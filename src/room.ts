import { App, Notice, TFile } from 'obsidian';
import * as Y from 'yjs';
import { Provider, type Status } from './network';
import { SharedDoc } from './shared-doc';
import { getText, observeDocs, openDoc } from './sync';

export interface RoomInfo {
  room: string;
  secret: string;
  relays: string[];
}

// One Y.Doc, one WebRTC room, any number of shared notes keyed by path.
export class Room {
  readonly ydoc = new Y.Doc();
  readonly docs = new Map<string, SharedDoc>();
  provider: Provider | null = null;
  private unobserve: () => void;

  constructor(
    private app: App,
    readonly info: RoomInfo,
    private iceServers: RTCIceServer[],
  ) {
    this.unobserve = observeDocs(this.ydoc, (id) => this.adoptReplaced(id));
  }

  connect(onStatus?: (status: Status) => void): void {
    this.provider = new Provider(this.ydoc, { ...this.info, iceServers: this.iceServers });
    this.provider.onStatus = onStatus ?? null;
    this.provider.onPeers = (count) => {
      new Notice(`Collab: ${count} ${count === 1 ? 'peer' : 'peers'} connected`);
    };
    // Relay sockets outlive rooms, so some may be open already.
    onStatus?.(this.provider.status());
  }

  status(): Status {
    return this.provider?.status() ?? { relays: 0, peerFound: false, iceFailed: false };
  }

  // Resolves true at the first sync with a peer, false on timeout.
  synced(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.provider?.synced) return resolve(true);
      if (this.provider) this.provider.onSynced = () => resolve(true);
      window.setTimeout(() => resolve(false), timeout);
    });
  }

  has(id: string): boolean {
    return getText(this.ydoc, id) !== undefined;
  }

  // Adopts the doc if the room already has it, seeds it from the note otherwise.
  async share(file: TFile, id: string = crypto.randomUUID()): Promise<SharedDoc> {
    const existing = getText(this.ydoc, id);
    const doc = existing
      ? new SharedDoc(this.app, file, id, existing, true)
      : new SharedDoc(
          this.app,
          file,
          id,
          openDoc(this.ydoc, { id, path: file.path, content: await this.app.vault.read(file) }),
        );
    this.docs.set(file.path, doc);
    return doc;
  }

  unshare(path: string): SharedDoc | undefined {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.destroy();
    this.docs.delete(path);
    return doc;
  }

  rename(oldPath: string, file: TFile): void {
    const doc = this.docs.get(oldPath);
    if (!doc) return;
    this.docs.delete(oldPath);
    doc.file = file;
    this.docs.set(file.path, doc);
  }

  rebindAll(): void {
    for (const doc of this.docs.values()) doc.rebind();
  }

  leave(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.unobserve();
    void this.provider?.destroy();
    this.ydoc.destroy();
  }

  // A concurrent seed on another peer replaced our entry. Adopt the winner.
  private adoptReplaced(id: string): void {
    const doc = [...this.docs.values()].find((d) => d.id === id);
    const ytext = getText(this.ydoc, id);
    if (!doc || !ytext || ytext === doc.ytext) return;
    doc.destroy();
    this.docs.set(doc.file.path, new SharedDoc(this.app, doc.file, id, ytext, true));
  }
}
