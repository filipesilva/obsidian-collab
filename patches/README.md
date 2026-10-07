# patches

Applied by `patch-package` on `npm install`.

- `@trystero-p2p/core`: every room joins its own relays. Trystero opened
  relays only for the first room and gave every room joined while it was
  open the same ones, so a second share whose URL names other relays never
  met its peers. Relays are shared by URL, so this opens no extra sockets.
  Remove the patch once upstream uses each room's relay config.
- `y-codemirror.next`: remote changes are dispatched with `filter: false`.
  With properties shown, Obsidian drops an edit inside the frontmatter
  while the cursor is in it, so a peer's property change never reached the
  editor, which then drifted from the shared text for good.
