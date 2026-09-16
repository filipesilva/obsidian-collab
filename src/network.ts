import { WebrtcProvider } from 'y-webrtc';
import type * as Y from 'yjs';

export interface RoomOptions {
	server: string;
	room: string;
	secret: string;
}

export function createProvider(doc: Y.Doc, opts: RoomOptions): WebrtcProvider {
	return new WebrtcProvider(opts.room, doc, {
		signaling: [`wss://${opts.server}/room/${opts.room}`],
		password: opts.secret,
	});
}
