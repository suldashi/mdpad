// The live preview editor: Markdown shown formatted, editable in place.
//
// The element is contenteditable and holds one <div> per source line. Its
// text is always exactly the note's Markdown: syntax characters are only
// hidden (on lines the cursor isn't on), never removed. That keeps every
// edit a plain text edit, so syncing and undo work the same as in the raw
// editor.
//
// Most typing is intercepted in `beforeinput` and applied to the model,
// which then re-renders the changed lines. Input the browser won't let us
// intercept (IME composition, Android keyboards, spellcheck on some
// browsers) is allowed to change the DOM, and the text is then read back.

import * as OT from '../shared/ot.js';
import { EditorModel, changeEnd, type Change } from './model.js';
import { enterEdit, wrapEdit, type Edit } from './edits.js';
import { renderLines } from './live-render.js';

interface Point {
  node: Node;
  offset: number;
}

interface Sel {
  start: number;
  end: number;
}

const LIST_TASK = /^(\s*(?:>\s*)*)([-*+]|\d{1,9}[.)])(\s+)\[([ xX])\]/;

function isWidget(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains('widget');
}

// A <br> that only keeps an empty line open, as opposed to a line break.
function isPlaceholderBr(br: Node, line: Node): boolean {
  for (let n: Node | null = br; n && n !== line; n = n.parentNode) {
    if (n.nextSibling) return false;
  }
  return true;
}

// Reads the editor's text the same way the model stores it, and optionally
// where some DOM positions fall in that text.
function serialize(root: HTMLElement, points: Point[] = []): { text: string; offsets: number[] } {
  const parts: string[] = [];
  let len = 0;
  const offsets = points.map(() => -1);
  const mark = (node: Node, offset: number) => {
    points.forEach((p, i) => {
      if (offsets[i] === -1 && p.node === node && p.offset === offset) offsets[i] = len;
    });
  };
  const inside = (node: Node) => {
    points.forEach((p, i) => {
      if (offsets[i] === -1 && node.contains(p.node)) offsets[i] = len;
    });
  };

  function walk(node: Node, line: Node): void {
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      points.forEach((p, i) => {
        if (offsets[i] === -1 && p.node === node) offsets[i] = len + Math.min(p.offset, data.length);
      });
      parts.push(data);
      len += data.length;
      return;
    }
    if (node.nodeType !== 1) return;
    if (isWidget(node)) { inside(node); return; }
    const el = node as Element;
    if (el.tagName === 'BR') {
      mark(node, 0);
      if (!isPlaceholderBr(node, line)) { parts.push('\n'); len++; }
      return;
    }
    // A block the browser created inside a line (for example on Enter).
    if ((el.tagName === 'DIV' || el.tagName === 'P') && node !== line && node.previousSibling) {
      parts.push('\n');
      len++;
    }
    const kids = node.childNodes;
    for (let k = 0; k < kids.length; k++) {
      mark(node, k);
      walk(kids[k], line);
    }
    mark(node, kids.length);
  }

  const lines = root.childNodes;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { parts.push('\n'); len++; }
    mark(root, i);
    walk(lines[i], lines[i]);
  }
  mark(root, lines.length);
  return { text: parts.join(''), offsets };
}

export class LiveView {
  readonly root: HTMLElement;
  private model: EditorModel;
  private keys: string[] = [];
  private sel: Sel | null = null;
  private caretAfterEdit: number | null = null;
  private composing = false;
  private activeEls: Element[] = [];
  // The line that was showing its source when the pointer went down, so a
  // click on a link in a formatted line opens it instead of editing it.
  private lineWasActiveBeforeClick: Element | null = null;
  active = false;

  constructor(root: HTMLElement, model: EditorModel) {
    this.root = root;
    this.model = model;
    root.contentEditable = 'true';
    root.spellcheck = true;
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    model.subscribe((change) => this.onChange(change));

    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', () => this.readBack(this.composing ? 'compose' : 'insertText'));
    root.addEventListener('compositionstart', () => { this.composing = true; });
    root.addEventListener('compositionend', () => {
      this.composing = false;
      this.readBack('insertText');
      this.render(true);
      this.restoreSelection();
    });
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('drop', (e) => this.onDrop(e));
    root.addEventListener('dragstart', (e) => e.preventDefault());
    root.addEventListener('mousedown', (e) => this.onMouseDown(e));
    root.addEventListener('pointerdown', (e) => {
      const line = (e.target as Element).closest('.ln');
      this.lineWasActiveBeforeClick = line && line.classList.contains('active') ? line : null;
    }, true);
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('focus', () => this.updateActive());
    root.addEventListener('blur', () => { this.sel = null; this.updateActive(); });
    document.addEventListener('selectionchange', () => this.onSelectionChange());
  }

  show(): void {
    this.active = true;
    this.root.hidden = false;
    this.render(true);
  }

  hide(): void {
    this.active = false;
    this.root.hidden = true;
  }

  focus(): void {
    this.root.focus();
  }

  // ------------------------------------------------------------ rendering

  // Re-renders the lines whose output changed, or everything when `full`.
  private render(full = false): void {
    const value = this.model.value;
    const rendered = renderLines(value.split('\n'));
    const keys = rendered.map((r) => r.cls + '\u0001' + r.block + '\u0001' + r.html);
    const root = this.root;
    const make = (i: number): HTMLElement => {
      const div = document.createElement('div');
      div.className = rendered[i].cls;
      if (rendered[i].block) div.dataset.block = String(rendered[i].block);
      div.innerHTML = rendered[i].html;
      return div;
    };

    const old = this.keys;
    if (full || root.childNodes.length !== old.length || root.children.length !== old.length) {
      const scroll = root.scrollTop;
      root.replaceChildren(...rendered.map((_, i) => make(i)));
      root.scrollTop = scroll;
    } else {
      let a = 0;
      while (a < old.length && a < keys.length && old[a] === keys[a]) a++;
      let b = 0;
      while (b < old.length - a && b < keys.length - a && old[old.length - 1 - b] === keys[keys.length - 1 - b]) b++;
      for (let k = old.length - b - 1; k >= a; k--) root.children[k].remove();
      const before = root.children[a] || null;
      for (let k = a; k < keys.length - b; k++) root.insertBefore(make(k), before);
    }
    this.keys = keys;
    this.activeEls = [];
    root.classList.toggle('is-empty', value === '');
    this.updateActive();
  }

  // Marks the lines the cursor is on, which show their Markdown syntax.
  private updateActive(): void {
    for (const el of this.activeEls) el.classList.remove('active', 'block-active');
    this.activeEls = [];
    if (!this.sel || document.activeElement !== this.root) return;
    const value = this.model.value;
    const first = countLines(value, this.sel.start);
    const last = countLines(value, this.sel.end);
    const blocks = new Set<string>();
    for (let i = first; i <= last && i < this.root.children.length; i++) {
      const el = this.root.children[i];
      el.classList.add('active');
      this.activeEls.push(el);
      const block = (el as HTMLElement).dataset.block;
      if (block) blocks.add(block);
    }
    for (const block of blocks) {
      for (const el of this.root.querySelectorAll(`[data-block="${block}"]`)) {
        el.classList.add('block-active');
        this.activeEls.push(el);
      }
    }
  }

  // ------------------------------------------------------------ positions

  private lineEl(index: number): Element | null {
    return this.root.children[index] || null;
  }

  // The DOM position for a text offset. Assumes the DOM shows the model.
  private toDom(offset: number): Point {
    const value = this.model.value;
    const line = countLines(value, offset);
    const lineStart = value.lastIndexOf('\n', offset - 1) + 1;
    const el = this.lineEl(line);
    if (!el) return { node: this.root, offset: this.root.childNodes.length };
    let local = offset - lineStart;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isWidget(n) ? NodeFilter.FILTER_REJECT : n.nodeType === 3 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    });
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (local <= t.data.length) return { node: t, offset: local };
      local -= t.data.length;
      last = t;
    }
    return last ? { node: last, offset: last.data.length } : { node: el, offset: 0 };
  }

  private readSelection(): Sel | null {
    const s = document.getSelection();
    if (!s || !s.anchorNode || !this.root.contains(s.anchorNode) || !s.focusNode || !this.root.contains(s.focusNode)) return null;
    const { offsets } = serialize(this.root, [
      { node: s.anchorNode, offset: s.anchorOffset },
      { node: s.focusNode, offset: s.focusOffset }
    ]);
    const [a, f] = offsets;
    if (a < 0 || f < 0) return null;
    return { start: Math.min(a, f), end: Math.max(a, f) };
  }

  private rangeOffsets(range: StaticRange | Range): Sel | null {
    const { offsets } = serialize(this.root, [
      { node: range.startContainer, offset: range.startOffset },
      { node: range.endContainer, offset: range.endOffset }
    ]);
    if (offsets[0] < 0 || offsets[1] < 0) return null;
    return { start: Math.min(offsets[0], offsets[1]), end: Math.max(offsets[0], offsets[1]) };
  }

  private setSelection(start: number, end = start): void {
    this.sel = { start, end };
    if (document.activeElement === this.root) {
      const a = this.toDom(start);
      const b = start === end ? a : this.toDom(end);
      document.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    }
    this.updateActive();
  }

  private restoreSelection(): void {
    if (this.sel) this.setSelection(this.sel.start, this.sel.end);
  }

  private onSelectionChange(): void {
    if (!this.active || this.composing) return;
    const sel = this.readSelection();
    if (!sel) return;
    this.sel = sel;
    this.updateActive();
  }

  // ------------------------------------------------------------ editing

  private applyEdit(edit: Edit, kind: string): void {
    this.caretAfterEdit = edit.caret;
    this.model.replace(edit.start, edit.end, edit.text, kind, this);
  }

  private replaceRange(range: Sel, text: string, kind: string): void {
    this.applyEdit({ start: range.start, end: range.end, text, caret: range.start + text.length }, kind);
  }

  private targetRange(e: InputEvent): Sel | null {
    const ranges = e.getTargetRanges();
    if (ranges.length) return this.rangeOffsets(ranges[0]);
    return this.readSelection();
  }

  private onBeforeInput(e: InputEvent): void {
    if (e.isComposing || this.composing) return; // read back after the browser is done
    const type = e.inputType;

    if (type === 'historyUndo' || type === 'historyRedo') {
      e.preventDefault();
      if (type === 'historyUndo') this.model.undo(); else this.model.redo();
      return;
    }
    if (type.startsWith('format')) {
      e.preventDefault();
      const sel = this.readSelection();
      if (sel && (type === 'formatBold' || type === 'formatItalic')) {
        this.applyEdit(wrapEdit(this.model.value, sel.start, sel.end, type === 'formatBold' ? '**' : '*'), 'format');
      }
      return;
    }
    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      const sel = this.targetRange(e);
      if (!sel) return;
      e.preventDefault();
      this.applyEdit(enterEdit(this.model.value, sel.start, sel.end), 'insertLineBreak');
      return;
    }
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromYank') {
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? null;
      const sel = this.targetRange(e);
      if (text === null || !sel) return;
      e.preventDefault();
      this.replaceRange(sel, text.replace(/\r\n?/g, '\n'), type === 'insertText' && !/\s/.test(text) ? 'insertText' : 'insertWord');
      return;
    }
    if (type.startsWith('delete') && type !== 'deleteByDrag') {
      const sel = this.targetRange(e);
      if (!sel) return;
      e.preventDefault();
      if (sel.start === sel.end) {
        // No target range given: delete one character.
        const value = this.model.value;
        if (type.endsWith('Backward') && sel.start > 0) sel.start -= isLowSurrogate(value, sel.start - 1) ? 2 : 1;
        else if (type.endsWith('Forward') && sel.end < value.length) sel.end += isHighSurrogate(value, sel.end) ? 2 : 1;
        if (sel.start === sel.end) return;
      }
      this.replaceRange(sel, '', 'delete');
    }
    // Anything else: let the browser do it, then read the text back.
  }

  // Picks up changes the browser made to the DOM itself.
  private readBack(kind: string): void {
    if (!this.active) return;
    const s = document.getSelection();
    const points: Point[] = s && s.anchorNode && this.root.contains(s.anchorNode) && s.focusNode
      ? [{ node: s.anchorNode, offset: s.anchorOffset }, { node: s.focusNode, offset: s.focusOffset }]
      : [];
    const { text, offsets } = serialize(this.root, points);
    if (offsets.length === 2 && offsets[0] >= 0 && offsets[1] >= 0) {
      this.sel = { start: Math.min(offsets[0], offsets[1]), end: Math.max(offsets[0], offsets[1]) };
    }
    if (text === this.model.value) return;
    const op = OT.fromDiff(this.model.value, text);
    this.caretAfterEdit = null;
    this.model.local(op, kind === 'compose' ? 'insertText' : kind, this);
  }

  private onChange(change: Change): void {
    if (!this.active) return;
    if (change.origin === 'reset') {
      this.sel = null;
      this.render(true);
      return;
    }
    const op = change.op!;
    if (change.source === this) {
      if (this.caretAfterEdit !== null) {
        // We applied this edit ourselves; the DOM still shows the old text.
        const caret = this.caretAfterEdit;
        this.caretAfterEdit = null;
        this.render();
        this.setSelection(caret);
      } else if (this.composing) {
        // The browser already shows the text. Leave the DOM alone so the
        // composition isn't interrupted; tidy up when it ends.
        this.keys = renderLines(this.model.value.split('\n')).map((r) => r.cls + '\u0001' + r.block + '\u0001' + r.html);
      } else {
        this.render(true);
        this.restoreSelection();
      }
      return;
    }
    if (change.origin === 'remote') {
      const sel = this.sel;
      this.render();
      if (sel && !this.composing) this.setSelection(OT.transformIndex(sel.start, op), OT.transformIndex(sel.end, op));
      else if (sel) this.sel = { start: OT.transformIndex(sel.start, op), end: OT.transformIndex(sel.end, op) };
      return;
    }
    // Undo, redo, or an edit made in the other view.
    this.render();
    const at = changeEnd(op);
    this.setSelection(at);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.model.redo(); else this.model.undo();
    } else if (mod && !e.altKey && !e.shiftKey && key === 'y') {
      e.preventDefault();
      this.model.redo();
    } else if (mod && !e.altKey && !e.shiftKey && (key === 'b' || key === 'i')) {
      e.preventDefault();
      const sel = this.readSelection();
      if (sel) this.applyEdit(wrapEdit(this.model.value, sel.start, sel.end, key === 'b' ? '**' : '*'), 'format');
    }
  }

  // Copying gives the Markdown source, not the formatted text.
  private onCopy(e: ClipboardEvent, cut: boolean): void {
    const sel = this.readSelection();
    if (!sel || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', this.model.value.slice(sel.start, sel.end));
    if (cut && sel.start !== sel.end) this.replaceRange(sel, '', 'cut');
  }

  private onPaste(e: ClipboardEvent): void {
    const sel = this.readSelection();
    if (!sel || !e.clipboardData) return;
    e.preventDefault();
    this.replaceRange(sel, e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'), 'paste');
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const text = e.dataTransfer?.getData('text/plain');
    if (!text) return;
    let range: Range | null = null;
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    } else if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    }
    const sel = range && this.rangeOffsets(range);
    if (sel) this.replaceRange({ start: sel.start, end: sel.start }, text.replace(/\r\n?/g, '\n'), 'paste');
  }

  private onMouseDown(e: MouseEvent): void {
    // Clicking a checkbox shouldn't move the cursor.
    if ((e.target as Element).closest('.widget.check')) e.preventDefault();
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element;
    const check = target.closest('.widget.check');
    if (check) {
      e.preventDefault();
      this.toggleTask(check.parentElement!);
      return;
    }
    // Links open with Ctrl/Cmd-click, or a plain click while the line is
    // showing its formatted form.
    const link = target.closest('a.md-link') as HTMLAnchorElement | null;
    if (link && link.getAttribute('href')) {
      const line = link.closest('.ln');
      const wasActive = line && line.classList.contains('active') && this.lineWasActiveBeforeClick === line;
      if (e.ctrlKey || e.metaKey || !wasActive) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener,noreferrer');
        return;
      }
      e.preventDefault();
    }
  }

  private toggleTask(line: Element): void {
    const index = Array.prototype.indexOf.call(this.root.children, line);
    if (index < 0) return;
    const value = this.model.value;
    let start = 0;
    for (let i = 0; i < index; i++) start = value.indexOf('\n', start) + 1;
    const end = value.indexOf('\n', start);
    const text = value.slice(start, end === -1 ? value.length : end);
    const m = text.match(LIST_TASK);
    if (!m) return;
    const at = start + m[1].length + m[2].length + m[3].length + 1;
    this.caretAfterEdit = null; // the cursor stays where it is
    this.model.replace(at, at + 1, m[4] === ' ' ? 'x' : ' ', 'toggle', this);
  }

}

function countLines(value: string, offset: number): number {
  let n = 0;
  for (let i = value.indexOf('\n'); i !== -1 && i < offset; i = value.indexOf('\n', i + 1)) n++;
  return n;
}

function isLowSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff && i > 0 && isHighSurrogate(s, i - 1);
}

function isHighSurrogate(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}
