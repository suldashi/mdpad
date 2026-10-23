import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server/app.js';
import { cleanFileName } from '../src/server/attachments.js';
import * as OT from '../src/shared/ot.js';

type Msg = Record<string, any>;

async function startApp(extra: { maxUpload?: number } = {}): Promise<{ app: App; base: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpad-test-'));
  const app = createApp({
    notesDir: dir,
    publicDir: path.join(import.meta.dirname, '../../public'),
    jsDir: path.join(import.meta.dirname, '../public/js'),
    saveDelay: 10,
    saveMaxWait: 50,
    watchInterval: 50,
    ...extra
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, dir };
}

async function json(base: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) resolve();
      else if (Date.now() - start > ms) reject(new Error('Timed out'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

// A headless editor client speaking the same protocol as the browser.
class TestClient {
  ws: WebSocket;
  messages: Msg[] = [];
  text = '';
  ot: OT.Client | null = null;
  sub = 1;
  clientId: string;
  presence = 0;
  private opened: Promise<void>;

  constructor(base: string, clientId = Math.random().toString(36).slice(2)) {
    this.clientId = clientId;
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string));
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('socket error'));
    });
  }

  ready(): Promise<void> {
    return this.opened;
  }

  open(title: string, since?: { epoch: string; rev: number }): void {
    this.ws.send(JSON.stringify({ type: 'open', title, sub: this.sub, clientId: this.clientId, ...since }));
  }

  onMessage(msg: Msg): void {
    this.messages.push(msg);
    if (msg.sub !== this.sub) return;
    if (msg.type === 'doc') {
      this.text = msg.text;
      this.ot = new OT.Client(msg.rev, msg.text);
    } else if (msg.type === 'ack') {
      const next = this.ot!.serverAck();
      if (next) this.sendOp(next);
    } else if (msg.type === 'op') {
      this.text = OT.apply(this.text, this.ot!.applyServer(msg.op));
    } else if (msg.type === 'presence') {
      this.presence = msg.count;
    }
  }

  edit(op: OT.Op): void {
    this.text = OT.apply(this.text, op);
    const msg = this.ot!.applyClient(op);
    if (msg) this.sendOp(msg);
  }

  insertAt(pos: number, s: string): void {
    this.edit(OT.retain(OT.insert(OT.retain([], pos), s), this.text.length - pos));
  }

  sendOp(msg: OT.OpMessage): void {
    this.ws.send(JSON.stringify({ type: 'op', ...msg }));
  }

  get synced(): boolean {
    return !!this.ot && !this.ot.outstanding;
  }

  close(): void {
    this.ws.close();
  }
}

test('REST API creates, lists, renames and deletes notes', async () => {
  const { app, base, dir } = await startApp();
  try {
    let r = await json(base, 'POST', '/api/notes', { title: 'Shopping list' });
    assert.equal(r.status, 201);
    assert.equal(r.body.title, 'Shopping list');
    assert.ok(fs.existsSync(path.join(dir, 'Shopping list.md')));

    r = await json(base, 'POST', '/api/notes', { title: 'Shopping list' });
    assert.equal(r.body.title, 'Shopping list 2');

    r = await json(base, 'GET', '/api/notes');
    assert.deepEqual(r.body.notes.map((n: any) => n.title).sort(), ['Shopping list', 'Shopping list 2']);

    r = await json(base, 'PATCH', '/api/notes/' + encodeURIComponent('Shopping list 2'), { title: 'Groceries' });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'Groceries.md')));

    r = await json(base, 'PATCH', '/api/notes/Groceries', { title: 'Shopping list' });
    assert.equal(r.status, 409);

    r = await json(base, 'PATCH', '/api/notes/Groceries', { title: '../escape' });
    assert.equal(r.status, 400);

    r = await json(base, 'DELETE', '/api/notes/Groceries');
    assert.equal(r.status, 204);
    assert.ok(!fs.existsSync(path.join(dir, 'Groceries.md')));

    r = await json(base, 'DELETE', '/api/notes/Groceries');
    assert.equal(r.status, 404);

    const res = await fetch(base + '/api/notes', { method: 'POST', body: '{}' });
    assert.equal(res.status, 415);
  } finally {
    await app.close();
  }
});

test('serves the app and compiled scripts but nothing outside them', async () => {
  const { app, base } = await startApp();
  try {
    let res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="editor"/);
    res = await fetch(base + '/js/client/main.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /javascript/);
    res = await fetch(base + '/js/../../package.json');
    assert.notEqual(res.status, 200);
    res = await fetch(base + '/js/%2e%2e/%2e%2e/package.json');
    assert.notEqual(res.status, 200);
  } finally {
    await app.close();
  }
});

test('two clients edit the same note concurrently and the file is saved', async () => {
  const { app, base, dir } = await startApp();
  const a = new TestClient(base), b = new TestClient(base);
  try {
    fs.writeFileSync(path.join(dir, 'Shared.md'), 'Hello\r\nworld\r\n');
    await Promise.all([a.ready(), b.ready()]);
    a.open('Shared');
    b.open('Shared');
    await waitFor(() => !!a.ot && !!b.ot && a.presence === 2);
    assert.equal(a.text, 'Hello\nworld\n');

    // Interleave edits without waiting for acknowledgements.
    for (let i = 0; i < 20; i++) {
      a.insertAt(0, 'a');
      b.insertAt(b.text.length, 'b');
      a.insertAt(a.text.length >> 1, 'A');
      b.insertAt(1, 'B');
    }
    await waitFor(() => a.synced && b.synced && a.text === b.text && a.text.length === 12 + 80);
    const doc = app.docs.docs.get('Shared')!;
    assert.equal(doc.text, a.text);

    // The file keeps its Windows line endings.
    await waitFor(() => fs.readFileSync(path.join(dir, 'Shared.md'), 'utf8') === a.text.replace(/\n/g, '\r\n'));
  } finally {
    a.close();
    b.close();
    await app.close();
  }
});

test('edits made to the file by another program reach open clients', async () => {
  const { app, base, dir } = await startApp();
  const a = new TestClient(base);
  try {
    const file = path.join(dir, 'Watched.md');
    fs.writeFileSync(file, 'one\ntwo\n');
    await a.ready();
    a.open('Watched');
    await waitFor(() => !!a.ot);

    // Make sure the new mtime differs from the old one.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    await waitFor(() => a.text === 'one\ntwo\nthree\n');

    // An edit in the browser and on disk at the same time are both kept.
    a.insertAt(0, '# ');
    await waitFor(() => a.synced);
    await waitFor(() => fs.readFileSync(file, 'utf8') === '# one\ntwo\nthree\n');
  } finally {
    a.close();
    await app.close();
  }
});

test('a reconnecting client gets what it missed and its edits are not applied twice', async () => {
  const { app, base, dir } = await startApp();
  fs.writeFileSync(path.join(dir, 'Note.md'), 'abc');
  const a = new TestClient(base, 'client-a');
  const b = new TestClient(base);
  try {
    await Promise.all([a.ready(), b.ready()]);
    a.open('Note');
    b.open('Note');
    await waitFor(() => !!a.ot && !!b.ot);
    const epoch = a.messages.find((m) => m.type === 'doc')!.epoch;

    // a edits, then drops before seeing the acknowledgement.
    a.insertAt(3, 'X');
    await waitFor(() => b.text === 'abcX');
    a.ws.onmessage = null;
    a.close();
    b.insertAt(0, 'Y');
    await waitFor(() => b.synced);

    // Reconnect with the same client id and the revision a last knew.
    const a2 = new TestClient(base, 'client-a');
    a2.ot = a.ot;
    a2.text = a.text;
    await a2.ready();
    a2.open('Note', { epoch, rev: a.ot!.rev });
    await waitFor(() => a2.messages.some((m) => m.type === 'catchup'));
    const catchup = a2.messages.find((m) => m.type === 'catchup')!;
    for (const entry of catchup.ops) {
      if (entry.seq !== null && entry.seq === a2.ot!.outstandingSeq) a2.ot!.serverAck();
      else a2.text = OT.apply(a2.text, a2.ot!.applyServer(entry.op));
    }
    assert.equal(a2.ot!.outstanding, null);
    assert.equal(a2.text, 'YabcX');
    assert.equal(app.docs.docs.get('Note')!.text, 'YabcX');
    a2.close();
  } finally {
    b.close();
    await app.close();
  }
});

test('renaming or deleting an open note tells its clients', async () => {
  const { app, base } = await startApp();
  const a = new TestClient(base);
  try {
    await json(base, 'POST', '/api/notes', { title: 'Draft' });
    await a.ready();
    a.open('Draft');
    await waitFor(() => !!a.ot);
    a.insertAt(0, 'kept');
    await waitFor(() => a.synced);

    await json(base, 'PATCH', '/api/notes/Draft', { title: 'Final' });
    await waitFor(() => a.messages.some((m) => m.type === 'renamed' && m.title === 'Final'));
    // Editing continues on the renamed note.
    a.insertAt(4, '!');
    await waitFor(() => a.synced);
    assert.equal(app.docs.docs.get('Final')!.text, 'kept!');

    await json(base, 'DELETE', '/api/notes/Final');
    await waitFor(() => a.messages.some((m) => m.type === 'deleted'));
  } finally {
    a.close();
    await app.close();
  }
});

test('a bad operation gets the client a fresh copy instead of corrupting the note', async () => {
  const { app, base, dir } = await startApp();
  fs.writeFileSync(path.join(dir, 'Safe.md'), 'safe');
  const a = new TestClient(base);
  try {
    await a.ready();
    a.open('Safe');
    await waitFor(() => !!a.ot);
    a.ws.send(JSON.stringify({ type: 'op', rev: 0, seq: 1, op: [99, 'x'] }));
    await waitFor(() => a.messages.filter((m) => m.type === 'doc').length === 2);
    assert.equal(app.docs.docs.get('Safe')!.text, 'safe');
  } finally {
    a.close();
    await app.close();
  }
});

test('opening a missing note reports it', async () => {
  const { app, base } = await startApp();
  const a = new TestClient(base);
  try {
    await a.ready();
    a.open('Nope');
    await waitFor(() => a.messages.some((m) => m.type === 'error' && m.notFound));
  } finally {
    a.close();
    await app.close();
  }
});

function upload(base: string, name: string, body: string | Uint8Array, headers: Record<string, string> = { 'X-Mdpad-Upload': '1' }): Promise<Response> {
  return fetch(`${base}/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body });
}

test('attachments are stored once under a content-hashed name and served back', async () => {
  const { app, base, dir } = await startApp();
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const res = await upload(base, 'My photo (1).PNG', png);
    assert.equal(res.status, 201);
    const info: any = await res.json();
    assert.match(info.url, /^attachments\/My-photo-1-[0-9a-f]{10}\.png$/);
    assert.equal(info.name, 'My photo (1).PNG');
    assert.equal(info.image, true);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')), [info.url.slice('attachments/'.length)]);

    // The same file again is the same attachment.
    const again: any = await (await upload(base, 'My photo (1).PNG', png)).json();
    assert.equal(again.url, info.url);
    assert.equal(fs.readdirSync(path.join(dir, 'attachments')).length, 1);

    // Attachments don't show up as notes.
    assert.deepEqual((await json(base, 'GET', '/api/notes')).body.notes, []);

    const got = await fetch(`${base}/${info.url}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), png);

    const part = await fetch(`${base}/${info.url}`, { headers: { Range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/8');
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), png.slice(2, 5));
  } finally {
    await app.close();
  }
});

test('attachments that could run scripts are downloads, and uploads are checked', async () => {
  const { app, base, dir } = await startApp({ maxUpload: 32 });
  try {
    const html: any = await (await upload(base, 'page.html', '<script>1</script>')).json();
    assert.equal(html.image, false);
    const got = await fetch(`${base}/${html.url}`);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.match(got.headers.get('content-disposition') || '', /^attachment/);
    assert.match(got.headers.get('content-security-policy') || '', /sandbox/);

    assert.equal((await upload(base, 'a.txt', 'x', {})).status, 400);
    assert.equal((await upload(base, 'big.txt', 'x'.repeat(33))).status, 413);
    assert.equal((await upload(base, 'empty.txt', '')).status, 400);
    // Without a declared length, the limit applies while the file streams in.
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); c.enqueue(new Uint8Array(20)); c.close(); } });
    const streamed = await fetch(`${base}/api/attachments?name=s.bin`, { method: 'POST', headers: { 'X-Mdpad-Upload': '1' }, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(streamed.status, 413);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')).filter((f) => f.endsWith('.tmp')), []);
    assert.equal((await fetch(`${base}/attachments/..%2Fsecret.md`)).status, 404);
    assert.equal((await fetch(`${base}/attachments/missing.png`)).status, 404);
  } finally {
    await app.close();
  }
});

test('attachment names are made safe for links', () => {
  assert.deepEqual(cleanFileName('Screenshot 2026-10-23 at 18.40.12.png'), { base: 'Screenshot-2026-10-23-at-18-40-12', ext: 'png' });
  assert.deepEqual(cleanFileName('../../etc/passwd'), { base: 'passwd', ext: '' });
  assert.deepEqual(cleanFileName('.hidden'), { base: 'hidden', ext: '' });
  assert.deepEqual(cleanFileName('Ünïcödé café.JPG'), { base: 'Ünïcödé-café', ext: 'jpg' });
  assert.deepEqual(cleanFileName('(((.pdf'), { base: 'file', ext: 'pdf' });
});
