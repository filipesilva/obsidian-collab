import { execSync } from 'node:child_process';

const wrangler = (args) => JSON.parse(execSync(`wrangler ${args} --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

const { token } = wrangler('auth token');
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID ?? wrangler('whoami').accounts[0].id;

const now = new Date();
const date = now.toISOString().slice(0, 10);

const query = `query ($accountTag: String!, $date: Date!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: { date: $date }) { sum { requests } }
    doRequests: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $date }) { sum { requests } }
    doDuration: durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { duration } }
  } }
}`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query, variables: { accountTag, date, since: `${date}T00:00:00Z`, until: now.toISOString() } }),
});
const { data, errors } = await res.json();
if (errors?.length) throw new Error(errors.map((e) => e.message).join('\n'));

const account = data.viewer.accounts[0];
const total = (groups, field) => groups.reduce((sum, g) => sum + g.sum[field], 0);

const rows = [
  ['Worker requests', total(account.workers, 'requests'), 100_000, ''],
  ['DO requests', total(account.doRequests, 'requests'), 100_000, ''],
  ['DO duration', total(account.doDuration, 'duration'), 13_000, ' GB-s'],
];

const minutesLeft = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 60_000);
console.log(`Free plan usage since 00:00 UTC, resets in ${Math.floor(minutesLeft / 60)}h ${minutesLeft % 60}m\n`);
for (const [name, used, limit, unit] of rows) {
  const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const pct = ((used / limit) * 100).toFixed(1).padStart(5);
  console.log(`${name.padEnd(16)} ${pct}%  ${fmt(used)} / ${fmt(limit)}${unit}`);
}
