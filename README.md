# Obsidian Collab

Peer-to-peer collaborative editing sessions for Obsidian notes.
Yjs CRDT over WebRTC. No server ever holds document data.

See [TODO.md](TODO.md) for the plan.

## Development

```
npm install
npm run test-deps  # downloads chromium for the tests
npm run dev     # esbuild watch
npm run build   # typecheck and bundle main.js
npm test        # vitest in headless Chromium
npm run lint
```

Tests run in a real browser with no Node globals, because Obsidian mobile
has none. The build bundles every dependency, including Node builtins, so a
dependency that needs Node fails at build time instead of on a phone.
