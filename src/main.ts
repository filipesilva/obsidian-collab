import { Menu, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { Collab, type Peer } from './collab';
import { gatherDiagnostics, natCheck } from './diagnostics';
import { collabExtension } from './editor';
import { FolderSync } from './folder';
import { readInvite, readUrl, removeUrl, writeUrl } from './frontmatter';
import { MARKER, markerPath, parentPath } from './identity';
import { Invite, inviteUrl, parseInvite, parseInviteUrl, randomId } from './invite';
import { AskUrl, Confirm, ShowText, confirmJoin, confirmRegenerate, createNote } from './join';
import { checkTurn, describeNat, preferredLiveRelays } from './nat';
import { RELAY_COUNT, closeRelays, type Status } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS, rtcConfig, turnServer } from './settings';
import type { StateStore } from './state';
import { commands, markerBody, modals, names, notices, status } from './text';
import { vaultStore } from './vault-store';

// What the plugin holds for a connected collab, released in teardown.
interface Session {
  sync?: FolderSync;
  // Refreshes the notice of the connect stage in progress.
  update?: () => void;
  // The last status, to tell a new attempt or failure from an old one.
  seen: Status;
  peerNotice?: Notice;
  failureTimer?: number;
}

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  // Connected collabs by id.
  collabs = new Map<string, Collab>();
  private sessions = new Map<Collab, Session>();
  store!: StateStore;
  private statusBar!: HTMLElement;
  private natCheckedAt = 0;

  async onload() {
    await this.loadSettings();
    this.store = vaultStore(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
    this.statusBar = this.addStatusBarItem();
    this.registerDomEvent(this.statusBar, 'click', (event) => void this.showConnected(event));
    this.updateStatus();
    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.registerEditorExtension(collabExtension);
    this.registerObsidianProtocolHandler('collab', (params) => {
      const invite = parseInvite(params);
      if (invite) void this.join(invite, false);
      else new Notice(notices.invalidUrl);
    });

    const activeFile = () => this.app.workspace.getActiveFile();
    // A note shared on its own. A folder's marker is not one.
    const fileInvite = (file: TFile) => {
      const invite = file.name === MARKER ? null : readInvite(this.app, file);
      return invite && invite.folder === undefined ? invite : null;
    };
    // The shared folder the active file is in, or the folder it could share.
    const sharedFolder = () => this.sharedFolderOf(activeFile()?.parent ?? null);
    const plainFolder = () => {
      const folder = activeFile()?.parent;
      return folder && this.canShare(folder) ? folder : null;
    };

    this.addCommand({
      id: 'share-file',
      name: commands.shareFile,
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file || !this.canShare(file)) return false;
        if (!checking) void this.shareFile(file);
        return true;
      },
    });
    this.addCommand({
      id: 'share-folder',
      name: commands.shareFolder,
      checkCallback: (checking) => {
        const folder = plainFolder();
        if (!folder) return false;
        if (!checking) void this.shareFolder(folder);
        return true;
      },
    });
    this.addCommand({
      id: 'open-url',
      name: commands.openUrl,
      callback: () => void this.joinUrl(),
    });
    this.addCommand({
      id: 'connect-file',
      name: commands.connectFile,
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
      name: commands.connectFolder,
      checkCallback: (checking) => {
        const folder = sharedFolder();
        if (!folder || this.collabOf(folderPath(folder))) return false;
        if (!checking) void this.connectFolder(folder);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-file-url',
      name: commands.copyFileUrl,
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
      name: commands.copyFolderUrl,
      checkCallback: (checking) => {
        const folder = sharedFolder();
        const url = folder && this.folderUrl(folder);
        if (!url) return false;
        if (!checking) void this.copy(url, folderName(folder));
        return true;
      },
    });
    this.addCommand({
      id: 'regenerate-file-url',
      name: commands.regenerateFileUrl,
      checkCallback: (checking) => {
        const file = activeFile();
        const invite = file && fileInvite(file);
        if (!file || !invite) return false;
        if (!checking) void this.regenerateFile(file, invite);
        return true;
      },
    });
    this.addCommand({
      id: 'regenerate-folder-url',
      name: commands.regenerateFolderUrl,
      checkCallback: (checking) => {
        const folder = sharedFolder();
        const invite = folder && this.folderInvite(folder);
        if (!folder || !invite) return false;
        if (!checking) void this.regenerateFolder(folder, invite);
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect-file',
      name: commands.disconnectFile,
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
      name: commands.disconnectFolder,
      checkCallback: (checking) => {
        const folder = sharedFolder();
        const collab = folder && this.collabOf(folderPath(folder));
        if (!collab) return false;
        if (!checking) void this.disconnect(collab);
        return true;
      },
    });
    this.addCommand({
      id: 'disconnect-all',
      name: commands.disconnectAll,
      checkCallback: (checking) => {
        if (!this.collabs.size) return false;
        if (!checking) void this.disconnectAll();
        return true;
      },
    });
    this.addCommand({
      id: 'show-connected',
      name: commands.showConnected,
      callback: () => void this.connectedSummary().then((text) => new Notice(text, 8000)),
    });
    this.addCommand({
      id: 'diagnostics',
      name: commands.diagnostics,
      callback: () => void this.showDiagnostics(),
    });
    this.addCommand({
      id: 'check-network',
      name: commands.checkNetwork,
      callback: () => void this.checkNetwork(),
    });
    this.addCommand({
      id: 'stop-sharing-file',
      name: commands.stopSharingFile,
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file || !fileInvite(file)) return false;
        if (!checking) void this.stopSharingFile(file);
        return true;
      },
    });
    this.addCommand({
      id: 'stop-sharing-folder',
      name: commands.stopSharingFolder,
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
    const teardowns = [...this.collabs.values()].map((collab) => this.teardown(collab));
    this.collabs.clear();
    void Promise.all(teardowns).then(closeRelays);
  }

  collabOf(path: string): Collab | undefined {
    for (const collab of this.collabs.values()) if (collab.contains(path)) return collab;
    return undefined;
  }

  // The nearest folder with a marker, walking up from a folder.
  sharedFolderOf(folder: TFolder | null): TFolder | null {
    for (; folder; folder = folder.parent) if (this.markerOf(folder)) return folder;
    return null;
  }

  // A note belongs to one collab at most. collabOf covers a file just shared,
  // whose property the metadata cache does not show yet.
  private canShare(target: TFile | TFolder): boolean {
    if (target instanceof TFolder) return !this.sharedFolderOf(target) && !this.containsShared(target);
    return target.name !== MARKER && !readUrl(this.app, target) && !this.collabOf(target.path) && !this.sharedFolderOf(target.parent);
  }

  // The nearest shared folder above a path, found by path so the path need
  // not exist yet.
  private sharedAbove(path: string): string | null {
    while (path) {
      path = parentPath(path);
      if (this.app.vault.getFileByPath(markerPath(path))) return path;
    }
    return null;
  }

  private containsShared(folder: TFolder): boolean {
    return folder.children.some((child) =>
      child instanceof TFolder ? this.containsShared(child) : child instanceof TFile && (child.name === MARKER || !!readUrl(this.app, child)),
    );
  }

  private markerOf(folder: TFolder): TFile | null {
    return this.app.vault.getFileByPath(markerPath(folderPath(folder)));
  }

  private folderUrl(folder: TFolder): string | undefined {
    const marker = this.markerOf(folder);
    return marker ? readUrl(this.app, marker) : undefined;
  }

  private folderMenu(menu: Menu, folder: TFolder) {
    const collab = this.collabOf(folderPath(folder));
    const marker = this.markerOf(folder);
    if (marker) {
      if (collab && collab.folder !== null) {
        menu.addItem((item) => item.setTitle(commands.disconnectFolder).setIcon('unplug').onClick(() => void this.disconnect(collab)));
      } else {
        menu.addItem((item) => item.setTitle(commands.connectFolder).setIcon('plug').onClick(() => void this.connectFolder(folder)));
      }
      const url = this.folderUrl(folder);
      if (url) menu.addItem((item) => item.setTitle(commands.copyFolderUrl).setIcon('link').onClick(() => void this.copy(url, folderName(folder))));
      const invite = this.folderInvite(folder);
      if (invite) menu.addItem((item) => item.setTitle(commands.regenerateFolderUrl).setIcon('refresh-cw').onClick(() => void this.regenerateFolder(folder, invite)));
      menu.addItem((item) => item.setTitle(commands.stopSharingFolder).setIcon('x').onClick(() => void this.stopSharingFolder(folder)));
    } else if (this.canShare(folder)) {
      menu.addItem((item) => item.setTitle(commands.shareFolder).setIcon('users').onClick(() => void this.shareFolder(folder)));
    }
  }

  private rebindAll() {
    for (const collab of this.collabs.values()) collab.rebindAll();
  }

  private peerTotal(): number {
    let peers = 0;
    for (const collab of this.collabs.values()) peers += collab.peers;
    return peers;
  }

  // Peer count and, per connected peer, whether the connection is direct
  // or through a TURN relay.
  private async peerSummary(collab: Collab): Promise<string> {
    const paths = await collab.paths();
    return status.peers(collab.peers, paths);
  }

  // One line per collab, then one indented per peer in it, as the menu
  // shows them.
  private async connectedSummary(): Promise<DocumentFragment | string> {
    if (!this.collabs.size) return notices.nothingConnected;
    const fragment = createFragment();
    for (const collab of this.collabs.values()) {
      fragment.createDiv({ text: status.collab(collabName(collab), await this.peerSummary(collab)) });
      for (const peer of collab.others()) fragment.createDiv({ text: peerLine(peer) });
    }
    return fragment;
  }

  // Bottom bar: how many collabs are connected and how many peers in all,
  // click for the list.
  private updateStatus() {
    const n = this.collabs.size;
    this.statusBar.setText(n ? status.some(n, this.peerTotal()) : status.none);
    this.statusBar.toggleClass('mod-clickable', n > 0);
  }

  private async showConnected(event: MouseEvent) {
    if (!this.collabs.size) return;
    const menu = new Menu();
    for (const collab of this.collabs.values()) {
      const title = status.disconnect(collabName(collab), await this.peerSummary(collab));
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon('unplug')
          .onClick(() => void this.disconnect(collab)),
      );
      for (const peer of collab.others()) {
        menu.addItem((item) =>
          item
            .setTitle(peerLine(peer))
            .setIcon('user')
            .setDisabled(!peer.path)
            .onClick(() => void this.app.workspace.openLinkText(peer.path ?? '', '')),
        );
      }
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(commands.disconnectAll).setIcon('unplug').onClick(() => void this.disconnectAll()));
    menu.showAtMouseEvent(event);
  }

  // Picks relays that answer right now. The URL carries them, so a dead
  // one would burden every join forever.
  private async newInvite(id = randomId()): Promise<Invite | null> {
    const { community, relays: publicRelays } = this.settings;
    if (!community.length && !publicRelays.length) {
      new Notice(notices.addRelay);
      return null;
    }
    const notice = new Notice(notices.checkingRelays, 0);
    let relays: string[];
    try {
      relays = await preferredLiveRelays(community, publicRelays, RELAY_COUNT);
    } finally {
      notice.hide();
    }
    if (!relays.length) {
      new Notice(notices.noRelay, 10000);
      return null;
    }
    return { relays, id, secret: randomId(16) };
  }

  // A new URL for a share: fresh relays and a new secret under the same
  // id, so its saved state and its notes carry over. Everyone needs the
  // new URL, and the old one stops working.
  async regenerateFile(file: TFile, old: Invite, confirmed = false) {
    if (!confirmed && !(await confirmRegenerate(this.app, old))) return;
    const invite = await this.newInvite(old.id);
    if (!invite) return;
    invite.file = old.file;
    void this.copy(inviteUrl(invite), file.basename);
    await this.adoptFile(file, invite, true);
  }

  async regenerateFolder(folder: TFolder, old: Invite, confirmed = false) {
    if (!confirmed && !(await confirmRegenerate(this.app, old))) return;
    const invite = await this.newInvite(old.id);
    if (!invite) return;
    invite.folder = old.folder;
    void this.copy(inviteUrl(invite), folderName(folder));
    await this.adoptFolder(folder, invite);
  }

  // Connects a share with a new URL, in place of any connection made with
  // the old one. The property is part of the shared text, so only the side
  // that made the URL writes it: sync carries it to the others. Written
  // on both sides, the same offline edit would merge doubled. With history
  // the note is bound once connected and the write is a shared edit; a
  // write before binding could lose to an editor not yet reloaded from
  // disk. Without history the text a peer sends replaces the note anyway.
  private async adoptFile(file: TFile, invite: Invite, write: boolean) {
    const current = this.collabs.get(invite.id);
    if (current) await this.disconnect(current);
    const url = inviteUrl(invite);
    const before = write && (await this.store.read(invite.id)) === null;
    if (before) await writeUrl(this.app, file, url);
    await this.connectFile(file, invite);
    if (write && !before && this.collabs.has(invite.id)) await writeUrl(this.app, file, url);
  }

  // The marker is not a shared doc, so every side stores it.
  private async adoptFolder(folder: TFolder, invite: Invite) {
    const current = this.collabs.get(invite.id);
    if (current) await this.disconnect(current);
    await this.writeMarker(folderPath(folder), inviteUrl(invite));
    await this.connectFolder(folder, invite);
  }

  // Sharing is the only way a doc gets created.
  async shareFile(file: TFile) {
    const invite = await this.newInvite();
    if (!invite) return;
    invite.file = file.basename;
    await writeUrl(this.app, file, inviteUrl(invite));
    const collab = await this.open(invite, file.path);
    await collab.seed(file, collab.id, '');
    void this.copy(collab.url, file.basename);
    await this.connectWith(collab, file.basename);
  }

  async shareFolder(folder: TFolder) {
    if (folder.isRoot()) {
      const { title, text, action } = modals.shareVault;
      const ok = await new Confirm(this.app, title, text, action).ask();
      if (!ok) return;
    }
    const invite = await this.newInvite();
    if (!invite) return;
    const path = folderPath(folder);
    invite.folder = path;
    await this.writeMarker(path, inviteUrl(invite));
    const collab = await this.open(invite, path);
    await this.folderSync(collab).start();
    void this.copy(collab.url, folderName(folder));
    await this.connectWith(collab, folderName(folder));
  }

  async joinUrl() {
    const url = await new AskUrl(this.app).ask();
    if (url === undefined) return;
    const invite = parseInviteUrl(url);
    if (invite) await this.join(invite, true);
    else new Notice(notices.notAUrl);
  }

  // Someone else's URL. The first time, creates the file or folder with the
  // property and connects. For a share already here, the URL replaces the
  // stored one: that is how a regenerated URL gets in.
  async join(invite: Invite, confirmed: boolean) {
    if (this.collabs.get(invite.id)?.url === inviteUrl(invite)) {
      new Notice(notices.alreadyConnected);
      return;
    }
    if (invite.folder === undefined) {
      // A note with this id may already be here from an earlier join.
      const existing = this.app.vault.getMarkdownFiles().find((file) => readInvite(this.app, file)?.id === invite.id);
      // A new note goes at the vault root.
      if (!existing && this.sharedFolderOf(this.app.vault.getRoot())) {
        new Notice(notices.vaultShared, 10000);
        return;
      }
      if (!confirmed && !(await confirmJoin(this.app, invite, !!existing))) return;
      if (existing) {
        await this.app.workspace.getLeaf(false).openFile(existing);
        await this.adoptFile(existing, invite, false);
        return;
      }
      // A fresh join has no history by definition.
      await this.store.remove(invite.id);
      const file = await createNote(this.app, invite.file ?? '');
      await writeUrl(this.app, file, inviteUrl(invite));
      await this.app.workspace.getLeaf(false).openFile(file);
      await this.connectFile(file, invite, true);
      return;
    }
    const path = invite.folder;
    const existing = path ? this.app.vault.getFolderByPath(path) : this.app.vault.getRoot();
    const known = existing && this.folderInvite(existing)?.id === invite.id ? existing : null;
    const above = known ? null : this.sharedAbove(path);
    if (above !== null) {
      new Notice(notices.insideShare(path, above), 10000);
      return;
    }
    // The vault root always exists. With no notes in it, it is as good as new.
    const taken = path ? !!existing : this.app.vault.getMarkdownFiles().length > 0;
    if (!known && taken) {
      new Notice(path ? notices.folderExists(path) : notices.vaultNotEmpty, 10000);
      return;
    }
    if (!confirmed && !(await confirmJoin(this.app, invite, !!known))) return;
    if (known) {
      await this.adoptFolder(known, invite);
      return;
    }
    await this.store.remove(invite.id);
    const folder = existing ?? (await this.app.vault.createFolder(path));
    await this.writeMarker(path, inviteUrl(invite));
    await this.connectFolder(folder, invite, true);
  }

  // The file has the property.
  async connectFile(file: TFile, invite: Invite, fresh = false) {
    if (this.collabs.has(invite.id)) {
      new Notice(notices.alreadyConnected);
      return;
    }
    const collab = await this.open(invite, file.path);
    await this.bindAndConnect(
      collab,
      file.basename,
      fresh,
      () => collab.waitFor(collab.id),
      async () => {
        await collab.attach(file, collab.id);
      },
    );
  }

  // The invite is passed when the marker was just written, since the
  // metadata cache lags behind.
  async connectFolder(folder: TFolder, invite?: Invite | null, fresh = false) {
    invite ??= this.folderInvite(folder);
    if (!invite || invite.folder === undefined) {
      new Notice(notices.markerInvalid(MARKER, folder.path));
      return;
    }
    if (this.collabs.has(invite.id)) {
      new Notice(notices.alreadyConnected);
      return;
    }
    const collab = await this.open(invite, invite.folder);
    const sync = this.folderSync(collab);
    await this.bindAndConnect(
      collab,
      folderName(folder),
      fresh,
      () => collab.waitSynced(),
      () => sync.start(),
    );
  }

  // With saved state, bind at once and let the CRDT merge. Without it, wait
  // for a peer who has the content, then bind.
  private async bindAndConnect(collab: Collab, name: string, fresh: boolean, arrived: () => Promise<boolean>, bind: () => Promise<void>) {
    if (collab.hasState) {
      await bind();
      await this.connectWith(collab, name);
      return;
    }
    if (!fresh) this.noHistory(name);
    await this.connectWith(collab, name, async () => {
      if (!(await arrived())) return false;
      await bind();
      return true;
    });
  }

  // State is a cache. Without it, local edits made meanwhile cannot merge.
  private noHistory(name: string) {
    new Notice(notices.noHistory(name), 15000);
  }

  // The network verdict. Shown on request, and folded into the failure
  // notice when a connection fails: a strict network often connects anyway,
  // so a warning up front would be noise.
  private verdict: string | null = null;

  private async refreshVerdict() {
    this.natCheckedAt = Date.now();
    const check = await natCheck(this.settings);
    const relayed = rtcConfig(this.settings).iceTransportPolicy === 'relay';
    const worrying = !check.online || (!relayed && (check.needsTurn || check.symmetric));
    this.verdict = worrying ? describeNat(check) : null;
    return check;
  }

  async checkNetwork() {
    const check = await this.refreshVerdict();
    new Notice(notices.network(describeNat(check)), this.verdict ? 15000 : 5000);
    const turn = turnServer(this.settings);
    if (!turn || !check.online) return;
    const ok = await checkTurn(turn);
    new Notice(ok ? notices.turnWorks : notices.turnFailed, ok ? 5000 : 15000);
  }

  async showDiagnostics() {
    const notice = new Notice(notices.gathering, 0);
    try {
      new ShowText(this.app, modals.diagnostics.title, await this.diagnostics()).open();
    } finally {
      notice.hide();
    }
  }

  // The e2e reads this.
  diagnostics(): Promise<string> {
    return gatherDiagnostics(this.manifest.version, this.settings, this.collabs.values());
  }

  // Connects with a notice that stays until we know whether relays can
  // reach us. Without saved state it then waits, visibly, for a peer to
  // hand over the content. Disconnecting cancels either wait.
  private async connectWith(collab: Collab, name: string, receive?: () => Promise<boolean>) {
    const session = this.sessions.get(collab);
    if (!session) return;
    const notice = new Notice(notices.connecting(name), 0);
    const connecting = () => {
      const { relays } = collab.status();
      notice.setMessage(relays ? notices.connectingRelays(name, relays) : notices.connecting(name));
    };
    try {
      collab.connect((status) => this.onStatus(collab, name, status));
      session.update = connecting;
      connecting();
      const reachable = await collab.waitReachable();
      session.update = undefined;
      if (!this.sessions.has(collab)) return;
      if (!reachable) {
        const why = this.verdict ? notices.networkWhy(this.verdict) : '';
        new Notice(notices.unreachable(name, why), 15000);
      } else if (!receive && !collab.peers) {
        // A peer that arrived while the relays were being probed has
        // already announced itself. Saying "waiting" after that reads
        // backwards, and once one arrives the waiting is over.
        const waiting = new Notice(notices.waitingPeers(name));
        session.update = () => {
          if (!collab.peers) return;
          waiting.hide();
          session.update = undefined;
        };
      }
      if (!receive) return;
      notice.setMessage(notices.waitingContent(name));
      session.update = () => {
        if (collab.peers) notice.setMessage(notices.receiving(name));
      };
      const received = await receive();
      session.update = undefined;
      if (received) new Notice(notices.received(name));
      else if (this.sessions.has(collab)) await this.disconnect(collab);
    } finally {
      notice.hide();
    }
  }

  // Peer stages after connecting: found, then connected or failed. Trystero
  // retries, and on a strict NAT a retry often succeeds, so a failure is
  // reported only when nothing has connected a few seconds after it.
  private onStatus(collab: Collab, name: string, status: Status) {
    // ICE events can still arrive from a collab that was just disconnected.
    const session = this.sessions.get(collab);
    if (!session) return;
    session.update?.();
    if (collab.peers) {
      clearAlerts(session);
    } else if (status.failures > session.seen.failures) {
      // Relayed connections take longer to settle than direct ones.
      const turn = !!turnServer(this.settings);
      window.clearTimeout(session.failureTimer);
      session.failureTimer = window.setTimeout(
        () => {
          clearAlerts(session);
          if (!this.sessions.has(collab) || collab.peers) return;
          const why = this.verdict ? notices.networkWhy(this.verdict) : '';
          new Notice(
            turn ? notices.failedWithTurn(name, why) : notices.failed(name, why),
            12000,
          );
        },
        turn ? 20000 : 8000,
      );
    } else if (status.attempts > session.seen.attempts && !session.peerNotice) {
      session.peerNotice = new Notice(notices.peerFound(name), 0);
    }
    session.seen = status;
    this.updateStatus();
  }

  private folderSync(collab: Collab): FolderSync {
    const sync = new FolderSync(this.app, collab, () => void this.disconnect(collab));
    const session = this.sessions.get(collab);
    if (session) session.sync = sync;
    return sync;
  }

  private async open(invite: Invite, path: string): Promise<Collab> {
    if (Date.now() - this.natCheckedAt >= 60000) void this.refreshVerdict();
    const collab = new Collab(this.app, invite, path, rtcConfig(this.settings), this.store);
    collab.setName(this.settings.name);
    collab.onPeers = (count) => new Notice(notices.peers(count));
    this.collabs.set(collab.id, collab);
    this.sessions.set(collab, { seen: collab.status() });
    this.updateStatus();
    await collab.load();
    return collab;
  }

  private folderInvite(folder: TFolder): Invite | null {
    const marker = this.markerOf(folder);
    return marker ? readInvite(this.app, marker) : null;
  }

  private async writeMarker(folder: string, url: string) {
    const path = markerPath(folder);
    const marker = this.app.vault.getFileByPath(path) ?? (await this.app.vault.create(path, markerBody));
    await writeUrl(this.app, marker, url);
  }

  async disconnect(collab: Collab) {
    if (!this.collabs.delete(collab.id)) return;
    this.updateStatus();
    await this.teardown(collab);
    new Notice(notices.disconnected);
  }

  private async teardown(collab: Collab) {
    const session = this.sessions.get(collab);
    this.sessions.delete(collab);
    session?.sync?.dispose();
    if (session) clearAlerts(session);
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
    new Notice(notices.unshared(file.basename));
  }

  async stopSharingFolder(folder: TFolder) {
    const marker = this.markerOf(folder);
    if (!marker) return;
    const invite = readInvite(this.app, marker);
    const collab = this.collabOf(folderPath(folder));
    if (collab) await this.disconnect(collab);
    await this.app.fileManager.trashFile(marker);
    if (invite) await this.store.remove(invite.id);
    new Notice(notices.unshared(folderName(folder)));
  }

  // The clipboard can stall when the window is not focused. Give up after
  // 3 s: the URL is in the property either way.
  async copy(url: string, name: string) {
    const timeout = new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 3000));
    try {
      const result = await Promise.race([navigator.clipboard.writeText(url), timeout]);
      if (result === 'timeout') throw new Error('clipboard timed out');
      new Notice(notices.copied(name));
    } catch {
      new Notice(notices.copyFailed(name), 8000);
    }
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<CollabSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved, turn: { ...DEFAULT_SETTINGS.turn, ...saved?.turn } };
  }

  async saveSettings() {
    for (const collab of this.collabs.values()) collab.setName(this.settings.name);
    await this.saveData(this.settings);
  }
}

function clearAlerts(session: Session) {
  session.peerNotice?.hide();
  session.peerNotice = undefined;
  window.clearTimeout(session.failureTimer);
  session.failureTimer = undefined;
}

// The vault root is '' in a collab and 'the vault' to the user.
function folderPath(folder: TFolder): string {
  return folder.isRoot() ? '' : folder.path;
}

function folderName(folder: TFolder): string {
  return folder.name || names.vault;
}

function collabName(collab: Collab): string {
  return collab.folder === null ? collab.path.replace(/\.md$/, '') : collab.path || names.vault;
}

// Indented under its collab. Spaces that survive a native menu, which
// takes plain strings only.
function peerLine({ name, path }: Peer): string {
  return `\u00a0\u00a0\u00a0\u00a0${path ? status.peerIn(name, path.replace(/\.md$/, '')) : name}`;
}
