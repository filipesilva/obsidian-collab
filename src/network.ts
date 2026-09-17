import { WebrtcProvider } from 'y-webrtc';
import type * as Y from 'yjs';

export interface RoomOptions {
  server: string;
  room: string;
  secret: string;
  iceServers?: RTCIceServer[];
}

export const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

export function createProvider(doc: Y.Doc, opts: RoomOptions): WebrtcProvider {
  return new WebrtcProvider(opts.room, doc, {
    signaling: [`${opts.server}/room/${opts.room}`],
    password: opts.secret,
    filterBcConns: false,
    peerOpts: { config: { iceServers: opts.iceServers ?? STUN } },
  });
}

// The signaling server also mints ICE credentials at /ice over https.
export function iceUrl(server: string): string {
  return `${server.replace(/^ws/, 'http')}/ice`;
}
