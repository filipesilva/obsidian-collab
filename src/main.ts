import { Menu, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { Collab } from './collab';
import { collabExtension } from './editor';
import { FolderSync } from './folder';
import { readInvite, readUrl, removeUrl, writeUrl } from './frontmatter';
import { MARKER, markerPath } from './identity';
import { Invite, inviteUrl, parseInvite, parseInviteUrl, randomId } from './invite';
import { AskUrl, Confirm, ConfirmJoin, createNote } from './join';
import { type Status, pickRelays } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS, iceServers } from './settings';
import type { StateStore } from './state';
import { vaultStore } from './vault-store';

const MARKER_BODY = `This folder is shared with the Collab plugin. Every markdown file in it syncs
with everyone who joined the URL above. This file itself is not synced.
`;

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  // Connected collabs by id.
  collabs = new Map<string, Collab>();
  private folders = new Map<string, FolderSync>();
  store!: StateStore;
  private statusBar!: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.store = vaultStore(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
    this.statusBar = this.addStatusBarItem();
    this.registerDomEvent(this.statusBar, 'click', (event) => this.showConnected(event));
    this.updateStatus();
    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.registerEditorExtension(collabExtension);
    this.registerObsidianProtocolHandler('collab', (params) => {
      const invite = parseInvite(params);
      if (invite) void this.join(invite, false);
      else new Notice('Collab: invalid URL');
    });

    const activeFile = () => this.app.workspace.getActiveFile();
    // A note shared on its own. A folder's marker is not one.
    const fileInvite = (file: TFile) => {
      const invite = file.name === MARKER ? null : readInvite(this.app, file);
      return invite && invite.folder === undefined ? invite : null;
    };
    // The shared folder the active file is in, or the folder it could share.
    const sharedFolder = () => {
      const file = activeFile();
      return file && this.sharedFolderOf(file.path);
    };
    const plainFolder = () => {
      const file = activeFile();
      const folder = file?.parent;
      return folder && !this.sharedFolderOf(file.path) && !this.containsShared(folder) ? folder : null;
    };

    this.addCommand({
      id: 'share-file',
      name: 'Share file',
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file || file.name === MARKER || readUrl(this.app, file) || this.collabOf(file.path)) return false;
        if (!checking) void this.shareFile(file);
        return true;
      },
    });
    this.addCommand({
      id: 'share-folder',
      name: 'Share folder',
      checkCallback: (checking) => {
        const folder = plainFolder();
        if (!folder) return false;
        if (!checking) void this.shareFolder(folder);
        return true;
      },
    });
    this.addCommand({
      id: 'join-url',
      name: 'Join URL',
      callback: () => void this.joinUrl(),
    });
    this.addCommand({
      id: 'connect-file',
      name: 'Connect file',
      checkCallback: (checking) => {
        const file = activeFile();
        const invite = file && fileInvite(file);
        if (!file || !invite || this.collabOf(file.path)) return false;
        if (!checking) void this.connectFile(file, invite);
        return true;
      },
    });
    this.addCommand({
      id: 'connect-folder',
      name: 'Connect folder',
      checkCallback: (checking) => {
        const folder = sharedFolder();
        if (!folder || this.collabOf(folder.path)) return false;
        if (!checking) void this.connectFolder(folder);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-file-url',
      name: 'Copy file URL',
      checkCallback: (checking) => {
        const file = activeFile();
        const invite = file && fileInvite(file);
        if (!file || !invite) return false;
        if (!checking) void this.copy(inviteUrl(invite), file.basename);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-folder-url',
      name: 'Copy folder URL',
      checkCallback: (checking) => {
        const folder = sharedFolder();
        const url = folder && this.folderUrl(folder);
        if (!url) return false;
        if (!checking) void this.copy(url, folder.name || 'the vault');
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect-file',
      name: 'Disconnect file',
      checkCallback: (checking) => {
        const file = activeFile();
        const collab = file && this.collabOf(file.path);
        if (!collab || collab.folder !== null) return false;
        if (!checking) void this.disconnect(collab);
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect-folder',
      name: 'Disconnect folder',
      checkCallback: (checking) => {
        const folder = sharedFolder();
        const collab = folder && this.collabOf(folder.path);
        if (!collab) return false;
        if (!checking) void this.disconnect(collab);
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect-all',
      name: 'Disconnect all',
      checkCallback: (checking) => {
        if (!this.collabs.size) return false;
        if (!checking) void this.disconnectAll();
        return true;
      },
    });
    this.addCommand({
      id: 'stop-sharing-file',
      name: 'Stop sharing file',
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file || !fileInvite(file)) return false;
        if (!checking) void this.stopSharingFile(file);
        return true;
      },
    });
    this.addCommand({
      id: 'stop-sharing-folder',
      name: 'Stop sharing folder',
      checkCallback: (checking) => {
        const folder = sharedFolder();
        if (!folder) return false;
        if (!checking) void this.stopSharingFolder(folder);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) this.folderMenu(menu, file);
      }),
    );
    this.registerEvent(this.app.workspace.on('layout-change', () => this.rebindAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.rebindAll()));
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        for (const collab of this.collabs.values()) void collab.docs.get(file.path)?.onModify();
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) for (const collab of this.collabs.values()) collab.rename(oldPath, file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const collab = this.collabOf(file.path);
        if (collab?.folder === null) void this.disconnect(collab);
      }),
    );
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      for (const collab of this.collabs.values()) collab.provider?.checkRelays();
    });
  }

  onunload() {
    for (const collab of this.collabs.values()) void this.teardown(collab);
    this.collabs.clear();
  }

  collabOf(path: string): Collab | undefined {
    for (const collab of this.collabs.values()) if (collab.contains(path)) return collab;
    return undefined;
  }

  // The nearest folder with a marker, walking up from a path.
  sharedFolderOf(path: string): TFolder | null {
    let folder = this.app.vault.getAbstractFileByPath(path)?.parent ?? null;
    if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) folder = this.app.vault.getFolderByPath(path);
    for (; folder; folder = folder.parent) if (this.markerOf(folder)) return folder;
    return null;
  }

  private containsShared(folder: TFolder): boolean {
    const prefix = folder.isRoot() ? '' : `${folder.path}/`;
    return this.app.vault.getMarkdownFiles().some((file) => file.name === MARKER && file.path.startsWith(prefix));
  }

  private markerOf(folder: TFolder): TFile | null {
    return this.app.vault.getFileByPath(markerPath(folder.isRoot() ? '' : folder.path));
  }

  private folderUrl(folder: TFolder): string | undefined {
    const marker = this.markerOf(folder);
    return marker ? readUrl(this.app, marker) : undefined;
  }

  private folderMenu(menu: Menu, folder: TFolder) {
    const collab = this.collabOf(folder.isRoot() ? '' : folder.path);
    const marker = this.markerOf(folder);
    if (marker) {
      if (collab && collab.folder !== null) {
        menu.addItem((item) => item.setTitle('Disconnect folder').setIcon('unplug').onClick(() => void this.disconnect(collab)));
      } else {
        menu.addItem((item) => item.setTitle('Connect folder').setIcon('plug').onClick(() => void this.connectFolder(folder)));
      }
      menu.addItem((item) =>
        item.setTitle('Copy folder URL').setIcon('link').onClick(() => void this.copy(this.folderUrl(folder) ?? '', folder.name)),
      );
      menu.addItem((item) => item.setTitle('Stop sharing folder').setIcon('x').onClick(() => void this.stopSharingFolder(folder)));
    } else if (!this.sharedFolderOf(folder.path) && !this.containsShared(folder)) {
      menu.addItem((item) => item.setTitle('Share folder').setIcon('users').onClick(() => void this.shareFolder(folder)));
    }
  }

  private rebindAll() {
    for (const collab of this.collabs.values()) collab.rebindAll();
  }

  // Bottom bar: how many collabs are connected, click for the list.
  private updateStatus() {
    this.statusBar.setText(`${this.collabs.size} connected`);
    this.statusBar.toggleClass('mod-clickable', this.collabs.size > 0);
  }

  private showConnected(event: MouseEvent) {
    if (!this.collabs.size) return;
    const menu = new Menu();
    for (const collab of this.collabs.values()) {
      const name = collab.folder === null ? collab.path.replace(/\.md$/, '') : collab.path || 'the vault';
      const peers = collab.peers;
      menu.addItem((item) =>
        item
          .setTitle(`Disconnect ${name} (${peers} ${peers === 1 ? 'peer' : 'peers'})`)
          .setIcon('unplug')
          .onClick(() => void this.disconnect(collab)),
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Disconnect all').setIcon('unplug').onClick(() => void this.disconnectAll()));
    menu.showAtMouseEvent(event);
  }

  private newInvite(): Invite | null {
    const relays = pickRelays(this.settings.relays);
    if (!relays.length) {
      new Notice('Collab: add a signalling server in settings first');
      return null;
    }
    return { relays, id: randomId(), secret: randomId(16) };
  }

  // Sharing is the only way a doc gets created.
  async shareFile(file: TFile) {
    const invite = this.newInvite();
    if (!invite) return;
    invite.file = file.basename;
    await writeUrl(this.app, file, inviteUrl(invite));
    const collab = await this.open(invite, file.path);
    await collab.seed(file, collab.id);
    collab.connect();
    await this.copy(collab.url, file.basename);
  }

  async shareFolder(folder: TFolder) {
    const invite = this.newInvite();
    if (!invite) return;
    const path = folder.isRoot() ? '' : folder.path;
    invite.folder = path;
    if (folder.isRoot()) {
      const ok = await new Confirm(
        this.app,
        'Share the whole vault?',
        'Every Markdown file in this vault will sync with everyone who joins, and no other folder in it can be shared on its own.',
        'Share vault',
      ).ask();
      if (!ok) return;
    }
    await this.writeMarker(path, inviteUrl(invite));
    const collab = await this.open(invite, path);
    const sync = this.folderSync(collab);
    await sync.seed();
    sync.watch();
    collab.connect();
    await this.copy(collab.url, folder.name || 'the vault');
  }

  async joinUrl() {
    const url = await new AskUrl(this.app).ask();
    if (url === undefined) return;
    const invite = parseInviteUrl(url);
    if (invite) await this.join(invite, true);
    else new Notice('Collab: that is not a collab URL');
  }

  // First time in from someone else's URL: creates the file or folder with
  // the property, then connects.
  async join(invite: Invite, confirmed: boolean) {
    if (this.collabs.has(invite.id)) {
      new Notice('Collab: already connected');
      return;
    }
    if (!confirmed && !(await new ConfirmJoin(this.app, invite).ask())) return;
    if (invite.folder === undefined) {
      const file = await createNote(this.app, invite.file ?? '');
      await writeUrl(this.app, file, inviteUrl(invite));
      await this.app.workspace.getLeaf(false).openFile(file);
      await this.connectFile(file, invite, true);
      return;
    }
    const path = invite.folder;
    const existing = path ? this.app.vault.getFolderByPath(path) : this.app.vault.getRoot();
    if (existing) {
      const marker = this.markerOf(existing);
      const there = marker && readInvite(this.app, marker);
      if (there?.id !== invite.id) {
        new Notice(`Collab: "${path || '/'}" already exists. Move it away first, the shared folder must use that path.`, 10000);
        return;
      }
      await this.connectFolder(existing);
      return;
    }
    await this.app.vault.createFolder(path);
    await this.writeMarker(path, inviteUrl(invite));
    await this.connectFolder(this.app.vault.getFolderByPath(path)!, invite, true);
  }

  // The file has the property. With saved state, bind at once and let the
  // CRDT merge. Without it, wait for a peer who has the doc.
  async connectFile(file: TFile, invite: Invite, fresh = false) {
    if (this.collabs.has(invite.id)) {
      new Notice('Collab: already connected');
      return;
    }
    const collab = await this.open(invite, file.path);
    if (collab.hasState) {
      await collab.attach(file, collab.id);
      collab.connect();
      new Notice(`Collab: connected, editing ${file.basename}`);
      return;
    }
    if (!fresh) this.noHistory(file.basename);
    await this.waiting(collab, async () => {
      if (!(await collab.waitFor(collab.id))) return false;
      const doc = await collab.attach(file, collab.id);
      await doc.ready;
      return true;
    });
    if (this.collabs.has(collab.id)) new Notice(`Collab: connected, editing ${file.basename}`);
  }

  // The invite is passed when the marker was just written, since the
  // metadata cache lags behind.
  async connectFolder(folder: TFolder, invite?: Invite | null, fresh = false) {
    const marker = this.markerOf(folder);
    invite ??= marker && readInvite(this.app, marker);
    if (!invite || invite.folder === undefined) {
      new Notice(`Collab: ${MARKER} in "${folder.path}" has no valid URL`);
      return;
    }
    if (this.collabs.has(invite.id)) {
      new Notice('Collab: already connected');
      return;
    }
    const collab = await this.open(invite, invite.folder);
    const sync = this.folderSync(collab);
    if (collab.hasState) {
      await sync.reconcile();
      sync.watch();
      collab.connect();
      new Notice(`Collab: connected, ${folder.name || 'the vault'} is syncing`);
      return;
    }
    if (!fresh) this.noHistory(folder.name || 'the vault');
    await this.waiting(collab, async () => {
      if (!(await collab.waitSynced())) return false;
      await sync.reconcile();
      sync.watch();
      return true;
    });
    if (this.collabs.has(collab.id)) new Notice(`Collab: connected, ${folder.name || 'the vault'} is syncing`);
  }

  // State is a cache. Without it, local edits made meanwhile cannot merge.
  private noHistory(name: string) {
    new Notice(
      `Collab: no local history for ${name}. A peer has to be online to send it, and it will replace what is here. Obsidian's file recovery keeps the current version.`,
      15000,
    );
  }

  // Connects with a progress notice that stays until the first sync, or
  // until the collab is disconnected, which is how a wait is cancelled.
  private async waiting(collab: Collab, then: () => Promise<boolean>) {
    const notice = new Notice(progress(collab), 0);
    try {
      collab.connect(() => notice.setMessage(progress(collab)));
      if (await then()) return;
      if (this.collabs.has(collab.id)) await this.disconnect(collab);
    } finally {
      notice.hide();
    }
  }

  private folderSync(collab: Collab): FolderSync {
    const sync = new FolderSync(this.app, collab, collab.folder ?? '', () => void this.disconnect(collab));
    this.folders.set(collab.id, sync);
    return sync;
  }

  private async open(invite: Invite, path: string): Promise<Collab> {
    const collab = new Collab(this.app, invite, path, iceServers(this.settings), this.store);
    collab.onPeers = () => this.updateStatus();
    this.collabs.set(collab.id, collab);
    this.updateStatus();
    await collab.load();
    return collab;
  }

  private async writeMarker(folder: string, url: string) {
    const path = markerPath(folder);
    const marker = this.app.vault.getFileByPath(path) ?? (await this.app.vault.create(path, MARKER_BODY));
    await writeUrl(this.app, marker, url);
  }

  async disconnect(collab: Collab) {
    if (!this.collabs.delete(collab.id)) return;
    this.updateStatus();
    await this.teardown(collab);
    new Notice('Collab: disconnected');
  }

  private async teardown(collab: Collab) {
    this.folders.get(collab.id)?.dispose();
    this.folders.delete(collab.id);
    await collab.disconnect();
  }

  async disconnectAll() {
    for (const collab of [...this.collabs.values()]) await this.disconnect(collab);
  }

  async stopSharingFile(file: TFile) {
    const invite = readInvite(this.app, file);
    const collab = this.collabOf(file.path);
    if (collab) await this.disconnect(collab);
    await removeUrl(this.app, file);
    if (invite) await this.store.remove(invite.id);
    new Notice(`Collab: ${file.basename} is no longer shared`);
  }

  async stopSharingFolder(folder: TFolder) {
    const marker = this.markerOf(folder);
    if (!marker) return;
    const invite = readInvite(this.app, marker);
    const collab = this.collabOf(folder.isRoot() ? '' : folder.path);
    if (collab) await this.disconnect(collab);
    await this.app.fileManager.trashFile(marker);
    if (invite) await this.store.remove(invite.id);
    new Notice(`Collab: ${folder.name || 'the vault'} is no longer shared`);
  }

  async copy(url: string, name: string) {
    await navigator.clipboard.writeText(url);
    new Notice(`Collab: URL for ${name} copied`);
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CollabSettings>) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function progress(collab: Collab): string {
  const status: Status = collab.status();
  if (collab.peers) return `Collab: connected to ${collab.peers} ${collab.peers === 1 ? 'peer' : 'peers'}, nothing shared has arrived yet. Waiting…`;
  if (status.iceFailed) return 'Collab: found a peer but the connection failed, a TURN server in settings may help. Still trying…';
  if (status.peerFound) return 'Collab: peer found, connecting…';
  if (status.relays) return `Collab: waiting for someone through ${status.relays} ${status.relays === 1 ? 'relay' : 'relays'}…`;
  return 'Collab: connecting to signalling servers…';
}
