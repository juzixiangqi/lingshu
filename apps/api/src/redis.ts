import { Redis } from 'ioredis';
import { ACL_EVENT_CHANNEL } from '@lingshu/shared';
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

/**
 * 通知协同分片重新校验某文档的成员角色。
 * 发布失败不影响接口结果：成员变更已落库，重连时会重新鉴权。
 */
export async function publishAclChange(documentId: string): Promise<void> {
  try {
    if (redis.status === 'wait') await redis.connect();
    await redis.publish(ACL_EVENT_CHANNEL, JSON.stringify({ documentId }));
  } catch (error) {
    console.warn('[redis] 成员变更事件发布失败', error instanceof Error ? error.message : error);
  }
}

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
