import { App, Notice, TFile, requestUrl } from 'obsidian';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import { STUN, createProvider, iceUrl } from './network';
import { SharedDoc } from './shared-doc';
import { getText, observeDocs, openDoc } from './sync';

export interface SessionInfo {
  server: string;
  room: string;
  secret: string;
}

// One Y.Doc, one WebRTC room, any number of shared notes keyed by path.
export class Session {
  readonly ydoc = new Y.Doc();
  readonly docs = new Map<string, SharedDoc>();
  provider: WebrtcProvider | null = null;
  private unobserve: () => void;

  constructor(
    private app: App,
    readonly info: SessionInfo,
  ) {
    this.unobserve = observeDocs(this.ydoc, (id) => this.adoptReplaced(id));
  }

  async connect(): Promise<void> {
    this.provider = createProvider(this.ydoc, { ...this.info, iceServers: await fetchIceServers(this.info.server) });
    this.provider.on('peers', ({ webrtcPeers }) => {
      new Notice(`Collab: ${webrtcPeers.length} ${webrtcPeers.length === 1 ? 'peer' : 'peers'} connected`);
    });
  }

  // Resolves true at the first sync with a peer, false on timeout.
  synced(timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.provider?.once('synced', () => resolve(true));
      window.setTimeout(() => resolve(false), timeout);
    });
  }

  has(id: string): boolean {
    return getText(this.ydoc, id) !== undefined;
  }

  // Adopts the doc if the session already has it, seeds it from the note otherwise.
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

  end(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.unobserve();
    // destroy() alone leaves the signaling socket open.
    this.provider?.disconnect();
    this.provider?.destroy();
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

async function fetchIceServers(server: string): Promise<RTCIceServer[]> {
  try {
    const res = await requestUrl({ url: iceUrl(server) });
    const { iceServers } = res.json as { iceServers?: RTCIceServer[] };
    if (iceServers?.length) return iceServers;
  } catch (e) {
    console.warn('collab: /ice unavailable, using STUN only', e);
  }
  return STUN;
}
