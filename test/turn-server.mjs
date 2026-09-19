// A local STUN and TURN server for the tests, run as its own process so it
// can be killed cleanly. Credentials collab/collab on port 3479. Relays on
// the machine's LAN address: a loopback relay address is not usable as a
// remote candidate.
import { networkInterfaces } from 'node:os';
import Turn from 'node-turn';

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

new Turn({
  listeningPort: 3479,
  listeningIps: ['0.0.0.0'],
  relayIps: [lan ?? '127.0.0.1'],
  authMech: 'long-term',
  credentials: { collab: 'collab' },
  debugLevel: 'FATAL',
}).start();
