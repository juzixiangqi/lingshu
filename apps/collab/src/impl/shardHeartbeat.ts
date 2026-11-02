import { Redis } from 'ioredis';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  SHARD_HEALTH_KEY_PREFIX,
  SHARD_HEARTBEAT_INTERVAL_MS,
  SHARD_HEARTBEAT_TTL_SECONDS,
  type ShardHeartbeat,
} from '@lingshu/shared';
import { env } from '../env.js';

export interface ShardHeartbeatHandle {
  stop: () => Promise<void>;
}

/**
 * 定期把分片运行状态写入 Redis，供管理端聚合“运行状态”页。
 * Redis 掉线只影响管理端观测，不影响协同热路径；下个周期会自动续上。
 */
export function startShardHeartbeat(instance: Hocuspocus): ShardHeartbeatHandle {
  const client = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  });

  client.on('error', (error: Error) => {
    console.warn('[collab] 心跳连接异常', error.message);
  });

  const key = `${SHARD_HEALTH_KEY_PREFIX}${env.shardId}`;
  const startedAt = new Date().toISOString();

  const publish = (): void => {
    const payload: ShardHeartbeat = {
      shardId: env.shardId,
      port: env.port,
      documents: instance.getDocumentsCount(),
      connections: instance.getConnectionsCount(),
      startedAt,
      at: new Date().toISOString(),
    };
    void client
      .set(key, JSON.stringify(payload), 'EX', SHARD_HEARTBEAT_TTL_SECONDS)
      .catch(() => undefined);
  };

  // 断线重连成功后也要立刻续一次，避免等待下一个定时周期
  client.on('ready', publish);

  if (client.status === 'wait') {
    void client
      .connect()
      .then(publish)
      .catch((error: unknown) => console.warn('[collab] 心跳初始连接失败，将后台重试', error));
  }

  const timer = setInterval(publish, SHARD_HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      await client.del(key).catch(() => undefined);
      client.disconnect();
    },
  };
}
