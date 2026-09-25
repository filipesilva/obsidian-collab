import { allRelaySockets, pickRelays, probeRequest } from './network';
import { nat } from './text';

// Whether this network can take a direct connection, judged from what STUN
// reports. One peer connection asks every STUN server from one local
// socket. No answer means UDP is blocked, unless nothing else answers
// either, which is just no network. Different mapped ports for the same
// public address mean a symmetric NAT. Blocked UDP and symmetric NAT both
// need TURN.
export interface NatCheck {
  online: boolean;
  reachable: boolean;
  symmetric: boolean | null;
  needsTurn: boolean;
}

export async function checkNat(stun: string[], online: () => Promise<boolean>, timeout = 5000): Promise<NatCheck> {
  const [ports, isOnline] = await Promise.all([gather(stun, timeout), online()]);
  const reachable = ports.size > 0;
  const symmetric = reachable ? [...ports.values()].some((set) => set.size > 1) : null;
  return { online: isOnline || reachable, reachable, symmetric, needsTurn: isOnline && !reachable };
}

// Hands each ICE candidate line of a throwaway connection to `each`, until
// gathering ends, `each` returns true, or the timeout.
function gatherCandidates(
  rtc: RTCConfiguration,
  timeout: number,
  each: (line: string) => boolean | void,
  problem: (text: string) => void = () => {},
): Promise<void> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(rtc);
    } catch (e) {
      problem(`error: ${String(e)}`);
      return resolve();
    }
    const done = () => {
      window.clearTimeout(timer);
      pc.close();
      resolve();
    };
    const timer = window.setTimeout(done, timeout);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || each(candidate.candidate)) done();
    };
    pc.onicecandidateerror = (e) => problem(`error ${String(e.errorCode)} ${e.errorText} ${e.url}`);
    pc.createDataChannel('probe');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch((e: unknown) => {
        problem(`error: ${String(e)}`);
        done();
      });
  });
}

// Mapped ports seen per public address.
async function gather(stun: string[], timeout: number): Promise<Map<string, Set<number>>> {
  const ports = new Map<string, Set<number>>();
  if (!stun.length) return ports;
  await gatherCandidates({ iceServers: [{ urls: stun }] }, timeout, (line) => {
    const parsed = parseCandidate(line);
    if (!parsed || parsed.type !== 'srflx') return;
    const set = ports.get(parsed.address) ?? new Set();
    set.add(parsed.port);
    ports.set(parsed.address, set);
  });
  return ports;
}

// Every ICE candidate a configuration yields, as SDP lines, for diagnostics.
export async function listCandidates(rtc: RTCConfiguration, timeout = 6000): Promise<string[]> {
  const lines: string[] = [];
  await gatherCandidates(
    rtc,
    timeout,
    (line) => {
      lines.push(line.replace(/^candidate:\S+ /, ''));
    },
    (text) => lines.push(text),
  );
  return lines;
}

// Whether a TURN server accepts these credentials: asks it for a relay
// allocation and waits for the relay candidate.
export async function checkTurn(server: RTCIceServer, timeout = 5000): Promise<boolean> {
  let ok = false;
  await gatherCandidates({ iceServers: [server], iceTransportPolicy: 'relay' }, timeout, (line) => (ok = parseCandidate(line)?.type === 'relay'));
  return ok;
}

// The SDP line, since not every browser fills in the candidate's fields:
// candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
export function parseCandidate(line: string): { address: string; port: number; type: string } | null {
  const parts = line.split(' ');
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  return { address: parts[4]!, port: Number(parts[5]), type: parts[7]! };
}

// The first `count` relays, out of a shuffled list, that answer a
// subscription. A share dials these and its URL carries them, so a dead
// relay in the list costs nothing beyond this probe. Probes run in batches
// so a long list does not open every socket at once.
export async function liveRelays(urls: string[], count: number, timeout = 4000): Promise<string[]> {
  const pool = pickRelays(urls, urls.length);
  const live: string[] = [];
  for (let i = 0; i < pool.length && live.length < count; i += count * 2) {
    const batch = pool.slice(i, i + count * 2);
    // Done once enough have answered: a silent relay must not hold up the rest.
    await new Promise<void>((resolve) => {
      let pending = batch.length;
      for (const url of batch) {
        void answers(url, timeout).then((ok) => {
          if (ok && live.length < count) live.push(url);
          if (--pending === 0 || live.length >= count) resolve();
        });
      }
    });
  }
  return live;
}

// Every `preferred` relay that answers, then others to fill up to `count`.
// Both lists are probed at once, so preferring costs no time.
export async function preferredLiveRelays(preferred: string[], others: string[], count: number, timeout?: number): Promise<string[]> {
  const [first, rest] = await Promise.all([
    liveRelays(preferred, count, timeout),
    liveRelays(others.filter((url) => !preferred.includes(url)), count, timeout),
  ]);
  return [...first, ...rest].slice(0, count);
}

function answers(url: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      return resolve(false);
    }
    const done = (ok: boolean) => {
      window.clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(false), timeout);
    socket.onopen = () => socket.send(probeRequest('probe'));
    socket.onmessage = () => done(true);
    socket.onerror = () => done(false);
  });
}

// Whether any of the given websocket servers accepts a connection. An
// already open one counts, so a live collab answers at once.
export function probeSockets(urls: string[], timeout = 5000): Promise<boolean> {
  const open = allRelaySockets();
  if (Object.values(open).some((socket) => socket?.readyState === WebSocket.OPEN)) return Promise.resolve(true);
  if (!urls.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    let pending = urls.length;
    const sockets = urls.map((url) => new WebSocket(url));
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      for (const socket of sockets) socket.close();
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeout);
    for (const socket of sockets) {
      socket.onopen = () => finish(true);
      socket.onerror = () => {
        if (--pending === 0) finish(false);
      };
    }
  });
}

// Blocked UDP always needs TURN. A symmetric NAT connects only to peers on
// open networks, so TURN makes it reliable rather than possible.
export function describeNat(check: NatCheck): string {
  if (!check.online) return nat.offline;
  if (!check.reachable) return nat.blocked;
  if (check.symmetric) return nat.symmetric;
  return nat.ok;
}
