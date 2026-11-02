import { pool } from './db.js';
import { env } from './env.js';
import { startAclWatcher } from './impl/aclWatcher.js';
import { startShardHeartbeat } from './impl/shardHeartbeat.js';
import { createCollabServer } from './server.js';

const server = createCollabServer();
const instance = await server.listen(env.port);
startAclWatcher();
const heartbeat = startShardHeartbeat(instance);

console.log(
  `[collab] shard=${env.shardId} listening ws://localhost:${env.port} ` +
    `单文档连接上限=${env.maxDocConnections} awareness间隔=${env.awarenessThrottleMs}ms`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[collab] received ${signal}, flushing snapshots`);
  await heartbeat.stop().catch(() => undefined);
  await server.destroy().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
