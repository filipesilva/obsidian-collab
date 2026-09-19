import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { Collab } from './collab';
import { MARKER, markerPath } from './identity';
import { getText, observeEntries } from './sync';

// Keeps a folder collab and the vault folder in agreement: every markdown
// file in the folder is a doc, entry paths are relative to the folder, and
// create, rename, move and delete travel both ways.
export class FolderSync {
  // Vault paths we are changing ourselves, so the vault event is not echoed.
  private busy = new Set<string>();
  private stops: (() => void)[] = [];

  constructor(
    private app: App,
    private collab: Collab,
    readonly root: string,
    // Called when the folder or its marker disappears locally.
    private onGone: () => void,
  ) {}

  private rel(path: string): string {
    return this.root ? path.slice(this.root.length + 1) : path;
  }

  private abs(entryPath: string): string {
    return normalizePath(this.root ? `${this.root}/${entryPath}` : entryPath);
  }

  private isMember(path: string): boolean {
    return path.endsWith('.md') && path !== markerPath(this.root) && this.collab.contains(path);
  }

  files(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isMember(file.path));
  }

  // Sharing: every markdown file becomes a doc.
  async seed(): Promise<void> {
    for (const file of this.files()) await this.collab.seed(file, crypto.randomUUID(), this.rel(file.path));
  }

  // Connecting: bind every entry to its file, creating missing files, and
  // share local files the collab does not know.
  async reconcile(): Promise<void> {
    for (const [id, entry] of this.collab.entries()) {
      const path = this.abs(String(entry.get('path')));
      const file = this.app.vault.getFileByPath(path);
      if (file) await this.collab.attach(file, id);
      else await this.create(id, path, getText(this.collab.ydoc, id)?.toString() ?? '');
    }
    for (const file of this.files()) {
      if (!this.collab.docs.has(file.path)) await this.collab.seed(file, crypto.randomUUID(), this.rel(file.path));
    }
  }

  watch(): void {
    this.stops.push(observeEntries(this.collab.ydoc, (id, change) => void this.onEntry(id, change)));
    const { vault } = this.app;
    const refs = [
      vault.on('create', (file) => {
        if (this.busy.has(file.path) || !(file instanceof TFile) || !this.isMember(file.path)) return;
        void this.collab.seed(file, crypto.randomUUID(), this.rel(file.path));
      }),
      vault.on('delete', (file) => {
        if (this.busy.delete(file.path)) return;
        if (file.path === this.root || file.path === markerPath(this.root)) return this.onGone();
        const doc = this.collab.docs.get(file.path);
        if (doc) this.collab.removeDoc(doc.id);
        if (file instanceof TFolder) {
          for (const doc of [...this.collab.docs.values()]) {
            if (doc.file.path.startsWith(`${file.path}/`)) this.collab.removeDoc(doc.id);
          }
        }
      }),
      // Runs after the plugin's own rename handler, so the doc is already
      // keyed by the new path.
      vault.on('rename', (file, oldPath) => {
        if (this.busy.delete(file.path) || !(file instanceof TFile)) return;
        const doc = this.collab.docs.get(file.path);
        if (this.isMember(file.path)) {
          if (doc) this.collab.setEntryPath(doc.id, this.rel(file.path));
          else void this.collab.seed(file, crypto.randomUUID(), this.rel(file.path));
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

  private async onEntry(id: string, change: 'add' | 'delete' | 'update') {
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
      else await this.create(id, path, getText(this.collab.ydoc, id)?.toString() ?? '');
    } else if (doc.file.path !== path) {
      // A plain rename: the peer that renamed already rewrote its links,
      // and those edits arrive as text.
      this.busy.add(path);
      await this.ensureFolder(path);
      await this.app.vault.rename(doc.file, path);
    }
  }

  private async create(id: string, path: string, content: string) {
    await this.ensureFolder(path);
    this.busy.add(path);
    const file = await this.app.vault.create(path, content);
    this.busy.delete(path);
    await this.collab.attach(file, id);
  }

  private async ensureFolder(path: string) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!parent || this.app.vault.getFolderByPath(parent)) return;
    await this.app.vault.createFolder(parent);
  }
}

export function isMarker(file: TFile): boolean {
  return file.name === MARKER;
}
