export interface Invite {
  relays: string[];
  room: string;
  secret: string;
  doc: string;
  note: string;
}

// Obsidian decodes percent escapes only, so spaces must not become '+'.
// Relays are encoded twice so a comma inside a URL survives the split.
export function inviteLink(invite: Invite): string {
  const fields = {
    s: invite.relays.map(encodeURIComponent).join(','),
    r: invite.room,
    k: invite.secret,
    d: invite.doc,
    n: invite.note,
  };
  const query = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `obsidian://collab?${query}`;
}

// A pasted link. Decodes the query the way Obsidian's protocol handler does.
export function parseInviteLink(link: string): Invite | null {
  const query = link.trim().split('?')[1];
  if (!link.trim().startsWith('obsidian://collab') || !query) return null;
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    const [key, value = ''] = pair.split('=');
    try {
      params[decodeURIComponent(key!)] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return parseInvite(params);
}

export function parseInvite(params: Record<string, string>): Invite | null {
  const { s, r, k, d, n } = params;
  if (!s || !r || !k || !d) return null;
  return { relays: s.split(',').map(decodeURIComponent), room: r, secret: k, doc: d, note: n ?? '' };
}

export function randomId(bytes = 12): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
