import { describe, expect, it } from 'vitest';
import { inviteLink, parseInvite, parseInviteLink, randomId } from './invite';

describe('invite link', () => {
  const invite = {
    relays: ['wss://relay.example.com', 'wss://a,b.example.com/x y'],
    room: 'r-1',
    secret: 'k/1+2=',
    doc: 'doc-1',
    note: 'My note & more',
  };

  // Obsidian splits on & and = and runs decodeURIComponent on each part.
  function obsidianParams(link: string): Record<string, string> {
    const query = link.slice(link.indexOf('?') + 1);
    const params: Record<string, string> = {};
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=');
      params[decodeURIComponent(key!)] = decodeURIComponent(value!);
    }
    return params;
  }

  it('round trips through the obsidian protocol query', () => {
    const link = inviteLink(invite);
    expect(link.startsWith('obsidian://collab?')).toBe(true);
    expect(link).not.toContain('+');
    expect(parseInvite({ action: 'collab', ...obsidianParams(link) })).toEqual(invite);
  });

  it('parses a pasted link', () => {
    expect(parseInviteLink(` ${inviteLink(invite)}\n`)).toEqual(invite);
    expect(parseInviteLink('https://example.com/?s=x&r=y&k=z&d=w')).toBeNull();
    expect(parseInviteLink('obsidian://collab')).toBeNull();
    expect(parseInviteLink('obsidian://collab?s=%E0%A4%A&r=y&k=z&d=w')).toBeNull();
  });

  it('rejects links missing a required field', () => {
    expect(parseInvite({ s: 'x', r: 'y', k: 'z' })).toBeNull();
    expect(parseInvite({ s: 'x', r: 'y', d: 'w' })).toBeNull();
  });

  it('defaults the note name to empty', () => {
    expect(parseInvite({ s: 'x', r: 'y', k: 'z', d: 'w' })?.note).toBe('');
  });
});

describe('randomId', () => {
  it('is url safe and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(randomId(16)).toHaveLength(22);
  });
});
