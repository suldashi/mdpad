// Files pasted or dropped into notes. They live in an "attachments" folder
// inside the notes folder, and notes link to them with a relative path
// ("attachments/photo-1a2b3c4d5e.png"), so the notes folder works as is in
// other Markdown tools too.
//
// A file's name is its original name plus a hash of its contents: the same
// file added twice is stored once, and a name never points to new contents.
//
// Files that no note links to are deleted once they have gone unlinked for
// a grace period (a day by default), which leaves time for undo, cut and
// paste, and restoring a note from elsewhere.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StoreError } from './store.js';

export const FOLDER = 'attachments';

export interface Attachment {
  url: string;    // relative to the notes folder, as written in notes
  name: string;   // the original file name, for link text
  image: boolean; // shown inline as an image
  size: number;
}

// Types the browser may show inline. Anything else is served as a download.
const INLINE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  txt: 'text/plain; charset=utf-8'
};
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

// Splits a file name into a URL-safe base and a lower-case extension.
export function cleanFileName(input: string): { base: string; ext: string } {
  const name = input.normalize('NFC').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
  const base = Array.from((dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, ''))
    .slice(0, 60)
    .join('')
    .replace(/[-_]+$/, '');
  return { base: base || 'file', ext };
}

export class Attachments {
  readonly dir: string;
  readonly maxSize: number;
  readonly grace: number;
  // When each file was first seen with no note linking to it. Kept in
  // memory only, so a restart starts the wait again, which errs on the safe
  // side.
  private unlinkedSince = new Map<string, number>();

  constructor(notesDir: string, maxSize: number, grace: number) {
    this.dir = path.join(path.resolve(notesDir), FOLDER);
    this.maxSize = maxSize;
    this.grace = grace;
  }

  // Deletes files that no note has linked to for the grace period, given the
  // text of every note. Returns the names of the deleted files.
  async sweep(notes: string[], now = Date.now()): Promise<string[]> {
    if (this.grace <= 0) return [];
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const text = notes.join('\n');
    const deleted: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const file = path.join(this.dir, name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue; // removed meanwhile
      }
      if (!stat.isFile()) continue;
      const old = now - stat.mtimeMs >= this.grace;
      // Leftovers from uploads cut short by a crash.
      if (name.startsWith('.upload-') && name.endsWith('.tmp')) {
        if (old) await fsp.rm(file, { force: true });
        continue;
      }
      if (name.startsWith('.')) continue;
      seen.add(name);
      // A name is linked if a note mentions it, written plainly or
      // URL-encoded. A fresh upload counts as linked, so its link has time
      // to arrive.
      if (!old || text.includes(name) || text.includes(encodeURI(name))) {
        this.unlinkedSince.delete(name);
        continue;
      }
      const since = this.unlinkedSince.get(name);
      if (since === undefined) {
        this.unlinkedSince.set(name, now);
      } else if (now - since >= this.grace) {
        await fsp.rm(file, { force: true });
        this.unlinkedSince.delete(name);
        deleted.push(name);
      }
    }
    for (const name of this.unlinkedSince.keys()) if (!seen.has(name)) this.unlinkedSince.delete(name);
    return deleted;
  }

  async save(name: string, body: NodeJS.ReadableStream): Promise<Attachment> {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, '.upload-' + crypto.randomBytes(6).toString('hex') + '.tmp');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const max = this.maxSize;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > max) return done(new StoreError(413, `Files can be at most ${formatSize(max)}`));
        hash.update(chunk);
        done(null, chunk);
      }
    });
    try {
      await pipeline(body, count, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (size === 0) throw new StoreError(400, 'The file is empty');
      const { base, ext } = cleanFileName(name);
      const file = `${base}-${hash.digest('hex').slice(0, 10)}${ext ? '.' + ext : ''}`;
      // An existing file with this name has the same contents.
      await fsp.rename(tmp, path.join(this.dir, file));
      return { url: `${FOLDER}/${file}`, name: name.split(/[\\/]/).pop() || file, image: IMAGES.has(ext), size };
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  // Serves /attachments/<file>. Supports a single byte range, which Safari
  // needs to play audio and video.
  async serve(req: http.IncomingMessage, res: http.ServerResponse, rel: string, baseHeaders: Record<string, string>): Promise<boolean> {
    let name: string;
    try {
      name = decodeURIComponent(rel);
    } catch {
      return false;
    }
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return false;
    const file = path.join(this.dir, name);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const ext = path.extname(name).slice(1).toLowerCase();
    const type = INLINE[ext];
    const headers: Record<string, string | number> = {
      ...baseHeaders,
      'Content-Type': type || 'application/octet-stream',
      // Names change with contents, so a file can be cached for good.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
      // An attachment opened on its own may not run scripts (an SVG could
      // try). Chrome won't show PDFs in a sandbox, and PDFs don't need one.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" + (ext === 'pdf' ? '' : '; sandbox')
    };
    if (!type) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

    let start = 0, end = stat.size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(0, stat.size - Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return true;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => res.destroy());
    return true;
  }
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
