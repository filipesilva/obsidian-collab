# patches

Applied by `patch-package` on `npm install`.

- `@trystero-p2p+core`: offer pool of 3 connections instead of 20. With a
  TURN server configured every pooled connection allocates a relay at join,
  and 20 at once starve each other on a phone, so Always relay never
  connected. Upstream request for a `poolSize` option:
  https://github.com/dmotz/trystero/issues/197. Remove the patch once a
  release has it.
