import { spawn } from 'node:child_process';

// Boots the signalling Worker and a local STUN and TURN server so browser
// tests run offline against them.
export const WORKER_PORT = 8788;

export default async function startWorker(): Promise<() => void> {
  const turn = spawn(process.execPath, ['test/turn-server.mjs'], { stdio: 'ignore', detached: true });
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(WORKER_PORT), '--inspector-port', '0'], {
    cwd: 'worker',
    stdio: 'ignore',
    detached: true,
  });
  const kill = (pid: number | undefined) => {
    try {
      if (pid) process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  const stop = () => {
    kill(turn.pid);
    kill(child.pid);
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
