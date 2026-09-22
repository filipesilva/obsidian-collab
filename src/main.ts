import { Menu, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { Collab, type Peer } from './collab';
import { gatherDiagnostics, natCheck } from './diagnostics';
import { collabExtension } from './editor';
import { FolderSync } from './folder';
import { readInvite, readUrl, removeUrl, writeUrl } from './frontmatter';
import { MARKER, findById, markerPath } from './identity';
import { Invite, inviteUrl, parseInvite, parseInviteUrl, randomId } from './invite';
import { AskUrl, Confirm, ShowText, confirmJoin, createNote } from './join';
import { checkTurn, describeNat, liveRelays } from './nat';
import { RELAY_COUNT, type Status } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS, rtcConfig, turnServer } from './settings';
import type { StateStore } from './state';
import { vaultStore } from './vault-store';

const MARKER_BODY = `This folder is shared with the Collab plugin. Every markdown file in it syncs
with everyone who joined the URL above. This file itself is not synced.
`;

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
      else new Notice('Collab: invalid URL');
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
      return folder && !this.sharedFolderOf(folder) && !this.containsShared(folder) ? folder : null;
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
        if (!folder || this.collabOf(folderPath(folder))) return false;
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
        if (!checking) void this.copy(url, folderName(folder));
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
        const collab = folder && this.collabOf(folderPath(folder));
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
      id: 'show-connected',
      name: 'Show connected',
      callback: () => void this.connectedSummary().then((text) => new Notice(text, 8000)),
    });
    this.addCommand({
      id: 'diagnostics',
      name: 'Diagnostics',
      callback: () => void this.showDiagnostics(),
    });
    this.addCommand({
      id: 'check-network',
      name: 'Check network',
      callback: () => void this.checkNetwork(),
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

  // The nearest folder with a marker, walking up from a folder.
  sharedFolderOf(folder: TFolder | null): TFolder | null {
    for (; folder; folder = folder.parent) if (this.markerOf(folder)) return folder;
    return null;
  }

  private containsShared(folder: TFolder): boolean {
    return folder.children.some((child) => (child instanceof TFolder ? this.containsShared(child) : child.name === MARKER));
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
        menu.addItem((item) => item.setTitle('Disconnect folder').setIcon('unplug').onClick(() => void this.disconnect(collab)));
      } else {
        menu.addItem((item) => item.setTitle('Connect folder').setIcon('plug').onClick(() => void this.connectFolder(folder)));
      }
      const url = this.folderUrl(folder);
      if (url) menu.addItem((item) => item.setTitle('Copy folder URL').setIcon('link').onClick(() => void this.copy(url, folderName(folder))));
      menu.addItem((item) => item.setTitle('Stop sharing folder').setIcon('x').onClick(() => void this.stopSharingFolder(folder)));
    } else if (!this.sharedFolderOf(folder) && !this.containsShared(folder)) {
      menu.addItem((item) => item.setTitle('Share folder').setIcon('users').onClick(() => void this.shareFolder(folder)));
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
    return `${plural(collab.peers, 'peer')}${paths.length ? `, ${paths.join(', ')}` : ''}`;
  }

  // One line per collab, then one indented per peer in it, as the menu
  // shows them.
  private async connectedSummary(): Promise<DocumentFragment | string> {
    if (!this.collabs.size) return 'Collab: nothing connected';
    const fragment = createFragment();
    for (const collab of this.collabs.values()) {
      fragment.createDiv({ text: `${collabName(collab)}: ${await this.peerSummary(collab)}` });
      for (const peer of collab.others()) fragment.createDiv({ text: peerLine(peer) });
    }
    return fragment;
  }

  // Bottom bar: how many collabs are connected and how many peers in all,
  // click for the list.
  private updateStatus() {
    const n = this.collabs.size;
    this.statusBar.setText(n ? `${n} connected, ${plural(this.peerTotal(), 'peer')}` : '0 connected');
    this.statusBar.toggleClass('mod-clickable', n > 0);
  }

  private async showConnected(event: MouseEvent) {
    if (!this.collabs.size) return;
    const menu = new Menu();
    for (const collab of this.collabs.values()) {
      const title = `Disconnect ${collabName(collab)} (${await this.peerSummary(collab)})`;
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
    menu.addItem((item) => item.setTitle('Disconnect all').setIcon('unplug').onClick(() => void this.disconnectAll()));
    menu.showAtMouseEvent(event);
  }

  // Picks relays that answer right now. The URL carries them, so a dead
  // one would burden every join forever.
  private async newInvite(): Promise<Invite | null> {
    if (!this.settings.relays.length) {
      new Notice('Collab: add a signalling server in settings first');
      return null;
    }
    const notice = new Notice('Collab: checking relays…', 0);
    let relays: string[];
    try {
      relays = await liveRelays(this.settings.relays, RELAY_COUNT);
    } finally {
      notice.hide();
    }
    if (!relays.length) {
      new Notice('Collab: no signalling server answered. Check the network and the list in settings.', 10000);
      return null;
    }
    return { relays, id: randomId(), secret: randomId(16) };
  }

  // Sharing is the only way a doc gets created.
  async shareFile(file: TFile) {
    const invite = await this.newInvite();
    if (!invite) return;
    invite.file = file.basename;
    await writeUrl(this.app, file, inviteUrl(invite));
    const collab = await this.open(invite, file.path);
    await collab.seed(file, collab.id);
    void this.copy(collab.url, file.basename);
    await this.connectWith(collab, file.basename);
  }

  async shareFolder(folder: TFolder) {
    if (folder.isRoot()) {
      const ok = await new Confirm(
        this.app,
        'Share the whole vault?',
        'Every Markdown file in this vault will sync with everyone who joins, and no other folder in it can be shared on its own.',
        'Share vault',
      ).ask();
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
    else new Notice('Collab: that is not a collab URL');
  }

  // First time in from someone else's URL: creates the file or folder with
  // the property, then connects.
  async join(invite: Invite, confirmed: boolean) {
    if (this.collabs.has(invite.id)) {
      new Notice('Collab: already connected');
      return;
    }
    if (!confirmed && !(await confirmJoin(this.app, invite))) return;
    if (invite.folder === undefined) {
      // A note with this id may already be here from an earlier join.
      const known = findById(
        this.app.vault.getMarkdownFiles().map((file) => ({ path: file.path, url: readUrl(this.app, file) })),
        invite.id,
      );
      const existing = known && this.app.vault.getFileByPath(known.path);
      if (existing) {
        await this.app.workspace.getLeaf(false).openFile(existing);
        await this.connectFile(existing, invite);
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
    await this.store.remove(invite.id);
    await this.app.vault.createFolder(path);
    await this.writeMarker(path, inviteUrl(invite));
    await this.connectFolder(this.app.vault.getFolderByPath(path)!, invite, true);
  }

  // The file has the property.
  async connectFile(file: TFile, invite: Invite, fresh = false) {
    if (this.collabs.has(invite.id)) {
      new Notice('Collab: already connected');
      return;
    }
    const collab = await this.open(invite, file.path);
    await this.bindAndConnect(
      collab,
      file.basename,
      fresh,
      () => collab.waitFor(collab.id),
      async () => (await collab.attach(file, collab.id)).ready,
    );
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
    new Notice(
      `Collab: no local history for ${name}. A peer has to be online to send it, and it will replace what is here. Obsidian's file recovery keeps the current version.`,
      15000,
    );
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
    new Notice(`Collab: ${describeNat(check)}.`, this.verdict ? 15000 : 5000);
    const turn = turnServer(this.settings);
    if (!turn || !check.online) return;
    const ok = await checkTurn(turn);
    new Notice(ok ? 'Collab: TURN works.' : 'Collab: TURN did not answer. Check the URL, username and credential in settings.', ok ? 5000 : 15000);
  }

  async showDiagnostics() {
    const notice = new Notice('Collab: gathering diagnostics…', 0);
    try {
      new ShowText(this.app, 'Collab diagnostics', await this.diagnostics()).open();
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
    const notice = new Notice(`Collab: connecting ${name}…`, 0);
    const connecting = () => {
      const { relays } = collab.status();
      notice.setMessage(relays ? `Collab: connecting ${name}, ${plural(relays, 'relay')} open…` : `Collab: connecting ${name}…`);
    };
    try {
      collab.connect((status) => this.onStatus(collab, name, status));
      session.update = connecting;
      connecting();
      const reachable = await collab.waitReachable();
      session.update = undefined;
      if (!this.sessions.has(collab)) return;
      if (!reachable) {
        const why = this.verdict ? ` Network check: ${this.verdict}.` : '';
        new Notice(`Collab: ${name} could not reach any signalling server. Check the network and the signalling list. Still trying…${why}`, 15000);
      } else if (!receive && !collab.peers) {
        // A peer that arrived while the relays were being probed has
        // already announced itself. Saying "waiting" after that reads
        // backwards, and once one arrives the waiting is over.
        const waiting = new Notice(`Collab: ${name} ready, waiting for peers…`);
        session.update = () => {
          if (!collab.peers) return;
          waiting.hide();
          session.update = undefined;
        };
      }
      if (!receive) return;
      notice.setMessage(`Collab: waiting for someone who has ${name}…`);
      session.update = () => {
        if (collab.peers) notice.setMessage(`Collab: receiving ${name}…`);
      };
      const received = await receive();
      session.update = undefined;
      if (received) new Notice(`Collab: received ${name}, editing`);
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
          const why = this.verdict ? ` Network check: ${this.verdict}.` : '';
          new Notice(
            turn
              ? `Collab: a peer was found for ${name} but connections keep failing, even with TURN. Test the TURN settings.${why}`
              : `Collab: a peer was found for ${name} but the connection failed. A TURN server in settings may help.${why}`,
            12000,
          );
        },
        turn ? 20000 : 8000,
      );
    } else if (status.attempts > session.seen.attempts && !session.peerNotice) {
      session.peerNotice = new Notice(`Collab: peer found for ${name}, connecting…`, 0);
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
    collab.onPeers = (count) => new Notice(count ? `Collab: ${plural(count, 'peer')} connected` : 'Collab: no peers connected');
    this.collabs.set(collab.id, collab);
    this.sessions.set(collab, { seen: collab.status() });
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
    new Notice(`Collab: ${file.basename} is no longer shared`);
  }

  async stopSharingFolder(folder: TFolder) {
    const marker = this.markerOf(folder);
    if (!marker) return;
    const invite = readInvite(this.app, marker);
    const collab = this.collabOf(folderPath(folder));
    if (collab) await this.disconnect(collab);
    await this.app.fileManager.trashFile(marker);
    if (invite) await this.store.remove(invite.id);
    new Notice(`Collab: ${folderName(folder)} is no longer shared`);
  }

  // The clipboard can stall when the window is not focused. Give up after
  // 3 s: the URL is in the property either way.
  async copy(url: string, name: string) {
    const timeout = new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 3000));
    try {
      const result = await Promise.race([navigator.clipboard.writeText(url), timeout]);
      if (result === 'timeout') throw new Error('clipboard timed out');
      new Notice(`Collab: URL for ${name} copied`);
    } catch {
      new Notice(`Collab: could not copy. The URL for ${name} is in its collab-url property.`, 8000);
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
  return folder.name || 'the vault';
}

function collabName(collab: Collab): string {
  return collab.folder === null ? collab.path.replace(/\.md$/, '') : collab.path || 'the vault';
}

// Indented under its collab. Spaces that survive a native menu, which
// takes plain strings only.
function peerLine({ name, path }: Peer): string {
  return `\u00a0\u00a0\u00a0\u00a0${path ? `${name} in ${path.replace(/\.md$/, '')}` : name}`;
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}
