import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

try {
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
} catch {
  // ignore
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  shardId: argValue('shard') ?? process.env.SHARD_ID ?? 'shard-a',
  port: Number(argValue('port') ?? process.env.COLLAB_PORT ?? 1234),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://lingshu:lingshu@localhost:5432/lingshu',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  maxDocConnections: readNumber('COLLAB_MAX_DOC_CONNECTIONS', 200),
  awarenessThrottleMs: readNumber('AWARENESS_THROTTLE_MS', 40),
};
