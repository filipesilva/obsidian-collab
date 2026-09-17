import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { yCollab, ySyncAnnotation, ySyncFacet } from 'y-codemirror.next';
import type * as Y from 'yjs';
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
export function bind(view: EditorView, ytext: Y.Text, winner: Winner = 'editor'): void {
  if (winner === 'editor') {
    applyContent(ytext, view.state.doc.toString());
  } else {
    const changes = diffChanges(view.state.doc.toString(), ytext.toString());
    if (changes.length) view.dispatch({ changes });
  }
  view.dispatch({
    effects: compartment.reconfigure([yCollab(ytext, null, { undoManager: false }), skipRemoteHistory]),
  });
}

export function unbind(view: EditorView): void {
  view.dispatch({ effects: compartment.reconfigure([]) });
}

export function isBound(view: EditorView, ytext: Y.Text): boolean {
  return (view.state.facet(ySyncFacet) as { ytext?: Y.Text } | undefined)?.ytext === ytext;
}
