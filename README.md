# Obsidian Collab

Peer-to-peer collaborative editing of Obsidian files and folders.
Yjs CRDT over WebRTC. No server ever holds document data.

See [TODO.md](TODO.md) for the plan.

Peers see each other's cursor and selection, with the name set in the plugin
settings. The name and cursor go only to the peers of a collab, the same way
edits do.

## Connectivity

Edits travel directly between peers over WebRTC data channels, encrypted end
to end. Three kinds of servers help set that connection up. All of them are
configurable in the plugin settings, and none can read a note.

### Signalling

Peers find each other through Nostr relays. The plugin ships with the public
relays that [Trystero](https://github.com/dmotz/trystero) uses. A shared
file or folder dials a few of them, and its URL tells guests which, so both
sides meet. Relays see your IP address, an id and encrypted connection
offers.

To run your own, deploy the Worker in [worker/](worker/README.md), or use
any Nostr relay, and put its URL in the list. Leave only that URL to keep a
shared file or folder on your relay alone, including offline on a LAN. Reset
restores the default list.

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

The **Check network** command tells you whether this network needs one, and
the plugin says so on its own when you connect without TURN configured.
If it does, get TURN credentials and fill in the URL, username and
credential. A note session moves kilobytes, so any free tier is plenty:

- [ExpressTURN](https://www.expressturn.com/): 100 GB a month, no card.
- [Metered Open Relay](https://www.metered.ca/tools/openrelay/): 0.5 GB a
  month, 20 GB with a card on file, and it stops rather than bills.
- [Xirsys](https://xirsys.com/): 0.5 GB a month.

Or run [coturn](https://github.com/coturn/coturn) on a machine with a
public IP. Cloudflare's TURN only issues short-lived credentials, so it
needs a small service to mint them and is not supported yet.

## Development

```
npm install
npm run test-deps  # downloads chromium for the tests
npm run dev     # esbuild watch
npm run build   # typecheck and bundle main.js
npm test        # fast tests in headless Chromium, no servers
npm run test-network  # network tests: local relay and TURN, plus public relays
npm run lint
npm run e2e     # end to end, drives two open dev vaults through the checklist
```

Tests run in a real browser with no Node globals, because Obsidian mobile
has none. The build bundles every dependency, including Node builtins, so a
dependency that needs Node fails at build time instead of on a phone.
