// Markdown-aware edits shared by both editor views.

export interface Edit {
  start: number;
  end: number;
  text: string;
  caret: number; // where the cursor goes afterwards
}

// What pressing Enter at `pos` does: in a list item it starts the next item,
// and on an empty item it ends the list. Otherwise a plain line break.
export function enterEdit(value: string, start: number, end: number): Edit {
  const plain = { start, end, text: '\n', caret: start + 1 };
  if (start !== end) return plain;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const line = value.slice(lineStart, start);
  const m = line.match(/^(\s*)(>\s*)?([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/);
  if (!m) {
    const quote = line.match(/^(\s*>\s?)/);
    if (quote && line.length > quote[0].length) {
      const text = '\n' + quote[0];
      return { start, end, text, caret: start + text.length };
    }
    return plain;
  }
  const rest = value.slice(start, value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start));
  if (line.length === m[0].length && rest.trim() === '') {
    // Empty item: remove the marker instead of adding another.
    return { start: lineStart, end: start, text: '', caret: lineStart };
  }
  const marker = m[4] ? String(Number(m[4]) + 1) + m[5] : m[3];
  const text = '\n' + m[1] + (m[2] || '') + marker + m[6] + (m[7] ? '[ ] ' : '');
  return { start, end, text, caret: start + text.length };
}

// Wraps the selection in `mark` (for bold and italic), or unwraps it if it
// is already wrapped.
export function wrapEdit(value: string, start: number, end: number, mark: string): Edit {
  const n = mark.length;
  if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark) {
    return { start: start - n, end: end + n, text: value.slice(start, end), caret: end - n };
  }
  const inner = value.slice(start, end);
  return { start, end, text: mark + inner + mark, caret: start === end ? start + n : end + 2 * n };
}
