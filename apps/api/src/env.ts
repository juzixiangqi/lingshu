import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { parseShards } from '@lingshu/shared';

// 读取仓库根的 .env；文件不存在时静默忽略，依赖进程环境变量
try {
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
} catch {
  // ignore
}

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === 'true';
}

export const env = {
  port: readNumber('API_PORT', 8787),
  databaseUrl: readString('DATABASE_URL', 'postgres://lingshu:lingshu@localhost:5432/lingshu'),
  redisUrl: readString('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: readString('JWT_SECRET', 'dev-only-change-me'),
  collabShards: parseShards(readString('COLLAB_SHARDS', 'ws://localhost:1234')),
  s3: {
    endPoint: readString('S3_ENDPOINT', 'localhost'),
    port: readNumber('S3_PORT', 9000),
    useSSL: readBoolean('S3_USE_SSL', false),
    accessKey: readString('S3_ACCESS_KEY', 'minioadmin'),
    secretKey: readString('S3_SECRET_KEY', 'minioadmin'),
    bucket: readString('S3_BUCKET', 'lingshu'),
  },
};
