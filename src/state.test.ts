import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Persistence, memoryStore } from './state';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Persistence', () => {
  it('reports missing state and saves after a change', async () => {
    const store = memoryStore();
    const doc = new Y.Doc();
    const persistence = new Persistence(doc, 'r1', store, 10);
    expect(await persistence.load()).toBe(false);
    doc.getText('t').insert(0, 'hello');
    expect(await store.read('r1')).toBeNull();
    await tick(30);
    expect(await store.read('r1')).not.toBeNull();
    await persistence.stop();
  });

  it('restores a doc from saved state', async () => {
    const store = memoryStore();
    const a = new Y.Doc();
    const pa = new Persistence(a, 'r1', store, 10);
    await pa.load();
    a.getText('t').insert(0, 'hello');
    await pa.stop();

    const b = new Y.Doc();
    const pb = new Persistence(b, 'r1', store, 10);
    expect(await pb.load()).toBe(true);
    expect(b.getText('t').toString()).toBe('hello');
    await pb.stop();
  });

  it('coalesces a burst of changes into one write and flushes on stop', async () => {
    const store = memoryStore();
    let writes = 0;
    const counting = { ...store, write: (room: string, state: Uint8Array) => (writes++, store.write(room, state)) };
    const doc = new Y.Doc();
    const persistence = new Persistence(doc, 'r1', counting, 20);
    await persistence.load();
    for (const ch of 'hello') doc.getText('t').insert(doc.getText('t').length, ch);
    await tick(40);
    expect(writes).toBe(1);
    doc.getText('t').insert(0, '!');
    await persistence.stop();
    expect(writes).toBe(2);
    doc.getText('t').insert(0, '?');
    await tick(40);
    expect(writes).toBe(2);
  });

  it('applying the same snapshot twice changes nothing', async () => {
    const store = memoryStore();
    const doc = new Y.Doc();
    const persistence = new Persistence(doc, 'r1', store, 10);
    await persistence.load();
    doc.getText('t').insert(0, 'hello');
    await persistence.stop();
    const snapshot = (await store.read('r1'))!;
    Y.applyUpdate(doc, snapshot);
    Y.applyUpdate(doc, snapshot);
    expect(doc.getText('t').toString()).toBe('hello');
  });
});
