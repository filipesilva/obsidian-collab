import { describe, expect, it } from 'vitest';
import { inviteUrl, parseInvite, parseInviteUrl, randomId } from './invite';

describe('invite url', () => {
  const invite = {
    relays: ['wss://relay.example.com', 'wss://a,b.example.com/x y'],
    id: 'c-1',
    secret: 'k/1+2=',
    file: 'My note & more',
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
    const url = inviteUrl(invite);
    expect(url.startsWith('obsidian://collab?')).toBe(true);
    expect(url).not.toContain('+');
    expect(parseInvite({ action: 'collab', ...obsidianParams(url) })).toEqual(invite);
  });

  it('round trips a folder url, including the vault root', () => {
    const folder = { ...invite, file: undefined, folder: 'Collab/Plan' };
    expect(parseInvite(obsidianParams(inviteUrl(folder)))).toEqual({ ...folder, file: undefined });
    const root = { ...folder, folder: '' };
    expect(parseInvite(obsidianParams(inviteUrl(root)))?.folder).toBe('');
  });

  it('parses a pasted url', () => {
    expect(parseInviteUrl(` ${inviteUrl(invite)}\n`)).toEqual(invite);
    expect(parseInviteUrl('https://example.com/?s=x&i=y&k=z&f=w')).toBeNull();
    expect(parseInviteUrl('obsidian://collab')).toBeNull();
    expect(parseInviteUrl('obsidian://collab?s=%E0%A4%A&i=y&k=z&f=w')).toBeNull();
  });

  it('rejects urls missing a required field', () => {
    expect(parseInvite({ s: 'x', i: 'y', k: 'z' })).toBeNull();
    expect(parseInvite({ s: 'x', i: 'y', f: 'w' })).toBeNull();
    expect(parseInvite({ s: 'x', i: 'y', k: 'z', f: '' })).toBeNull();
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
