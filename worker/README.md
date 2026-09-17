# obsidian-collab worker

Signaling and TURN credentials for the plugin. One Durable Object per room
forwards opaque y-webrtc signaling messages between the peers in it. Every
message is encrypted by the plugin with the session secret before it gets
here, so this server never sees connection details or document content and
never stores anything.

Routes:

- `wss://<host>/room/<id>`: signaling websocket for one room.
- `https://<host>/ice`: ICE server list. STUN only, unless TURN secrets are set.

## Run locally

```
npm install
npm run dev
```

Point the plugin at `ws://localhost:8787`, or at `ws://<lan ip>:8787` with
`npm run dev -- --ip 0.0.0.0` for a phone on the same network.

## Deploy your own

```
npx wrangler login
npm run deploy
```

Then set the plugin's server to `wss://<worker host>`.

TURN is optional. Without it, peers behind strict NATs may fail to connect.
Create a TURN key in the Cloudflare dashboard under Realtime, then:

```
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

`/ice` then returns short-lived TURN credentials, cached for an hour.

## Cost

Signaling runs within the Workers Free plan: 100,000 requests a day, and
the Durable Object hibernates between messages, so idle rooms cost nothing.
Past the daily limit new connections fail until midnight UTC and nothing is
billed. Staying on the Free plan is the cap.

TURN is part of Cloudflare Realtime, which asks for a payment method even
though the first 1,000 GB a month are free and a session moves kilobytes.
There is no hard cap on it. Set a budget alert at a low value in the billing
dashboard; it emails a day late but is the only signal. Deleting the TURN key
invalidates every outstanding credential at once.
