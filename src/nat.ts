import { getRelaySockets } from 'trystero';

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

// Mapped ports seen per public address.
function gather(stun: string[], timeout: number): Promise<Map<string, Set<number>>> {
  const ports = new Map<string, Set<number>>();
  if (!stun.length) return Promise.resolve(ports);
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
    const done = () => {
      window.clearTimeout(timer);
      pc.close();
      resolve(ports);
    };
    const timer = window.setTimeout(done, timeout);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return done();
      const parsed = parseCandidate(candidate.candidate);
      if (!parsed || parsed.type !== 'srflx') return;
      const set = ports.get(parsed.address) ?? new Set();
      set.add(parsed.port);
      ports.set(parsed.address, set);
    };
    pc.createDataChannel('nat');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(done);
  });
}

// Every ICE candidate a configuration yields, as SDP lines, for diagnostics.
export function listCandidates(rtc: RTCConfiguration, timeout = 6000): Promise<string[]> {
  const lines: string[] = [];
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(rtc);
    } catch (e) {
      return resolve([`error: ${String(e)}`]);
    }
    const done = () => {
      window.clearTimeout(timer);
      pc.close();
      resolve(lines);
    };
    const timer = window.setTimeout(done, timeout);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return done();
      lines.push(candidate.candidate.replace(/^candidate:\S+ /, ''));
    };
    pc.onicecandidateerror = (e) => lines.push(`error ${String(e.errorCode)} ${e.errorText} ${e.url}`);
    pc.createDataChannel('diag');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch((e: unknown) => {
        lines.push(`error: ${String(e)}`);
        done();
      });
  });
}

// Whether a TURN server accepts these credentials: asks it for a relay
// allocation and waits for the relay candidate.
export function checkTurn(server: RTCIceServer, timeout = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: 'relay' });
    } catch {
      return resolve(false);
    }
    const done = (ok: boolean) => {
      window.clearTimeout(timer);
      pc.close();
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(false), timeout);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return done(false);
      if (parseCandidate(candidate.candidate)?.type === 'relay') done(true);
    };
    pc.createDataChannel('turn');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => done(false));
  });
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
  const pool = [...urls].sort(() => Math.random() - 0.5);
  const live: string[] = [];
  for (let i = 0; i < pool.length && live.length < count; i += count * 2) {
    const batch = pool.slice(i, i + count * 2);
    const answered = await Promise.all(batch.map((url) => answers(url, timeout)));
    for (const [j, ok] of answered.entries()) if (ok && live.length < count) live.push(batch[j]!);
  }
  return live;
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
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'probe', { kinds: [20000], since: Math.floor(Date.now() / 1000), '#x': ['probe'] }]));
    socket.onmessage = () => done(true);
    socket.onerror = () => done(false);
  });
}

// Whether any of the given websocket servers accepts a connection. An
// already open one counts, so a live collab answers at once.
export function probeSockets(urls: string[], timeout = 5000): Promise<boolean> {
  const open = (getRelaySockets as () => Record<string, WebSocket | undefined>)();
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
  if (!check.online) return 'no network, will connect when it is back';
  if (!check.reachable) return 'UDP is blocked here, a TURN server in settings is required';
  if (check.symmetric) return 'symmetric NAT here, direct connections depend on the other side. A TURN server in settings makes them reliable';
  return 'direct connections should work';
}
