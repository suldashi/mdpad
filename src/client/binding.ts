// Connects a <textarea> to OT: turns typing into operations, applies remote
// operations without moving the user's cursor, and keeps its own undo history
// (the browser's history is lost whenever remote edits rewrite the value).

import * as OT from '../shared/ot.js';

const GROUP_WINDOW = 1000; // ms; typing within this window undoes together

// Where the cursor should land after an operation: just past its last change.
function changeEnd(op: OT.Op): number {
  let pos = 0, end = 0;
  for (const c of op) {
    if (typeof c === 'string') { pos += c.length; end = pos; }
    else if (c > 0) pos += c;
    else end = pos;
  }
  return end;
}

// Re-bases an undo or redo stack over a remote operation. The top entry
// applies to the current text, the next one to the text after undoing the
// top, and so on.
function transformStack(stack: OT.Op[], op: OT.Op): OT.Op[] {
  const out: OT.Op[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const [entry, rest] = OT.transform(stack[i], op);
    if (!OT.isNoop(entry)) out.push(entry);
    op = rest;
  }
  return out.reverse();
}

export class TextBinding {
  readonly ta: HTMLTextAreaElement;
  value: string;
  onLocalOp: (op: OT.Op) => void = () => {};
  onChange: () => void = () => {};
  private undoStack: OT.Op[] = [];
  private redoStack: OT.Op[] = [];
  private lastEditAt = 0;
  private lastInputType = '';

  constructor(ta: HTMLTextAreaElement) {
    this.ta = ta;
    this.value = ta.value;

    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); }
    });
    ta.addEventListener('input', (e) => this.sync((e as InputEvent).inputType || 'insertText'));
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  setText(text: string): void {
    this.ta.value = text;
    this.value = text;
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }

  // Reads the textarea and reports what changed since the last look.
  sync(inputType = 'insertText'): void {
    const next = this.ta.value;
    if (next === this.value) return;
    const op = OT.fromDiff(this.value, next);
    const inverse = OT.invert(this.value, op);
    this.value = next;

    const now = Date.now();
    const kind = inputType.startsWith('delete') ? 'delete' : inputType;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && kind === this.lastInputType && (kind === 'insertText' || kind === 'delete') && now - this.lastEditAt < GROUP_WINDOW) {
      this.undoStack[this.undoStack.length - 1] = OT.compose(inverse, top);
    } else {
      this.undoStack.push(inverse);
      if (this.undoStack.length > 500) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastEditAt = now;
    this.lastInputType = kind;

    this.onLocalOp(op);
    this.onChange();
  }

  // Applies an operation that came from someone else.
  applyRemote(op: OT.Op): void {
    if (OT.isNoop(op)) return;
    const ta = this.ta;
    const focused = document.activeElement === ta;
    const start = ta.selectionStart, end = ta.selectionEnd, dir = ta.selectionDirection;
    const scroll = ta.scrollTop;
    this.value = OT.apply(this.value, op);
    ta.value = this.value;
    if (focused) ta.setSelectionRange(OT.transformIndex(start, op), OT.transformIndex(end, op), dir);
    ta.scrollTop = scroll;
    this.undoStack = transformStack(this.undoStack, op);
    this.redoStack = transformStack(this.redoStack, op);
    this.onChange();
  }

  private applyLocal(op: OT.Op): void {
    this.value = OT.apply(this.value, op);
    const scroll = this.ta.scrollTop;
    this.ta.value = this.value;
    this.ta.scrollTop = scroll;
    const at = changeEnd(op);
    this.ta.setSelectionRange(at, at);
    this.lastInputType = '';
    this.onLocalOp(op);
    this.onChange();
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(OT.invert(this.value, op));
    this.applyLocal(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(OT.invert(this.value, op));
    this.applyLocal(op);
  }

  // Replaces the selection, the way typing would.
  replaceSelection(text: string, inputType = 'insertReplacementText'): void {
    this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
    this.sync(inputType);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      if (this.continueList()) e.preventDefault();
    }
  }

  // Pressing Enter in a list item starts the next item; pressing it on an
  // empty item ends the list.
  private continueList(): boolean {
    const ta = this.ta;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const pos = ta.selectionStart;
    const lineStart = this.value.lastIndexOf('\n', pos - 1) + 1;
    const line = this.value.slice(lineStart, pos);
    const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/);
    if (!m) return false;
    if (line.length === m[0].length && this.value.slice(pos, pos + 1).match(/^(\n|$)/)) {
      // Empty item: remove the marker instead of adding another.
      ta.setSelectionRange(lineStart, pos);
      this.replaceSelection('', 'deleteContentBackward');
      return true;
    }
    const marker = m[3] ? String(Number(m[3]) + 1) + m[4] : m[2];
    const task = m[6] ? '[ ] ' : '';
    this.replaceSelection('\n' + m[1] + marker + m[5] + task, 'insertLineBreak');
    return true;
  }
}
