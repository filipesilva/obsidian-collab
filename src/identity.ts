import { Invite, parseInviteUrl } from './invite';

// A shared file or folder is identified by the `collab-url` frontmatter
// property holding its invite URL. The collab id inside is the identity.
export const PROPERTY = 'collab-url';
export const MARKER = 'collab.md';

export interface Marked {
  path: string;
  url: string | undefined;
}

export function markerPath(folder: string): string {
  return folder ? `${folder}/${MARKER}` : MARKER;
}

// The folder a marker file belongs to, or null for any other file.
export function markedFolder(path: string): string | null {
  if (path === MARKER) return '';
  return path.endsWith(`/${MARKER}`) ? path.slice(0, -MARKER.length - 1) : null;
}

export function inviteOf(item: Marked): Invite | null {
  return typeof item.url === 'string' ? parseInviteUrl(item.url) : null;
}

export function findById(items: Iterable<Marked>, id: string): Marked | undefined {
  for (const item of items) if (inviteOf(item)?.id === id) return item;
  return undefined;
}
