// The text of the open note, shared by the editor views. It records local
// edits for undo and hands them to the sync session, and takes in remote
// edits. Undo only ever takes back this user's own edits, re-based over
// whatever other people changed since.

import * as OT from '../shared/ot.js';

const GROUP_WINDOW = 1000; // ms; typing within this window undoes together

export type ChangeOrigin = 'local' | 'remote' | 'undo' | 'reset';

export interface Change {
  op: OT.Op | null; // null when the whole text was replaced
  origin: ChangeOrigin;
  source?: unknown; // the view that made a local edit
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

// Where the cursor should land after an operation: just past its last change.
export function changeEnd(op: OT.Op): number {
  let pos = 0, end = 0;
  for (const c of op) {
    if (typeof c === 'string') { pos += c.length; end = pos; }
    else if (c > 0) pos += c;
    else end = pos;
  }
  return end;
}

// An operation that replaces text[start, end) with `insert`.
export function replaceOp(length: number, start: number, end: number, insert: string): OT.Op {
  const op: OT.Op = [];
  OT.retain(op, start);
  OT.insert(op, insert);
  OT.del(op, end - start);
  OT.retain(op, length - end);
  return op;
}

export class EditorModel {
  value = '';
  onLocalOp: (op: OT.Op) => void = () => {};
  private listeners: Array<(change: Change) => void> = [];
  private undoStack: OT.Op[] = [];
  private redoStack: OT.Op[] = [];
  private lastEditAt = 0;
  private lastKind = '';

  subscribe(fn: (change: Change) => void): void {
    this.listeners.push(fn);
  }

  private emit(change: Change): void {
    for (const fn of this.listeners) fn(change);
  }

  reset(text: string): void {
    this.value = text;
    this.undoStack = [];
    this.redoStack = [];
    this.lastKind = '';
    this.emit({ op: null, origin: 'reset' });
  }

  // A local edit. `kind` groups consecutive typing into one undo step.
  local(op: OT.Op, kind: string, source?: unknown): void {
    if (OT.isNoop(op)) return;
    const inverse = OT.invert(this.value, op);
    this.value = OT.apply(this.value, op);

    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    const groupable = kind === 'insertText' || kind === 'delete';
    if (top && groupable && kind === this.lastKind && now - this.lastEditAt < GROUP_WINDOW) {
      this.undoStack[this.undoStack.length - 1] = OT.compose(inverse, top);
    } else {
      this.undoStack.push(inverse);
      if (this.undoStack.length > 500) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastEditAt = now;
    this.lastKind = kind;

    this.onLocalOp(op);
    this.emit({ op, origin: 'local', source });
  }

  // Replaces text[start, end) as a local edit.
  replace(start: number, end: number, text: string, kind: string, source?: unknown): void {
    this.local(replaceOp(this.value.length, start, end, text), kind, source);
  }

  remote(op: OT.Op): void {
    if (OT.isNoop(op)) return;
    this.value = OT.apply(this.value, op);
    this.undoStack = transformStack(this.undoStack, op);
    this.redoStack = transformStack(this.redoStack, op);
    this.emit({ op, origin: 'remote' });
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(OT.invert(this.value, op));
    this.applyHistory(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(OT.invert(this.value, op));
    this.applyHistory(op);
  }

  private applyHistory(op: OT.Op): void {
    this.value = OT.apply(this.value, op);
    this.lastKind = '';
    this.onLocalOp(op);
    this.emit({ op, origin: 'undo' });
  }
}
