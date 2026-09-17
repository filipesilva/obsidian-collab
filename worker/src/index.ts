// Signaling for obsidian-collab. One Durable Object per room forwards opaque
// messages between the peers in it, using the y-webrtc signaling protocol.
// It never sees document content: y-webrtc encrypts every message with the
// session secret before it reaches this server.

export interface Env {
  ROOMS: DurableObjectNamespace;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}

const STUN = { urls: ['stun:stun.cloudflare.com:3478'] };
const TURN_TTL = 7200;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket', { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    if (url.pathname === '/ice') return ice(env);
    return new Response('obsidian-collab signaling server', { status: 200 });
  },
};

let iceCache: { body: string; expires: number } | null = null;

async function ice(env: Env): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return new Response(JSON.stringify({ iceServers: [STUN] }), { headers });
  }
  if (!iceCache || iceCache.expires < Date.now()) {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL }),
      },
    );
    if (!res.ok) return new Response(JSON.stringify({ iceServers: [STUN] }), { headers });
    // Cloudflare returns the STUN entry alongside the TURN one.
    iceCache = { body: await res.text(), expires: Date.now() + (TURN_TTL / 2) * 1000 };
  }
  return new Response(iceCache.body, { headers });
}

interface Message {
  type: string;
  topic?: string;
  topics?: string[];
  clients?: number;
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment([]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let message: Message;
    try {
      message = JSON.parse(raw) as Message;
    } catch {
      return;
    }
    const topics = new Set(ws.deserializeAttachment() as string[]);
    switch (message.type) {
      case 'subscribe':
        for (const topic of message.topics ?? []) topics.add(topic);
        ws.serializeAttachment([...topics]);
        break;
      case 'unsubscribe':
        for (const topic of message.topics ?? []) topics.delete(topic);
        ws.serializeAttachment([...topics]);
        break;
      case 'publish': {
        if (!message.topic) return;
        const receivers = this.state
          .getWebSockets()
          .filter((peer) => (peer.deserializeAttachment() as string[]).includes(message.topic!));
        message.clients = receivers.length;
        const out = JSON.stringify(message);
        for (const peer of receivers) peer.send(out);
        break;
      }
      case 'ping':
        ws.send('{"type":"pong"}');
        break;
    }
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  webSocketError(ws: WebSocket): void {
    ws.close();
  }
}
