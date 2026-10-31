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
  /** local：自建账号密码登录；im：信任若依 IM 签发的 token */
  authMode: (readString('AUTH_MODE', 'local') === 'im' ? 'im' : 'local') as 'local' | 'im',
  im: {
    /** 若依 /getInfo 完整地址；留空则 im 模式下所有请求都会因身份服务不可用被拒绝 */
    userinfoUrl: readString('IM_USERINFO_URL', ''),
    tokenHeader: readString('IM_TOKEN_HEADER', 'Authorization'),
    tokenPrefix: readString('IM_TOKEN_PREFIX', 'Bearer '),
    timeoutMs: readNumber('IM_USERINFO_TIMEOUT_MS', 5000),
    cacheTtlMs: readNumber('IM_USER_CACHE_TTL_MS', 60_000),
  },
  // 免密登录仅供开发与 M0 压测脚本使用，生产环境默认关闭
  devLoginEnabled: readBoolean('DEV_LOGIN_ENABLED', process.env.NODE_ENV !== 'production'),
  collabShards: parseShards(readString('COLLAB_SHARDS', 'ws://localhost:1234')),
  /** 灵犀（或任意兼容接收方）的 webhook 地址；留空则只发站内通知 */
  lingxiWebhookUrl: readString('LINGXI_WEBHOOK_URL', ''),
  /** webhook 里的文档链接前缀，需与前端部署地址一致 */
  webBaseUrl: readString('WEB_BASE_URL', 'http://localhost:5173'),
  s3: {
    endPoint: readString('S3_ENDPOINT', 'localhost'),
    port: readNumber('S3_PORT', 9000),
    useSSL: readBoolean('S3_USE_SSL', false),
    accessKey: readString('S3_ACCESS_KEY', 'minioadmin'),
    secretKey: readString('S3_SECRET_KEY', 'minioadmin'),
    bucket: readString('S3_BUCKET', 'lingshu'),
  },
};
