// The formatted editor, built on Milkdown (ProseMirror with a Markdown
// parser and serializer). Markdown typed into it turns into formatting as
// you type: `**bold**` becomes bold and the stars go away.
//
// The note itself stays Markdown text, synced with OT. This view turns each
// editor change into a text edit by serializing the document, and applies
// text edits from elsewhere by parsing the new text and replacing only the
// part of the document that changed.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { commonmark, remarkPreserveEmptyLinePlugin, syncHeadingIdPlugin, headingIdGenerator } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { diffOp, rebaseEdit } from '../shared/diff.js';
import type { EditorModel, Change } from './model.js';
import { uploadAll, altText, pastedFiles, droppedFiles } from './attachments.js';

// Marks where uploading files will go, so the spot moves with edits made
// while they upload.
const uploadKey = new PluginKey<DecorationSet>('mdpad-upload');
type UploadAction = { add: { id: symbol; pos: number; label: string } } | { remove: symbol };

export class WysiwygView {
  readonly root: HTMLElement;
  private model: EditorModel;
  private view: EditorView | null = null;
  private parse: ((md: string) => PMNode) | null = null;
  private serialize: ((doc: PMNode) => string) | null = null;
  private serialized = '';   // the editor's own Markdown for the current document
  private applying = false;  // true while we apply a change that came from the model
  private editable = true;
  active = false;
  onError: (message: string) => void = () => {};
  readonly ready: Promise<void>;

  constructor(root: HTMLElement, model: EditorModel) {
    this.root = root;
    this.model = model;
    model.subscribe((change) => this.onChange(change));
    this.ready = this.create();
  }

  private async create(): Promise<void> {
    // Reports document changes that the user made in this editor.
    const watcher = $prose(() => new Plugin({
      view: () => ({
        update: (view, prev) => {
          if (!this.applying && !view.state.doc.eq(prev.doc)) this.localChange(view.state.doc);
        }
      })
    }));

    // Pasting or dropping files uploads them and links them in.
    const uploads = $prose(() => new Plugin<DecorationSet>({
      key: uploadKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => {
          set = set.map(tr.mapping, tr.doc);
          const action = tr.getMeta(uploadKey) as UploadAction | undefined;
          if (action && 'add' in action) {
            const el = document.createElement('span');
            el.className = 'upload-placeholder';
            el.textContent = action.add.label;
            set = set.add(tr.doc, [Decoration.widget(action.add.pos, el, { id: action.add.id })]);
          } else if (action) {
            set = set.remove(set.find(undefined, undefined, (spec) => spec.id === action.remove));
          }
          return set;
        }
      },
      props: {
        decorations: (state) => uploadKey.getState(state),
        handlePaste: (view, e) => {
          const files = pastedFiles(e);
          if (!files.length || !this.editable) return false;
          this.insertFiles(files, view.state.selection.from);
          return true;
        },
        handleDrop: (view, e) => {
          const files = droppedFiles(e as DragEvent);
          if (!files.length || !this.editable) return false;
          const at = view.posAtCoords({ left: (e as DragEvent).clientX, top: (e as DragEvent).clientY });
          this.insertFiles(files, at ? at.pos : view.state.selection.from);
          return true;
        }
      }
    }));

    // Left out: writing empty paragraphs as "<br />" (it would put HTML into
    // notes), and heading ids, which change whenever a heading is edited and
    // would make documents differ when their Markdown doesn't.
    const skip = new Set<unknown>([...(remarkPreserveEmptyLinePlugin as unknown as unknown[]), syncHeadingIdPlugin]);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, this.root);
        ctx.set(defaultValueCtx, '');
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => this.editable }));
        ctx.set(headingIdGenerator.key, () => '');
        // "-" bullets are the more common style in plain Markdown files.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));
      })
      .use(commonmark.filter((plugin) => !skip.has(plugin)))
      .use(gfm)
      .use(history)
      .use(uploads)
      .use(clipboard)
      .use(watcher)
      .create();

    editor.action((ctx) => {
      this.view = ctx.get(editorViewCtx);
      this.parse = ctx.get(parserCtx) as unknown as (md: string) => PMNode;
      this.serialize = ctx.get(serializerCtx) as unknown as (doc: PMNode) => string;
    });
    this.serialized = this.serialize!(this.view!.state.doc);
    this.view!.dom.addEventListener('click', (e) => this.onClick(e), true);
    if (this.active) this.load();
  }

  show(): void {
    this.active = true;
    this.root.hidden = false;
    this.load();
  }

  hide(): void {
    this.active = false;
    this.root.hidden = true;
  }

  focus(): void {
    this.view?.focus();
  }

  setEditable(on: boolean): void {
    this.editable = on;
    this.view?.setProps({});
  }

  // Uploads files and links them in at `pos` (the cursor by default):
  // images show inline, other files become links.
  insertFiles(files: File[], pos?: number): void {
    const view = this.view;
    if (!view || !files.length) return;
    const id = Symbol('upload');
    const label = files.length === 1 ? `Uploading ${files[0].name || 'file'}…` : `Uploading ${files.length} files…`;
    const at = pos ?? view.state.selection.from;
    view.dispatch(view.state.tr.setMeta(uploadKey, { add: { id, pos: at, label } } satisfies UploadAction));
    void uploadAll(files, this.onError).then((done) => {
      const view = this.view!;
      const found = uploadKey.getState(view.state)?.find(undefined, undefined, (spec) => spec.id === id)[0];
      if (!found) {
        // The note was switched or reloaded while uploading.
        if (done.length) this.onError('The upload finished after you switched notes or views, so it was not linked. The file is in the attachments folder.');
        return;
      }
      const tr = view.state.tr.setMeta(uploadKey, { remove: id } satisfies UploadAction);
      if (done.length) {
        const { schema } = view.state;
        const nodes: PMNode[] = [];
        for (const u of done) {
          if (nodes.length) nodes.push(schema.text(' '));
          nodes.push(u.image
            ? schema.nodes.image.create({ src: u.url, alt: altText(u) })
            : schema.text(u.name, [schema.marks.link.create({ href: u.url })]));
        }
        // Keep the files apart from words right next to them.
        const $pos = view.state.doc.resolve(found.from);
        if ($pos.parent.isTextblock) {
          const off = $pos.parentOffset;
          const near = (from: number, to: number) => $pos.parent.textBetween(from, to, undefined, '\ufffc');
          if (off > 0 && /\S/.test(near(off - 1, off))) nodes.unshift(schema.text(' '));
          if (off < $pos.parent.content.size && /\S/.test(near(off, off + 1))) nodes.push(schema.text(' '));
        }
        tr.replaceWith(found.from, found.from, nodes);
      }
      view.dispatch(tr);
    });
  }

  // Replaces the whole document (and the undo history) with the model's text.
  private load(): void {
    const view = this.view;
    if (!view || !this.parse) return;
    const doc = this.parse(this.model.value);
    this.applying = true;
    view.updateState(EditorState.create({ schema: view.state.schema, doc, plugins: view.state.plugins }));
    this.applying = false;
    this.serialized = this.serialize!(view.state.doc);
  }

  // The user changed the document: send the matching text edit.
  private localChange(doc: PMNode): void {
    const next = this.serialize!(doc);
    const prev = this.serialized;
    this.serialized = next;
    // The editor may write some Markdown differently from how the file has
    // it ("-" for "*" bullets, say). Apply only what the user changed and
    // leave the rest of the file as it was.
    let text = rebaseEdit(this.model.value, prev, next);
    // Keeping the file's own style must not change what it means (a "*"
    // bullet next to a "-" list joins or splits lists, for instance). If the
    // result reads differently from the editor's document, use the editor's
    // Markdown as is.
    if (text !== next && this.normalize(text) !== this.normalize(next)) text = next;
    if (text === this.model.value) return;
    this.model.local(diffOp(this.model.value, text), 'wysiwyg', this);
  }

  // Markdown in the editor's own style, for comparing what two texts mean.
  private normalize(md: string): string {
    return this.serialize!(this.parse!(md));
  }

  // The text changed elsewhere (another person, the raw editor, a reload).
  private onChange(change: Change): void {
    if (!this.active || change.source === this || !this.view || !this.parse) return;
    if (change.origin === 'reset') {
      this.load();
      return;
    }
    const view = this.view;
    const next = this.parse(this.model.value);
    const current = view.state.doc;
    const start = current.content.findDiffStart(next.content);
    if (start === null || start === undefined) {
      this.serialized = this.serialize!(current);
      return;
    }
    let { a: endA, b: endB } = current.content.findDiffEnd(next.content)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) { endA += overlap; endB += overlap; }
    const tr = view.state.tr.replace(start, endA, next.slice(start, endB));
    // Other people's edits aren't ours to undo.
    tr.setMeta('addToHistory', change.origin !== 'remote' ? true : false);
    this.applying = true;
    view.dispatch(tr);
    this.applying = false;
    this.serialized = this.serialize!(view.state.doc);
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    // Links open with Ctrl/Cmd-click.
    const link = target.closest('a[href]') as HTMLAnchorElement | null;
    if (link && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.open(link.href, '_blank', 'noopener,noreferrer');
      return;
    }
    // Task list items: the checkbox is drawn just left of the item, so a
    // click there lands on the item itself.
    const item = target.closest('li[data-item-type="task"]') as HTMLElement | null;
    if (item && target === item && this.view) {
      if (e.clientX > item.getBoundingClientRect().left) return;
      e.preventDefault();
      const pos = this.view.posAtDOM(item, 0) - 1;
      const node = this.view.state.doc.nodeAt(pos);
      if (!node) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
    }
  }
}
