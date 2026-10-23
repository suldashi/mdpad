// Keeps one open note in sync with the server.

import * as OT from '../shared/ot.js';
import type { Connection } from './connection.js';
import type { EditorModel } from './model.js';

export interface SessionEvents {
  loaded(): void;
  synced(synced: boolean): void;
  presence(count: number): void;
  renamed(title: string): void;
  gone(reason: 'deleted' | 'not-found', message: string): void;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// One id per page, so the server can tell this tab's edits apart after a
// reconnect.
const clientId = randomId();
let nextSub = 1;

export class NoteSession {
  title: string;
  readonly sub = nextSub++;
  private conn: Connection;
  private model: EditorModel;
  private events: SessionEvents;
  private client: OT.Client | null = null;
  private epoch: string | null = null;
  private ready = false; // the server has caught us up on this connection
  closed = false;

  constructor(title: string, conn: Connection, model: EditorModel, events: SessionEvents) {
    this.title = title;
    this.conn = conn;
    this.model = model;
    this.events = events;
    model.onLocalOp = (op) => this.localOp(op);
  }

  get loaded(): boolean {
    return this.client !== null;
  }

  get synced(): boolean {
    return !this.client || !this.client.outstanding;
  }

  // Asks the server for the note, or for what we missed while disconnected.
  open(): void {
    this.ready = false;
    const msg: Record<string, unknown> = { type: 'open', title: this.title, sub: this.sub, clientId };
    if (this.client && this.epoch) {
      msg.epoch = this.epoch;
      msg.rev = this.client.rev;
    }
    this.conn.send(msg);
  }

  close(): void {
    this.closed = true;
    this.model.onLocalOp = () => {};
    this.conn.send({ type: 'close' });
  }

  disconnected(): void {
    this.ready = false;
  }

  private localOp(op: OT.Op): void {
    if (!this.client) return;
    const msg = this.client.applyClient(op);
    if (msg && this.ready) this.sendOp(msg);
    this.events.synced(this.synced);
  }

  private sendOp(msg: OT.OpMessage): void {
    this.conn.send({ type: 'op', rev: msg.rev, seq: msg.seq, op: msg.op });
  }

  handle(msg: Record<string, unknown>): void {
    if (msg.sub !== this.sub || this.closed) return;
    switch (msg.type) {
      case 'doc': return this.onDoc(msg.text as string, msg.rev as number, msg.epoch as string);
      case 'catchup': return this.onCatchup(msg.ops as Array<{ op: OT.Op; seq: number | null }>, msg.epoch as string);
      case 'ack': {
        if (!this.client || !this.client.outstanding) return;
        const next = this.client.serverAck();
        if (next) this.sendOp(next);
        this.events.synced(this.synced);
        return;
      }
      case 'op': {
        if (!this.client || !this.ready) return;
        this.model.remote(this.client.applyServer(msg.op as OT.Op));
        return;
      }
      case 'presence': return this.events.presence(msg.count as number);
      case 'renamed':
        this.title = msg.title as string;
        return this.events.renamed(this.title);
      case 'deleted':
        this.closed = true;
        return this.events.gone('deleted', 'This note was deleted.');
      case 'error':
        if (msg.notFound) {
          this.closed = true;
          this.events.gone('not-found', 'This note does not exist.');
        } else {
          console.warn('Server error:', msg.message);
        }
        return;
    }
  }

  // A full copy of the note: on first load, or when the server could not
  // replay what we missed.
  private onDoc(text: string, rev: number, epoch: string): void {
    const old = this.client;
    const pending = old && old.pending();
    this.epoch = epoch;
    if (old && pending) {
      // Keep our unsent edits: transform them past whatever changed on the
      // server, then send them again.
      const serverChange = OT.fromDiff(old.serverText, text);
      const [mine, theirs] = OT.transform(pending, serverChange);
      this.client = new OT.Client(rev, text, old.seq);
      this.model.remote(theirs);
      this.ready = true;
      const msg = this.client.applyClient(mine);
      if (msg) this.sendOp(msg);
    } else if (old) {
      this.client = new OT.Client(rev, text, old.seq);
      this.model.remote(OT.fromDiff(this.model.value, text));
      this.ready = true;
    } else {
      this.client = new OT.Client(rev, text);
      this.model.reset(text);
      this.ready = true;
      this.events.loaded();
    }
    this.events.synced(this.synced);
  }

  private onCatchup(ops: Array<{ op: OT.Op; seq: number | null }>, epoch: string): void {
    const client = this.client;
    if (!client) return;
    this.epoch = epoch;
    for (const entry of ops) {
      if (entry.seq !== null && client.outstanding && entry.seq === client.outstandingSeq) {
        client.serverAck();
      } else {
        this.model.remote(client.applyServer(entry.op));
      }
    }
    this.ready = true;
    const msg = client.message();
    if (msg) this.sendOp(msg);
    this.events.synced(this.synced);
  }
}
