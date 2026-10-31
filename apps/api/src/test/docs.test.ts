import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { documentNamesFor } from '@lingshu/shared';
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

let env: { collabShards: string[] };
let owner: TestSession;
let editor: TestSession;
let outsider: TestSession;

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
  owner = await registerUser('owner@example.com', 'password123', '所有者');
  editor = await registerUser('editor@example.com', 'password123', '编辑者');
  outsider = await registerUser('outsider@example.com', 'password123', '路人');
});

async function createDocFor(session: TestSession, body: Record<string, unknown> = {}) {
  const response = await createDoc(session.token, body);
  expect(response.status).toBe(201);
  return (await readJson(response)).doc as {
    id: string;
    kind: string;
    title: string;
    role: string;
    updatedAt: string;
    collab: { url: string; documentNames: string[] };
  };
}

async function addMember(docId: string, session: TestSession, role: 'editor' | 'spectator') {
  const response = await inviteMember(owner.token, docId, session.user.email, role);
  expect([200, 201]).toContain(response.status);
}

describe('文档列表 / 创建 / 详情', () => {
  it('未登录访问文档接口返回 401', async () => {
    expect((await api('/api/docs')).status).toBe(401);
  });

  it('创建文档使用默认标题与一致性哈希分片', async () => {
    const doc = await createDocFor(owner);
    expect(doc.kind).toBe('doc');
    expect(doc.title).toBe('未命名文档');
    expect(doc.role).toBe('owner');
    expect(env.collabShards).toContain(doc.collab.url);
    expect(doc.collab.documentNames).toEqual(documentNamesFor(doc.id, 'doc'));
  });

  it('创建表格使用表格默认标题与 workbook + sheet 文档名', async () => {
    const doc = await createDocFor(owner, { kind: 'sheet', title: ' 季度预算 ' });
    expect(doc.kind).toBe('sheet');
    expect(doc.title).toBe('季度预算');
    expect(doc.collab.documentNames).toEqual(documentNamesFor(doc.id, 'sheet'));
  });

  it('未知 kind 归一化为 doc', async () => {
    const doc = await createDocFor(owner, { kind: 'unknown', title: '' });
    expect(doc.kind).toBe('doc');
    expect(doc.title).toBe('未命名文档');
  });

  it('列表只返回当前用户参与的文档，并按更新时间倒序', async () => {
    const first = await createDocFor(owner, { title: '第一篇' });
    const second = await createDocFor(owner, { kind: 'sheet', title: '第二篇' });
    await dbQuery('update documents set updated_at = now() - interval \'1 hour\' where id = $1', [
      first.id,
    ]);

    const response = await api('/api/docs', { token: owner.token });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.docs.map((doc: { id: string }) => doc.id)).toEqual([second.id, first.id]);

    const outsiderResponse = await api('/api/docs', { token: outsider.token });
    expect((await readJson(outsiderResponse)).docs).toHaveLength(0);
  });

  it('详情：非法 id 400、不存在 404、成员可见', async () => {
    const doc = await createDocFor(owner);
    expect((await api('/api/docs/not-a-uuid', { token: owner.token })).status).toBe(400);
    expect((await api(`/api/docs/${randomUUID()}`, { token: owner.token })).status).toBe(404);

    await addMember(doc.id, editor, 'editor');
    const response = await api(`/api/docs/${doc.id}`, { token: editor.token });
    expect(response.status).toBe(200);
    expect((await readJson(response)).doc.role).toBe('editor');

    expect((await api(`/api/docs/${doc.id}`, { token: outsider.token })).status).toBe(404);
  });
});

describe('成员管理', () => {
  it('成员列表：成员可见、owner 排在最前、非成员 404', async () => {
    const doc = await createDocFor(owner);
    await addMember(doc.id, editor, 'editor');
    const spectator = await registerUser('spectator@example.com', 'password123', '旁观者');
    await addMember(doc.id, spectator, 'spectator');

    const response = await api(`/api/docs/${doc.id}/members`, { token: editor.token });
    expect(response.status).toBe(200);
    const members = (await readJson(response)).members;
    expect(members.map((member: { email: string }) => member.email)).toEqual([
      'owner@example.com',
      'editor@example.com',
      'spectator@example.com',
    ]);
    expect(members[0].role).toBe('owner');
    expect(members[2].role).toBe('spectator');

    expect((await api(`/api/docs/${doc.id}/members`, { token: outsider.token })).status).toBe(404);
    expect((await api('/api/docs/bad-id/members', { token: owner.token })).status).toBe(400);
  });

  it('仅 owner 可邀请，未注册邮箱 404、重复邀请 200、改 owner 409', async () => {
    const doc = await createDocFor(owner);
    await addMember(doc.id, editor, 'editor');

    const repeat = await inviteMember(owner.token, doc.id, editor.user.email, 'spectator');
    expect(repeat.status).toBe(200);
    expect((await readJson(repeat)).members[1].role).toBe('spectator');

    const nonOwner = await inviteMember(editor.token, doc.id, outsider.user.email, 'editor');
    expect(nonOwner.status).toBe(403);

    const unregistered = await inviteMember(owner.token, doc.id, 'nobody@example.com', 'editor');
    expect(unregistered.status).toBe(404);

    const makeOwner = await inviteMember(owner.token, doc.id, owner.user.email, 'editor');
    expect(makeOwner.status).toBe(409);

    const missingEmail = await api(`/api/docs/${doc.id}/members`, {
      token: owner.token,
      body: { role: 'editor' },
    });
    expect(missingEmail.status).toBe(400);

    expect((await api('/api/docs/bad-id/members', { token: owner.token, body: {} })).status).toBe(
      400,
    );

    const original = await api(`/api/docs/${doc.id}/members`, {
      token: owner.token,
      body: { email: ' OUTSIDER@example.com ', role: 'unknown' },
    });
    expect(original.status).toBe(201);
    const originalBody = await readJson(original);
    expect(originalBody.members.some((m: { role: string }) => m.role === 'editor')).toBe(true);
    expect(originalBody.members.some((m: { email: string }) => m.email === 'outsider@example.com')).toBe(
      true,
    );
  });

  it('移除成员：非法 id 400、非 owner 403、不存在 404、owner 409、成功 200', async () => {
    const doc = await createDocFor(owner);
    await addMember(doc.id, editor, 'editor');

    expect(
      (await api(`/api/docs/${doc.id}/members/not-a-uuid`, { token: owner.token, method: 'DELETE' }))
        .status,
    ).toBe(400);

    const nonOwner = await api(`/api/docs/${doc.id}/members/${editor.user.id}`, {
      token: editor.token,
      method: 'DELETE',
    });
    expect(nonOwner.status).toBe(403);

    const missing = await api(`/api/docs/${doc.id}/members/${randomUUID()}`, {
      token: owner.token,
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);

    const removeOwner = await api(`/api/docs/${doc.id}/members/${owner.user.id}`, {
      token: owner.token,
      method: 'DELETE',
    });
    expect(removeOwner.status).toBe(409);

    const removed = await api(`/api/docs/${doc.id}/members/${editor.user.id}`, {
      token: owner.token,
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    const members = (await readJson(removed)).members;
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');

    expect((await api(`/api/docs/${doc.id}`, { token: editor.token })).status).toBe(404);
  });
});

describe('存储状态 / 版本历史 / 恢复', () => {
  it('storage：非法 id 400、非成员 404、无快照返回空状态、有快照返回最新版本', async () => {
    const doc = await createDocFor(owner);
    expect((await api('/api/docs/bad-id/storage', { token: owner.token })).status).toBe(400);
    expect((await api(`/api/docs/${randomUUID()}/storage`, { token: owner.token })).status).toBe(404);

    const empty = await api(`/api/docs/${doc.id}/storage`, { token: owner.token });
    expect((await readJson(empty)).storage).toEqual({ savedAt: null, version: 0 });

    await dbQuery(
      `insert into doc_snapshots (document_name, document_id, snapshot, version, updated_at)
       values ($1, $2, $3::jsonb, 3, now())`,
      [documentNamesFor(doc.id, 'doc')[0], doc.id, JSON.stringify({ format: 'yjs-v1', base64: '' })],
    );

    const filled = await api(`/api/docs/${doc.id}/storage`, { token: owner.token });
    const storage = (await readJson(filled)).storage;
    expect(storage.version).toBe(3);
    expect(typeof storage.savedAt).toBe('string');
    expect((await api(`/api/docs/${doc.id}/storage`, { token: outsider.token })).status).toBe(404);
  });

  it('版本列表：按时间倒序、7 天内 content 其余 snapshot、非成员 404', async () => {
    const doc = await createDocFor(owner);
    const names = documentNamesFor(doc.id, 'doc');

    const insertVersion = async (ageDays: number, version: number) => {
      const rows = await dbQuery<{ id: string }>(
        `insert into doc_snapshot_versions (document_name, document_id, snapshot, version, created_at)
         values ($1, $2, $3::jsonb, $4, now() - make_interval(days => $5))
         returning id`,
        [names[0], doc.id, JSON.stringify({ format: 'yjs-v1', base64: 'aGVsbG8=' }), version, ageDays],
      );
      return rows[0]!.id;
    };
    await insertVersion(0, 1);
    await insertVersion(8, 2);
    await insertVersion(100, 3);

    const response = await api(`/api/docs/${doc.id}/versions`, { token: owner.token });
    expect(response.status).toBe(200);
    const versions = (await readJson(response)).versions;
    expect(versions).toHaveLength(3);
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
    expect(versions[0].precision).toBe('content');
    expect(versions[1].precision).toBe('snapshot');
    expect(versions[2].precision).toBe('snapshot');

    expect((await api('/api/docs/bad-id/versions', { token: owner.token })).status).toBe(400);
    expect((await api(`/api/docs/${randomUUID()}/versions`, { token: owner.token })).status).toBe(
      404,
    );
  });

  it('表格版本只匹配 workbook / sheet 文档名', async () => {
    const doc = await createDocFor(owner, { kind: 'sheet' });
    await dbQuery(
      `insert into doc_snapshot_versions (document_name, document_id, snapshot, version)
       values ($1, $2, $3::jsonb, 1), ($4, $2, $3::jsonb, 2), ($5, $2, $3::jsonb, 3)`,
      [
        documentNamesFor(doc.id, 'sheet')[0],
        doc.id,
        JSON.stringify({ format: 'yjs-v1', base64: '' }),
        documentNamesFor(doc.id, 'sheet')[1],
        `${doc.id}/other`,
      ],
    );
    const response = await api(`/api/docs/${doc.id}/versions`, { token: owner.token });
    const versions = (await readJson(response)).versions;
    expect(versions).toHaveLength(2);
    expect(versions.every((v: { documentName: string }) => v.documentName !== `${doc.id}/other`)).toBe(
      true,
    );
  });

  it('恢复：参数校验、非成员 404、spectator 403、跨文档 404、成功返回快照', async () => {
    const doc = await createDocFor(owner);
    const other = await createDocFor(owner);
    const spectator = await registerUser('spectator2@example.com', 'password123', '只读成员');
    await addMember(doc.id, spectator, 'spectator');

    const rows = await dbQuery<{ id: string }>(
      `insert into doc_snapshot_versions (document_name, document_id, snapshot, version)
       values ($1, $2, $3::jsonb, 7) returning id`,
      [
        documentNamesFor(doc.id, 'doc')[0],
        doc.id,
        JSON.stringify({ format: 'yjs-v1', base64: 'aGVsbG8=' }),
      ],
    );
    const versionId = rows[0]!.id;

    const otherRows = await dbQuery<{ id: string }>(
      `insert into doc_snapshot_versions (document_name, document_id, snapshot, version)
       values ($1, $2, $3::jsonb, 1) returning id`,
      [documentNamesFor(other.id, 'doc')[0], other.id, JSON.stringify({ format: 'yjs-v1', base64: '' })],
    );
    const otherVersionId = otherRows[0]!.id;

    const restorePath = (id: string, version: string) => `/api/docs/${id}/versions/${version}/restore`;

    expect(
      (await api(restorePath('bad-id', versionId), { token: owner.token, method: 'POST' })).status,
    ).toBe(400);
    expect(
      (await api(restorePath(doc.id, 'abc'), { token: owner.token, method: 'POST' })).status,
    ).toBe(400);
    expect(
      (await api(restorePath(randomUUID(), versionId), { token: owner.token, method: 'POST' })).status,
    ).toBe(404);
    expect(
      (await api(restorePath(doc.id, versionId), { token: outsider.token, method: 'POST' })).status,
    ).toBe(404);
    expect(
      (await api(restorePath(doc.id, versionId), { token: spectator.token, method: 'POST' })).status,
    ).toBe(403);
    expect(
      (await api(restorePath(doc.id, otherVersionId), { token: owner.token, method: 'POST' })).status,
    ).toBe(404);
    expect(
      (await api(restorePath(doc.id, '999999'), { token: owner.token, method: 'POST' })).status,
    ).toBe(404);

    const success = await api(restorePath(doc.id, versionId), { token: owner.token, method: 'POST' });
    expect(success.status).toBe(200);
    const version = (await readJson(success)).version;
    expect(version.id).toBe(versionId);
    expect(version.version).toBe(7);
    expect(version.format).toBe('yjs-v1');
    expect(version.base64).toBe('aGVsbG8=');
    expect(version.precision).toBe('content');
  });
});
