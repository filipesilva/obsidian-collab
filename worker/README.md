# obsidian-collab worker

A signalling server for the plugin: the smallest Nostr relay that Trystero
needs. It forwards live events between the peers subscribed to a room and
stores nothing. Every message is encrypted by the plugin with the room
secret before it gets here, so this server never sees connection details or
document content.

You do not need one. The plugin ships with public Nostr relays. Run your own
when you want signalling under your control, or for offline use on a LAN.

## Run locally

```
npm install
npm run dev
```

Add `ws://localhost:8787` to the plugin's signalling servers, or
`ws://<lan ip>:8787` with `npm run dev -- --ip 0.0.0.0` for a phone on the
same network. Replace the list with just that URL to keep a room fully
local.

The plugin's tests start this Worker themselves on port 8788.

## Deploy your own

```
npx wrangler login
npm run deploy
```

No domain is needed. The Worker gets a free `workers.dev` address, and the
first deploy asks you to pick the subdomain. Add
`wss://obsidian-collab.<subdomain>.workers.dev` to the plugin's signalling
servers. The `name` in `wrangler.jsonc` is the first label of that host.

## Keep it private

Anyone who knows the URL can use the relay, for any Trystero app. To limit it
to people you invite, set a token:

```
npx wrangler secret put RELAY_TOKEN
```

Then the relay only accepts `wss://<host>/<token>`. Use that full URL in the
signalling servers. Invite links carry it to guests, so share links only
with people who should have it.

## Cost

Runs within the Workers Free plan: 100,000 requests a day, and the Durable
Object hibernates between messages, so idle rooms cost nothing. Past the
daily limit new connections fail until midnight UTC and nothing is billed.
Staying on the Free plan is the cap.
