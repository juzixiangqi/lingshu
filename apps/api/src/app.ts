import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { pingDatabase } from './db.js';
import { pingRedis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { commentsRoutes } from './routes/comments.js';
import { docsRoutes } from './routes/docs.js';
import { fileRoutes } from './routes/files.js';
import { internalAdminRoutes } from './routes/internalAdmin.js';
import { notificationsRoutes } from './routes/notifications.js';

/**
 * 依赖不可用时统一返回 503，而不是把 pg/ioredis 的原始堆栈当成 500 文本抛给前端。
 * 这些错误码覆盖：连接被拒/被重置、超时，以及 PostgreSQL 的关停与连接数耗尽。
 */
const INFRA_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

export function isInfraError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && INFRA_ERROR_CODES.has(code);
}

export const app = new Hono();

app.use('/api/*', cors());

app.get('/', (c) => c.json({ service: 'lingshu-api', shards: env.collabShards }));

/**
 * 健康检查只把“主库不可用”视为不健康。
 * Redis 只承载低频 ACL 事件与缓存，掉线时协同热路径不受影响，因此标记为降级而非故障。
 */
export async function healthHandler(c: Context) {
  const [db, cache] = await Promise.all([pingDatabase(), pingRedis()]);
  return c.json({
    ok: db,
    db,
    redis: cache,
    degraded: db && !cache,
    storage: { bucket: env.s3.bucket, endpoint: `${env.s3.endPoint}:${env.s3.port}` },
    shards: env.collabShards,
    uptimeSeconds: Math.round(process.uptime()),
  });
}

export function appErrorHandler(error: Error, c: Context) {
  console.error(`[api] 请求处理失败 ${c.req.method} ${c.req.path}`, error);
  if (isInfraError(error)) {
    return c.json({ error: '依赖服务暂不可用，请稍后重试' }, 503);
  }
  return c.json({ error: '服务器内部错误' }, 500);
}

app.get('/api/health', healthHandler);

app.onError(appErrorHandler);

app.route('/api/auth', authRoutes);
app.route('/api/docs', docsRoutes);
// 评论与文档同前缀，Hono 允许同一 basePath 挂多个子路由
app.route('/api/docs', commentsRoutes);
app.route('/api/files', fileRoutes);
app.route('/api/notifications', notificationsRoutes);
// 管理端接口：不对浏览器暴露，鉴权与用户 token 完全隔离
app.route('/internal/admin', internalAdminRoutes);
