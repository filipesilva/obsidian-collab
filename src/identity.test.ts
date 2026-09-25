import { describe, expect, it } from 'vitest';
import { markerPath, parentPath } from './identity';

describe('identity', () => {
  it('maps folders to marker files', () => {
    expect(markerPath('Collab/Plan')).toBe('Collab/Plan/collab.md');
    expect(markerPath('')).toBe('collab.md');
  });

  it('finds the folder a path is in', () => {
    expect(parentPath('Collab/Plan/notes.md')).toBe('Collab/Plan');
    expect(parentPath('notes.md')).toBe('');
  });
});
