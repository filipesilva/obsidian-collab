import { Menu, Notice, Platform, Plugin, TFile, TFolder } from 'obsidian';
import { Collab } from './collab';
import { collabExtension } from './editor';
import { FolderSync } from './folder';
import { readInvite, readUrl, removeUrl, writeUrl } from './frontmatter';
import { MARKER, findById, markerPath } from './identity';
import { Invite, inviteUrl, parseInvite, parseInviteUrl, randomId } from './invite';
import { AskUrl, Confirm, ConfirmJoin, ShowText, createNote } from './join';
import { checkNat, checkTurn, describeNat, listCandidates, liveRelays, probeSockets } from './nat';
import { RELAY_COUNT, type Status, pickRelays } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS, rtcConfig, turnServer } from './settings';
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
  private natCheckedAt = 0;
  private statusUpdaters = new Map<string, () => void>();
  private seenStatus = new Map<string, { attempts: number; failures: number }>();
  private peerNotices = new Map<string, Notice>();
  private failureTimers = new Map<string, number>();

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
      callback: () => void this.checkNetwork(true),
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

  private peerTotal(): number {
    let peers = 0;
    for (const collab of this.collabs.values()) peers += collab.peers;
    return peers;
  }

  private async connectedSummary(): Promise<string> {
    if (!this.collabs.size) return 'Collab: nothing connected';
    const lines: string[] = [];
    for (const collab of this.collabs.values()) {
      const name = collab.folder === null ? collab.path.replace(/\.md$/, '') : collab.path || 'the vault';
      const paths = await collab.paths();
      const detail = paths.length ? ` (${paths.join(', ')})` : '';
      lines.push(`${name}: ${collab.peers} ${collab.peers === 1 ? 'peer' : 'peers'}${detail}`);
    }
    return `Collab: ${lines.join(', ')}`;
  }

  // Bottom bar: how many collabs are connected and how many peers in all,
  // click for the list.
  private updateStatus() {
    const n = this.collabs.size;
    const peers = this.peerTotal();
    this.statusBar.setText(n ? `${n} connected, ${peers} ${peers === 1 ? 'peer' : 'peers'}` : '0 connected');
    this.statusBar.toggleClass('mod-clickable', n > 0);
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
    await this.copy(collab.url, file.basename);
    await this.connectWith(collab, file.basename);
  }

  async shareFolder(folder: TFolder) {
    const invite = await this.newInvite();
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
    await this.copy(collab.url, folder.name || 'the vault');
    await this.connectWith(collab, folder.name || 'the vault');
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
      await this.connectWith(collab, file.basename);
      return;
    }
    if (!fresh) this.noHistory(file.basename);
    await this.connectWith(collab, file.basename, async () => {
      if (!(await collab.waitFor(collab.id))) return false;
      const doc = await collab.attach(file, collab.id);
      await doc.ready;
      return true;
    });
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
    const name = folder.name || 'the vault';
    if (collab.hasState) {
      await sync.reconcile();
      sync.watch();
      await this.connectWith(collab, name);
      return;
    }
    if (!fresh) this.noHistory(name);
    await this.connectWith(collab, name, async () => {
      if (!(await collab.waitSynced())) return false;
      await sync.reconcile();
      sync.watch();
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

  async checkNetwork(always: boolean) {
    if (!always && Date.now() - this.natCheckedAt < 60000) return;
    this.natCheckedAt = Date.now();
    const check = await checkNat(this.settings.stun, () => probeSockets(pickRelays(this.settings.relays, 5)));
    const turn = turnServer(this.settings);
    const worrying = !check.online || (!this.settings.turn.always && (check.needsTurn || check.symmetric));
    this.verdict = worrying ? describeNat(check) : null;
    if (always) new Notice(`Collab: ${describeNat(check)}.`, worrying ? 15000 : 5000);
    if (turn && always && check.online) {
      const ok = await checkTurn(turn);
      new Notice(ok ? 'Collab: TURN works.' : 'Collab: TURN did not answer. Check the URL, username and credential in settings.', ok ? 5000 : 15000);
    }
  }

  // Everything needed to debug a connection from afar, on the clipboard.
  async showDiagnostics() {
    const notice = new Notice('Collab: gathering diagnostics…', 0);
    try {
      new ShowText(this.app, 'Collab diagnostics', await this.diagnostics()).open();
    } finally {
      notice.hide();
    }
  }

  // Everything needed to debug a connection from afar, as text.
  async diagnostics(): Promise<string> {
    const started = Date.now();
    const platform = Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : 'linux';
    const lines: string[] = [`collab ${this.manifest.version} ${platform} ${new Date().toISOString()}`, `online=${navigator.onLine}`];
    try {
      const nat = await checkNat(this.settings.stun, () => probeSockets(pickRelays(this.settings.relays, 5)));
      lines.push(`nat: ${JSON.stringify(nat)} -> ${describeNat(nat)}`);
      const turn = turnServer(this.settings);
      lines.push(`turn: ${turn ? `${String(turn.urls)} always=${this.settings.turn.always}` : 'none'}`);
      if (turn) lines.push(`turn test: ${await checkTurn(turn)}`);
      const withStun = await listCandidates({ iceServers: [{ urls: this.settings.stun }] });
      // Candidate lines here start at the component: "1 udp <priority> <address> <port> typ …".
      const publicAddresses = [...new Set(withStun.filter((l) => / typ srflx /.test(l)).map((l) => l.split(' ')[3]))];
      lines.push(`public address: ${publicAddresses.join(', ') || 'none seen'}`);
      lines.push(`network: ${describeNetwork(withStun)}${Platform.isIosApp ? ' (a guess: iOS marks every candidate as costly)' : ''}`);
      lines.push('candidates with stun:');
      for (const line of withStun) lines.push(`  ${line}`);
      if (turn) {
        lines.push('candidates with turn only:');
        for (const line of await listCandidates({ iceServers: [turn], iceTransportPolicy: 'relay' })) lines.push(`  ${line}`);
      }
      for (const collab of this.collabs.values()) {
        lines.push(`collab ${collab.path}: peers=${collab.peers} status=${JSON.stringify(collab.status())}`);
        for (const line of await collab.describeConnections()) lines.push(`  ${line}`);
      }
    } catch (e) {
      lines.push(`error: ${String(e)}`);
    }
    lines.push(`gathered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return lines.join('\n');
  }

  // Connects with a notice that stays until we know whether relays can
  // reach us. Without saved state it then waits, visibly, for a peer to
  // hand over the content. Disconnecting cancels either wait.
  private async connectWith(collab: Collab, name: string, receive?: () => Promise<boolean>) {
    const notice = new Notice(`Collab: connecting ${name}…`, 0);
    const connecting = () => {
      const { relays } = collab.status();
      notice.setMessage(relays ? `Collab: connecting ${name}, ${relays} ${relays === 1 ? 'relay' : 'relays'} open…` : `Collab: connecting ${name}…`);
    };
    try {
      collab.connect((status) => this.onStatus(collab, name, status));
      this.statusUpdaters.set(collab.id, connecting);
      connecting();
      const reachable = await collab.waitReachable();
      this.statusUpdaters.delete(collab.id);
      if (!this.collabs.has(collab.id)) return;
      if (!reachable) {
        const why = this.verdict ? ` Network check: ${this.verdict}.` : '';
        new Notice(`Collab: ${name} could not reach any signalling server. Check the network and the signalling list. Still trying…${why}`, 15000);
      } else if (!receive && !collab.peers) {
        // A peer that arrived while the relays were being probed has
        // already announced itself. Saying "waiting" after that reads
        // backwards, and once one arrives the waiting is over.
        const waiting = new Notice(`Collab: ${name} ready, waiting for peers…`);
        this.statusUpdaters.set(collab.id, () => {
          if (collab.peers) {
            waiting.hide();
            this.statusUpdaters.delete(collab.id);
          }
        });
      }
      if (!receive) return;
      notice.setMessage(`Collab: waiting for someone who has ${name}…`);
      this.statusUpdaters.set(collab.id, () => {
        if (collab.peers) notice.setMessage(`Collab: receiving ${name}…`);
      });
      const received = await receive();
      this.statusUpdaters.delete(collab.id);
      if (received) new Notice(`Collab: received ${name}, editing`);
      else if (this.collabs.has(collab.id)) await this.disconnect(collab);
    } finally {
      notice.hide();
    }
  }

  // Peer stages after connecting: found, then connected or failed. Trystero
  // retries, and on a strict NAT a retry often succeeds, so a failure is
  // reported only when nothing has connected a few seconds after it.
  private onStatus(collab: Collab, name: string, status: Status) {
    // ICE events can still arrive from a collab that was just disconnected.
    if (this.collabs.get(collab.id) !== collab) return;
    this.statusUpdaters.get(collab.id)?.();
    const seen = this.seenStatus.get(collab.id) ?? { attempts: 0, failures: 0 };
    const hidePeerNotice = () => {
      this.peerNotices.get(collab.id)?.hide();
      this.peerNotices.delete(collab.id);
    };
    if (collab.peers) {
      hidePeerNotice();
      window.clearTimeout(this.failureTimers.get(collab.id));
      this.failureTimers.delete(collab.id);
    } else if (status.failures > seen.failures) {
      // Relayed connections take longer to settle than direct ones.
      const turn = !!turnServer(this.settings);
      window.clearTimeout(this.failureTimers.get(collab.id));
      this.failureTimers.set(
        collab.id,
        window.setTimeout(
          () => {
            this.failureTimers.delete(collab.id);
            if (!this.collabs.has(collab.id) || collab.peers) return;
            hidePeerNotice();
            const why = this.verdict ? ` Network check: ${this.verdict}.` : '';
            new Notice(
              turn
                ? `Collab: a peer was found for ${name} but connections keep failing, even with TURN. Test the TURN settings.${why}`
                : `Collab: a peer was found for ${name} but the connection failed. A TURN server in settings may help.${why}`,
              12000,
            );
          },
          turn ? 20000 : 8000,
        ),
      );
    } else if (status.attempts > seen.attempts && !this.peerNotices.has(collab.id) && !collab.peers) {
      this.peerNotices.set(collab.id, new Notice(`Collab: peer found for ${name}, connecting…`, 0));
    }
    this.seenStatus.set(collab.id, { attempts: status.attempts, failures: status.failures });
    this.updateStatus();
  }

  private folderSync(collab: Collab): FolderSync {
    const sync = new FolderSync(this.app, collab, collab.folder ?? '', () => void this.disconnect(collab));
    this.folders.set(collab.id, sync);
    return sync;
  }

  private async open(invite: Invite, path: string): Promise<Collab> {
    void this.checkNetwork(false);
    const collab = new Collab(this.app, invite, path, rtcConfig(this.settings), this.store);
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
    this.peerNotices.get(collab.id)?.hide();
    this.peerNotices.delete(collab.id);
    window.clearTimeout(this.failureTimers.get(collab.id));
    this.failureTimers.delete(collab.id);
    this.seenStatus.delete(collab.id);
    this.statusUpdaters.delete(collab.id);
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

  // The clipboard can stall when the window is not focused. Never let that
  // hold up sharing: the URL is in the property either way.
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
    await this.saveData(this.settings);
  }
}

// The kind of network, read off the candidates' network-cost: 999 is
// cellular, 10 wifi, 0 wired. Several kinds can be up at once.
function describeNetwork(candidates: string[]): string {
  const costs = new Set<number>();
  for (const line of candidates) {
    const m = /network-cost (\d+)/.exec(line);
    if (m) costs.add(Number(m[1]));
  }
  if (!costs.size) return 'unknown';
  const names = [...costs].sort((a, b) => a - b).map((c) => (c >= 900 ? 'cellular' : c >= 10 ? 'wifi' : 'wired'));
  return [...new Set(names)].join(' and ');
}
