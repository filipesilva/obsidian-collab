// Signalling for obsidian-collab: a minimal Nostr relay for Trystero. EVENT
// fans out to every REQ whose filter matches, only ephemeral kinds are
// accepted, nothing is stored, signatures are not checked. It never sees
// connection details or document content: the plugin encrypts every message
// with the session secret before it reaches this server.

export interface Env {
  RELAY: DurableObjectNamespace;
  RELAY_TOKEN?: string;
}

const MAX_MESSAGE = 65536;

// NIP-11: how a relay describes itself to clients and relay directories.
const INFO = {
  name: 'obsidian-collab signalling',
  description: 'Forwards ephemeral events to live subscribers and stores nothing. Made for WebRTC signalling with Trystero.',
  software: 'https://github.com/filipesilva/obsidian-collab',
  supported_nips: [1, 11],
  limitation: { max_message_length: MAX_MESSAGE, auth_required: false, payment_required: false, restricted_writes: true },
};

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (request.headers.get('Accept')?.includes('application/nostr+json')) {
        return new Response(JSON.stringify(INFO), {
          headers: { 'Content-Type': 'application/nostr+json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response('obsidian-collab signalling server', { status: 200 });
    }
    const { pathname } = new URL(request.url);
    if (env.RELAY_TOKEN && pathname !== `/${env.RELAY_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    // One object per path serves every room on it, because clients connect
    // before saying which topics they want. Different paths never meet.
    return env.RELAY.get(env.RELAY.idFromName(pathname)).fetch(request);
  },
};

interface NostrEvent {
  id: string;
  kind: number;
  tags: string[][];
  content: string;
}

interface Filter {
  kinds?: number[];
  [tag: `#${string}`]: string[] | undefined;
}

type Subscriptions = Record<string, Filter[]>;

interface Sub {
  ws: WebSocket;
  id: string;
  filters: Filter[];
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1] ?? ''))) return false;
  }
  return true;
}

// The index keys of the first tag a filter needs, or null when it needs none.
function tagKeys(filter: Filter): string[] | null {
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) return values.map((value) => `${key.slice(1)}:${value}`);
  }
  return null;
}

// Subscriptions are indexed by the tag values they need, so an event only
// checks the ones that could match, not every socket on the path. The
// socket attachments hold them through hibernation; the index is rebuilt
// from those on wake.
export class Relay implements DurableObject {
  private byTag = new Map<string, Set<Sub>>();
  private untagged = new Set<Sub>();
  private subs = new Map<WebSocket, Map<string, Sub>>();

  constructor(private state: DurableObjectState) {
    for (const ws of state.getWebSockets()) {
      for (const [id, filters] of Object.entries(ws.deserializeAttachment() as Subscriptions)) this.add(ws, id, filters);
    }
  }

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    if (raw.length > MAX_MESSAGE) {
      ws.send(JSON.stringify(['NOTICE', `invalid: message over ${MAX_MESSAGE} characters`]));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, arg, ...rest] = message as unknown[];
    switch (type) {
      case 'REQ': {
        if (typeof arg !== 'string') return;
        const subs = ws.deserializeAttachment() as Subscriptions;
        const filters = rest.filter((f): f is Filter => typeof f === 'object' && f !== null);
        subs[arg] = filters;
        ws.serializeAttachment(subs);
        this.add(ws, arg, filters);
        ws.send(JSON.stringify(['EOSE', arg]));
        break;
      }
      case 'CLOSE': {
        if (typeof arg !== 'string') return;
        const subs = ws.deserializeAttachment() as Subscriptions;
        delete subs[arg];
        ws.serializeAttachment(subs);
        this.remove(ws, arg);
        break;
      }
      case 'EVENT': {
        const event = arg as NostrEvent | undefined;
        if (!event || typeof event.id !== 'string' || !Array.isArray(event.tags)) return;
        if (typeof event.kind !== 'number' || event.kind < 20000 || event.kind >= 30000) {
          ws.send(JSON.stringify(['OK', event.id, false, 'blocked: only ephemeral events, kinds 20000 to 29999']));
          return;
        }
        ws.send(JSON.stringify(['OK', event.id, true, '']));
        const candidates = new Set(this.untagged);
        for (const tag of event.tags) {
          if (!Array.isArray(tag)) continue;
          for (const sub of this.byTag.get(`${tag[0]}:${tag[1]}`) ?? []) candidates.add(sub);
        }
        for (const sub of candidates) {
          if (!sub.filters.some((f) => matches(f, event))) continue;
          try {
            sub.ws.send(JSON.stringify(['EVENT', sub.id, event]));
          } catch {
            this.drop(sub.ws);
          }
        }
        break;
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.drop(ws);
    ws.close();
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws);
    ws.close();
  }

  private add(ws: WebSocket, id: string, filters: Filter[]) {
    this.remove(ws, id);
    const sub = { ws, id, filters };
    let own = this.subs.get(ws);
    if (!own) this.subs.set(ws, (own = new Map<string, Sub>()));
    own.set(id, sub);
    for (const filter of filters) {
      const keys = tagKeys(filter);
      if (!keys) this.untagged.add(sub);
      else {
        for (const key of keys) {
          let set = this.byTag.get(key);
          if (!set) this.byTag.set(key, (set = new Set()));
          set.add(sub);
        }
      }
    }
  }

  private remove(ws: WebSocket, id: string) {
    const own = this.subs.get(ws);
    const sub = own?.get(id);
    if (!own || !sub) return;
    own.delete(id);
    this.untagged.delete(sub);
    for (const filter of sub.filters) {
      for (const key of tagKeys(filter) ?? []) {
        const set = this.byTag.get(key);
        set?.delete(sub);
        if (set?.size === 0) this.byTag.delete(key);
      }
    }
  }

  private drop(ws: WebSocket) {
    for (const id of [...(this.subs.get(ws)?.keys() ?? [])]) this.remove(ws, id);
    this.subs.delete(ws);
  }
}
