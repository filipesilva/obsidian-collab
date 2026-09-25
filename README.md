# Obsidian Collab

Peer-to-peer collaborative editing of Obsidian files and folders.
Yjs CRDT over WebRTC. No server ever holds document data.

Peers see each other's cursor and selection, with the name set in the plugin
settings. The name and cursor go only to the peers of a collab, the same way
edits do.

## Use

Everyone who edits needs the plugin.

1. Open a note and run **Share file**. Its URL is copied, and kept in the
   note's `collab-url` property.
2. Send the URL to the others.
3. They select the link, or paste it into **Open collab URL**. The note is
   created in their vault and opened.

To share a folder, right-click it and select **Share folder**. Every Markdown
file in it syncs, other files do not. The URL is kept in a `collab.md` note
in the folder, and the others get the folder at the same path.

Edits sync while at least two of you are connected. After a restart, run
**Connect file** or **Connect folder** to connect again.

## Connectivity

Edits travel directly between peers over WebRTC data channels, encrypted end
to end. Three kinds of servers help set that connection up. All of them are
configurable in the plugin settings, and none can read a note.

### Signalling

Peers find each other through Nostr relays. A shared file or folder dials
five of them, and its URL tells guests which, so both sides meet. Relays see
your IP address, an id and encrypted connection offers.

There are two lists. **Community Collab relays** are run for Collab by its
users, and a new share takes every one of them that answers. The list starts
with `wss://obsidian-collab.filipesilva.workers.dev`, the plugin author's
deployment of the Worker in [worker/](worker/README.md). **Public Nostr
relays** fill it up to five. The public list starts as the relays that
[Trystero](https://github.com/dmotz/trystero) uses.

To run your own, deploy the Worker in [worker/](worker/README.md), or use
any Nostr relay, and put its URL in **Community Collab relays**. To keep a
shared file or folder on your relay alone, including offline on a LAN, make
it the only line in **Community Collab relays** and empty **Public Nostr
relays**. Reset restores both lists.

A share's URL fixes its relays. To move a share to other relays, or to lock
out someone who has the URL, one peer runs **Regenerate file URL** or
**Regenerate folder URL**. That picks relays from their settings again and
makes a new secret, under the same id, so everyone's notes, history and
offline edits carry over. The old URL stops working. The other peers paste
the new URL into **Open collab URL** or open it, and it replaces the one
they had.

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
npm run e2e     # end to end in test-vaults/one, two and three; needs Obsidian running and npm run build
```

Tests run in a real browser with no Node globals, because Obsidian mobile
has none. The build bundles every dependency, including Node builtins, so a
dependency that needs Node fails at build time instead of on a phone.
