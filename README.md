# Obsidian Collab

Peer-to-peer collaborative editing rooms for Obsidian notes.
Yjs CRDT over WebRTC. No server ever holds document data.

See [TODO.md](TODO.md) for the plan.

## Connectivity

Edits travel directly between peers over WebRTC data channels, encrypted end
to end. Three kinds of servers help set that connection up. All of them are
configurable in the plugin settings, and none can read a note.

### Signalling

Peers find each other through Nostr relays. The plugin ships with the public
relays that [Trystero](https://github.com/dmotz/trystero) uses. A room
dials a few of them, and the invite link tells guests which, so both sides
meet. Relays see your IP address, a room id and encrypted connection offers.

To run your own, deploy the Worker in [worker/](worker/README.md), or use
any Nostr relay, and put its URL in the list. Leave only that URL to keep a
room on your relay alone, including offline on a LAN. Reset restores the
default list.

### STUN

STUN servers tell a peer its public address so the other side can reach it.
They are stateless and free, and the defaults are public ones from Google
and Cloudflare. Any STUN server works, for example a self-hosted
[coturn](https://github.com/coturn/coturn).

### TURN

When a direct connection fails, usually on mobile networks or behind strict
firewalls, a TURN server relays the encrypted traffic. Only the peer on the
strict network needs one, and it fixes every connection that peer makes. Most
people never need it.

If rooms fail to connect, get TURN credentials and fill them in. The
[Open Relay](https://www.metered.ca/tools/openrelay/) free tier works, or
run [coturn](https://github.com/coturn/coturn) on a machine with a public IP.

## Development

```
npm install
npm run test-deps  # downloads chromium for the tests
npm run dev     # esbuild watch
npm run build   # typecheck and bundle main.js
npm test        # vitest in headless Chromium, offline
npm run test-online  # also the test that uses public relays
npm run lint
```

Tests run in a real browser with no Node globals, because Obsidian mobile
has none. The build bundles every dependency, including Node builtins, so a
dependency that needs Node fails at build time instead of on a phone.
