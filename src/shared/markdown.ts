// A small Markdown to HTML renderer covering CommonMark basics plus the common
// GitHub extensions (tables, task lists, strikethrough). Raw HTML in the input
// is escaped, so the output is safe to put into the page.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Only allow link targets that cannot run script.
function safeUrl(url: string): string {
  const u = url.trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.{0,2}\/)/i.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // relative path
  return '#';
}

const BLANK = /^\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+(.*)|$)/;
const TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

export function renderInline(src: string): string {
  const slots: string[] = [];
  const keep = (html: string): string => '\u0000' + (slots.push(html) - 1) + '\u0000';
  let s = src.replace(/\u0000/g, '');

  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, (_, c: string) => keep(escapeHtml(c)));
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
    if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
    return keep('<code>' + escapeHtml(code) + '</code>');
  });
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, alt: string, url: string, title?: string) =>
    keep('<img src="' + escapeHtml(safeUrl(url)) + '" alt="' + escapeHtml(alt) + '"' +
      (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy">'));
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, text: string, url: string, title?: string) =>
    keep('<a href="' + escapeHtml(safeUrl(url)) + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
      renderInline(text) + '</a>'));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_, url: string) =>
    keep('<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>'));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)"'\]])/g, (_, pre: string, url: string) =>
    pre + keep('<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>'));

  s = escapeHtml(s);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');

  // Slots can hold other slots (link text), so restore until none are left.
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
  return s;
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    if (BLANK.test(line)) { i++; continue; }

    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const lang = m[2];
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(lines[i])) {
        body.push(lines[i].replace(new RegExp('^ {0,' + indent + '}'), ''));
        i++;
      }
      i++; // closing fence
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
        escapeHtml(body.join('\n')) + (body.length ? '\n' : '') + '</code></pre>');
      continue;
    }

    if ((m = line.match(HEADING))) {
      const level = m[1].length;
      const html = renderInline(m[2] || '');
      out.push('<h' + level + ' id="' + escapeHtml(slugify(html)) + '">' + html + '</h' + level + '>');
      i++;
      continue;
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !BLANK.test(lines[i])) {
        const q = lines[i].match(QUOTE);
        if (q) body.push(q[1]);
        else if (startsBlock(lines[i])) break;
        else body.push(lines[i]); // lazy continuation
        i++;
      }
      out.push('<blockquote>\n' + renderBlocks(body) + '\n</blockquote>');
      continue;
    }

    if (LIST.test(line)) {
      i = renderList(lines, i, out);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
      const cell = (tag: string, text: string | undefined, k: number) =>
        '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + renderInline(text || '') + '</' + tag + '>';
      let html = '<table>\n<thead>\n<tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr>\n</thead>\n<tbody>\n';
      i += 2;
      while (i < lines.length && !BLANK.test(lines[i]) && lines[i].includes('|')) {
        const row = splitRow(lines[i]);
        html += '<tr>' + head.map((_, k) => cell('td', row[k], k)).join('') + '</tr>\n';
        i++;
      }
      out.push(html + '</tbody>\n</table>');
      continue;
    }

    // Paragraph.
    const para: string[] = [];
    while (i < lines.length && !BLANK.test(lines[i]) && !(para.length && startsBlock(lines[i]))) {
      para.push(lines[i].replace(/^ +/, ''));
      i++;
    }
    out.push('<p>' + renderInline(para.join('\n')) + '</p>');
  }
  return out.join('\n');
}

function renderList(lines: string[], i: number, out: string[]): number {
  const first = lines[i].match(LIST)!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let loose = false;

  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body: string[] = [m[4] || ''];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (BLANK.test(l)) {
        let k = i + 1;
        while (k < lines.length && BLANK.test(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]) > baseIndent && indentOf(lines[k]) >= Math.min(contentIndent, baseIndent + 2)) {
          for (; i < k; i++) body.push('');
          loose = true;
          continue;
        }
        break;
      }
      if (indentOf(l) > baseIndent) { body.push(l.slice(Math.min(indentOf(l), contentIndent))); i++; continue; }
      if (startsBlock(l)) break;
      body.push(l); // lazy continuation
      i++;
    }
    items.push(body);

    if (i < lines.length && BLANK.test(lines[i])) {
      let k = i;
      while (k < lines.length && BLANK.test(lines[k])) k++;
      const next = k < lines.length && lines[k].match(LIST);
      if (next && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) { loose = true; i = k; }
      else break;
    }
  }

  const start = ordered ? parseInt(first[2], 10) : 1;
  let html = ordered ? (start !== 1 ? '<ol start="' + start + '">' : '<ol>') : '<ul>';
  for (const body of items) {
    let checkbox = '';
    const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checkbox = '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ';
      body[0] = task[2];
    }
    let inner = renderBlocks(body);
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1');
    html += '\n<li' + (task ? ' class="task"' : '') + '>' + checkbox + inner + '</li>';
  }
  out.push(html + '\n' + (ordered ? '</ol>' : '</ul>'));
  return i;
}

export function render(src: string): string {
  return renderBlocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}
