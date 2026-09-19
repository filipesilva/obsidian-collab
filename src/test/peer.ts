// Second peer for browser tests. Trystero has one fixed peer id per page, so
// a test loads this in an iframe to get another one.
import * as Y from 'yjs';
import { Provider } from '../network';

interface Config {
  room: string;
  secret: string;
  relays: string[];
}

const config = (window as unknown as { config: Config }).config;
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
