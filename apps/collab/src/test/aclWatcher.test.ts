import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACL_EVENT_CHANNEL } from '@lingshu/shared';
import { closeCollabDatabase, resetCollabDatabase, setupCollabDatabase } from './db.js';

let query: typeof import('../db.js').query;
let addLiveConnection: typeof import('../impl/liveConnections.js').addLiveConnection;
let removeLiveConnection: typeof import('../impl/liveConnections.js').removeLiveConnection;
let startAclWatcher: typeof import('../impl/aclWatcher.js').startAclWatcher;
let env: { redisUrl: string };
let subscriber: Redis;
let publisher: Redis;

beforeAll(async () => {
  await setupCollabDatabase();
  query = (await import('../db.js')).query;
  ({ addLiveConnection, removeLiveConnection } = await import('../impl/liveConnections.js'));
  ({ startAclWatcher } = await import('../impl/aclWatcher.js'));
  env = (await import('../env.js')).env;
});

afterAll(async () => {
  await closeCollabDatabase();
});

beforeEach(async () => {
  await resetCollabDatabase();
  subscriber = startAclWatcher();
  publisher = new Redis(env.redisUrl);
  await new Promise<void>((resolve) => {
    if (subscriber.status === 'ready') {
      resolve();
      return;
    }
    subscriber.once('ready', () => resolve());
  });
  // 确保订阅命令已完成（startAclWatcher 在 ready 时也会订阅一次）。
  await subscriber.subscribe(ACL_EVENT_CHANNEL);
});

afterEach(() => {
  subscriber.disconnect();
  publisher.disconnect();
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待 ACL 事件处理超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seedMembership(role: 'owner' | 'editor' | 'spectator') {
  const userId = randomUUID();
  const documentId = randomUUID();
  await query(`insert into users (id, email, display_name) values ($1, $2, '成员')`, [
    userId,
    `${userId}@example.com`,
  ]);
  await query(`insert into documents (id, owner_id, kind, title) values ($1, $2, 'doc', '文档')`, [
    documentId,
    userId,
  ]);
  await query(
    `insert into doc_members (document_id, user_id, role) values ($1, $2, $3)`,
    [documentId, userId, role],
  );
  return { userId, documentId };
}

describe('startAclWatcher', () => {
  it('收到成员变更事件后重新校验并断开角色已变化的连接', async () => {
    const { userId, documentId } = await seedMembership('editor');
    const connection = { socketId: 'socket-acl', close: vi.fn() } as any;
    addLiveConnection({
      socketId: 'socket-acl',
      documentId,
      userId,
      role: 'editor',
      connection,
    });

    // 先发送非法消息与无关通道，均不应触发断开
    await publisher.publish(ACL_EVENT_CHANNEL, 'not-json');
    await publisher.publish(ACL_EVENT_CHANNEL, JSON.stringify({ documentId: 123 }));
    await publisher.publish('other:channel', JSON.stringify({ documentId }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connection.close).not.toHaveBeenCalled();

    // 角色由 editor 变为 spectator 后发布事件
    await query('update doc_members set role = $2 where document_id = $1 and user_id = $3', [
      documentId,
      'spectator',
      userId,
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await publisher.publish(ACL_EVENT_CHANNEL, JSON.stringify({ documentId }));

    await waitFor(() => connection.close.mock.calls.length > 0);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();

    removeLiveConnection(documentId, 'socket-acl');
  });

  it('成员被移除的事件同样会断开在线连接', async () => {
    const { userId, documentId } = await seedMembership('editor');
    const connection = { socketId: 'socket-removed', close: vi.fn() } as any;
    addLiveConnection({
      socketId: 'socket-removed',
      documentId,
      userId,
      role: 'editor',
      connection,
    });

    await query('delete from doc_members where document_id = $1 and user_id = $2', [
      documentId,
      userId,
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await publisher.publish(ACL_EVENT_CHANNEL, JSON.stringify({ documentId }));

    await waitFor(() => connection.close.mock.calls.length > 0);
    expect(connection.close).toHaveBeenCalledTimes(1);
    log.mockRestore();

    removeLiveConnection(documentId, 'socket-removed');
  });
});
