import * as Y from 'yjs';

// Where a collab's Yjs state lives between sessions. State is a cache: when
// it is missing, a peer has to be online to get it back.
export interface StateStore {
  read(id: string): Promise<Uint8Array | null>;
  write(id: string, state: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

export function memoryStore(): StateStore {
  const states = new Map<string, Uint8Array>();
  return {
    read: (id) => Promise.resolve(states.get(id) ?? null),
    write: (id, state) => {
      states.set(id, state);
      return Promise.resolve();
    },
    remove: (id) => {
      states.delete(id);
      return Promise.resolve();
    },
  };
}

// Keeps a doc's state in a store: loads it once, then writes a full
// snapshot shortly after each change and on stop.
export class Persistence {
  private timer: number | null = null;

  constructor(
    private doc: Y.Doc,
    private id: string,
    private store: StateStore,
    private delay = 2000,
  ) {}

  // Resolves whether saved state existed.
  async load(): Promise<boolean> {
    const state = await this.store.read(this.id);
    if (state) Y.applyUpdate(this.doc, state);
    this.doc.on('update', this.onUpdate);
    return state !== null;
  }

  // A pending timer means unsaved changes.
  async flush(): Promise<void> {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
    await this.store.write(this.id, Y.encodeStateAsUpdate(this.doc));
  }

  async stop(): Promise<void> {
    this.doc.off('update', this.onUpdate);
    await this.flush();
  }

  private onUpdate = () => {
    this.timer ??= window.setTimeout(() => void this.flush(), this.delay);
  };
}
