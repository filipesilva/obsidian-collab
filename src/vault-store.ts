import { App, normalizePath } from 'obsidian';
import type { StateStore } from './state';

// Collab state as `state/<collab id>.yjs` inside the plugin folder.
export function vaultStore(app: App, pluginDir: string): StateStore {
  const { adapter } = app.vault;
  const folder = normalizePath(`${pluginDir}/state`);
  const path = (id: string) => normalizePath(`${folder}/${id}.yjs`);
  return {
    async read(id) {
      if (!(await adapter.exists(path(id)))) return null;
      return new Uint8Array(await adapter.readBinary(path(id)));
    },
    async write(id, state) {
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      const bytes = state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength) as ArrayBuffer;
      await adapter.writeBinary(path(id), bytes);
    },
    async remove(id) {
      if (await adapter.exists(path(id))) await adapter.remove(path(id));
    },
  };
}
