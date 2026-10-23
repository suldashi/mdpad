// Entry point: node dist/src/server/main.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

// dist/src/server -> project root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const notesDir = path.resolve(root, process.env.NOTES_DIR || 'notes');

const app = createApp({
  notesDir,
  publicDir: path.join(root, 'public'),
  jsDir: path.join(root, 'dist/public/js')
});

app.server.listen(port, host, () => {
  console.log(`Mdpad is running at http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  console.log(`Notes are stored in ${notesDir}`);
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('Saving notes and shutting down...');
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
