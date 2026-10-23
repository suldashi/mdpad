// The raw editor: a plain <textarea> showing the Markdown source.

import * as OT from '../shared/ot.js';
import { EditorModel, changeEnd, type Change } from './model.js';
import { enterEdit, wrapEdit, type Edit } from './edits.js';

export class TextareaView {
  readonly ta: HTMLTextAreaElement;
  private model: EditorModel;
  private shown = '';
  active = false;

  constructor(ta: HTMLTextAreaElement, model: EditorModel) {
    this.ta = ta;
    this.model = model;
    model.subscribe((change) => this.onChange(change));

    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); model.undo(); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); model.redo(); }
    });
    ta.addEventListener('input', (e) => this.sync((e as InputEvent).inputType || 'insertText'));
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  // Shows the model's text after the view was hidden.
  show(): void {
    this.active = true;
    this.ta.hidden = false;
    if (this.ta.value !== this.model.value) this.ta.value = this.model.value;
    this.shown = this.model.value;
  }

  hide(): void {
    this.active = false;
    this.ta.hidden = true;
  }

  // Reads the textarea and reports what changed.
  private sync(inputType: string): void {
    const next = this.ta.value;
    if (next === this.shown) return;
    const op = OT.fromDiff(this.shown, next);
    this.shown = next;
    this.model.local(op, inputType.startsWith('delete') ? 'delete' : inputType, this);
  }

  private onChange(change: Change): void {
    if (!this.active || change.source === this) return;
    const ta = this.ta;
    const scroll = ta.scrollTop;
    if (!change.op) {
      ta.value = this.model.value;
    } else if (change.origin === 'remote') {
      const focused = document.activeElement === ta;
      const start = ta.selectionStart, end = ta.selectionEnd, dir = ta.selectionDirection;
      ta.value = this.model.value;
      if (focused) ta.setSelectionRange(OT.transformIndex(start, change.op), OT.transformIndex(end, change.op), dir);
    } else {
      ta.value = this.model.value;
      const at = changeEnd(change.op);
      ta.setSelectionRange(at, at);
    }
    ta.scrollTop = scroll;
    this.shown = this.model.value;
  }

  private apply(edit: Edit, kind: string): void {
    this.ta.setRangeText(edit.text, edit.start, edit.end);
    this.ta.setSelectionRange(edit.caret, edit.caret);
    this.sync(kind);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const { selectionStart: start, selectionEnd: end } = this.ta;
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.model.redo(); else this.model.undo();
    } else if (mod && !e.altKey && !e.shiftKey && key === 'y') {
      e.preventDefault();
      this.model.redo();
    } else if (mod && !e.altKey && !e.shiftKey && (key === 'b' || key === 'i')) {
      e.preventDefault();
      this.apply(wrapEdit(this.model.value, start, end, key === 'b' ? '**' : '*'), 'format');
    } else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      const edit = enterEdit(this.model.value, start, end);
      if (edit.text !== '\n') {
        e.preventDefault();
        this.apply(edit, 'insertLineBreak');
      }
    }
  }
}
