import { Redis } from 'ioredis';
import { ACL_EVENT_CHANNEL, type AclChangeEvent } from '@lingshu/shared';
import { env } from '../env.js';
import { syncDocumentMembership } from './liveConnections.js';

/**
 * 订阅 API 的成员变更事件。
 * 该通道只承载低频 ACL 控制消息，不进入 update/awareness 广播热路径；
 * Redis 不可用时订阅会持续重试，成员变更仍然落库，重连时重新鉴权即可生效。
 */
export function startAclWatcher(): Redis {
  const subscriber = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  });

  subscriber.on('error', (error: Error) => {
    console.warn('[collab] ACL 订阅连接异常', error.message);
  });

  subscriber.on('ready', () => {
    void subscriber
      .subscribe(ACL_EVENT_CHANNEL)
      .then(() => console.log(`[collab] ACL 订阅已启用（${ACL_EVENT_CHANNEL}）`))
      .catch((error: unknown) => console.warn('[collab] ACL 订阅失败', error));
  });

  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== ACL_EVENT_CHANNEL) return;
    try {
      const event = JSON.parse(message) as AclChangeEvent;
      if (typeof event.documentId !== 'string') return;
      void syncDocumentMembership(event.documentId).catch((error: unknown) => {
        console.warn('[collab] 成员权限重新校验失败', error);
      });
    } catch {
      // 忽略非法消息
    }
  });

  void subscriber.connect().catch((error: unknown) => {
    console.warn('[collab] ACL 订阅初始连接失败，将后台重试', error);
  });

  return subscriber;
}
