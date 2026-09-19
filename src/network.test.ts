/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest';
import { getRelaySockets } from 'trystero';
import * as Y from 'yjs';
import { DEFAULT_RELAYS, Provider, RELAY_COUNT, pickRelays } from './network';

// The test worker serves one isolated relay per path.
const RELAY = 'ws://localhost:8788';
const LOCAL_RELAYS = [RELAY];
// The test setup also runs a STUN and TURN server, credentials collab/collab.
const LOCAL_TURN: RTCIceServer = { urls: 'turn:127.0.0.1:3479', username: 'collab', credential: 'collab' };

interface PeerMessage {
  type: 'ready' | 'peers' | 'text';
  count?: number;
  data?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);
}

// A peer in an iframe. Messages are matched by source, so several can run.
class Peer {
  private iframe: HTMLIFrameElement;
  private listeners = new Set<(m: PeerMessage) => void>();
  peers = 0;
  text = '';

  constructor(config: { room: string; secret: string; relays: string[] }) {
    this.iframe = document.createElement('iframe');
    const { room, secret, relays } = config;
    this.iframe.srcdoc = `<script>window.config = ${JSON.stringify({ room, secret, relays })}</script>
<script type="module" src="/src/test/peer.ts"></script>`;
    window.addEventListener('message', this.onMessage);
    document.body.appendChild(this.iframe);
  }

  private onMessage = (e: MessageEvent<PeerMessage>) => {
    if (e.source !== this.iframe.contentWindow) return;
    if (e.data.type === 'peers') this.peers = e.data.count ?? 0;
    if (e.data.type === 'text') this.text = e.data.data ?? '';
    for (const listener of this.listeners) listener(e.data);
  };

  wait(test: (m: PeerMessage) => boolean, ms: number, what: string): Promise<PeerMessage> {
    return withTimeout(
      new Promise((resolve) => {
        const listener = (m: PeerMessage) => {
          if (!test(m)) return;
          this.listeners.delete(listener);
          resolve(m);
        };
        this.listeners.add(listener);
      }),
      ms,
      what,
    );
  }

  waitText(test: (text: string) => boolean, ms = 20000): Promise<string> {
    if (test(this.text)) return Promise.resolve(this.text);
    return this.wait((m) => m.type === 'text' && test(m.data ?? ''), ms, `peer text never matched, last: ${JSON.stringify(this.text)}`).then((m) => m.data ?? '');
  }

  waitPeers(count: number, ms = 20000): Promise<void> {
    if (this.peers === count) return Promise.resolve();
    return this.wait((m) => m.type === 'peers' && m.count === count, ms, `peer never had ${count} peers, has ${this.peers}`).then(() => undefined);
  }

  insert(data: string) {
    this.iframe.contentWindow?.postMessage({ type: 'insert', data }, '*');
  }

  async leave() {
    this.iframe.contentWindow?.postMessage({ type: 'leave' }, '*');
    await new Promise((r) => setTimeout(r, 500));
    window.removeEventListener('message', this.onMessage);
    this.iframe.remove();
  }
}

function newConfig(relays: string[]) {
  return { room: crypto.randomUUID(), secret: crypto.randomUUID(), relays };
}

// The page's own peer: a Provider on a doc that starts with 'hello'. The
// iframe peers get the same config, minus the rtc part.
function local(config: { room: string; secret: string; relays: string[]; rtc?: RTCConfiguration }) {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, 'hello');
  const provider = new Provider(doc, config);
  const gone = new Promise<void>((resolve) => {
    provider.onPeers = (n) => {
      if (n === 0) resolve();
    };
  });
  const waitText = (test: (t: string) => boolean, ms = 20000) =>
    withTimeout(
      new Promise<string>((resolve) => {
        if (test(text.toString())) return resolve(text.toString());
        text.observe(() => {
          if (test(text.toString())) resolve(text.toString());
        });
      }),
      ms,
      `local text never matched, last: ${JSON.stringify(text.toString())}`,
    );
  return { doc, text, provider, gone, waitText };
}

async function syncWithPeer(relays: string[], sabotage: (provider: Provider) => Promise<void> = async () => {}) {
  const config = newConfig(relays);
  const me = local(config);
  await sabotage(me.provider);
  const peer = new Peer(config);
  try {
    expect(await peer.waitText((t) => t === 'hello')).toBe('hello');
    expect(me.provider.peers).toHaveLength(1);
    // Public relays come and go; one open relay is enough to meet on.
    const { relays: open, failures } = me.provider.status();
    expect(open).toBeGreaterThanOrEqual(1);
    expect(open).toBeLessThanOrEqual(relays.length);
    expect(failures).toBe(0);
    expect(me.provider.status().attempts).toBeGreaterThan(0);
    expect(await me.provider.reachable).toBe(true);
    peer.insert(' world');
    expect(await me.waitText((t) => t === 'hello world')).toBe('hello world');
  } finally {
    await peer.leave();
    await withTimeout(me.gone, 5000, 'peer never left').catch(() => {});
    await me.provider.destroy();
  }
  return me.provider;
}

describe('browser runtime', () => {
  it('has no Node globals, like Obsidian mobile', () => {
    expect(typeof Buffer).toBe('undefined');
    expect(typeof process).toBe('undefined');
    expect(typeof require).toBe('undefined');
  });

  it('has the web APIs trystero needs', () => {
    expect(typeof RTCPeerConnection).toBe('function');
    expect(typeof WebSocket).toBe('function');
    expect(typeof crypto.subtle).toBe('object');
  });
});

describe('pickRelays', () => {
  it('samples a few of the defaults', () => {
    const picked = pickRelays(DEFAULT_RELAYS);
    expect(picked).toHaveLength(RELAY_COUNT);
    expect(new Set(picked).size).toBe(RELAY_COUNT);
    for (const url of picked) expect(DEFAULT_RELAYS).toContain(url);
  });

  it('keeps a short list whole', () => {
    expect(pickRelays(['ws://a'])).toEqual(['ws://a']);
  });
});

describe('Provider', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is not reachable when no relay answers', { timeout: 15000 }, async () => {
    const provider = new Provider(new Y.Doc(), { room: 'r', secret: 's', relays: ['ws://localhost:1'] });
    expect(await provider.reachable).toBe(false);
    await provider.destroy();
  });

  it('syncs a doc with a peer through the local worker', { timeout: 40000 }, async () => {
    await syncWithPeer(LOCAL_RELAYS);
  });

  it('leaves a healthy relay socket alone when checked', { timeout: 40000 }, async () => {
    const sockets = getRelaySockets as () => Record<string, WebSocket>;
    await syncWithPeer(LOCAL_RELAYS, async (provider) => {
      const socket = sockets()[RELAY]!;
      while (socket.readyState !== WebSocket.OPEN) await new Promise((r) => setTimeout(r, 20));
      provider.checkRelays();
      await new Promise((r) => setTimeout(r, 4500));
      expect(sockets()[RELAY]).toBe(socket);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it('recovers from a relay socket that looks open but is dead', { timeout: 40000 }, async () => {
    const sockets = getRelaySockets as () => Record<string, WebSocket>;
    // Record the subscriptions Trystero opens, so the zombie can drop them:
    // a dead socket neither sends nor receives anything.
    const subs = new Map<WebSocket, string[]>();
    type Send = (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) => void;
    const send = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'send')!.value as Send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      if (typeof data === 'string') {
        const parsed = JSON.parse(data) as unknown[];
        if (parsed[0] === 'REQ') subs.set(this, [...(subs.get(this) ?? []), String(parsed[1])]);
      }
      send.call(this, data);
    };
    let zombie: WebSocket;
    try {
      await syncWithPeer(LOCAL_RELAYS, async (provider) => {
        zombie = sockets()[RELAY]!;
        while (zombie.readyState !== WebSocket.OPEN) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 200));
        for (const id of subs.get(zombie) ?? []) send.call(zombie, JSON.stringify(['CLOSE', id]));
        zombie.send = () => {};
        zombie.onmessage = null;
        provider.checkRelays();
      });
    } finally {
      WebSocket.prototype.send = send;
    }
    expect(zombie!.readyState).toBe(WebSocket.CLOSED);
    expect(sockets()[RELAY]).not.toBe(zombie!);
  });

  it.runIf(import.meta.env.VITE_ONLINE)('syncs through public nostr relays', { timeout: 60000 }, async () => {
    await syncWithPeer(pickRelays(DEFAULT_RELAYS));
  });
});

describe('the mesh', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('converges with three peers and edits from each', { timeout: 60000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    const b = new Peer(config);
    const c = new Peer(config);
    try {
      await Promise.all([b.waitText((t) => t === 'hello'), c.waitText((t) => t === 'hello')]);
      await Promise.all([b.waitPeers(2), c.waitPeers(2)]);
      expect(me.provider.peers).toHaveLength(2);
      b.insert(' b');
      await me.waitText((t) => t.endsWith(' b'));
      await c.waitText((t) => t.endsWith(' b'));
      c.insert(' c');
      me.text.insert(me.text.length, ' a');
      const done = (t: string) => t.includes(' b') && t.includes(' c') && t.includes(' a');
      const [mine, bs, cs] = await Promise.all([me.waitText(done), b.waitText(done), c.waitText(done)]);
      expect(bs).toBe(mine);
      expect(cs).toBe(mine);
    } finally {
      await b.leave();
      await c.leave();
      await me.provider.destroy();
    }
  });

  it('survives the peer check without rejoining', { timeout: 40000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    const peer = new Peer(config);
    try {
      await peer.waitText((t) => t === 'hello');
      const before = me.provider.status().attempts;
      await me.provider.checkPeers();
      expect(me.provider.status().attempts).toBe(before);
      expect(me.provider.peers).toHaveLength(1);
      peer.insert('!');
      await me.waitText((t) => t === 'hello!');
    } finally {
      await peer.leave();
      await me.provider.destroy();
    }
  });

  // A peer that shares no relay with another can never signal it, so the
  // two are linked only through a peer on both relays.
  it('forwards updates across a missing link', { timeout: 60000 }, async () => {
    const room = crypto.randomUUID();
    const secret = crypto.randomUUID();
    const me = local({ room, secret, relays: [`${RELAY}/one`] });
    const bridge = new Peer({ room, secret, relays: [`${RELAY}/one`, `${RELAY}/two`] });
    const far = new Peer({ room, secret, relays: [`${RELAY}/two`] });
    try {
      await bridge.waitText((t) => t === 'hello');
      await far.waitText((t) => t === 'hello');
      await bridge.waitPeers(2);
      expect(me.provider.peers).toHaveLength(1);
      expect(far.peers).toBe(1);
      far.insert(' from far');
      await me.waitText((t) => t.endsWith(' from far'));
      me.text.insert(me.text.length, ' from me');
      await far.waitText((t) => t.endsWith(' from me'));
      expect(far.text).toBe(me.text.toString());
    } finally {
      await far.leave();
      await bridge.leave();
      await me.provider.destroy();
    }
  });
});

describe('TURN', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // The page's peer may only use relay candidates, as with Always relay on
  // a strict network. The other peer needs nothing: it reaches the relay.
  it('syncs through the relay when direct paths are not allowed', { timeout: 60000 }, async () => {
    const config = { ...newConfig(LOCAL_RELAYS), rtc: { iceServers: [LOCAL_TURN], iceTransportPolicy: 'relay' as const } };
    const me = local(config);
    const peer = new Peer(config);
    try {
      await peer.waitText((t) => t === 'hello');
      expect(await me.provider.paths()).toEqual(['relay']);
      const lines = await me.provider.describeConnections();
      expect(lines.find((l) => l.startsWith('peer '))).toContain('relay>');
      // Three spare pooled offers, refilled after the live one was taken.
      expect(lines.find((l) => l.startsWith('pool '))).toMatch(/have-local-offer\/\w+\/new:3/);
      peer.insert(' via relay');
      await me.waitText((t) => t === 'hello via relay');
    } finally {
      await peer.leave();
      await me.provider.destroy();
    }
  });

  it('reports direct when nothing forces the relay', { timeout: 40000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    const peer = new Peer(config);
    try {
      await peer.waitText((t) => t === 'hello');
      expect(await me.provider.paths()).toEqual(['direct']);
    } finally {
      await peer.leave();
      await me.provider.destroy();
    }
  });
});

describe('rejoining', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // Alone, the provider rejoins every 10 s to announce again. A peer that
  // arrives after that must still connect, and a connected pair must not
  // be disturbed by the cycle.
  it('is still joinable after a lone rejoin cycle', { timeout: 80000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    try {
      await new Promise((r) => setTimeout(r, 35000));
      const peer = new Peer(config);
      try {
        await peer.waitText((t) => t === 'hello', 20000);
        peer.insert('!');
        await me.waitText((t) => t === 'hello!');
      } finally {
        await peer.leave();
      }
    } finally {
      await me.provider.destroy();
    }
  });

  it('keeps a pair connected across a cycle', { timeout: 80000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    const peer = new Peer(config);
    try {
      await peer.waitText((t) => t === 'hello');
      const attempts = me.provider.status().attempts;
      await new Promise((r) => setTimeout(r, 35000));
      expect(me.provider.peers).toHaveLength(1);
      expect(me.provider.status().attempts).toBe(attempts);
      peer.insert('!');
      await me.waitText((t) => t === 'hello!');
    } finally {
      await peer.leave();
      await me.provider.destroy();
    }
  });

  // Leaving and coming back to the same room from the same page, the way a
  // disconnect and connect does, must find the peer again about as fast as
  // a first join.
  it('finds the peer again quickly after leaving and rejoining', { timeout: 60000 }, async () => {
    const config = newConfig(LOCAL_RELAYS);
    const me = local(config);
    const peer = new Peer(config);
    try {
      await peer.waitText((t) => t === 'hello');
      await me.provider.destroy();
      await peer.waitPeers(0);
      const again = new Provider(me.doc, config);
      try {
        await withTimeout(
          new Promise<void>((resolve) => (again.onPeers = (n) => n === 1 && resolve())),
          15000,
          'peer not found again within 15s',
        );
        peer.insert('!');
        await me.waitText((t) => t === 'hello!');
      } finally {
        await again.destroy();
      }
    } finally {
      await peer.leave();
    }
  });
});
