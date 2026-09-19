import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// `npm test` runs the fast tests with no servers. `npm run test-network`
// runs the network tests against a local relay and TURN server, plus the
// public relay tests, and takes a few minutes.
const network = process.env.VITEST_NETWORK === '1';
const networkFiles = ['src/network.test.ts', 'src/nat.test.ts'];

export default defineConfig({
  test: {
    include: network ? networkFiles : ['src/**/*.test.ts'],
    exclude: network ? [] : [...networkFiles, '**/node_modules/**'],
    globalSetup: network ? ['test/start-worker.ts'] : [],
    // Trystero logs the other side's close as an error. Show console output only when a test fails.
    silent: 'passed-only',
    browser: {
      enabled: true,
      headless: true,
      // Real local IPs in ICE candidates, so the test TURN server can relay to them.
      provider: playwright({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
