import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApiDatabase, resetApiDatabase, setupApiDatabase } from './db.js';
import {
  api,
  createDoc,
  dbQuery,
  inviteMember,
  readJson,
  registerUser,
  type TestSession,
} from './fixtures.js';

let env: { lingxiWebhookUrl: string; webBaseUrl: string };
let owner: TestSession;
let editor: TestSession;
let spectator: TestSession;
let outsider: TestSession;
let docId: string;

beforeAll(async () => {
  await setupApiDatabase();
  env = (await import('../env.js')).env;
});

afterAll(async () => {
  await closeApiDatabase();
  const { redis } = await import('../redis.js');
  redis.disconnect();
});

beforeEach(async () => {
  await resetApiDatabase();
  env.lingxiWebhookUrl = '';
  owner = await registerUser('owner@example.com', 'password123', '所有者');
  editor = await registerUser('editor@example.com', 'password123', '编辑者');
  spectator = await registerUser('spectator@example.com', 'password123', '旁观者');
  outsider = await registerUser('outsider@example.com', 'password123', '路人');

  const response = await createDoc(owner.token, { title: '提及测试' });
  docId = (await readJson(response)).doc.id;
  await inviteMember(owner.token, docId, editor.user.email, 'editor');
  await inviteMember(owner.token, docId, spectator.user.email, 'spectator');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mention(token: string, userIds: string[], excerpt = '看这里') {
  return api(`/api/docs/${docId}/mentions`, { token, body: { userIds, excerpt } });
}

describe('POST /api/docs/:id/mentions', () => {
  it('非法 id 400、非成员 404、spectator 403', async () => {
    expect((await api('/api/docs/bad-id/mentions', { token: owner.token, body: {} })).status).toBe(400);
    expect((await mention(outsider.token, [editor.user.id])).status).toBe(404);
    expect((await mention(spectator.token, [editor.user.id])).status).toBe(403);
  });

  it('自己/非法/非成员 id 被过滤后返回 0 且 webhook skipped', async () => {
    for (const userIds of [
      [owner.user.id],
      ['not-a-uuid', owner.user.id],
      [outsider.user.id],
      [],
    ]) {
      const response = await mention(owner.token, userIds);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ delivered: 0, webhook: 'skipped' });
    }
    expect(await dbQuery('select id from notifications')).toHaveLength(0);
  });

  it('合法提及落库站内通知并去重，默认 webhook skipped', async () => {
    const response = await mention(
      owner.token,
      [editor.user.id, editor.user.id],
      '  第一行\n\n第二行  ',
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toEqual({ delivered: 1, webhook: 'skipped' });

    const rows = await dbQuery<{ user_id: string; excerpt: string; actor_id: string }>(
      'select user_id, excerpt, actor_id from notifications',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(editor.user.id);
    expect(rows[0]!.excerpt).toBe('第一行 第二行');
    expect(rows[0]!.actor_id).toBe(owner.user.id);
  });

  it('excerpt 折叠空白并截断到 200 字', async () => {
    const longExcerpt = Array.from({ length: 80 }, (_, index) => `word${index}`).join('  ');
    await mention(owner.token, [editor.user.id], longExcerpt);
    const rows = await dbQuery<{ excerpt: string }>('select excerpt from notifications');
    expect(rows[0]!.excerpt.length).toBe(200);
    expect(rows[0]!.excerpt).not.toContain('  ');
    expect(rows[0]!.excerpt.startsWith('word0 word1')).toBe(true);
  });

  it('webhook 配置后发送 sent，并带上文档链接与接收人', async () => {
    env.lingxiWebhookUrl = 'http://webhook.local/mention';
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await mention(owner.token, [editor.user.id], '请看一下');
    expect(await readJson(response)).toEqual({ delivered: 1, webhook: 'sent' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://webhook.local/mention');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(String(init.body));
    expect(payload.type).toBe('mention');
    expect(payload.documentId).toBe(docId);
    expect(payload.documentTitle).toBe('提及测试');
    expect(payload.documentKind).toBe('doc');
    expect(payload.url).toBe(`${env.webBaseUrl}/doc/${docId}`);
    expect(payload.actor).toEqual({ id: owner.user.id, displayName: '所有者' });
    expect(payload.recipients).toEqual([
      { id: editor.user.id, displayName: '编辑者', email: 'editor@example.com' },
    ]);
    expect(payload.excerpt).toBe('请看一下');
    expect(typeof payload.occurredAt).toBe('string');
  });

  it('表格提及链接指向 /sheet', async () => {
    const sheet = await createDoc(owner.token, { kind: 'sheet', title: '表格' });
    const sheetId = (await readJson(sheet)).doc.id;
    await inviteMember(owner.token, sheetId, editor.user.email, 'editor');

    env.lingxiWebhookUrl = 'http://webhook.local/mention';
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api(`/api/docs/${sheetId}/mentions`, {
      token: owner.token,
      body: { userIds: [editor.user.id], excerpt: '看表格' },
    });
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(payload.url).toBe(`${env.webBaseUrl}/sheet/${sheetId}`);
    expect(payload.documentKind).toBe('sheet');
  });

  it('webhook 非 2xx 或网络异常时返回 failed，但通知仍落库', async () => {
    env.lingxiWebhookUrl = 'http://webhook.local/mention';

    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })));
    const failedStatus = await mention(owner.token, [editor.user.id]);
    expect((await readJson(failedStatus)).webhook).toBe('failed');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network down'))));
    const failedThrow = await mention(owner.token, [editor.user.id]);
    expect((await readJson(failedThrow)).webhook).toBe('failed');

    expect(await dbQuery('select id from notifications')).toHaveLength(2);
  });
});

describe('站内通知列表与标记已读', () => {
  async function createNotifications(count: number) {
    for (let index = 0; index < count; index += 1) {
      await mention(owner.token, [editor.user.id], `通知 ${index}`);
    }
  }

  it('未登录返回 401；成员只看到自己的通知与未读数', async () => {
    expect((await api('/api/notifications')).status).toBe(401);
    await createNotifications(2);

    const response = await api('/api/notifications', { token: editor.token });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.unread).toBe(2);
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications[0]).toMatchObject({
      kind: 'mention',
      documentId: docId,
      documentTitle: '提及测试',
      documentKind: 'doc',
      actorName: '所有者',
      readAt: null,
    });
    expect(typeof body.notifications[0].createdAt).toBe('string');

    const ownerView = await api('/api/notifications', { token: owner.token });
    expect((await readJson(ownerView)).notifications).toHaveLength(0);
  });

  it('actor 被注销后展示“已注销成员”', async () => {
    await createNotifications(1);
    await dbQuery('update notifications set actor_id = null');
    const response = await api('/api/notifications', { token: editor.token });
    expect((await readJson(response)).notifications[0].actorName).toBe('已注销成员');
  });

  it('按 ids 标记已读只影响指定条目', async () => {
    await createNotifications(2);
    const list = await readJson(await api('/api/notifications', { token: editor.token }));
    const firstId = list.notifications[0].id;

    const read = await api('/api/notifications/read', {
      token: editor.token,
      body: { ids: [firstId, 'not-a-number'] },
    });
    expect(await readJson(read)).toEqual({ unread: 1 });
  });

  it('不带 ids 时全部标记已读', async () => {
    await createNotifications(2);
    const read = await api('/api/notifications/read', { token: editor.token, body: {} });
    expect(await readJson(read)).toEqual({ unread: 0 });

    const list = await readJson(await api('/api/notifications', { token: editor.token }));
    expect(list.notifications.every((n: { readAt: string | null }) => n.readAt !== null)).toBe(true);
  });

  it('非法 JSON 与非法 ids 均按全部已读处理', async () => {
    await createNotifications(1);
    const read = await api('/api/notifications/read', {
      token: editor.token,
      body: { ids: ['bad-id'] },
    });
    expect(await readJson(read)).toEqual({ unread: 0 });

    const invalidJson = await api('/api/notifications/read', {
      token: editor.token,
      rawBody: '{not-json',
      headers: { 'content-type': 'application/json' },
    });
    expect(invalidJson.status).toBe(200);
  });
});
