import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { pingDatabase } from './db.js';
import { pingRedis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { docsRoutes } from './routes/docs.js';
import { notificationsRoutes } from './routes/notifications.js';

const app = new Hono();

app.use('/api/*', cors());

app.get('/', (c) => c.json({ service: 'lingshu-api', shards: env.collabShards }));

app.get('/api/health', async (c) => {
  const [db, cache] = await Promise.all([pingDatabase(), pingRedis()]);
  return c.json({
    ok: db,
    db,
    redis: cache,
    storage: { bucket: env.s3.bucket, endpoint: `${env.s3.endPoint}:${env.s3.port}` },
    shards: env.collabShards,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.route('/api/auth', authRoutes);
app.route('/api/docs', docsRoutes);
app.route('/api/notifications', notificationsRoutes);

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] received ${signal}, shutting down`);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
