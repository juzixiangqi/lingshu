import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeCollabDatabase, resetCollabDatabase, setupCollabDatabase } from './db.js';

let query: typeof import('../db.js').query;
let addLiveConnection: typeof import('../impl/liveConnections.js').addLiveConnection;
let removeLiveConnection: typeof import('../impl/liveConnections.js').removeLiveConnection;
let syncDocumentMembership: typeof import('../impl/liveConnections.js').syncDocumentMembership;

beforeAll(async () => {
  await setupCollabDatabase();
  query = (await import('../db.js')).query;
  ({ addLiveConnection, removeLiveConnection, syncDocumentMembership } = await import(
    '../impl/liveConnections.js'
  ));
});

afterAll(async () => {
  await closeCollabDatabase();
});

beforeEach(async () => {
  await resetCollabDatabase();
});

interface Seed {
  documentId: string;
  users: { id: string; role: 'owner' | 'editor' | 'spectator' }[];
}

async function seedDocument(roles: Seed['users']): Promise<Seed> {
  const ownerId = roles[0]!.id;
  const documentId = randomUUID();
  for (const user of roles) {
    await query(`insert into users (id, email, display_name) values ($1, $2, '成员')`, [
      user.id,
      `${user.id}@example.com`,
    ]);
  }
  await query(
    `insert into documents (id, owner_id, kind, title) values ($1, $2, 'doc', '在线文档')`,
    [documentId, ownerId],
  );
  for (const user of roles) {
    await query(
      `insert into doc_members (document_id, user_id, role) values ($1, $2, $3)`,
      [documentId, user.id, user.role],
    );
  }
  return { documentId, users: roles };
}

function fakeConnection(socketId: string) {
  return { socketId, close: vi.fn() } as any;
}

describe('syncDocumentMembership', () => {
  it('没有在线连接时直接返回', async () => {
    await expect(syncDocumentMembership(randomUUID())).resolves.toBeUndefined();
  });

  it('角色未变化时不断开连接', async () => {
    const user = randomUUID();
    const { documentId } = await seedDocument([{ id: user, role: 'editor' }]);
    const connection = fakeConnection('socket-1');
    addLiveConnection({ socketId: 'socket-1', documentId, userId: user, role: 'editor', connection });

    await syncDocumentMembership(documentId);
    expect(connection.close).not.toHaveBeenCalled();

    removeLiveConnection(documentId, 'socket-1');
  });

  it('角色变更与被移除的成员连接会被关闭', async () => {
    const changedUser = randomUUID();
    const removedUser = randomUUID();
    const stableUser = randomUUID();
    const { documentId } = await seedDocument([
      { id: randomUUID(), role: 'owner' },
      { id: changedUser, role: 'editor' },
      { id: removedUser, role: 'spectator' },
      { id: stableUser, role: 'editor' },
    ]);

    const changedConnection = fakeConnection('socket-changed');
    const removedConnection = fakeConnection('socket-removed');
    const stableConnection = fakeConnection('socket-stable');
    addLiveConnection({
      socketId: 'socket-changed',
      documentId,
      userId: changedUser,
      role: 'editor',
      connection: changedConnection,
    });
    addLiveConnection({
      socketId: 'socket-removed',
      documentId,
      userId: removedUser,
      role: 'spectator',
      connection: removedConnection,
    });
    addLiveConnection({
      socketId: 'socket-stable',
      documentId,
      userId: stableUser,
      role: 'editor',
      connection: stableConnection,
    });

    // 角色由 editor 改为 spectator、另一个成员被移除
    await query('update doc_members set role = $2 where document_id = $1 and user_id = $3', [
      documentId,
      'spectator',
      changedUser,
    ]);
    await query('delete from doc_members where document_id = $1 and user_id = $2', [
      documentId,
      removedUser,
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await syncDocumentMembership(documentId);
    expect(changedConnection.close).toHaveBeenCalledTimes(1);
    expect(removedConnection.close).toHaveBeenCalledTimes(1);
    expect(stableConnection.close).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    log.mockRestore();

    removeLiveConnection(documentId, 'socket-changed');
    removeLiveConnection(documentId, 'socket-removed');
    removeLiveConnection(documentId, 'socket-stable');
  });

  it('连接移除后不再参与成员校验', async () => {
    const user = randomUUID();
    const { documentId } = await seedDocument([{ id: user, role: 'editor' }]);
    const connection = fakeConnection('socket-x');
    addLiveConnection({ socketId: 'socket-x', documentId, userId: user, role: 'editor', connection });
    removeLiveConnection(documentId, 'socket-x');

    await query('delete from doc_members where document_id = $1 and user_id = $2', [
      documentId,
      user,
    ]);
    await syncDocumentMembership(documentId);
    expect(connection.close).not.toHaveBeenCalled();
  });
});
