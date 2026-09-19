export interface Invite {
  relays: string[];
  id: string;
  secret: string;
  // Exactly one of these: the suggested name of a shared file, or the
  // vault path of a shared folder.
  file?: string;
  folder?: string;
}

// Obsidian decodes percent escapes only, so spaces must not become '+'.
// Relays are encoded twice so a comma inside a URL survives the split.
export function inviteUrl(invite: Invite): string {
  const fields: Record<string, string> = {
    s: invite.relays.map(encodeURIComponent).join(','),
    i: invite.id,
    k: invite.secret,
  };
  if (invite.folder !== undefined) fields.d = invite.folder;
  else fields.f = invite.file ?? '';
  const query = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `obsidian://collab?${query}`;
}

// A pasted URL. Decodes the query the way Obsidian's protocol handler does.
export function parseInviteUrl(url: string): Invite | null {
  const query = url.trim().split('?')[1];
  if (!url.trim().startsWith('obsidian://collab') || !query) return null;
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
  const { s, i, k, f, d } = params;
  if (!s || !i || !k || (d === undefined && !f)) return null;
  const invite: Invite = { relays: s.split(',').map(decodeURIComponent), id: i, secret: k };
  if (d !== undefined) invite.folder = d;
  else invite.file = f;
  return invite;
}

export function randomId(bytes = 12): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
