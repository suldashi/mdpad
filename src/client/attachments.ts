// Uploading pasted and dropped files. The server stores them next to the
// notes and answers with the relative path that notes link to.

export interface Uploaded {
  url: string;    // "attachments/name-1a2b3c4d5e.png"
  name: string;   // the original file name
  image: boolean; // link it as an image
}

async function uploadFile(file: File): Promise<Uploaded> {
  const res = await fetch('/api/attachments?name=' + encodeURIComponent(file.name || 'file'), {
    method: 'POST',
    headers: { 'X-Mdpad-Upload': '1', 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Could not add ${file.name || 'the file'}: ${data.error || `upload failed (${res.status})`}`);
  return data as Uploaded;
}

// Uploads the files side by side. Returns the ones that made it, in order,
// and reports each failure.
export async function uploadAll(files: File[], onError: (message: string) => void): Promise<Uploaded[]> {
  const results = await Promise.allSettled(files.map(uploadFile));
  const done: Uploaded[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') done.push(r.value);
    else onError((r.reason as Error).message);
  }
  return done;
}

// Image alt text: the file name without its extension.
export function altText(u: Uploaded): string {
  return u.name.replace(/\.[^.]*$/, '') || u.name;
}

function escape(text: string): string {
  return text.replace(/[\\[\]*_`]/g, '\\$&');
}

export function markdownFor(u: Uploaded): string {
  return u.image ? `![${escape(altText(u))}](${u.url})` : `[${escape(u.name)}](${u.url})`;
}

// Files on a paste, if the paste is files. Copying from an office app puts
// a picture of the selection on the clipboard next to its text; the text is
// what's wanted then.
export function pastedFiles(e: ClipboardEvent): File[] {
  const data = e.clipboardData;
  if (!data || !data.files.length || data.getData('text/plain')) return [];
  return Array.from(data.files);
}

export function droppedFiles(e: DragEvent): File[] {
  return Array.from(e.dataTransfer?.files ?? []);
}
