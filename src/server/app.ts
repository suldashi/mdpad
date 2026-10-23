// HTTP routes, static files and the WebSocket endpoint.

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, StoreError } from './store.js';
import { DocManager, type Doc, type DocOptions, type Peer } from './docs.js';
import { attachWebSocketServer, type WebSocketConnection } from './websocket.js';

export interface AppOptions extends DocOptions {
  notesDir: string;
  publicDir: string; // index.html, styles, icons
  jsDir: string;     // bundled browser code (dist/public/js)
}

export interface App {
  server: http.Server;
  docs: DocManager;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https: http:; connect-src 'self' ws: wss:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON means a page on another site cannot post here without a
  // CORS preflight, which this server never approves.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Expected a JSON body');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, 'Invalid JSON');
}

async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, root: string, rel: string): Promise<boolean> {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end();
  else res.end(await fsp.readFile(file));
  return true;
}

export function createApp(opts: AppOptions): App {
  const store = new Store(opts.notesDir);
  const docs = new DocManager(store, opts);
  const publicDir = path.resolve(opts.publicDir);
  const jsDir = path.resolve(opts.jsDir);

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').slice(3); // after /api/notes
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
      if (req.method === 'GET') return sendJson(res, 200, { notes: await store.list() });
      if (req.method === 'POST') {
        const body = await readJson(req);
        const base = typeof body.title === 'string' && body.title.trim() ? body.title : 'Untitled';
        const title = await store.create(await store.freeTitle(base), typeof body.text === 'string' ? body.text : '');
        docs.onListChanged();
        return sendJson(res, 201, { title });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (parts.length === 1) {
      let title: string;
      try {
        title = decodeURIComponent(parts[0]);
      } catch {
        throw new HttpError(400, 'Bad note title');
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        return sendJson(res, 200, { title: await docs.rename(title, body.title as string) });
      }
      if (req.method === 'DELETE') {
        await docs.remove(title);
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      throw new HttpError(405, 'Method not allowed');
    }
    throw new HttpError(404, 'Not found');
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/api/notes' || url.pathname.startsWith('/api/notes/')) {
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (url.pathname.startsWith('/js/')) {
        if (await serveFile(req, res, jsDir, url.pathname.slice(4))) return;
      } else if (url.pathname !== '/' && await serveFile(req, res, publicDir, url.pathname)) {
        return;
      }
      if (url.pathname.startsWith('/js/') || path.extname(url.pathname)) throw new HttpError(404, 'Not found');
      // Every other path is the app itself.
      await serveFile(req, res, publicDir, 'index.html');
    } catch (err) {
      const status = err instanceof HttpError || err instanceof StoreError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : (err as Error).message });
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => void handle(req, res));

  interface Session extends Peer {
    ws: WebSocketConnection;
    doc: Doc | null;
  }
  const sessions = new Set<Session>();

  docs.onListChanged = () => {
    for (const s of sessions) s.send({ type: 'notes' });
  };

  const wss = attachWebSocketServer(server, '/ws', (ws) => {
    const session: Session = {
      ws,
      clientId: crypto.randomUUID(),
      sub: 0,
      doc: null,
      send: (message) => ws.send(message)
    };
    sessions.add(session);
    let openToken = 0;

    function leave(): void {
      if (session.doc) docs.leave(session.doc, session);
      session.doc = null;
    }

    async function open(msg: Record<string, unknown>): Promise<void> {
      leave();
      // `sub` is the client's id for this open; it tags every message about
      // the note so the client can drop ones meant for a note it has left.
      const token = ++openToken;
      const sub = typeof msg.sub === 'number' && Number.isSafeInteger(msg.sub) ? msg.sub : 0;
      session.sub = sub;
      if (typeof msg.clientId === 'string' && msg.clientId.length <= 64) session.clientId = msg.clientId;
      let doc: Doc;
      try {
        doc = await docs.open(msg.title as string);
      } catch (err) {
        if (token === openToken && ws.open) {
          ws.send({ type: 'error', sub, notFound: err instanceof StoreError && err.status === 404, message: (err as Error).message });
        }
        return;
      }
      // Another open arrived while this one was loading, or the socket closed.
      if (token !== openToken || !ws.open || doc.closed) return;
      session.doc = doc;
      docs.join(doc, session, { epoch: msg.epoch, rev: msg.rev });
    }

    // Messages are handled strictly in order, so an edit never overtakes the
    // open it belongs to.
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (data: string) => {
      queue = queue.then(async () => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'open') await open(msg);
        else if (msg.type === 'close') { leave(); openToken++; }
        else if (msg.type === 'op') {
          if (session.doc && !session.doc.closed) docs.receive(session.doc, session, msg);
        }
      }).catch((err) => console.error(err));
    });

    ws.on('close', () => {
      sessions.delete(session);
      leave();
    });
  });

  return {
    server,
    docs,
    async close() {
      wss.close();
      await docs.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
