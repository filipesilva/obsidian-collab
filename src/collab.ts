import { App, TFile } from 'obsidian';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Invite, inviteUrl } from './invite';
import { Provider, type Status } from './network';
import { SharedDoc, sourceViews } from './shared-doc';
import { Persistence, type StateStore } from './state';
import { DocEntry, applyContent, docs, getText, observeDocs, openDoc } from './sync';

// Our colour for this run of the plugin, the same in every collab. It
// travels with the name, so everyone sees a peer in the same colour.
const HUE = Math.floor(Math.random() * 360);

export interface Peer {
  name: string;
  // Vault path of the note their cursor is in, if any.
  path: string | null;
}

// A shared file or folder: one Y.Doc, one Trystero room, its saved state,
// and the shared notes in it keyed by vault path. A file collab holds one
// doc, keyed by the collab id. A folder collab holds one per markdown file,
// with the entry path relative to the folder.
export class Collab {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  readonly docs = new Map<string, SharedDoc>();
  provider: Provider | null = null;
  // Whether saved state existed. With it, files win over the text on open.
  // Without it, the shared text wins, and nothing may be seeded.
  hasState = false;
  onPeers: ((count: number) => void) | null = null;
  private persistence: Persistence;
  private unobserve: () => void;
  // Every wait races `closed`, which resolves false on disconnect.
  private close!: () => void;
  private closed = new Promise<false>((resolve) => (this.close = () => resolve(false)));
  private gotSync!: () => void;
  private firstSync = new Promise<true>((resolve) => (this.gotSync = () => resolve(true)));

  constructor(
    private app: App,
    readonly invite: Invite,
    // The file's path, or the folder's path.
    public path: string,
    private rtc: RTCConfiguration,
    store: StateStore,
  ) {
    this.persistence = new Persistence(this.ydoc, invite.id, store);
    this.unobserve = observeDocs(this.ydoc, (id) => this.adoptReplaced(id));
  }

  get id(): string {
    return this.invite.id;
  }

  get url(): string {
    return inviteUrl(this.invite);
  }

  get folder(): string | null {
    return this.invite.folder ?? null;
  }

  contains(path: string): boolean {
    if (this.folder === null) return path === this.path;
    return this.folder === '' || path === this.folder || path.startsWith(`${this.folder}/`);
  }

  async load(): Promise<void> {
    this.hasState = await this.persistence.load();
  }

  connect(onStatus: (status: Status) => void): void {
    const { relays, id, secret } = this.invite;
    this.provider = new Provider(this.ydoc, { relays, room: id, secret, rtc: this.rtc }, this.awareness);
    this.provider.onStatus = onStatus;
    this.provider.onPeers = (count) => {
      onStatus(this.status());
      this.onPeers?.(count);
    };
    this.provider.onSynced = this.gotSync;
    // Relay sockets outlive collabs, so some may be open already.
    onStatus(this.status());
  }

  status(): Status {
    return this.provider?.status() ?? { relays: 0, attempts: 0, failures: 0 };
  }

  get peers(): number {
    return this.provider?.peers.length ?? 0;
  }

  setName(name: string): void {
    const user = { name: name || 'Anonymous', color: `hsl(${HUE}, 70%, 40%)`, colorLight: `hsla(${HUE}, 70%, 40%, 0.25)` };
    this.awareness.setLocalStateField('user', user);
  }

  // Everyone else here, and the note each one's cursor is in.
  others(): Peer[] {
    const out: Peer[] = [];
    for (const [client, state] of this.awareness.getStates()) {
      if (client === this.awareness.clientID) continue;
      const { name = 'Anonymous' } = (state.user ?? {}) as Partial<Peer>;
      const head = (state.cursor as { head: unknown } | null | undefined)?.head;
      const type = head ? Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), this.ydoc)?.type : null;
      const doc = [...this.docs.values()].find((doc) => doc.ytext === type);
      out.push({ name, path: doc?.file.path ?? null });
    }
    return out;
  }

  // Whether any relay answered, so others can find us. A sync proves it too.
  // False on timeout or disconnect.
  waitReachable(): Promise<boolean> {
    if (!this.provider) return Promise.resolve(false);
    return Promise.race([this.provider.reachable, this.firstSync, this.closed]);
  }

  describeConnections(): Promise<string[]> {
    return this.provider?.describeConnections() ?? Promise.resolve([]);
  }

  paths(): Promise<string[]> {
    return this.provider?.paths() ?? Promise.resolve([]);
  }

  has(id: string): boolean {
    return getText(this.ydoc, id) !== undefined;
  }

  entries(): [string, DocEntry][] {
    return [...docs(this.ydoc).entries()];
  }

  entryPath(id: string): string | undefined {
    return docs(this.ydoc).get(id)?.get('path') as string | undefined;
  }

  docById(id: string): SharedDoc | undefined {
    for (const doc of this.docs.values()) if (doc.id === id) return doc;
    return undefined;
  }

  // Resolves true once a peer has handed us the doc, false on disconnect
  // first. There is no timeout: nothing can happen until someone who has it
  // is online.
  waitFor(id: string): Promise<boolean> {
    if (this.has(id)) return Promise.resolve(true);
    let stop = () => {};
    const arrived = new Promise<true>((resolve) => {
      stop = observeDocs(this.ydoc, () => {
        if (this.has(id)) resolve(true);
      });
    });
    const done = Promise.race([arrived, this.closed]);
    void done.then(stop);
    return done;
  }

  // Resolves true at the first full sync with any peer, false on disconnect.
  waitSynced(): Promise<boolean> {
    return Promise.race([this.firstSync, this.closed]);
  }

  // Creates the doc from the file. Only sharing does this: a doc seeded by
  // someone without history could win over the real one.
  async seed(file: TFile, id: string, entryPath = file.path): Promise<SharedDoc> {
    const content = await this.app.vault.read(file);
    return this.track(file, new SharedDoc(this.app, file, id, openDoc(this.ydoc, { id, path: entryPath, content }), this.awareness));
  }

  // Binds the file to a doc the collab already has. With saved state the
  // file's offline edits are diffed in; without it the shared text replaces
  // the file.
  async attach(file: TFile, id: string): Promise<SharedDoc> {
    const content = this.hasState ? await this.app.vault.read(file) : null;
    const text = getText(this.ydoc, id);
    if (!text) throw new Error(`collab: no doc ${id}`);
    if (content !== null) applyContent(text, content);
    return this.track(file, new SharedDoc(this.app, file, id, text, this.awareness, !this.hasState));
  }

  private track(file: TFile, doc: SharedDoc): SharedDoc {
    this.docs.set(file.path, doc);
    return doc;
  }

  // Drops the doc from the collab for everyone.
  removeDoc(id: string): void {
    const doc = this.docById(id);
    if (doc) this.unshare(doc.file.path);
    docs(this.ydoc).delete(id);
  }

  setEntryPath(id: string, entryPath: string): void {
    docs(this.ydoc).get(id)?.set('path', entryPath);
  }

  unshare(path: string): SharedDoc | undefined {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.destroy();
    this.docs.delete(path);
    return doc;
  }

  rename(oldPath: string, file: TFile): void {
    if (this.folder === null && this.path === oldPath) this.path = file.path;
    const doc = this.docs.get(oldPath);
    if (!doc) return;
    this.docs.delete(oldPath);
    doc.file = file;
    this.docs.set(file.path, doc);
  }

  rebindAll(): void {
    const open = sourceViews(this.app);
    for (const doc of this.docs.values()) doc.rebind(open);
  }

  async disconnect(): Promise<void> {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.close();
    this.unobserve();
    // The snapshot is taken now, while it matches what the notes last saw.
    await Promise.all([this.provider?.destroy(), this.persistence.stop()]);
    this.provider = null;
    this.ydoc.destroy();
  }

  // A concurrent seed on another peer replaced our entry. Adopt the winner.
  private adoptReplaced(id: string): void {
    const doc = this.docById(id);
    const ytext = getText(this.ydoc, id);
    if (!doc || !ytext || ytext === doc.ytext) return;
    doc.destroy();
    this.docs.set(doc.file.path, new SharedDoc(this.app, doc.file, id, ytext, this.awareness, true));
  }
}
