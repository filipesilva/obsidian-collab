import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createProvider, iceUrl } from './network';

describe('browser runtime', () => {
  it('has no Node globals, like Obsidian mobile', () => {
    expect(typeof Buffer).toBe('undefined');
    expect(typeof process).toBe('undefined');
    expect(typeof require).toBe('undefined');
  });

  it('has the web APIs y-webrtc needs', () => {
    expect(typeof RTCPeerConnection).toBe('function');
    expect(typeof WebSocket).toBe('function');
    expect(typeof crypto.subtle).toBe('object');
  });
});

describe('createProvider', () => {
  it('constructs and destroys without touching the network', () => {
    const doc = new Y.Doc();
    const provider = createProvider(doc, {
      server: 'ws://localhost:1',
      room: 'test',
      secret: 'secret',
    });
    expect(provider.signalingUrls).toEqual(['ws://localhost:1/room/test']);
    provider.destroy();
    doc.destroy();
  });
});

describe('iceUrl', () => {
  it('derives the https route from the signaling url', () => {
    expect(iceUrl('wss://collab.example.com')).toBe('https://collab.example.com/ice');
    expect(iceUrl('ws://localhost:8787')).toBe('http://localhost:8787/ice');
  });
});
