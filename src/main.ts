import { Notice, Plugin, TFile } from 'obsidian';
import { collabExtension } from './editor';
import { Invite, inviteLink, parseInvite, randomId } from './invite';
import { ConfirmJoin, PickNote, createNote } from './join';
import { Session } from './session';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS } from './settings';

const JOIN_TIMEOUT = 15000;

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  session: Session | null = null;

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
      id: 'start-session',
      name: 'Start session with current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.session) return false;
        if (!checking) void this.start(file);
        return true;
      },
    });
    this.addCommand({
      id: 'share-note',
      name: 'Share current note into the session',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.session || this.session.docs.has(file.path)) return false;
        if (!checking) void this.share(file);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-invite',
      name: 'Copy invite link for current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.session?.docs.has(file.path)) return false;
        if (!checking) void this.copyInvite(file);
        return true;
      },
    });
    this.addCommand({
      id: 'unshare-note',
      name: 'Stop sharing current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.session?.docs.has(file.path)) return false;
        if (!checking) this.unshare(file.path);
        return true;
      },
    });
    this.addCommand({
      id: 'end-session',
      name: 'End session',
      checkCallback: (checking) => {
        if (!this.session) return false;
        if (!checking) this.end();
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => this.session?.rebindAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.session?.rebindAll()));
    this.registerEvent(
      this.app.vault.on('modify', (file) => void this.session?.docs.get(file.path)?.onModify()),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.session?.rename(oldPath, file);
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.unshare(file.path)));
  }

  onunload() {
    this.session?.end();
    this.session = null;
  }

  async start(file: TFile) {
    if (!this.settings.server) {
      new Notice('Collab: set a server URL in settings first');
      return;
    }
    this.session = new Session(this.app, {
      server: this.settings.server,
      room: randomId(),
      secret: randomId(16),
    });
    await this.session.connect();
    await this.session.share(file);
    await this.copyInvite(file);
  }

  // The host's server is used for this session only. Settings stay untouched.
  async join(invite: Invite) {
    if (this.session) {
      new Notice('Collab: end the current session before joining another');
      return;
    }
    if (!(await new ConfirmJoin(this.app, invite).ask())) return;
    const picked = await new PickNote(this.app, invite.note).ask();
    if (picked === undefined) return;
    const file = picked ?? (await createNote(this.app, invite.note));

    const session = new Session(this.app, invite);
    this.session = session;
    new Notice('Collab: connecting…');
    await session.connect();
    const synced = await session.synced(JOIN_TIMEOUT);
    if (this.session !== session) return;
    if (!synced || !session.has(invite.doc)) {
      this.end();
      new Notice(
        synced
          ? 'Collab: the session does not have that note anymore'
          : 'Collab: could not reach the peers. A direct connection failed; the server may need TURN.',
        10000,
      );
      return;
    }
    const doc = await session.share(file, invite.doc);
    await doc.ready;
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice(`Collab: joined, editing ${file.basename}`);
  }

  async share(file: TFile) {
    if (!this.session) return;
    await this.session.share(file);
    new Notice(`Collab: sharing ${file.basename}`);
  }

  async copyInvite(file: TFile) {
    const doc = this.session?.docs.get(file.path);
    if (!this.session || !doc) return;
    await navigator.clipboard.writeText(
      inviteLink({ ...this.session.info, doc: doc.id, note: file.basename }),
    );
    new Notice(`Collab: invite link for ${file.basename} copied`);
  }

  unshare(path: string) {
    const doc = this.session?.unshare(path);
    if (doc) new Notice(`Collab: stopped sharing ${doc.file.basename}`);
  }

  end() {
    this.session?.end();
    this.session = null;
    new Notice('Collab: session ended');
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CollabSettings>) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
