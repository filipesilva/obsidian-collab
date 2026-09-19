import { defaultRelayUrls, getRelaySockets, joinRoom, type MessageAction, type Room } from 'trystero';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

export const APP_ID = 'obsidian-collab';
export const RELAY_COUNT = 5;
const RELAY_PROBE_MS = 4000;
const RELAY_CHECK_INTERVAL_MS = 30000;
export const DEFAULT_RELAYS: string[] = defaultRelayUrls;
export const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export interface RoomOptions {
  room: string;
  secret: string;
  relays: string[];
  iceServers?: RTCIceServer[];
}

// Every peer must dial the same relays to meet, so the host picks a few and
// the invite link carries them.
export function pickRelays(relays: string[], count = RELAY_COUNT): string[] {
  const pool = [...relays];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

// Where a connection attempt got to, for progress and failure messages.
export interface Status {
  relays: number;
  peerFound: boolean;
  iceFailed: boolean;
}

// Syncs a Y.Doc with every peer in a Trystero room using the Yjs sync
// protocol: step 1 on join, step 2 in reply, updates as they happen.
export class Provider {
  private room!: Room;
  private sync!: MessageAction<Uint8Array>;
  private peerIds = new Set<string>();
  private peerFound = false;
  private iceFailed = false;
  private destroyed = false;
  private checkTimer: number;
  private rtcConfig: RTCConfiguration;
  synced = false;
  onPeers: ((count: number) => void) | null = null;
  onSynced: (() => void) | null = null;
  onStatus: ((status: Status) => void) | null = null;

  constructor(
    private doc: Y.Doc,
    private opts: RoomOptions,
  ) {
    this.rtcConfig = { iceServers: opts.iceServers ?? [] };
    this.join();
    for (const socket of this.relaySockets()) socket.addEventListener('open', () => this.emitStatus());
    this.checkRelays();
    this.checkTimer = window.setInterval(() => this.checkRelays(), RELAY_CHECK_INTERVAL_MS);
    doc.on('update', this.onUpdate);
  }

  get peers(): string[] {
    return [...this.peerIds];
  }

  status(): Status {
    const relays = this.relaySockets().filter((socket) => socket.readyState === WebSocket.OPEN).length;
    return { relays, peerFound: this.peerFound, iceFailed: this.iceFailed };
  }

  // Relay sockets outlive rooms and can look open while dead, for example
  // after the app was in the background on a phone. Probe each open one
  // with a subscription a live relay answers at once. Close any that stays
  // silent so Trystero reconnects it, then rejoin, because only a fresh
  // join announces at once.
  checkRelays(): void {
    const silent = new Set(this.relaySockets().filter((socket) => socket.readyState === WebSocket.OPEN));
    const probe = `probe-${Math.random().toString(36).slice(2)}`;
    for (const socket of silent) {
      const onMessage = (e: MessageEvent) => {
        if (!String(e.data).includes(probe)) return;
        silent.delete(socket);
        socket.removeEventListener('message', onMessage);
      };
      socket.addEventListener('message', onMessage);
      window.setTimeout(() => socket.removeEventListener('message', onMessage), RELAY_PROBE_MS);
      socket.send(JSON.stringify(['REQ', probe, { kinds: [20000], since: Math.floor(Date.now() / 1000), '#x': [probe] }]));
    }
    window.setTimeout(() => {
      const dead = [...silent].filter((socket) => socket.readyState === WebSocket.OPEN);
      for (const socket of dead) socket.close();
      for (const socket of this.relaySockets()) {
        if (!dead.includes(socket) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', probe]));
      }
      if (dead.length && !this.destroyed) void this.rejoin();
      else this.emitStatus();
    }, RELAY_PROBE_MS);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    window.clearInterval(this.checkTimer);
    this.doc.off('update', this.onUpdate);
    await this.room.leave();
  }

  private join() {
    // Trystero keeps a pool of idle connections, so only ICE moving past
    // 'new' means a real peer answered.
    const onIce = (state: RTCIceConnectionState) => {
      if (state !== 'new') this.peerFound = true;
      if (state === 'failed') this.iceFailed = true;
      this.emitStatus();
    };
    class ObservedPeerConnection extends RTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        this.addEventListener('iceconnectionstatechange', () => onIce(this.iceConnectionState));
      }
    }
    this.room = joinRoom(
      {
        appId: APP_ID,
        password: this.opts.secret,
        relayConfig: { urls: this.opts.relays },
        rtcConfig: this.rtcConfig,
        rtcPolyfill: ObservedPeerConnection,
      },
      this.opts.room,
    );
    this.sync = this.room.makeAction<Uint8Array>('sync');
    this.sync.onMessage = (data, { peerId }) => this.receive(toBytes(data), peerId);
    this.room.onPeerJoin = (peerId) => {
      this.peerIds.add(peerId);
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoder, peerId);
      this.onPeers?.(this.peerIds.size);
    };
    this.room.onPeerLeave = (peerId) => {
      this.peerIds.delete(peerId);
      this.onPeers?.(this.peerIds.size);
    };
  }

  private async rejoin() {
    await this.room.leave();
    // An announce sent while a socket is still reconnecting is deferred a minute.
    for (let i = 0; i < 80 && this.status().relays < this.opts.relays.length; i++) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (this.destroyed) return;
    this.join();
    this.emitStatus();
  }

  private relaySockets(): WebSocket[] {
    const sockets = (getRelaySockets as () => Record<string, WebSocket | undefined>)();
    return this.opts.relays.map((url) => sockets[url]).filter((socket): socket is WebSocket => !!socket);
  }

  private emitStatus() {
    this.onStatus?.(this.status());
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.peerIds.size === 0) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoder);
  };

  private receive(data: Uint8Array, peerId: string) {
    const encoder = encoding.createEncoder();
    const type = syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, this);
    if (encoding.length(encoder) > 0) this.send(encoder, peerId);
    if (type === syncProtocol.messageYjsSyncStep2 && !this.synced) {
      this.synced = true;
      this.onSynced?.();
    }
  }

  private send(encoder: encoding.Encoder, target?: string) {
    void this.sync.send(encoding.toUint8Array(encoder), target ? { target } : undefined);
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('collab: unexpected sync payload');
}
