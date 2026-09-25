// A shared folder is marked by this file in it, which holds the invite URL
// in its frontmatter and is never synced.
export const MARKER = 'collab.md';

export function markerPath(folder: string): string {
  return folder ? `${folder}/${MARKER}` : MARKER;
}

// '' at the vault root.
export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}
