// The app shell: note list, title, editor and preview.

import { render } from '../shared/markdown.js';
import { Connection } from './connection.js';
import { TextBinding } from './binding.js';
import { NoteSession } from './session.js';

interface NoteInfo {
  title: string;
  mtime: number;
  size: number;
}

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const app = $('app');
const list = $('note-list');
const titleInput = $<HTMLInputElement>('title');
const editor = $<HTMLTextAreaElement>('editor');
const preview = $('preview');
const statusEl = $('status');
const presenceEl = $('presence');
const emptyEl = $('empty');
const toast = $('toast');
const previewButton = $<HTMLButtonElement>('toggle-preview');

const conn = new Connection();
const binding = new TextBinding(editor);
let session: NoteSession | null = null;
let notes: NoteInfo[] = [];
let previewing = false;

const mobile = window.matchMedia('(max-width: 760px)');

// ---------------------------------------------------------------- helpers

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); these are just preferences.
  }
  return null;
}

let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function noteUrl(title: string): string {
  return '#/' + encodeURIComponent(title);
}

function titleFromHash(): string | null {
  const h = location.hash;
  if (!h.startsWith('#/') || h.length <= 2) return null;
  try { return decodeURIComponent(h.slice(2)); } catch { return null; }
}

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// ---------------------------------------------------------------- sidebar

function setSidebar(open: boolean, remember = true): void {
  app.classList.toggle('sidebar-open', open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  if (remember && !mobile.matches) store('mdpad.sidebar', open ? '1' : '0');
}

function renderList(): void {
  const current = session?.title;
  list.replaceChildren(...notes.map((note) => {
    const a = document.createElement('a');
    a.href = noteUrl(note.title);
    a.className = 'note-link' + (note.title === current ? ' active' : '');
    if (note.title === current) a.setAttribute('aria-current', 'page');
    const name = document.createElement('span');
    name.className = 'note-title';
    name.textContent = note.title;
    const time = document.createElement('span');
    time.className = 'note-time';
    time.textContent = timeAgo(note.mtime);
    a.append(name, time);
    return a;
  }));
  if (!notes.length) {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = 'No notes yet';
    list.append(p);
  }
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
async function refreshList(): Promise<void> {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    try {
      notes = (await api('GET', '/api/notes')).notes;
      renderList();
    } catch (err) {
      console.warn(err);
    } finally {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; void refreshList(); }
    }
  })();
  return refreshing;
}

// ---------------------------------------------------------------- note

function updateStatus(): void {
  let state: string, label: string;
  if (conn.status === 'connecting') { state = 'syncing'; label = 'Connecting…'; }
  else if (conn.status === 'offline') { state = 'offline'; label = 'Offline, changes will sync when reconnected'; }
  else if (session && !session.synced) { state = 'syncing'; label = 'Saving…'; }
  else { state = 'synced'; label = 'All changes saved'; }
  statusEl.dataset.state = state;
  statusEl.title = label;
  statusEl.setAttribute('aria-label', label);
}

function setPresence(count: number): void {
  presenceEl.hidden = count < 2;
  presenceEl.textContent = `${count} editing`;
  presenceEl.title = `${count} people have this note open`;
}

let previewFrame = 0;
function renderPreview(): void {
  if (!previewing || previewFrame) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    preview.innerHTML = render(binding.value);
  });
}

function setPreview(on: boolean): void {
  previewing = on;
  app.classList.toggle('previewing', on);
  previewButton.setAttribute('aria-pressed', String(on));
  previewButton.title = on ? 'Edit (Ctrl+E)' : 'Preview (Ctrl+E)';
  previewButton.querySelector('.label')!.textContent = on ? 'Edit' : 'Preview';
  editor.hidden = on;
  preview.hidden = !on;
  if (on) renderPreview();
  else if (!mobile.matches) editor.focus();
  store('mdpad.preview', on ? '1' : '0');
}

function showEmpty(empty: boolean): void {
  app.classList.toggle('no-note', empty);
  emptyEl.hidden = !empty;
}

function openNote(title: string): void {
  if (session && session.title === title && !session.closed) return;
  if (session) session.close();
  showEmpty(false);
  editor.readOnly = true;
  titleInput.value = title;
  document.title = `${title} · Mdpad`;
  setPresence(1);
  binding.setText('');
  const s = new NoteSession(title, conn, binding, {
    loaded() {
      editor.readOnly = false;
      renderPreview();
    },
    synced: () => updateStatus(),
    presence: (count) => setPresence(count),
    renamed(newTitle) {
      if (document.activeElement !== titleInput) titleInput.value = newTitle;
      document.title = `${newTitle} · Mdpad`;
      history.replaceState(null, '', noteUrl(newTitle));
      renderList();
    },
    gone(_reason, message) {
      if (session !== s) return;
      session = null;
      showToast(message);
      void refreshList().then(() => openDefault());
    }
  });
  session = s;
  s.open();
  renderList();
  updateStatus();
  if (mobile.matches) setSidebar(false, false);
}

function openDefault(): void {
  const first = notes[0];
  if (first) {
    history.replaceState(null, '', noteUrl(first.title));
    openNote(first.title);
  } else {
    if (session) { session.close(); session = null; }
    history.replaceState(null, '', location.pathname);
    document.title = 'Mdpad';
    showEmpty(true);
    renderList();
  }
}

function route(): void {
  const title = titleFromHash();
  if (title) openNote(title);
  else openDefault();
}

async function createNote(): Promise<void> {
  try {
    const { title } = await api('POST', '/api/notes', { title: 'Untitled' });
    await refreshList();
    history.pushState(null, '', noteUrl(title));
    openNote(title);
    setPreview(false);
    // Let the user name it right away.
    titleInput.focus();
    titleInput.select();
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function renameNote(): Promise<void> {
  if (!session) return;
  const from = session.title;
  const to = titleInput.value.trim();
  if (!to || to === from) { titleInput.value = from; return; }
  try {
    const { title } = await api('PATCH', '/api/notes/' + encodeURIComponent(from), { title: to });
    titleInput.value = title;
    if (session && session.title === from) session.title = title;
    document.title = `${title} · Mdpad`;
    history.replaceState(null, '', noteUrl(title));
    await refreshList();
  } catch (err) {
    showToast((err as Error).message);
    if (session) titleInput.value = session.title;
  }
}

async function deleteNote(): Promise<void> {
  if (!session) return;
  const title = session.title;
  if (!confirm(`Delete "${title}"? This removes ${title}.md from disk.`)) return;
  // Leave the note first, so the server's "deleted" notice goes to others only.
  session.close();
  session = null;
  try {
    await api('DELETE', '/api/notes/' + encodeURIComponent(title));
    await refreshList();
    openDefault();
  } catch (err) {
    showToast((err as Error).message);
    openNote(title);
  }
}

// ---------------------------------------------------------------- wiring

binding.onChange = () => renderPreview();

conn.onMessage = (msg) => {
  if (msg.type === 'notes') {
    void refreshList();
    return;
  }
  session?.handle(msg);
};
conn.onOpen = () => {
  session?.open();
  void refreshList();
};
conn.onStatus = (status) => {
  if (status !== 'online') session?.disconnected();
  updateStatus();
};

$('toggle-sidebar').addEventListener('click', () => setSidebar(!app.classList.contains('sidebar-open')));
$('scrim').addEventListener('click', () => setSidebar(false, false));
$('new-note').addEventListener('click', () => void createNote());
$('empty-new').addEventListener('click', () => void createNote());
$('delete-note').addEventListener('click', () => void deleteNote());
previewButton.addEventListener('click', () => setPreview(!previewing));

list.addEventListener('click', (e) => {
  // Re-selecting the open note on a phone should still close the drawer.
  if ((e.target as HTMLElement).closest('a') && mobile.matches) setSidebar(false, false);
});

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
  else if (e.key === 'Escape') { titleInput.value = session?.title ?? ''; editor.focus(); }
});
titleInput.addEventListener('change', () => void renameNote());

preview.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (a && a.origin !== location.origin) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'e' && !e.shiftKey) { e.preventDefault(); if (session) setPreview(!previewing); }
  else if (key === 's') { e.preventDefault(); updateStatus(); }
  else if (key === '\\') { e.preventDefault(); setSidebar(!app.classList.contains('sidebar-open')); }
});

mobile.addEventListener('change', () => setSidebar(mobile.matches ? false : store('mdpad.sidebar') !== '0', false));
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => void refreshList());
window.addEventListener('beforeunload', (e) => {
  if (session && !session.synced) e.preventDefault();
});
setInterval(renderList, 60000); // keep the "x min ago" labels fresh

// ---------------------------------------------------------------- start

setSidebar(mobile.matches ? false : store('mdpad.sidebar') !== '0', false);
setPreview(store('mdpad.preview') === '1');
updateStatus();
requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove('booting')));
conn.start();
void refreshList().then(route);
