import { describe, expect, it } from 'vitest';
import { findById, inviteOf, markedFolder, markerPath } from './identity';
import { inviteUrl } from './invite';

const url = inviteUrl({ relays: ['wss://a'], id: 'c1', secret: 'k', file: 'Plan' });

describe('identity', () => {
  it('parses the property into an invite', () => {
    expect(inviteOf({ path: 'Plan.md', url })?.id).toBe('c1');
    expect(inviteOf({ path: 'Plan.md', url: 'not a url' })).toBeNull();
    expect(inviteOf({ path: 'Plan.md', url: undefined })).toBeNull();
  });

  it('finds a file by collab id, never by name', () => {
    const files = [
      { path: 'Other.md', url: undefined },
      { path: 'Renamed.md', url },
    ];
    expect(findById(files, 'c1')?.path).toBe('Renamed.md');
    expect(findById(files, 'c2')).toBeUndefined();
  });

  it('maps folders to marker files and back', () => {
    expect(markerPath('Collab/Plan')).toBe('Collab/Plan/collab.md');
    expect(markerPath('')).toBe('collab.md');
    expect(markedFolder('Collab/Plan/collab.md')).toBe('Collab/Plan');
    expect(markedFolder('collab.md')).toBe('');
    expect(markedFolder('Collab/Plan/notes.md')).toBeNull();
    expect(markedFolder('mycollab.md')).toBeNull();
  });
});
