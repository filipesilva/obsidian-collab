export interface Invite {
  server: string;
  room: string;
  secret: string;
  doc: string;
  note: string;
}

// Obsidian decodes percent escapes only, so spaces must not become '+'.
export function inviteLink(invite: Invite): string {
  const fields = { s: invite.server, r: invite.room, k: invite.secret, d: invite.doc, n: invite.note };
  const query = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `obsidian://collab?${query}`;
}

export function parseInvite(params: Record<string, string>): Invite | null {
  const { s, r, k, d, n } = params;
  if (!s || !r || !k || !d) return null;
  return { server: s, room: r, secret: k, doc: d, note: n ?? '' };
}

export function randomId(bytes = 12): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
