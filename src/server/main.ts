// Entry point: node dist/src/server/main.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

// dist/src/server -> project root
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const notesDir = path.resolve(root, process.env.NOTES_DIR || 'notes');
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 25;
// Host names the server answers besides IP addresses and localhost.
const allowedHosts = [host, ...(process.env.ALLOWED_HOSTS || '').split(',')];
const graceHours = process.env.ATTACHMENT_GRACE_HOURS ? Number(process.env.ATTACHMENT_GRACE_HOURS) : 24;

const app = createApp({
  notesDir,
  publicDir: path.join(root, 'public'),
  jsDir: path.join(root, 'dist/public/js'),
  allowedHosts,
  maxUpload: maxUploadMb * 1024 * 1024,
  attachmentGrace: Number.isFinite(graceHours) ? graceHours * 3600 * 1000 : 24 * 3600 * 1000
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
