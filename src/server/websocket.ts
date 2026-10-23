// A minimal WebSocket server (RFC 6455) on top of Node's http module. It
// handles text messages, fragmentation, ping/pong and close, which is all the
// editor needs.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
  socket: Duplex;
  open = true;
  alive = true;
  buffer: Buffer = Buffer.alloc(0);
  fragments: Buffer[] = [];
  fragmentsLength = 0;
  messageOpcode = 0;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const frame = this.readFrame();
      if (!frame) break;
      this.onFrame(frame);
    }
  }

  readFrame(): Frame | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'Message too big'); return null; }
      length = Number(big);
      offset = 10;
    }
    if (!masked) { this.close(1002, 'Client frames must be masked'); return null; }
    if (length > MAX_MESSAGE) { this.close(1009, 'Message too big'); return null; }
    if (buf.length < offset + 4 + length) return null;

    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  onFrame({ fin, opcode, payload }: Frame): void {
    switch (opcode) {
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: // binary
        if (opcode !== 0x0) {
          if (this.fragments.length) return this.close(1002, 'Expected a continuation frame');
          this.messageOpcode = opcode;
        } else if (!this.fragments.length) {
          return this.close(1002, 'Unexpected continuation frame');
        }
        this.fragments.push(payload);
        this.fragmentsLength += payload.length;
        if (this.fragmentsLength > MAX_MESSAGE) return this.close(1009, 'Message too big');
        if (fin) {
          const data = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentsLength = 0;
          if (this.messageOpcode !== 0x1) return this.close(1003, 'Only text messages are supported');
          this.emit('message', data.toString('utf8'));
        }
        return;
      case 0x8: // close
        return this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
      case 0x9: // ping
        return this.sendFrame(0xa, payload);
      case 0xa: // pong
        this.alive = true;
        return;
      default:
        return this.close(1002, 'Unknown opcode');
    }
  }

  sendFrame(opcode: number, payload: Buffer): void {
    if (!this.open) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(data: unknown): void {
    this.sendFrame(0x1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8'));
  }

  ping(): void {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.socket.end();
    this.finish();
  }

  terminate(): void {
    this.socket.destroy();
    this.finish();
  }

  finish(): void {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

// Attaches a WebSocket endpoint at `path` to an http server and calls
// `onConnection(ws, req)` for each new connection.
export interface WebSocketServer {
  connections: Set<WebSocketConnection>;
  close(): void;
}

export function attachWebSocketServer(
  server: Server,
  path: string,
  onConnection: (ws: WebSocketConnection, req: IncomingMessage) => void
): WebSocketServer {
  const connections = new Set<WebSocketConnection>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    if (url.pathname !== path || upgrade !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    // Refuse connections that a page on another site opened.
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | null;
      try { originHost = new URL(origin).host; } catch { originHost = null; }
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',').map((h) => h.trim());
      const hosts = [req.headers.host, ...forwarded];
      if (!originHost || !hosts.includes(originHost)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const ws = new WebSocketConnection(socket);
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));
    onConnection(ws, req);
  });

  // Drop connections that stop answering pings.
  const heartbeat = setInterval(() => {
    for (const ws of connections) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    connections,
    close() {
      clearInterval(heartbeat);
      for (const ws of connections) ws.close(1001, 'Server shutting down');
    }
  };
}
