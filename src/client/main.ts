// The app shell: note list, title and the two editor views.

import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css';
import '@milkdown/kit/prose/tables/style/tables.css';
import { Connection } from './connection.js';
import { EditorModel } from './model.js';
import { WysiwygView } from './wysiwyg-view.js';
import { TextareaView } from './textarea-view.js';
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
const raw = $<HTMLTextAreaElement>('raw');
const editorEl = $('editor');
const statusEl = $('status');
const presenceEl = $('presence');
const emptyEl = $('empty');
const toast = $('toast');
const rawButton = $<HTMLButtonElement>('toggle-raw');

const conn = new Connection();
const model = new EditorModel();
const wysiwyg = new WysiwygView(editorEl, model);
const rawView = new TextareaView(raw, model);
let session: NoteSession | null = null;
let notes: NoteInfo[] = [];
let rawMode = false;

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

const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function renderList(): void {
  const current = session?.title;
  list.replaceChildren(...notes.map((note) => {
    const item = document.createElement('div');
    item.className = 'note-item' + (note.title === current ? ' active' : '');
    const a = document.createElement('a');
    a.href = noteUrl(note.title);
    a.className = 'note-link';
    if (note.title === current) a.setAttribute('aria-current', 'page');
    const name = document.createElement('span');
    name.className = 'note-title';
    name.textContent = note.title;
    const time = document.createElement('span');
    time.className = 'note-time';
    time.textContent = timeAgo(note.mtime);
    a.append(name, time);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-button note-delete';
    del.title = 'Delete note';
    del.setAttribute('aria-label', `Delete ${note.title}`);
    del.innerHTML = TRASH_ICON;
    del.addEventListener('click', () => void deleteNote(note.title));
    item.append(a, del);
    return item;
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

// The formatted live editor is the default; the raw Markdown editor is
// there when asked for, and only until the page is reloaded.
function setRaw(on: boolean, focus = true): void {
  rawMode = on;
  rawButton.setAttribute('aria-pressed', String(on));
  rawButton.title = on ? 'Back to formatted view (Ctrl+E)' : 'Edit raw Markdown (Ctrl+E)';
  if (on) { wysiwyg.hide(); rawView.show(); }
  else { rawView.hide(); wysiwyg.show(); }
  // Coming back from raw leaves the formatted view unfocused, so the whole
  // note shows formatted and no line reveals its Markdown until clicked.
  if (on && focus && session && !mobile.matches) focusEditor();
  else if (!on) raw.blur();
}

function focusEditor(): void {
  if (rawMode) raw.focus();
  else wysiwyg.focus();
}

function setEditable(on: boolean): void {
  raw.readOnly = !on;
  wysiwyg.setEditable(on);
  app.classList.toggle('loading', !on);
}

function showEmpty(empty: boolean): void {
  app.classList.toggle('no-note', empty);
  emptyEl.hidden = !empty;
}

function openNote(title: string): void {
  if (session && session.title === title && !session.closed) return;
  if (session) session.close();
  showEmpty(false);
  setEditable(false);
  titleInput.value = title;
  document.title = `${title} · Mdpad`;
  setPresence(1);
  model.reset('');
  const s = new NoteSession(title, conn, model, {
    loaded() {
      setEditable(true);
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

async function deleteNote(title: string): Promise<void> {
  if (!confirm(`Delete "${title}"? This removes ${title}.md from disk.`)) return;
  const wasOpen = session?.title === title;
  // Leave the note first, so the server's "deleted" notice goes to others only.
  if (wasOpen && session) {
    session.close();
    session = null;
  }
  try {
    await api('DELETE', '/api/notes/' + encodeURIComponent(title));
    await refreshList();
    if (wasOpen) openDefault();
  } catch (err) {
    showToast((err as Error).message);
    if (wasOpen) openNote(title);
  }
}

// ---------------------------------------------------------------- wiring

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
rawButton.addEventListener('click', () => setRaw(!rawMode));

list.addEventListener('click', (e) => {
  // Re-selecting the open note on a phone should still close the drawer.
  if ((e.target as HTMLElement).closest('a.note-link') && mobile.matches) setSidebar(false, false);
});

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); focusEditor(); }
  else if (e.key === 'Escape') { titleInput.value = session?.title ?? ''; focusEditor(); }
});
titleInput.addEventListener('change', () => void renameNote());

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'e' && !e.shiftKey) { e.preventDefault(); if (session) setRaw(!rawMode); }
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
setRaw(false, false);
updateStatus();
requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove('booting')));
conn.start();
void refreshList().then(route);
