import { Notice, Plugin, TFile } from 'obsidian';
import { collabExtension } from './editor';
import { Invite, inviteLink, parseInvite, parseInviteLink, randomId } from './invite';
import { AskLink, ConfirmJoin, PickNote, createNote } from './join';
import { Room } from './room';
import { type Status, pickRelays } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS, iceServers } from './settings';

// Peers announce once, then every 60 s, and relays that rate-limit back off
// for 60 s. Wait out one full cycle before giving up.
const JOIN_TIMEOUT = 75000;

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  room: Room | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.registerEditorExtension(collabExtension);
    this.registerObsidianProtocolHandler('collab', (params) => {
      const invite = parseInvite(params);
      if (invite) void this.join(invite);
      else new Notice('Collab: invalid invite link');
    });

    this.addCommand({
      id: 'start-room',
      name: 'Start room with current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.room) return false;
        if (!checking) void this.start(file);
        return true;
      },
    });
    this.addCommand({
      id: 'join-room',
      name: 'Join room from invite link',
      checkCallback: (checking) => {
        if (this.room) return false;
        if (!checking) void this.joinFromLink();
        return true;
      },
    });
    this.addCommand({
      id: 'share-note',
      name: 'Share current note into the room',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.room || this.room.docs.has(file.path)) return false;
        if (!checking) void this.share(file);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-invite',
      name: 'Copy invite link for current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.room?.docs.has(file.path)) return false;
        if (!checking) void this.copyInvite(file);
        return true;
      },
    });
    this.addCommand({
      id: 'unshare-note',
      name: 'Stop sharing current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.room?.docs.has(file.path)) return false;
        if (!checking) this.unshare(file.path);
        return true;
      },
    });
    this.addCommand({
      id: 'leave-room',
      name: 'Leave room',
      checkCallback: (checking) => {
        if (!this.room) return false;
        if (!checking) this.leave();
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.room?.rebindAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.room?.rebindAll()));
    this.registerEvent(
      this.app.vault.on('modify', (file) => void this.room?.docs.get(file.path)?.onModify()),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.room?.rename(oldPath, file);
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.unshare(file.path)));
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.room?.provider?.checkRelays();
    });
  }

  onunload() {
    this.room?.leave();
    this.room = null;
  }

  async start(file: TFile) {
    const relays = pickRelays(this.settings.relays);
    if (!relays.length) {
      new Notice('Collab: add a signalling server in settings first');
      return;
    }
    this.room = new Room(this.app, { relays, room: randomId(), secret: randomId(16) }, iceServers(this.settings));
    this.room.connect();
    await this.room.share(file);
    await this.copyInvite(file);
  }

  async joinFromLink() {
    const link = await new AskLink(this.app).ask();
    if (link === undefined) return;
    const invite = parseInviteLink(link);
    if (invite) await this.join(invite, true);
    else new Notice('Collab: that is not an invite link');
  }

  // The invite's relays are used for this room only. Settings stay untouched.
  // A link from the protocol handler asks for confirmation, a pasted one does not.
  async join(invite: Invite, confirmed = false) {
    if (this.room) {
      new Notice('Collab: leave the current room before joining another');
      return;
    }
    if (!confirmed && !(await new ConfirmJoin(this.app, invite).ask())) return;
    const picked = await new PickNote(this.app, invite.note).ask();
    if (picked === undefined) return;
    const file = picked ?? (await createNote(this.app, invite.note));

    const room = new Room(this.app, invite, iceServers(this.settings));
    this.room = room;
    const notice = new Notice(progress(room.status()), 0);
    try {
      room.connect((status) => notice.setMessage(progress(status)));
      const synced = await room.synced(JOIN_TIMEOUT);
      if (this.room !== room) return;
      if (!synced || !room.has(invite.doc)) {
        const status = room.status();
        room.leave();
        this.room = null;
        new Notice(synced ? 'Collab: the room does not have that note anymore' : failure(status), 10000);
        return;
      }
      const doc = await room.share(file, invite.doc);
      await doc.ready;
      await this.app.workspace.getLeaf(false).openFile(file);
      new Notice(`Collab: joined, editing ${file.basename}`);
    } finally {
      notice.hide();
    }
  }

  async share(file: TFile) {
    if (!this.room) return;
    await this.room.share(file);
    new Notice(`Collab: sharing ${file.basename}`);
  }

  async copyInvite(file: TFile) {
    const doc = this.room?.docs.get(file.path);
    if (!this.room || !doc) return;
    await navigator.clipboard.writeText(
      inviteLink({ ...this.room.info, doc: doc.id, note: file.basename }),
    );
    new Notice(`Collab: invite link for ${file.basename} copied`);
  }

  unshare(path: string) {
    const doc = this.room?.unshare(path);
    if (doc) new Notice(`Collab: stopped sharing ${doc.file.basename}`);
  }

  leave() {
    this.room?.leave();
    this.room = null;
    new Notice('Collab: left the room');
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CollabSettings>) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function progress(status: Status): string {
  if (status.peerFound) return 'Collab: peer found, connecting…';
  if (status.relays) return `Collab: looking for peers through ${status.relays} ${status.relays === 1 ? 'relay' : 'relays'}…`;
  return 'Collab: connecting to signalling servers…';
}

function failure(status: Status): string {
  if (status.peerFound) {
    return 'Collab: found a peer but the connection failed. A TURN server in settings may help.';
  }
  if (status.relays) return 'Collab: nobody found in that room. The host may have left, or the link is old.';
  return 'Collab: could not reach any signalling server. Check the network and the signalling list in settings.';
}
