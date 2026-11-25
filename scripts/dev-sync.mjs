import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'vite';

const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 15000);

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

async function startServer() {
  const server = await createServer();
  await server.listen();
  server.printUrls();
  return server;
}

let server = await startServer();

while (true) {
  await sleep(INTERVAL_MS);

  const before = git('rev-parse', 'HEAD');
  try {
    git('pull', '-q', '--ff-only');
  } catch (e) {
    console.warn(`[sync] pull failed: ${e.stderr?.trim() || e.message}`);
    continue;
  }
  const after = git('rev-parse', 'HEAD');
  if (before === after) continue;

  console.log(`[sync] ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);

  const changed = git('diff', '--name-only', before, after).split('\n');
  if (changed.includes('package.json') || changed.includes('package-lock.json')) {
    console.log('[sync] dependencies changed, reinstalling');
    execFileSync('npm', ['install'], { stdio: 'inherit' });
    await server.close();
    server = await startServer();
  }
}
