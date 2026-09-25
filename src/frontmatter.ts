import { App, TFile } from 'obsidian';
import { Invite, parseInviteUrl } from './invite';

// A shared file or folder is identified by this property holding its invite
// URL. The collab id inside is the identity.
const PROPERTY = 'collab-url';

export function readUrl(app: App, file: TFile): string | undefined {
  const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[PROPERTY];
  return typeof value === 'string' ? value : undefined;
}

export function readInvite(app: App, file: TFile): Invite | null {
  const url = readUrl(app, file);
  return url ? parseInviteUrl(url) : null;
}

export function writeUrl(app: App, file: TFile, url: string): Promise<void> {
  return app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    frontmatter[PROPERTY] = url;
  });
}

export function removeUrl(app: App, file: TFile): Promise<void> {
  return app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    delete frontmatter[PROPERTY];
  });
}
