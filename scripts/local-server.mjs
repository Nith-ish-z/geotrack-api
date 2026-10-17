// Shared by dev-memory.mjs and smoke-test.mjs: boots a throwaway in-memory
// MongoDB and a Next.js dev server pointed at it.
import { spawn, spawnSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';

export const DEV_ENV = {
  MONGODB_DB: 'geotracker',
  JWT_SECRET: 'local-development-secret-not-for-production-use',
};

export async function startLocalServer({ port, stdio = 'inherit' }) {
  const mongo = await MongoMemoryServer.create();
  const env = {
    ...process.env,
    ...DEV_ENV,
    MONGODB_URI: mongo.getUri(),
  };
  const next = spawn(`npx next dev --port ${Number(port)}`, {
    env,
    stdio,
    shell: true,
  });

  const stop = async () => {
    // `shell: true` wraps Next in a shell on Windows, so kill the whole tree.
    if (process.platform === 'win32') {
      // Synchronous: callers exit right after stop(), which would otherwise
      // cut the kill short and leave the dev server running.
      spawnSync('taskkill', ['/pid', String(next.pid), '/T', '/F']);
    } else {
      next.kill('SIGTERM');
    }
    await mongo.stop();
  };

  return {
    mongoUri: mongo.getUri(),
    baseUrl: `http://localhost:${port}`,
    stop,
  };
}

export async function waitUntilReady(baseUrl, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Server at ${baseUrl} did not start in time`);
}
