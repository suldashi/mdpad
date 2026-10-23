// Renders Markdown source for the live preview editor. Every character of
// the source stays in the output, in order, so the page can be edited like
// plain text: Markdown syntax is wrapped in `.mk` spans that are hidden on
// lines the cursor is not on. Extras that are not part of the text (images,
// checkboxes) go in `contenteditable=false` widgets that the editor skips when
// reading text back.
//
// This module has no DOM dependencies, so it is tested in Node.

export interface RenderedLine {
  html: string;
  cls: string;    // classes for the line element
  block: number;  // lines of one fenced code block share a number; 0 otherwise
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mk(s: string): string {
  return s ? `<span class="mk">${esc(s)}</span>` : '';
}

function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.{0,2}\/)/i.test(u)) return u;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return null;
}

interface Rule {
  re: RegExp;
  render(m: RegExpExecArray, prev: string): string | null; // null: not a match here
}

const RULES: Rule[] = [
  { // backslash escape
    re: /\\([\\`*_{}\[\]()#+\-.!~|>])/y,
    render: (m) => mk('\\') + esc(m[1])
  },
  { // code span
    re: /(`+)([^`]|[^`].*?[^`])\1(?!`)/y,
    render: (m) => mk(m[1]) + `<code>${esc(m[2])}</code>` + mk(m[1])
  },
  { // image
    re: /!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/y,
    render: (m) => {
      const url = safeUrl(m[2]);
      const widget = url ? `<span class="widget img" contenteditable="false"><img src="${esc(url)}" alt="${esc(m[1])}" loading="lazy"></span>` : '';
      return mk('![') + `<span class="img-alt">${esc(m[1])}</span>` + mk('](' + m[2] + m[3] + ')') + widget;
    }
  },
  { // link
    re: /\[([^\]]+)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/y,
    render: (m) => {
      const url = safeUrl(m[2]);
      return mk('[') + `<a class="md-link"${url ? ` href="${esc(url)}"` : ''}>${inline(m[1])}</a>` + mk('](' + m[2] + m[3] + ')');
    }
  },
  { // autolink in angle brackets
    re: /<((?:https?:\/\/|mailto:)[^>\s]+)>/y,
    render: (m) => mk('<') + `<a class="md-link" href="${esc(m[1])}">${esc(m[1])}</a>` + mk('>')
  },
  { // bare URL
    re: /https?:\/\/[^\s<]*[^\s<.,;:!?)"'\]]/y,
    render: (m, prev) => (/[\w/]/.test(prev) ? null : `<a class="md-link" href="${esc(m[0])}">${esc(m[0])}</a>`)
  },
  { // bold
    re: /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/y,
    render: (m, prev) => (m[1] === '__' && /\w/.test(prev) ? null : mk(m[1]) + `<strong>${inline(m[2])}</strong>` + mk(m[1]))
  },
  { // strikethrough
    re: /~~(?=\S)(.+?)(?<=\S)~~/y,
    render: (m) => mk('~~') + `<del>${inline(m[1])}</del>` + mk('~~')
  },
  { // italic
    re: /([*_])(?=[^\s*_])(.+?)(?<=[^\s])\1(?![*_\w])/y,
    render: (m, prev) => (m[1] === '_' && /\w/.test(prev) ? null : mk(m[1]) + `<em>${inline(m[2])}</em>` + mk(m[1]))
  }
];

export function inline(text: string): string {
  let out = '';
  let plain = '';
  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i];
    if ('\\`![<h*_~'.includes(ch)) {
      for (const rule of RULES) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (!m) continue;
        const html = rule.render(m, i > 0 ? text[i - 1] : '');
        if (html === null) continue;
        out += esc(plain) + html;
        plain = '';
        i += m[0].length;
        continue outer;
      }
    }
    plain += ch;
    i++;
  }
  return out + esc(plain);
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^(\s{0,3}#{1,6})(\s+|$)(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^(\s*>\s?)(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s)?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// Renders the content of a line that is not a code block or rule, after any
// block quote markers.
function renderContent(text: string, classes: string[], quoteDepth: number): string {
  let m: RegExpMatchArray | null;
  if ((m = text.match(QUOTE))) {
    classes.push('quote');
    return mk(m[1]) + renderContent(m[2], classes, quoteDepth + 1);
  }
  if ((m = text.match(HEADING))) {
    classes.push('h' + m[1].trim().length);
    return mk(m[1] + m[2]) + inline(m[3]);
  }
  if ((m = text.match(LIST))) {
    const [, indent, marker, space, task, rest] = m;
    const ordered = /\d/.test(marker);
    classes.push('li', ordered ? 'ol' : 'ul');
    let html = indent ? `<span class="indent">${esc(indent)}</span>` : '';
    html += ordered
      ? `<span class="num">${esc(marker)}</span>${esc(space)}`
      : `<span class="bullet"><span class="mk-bullet">${esc(marker)}</span></span>${esc(space)}`;
    if (task) {
      const done = task[1] !== ' ';
      classes.push('task');
      if (done) classes.push('done');
      html += `<span class="widget check" contenteditable="false"><input type="checkbox" tabindex="-1"${done ? ' checked' : ''}></span>` + mk(task);
    }
    return html + inline(rest);
  }
  return inline(text);
}

export function renderLines(lines: string[]): RenderedLine[] {
  const out: RenderedLine[] = [];
  let fence: { char: string; len: number; block: number } | null = null;
  let blocks = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    if (fence) {
      const close = line.match(FENCE);
      if (close && close[2][0] === fence.char && close[2].length >= fence.len && !close[3].trim()) {
        out.push({ html: mk(line), cls: 'ln fence fence-close', block: fence.block });
        fence = null;
      } else {
        out.push({ html: line ? `<code>${esc(line)}</code>` : '<br>', cls: 'ln code', block: fence.block });
      }
      continue;
    }

    if ((m = line.match(FENCE)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      fence = { char: m[2][0], len: m[2].length, block: ++blocks };
      const lang = m[3].trim();
      out.push({
        html: mk(m[1] + m[2]) + (lang ? `<span class="lang">${esc(m[3])}</span>` : esc(m[3])),
        cls: 'ln fence fence-open',
        block: fence.block
      });
      continue;
    }

    if (!line) {
      out.push({ html: '<br>', cls: 'ln empty', block: 0 });
      continue;
    }

    // "---" right under a paragraph line is a heading underline, not a rule.
    const prev = i > 0 ? lines[i - 1] : '';
    const underline = /^\s*-+\s*$/.test(line) && prev.trim() !== '' &&
      !QUOTE.test(prev) && !LIST.test(prev) && !HEADING.test(prev) && !HR.test(prev);
    if (HR.test(line) && !underline) {
      out.push({ html: mk(line), cls: 'ln hr', block: 0 });
      continue;
    }

    // Tables stay as aligned source; the separator row is dimmed.
    if (line.includes('|') && (TABLE_SEP.test(line) && line.includes('-') ||
        (i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) ||
        (out.length && out[out.length - 1].cls.includes('table')))) {
      const sep = TABLE_SEP.test(line);
      out.push({ html: sep ? mk(line) : inline(line), cls: 'ln table' + (sep ? ' table-sep' : ''), block: 0 });
      continue;
    }

    const classes = ['ln'];
    const html = renderContent(line, classes, 0);
    out.push({ html, cls: classes.join(' '), block: 0 });
  }
  return out;
}
