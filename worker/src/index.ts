// Signalling for obsidian-collab: a minimal Nostr relay for Trystero. EVENT
// fans out to every REQ whose filter matches, nothing is stored, signatures
// are not checked. It never sees connection details or document content:
// the plugin encrypts every message with the session secret before it
// reaches this server.

export interface Env {
  RELAY: DurableObjectNamespace;
  RELAY_TOKEN?: string;
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
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

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === name && values.includes(tag[1] ?? ''))) return false;
  }
  return true;
}

export class Relay implements DurableObject {
  constructor(private state: DurableObjectState) {}

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const subs = ws.deserializeAttachment() as Subscriptions;
    const [type, arg, ...rest] = message as unknown[];
    switch (type) {
      case 'REQ': {
        if (typeof arg !== 'string') return;
        subs[arg] = rest.filter((f): f is Filter => typeof f === 'object' && f !== null);
        ws.serializeAttachment(subs);
        ws.send(JSON.stringify(['EOSE', arg]));
        break;
      }
      case 'CLOSE': {
        if (typeof arg !== 'string') return;
        delete subs[arg];
        ws.serializeAttachment(subs);
        break;
      }
      case 'EVENT': {
        const event = arg as NostrEvent | undefined;
        if (!event || typeof event.id !== 'string' || !Array.isArray(event.tags)) return;
        ws.send(JSON.stringify(['OK', event.id, true, '']));
        for (const peer of this.state.getWebSockets()) {
          const peerSubs = peer.deserializeAttachment() as Subscriptions;
          for (const [subId, filters] of Object.entries(peerSubs)) {
            if (filters.some((f) => matches(f, event))) peer.send(JSON.stringify(['EVENT', subId, event]));
          }
        }
        break;
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  webSocketError(ws: WebSocket): void {
    ws.close();
  }
}
