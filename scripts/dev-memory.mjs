// `npm run dev:memory` — runs the API against an in-memory MongoDB with the
// dev login bypass on, for working on the app before Atlas is set up. Data is
// lost when it stops.
import { startLocalServer } from './local-server.mjs';

const port = Number(process.env.PORT || 3000);
const server = await startLocalServer({ port });
console.log(`In-memory MongoDB at ${server.mongoUri}`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
