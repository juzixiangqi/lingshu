import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, RESTORE_STATELESS_PAYLOAD } from '@lingshu/shared';
import { closeCollabDatabase, resetCollabDatabase, setupCollabDatabase } from './db.js';

let serverModule: typeof import('../server.js');
let server: ReturnType<typeof serverModule.createCollabServer>;
let config: any;
let query: typeof import('../db.js').query;
let env: {
  jwtSecret: string;
  maxDocConnections: number;
  awarenessThrottleMs: number;
};
let syncDocumentMembership: typeof import('../impl/liveConnections.js').syncDocumentMembership;

beforeAll(async () => {
  await setupCollabDatabase();
  query = (await import('../db.js')).query;
  env = (await import('../env.js')).env;
  syncDocumentMembership = (await import('../impl/liveConnections.js')).syncDocumentMembership;
  serverModule = await import('../server.js');
  server = serverModule.createCollabServer();
  config = (server as any).configuration;
});

afterAll(async () => {
  await closeCollabDatabase();
});

beforeEach(async () => {
  await resetCollabDatabase();
  env.maxDocConnections = 200;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cursorState(clientId: number, userId = `u${clientId}`) {
  return { user: { id: userId, name: userId }, cursor: { anchor: clientId, head: clientId } };
}

describe('governAwareness', () => {
  function fillSlots(documentName: string, now: number): Map<number, Record<string, any>> {
    const states = new Map<number, Record<string, any>>();
    for (let clientId = 0; clientId < LIMITS.maxBroadcastCursors; clientId += 1) {
      states.set(clientId, cursorState(clientId));
    }
    serverModule.governAwareness(documentName, states, new Map(), false, now);
    return states;
  }

  it('spectator 只保留在线状态，剥离 cursor/selection', () => {
    const states = new Map<number, Record<string, any>>([
      [1, { user: { id: 'u1' }, cursor: { anchor: 0 }, selection: { anchor: 0, head: 1 } }],
    ]);
    serverModule.governAwareness('doc-spectator', states, new Map(), true, 1_000);
    expect(states.get(1)!.cursor).toBeUndefined();
    expect(states.get(1)!.selection).toBeUndefined();
    expect(states.get(1)!.user).toEqual({ id: 'u1' });
  });

  it('光标槽位上限为 maxBroadcastCursors，超出者被剥离光标', () => {
    const documentName = 'doc-slot-limit';
    const filled = fillSlots(documentName, 1_000);
    for (let clientId = 0; clientId < LIMITS.maxBroadcastCursors; clientId += 1) {
      // 已持有槽位的写者继续广播
      expect(filled.get(clientId)!.cursor).toBeDefined();
    }

    const incoming = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    const current = new Map<number, Record<string, any>>([[99, { user: { id: 'other' } }]]);
    serverModule.governAwareness(documentName, incoming, current, false, 1_100);
    expect(incoming.get(99)!.cursor).toBeUndefined();
    expect(incoming.has(99)).toBe(true);
  });

  it('未持有槽位且只有光标变化时整条抑制，10 秒后放行', () => {
    const documentName = 'doc-suppress';
    fillSlots(documentName, 1_000);

    // 首次带 user 变化：保留 state，但剥离光标，并记录放行时间
    const first = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    serverModule.governAwareness(documentName, first, new Map(), false, 1_100);
    expect(first.has(99)).toBe(true);
    expect(first.get(99)!.cursor).toBeUndefined();

    // 仅光标移动：整条从广播中剔除
    const second = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    serverModule.governAwareness(
      documentName,
      second,
      new Map([[99, { user: { id: 'u99', name: 'u99' } }]]),
      false,
      1_200,
    );
    expect(second.has(99)).toBe(false);

    // 超过 awarenessRepublishMs 后放行完整状态，避免被判定超时
    // 先刷新华者槽位时间，确保 10s 放行窗口内旧槽位尚未过期让位
    fillSlots(documentName, 6_200);
    const republished = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    serverModule.governAwareness(
      documentName,
      republished,
      new Map([[99, { user: { id: 'u99', name: 'u99' } }]]),
      false,
      11_200,
    );
    expect(republished.has(99)).toBe(true);
  });

  it('cursorOwnerStaleMs 后旧槽位让位给新写者', () => {
    const documentName = 'doc-stale';
    fillSlots(documentName, 1_000);

    const incoming = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    serverModule.governAwareness(documentName, incoming, new Map(), false, 7_000);
    expect(incoming.get(99)!.cursor).toBeDefined();
  });

  it('非光标字段变化时保留 state', () => {
    const documentName = 'doc-other-field';
    fillSlots(documentName, 1_000);

    const incoming = new Map<number, Record<string, any>>([
      [99, { user: { id: 'u99', status: 'online' }, cursor: { anchor: 1 } }],
    ]);
    const current = new Map<number, Record<string, any>>([
      [99, { user: { id: 'u99', status: 'away' } }],
    ]);
    serverModule.governAwareness(documentName, incoming, current, false, 1_100);
    expect(incoming.has(99)).toBe(true);
    expect(incoming.get(99)!.cursor).toBeUndefined();
    expect(incoming.get(99)!.user.status).toBe('online');
  });
});

describe('server configuration 钩子', () => {
  it('构造参数符合快照与 awareness 节流约束', () => {
    expect(config.port).toBe(1234);
    expect(config.debounce).toBe(LIMITS.snapshotIntervalMs);
    expect(config.maxDebounce).toBe(LIMITS.snapshotIntervalMs);
    expect(config.flushDelay).toBe(env.awarenessThrottleMs ?? 40);
  });

  it('beforeHandleAwareness 对 spectator 剥离光标，对普通连接保留', async () => {
    const spectatorDoc = `doc-hook-spectator-${randomUUID()}`;
    const states = new Map<number, Record<string, any>>([[1, cursorState(1)]]);
    await config.beforeHandleAwareness({
      documentName: spectatorDoc,
      states,
      awareness: { getStates: () => new Map() },
      context: { role: 'spectator' },
    });
    expect(states.get(1)!.cursor).toBeUndefined();

    const writerDoc = `doc-hook-writer-${randomUUID()}`;
    const writerStates = new Map<number, Record<string, any>>([[2, cursorState(2)]]);
    await config.beforeHandleAwareness({
      documentName: writerDoc,
      states: writerStates,
      awareness: { getStates: () => new Map() },
      context: undefined,
    });
    expect(writerStates.get(2)!.cursor).toBeDefined();
  });

  it('afterUnloadDocument 清理光标槽位与放行时间', async () => {
    const documentName = `doc-unload-${randomUUID()}`;
    const fill = new Map<number, Record<string, any>>();
    for (let clientId = 0; clientId < LIMITS.maxBroadcastCursors; clientId += 1) {
      fill.set(clientId, cursorState(clientId));
    }
    await config.beforeHandleAwareness({
      documentName,
      states: fill,
      awareness: { getStates: () => new Map() },
      context: { role: 'editor' },
    });

    const blocked = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    await config.beforeHandleAwareness({
      documentName,
      states: blocked,
      awareness: { getStates: () => new Map([[99, { user: { id: 'other' } }]]) },
      context: { role: 'editor' },
    });
    expect(blocked.get(99)!.cursor).toBeUndefined();

    await config.afterUnloadDocument({ documentName });

    const allowed = new Map<number, Record<string, any>>([[99, cursorState(99)]]);
    await config.beforeHandleAwareness({
      documentName,
      states: allowed,
      awareness: { getStates: () => new Map([[99, { user: { id: 'other' } }]]) },
      context: { role: 'editor' },
    });
    expect(allowed.get(99)!.cursor).toBeDefined();
  });

  it('onStateless 只转发 RESTORE_STATELESS_PAYLOAD', async () => {
    const broadcastStateless = vi.fn();
    await config.onStateless({
      document: { broadcastStateless },
      payload: RESTORE_STATELESS_PAYLOAD,
    });
    expect(broadcastStateless).toHaveBeenCalledWith(RESTORE_STATELESS_PAYLOAD);

    broadcastStateless.mockClear();
    await config.onStateless({ document: { broadcastStateless }, payload: 'other' });
    expect(broadcastStateless).not.toHaveBeenCalled();
  });

  it('acquireSlot 达到单文档连接上限后抛错，releaseSlot 释放槽位', () => {
    const documentName = `doc-quota-${randomUUID()}`;
    env.maxDocConnections = 2;
    serverModule.acquireSlot(documentName, 'socket-a');
    serverModule.acquireSlot(documentName, 'socket-b');
    expect(() => serverModule.acquireSlot(documentName, 'socket-c')).toThrow('文档连接数已达上限');

    serverModule.releaseSlot(documentName, 'socket-b');
    expect(() => serverModule.acquireSlot(documentName, 'socket-c')).not.toThrow();
    serverModule.releaseSlot(documentName, 'socket-a');
    serverModule.releaseSlot(documentName, 'socket-c');
    expect(() => serverModule.releaseSlot(documentName, 'socket-a')).not.toThrow();
    env.maxDocConnections = 200;
  });

  async function seedMember(role: 'owner' | 'editor' | 'spectator') {
    const userId = randomUUID();
    const documentId = randomUUID();
    const documentName = `${documentId}/body`;
    await query(`insert into users (id, email, display_name) values ($1, $2, '用户')`, [
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
    const token = await new SignJWT({ email: 'user@example.com', name: '用户' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(env.jwtSecret));
    return { userId, documentId, documentName, token };
  }

  it('onAuthenticate 为 spectator 设置 readOnly，非法 token 拒绝', async () => {
    const member = await seedMember('spectator');
    const connectionConfig: Record<string, unknown> = {};
    const context = await config.onAuthenticate({
      token: member.token,
      documentName: member.documentName,
      socketId: 'auth-socket-1',
      connectionConfig,
    });
    expect(connectionConfig.readOnly).toBe(true);
    expect(context.role).toBe('spectator');
    expect(context.documentId).toBe(member.documentId);

    await expect(
      config.onAuthenticate({
        token: 'bad-token',
        documentName: member.documentName,
        socketId: 'auth-socket-2',
        connectionConfig: {},
      }),
    ).rejects.toThrow('invalid token');

    serverModule.releaseSlot(member.documentName, 'auth-socket-1');
  });

  it('onAuthenticate 在连接配额超限时拒绝', async () => {
    const member = await seedMember('editor');
    env.maxDocConnections = 1;
    try {
      await config.onAuthenticate({
        token: member.token,
        documentName: member.documentName,
        socketId: 'quota-1',
        connectionConfig: {},
      });
      await expect(
        config.onAuthenticate({
          token: member.token,
          documentName: member.documentName,
          socketId: 'quota-2',
          connectionConfig: {},
        }),
      ).rejects.toThrow('文档连接数已达上限');
    } finally {
      serverModule.releaseSlot(member.documentName, 'quota-1');
      env.maxDocConnections = 200;
    }
  });

  it('connected 注册在线连接，onDisconnect 移除并释放配额', async () => {
    const member = await seedMember('editor');
    const connection = { socketId: 'live-socket', close: vi.fn() } as any;
    await config.connected({
      connection,
      context: { user: { id: member.userId }, role: 'editor', documentId: member.documentId },
    });
    await config.connected({ connection, context: null });

    await query('delete from doc_members where document_id = $1 and user_id = $2', [
      member.documentId,
      member.userId,
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await syncDocumentMembership(member.documentId);
    expect(connection.close).toHaveBeenCalledTimes(1);
    log.mockRestore();

    await config.onDisconnect({
      documentName: member.documentName,
      socketId: 'live-socket',
      context: { user: { id: member.userId }, role: 'editor', documentId: member.documentId },
    });
    await syncDocumentMembership(member.documentId);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('onChange 异步写入 op 流并记录操作者', async () => {
    const member = await seedMember('editor');
    await config.onChange({
      documentName: member.documentName,
      update: new Uint8Array([1, 2, 3]),
      context: {
        user: { id: member.userId, email: 'user@example.com', displayName: '用户' },
        role: 'editor',
        documentId: member.documentId,
      },
    });
    const start = Date.now();
    let rows: { id: string; user_id: string | null; user_name: string }[] = [];
    while (rows.length === 0 && Date.now() - start < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = await query<{ id: string; user_id: string | null; user_name: string }>(
        'select id, user_id, user_name from doc_op_log where document_name = $1',
        [member.documentName],
      );
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(member.userId);
    expect(rows[0]!.user_name).toBe('用户');
  });

  it('Database 扩展的 fetch/store 委托给 persistence，并吞掉落盘错误', async () => {
    const extension = (config.extensions as any[])[0];
    const { documentName, documentId } = await seedMember('editor');

    expect(await extension.configuration.fetch({ documentName: 'missing/body' })).toBeNull();

    await extension.configuration.store({ documentName, state: new Uint8Array([1, 2, 3]) });
    const loaded = await extension.configuration.fetch({ documentName });
    expect(Array.from(loaded)).toEqual([1, 2, 3]);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await extension.configuration.store({
      documentName: `not-a-uuid-${randomUUID()}/body`,
      state: new Uint8Array([1]),
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    expect(documentId).toBeTruthy();
  });
});
