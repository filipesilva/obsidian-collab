import { Notice, Plugin, TFile } from 'obsidian';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import { collabExtension } from './editor';
import { createProvider } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS } from './settings';
import { SharedDoc } from './shared-doc';
import { getText, observeDocs, openDoc } from './sync';

interface Session {
  ydoc: Y.Doc;
  docs: Map<string, SharedDoc>;
  provider: WebrtcProvider | null;
  synced: Promise<void>;
}

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  session: Session | null = null;
  hello: { doc: Y.Doc; provider: WebrtcProvider } | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.registerEditorExtension(collabExtension);

    this.addCommand({
      id: 'share-note',
      name: 'Share current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.session?.docs.has(file.path)) return false;
        if (!checking) void this.shareNote(file);
        return true;
      },
    });
    this.addCommand({
      id: 'unshare-note',
      name: 'Stop sharing current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.session?.docs.has(file.path)) return false;
        if (!checking) this.unshareNote(file.path);
        return true;
      },
    });
    this.addCommand({
      id: 'hello',
      name: 'Hello: toggle network test',
      callback: () => (this.hello ? this.stopHello() : this.startHello()),
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.rebindAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.rebindAll()));
    this.registerEvent(
      this.app.vault.on('modify', (file) => void this.session?.docs.get(file.path)?.onModify()),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const doc = this.session?.docs.get(oldPath);
        if (!doc || !this.session) return;
        this.session.docs.delete(oldPath);
        this.session.docs.set(file.path, doc);
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.unshareNote(file.path)));
  }

  onunload() {
    this.stopHello();
    for (const path of [...(this.session?.docs.keys() ?? [])]) this.unshareNote(path);
  }

  // Dev session: one fixed room, doc id is the note path.
  startSession(): Session {
    const ydoc = new Y.Doc();
    const provider = this.settings.server
      ? createProvider(ydoc, { server: this.settings.server, room: 'dev', secret: 'dev' })
      : null;
    provider?.on('peers', ({ webrtcPeers }) => {
      new Notice(`Collab: ${webrtcPeers.length} peers`);
    });
    // First sync with a peer, or a timeout when nobody is there.
    const synced = new Promise<void>((resolve) => {
      provider?.once('synced', () => resolve());
      window.setTimeout(resolve, provider ? 5000 : 0);
    });
    const session: Session = { ydoc, docs: new Map(), provider, synced };
    // A concurrent seed on another peer may replace our entry. Adopt the winner.
    observeDocs(ydoc, (path) => {
      const doc = session.docs.get(path);
      const ytext = getText(ydoc, path);
      if (doc && ytext && ytext !== doc.ytext) {
        doc.destroy();
        session.docs.set(path, new SharedDoc(this.app, doc.file, ytext, true));
      }
    });
    return session;
  }

  endSession() {
    if (!this.session) return;
    this.session.provider?.destroy();
    this.session.ydoc.destroy();
    this.session = null;
  }

  // Without local history, wait for the first sync and adopt the shared text
  // if the doc exists. Only seed when nobody has it.
  async shareNote(file: TFile) {
    this.session ??= this.startSession();
    const { ydoc } = this.session;
    await this.session.synced;
    const existing = getText(ydoc, file.path);
    const doc = existing
      ? new SharedDoc(this.app, file, existing, true)
      : new SharedDoc(
          this.app,
          file,
          openDoc(ydoc, { id: file.path, path: file.path, content: await this.app.vault.read(file) }),
        );
    this.session.docs.set(file.path, doc);
    new Notice(`Collab: sharing ${file.basename}`);
  }

  unshareNote(path: string) {
    const doc = this.session?.docs.get(path);
    if (!doc) return;
    doc.destroy();
    this.session?.docs.delete(path);
    if (this.session?.docs.size === 0) this.endSession();
    new Notice(`Collab: stopped sharing ${doc.file.basename}`);
  }

  rebindAll() {
    for (const doc of this.session?.docs.values() ?? []) doc.rebind();
  }

  startHello() {
    if (!this.settings.server) {
      new Notice('Collab: set a server URL in settings first');
      return;
    }
    const doc = new Y.Doc();
    const provider = createProvider(doc, {
      server: this.settings.server,
      room: 'hello',
      secret: 'hello',
    });
    provider.on('status', ({ connected }) => {
      new Notice(`Collab hello: signaling ${connected ? 'connected' : 'disconnected'}`);
    });
    provider.on('peers', ({ webrtcPeers, bcPeers }) => {
      new Notice(`Collab hello: ${webrtcPeers.length} webrtc peers, ${bcPeers.length} local peers`);
    });
    this.hello = { doc, provider };
    new Notice(`Collab hello: started on ${this.settings.server}`);
  }

  stopHello() {
    if (!this.hello) return;
    this.hello.provider.destroy();
    this.hello.doc.destroy();
    this.hello = null;
    new Notice('Collab hello: stopped');
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CollabSettings>) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
