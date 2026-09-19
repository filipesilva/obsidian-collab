import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bind, collabExtension, isBound, unbind } from './editor';
import { getText, observeDocs, openDoc } from './sync';

const views: EditorView[] = [];

function editor(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [collabExtension, history()] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function text(content: string): Y.Text {
  const ytext = new Y.Doc().getText('t');
  ytext.insert(0, content);
  return ytext;
}

// Obsidian forwards an edit to other panes of the same file as a plain spec
// with userEvent 'set'. Mirror that between two views.
function paneSync(a: EditorView, b: EditorView) {
  const forward = (to: EditorView) =>
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || update.transactions.some((tr) => tr.isUserEvent('set'))) return;
      to.dispatch({ changes: update.changes, userEvent: 'set' });
    });
  const link = (from: EditorView, to: EditorView) =>
    from.setState(
      EditorState.create({
        doc: from.state.doc,
        extensions: [collabExtension, history(), forward(to)],
      }),
    );
  link(a, b);
  link(b, a);
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('bind', () => {
  it('moves local edits into the text', () => {
    const view = editor('hello');
    const ytext = text('hello');
    bind(view, ytext);
    view.dispatch({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' });
    expect(ytext.toString()).toBe('hello world');
  });

  it('moves text changes into the editor', () => {
    const view = editor('hello');
    const ytext = text('hello');
    bind(view, ytext);
    ytext.insert(0, 'oh, ');
    expect(view.state.doc.toString()).toBe('oh, hello');
  });

  it('lets the editor win when the two disagree', () => {
    const view = editor('hello world');
    const ytext = text('hello');
    bind(view, ytext);
    expect(ytext.toString()).toBe('hello world');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('lets the text win when asked', () => {
    const view = editor('hello world');
    const ytext = text('hello');
    bind(view, ytext, 'text');
    expect(ytext.toString()).toBe('hello');
    expect(view.state.doc.toString()).toBe('hello');
    view.dispatch({ changes: { from: 5, insert: '!' } });
    expect(ytext.toString()).toBe('hello!');
  });

  it('reports whether a view is bound to a text', () => {
    const view = editor('hello');
    const ytext = text('hello');
    expect(isBound(view, ytext)).toBe(false);
    bind(view, ytext);
    expect(isBound(view, ytext)).toBe(true);
    expect(isBound(view, text('hello'))).toBe(false);
  });

  it('is undone by unbind', () => {
    const view = editor('hello');
    const ytext = text('hello');
    bind(view, ytext);
    unbind(view);
    view.dispatch({ changes: { from: 5, insert: '!' } });
    ytext.insert(0, '?');
    expect(view.state.doc.toString()).toBe('hello!');
    expect(ytext.toString()).toBe('?hello');
    expect(isBound(view, ytext)).toBe(false);
  });

  it('does not survive a state swap, as when a leaf opens another file', () => {
    const view = editor('hello');
    const ytext = text('hello');
    bind(view, ytext);
    view.setState(EditorState.create({ doc: 'other file', extensions: [collabExtension] }));
    view.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(ytext.toString()).toBe('hello');
    expect(isBound(view, ytext)).toBe(false);
  });
});

describe('undo', () => {
  it('reverts local edits only', () => {
    const view = editor('hello');
    const ytext = text('hello');
    bind(view, ytext);
    view.dispatch({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' });
    ytext.insert(0, 'remote: ');
    expect(view.state.doc.toString()).toBe('remote: hello world');
    undo(view);
    expect(view.state.doc.toString()).toBe('remote: hello');
    expect(ytext.toString()).toBe('remote: hello');
  });
});

describe('two panes of one file, one bound', () => {
  it('applies an edit in either pane to the text once', () => {
    const a = editor('hello');
    const b = editor('hello');
    paneSync(a, b);
    const ytext = text('hello');
    bind(a, ytext);
    a.dispatch({ changes: { from: 5, insert: ' a' }, userEvent: 'input.type' });
    b.dispatch({ changes: { from: 0, insert: 'b ' }, userEvent: 'input.type' });
    expect(a.state.doc.toString()).toBe('b hello a');
    expect(b.state.doc.toString()).toBe('b hello a');
    expect(ytext.toString()).toBe('b hello a');
  });

  it('shows a text change in both panes once', () => {
    const a = editor('hello');
    const b = editor('hello');
    paneSync(a, b);
    const ytext = text('hello');
    bind(a, ytext);
    ytext.insert(5, '!');
    expect(a.state.doc.toString()).toBe('hello!');
    expect(b.state.doc.toString()).toBe('hello!');
    expect(ytext.toString()).toBe('hello!');
  });
});

describe('rebinding after a lost seed', () => {
  // Two peers seed the same note while apart. After they connect, the loser
  // must adopt the winner's text without doubling content.
  async function lostSeed(rebind: (loser: Y.Doc, run: () => void) => void) {
    const a = new Y.Doc();
    const b = new Y.Doc();
    // The higher client id wins a concurrent map set, so b loses.
    a.clientID = 2;
    b.clientID = 1;
    const forward = (to: Y.Doc) => (update: Uint8Array, origin: unknown) => {
      if (origin !== 'link') Y.applyUpdate(to, update, 'link');
    };
    const note = { id: 'n', path: 'n.md' };
    openDoc(a, { ...note, content: 'abc' });
    const view = editor('abc from b');
    let ytext = openDoc(b, { ...note, content: 'abc from b' });
    bind(view, ytext);
    rebind(b, () => {
      const winner = getText(b, note.id);
      if (winner && winner !== ytext) {
        unbind(view);
        ytext = winner;
        bind(view, ytext, 'text');
      }
    });
    a.on('update', forward(b));
    b.on('update', forward(a));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'link');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'link');
    await new Promise((r) => window.setTimeout(r, 0));
    return { view, a, b, note };
  }

  it('adopts the winner when the rebind is deferred', async () => {
    const { view, a, b, note } = await lostSeed((doc, run) => observeDocs(doc, run));
    expect(view.state.doc.toString()).toBe('abc');
    expect(getText(a, note.id)!.toString()).toBe('abc');
    expect(getText(b, note.id)!.toString()).toBe('abc');
  });
});
