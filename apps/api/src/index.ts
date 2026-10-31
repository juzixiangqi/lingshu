import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './env.js';

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] received ${signal}, shutting down`);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
