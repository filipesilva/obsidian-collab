# patches

Applied by `patch-package` on `npm install`.

- `@trystero-p2p+core`: offer pool of 3 connections instead of 20. With a
  TURN server configured every pooled connection allocates a relay at join,
  and 20 at once starve each other on a phone, so Always relay never
  connected. Upstream request for a `poolSize` option:
  https://github.com/dmotz/trystero/issues/197. Remove the patch once a
  release has it.
- `@trystero-p2p+core`: a shared connection that closes or errors is also
  destroyed. Trystero only dropped it from its books, so when the other
  side left first ours stayed open, two per regenerated URL, until the
  window hit its limit of peer connections.
- `y-codemirror.next`: remote changes are dispatched with `filter: false`.
  With properties shown, Obsidian drops an edit inside the frontmatter
  while the cursor is in it, so a peer's property change never reached the
  editor, which then drifted from the shared text for good.
