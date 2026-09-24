import { Platform } from 'obsidian';
import type { Collab } from './collab';
import { checkNat, checkTurn, describeNat, listCandidates, probeSockets, type NatCheck } from './nat';
import { pickRelays } from './network';
import { type CollabSettings, turnServer } from './settings';

export function natCheck(settings: CollabSettings): Promise<NatCheck> {
  return checkNat(settings.stun, () => probeSockets(pickRelays([...settings.community, ...settings.relays])));
}

// Everything needed to debug a connection from afar, as text.
export async function gatherDiagnostics(version: string, settings: CollabSettings, collabs: Iterable<Collab>): Promise<string> {
  const started = Date.now();
  const platform = Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : 'linux';
  const lines: string[] = [`collab ${version} ${platform} ${new Date().toISOString()}`, `online=${navigator.onLine}`];
  try {
    const nat = await natCheck(settings);
    lines.push(`nat: ${JSON.stringify(nat)} -> ${describeNat(nat)}`);
    const turn = turnServer(settings);
    lines.push(`turn: ${turn ? `${String(turn.urls)} always=${settings.turn.always}` : 'none'}`);
    if (turn) lines.push(`turn test: ${await checkTurn(turn)}`);
    const withStun = await listCandidates({ iceServers: [{ urls: settings.stun }] });
    // Candidate lines here start at the component: "1 udp <priority> <address> <port> typ …".
    const publicAddresses = [...new Set(withStun.filter((l) => / typ srflx /.test(l)).map((l) => l.split(' ')[3]))];
    lines.push(`public address: ${publicAddresses.join(', ') || 'none seen'}`);
    lines.push(`network: ${describeNetwork(withStun)}${Platform.isIosApp ? ' (a guess: iOS marks every candidate as costly)' : ''}`);
    lines.push('candidates with stun:');
    for (const line of withStun) lines.push(`  ${line}`);
    if (turn) {
      lines.push('candidates with turn only:');
      for (const line of await listCandidates({ iceServers: [turn], iceTransportPolicy: 'relay' })) lines.push(`  ${line}`);
    }
    for (const collab of collabs) {
      lines.push(`collab ${collab.path}: peers=${collab.peers} status=${JSON.stringify(collab.status())}`);
      for (const line of await collab.describeConnections()) lines.push(`  ${line}`);
    }
  } catch (e) {
    lines.push(`error: ${String(e)}`);
  }
  lines.push(`gathered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

// The kind of network, read off the candidates' network-cost: 999 is
// cellular, 10 wifi, 0 wired. Several kinds can be up at once.
function describeNetwork(candidates: string[]): string {
  const costs = new Set<number>();
  for (const line of candidates) {
    const m = /network-cost (\d+)/.exec(line);
    if (m) costs.add(Number(m[1]));
  }
  if (!costs.size) return 'unknown';
  const names = [...costs].sort((a, b) => a - b).map((c) => (c >= 900 ? 'cellular' : c >= 10 ? 'wifi' : 'wired'));
  return [...new Set(names)].join(' and ');
}
