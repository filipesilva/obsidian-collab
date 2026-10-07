import type { CollabSettings } from './settings';

type Data = Record<string, unknown>;

// Steps that bring saved settings up to date, oldest first. Each runs once:
// data.json keeps the number of steps applied as `version`. Only append.
const MIGRATIONS: ((data: Data) => void)[] = [
  // 1.0.5: TURN credentials moved from here, where they were plaintext, to secret storage.
  (data) => {
    if (typeof data.turn === 'object' && data.turn !== null && 'credential' in data.turn) delete data.turn;
  },
  // 1.1.0: earlier versions saved the Public Nostr relays default as if chosen.
  // Drop that copy of the Trystero 0.25 default so the current one applies.
  (data) => {
    if (Array.isArray(data.relays) && sameList(data.relays as string[], RELAYS_0_25)) delete data.relays;
  },
];

// Order does not matter, so a list matches whatever order it was saved in.
export function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

export const SETTINGS_VERSION = MIGRATIONS.length;

export const RELAYS_0_25 = [
  'basspistol.org',
  'bucket.coracle.social',
  'chorus.pjv.me',
  'koru.bitcointxoko.org',
  'nos.lol',
  'nostr-01.uid.ovh',
  'nostr-01.yakihonne.com',
  'nostr-relay.corb.net',
  'nostr.data.haus',
  'nostr.islandarea.net',
  'nostr.sathoarder.com',
  'nostr.tegila.com.br',
  'nostr.vulpem.com',
  'purplerelay.com',
  'relay-can.zombi.cloudrodion.com',
  'relay-rpi.edufeed.org',
  'relay.agorist.space',
  'relay.artio.inf.unibe.ch',
  'relay.mostr.pub',
  'relay.mostro.network',
  'relay.sigit.io',
  'relay02.lnfi.network',
  'schnorr.me',
  'social.amanah.eblessing.co',
  'staging.yabu.me',
  'strfry.shock.network',
  'top.testrelay.top',
  'yabu.me/v2',
].map((host) => `wss://${host}`);

export function migrate(saved: Data | null): { settings: Partial<CollabSettings>; changed: boolean } {
  const { version, ...data } = saved ?? {};
  const from = typeof version === 'number' ? version : 0;
  for (const step of MIGRATIONS.slice(from)) step(data);
  return { settings: data, changed: saved !== null && from < SETTINGS_VERSION };
}
