import { App, MarkdownView, TFile, debounce } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { bind, isBound, unbind } from './editor';
import { applyContent } from './sync';

// The source-mode editors of every open note, by file.
export function sourceViews(app: App): Map<TFile, EditorView[]> {
  const open = new Map<TFile, EditorView[]>();
  for (const { view } of app.workspace.getLeavesOfType('markdown')) {
    if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== 'source') continue;
    const views = open.get(view.file) ?? [];
    views.push((view.editor as unknown as { cm: EditorView }).cm);
    open.set(view.file, views);
  }
  return open;
}

// Keeps one note, its open editor and a shared text in agreement.
// While a source-mode editor shows the file, it is the source of truth:
// y-codemirror moves edits both ways and Obsidian saves to disk. Without one,
// the text is written to disk and disk changes are diffed into the text.
// Reading mode does not count: Obsidian ignores editor changes there.
export class SharedDoc {
  private view: EditorView | null = null;
  private written = new Set<string>();
  private adopting = false;
  // Resolves once the note holds the shared text. Open the note after this.
  readonly ready: Promise<void>;

  private write = () => {
    const content = this.ytext.toString();
    this.written.add(content);
    return this.app.vault.modify(this.file, content);
  };

  private writeDisk = debounce(() => void this.write(), 200, true);

  private onText = () => {
    if (!this.view) this.writeDisk();
    else queueMicrotask(() => this.verify());
  };

  // A bound editor must mirror the text exactly, or every later remote
  // change lands in the wrong place. If they ever drift, say so and make
  // the editor follow the text, which is what the peers have.
  private verify() {
    const view = this.view;
    if (!view || view.state.doc.length === this.ytext.length) return;
    console.error('collab: editor drifted from the shared text', this.file.path, view.state.doc.length, this.ytext.length);
    unbind(view);
    bind(view, this.ytext, 'text', this.awareness);
  }

  // With adopt, the shared text replaces the note: joining a live doc.
  // Otherwise the note has already been diffed into the text.
  constructor(
    private app: App,
    public file: TFile,
    readonly id: string,
    readonly ytext: Y.Text,
    private awareness: Awareness,
    adopt = false,
  ) {
    ytext.observe(this.onText);
    this.ready = adopt ? this.adopt() : Promise.resolve();
    if (!adopt) this.rebind();
  }

  private async adopt(): Promise<void> {
    this.adopting = true;
    this.rebind();
    if (!this.view && (await this.app.vault.read(this.file)) !== this.ytext.toString()) await this.write();
    this.adopting = false;
  }

  rebind(open = sourceViews(this.app)): void {
    const views = open.get(this.file) ?? [];
    if (this.view && views.includes(this.view) && isBound(this.view, this.ytext)) return;
    if (this.view) unbind(this.view);
    this.view = views[0] ?? null;
    if (this.view) bind(this.view, this.ytext, this.adopting ? 'text' : 'editor', this.awareness);
  }

  async onModify(): Promise<void> {
    if (this.view) return;
    const content = await this.app.vault.read(this.file);
    if (this.written.delete(content)) return;
    applyContent(this.ytext, content);
  }

  destroy(): void {
    this.writeDisk.cancel();
    this.ytext.unobserve(this.onText);
    if (this.view) unbind(this.view);
    this.view = null;
  }
}
