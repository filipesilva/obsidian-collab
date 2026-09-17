import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyContent, docs, getText, openDoc } from './sync';

// Two docs joined by a fake network. Connected docs forward updates live;
// connect() also exchanges everything missed while apart.
function link(a: Y.Doc, b: Y.Doc) {
  let connected = false;
  const forward = (to: Y.Doc) => (update: Uint8Array, origin: unknown) => {
    if (connected && origin !== 'link') Y.applyUpdate(to, update, 'link');
  };
  a.on('update', forward(b));
  b.on('update', forward(a));
  return {
    connect() {
      connected = true;
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'link');
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'link');
    },
    disconnect() {
      connected = false;
    },
  };
}

function reopen(from: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}

const note = { id: 'n1', path: 'Note.md' };

describe('applyContent', () => {
  it.each([
    ['', 'hello'],
    ['hello', ''],
    ['hello world', 'hello brave world'],
    ['hello brave world', 'hello world'],
    ['one two three', 'one 2 three'],
    ['a\nb\nc', 'a\nc\nb'],
    ['smile 😀 wave', 'smile 👋 wave'],
    ['same', 'same'],
  ])('turns %j into %j', (before, after) => {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    text.insert(0, before);
    applyContent(text, after);
    expect(text.toString()).toBe(after);
  });

  it('keeps unchanged text untouched so concurrent edits merge', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const net = link(a, b);
    a.getText('t').insert(0, 'one two three');
    net.connect();
    net.disconnect();
    applyContent(a.getText('t'), 'one two three four');
    applyContent(b.getText('t'), 'zero one two three');
    net.connect();
    expect(a.getText('t').toString()).toBe('zero one two three four');
    expect(b.getText('t').toString()).toBe('zero one two three four');
  });
});

describe('openDoc', () => {
  it('seeds the doc map from the file', () => {
    const doc = new Y.Doc();
    const text = openDoc(doc, { ...note, content: 'hello' });
    expect(text.toString()).toBe('hello');
    expect(docs(doc).get(note.id)?.get('path')).toBe('Note.md');
    expect(getText(doc, note.id)).toBe(text);
  });

  it('returns the existing text with the file applied', () => {
    const doc = new Y.Doc();
    const first = openDoc(doc, { ...note, content: 'hello' });
    const second = openDoc(doc, { ...note, content: 'hello world' });
    expect(second).toBe(first);
    expect(second.toString()).toBe('hello world');
    expect(docs(doc).size).toBe(1);
  });
});

describe('nobody has history', () => {
  it('concurrent seeds collapse to one text without duplicating content', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const net = link(a, b);
    openDoc(a, { ...note, content: 'hello' });
    openDoc(b, { ...note, content: 'hello' });
    net.connect();
    const ta = openDoc(a, { ...note, content: 'hello' });
    const tb = openDoc(b, { ...note, content: 'hello' });
    expect(ta.toString()).toBe('hello');
    expect(tb.toString()).toBe('hello');
    expect(docs(a).size).toBe(1);
    expect(getText(a, note.id)).toBe(ta);
    expect(getText(b, note.id)).toBe(tb);
  });

  it('the loser diffs its file into the winner text', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const net = link(a, b);
    openDoc(a, { ...note, content: 'hello from a' });
    openDoc(b, { ...note, content: 'hello from b' });
    net.connect();
    const winner = getText(a, note.id)!.toString();
    const loser = winner === 'hello from a' ? b : a;
    const loserFile = loser === a ? 'hello from a' : 'hello from b';
    openDoc(loser, { ...note, content: loserFile });
    expect(getText(a, note.id)!.toString()).toBe(loserFile);
    expect(getText(b, note.id)!.toString()).toBe(loserFile);
  });
});

describe('one side lost history', () => {
  it('joining after sync binds to the shared text', () => {
    const a = new Y.Doc();
    openDoc(a, { ...note, content: 'hello' });
    const b = new Y.Doc();
    const net = link(a, b);
    net.connect();
    const tb = openDoc(b, { ...note, content: 'hello' });
    expect(tb.toString()).toBe('hello');
    expect(docs(b).size).toBe(1);
  });

  it('joining before sync seeds, then rebinds to the shared text', () => {
    const a = new Y.Doc();
    openDoc(a, { ...note, content: 'hello' });
    const b = new Y.Doc();
    const net = link(a, b);
    openDoc(b, { ...note, content: 'hello' });
    net.connect();
    const tb = openDoc(b, { ...note, content: 'hello' });
    expect(tb.toString()).toBe('hello');
    expect(getText(b, note.id)).toBe(tb);
    expect(getText(a, note.id)!.toString()).toBe('hello');
    expect(docs(a).size).toBe(1);
    expect(docs(b).size).toBe(1);
  });

  it('the file of the side without history wins', () => {
    const a = new Y.Doc();
    openDoc(a, { ...note, content: 'hello' });
    const b = new Y.Doc();
    const net = link(a, b);
    net.connect();
    openDoc(b, { ...note, content: 'hello, edited offline' });
    expect(getText(a, note.id)!.toString()).toBe('hello, edited offline');
  });
});

describe('history exists but the file changed outside the plugin', () => {
  it('merges offline file edits with live edits from the peer', () => {
    const a = new Y.Doc();
    openDoc(a, { ...note, content: 'one two three' });
    const b0 = new Y.Doc();
    link(a, b0).connect();
    const b = reopen(b0);

    getText(a, note.id)!.insert(13, ' four');
    const net = link(a, b);
    openDoc(b, { ...note, content: 'zero one two three' });
    net.connect();

    expect(getText(a, note.id)!.toString()).toBe('zero one two three four');
    expect(getText(b, note.id)!.toString()).toBe('zero one two three four');
  });

  it('a local file edit while offline survives a reopen with saved state', () => {
    const a = new Y.Doc();
    openDoc(a, { ...note, content: 'hello' });
    const b = reopen(a);
    const tb = openDoc(b, { ...note, content: 'hello world' });
    expect(tb.toString()).toBe('hello world');
    const net = link(a, b);
    net.connect();
    expect(getText(a, note.id)!.toString()).toBe('hello world');
  });
});
