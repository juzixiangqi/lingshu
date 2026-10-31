import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 切换为 IM 模式，覆盖 authenticateDocument 的 IM 分支。
process.env.AUTH_MODE = 'im';
process.env.IM_USERINFO_URL = 'http://im.local/getInfo';

let query: typeof import('../db.js').query;
let authenticateDocument: typeof import('../impl/auth.js').authenticateDocument;
let resetDatabase: () => Promise<void>;
let closeDatabase: () => Promise<void>;

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  const helpers = await import('./db.js');
  resetDatabase = helpers.resetCollabDatabase;
  closeDatabase = helpers.closeCollabDatabase;
  await helpers.setupCollabDatabase();
  query = (await import('../db.js')).query;
  authenticateDocument = (await import('../impl/auth.js')).authenticateDocument;
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function seedImMember(role: 'owner' | 'editor' | 'spectator', imUserId = randomUUID()) {
  const ownerId = randomUUID();
  const documentId = randomUUID();
  const memberId = randomUUID();
  await query(`insert into users (id, email, display_name) values ($1, $2, '文档所有者')`, [
    ownerId,
    `${ownerId}@example.com`,
  ]);
  await query(`insert into documents (id, owner_id, kind, title) values ($1, $2, 'doc', '文档')`, [
    documentId,
    ownerId,
  ]);
  await query(
    `insert into users (id, email, display_name, im_user_id) values ($1, $2, 'IM 成员', $3)`,
    [memberId, `${memberId}@im.local`, imUserId],
  );
  await query(`insert into doc_members (document_id, user_id, role) values ($1, $2, $3)`, [
    documentId,
    memberId,
    role,
  ]);
  return { documentId, memberId, imUserId };
}

describe('authenticateDocument（IM 模式）', () => {
  it('IM 返回 401 时视为 token 无效', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const result = await authenticateDocument({
      token: 'im-token-a',
      documentName: `${randomUUID()}/body`,
    });
    expect(result).toEqual({ allowed: false, reason: 'invalid token' });
  });

  it('IM 服务不可用时返回临时不可用', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const result = await authenticateDocument({
      token: 'im-token-b',
      documentName: `${randomUUID()}/body`,
    });
    expect(result).toEqual({ allowed: false, reason: 'auth temporarily unavailable' });
  });

  it('IM 用户在本地没有成员记录时拒绝', async () => {
    const imUserId = randomUUID();
    fetchMock.mockResolvedValueOnce(respond({ user: { userId: imUserId, userName: '路人' } }));
    const result = await authenticateDocument({
      token: 'im-token-c',
      documentName: `${randomUUID()}/body`,
    });
    expect(result).toEqual({ allowed: false, reason: 'not a member' });
  });

  it('IM 成员按本地角色鉴权，spectator 只读', async () => {
    const { documentId, memberId, imUserId } = await seedImMember('spectator', randomUUID());
    fetchMock.mockResolvedValueOnce(respond({ user: { userId: imUserId, userName: 'IM 成员' } }));

    const result = await authenticateDocument({
      token: 'im-token-d',
      documentName: `${documentId}/body`,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.readOnly).toBe(true);
    expect(result.context).toEqual({
      user: { id: memberId, email: `${memberId}@im.local`, displayName: 'IM 成员' },
      role: 'spectator',
      documentId,
    });
  });

  it('IM 成员为 editor 时可写', async () => {
    const { documentId, imUserId } = await seedImMember('editor', randomUUID());
    fetchMock.mockResolvedValueOnce(respond({ user: { userId: imUserId, nickName: '编辑者' } }));

    const result = await authenticateDocument({
      token: 'im-token-e',
      documentName: `${documentId}/sheet/main`,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.readOnly).toBe(false);
    expect(result.context.role).toBe('editor');
    expect(result.context.user.displayName).toBe('IM 成员');
  });
});
