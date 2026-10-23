// Notes live as plain .md files in one folder. A note's title is its file
// name without the extension, so there is nothing to keep in sync.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TITLE = 200;

export interface NoteInfo {
  title: string;
  mtime: number;
  size: number;
}

export class StoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

// Turns user input into a title, or throws if it can't be a file name.
export function cleanTitle(input: unknown): string {
  if (typeof input !== 'string') throw new StoreError(400, 'Title must be a string');
  let title = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (title.toLowerCase().endsWith('.md')) title = title.slice(0, -3).trim();
  if (!title) throw new StoreError(400, 'Title cannot be empty');
  if (title.length > MAX_TITLE) throw new StoreError(400, 'Title is too long');
  if (/[\/\\\x00-\x1f\x7f]/.test(title)) throw new StoreError(400, 'Title cannot contain slashes or control characters');
  if (/[<>:"|?*]/.test(title)) throw new StoreError(400, 'Title cannot contain any of < > : " | ? *');
  if (title.startsWith('.')) throw new StoreError(400, 'Title cannot start with a dot');
  if (title.endsWith('.')) throw new StoreError(400, 'Title cannot end with a dot');
  return title;
}

export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  pathFor(title: string): string {
    return path.join(this.dir, cleanTitle(title) + '.md');
  }

  async list(): Promise<NoteInfo[]> {
    const entries = await fsp.readdir(this.dir, { withFileTypes: true });
    const notes: NoteInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
      try {
        const stat = await fsp.stat(path.join(this.dir, entry.name));
        notes.push({ title: entry.name.slice(0, -3), mtime: stat.mtimeMs, size: stat.size });
      } catch {
        // Removed while listing.
      }
    }
    notes.sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title));
    return notes;
  }

  async exists(title: string): Promise<boolean> {
    try {
      return (await fsp.stat(this.pathFor(title))).isFile();
    } catch (err) {
      if (code(err) === 'ENOENT') return false;
      throw err;
    }
  }

  async read(title: string): Promise<string> {
    try {
      return await fsp.readFile(this.pathFor(title), 'utf8');
    } catch (err) {
      if (code(err) === 'ENOENT') throw new StoreError(404, 'Note not found');
      throw err;
    }
  }

  // Writes through a temporary file and a rename, so a crash never leaves a
  // half-written note behind.
  async write(title: string, text: string): Promise<void> {
    const file = this.pathFor(title);
    const tmp = path.join(this.dir, '.' + path.basename(file) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    await fsp.writeFile(tmp, text, 'utf8');
    try {
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async create(input: string, text = ''): Promise<string> {
    const title = cleanTitle(input);
    try {
      await fsp.writeFile(this.pathFor(title), text, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (code(err) === 'EEXIST') throw new StoreError(409, 'A note with that title already exists');
      throw err;
    }
    return title;
  }

  async remove(title: string): Promise<void> {
    try {
      await fsp.unlink(this.pathFor(title));
    } catch (err) {
      if (code(err) === 'ENOENT') throw new StoreError(404, 'Note not found');
      throw err;
    }
  }

  async rename(fromInput: string, toInput: string): Promise<string> {
    const from = cleanTitle(fromInput);
    const to = cleanTitle(toInput);
    if (from === to) return to;
    // Changing only the letter case is the same file on case-insensitive disks.
    const sameFile = from.toLowerCase() === to.toLowerCase();
    if (!sameFile && await this.exists(to)) throw new StoreError(409, 'A note with that title already exists');
    try {
      await fsp.rename(this.pathFor(from), this.pathFor(to));
    } catch (err) {
      if (code(err) === 'ENOENT') throw new StoreError(404, 'Note not found');
      throw err;
    }
    return to;
  }

  // A title based on `base` that no note uses yet.
  async freeTitle(input: string): Promise<string> {
    const base = cleanTitle(input);
    if (!await this.exists(base)) return base;
    for (let n = 2; ; n++) {
      const title = `${base} ${n}`;
      if (!await this.exists(title)) return title;
    }
  }
}
