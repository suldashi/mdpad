// Live documents. A note that someone has open is loaded into memory, edited
// through the OT server, and written back to its .md file shortly after each
// change. Edits made to the file by other programs are picked up and merged
// in as if another client had typed them.

import fs from 'node:fs';
import crypto from 'node:crypto';
import * as OT from '../shared/ot.js';
import { Store, StoreError, cleanTitle } from './store.js';

const SAVE_DELAY = 300;     // ms after the last edit
const SAVE_MAX_WAIT = 2000; // ms after the first unsaved edit
const UNLOAD_DELAY = 5 * 60 * 1000;
const WATCH_INTERVAL = 1000;

// Anything that can receive messages about a document: a WebSocket connection.
export interface Peer {
  clientId: string;
  sub: number;
  send(message: unknown): void;
}

export interface DocOptions {
  saveDelay?: number;
  saveMaxWait?: number;
  unloadDelay?: number;
  watchInterval?: number;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export class Doc {
  title: string;
  readonly epoch = crypto.randomBytes(8).toString('hex');
  readonly ot: OT.Server;
  readonly peers = new Set<Peer>();
  eol: string;
  lastSaved: string;       // the file's content as we last wrote or read it
  unsaved: OT.Op | null = null; // edits since lastSaved
  firstUnsavedAt = 0;
  saveTimer: NodeJS.Timeout | null = null;
  unloadTimer: NodeJS.Timeout | null = null;
  saving: Promise<void> = Promise.resolve();
  closed = false;

  constructor(title: string, fileText: string) {
    this.title = title;
    this.eol = fileText.includes('\r\n') ? '\r\n' : '\n';
    const text = normalizeEol(fileText);
    this.lastSaved = text;
    this.ot = new OT.Server(text);
  }

  get text(): string {
    return this.ot.text;
  }

  broadcast(message: Record<string, unknown>, except?: Peer): void {
    for (const peer of this.peers) {
      if (peer !== except) peer.send({ ...message, sub: peer.sub });
    }
  }
}

export class DocManager {
  readonly store: Store;
  readonly docs = new Map<string, Doc>();
  private loading = new Map<string, Promise<Doc>>();
  private opts: Required<DocOptions>;
  onListChanged: () => void = () => {};

  constructor(store: Store, opts: DocOptions = {}) {
    this.store = store;
    this.opts = {
      saveDelay: opts.saveDelay ?? SAVE_DELAY,
      saveMaxWait: opts.saveMaxWait ?? SAVE_MAX_WAIT,
      unloadDelay: opts.unloadDelay ?? UNLOAD_DELAY,
      watchInterval: opts.watchInterval ?? WATCH_INTERVAL
    };
  }

  async open(input: string): Promise<Doc> {
    const title = cleanTitle(input);
    const existing = this.docs.get(title);
    if (existing) return existing;
    let pending = this.loading.get(title);
    if (!pending) {
      pending = this.load(title).finally(() => this.loading.delete(title));
      this.loading.set(title, pending);
    }
    return pending;
  }

  private async load(title: string): Promise<Doc> {
    const doc = new Doc(title, await this.store.read(title));
    this.docs.set(title, doc);
    this.watch(doc);
    return doc;
  }

  join(doc: Doc, peer: Peer, since?: { epoch?: unknown; rev?: unknown }): void {
    if (doc.unloadTimer) { clearTimeout(doc.unloadTimer); doc.unloadTimer = null; }
    doc.peers.add(peer);

    // A client that reconnects gets only the edits it missed, so its own
    // unconfirmed edits can be matched up and nothing is applied twice.
    const entries = since && since.epoch === doc.epoch ? doc.ot.since(since.rev) : null;
    if (entries) {
      peer.send({
        type: 'catchup', sub: peer.sub, title: doc.title, epoch: doc.epoch, rev: since!.rev,
        ops: entries.map((e) => ({ op: e.op, seq: e.clientId === peer.clientId ? e.seq : null }))
      });
    } else {
      peer.send({ type: 'doc', sub: peer.sub, title: doc.title, epoch: doc.epoch, rev: doc.ot.rev, text: doc.text });
    }
    doc.broadcast({ type: 'presence', count: doc.peers.size });
  }

  leave(doc: Doc, peer: Peer): void {
    if (!doc.peers.delete(peer)) return;
    doc.broadcast({ type: 'presence', count: doc.peers.size });
    if (doc.peers.size === 0 && !doc.closed) {
      void this.flush(doc);
      doc.unloadTimer = setTimeout(() => this.unload(doc), this.opts.unloadDelay);
      doc.unloadTimer.unref();
    }
  }

  // Applies an edit from a client. A bad edit gets the client a fresh copy
  // of the document instead of breaking anyone else.
  receive(doc: Doc, peer: Peer, msg: { rev?: unknown; seq?: unknown; op?: unknown }): void {
    const seq = typeof msg.seq === 'number' ? msg.seq : null;
    let op: OT.Op;
    try {
      op = doc.ot.receive(msg.rev as number, msg.op, { clientId: peer.clientId, seq });
    } catch (err) {
      peer.send({ type: 'error', sub: peer.sub, message: (err as Error).message });
      peer.send({ type: 'doc', sub: peer.sub, title: doc.title, epoch: doc.epoch, rev: doc.ot.rev, text: doc.text });
      return;
    }
    peer.send({ type: 'ack', sub: peer.sub, seq });
    doc.broadcast({ type: 'op', op }, peer);
    this.changed(doc, op);
  }

  private changed(doc: Doc, op: OT.Op): void {
    if (!doc.unsaved) doc.firstUnsavedAt = Date.now();
    doc.unsaved = doc.unsaved ? OT.compose(doc.unsaved, op) : op;
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    const wait = Math.max(0, Math.min(this.opts.saveDelay, doc.firstUnsavedAt + this.opts.saveMaxWait - Date.now()));
    doc.saveTimer = setTimeout(() => { doc.saveTimer = null; void this.flush(doc); }, wait);
  }

  // Writes unsaved edits to disk. Saves for one document never overlap.
  flush(doc: Doc): Promise<void> {
    if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
    doc.saving = doc.saving.then(async () => {
      if (!doc.unsaved || doc.closed) return;
      const previous = doc.lastSaved;
      const previousUnsaved = doc.unsaved;
      const text = doc.text;
      doc.lastSaved = text;
      doc.unsaved = null;
      try {
        await this.store.write(doc.title, doc.eol === '\n' ? text : text.replace(/\n/g, doc.eol));
      } catch (err) {
        // Keep the edits so the next save tries again.
        doc.lastSaved = previous;
        doc.unsaved = doc.unsaved ? OT.compose(previousUnsaved, doc.unsaved) : previousUnsaved;
        console.error(`Could not save "${doc.title}":`, (err as Error).message);
        return;
      }
      this.onListChanged();
    });
    return doc.saving;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.docs.values()].map((doc) => this.flush(doc)));
  }

  private watch(doc: Doc): void {
    fs.watchFile(this.store.pathFor(doc.title), { interval: this.opts.watchInterval, persistent: false }, (curr) => {
      if (doc.closed) return;
      if (curr.nlink === 0 && curr.mtimeMs === 0) {
        // Gone. Some editors briefly remove a file while saving it, so look again.
        setTimeout(() => void this.checkDisk(doc), 500);
      } else {
        void this.checkDisk(doc);
      }
    });
  }

  private unwatch(doc: Doc): void {
    fs.unwatchFile(this.store.pathFor(doc.title));
  }

  // Merges changes another program made to the file into the live document.
  async checkDisk(doc: Doc): Promise<void> {
    await doc.saving;
    if (doc.closed) return;
    let disk: string;
    try {
      disk = await this.store.read(doc.title);
    } catch (err) {
      if (err instanceof StoreError && err.status === 404 && !doc.closed) {
        this.close(doc, { type: 'deleted' });
        this.onListChanged();
      }
      return;
    }
    if (doc.closed) return;
    const text = normalizeEol(disk);
    if (text === doc.lastSaved) return;

    // `external` turns lastSaved into the disk version; `unsaved` turns
    // lastSaved into the live text. Transforming one past the other merges both.
    const external = OT.fromDiff(doc.lastSaved, text);
    let toApply = external;
    let stillUnsaved: OT.Op | null = null;
    if (doc.unsaved) {
      [toApply, stillUnsaved] = OT.transform(external, doc.unsaved);
    }
    doc.lastSaved = text;
    doc.unsaved = null;
    if (!OT.isNoop(toApply)) {
      const op = doc.ot.receive(doc.ot.rev, toApply, { clientId: null, seq: null });
      doc.broadcast({ type: 'op', op });
    }
    if (stillUnsaved && !OT.isNoop(stillUnsaved)) this.changed(doc, stillUnsaved);
    this.onListChanged();
  }

  async rename(fromInput: string, toInput: string): Promise<string> {
    const from = cleanTitle(fromInput);
    const doc = this.docs.get(from);
    if (doc) {
      await this.flush(doc);
      this.unwatch(doc);
    }
    let to: string;
    try {
      to = await this.store.rename(from, toInput);
    } catch (err) {
      if (doc && !doc.closed) this.watch(doc);
      throw err;
    }
    if (doc && !doc.closed) {
      this.docs.delete(from);
      doc.title = to;
      this.docs.set(to, doc);
      this.watch(doc);
      doc.broadcast({ type: 'renamed', title: to });
    }
    this.onListChanged();
    return to;
  }

  async remove(input: string): Promise<void> {
    const title = cleanTitle(input);
    const doc = this.docs.get(title);
    if (doc) this.close(doc, { type: 'deleted' });
    await this.store.remove(title);
    this.onListChanged();
  }

  // Drops a document from memory and tells everyone who has it open why.
  private close(doc: Doc, message?: Record<string, unknown>): void {
    if (doc.closed) return;
    doc.closed = true;
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    if (doc.unloadTimer) clearTimeout(doc.unloadTimer);
    this.unwatch(doc);
    if (this.docs.get(doc.title) === doc) this.docs.delete(doc.title);
    if (message) doc.broadcast(message);
    doc.peers.clear();
  }

  private async unload(doc: Doc): Promise<void> {
    if (doc.peers.size > 0 || doc.closed) return;
    await this.flush(doc);
    if (doc.peers.size > 0) return;
    this.close(doc);
  }

  async shutdown(): Promise<void> {
    await this.flushAll();
    for (const doc of [...this.docs.values()]) this.close(doc);
  }
}
