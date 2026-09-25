import { App, Notice, TFile, normalizePath } from 'obsidian';
import type { Collab } from './collab';
import { markerPath, parentPath } from './identity';
import { getText, observeEntries, type EntryChange } from './sync';

// Keeps a folder collab and the vault folder in agreement: every markdown
// file in the folder is a doc, entry paths are relative to the folder, and
// create, rename, move and delete travel both ways.
export class FolderSync {
  // Vault paths we are changing ourselves, so the vault event is not echoed.
  // The entries cannot tell an echo apart: another doc may hold the path by then.
  private busy = new Set<string>();
  private stops: (() => void)[] = [];

  constructor(
    private app: App,
    private collab: Collab,
    // Called when the folder or its marker disappears locally.
    private onGone: () => void,
  ) {}

  private get root(): string {
    return this.collab.folder ?? '';
  }

  private rel(path: string): string {
    return this.root ? path.slice(this.root.length + 1) : path;
  }

  private abs(entryPath: string): string {
    return normalizePath(this.root ? `${this.root}/${entryPath}` : entryPath);
  }

  private isMember(path: string): boolean {
    return path.endsWith('.md') && path !== markerPath(this.root) && this.collab.contains(path);
  }

  private async add(file: TFile) {
    try {
      await this.collab.seed(file, crypto.randomUUID(), this.rel(file.path));
    } catch (e) {
      this.failed(file.path, e);
    }
  }

  // A note that cannot be read or written is reported and skipped, so the
  // rest of the folder keeps syncing.
  private failed(path: string, error: unknown) {
    console.error('collab: could not sync', path, error);
    new Notice(`Collab: could not sync ${path}. ${String(error)}`, 10000);
  }

  // Bind every entry to its file, creating missing files, share local files
  // the collab does not know, then keep both sides in step. A new share has
  // no entries yet, so every markdown file becomes a doc.
  async start(): Promise<void> {
    for (const [id] of this.collab.entries()) await this.onEntry(id, 'add');
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isMember(file.path) && !this.collab.docs.has(file.path)) await this.add(file);
    }
    this.watch();
  }

  private watch(): void {
    this.stops.push(observeEntries(this.collab.ydoc, (id, change) => void this.onEntry(id, change)));
    const { vault } = this.app;
    const refs = [
      vault.on('create', (file) => {
        if (this.busy.has(file.path) || !(file instanceof TFile) || !this.isMember(file.path)) return;
        void this.add(file);
      }),
      vault.on('delete', (file) => {
        if (this.busy.delete(file.path)) return;
        if (file.path === this.root || file.path === markerPath(this.root)) return this.onGone();
        for (const doc of [...this.collab.docs.values()]) {
          if (doc.file.path === file.path || doc.file.path.startsWith(`${file.path}/`)) this.collab.removeDoc(doc.id);
        }
      }),
      // Runs after the plugin's own rename handler, so the doc is already
      // keyed by the new path.
      vault.on('rename', (file, oldPath) => {
        if (this.busy.delete(file.path) || !(file instanceof TFile)) return;
        const doc = this.collab.docs.get(file.path);
        if (this.isMember(file.path)) {
          if (doc) this.collab.setEntryPath(doc.id, this.rel(file.path));
          else void this.add(file);
        } else if (doc) {
          this.collab.removeDoc(doc.id);
        }
        if (oldPath === this.root || oldPath === markerPath(this.root)) this.onGone();
      }),
    ];
    this.stops.push(() => refs.forEach((ref) => vault.offref(ref)));
  }

  dispose(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  private async onEntry(id: string, change: EntryChange) {
    const entryPath = this.collab.entryPath(id);
    const path = this.collab.docById(id)?.file.path ?? (entryPath === undefined ? 'a note' : this.abs(entryPath));
    try {
      await this.applyEntry(id, change);
    } catch (e) {
      this.failed(path, e);
    }
  }

  private async applyEntry(id: string, change: EntryChange) {
    const doc = this.collab.docById(id);
    if (change === 'delete') {
      if (!doc) return;
      this.collab.unshare(doc.file.path);
      this.busy.add(doc.file.path);
      await this.app.fileManager.trashFile(doc.file);
      return;
    }
    const entryPath = this.collab.entryPath(id);
    if (entryPath === undefined) return;
    const path = this.abs(entryPath);
    if (!doc) {
      const file = this.app.vault.getFileByPath(path);
      if (file) await this.collab.attach(file, id);
      else await this.create(id, path);
    } else if (doc.file.path !== path) {
      // A plain rename: the peer that renamed already rewrote its links,
      // and those edits arrive as text.
      this.busy.add(path);
      await this.ensureFolder(path);
      await this.app.vault.rename(doc.file, path);
    }
  }

  private async create(id: string, path: string) {
    await this.ensureFolder(path);
    this.busy.add(path);
    const file = await this.app.vault.create(path, getText(this.collab.ydoc, id)?.toString() ?? '');
    this.busy.delete(path);
    await this.collab.attach(file, id);
  }

  private async ensureFolder(path: string) {
    const parent = parentPath(path);
    if (!parent || this.app.vault.getFolderByPath(parent)) return;
    await this.app.vault.createFolder(parent);
  }
}
