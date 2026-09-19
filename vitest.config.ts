import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Trystero logs the other side's close as an error. Show console output only when a test fails.
    silent: 'passed-only',
    globalSetup: ['test/start-worker.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
