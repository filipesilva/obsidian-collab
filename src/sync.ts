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
// room does not have it yet. The file always wins over whatever state the
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

export interface Change {
  from: number;
  to: number;
  insert: string;
}

// Minimal edits that turn before into after, positioned in before.
export function diffChanges(before: string, after: string): Change[] {
  const changes: Change[] = [];
  let pos = 0;
  for (const [op, chunk] of diff(before, after)) {
    if (op === diff.INSERT) {
      changes.push({ from: pos, to: pos, insert: chunk });
    } else if (op === diff.DELETE) {
      changes.push({ from: pos, to: pos + chunk.length, insert: '' });
      pos += chunk.length;
    } else {
      pos += chunk.length;
    }
  }
  return changes;
}

export function applyContent(text: Y.Text, content: string): void {
  const current = text.toString();
  if (current === content) return;
  if (!text.doc) throw new Error('text is not attached to a doc');
  text.doc.transact(() => {
    let shift = 0;
    for (const { from, to, insert } of diffChanges(current, content)) {
      if (to > from) text.delete(from + shift, to - from);
      if (insert) text.insert(from + shift, insert);
      shift += insert.length - (to - from);
    }
  });
}

// Calls back with the ids whose entry changed, after the Yjs transaction has
// fully settled. Binding an editor inside the transaction would let it replay
// events from before it was attached.
export function observeDocs(ydoc: Y.Doc, cb: (id: string) => void): () => void {
  const observer = (event: Y.YMapEvent<DocEntry>) => {
    const ids = [...(event.keysChanged as Set<string>)];
    queueMicrotask(() => ids.forEach(cb));
  };
  docs(ydoc).observe(observer);
  return () => docs(ydoc).unobserve(observer);
}
