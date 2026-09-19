import { spawn } from 'node:child_process';

// Boots the signaling Worker so browser tests run offline against it.
export const WORKER_PORT = 8788;

export default async function startWorker(): Promise<() => void> {
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(WORKER_PORT), '--inspector-port', '0'], {
    cwd: 'worker',
    stdio: 'ignore',
    detached: true,
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://localhost:${WORKER_PORT}/`);
      if (res.ok) return stop;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error('signaling worker did not start');
}
