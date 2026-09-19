/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getRelaySockets } from 'trystero';
import { DEFAULT_RELAYS, Provider, RELAY_COUNT, pickRelays } from './network';

const LOCAL_RELAYS = ['ws://localhost:8788'];

interface PeerMessage {
  type: 'peers' | 'text';
  count?: number;
  data?: string;
}

function spawnPeer(config: { room: string; secret: string; relays: string[] }): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.srcdoc = `<script>window.config = ${JSON.stringify(config)}</script>
<script type="module" src="/src/test/peer.ts"></script>`;
  document.body.appendChild(iframe);
  return iframe;
}

function fromPeer(type: PeerMessage['type'], test: (m: PeerMessage) => boolean = () => true): Promise<PeerMessage> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent<PeerMessage>) => {
      if (e.data.type !== type || !test(e.data)) return;
      window.removeEventListener('message', onMessage);
      resolve(e.data);
    };
    window.addEventListener('message', onMessage);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);
}

async function syncWithPeer(relays: string[], sabotage: (provider: Provider) => Promise<void> = async () => {}) {
  const config = { room: crypto.randomUUID(), secret: crypto.randomUUID(), relays };
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, 'hello');
  const provider = new Provider(doc, config);
  const synced = new Promise<void>((resolve) => (provider.onSynced = resolve));
  const events: string[] = [];
  const gone = new Promise<void>((resolve) => {
    provider.onPeers = (n) => {
      events.push(`peers=${n}@${Date.now() % 100000}`);
      if (n === 0) resolve();
    };
  });
  await sabotage(provider);
  const iframe = spawnPeer(config);
  try {
    const peerText = fromPeer('text', (m) => m.data === 'hello');
    expect((await withTimeout(peerText, 20000, 'peer never received the text')).data).toBe('hello');
    await withTimeout(synced, 5000, 'never synced');
    expect(provider.peers).toHaveLength(1);
    expect(events).toEqual([expect.stringMatching(/^peers=1@/)]);
    expect(provider.status()).toEqual({ relays: relays.length, peerFound: true, iceFailed: false });

    const grown = new Promise<void>((resolve) => text.observe(() => resolve()));
    iframe.contentWindow?.postMessage({ type: 'insert', data: ' world' }, '*');
    await withTimeout(grown, 5000, 'peer edit never arrived');
    expect(text.toString()).toBe('hello world');
  } catch (error) {
    // Report the real failure, not a teardown failure it caused.
    await teardown().catch(() => {});
    throw error;
  }
  await teardown();
  return provider;

  async function teardown() {
    iframe.contentWindow?.postMessage({ type: 'leave' }, '*');
    await withTimeout(gone, 5000, 'peer never left');
    await provider.destroy();
    iframe.remove();
  }
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

  it('syncs a doc with a peer through the local worker', { timeout: 40000 }, async () => {
    await syncWithPeer(LOCAL_RELAYS);
  });

  it('leaves a healthy relay socket alone when checked', { timeout: 40000 }, async () => {
    const sockets = getRelaySockets as () => Record<string, WebSocket>;
    await syncWithPeer(LOCAL_RELAYS, async (provider) => {
      const socket = sockets()[LOCAL_RELAYS[0]!]!;
      while (socket.readyState !== WebSocket.OPEN) await new Promise((r) => setTimeout(r, 20));
      provider.checkRelays();
      await new Promise((r) => setTimeout(r, 4500));
      expect(sockets()[LOCAL_RELAYS[0]!]).toBe(socket);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it('recovers from a relay socket that looks open but is dead', { timeout: 40000 }, async () => {
    // Trystero reuses the socket from the previous test. Make it swallow
    // everything, like a socket iOS cut while the app was in the background.
    const sockets = getRelaySockets as () => Record<string, WebSocket>;
    let zombie: WebSocket;
    await syncWithPeer(LOCAL_RELAYS, async (provider) => {
      zombie = sockets()[LOCAL_RELAYS[0]!]!;
      while (zombie.readyState !== WebSocket.OPEN) await new Promise((r) => setTimeout(r, 20));
      zombie.send = () => {};
      zombie.onmessage = null;
      provider.checkRelays();
    });
    expect(zombie!.readyState).toBe(WebSocket.CLOSED);
    expect(sockets()[LOCAL_RELAYS[0]!]).not.toBe(zombie!);
  });

  it.runIf(import.meta.env.VITE_ONLINE)('syncs through public nostr relays', { timeout: 60000 }, async () => {
    await syncWithPeer(pickRelays(DEFAULT_RELAYS));
  });
});
