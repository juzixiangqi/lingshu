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
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  /** local：验本地会话 JWT；im：信任若依 IM 签发的 token */
  authMode: process.env.AUTH_MODE === 'im' ? 'im' : 'local',
  im: {
    userinfoUrl: process.env.IM_USERINFO_URL ?? '',
    tokenHeader: process.env.IM_TOKEN_HEADER ?? 'Authorization',
    // 前缀对空格敏感，不能用 trim 过的通用读取
    tokenPrefix: process.env.IM_TOKEN_PREFIX ?? 'Bearer ',
    timeoutMs: readNumber('IM_USERINFO_TIMEOUT_MS', 5000),
    cacheTtlMs: readNumber('IM_USER_CACHE_TTL_MS', 60_000),
  },
  maxDocConnections: readNumber('COLLAB_MAX_DOC_CONNECTIONS', 200),
  awarenessThrottleMs: readNumber('AWARENESS_THROTTLE_MS', 40),
};
