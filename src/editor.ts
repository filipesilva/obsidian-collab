import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { yCollab, ySyncAnnotation, ySyncFacet } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { applyContent, diffChanges } from './sync';

const compartment = new Compartment();

// Register once with the plugin so every editor state carries the compartment.
export const collabExtension: Extension = compartment.of([]);

// Keep remote changes out of the editor's undo history.
const skipRemoteHistory = EditorState.transactionExtender.of((tr) =>
  tr.annotation(ySyncAnnotation) ? { annotations: Transaction.addToHistory.of(false) } : null,
);

export type Winner = 'editor' | 'text';

// The two must agree before they are joined. The editor is the freshest
// local copy and wins on resume; the text wins when joining a live doc.
// With awareness, peers see each other's cursor and selection.
export function bind(view: EditorView, ytext: Y.Text, winner: Winner = 'editor', awareness: Awareness | null = null): void {
  if (winner === 'editor') {
    applyContent(ytext, view.state.doc.toString());
  } else {
    const changes = diffChanges(view.state.doc.toString(), ytext.toString());
    if (changes.length) view.dispatch({ changes });
  }
  view.dispatch({
    effects: compartment.reconfigure([yCollab(ytext, awareness, { undoManager: false }), skipRemoteHistory]),
  });
}

// y-codemirror leaves the cursor where it was, so peers would keep seeing
// it in a note that is no longer open.
export function unbind(view: EditorView): void {
  const { ytext, awareness } = (view.state.facet(ySyncFacet) ?? {}) as { ytext?: Y.Text; awareness?: Awareness | null };
  const cursor = awareness?.getLocalState()?.cursor as { head: unknown } | undefined;
  if (awareness && ytext?.doc && cursor) {
    const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), ytext.doc);
    if (!head || head.type === ytext) awareness.setLocalStateField('cursor', null);
  }
  view.dispatch({ effects: compartment.reconfigure([]) });
}

export function isBound(view: EditorView, ytext: Y.Text): boolean {
  return (view.state.facet(ySyncFacet) as { ytext?: Y.Text } | undefined)?.ytext === ytext;
}
