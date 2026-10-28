import type { CollabSettings } from './settings';

type Data = Record<string, unknown>;

// Steps that bring saved settings up to date, oldest first. Each runs once:
// data.json keeps the number of steps applied as `version`. Only append.
const MIGRATIONS: ((data: Data) => void)[] = [
  // 1.0.5: TURN credentials moved from here, where they were plaintext, to secret storage.
  (data) => {
    if (typeof data.turn === 'object' && data.turn !== null && 'credential' in data.turn) delete data.turn;
  },
  // 1.0.6: earlier versions saved the Community Collab relays default as if chosen.
  // Drop that copy so new community relays apply.
  (data) => {
    if (Array.isArray(data.community) && sameList(data.community as string[], COMMUNITY_1_0)) delete data.community;
  },
];

// Order does not matter, so a list matches whatever order it was saved in.
export function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

export const SETTINGS_VERSION = MIGRATIONS.length;

export const COMMUNITY_1_0 = ['wss://obsidian-collab.filipesilva.workers.dev'];

export function migrate(saved: Data | null): { settings: Partial<CollabSettings>; changed: boolean } {
  const { version, ...data } = saved ?? {};
  const from = typeof version === 'number' ? version : 0;
  for (const step of MIGRATIONS.slice(from)) step(data);
  return { settings: data, changed: saved !== null && from < SETTINGS_VERSION };
}
