import { defaultRelayUrls, getRelaySockets, joinRoom, type MessageAction, type Room } from 'trystero';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

export const APP_ID = 'obsidian-collab';
export const RELAY_COUNT = 5;
const RELAY_PROBE_MS = 4000;
const RELAY_CHECK_INTERVAL_MS = 30000;
const ALONE_INTERVAL_MS = 10000;
const PEER_PING_TIMEOUT_MS = 5000;
const REACHABLE_TIMEOUT_MS = 10000;
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
  rtc?: RTCConfiguration;
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
// Trystero keeps a pool of idle connections (3, patched down from 20 in
// patches/, see dmotz/trystero#197), so only ICE moving past 'new' means a
// real peer answered. Counters, so a caller can tell a new attempt or
// failure from an old one.
export interface Status {
  relays: number;
  attempts: number;
  failures: number;
}

// Syncs a Y.Doc with every peer in a Trystero room using the Yjs sync
// protocol: step 1 on join, step 2 in reply, updates as they happen.
export class Provider {
  private room!: Room;
  private sync!: MessageAction<Uint8Array>;
  private peerIds = new Set<string>();
  private attempts = 0;
  private failures = 0;
  // Every peer connection Trystero created and has not closed, pool included.
  private pcs = new Set<RTCPeerConnection>();
  private destroyed = false;
  private resolveReachable!: (ok: boolean) => void;
  // Whether any relay answered. Settled by the first reply, or the timeout.
  readonly reachable: Promise<boolean>;
  private checkTimer = 0;
  private attemptsAtLastTick = 0;
  private rtcConfig: RTCConfiguration;
  synced = false;
  onPeers: ((count: number) => void) | null = null;
  onSynced: (() => void) | null = null;
  onStatus: ((status: Status) => void) | null = null;

  constructor(
    private doc: Y.Doc,
    private opts: RoomOptions,
  ) {
    this.rtcConfig = opts.rtc ?? { iceServers: [] };
    this.reachable = new Promise((resolve) => (this.resolveReachable = resolve));
    window.setTimeout(() => this.resolveReachable(false), REACHABLE_TIMEOUT_MS);
    this.join();
    // Probe each relay as it opens, then every so often.
    for (const socket of this.relaySockets()) {
      if (socket.readyState === WebSocket.OPEN) void this.probe(socket);
      else {
        socket.addEventListener('open', () => {
          this.emitStatus();
          void this.probe(socket);
        });
      }
    }
    this.schedule();
    doc.on('update', this.onUpdate);
  }

  // Trystero's active peers, the ones a send reaches. `peerIds` is what we
  // saw join and not leave, which can differ: see checkPeers.
  get peers(): string[] {
    return Object.keys(this.room.getPeers());
  }

  // One line per Trystero peer connection that has a remote, then a summary
  // of every connection it holds, pool included, for diagnostics.
  async describeConnections(): Promise<string[]> {
    const out: string[] = [];
    const states = new Map<string, number>();
    const local = new Map<string, number>();
    let withRelay = 0;
    // close() fires no event, so drop closed ones here.
    for (const pc of this.pcs) if (pc.connectionState === 'closed') this.pcs.delete(pc);
    for (const pc of this.pcs) {
      const key = `${pc.signalingState}/${pc.iceGatheringState}/${pc.iceConnectionState}`;
      states.set(key, (states.get(key) ?? 0) + 1);
      const stats = await pc.getStats();
      let relay = false;
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type !== 'local-candidate') return;
        const type = String(report.candidateType);
        local.set(type, (local.get(type) ?? 0) + 1);
        if (type === 'relay') relay = true;
      });
      if (relay) withRelay++;
    }
    out.push(
      `pool ${this.pcs.size} connections, ${withRelay} with a relay candidate, local candidates ${[...local].map(([t, n]) => `${t}:${n}`).join(',') || 'none'}, states ${[...states].map(([k, n]) => `${k}:${n}`).join(' ')}`,
    );
    for (const [id, pc] of Object.entries(this.room.getPeers())) {
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((report: Record<string, unknown>) => byId.set(String(report.id), report));
      const pairs: string[] = [];
      const local = new Map<string, number>();
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type === 'local-candidate') {
          const type = String(report.candidateType);
          local.set(type, (local.get(type) ?? 0) + 1);
        }
        if (report.type !== 'candidate-pair') return;
        const l = byId.get(String(report.localCandidateId));
        const r = byId.get(String(report.remoteCandidateId));
        pairs.push(`${String(l?.candidateType)}>${String(r?.candidateType)}=${String(report.state)}${report.nominated ? '*' : ''}`);
      });
      out.push(
        `peer ${id.slice(0, 6)} ice=${pc.iceConnectionState} conn=${pc.connectionState} local=${[...local].map(([t, n]) => `${t}:${n}`).join(',')} pairs=${pairs.join(' ')}`,
      );
    }
    return out;
  }

  // 'direct' or 'relay' per connected peer, from the selected candidate pair.
  async paths(): Promise<string[]> {
    const out: string[] = [];
    for (const pc of Object.values(this.room.getPeers())) {
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((report: Record<string, unknown>) => byId.set(String(report.id), report));
      let path = 'connecting';
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) return;
        const local = byId.get(String(report.localCandidateId));
        const remote = byId.get(String(report.remoteCandidateId));
        path = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
      });
      out.push(path);
    }
    return out;
  }

  status(): Status {
    const relays = this.relaySockets().filter((socket) => socket.readyState === WebSocket.OPEN).length;
    return { relays, attempts: this.attempts, failures: this.failures };
  }

  // Relay sockets outlive rooms and can look open while dead, for example
  // after the app was in the background on a phone. Probe each open one
  // with a subscription a live relay answers at once. Close any that stays
  // silent so Trystero reconnects it, then rejoin, because only a fresh
  // join announces at once.
  // Closing a dead socket makes Trystero reconnect it. Only a fresh join
  // announces at once, but rejoining drops every peer, so that happens
  // only while there is nobody to lose.
  checkRelays(): void {
    const open = this.relaySockets().filter((socket) => socket.readyState === WebSocket.OPEN);
    void Promise.all(open.map((socket) => this.probe(socket))).then((alive) => {
      const dead = open.filter((socket, i) => !alive[i] && socket.readyState === WebSocket.OPEN);
      for (const socket of dead) socket.close();
      if (dead.length && !this.destroyed && !this.peers.length) void this.rejoin();
      else this.emitStatus();
    });
  }

  // The periodic upkeep, sooner while alone. Alone with nothing in
  // progress, a rejoin costs nothing and announces again, which covers an
  // announce a relay lost or a handshake that missed: Trystero's own next
  // announce is a minute away.
  private schedule() {
    this.checkTimer = window.setTimeout(() => void this.tick(), this.peers.length ? RELAY_CHECK_INTERVAL_MS : ALONE_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (this.destroyed) return;
    const { attempts } = this.status();
    const idle = !this.peers.length && !this.peerIds.size && attempts === this.attemptsAtLastTick;
    this.attemptsAtLastTick = attempts;
    if (idle) await this.rejoin();
    else {
      this.checkRelays();
      await this.checkPeers();
    }
    if (!this.destroyed) this.schedule();
  }

  // When Trystero replaces a peer's connection it drops the old one without
  // a leave event, and if the new one never completes, that side keeps
  // believing it is connected and ignores the peer's announces. A peer we
  // saw join that Trystero no longer lists is that state, as is a listed
  // peer that stops answering pings. Rejoining renegotiates everything.
  async checkPeers(): Promise<void> {
    if (this.destroyed || !this.peerIds.size) return;
    const active = new Set(this.peers);
    if ([...this.peerIds].some((id) => !active.has(id))) {
      console.warn('collab: a peer vanished without leaving, rejoining');
      this.peerIds.clear();
      this.onPeers?.(0);
      await this.rejoin();
      return;
    }
    const ping = (id: string) => {
      try {
        return this.room.ping(id).then(() => true, () => false);
      } catch {
        // Trystero throws synchronously when it no longer knows the peer.
        return Promise.resolve(false);
      }
    };
    const answers = await Promise.all(
      this.peers.map((id) =>
        Promise.race([ping(id), new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), PEER_PING_TIMEOUT_MS))]),
      ),
    );
    if (this.destroyed || answers.every(Boolean)) return;
    console.warn('collab: a peer stopped answering, rejoining');
    await this.rejoin();
  }

  // Whether the relay behind an open socket says anything after a
  // subscription. Relays answer in different ways; a dead one is silent.
  private probe(socket: WebSocket): Promise<boolean> {
    const id = `probe-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        if (ok) {
          this.resolveReachable(true);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', id]));
        }
        resolve(ok);
      };
      const onMessage = () => done(true);
      const timer = window.setTimeout(() => done(false), RELAY_PROBE_MS);
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify(['REQ', id, { kinds: [20000], since: Math.floor(Date.now() / 1000), '#x': [id] }]));
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    window.clearTimeout(this.checkTimer);
    this.doc.off('update', this.onUpdate);
    await this.room.leave().catch(() => {});
  }

  private join() {
    // WebKit can go straight from 'new' to 'connected', so the first state
    // past 'new' is the attempt, counted once per connection.
    const onIce = (pc: RTCPeerConnection, state: RTCIceConnectionState) => {
      if (state !== 'new' && state !== 'closed' && !attempted.has(pc)) {
        attempted.add(pc);
        this.attempts++;
      }
      if (state === 'failed') this.failures++;
      this.emitStatus();
    };
    const attempted = new WeakSet<RTCPeerConnection>();
    const pcs = this.pcs;
    class ObservedPeerConnection extends RTCPeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        pcs.add(this);
        this.addEventListener('connectionstatechange', () => {
          if (this.connectionState === 'closed') pcs.delete(this);
        });
        this.addEventListener('iceconnectionstatechange', () => onIce(this, this.iceConnectionState));
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
    this.peerIds.clear();
    // Trystero's leave can reject on a channel that already closed
    // (dmotz/trystero#195). The room is gone either way.
    await this.room.leave().catch(() => {});
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

  // Every update goes to every peer, including ones received from a peer,
  // which then skip their sender. Peers are meant to form a full mesh, but
  // when a link is missing this keeps everyone in sync. Yjs ignores
  // updates it already has, so the duplicates cost only bytes.
  private onUpdate = (update: Uint8Array, origin: unknown) => {
    const from = origin instanceof Received && origin.provider === this ? origin.from : null;
    const targets = this.peers.filter((id) => id !== from);
    if (!targets.length) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    void this.sync.send(encoding.toUint8Array(encoder), { target: targets });
  };

  private receive(data: Uint8Array, peerId: string) {
    const encoder = encoding.createEncoder();
    const type = syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, new Received(this, peerId));
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

// The origin of updates applied from a peer.
class Received {
  constructor(
    readonly provider: Provider,
    readonly from: string,
  ) {}
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('collab: unexpected sync payload');
}
