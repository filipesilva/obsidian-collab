import diff from 'fast-diff';
import * as Y from 'yjs';

export type DocEntry = Y.Map<string | Y.Text>;

export interface DocInfo {
  id: string;
  path: string;
  content: string;
}

export function docs(ydoc: Y.Doc): Y.Map<DocEntry> {
  return ydoc.getMap('docs');
}

export function getText(ydoc: Y.Doc, id: string): Y.Text | undefined {
  return docs(ydoc).get(id)?.get('text') as Y.Text | undefined;
}

// Returns the shared text for a doc, seeding it from the file when the
// session does not have it yet. The file always wins over whatever state the
// text has at call time. Call again after a sync to rebind if a concurrent seed
// on another peer won.
export function openDoc(ydoc: Y.Doc, info: DocInfo): Y.Text {
  const existing = getText(ydoc, info.id);
  if (existing) {
    applyContent(existing, info.content);
    return existing;
  }
  const entry: DocEntry = new Y.Map();
  ydoc.transact(() => {
    docs(ydoc).set(info.id, entry);
    entry.set('path', info.path);
    entry.set('text', new Y.Text(info.content));
  });
  return entry.get('text') as Y.Text;
}

export function applyContent(text: Y.Text, content: string): void {
  const current = text.toString();
  if (current === content) return;
  const ops = diff(current, content);
  if (!text.doc) throw new Error('text is not attached to a doc');
  text.doc.transact(() => {
    let index = 0;
    for (const [op, chunk] of ops) {
      if (op === diff.INSERT) {
        text.insert(index, chunk);
        index += chunk.length;
      } else if (op === diff.DELETE) {
        text.delete(index, chunk.length);
      } else {
        index += chunk.length;
      }
    }
  });
}
