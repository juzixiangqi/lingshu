import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * Redis 只用于 API 层缓存与（二期）跨分片 presence 可见性。
 * 设计约束：Redis 不进入协同 update/awareness 的广播热路径。
 */
export const redis = new Redis(env.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on('error', (error: Error) => {
  console.warn('[redis] 连接异常（不阻断协同热路径）', error.message);
});

export async function pingRedis(): Promise<boolean> {
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
