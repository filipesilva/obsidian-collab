import { describe, expect, it } from 'vitest';
import { COMMUNITY_1_0, SETTINGS_VERSION, migrate } from './migrations';

describe('settings migrations', () => {
  const v104 = {
    name: 'Me',
    community: COMMUNITY_1_0,
    relays: ['wss://relay.example.com'],
    stun: ['stun:stun.example.com:3478'],
    turn: { enabled: true, url: 'turn:x:3478', username: 'u', credential: 'p', always: true },
  };

  it('leaves a fresh install alone', () => {
    expect(migrate(null)).toEqual({ settings: {}, changed: false });
  });

  it('brings 1.0.4 data up to date', () => {
    const { settings, changed } = migrate(v104);
    expect(changed).toBe(true);
    expect(settings).toEqual({ name: 'Me', relays: v104.relays, stun: v104.stun });
  });

  it('keeps the TURN toggles saved by 1.0.5', () => {
    const turn = { disabled: true, always: true };
    const { settings, changed } = migrate({ ...v104, turn });
    expect(changed).toBe(true);
    expect(settings.turn).toEqual(turn);
  });

  it('keeps community relays the user chose', () => {
    const community = [...COMMUNITY_1_0, 'wss://relay.example.com'];
    expect(migrate({ community }).settings).toEqual({ community });
  });

  it('runs only the steps after the saved version', () => {
    expect(migrate({ ...v104, version: SETTINGS_VERSION })).toEqual({
      settings: { name: 'Me', community: v104.community, relays: v104.relays, stun: v104.stun, turn: v104.turn },
      changed: false,
    });
    const { settings, changed } = migrate({ ...v104, version: 1 });
    expect(changed).toBe(true);
    expect(settings.turn).toEqual(v104.turn);
    expect(settings.community).toBeUndefined();
  });

  it('does not change the data it was given', () => {
    const saved = structuredClone(v104);
    migrate(saved);
    expect(saved).toEqual(v104);
  });
});
