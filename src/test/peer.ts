// Extra peers for browser tests. Trystero has one fixed peer id per page, so
// a test loads this in an iframe for each additional peer and talks to it
// with postMessage.
import * as Y from 'yjs';
import { Provider, type RoomOptions } from '../network';

const config = (window as unknown as { config: RoomOptions }).config;
const doc = new Y.Doc();
const text = doc.getText('t');
const post = (msg: unknown) => window.parent.postMessage(msg, '*');
const start = (opts: RoomOptions) => {
  const provider = new Provider(doc, opts);
  provider.onPeers = (count) => post({ type: 'peers', count });
  return provider;
};
let provider = start(config);

text.observe(() => post({ type: 'text', data: text.toString() }));
window.addEventListener('message', (e: MessageEvent<{ type: string; data?: string; room?: string; secret?: string }>) => {
  if (e.data.type === 'insert') text.insert(text.length, e.data.data ?? '');
  if (e.data.type === 'name') provider.awareness.setLocalStateField('user', { name: e.data.data });
  if (e.data.type === 'leave') void provider.destroy();
  // A new room on the same doc, as a regenerated URL does.
  if (e.data.type === 'rejoin') {
    void provider.destroy().then(() => {
      provider = start({ ...config, room: e.data.room ?? config.room, secret: e.data.secret ?? config.secret });
    });
  }
});
post({ type: 'ready' });
