/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { checkNat, checkTurn, describeNat, liveRelays, parseCandidate, probeSockets } from './nat';
import { DEFAULT_STUN } from './network';

const yes = () => Promise.resolve(true);
const no = () => Promise.resolve(false);

describe('checkNat', () => {
  it('needs TURN when online but no STUN answers', async () => {
    const check = await checkNat(['stun:localhost:1'], yes, 1500);
    expect(check).toEqual({ online: true, reachable: false, symmetric: null, needsTurn: true });
    expect(describeNat(check)).toContain('UDP is blocked');
    expect(describeNat({ online: true, reachable: true, symmetric: true, needsTurn: false })).toContain('symmetric');
  });

  it('claims nothing when there is no network', async () => {
    const check = await checkNat(['stun:localhost:1'], no, 1500);
    expect(check).toEqual({ online: false, reachable: false, symmetric: null, needsTurn: false });
    expect(describeNat(check)).toContain('no network');
  });

  it('needs TURN online without STUN servers', async () => {
    expect((await checkNat([], yes)).needsTurn).toBe(true);
  });

  it.runIf(import.meta.env.VITE_ONLINE)('reaches public STUN from here', { timeout: 10000 }, async () => {
    const check = await checkNat(DEFAULT_STUN, yes, 5000);
    expect(check.reachable).toBe(true);
    expect(check.symmetric).not.toBeNull();
  });
});

describe('probeSockets', () => {
  it('is true when one server accepts', async () => {
    expect(await probeSockets(['ws://localhost:1', 'ws://localhost:8788'], 3000)).toBe(true);
  });

  it('is false when none does', async () => {
    expect(await probeSockets(['ws://localhost:1'], 3000)).toBe(false);
    expect(await probeSockets([], 3000)).toBe(false);
  });
});

describe('parseCandidate', () => {
  it('reads address, port and type from the SDP line', () => {
    expect(parseCandidate('candidate:842163049 1 udp 1677729535 203.0.113.7 51234 typ srflx raddr 0.0.0.0 rport 0 generation 0')).toEqual({
      address: '203.0.113.7',
      port: 51234,
      type: 'srflx',
    });
    expect(parseCandidate('candidate:1 1 udp 2113937151 abcd.local 60000 typ host generation 0')?.type).toBe('host');
    expect(parseCandidate('garbage')).toBeNull();
  });
});

describe('checkTurn', () => {
  it('fails for a server that does not answer', async () => {
    expect(await checkTurn({ urls: 'turn:localhost:1', username: 'u', credential: 'p' }, 2000)).toBe(false);
  });

  it('fails for a malformed url', async () => {
    expect(await checkTurn({ urls: 'not a turn url', username: 'u', credential: 'p' }, 2000)).toBe(false);
  });
});

describe('liveRelays', () => {
  it('keeps only relays that answer, in the requested number', { timeout: 20000 }, async () => {
    const live = await liveRelays(['ws://localhost:1', 'ws://localhost:8788', 'ws://localhost:8788/two', 'ws://localhost:2'], 1, 3000);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatch(/^ws:\/\/localhost:8788/);
    expect(await liveRelays(['ws://localhost:1'], 3, 2000)).toEqual([]);
  });
});

// The test setup runs a local STUN and TURN server on 3479 with collab/collab.
const LOCAL_TURN: RTCIceServer = { urls: 'turn:localhost:3479', username: 'collab', credential: 'collab' };

describe('with the local TURN server', () => {
  it('checkTurn gets a relay allocation', { timeout: 15000 }, async () => {
    expect(await checkTurn(LOCAL_TURN, 8000)).toBe(true);
  });

  it('checkNat sees the local STUN answer', { timeout: 15000 }, async () => {
    const check = await checkNat(['stun:localhost:3479'], yes, 8000);
    expect(check.reachable).toBe(true);
  });
});
