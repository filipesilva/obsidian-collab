// Extra peers for browser tests. Trystero has one fixed peer id per page, so
// a test loads this in an iframe for each additional peer and talks to it
// with postMessage.
import * as Y from 'yjs';
import { Provider, type RoomOptions } from '../network';

const config = (window as unknown as { config: RoomOptions }).config;
const doc = new Y.Doc();
const text = doc.getText('t');
const provider = new Provider(doc, config);
const post = (msg: unknown) => window.parent.postMessage(msg, '*');

provider.onPeers = (count) => post({ type: 'peers', count });
text.observe(() => post({ type: 'text', data: text.toString() }));
window.addEventListener('message', (e: MessageEvent<{ type: string; data?: string }>) => {
  if (e.data.type === 'insert') text.insert(text.length, e.data.data ?? '');
  if (e.data.type === 'leave') void provider.destroy();
});
post({ type: 'ready' });
