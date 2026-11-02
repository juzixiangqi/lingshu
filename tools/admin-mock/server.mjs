#!/usr/bin/env node
/**
 * 灵枢管理端 Mock 服务：外网开发管理端页面时使用，不依赖 PostgreSQL / Redis / IM。
 *
 * 启动：
 *   node tools/admin-mock/server.mjs
 *   pnpm mock:admin
 *
 * 环境变量：
 *   MOCK_ADMIN_PORT   端口，默认 9100
 *   MOCK_ADMIN_TOKEN  服务令牌，默认 mock-token；设为空字符串则跳过鉴权
 *
 * 契约：docs/openapi-admin.yaml
 * 额外提供 POST /__reset 重置为初始数据，便于反复演示。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_ADMIN_PORT ?? 9100);
const TOKEN = process.env.MOCK_ADMIN_TOKEN ?? 'mock-token';
const BASE = Date.now();

const iso = (minutesAgo = 0) => new Date(BASE - minutesAgo * 60_000).toISOString();

const DOC_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
];

function buildSeed() {
  const users = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', imUserId: '1001', email: 'zhangsan@corp.local', displayName: '张三' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', imUserId: '1002', email: 'lisi@corp.local', displayName: '李四' },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', imUserId: '1003', email: 'wangwu@corp.local', displayName: '王五' },
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', imUserId: '1004', email: 'zhaoliu@corp.local', displayName: '赵六' },
  ];

  const docs = [
    { id: DOC_IDS[0], kind: 'doc', title: '季度复盘纪要', ownerId: users[0].id, createdAt: iso(60 * 24 * 20), updatedAt: iso(35), deletedAt: null, versionCount: 42 },
    { id: DOC_IDS[1], kind: 'sheet', title: '2026 销售预测', ownerId: users[1].id, createdAt: iso(60 * 24 * 14), updatedAt: iso(80), deletedAt: null, versionCount: 18 },
    { id: DOC_IDS[2], kind: 'doc', title: '接口设计说明', ownerId: users[2].id, createdAt: iso(60 * 24 * 9), updatedAt: iso(180), deletedAt: null, versionCount: 7 },
    { id: DOC_IDS[3], kind: 'sheet', title: '人力盘点表', ownerId: users[0].id, createdAt: iso(60 * 24 * 7), updatedAt: iso(320), deletedAt: null, versionCount: 5 },
    { id: DOC_IDS[4], kind: 'doc', title: '周会记录（归档）', ownerId: users[3].id, createdAt: iso(60 * 24 * 30), updatedAt: iso(60 * 24 * 6), deletedAt: iso(60 * 24 * 3), versionCount: 2 },
    { id: DOC_IDS[5], kind: 'sheet', title: '旧版预算表', ownerId: users[1].id, createdAt: iso(60 * 24 * 45), updatedAt: iso(60 * 24 * 12), deletedAt: iso(60 * 24 * 5), versionCount: 1 },
    { id: DOC_IDS[6], kind: 'doc', title: '入职指引', ownerId: users[2].id, createdAt: iso(60 * 24 * 4), updatedAt: iso(90), deletedAt: null, versionCount: 3 },
    { id: DOC_IDS[7], kind: 'sheet', title: '项目排期', ownerId: users[3].id, createdAt: iso(60 * 24 * 2), updatedAt: iso(15), deletedAt: null, versionCount: 9 },
  ];

  const members = new Map();
  for (const [index, doc] of docs.entries()) {
    const extra = users[(index + 1) % users.length];
    const another = users[(index + 2) % users.length];
    members.set(doc.id, [
      { userId: doc.ownerId, role: 'owner', joinedAt: doc.createdAt },
      { userId: extra.id, role: 'editor', joinedAt: doc.createdAt },
      ...(index % 2 === 0 ? [{ userId: another.id, role: 'spectator', joinedAt: doc.createdAt }] : []),
    ]);
  }

  const auditLogs = [
    {
      id: '1',
      operatorId: 'admin-1',
      operatorName: '管理员',
      action: 'doc.delete',
      targetType: 'document',
      targetId: DOC_IDS[4],
      detail: {},
      createdAt: iso(60 * 24 * 3),
    },
    {
      id: '2',
      operatorId: 'admin-1',
      operatorName: '管理员',
      action: 'doc.member.remove',
      targetType: 'document_member',
      targetId: DOC_IDS[2],
      detail: { userId: users[3].id, role: 'spectator' },
      createdAt: iso(600),
    },
  ];

  return { users, docs, members, auditLogs };
}

let state = buildSeed();

function findUser(id) {
  return state.users.find((user) => user.id === id) ?? null;
}

function toAdminDoc(doc) {
  const owner = findUser(doc.ownerId);
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    owner: {
      id: doc.ownerId,
      imUserId: owner?.imUserId ?? null,
      email: owner?.email ?? '',
      displayName: owner?.displayName ?? '未知用户',
    },
    memberCount: (state.members.get(doc.id) ?? []).length,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toAdminMember(docId, member) {
  const user = findUser(member.userId);
  return {
    userId: member.userId,
    imUserId: user?.imUserId ?? null,
    email: user?.email ?? '',
    displayName: user?.displayName ?? '未知用户',
    role: member.role,
    joinedAt: member.joinedAt,
  };
}

function readPaging(url) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const size = Number(url.searchParams.get('pageSize') ?? 20) || 20;
  const pageSize = Math.min(100, Math.max(1, size));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pushAudit(operator, action, targetType, targetId, detail = {}) {
  state.auditLogs.unshift({
    id: String(state.auditLogs.length + 1),
    operatorId: operator.id,
    operatorName: operator.name,
    action,
    targetType,
    targetId,
    detail,
    createdAt: new Date().toISOString(),
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function error(res, status, message) {
  json(res, status, { error: message });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-service-token,x-operator-id,x-operator-name',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', 'content-type');

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/__reset') {
    state = buildSeed();
    return json(res, 200, { ok: true });
  }

  if (TOKEN && req.headers['x-service-token'] !== TOKEN) {
    return error(res, 401, 'unauthorized');
  }
  const operatorId = String(req.headers['x-operator-id'] ?? '').trim();
  if (!operatorId) {
    return error(res, 400, '缺少操作人标识（X-Operator-Id）');
  }
  const operator = {
    id: operatorId,
    name: String(req.headers['x-operator-name'] ?? '').trim(),
  };

  const parts = url.pathname.split('/').filter(Boolean);

  // GET /docs
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'docs') {
    const keyword = (url.searchParams.get('keyword') ?? '').trim();
    const kind = url.searchParams.get('kind') ?? '';
    const ownerId = (url.searchParams.get('ownerId') ?? '').trim();
    const deletedOnly = url.searchParams.get('deletedOnly') === 'true';
    const includeDeleted = url.searchParams.get('includeDeleted') === 'true' || deletedOnly;
    const { page, pageSize, offset } = readPaging(url);

    const filtered = state.docs.filter((doc) => {
      if (!includeDeleted && doc.deletedAt) return false;
      if (deletedOnly && !doc.deletedAt) return false;
      if (keyword && !doc.title.includes(keyword)) return false;
      if (kind && doc.kind !== kind) return false;
      if (ownerId) {
        const owner = findUser(doc.ownerId);
        if (doc.ownerId !== ownerId && owner?.imUserId !== ownerId) return false;
      }
      return true;
    });

    return json(res, 200, {
      items: filtered.slice(offset, offset + pageSize).map(toAdminDoc),
      total: filtered.length,
      page,
      pageSize,
    });
  }

  // GET /docs/:id
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'docs') {
    const doc = state.docs.find((item) => item.id === parts[1]);
    if (!doc) return error(res, 404, 'not found');
    const savedAt = doc.deletedAt ? null : iso(1);
    return json(res, 200, {
      doc: toAdminDoc(doc),
      members: (state.members.get(doc.id) ?? []).map((member) => toAdminMember(doc.id, member)),
      lastSavedAt: savedAt,
      versionCount: doc.versionCount,
    });
  }

  // DELETE /docs/:id
  if (req.method === 'DELETE' && parts.length === 2 && parts[0] === 'docs') {
    const doc = state.docs.find((item) => item.id === parts[1]);
    if (!doc) return error(res, 404, 'not found');
    if (doc.deletedAt) return error(res, 409, '文档已在回收站');
    doc.deletedAt = new Date().toISOString();
    pushAudit(operator, 'doc.delete', 'document', doc.id);
    return json(res, 200, { deletedAt: doc.deletedAt });
  }

  // POST /docs/:id/restore
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'docs' && parts[2] === 'restore') {
    const doc = state.docs.find((item) => item.id === parts[1]);
    if (!doc) return error(res, 404, 'not found');
    if (!doc.deletedAt) return error(res, 409, '文档不在回收站');
    doc.deletedAt = null;
    pushAudit(operator, 'doc.restore', 'document', doc.id);
    return json(res, 200, { doc: toAdminDoc(doc) });
  }

  // GET /docs/:id/members
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'docs' && parts[2] === 'members') {
    const doc = state.docs.find((item) => item.id === parts[1]);
    if (!doc) return error(res, 404, 'not found');
    return json(res, 200, {
      members: (state.members.get(doc.id) ?? []).map((member) => toAdminMember(doc.id, member)),
    });
  }

  // DELETE /docs/:id/members/:userId
  if (req.method === 'DELETE' && parts.length === 4 && parts[0] === 'docs' && parts[2] === 'members') {
    const docId = parts[1];
    const userId = parts[3];
    if (!UUID_RE.test(docId) || !UUID_RE.test(userId)) return error(res, 400, 'invalid id');
    const doc = state.docs.find((item) => item.id === docId);
    if (!doc) return error(res, 404, 'not found');
    const list = state.members.get(docId) ?? [];
    const target = list.find((member) => member.userId === userId);
    if (!target) return error(res, 404, '成员不存在');
    if (target.role === 'owner') return error(res, 409, '不能移除所有者');
    state.members.set(docId, list.filter((member) => member.userId !== userId));
    pushAudit(operator, 'doc.member.remove', 'document_member', docId, {
      userId,
      role: target.role,
    });
    return json(res, 200, {
      members: (state.members.get(docId) ?? []).map((member) => toAdminMember(docId, member)),
    });
  }

  // GET /users
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'users') {
    const keyword = (url.searchParams.get('keyword') ?? '').trim().toLowerCase();
    const { page, pageSize, offset } = readPaging(url);

    const filtered = state.users.filter((user) => {
      if (!keyword) return true;
      return (
        user.email.toLowerCase().includes(keyword) ||
        user.displayName.toLowerCase().includes(keyword) ||
        user.imUserId === keyword
      );
    });

    return json(res, 200, {
      items: filtered.slice(offset, offset + pageSize).map((user) => ({
        id: user.id,
        imUserId: user.imUserId,
        email: user.email,
        displayName: user.displayName,
        docCount: state.docs.filter(
          (doc) =>
            !doc.deletedAt &&
            (state.members.get(doc.id) ?? []).some((member) => member.userId === user.id),
        ).length,
      })),
      total: filtered.length,
      page,
      pageSize,
    });
  }

  // GET /shards
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'shards') {
    return json(res, 200, {
      items: [
        {
          url: 'ws://localhost:1234',
          reachable: true,
          statusCode: 200,
          shardId: 'shard-a',
          documents: 3,
          connections: 5,
          uptimeSeconds: 7200,
          lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(),
          error: null,
        },
        {
          url: 'ws://localhost:1235',
          reachable: false,
          statusCode: null,
          shardId: null,
          documents: null,
          connections: null,
          uptimeSeconds: null,
          lastHeartbeatAt: null,
          error: 'fetch failed',
        },
      ],
      healthy: 1,
      total: 2,
    });
  }

  // GET /stats
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'stats') {
    const active = state.docs.filter((doc) => !doc.deletedAt);
    const memberships = active.reduce((sum, doc) => sum + (state.members.get(doc.id) ?? []).length, 0);
    const distinct = new Set(
      active.flatMap((doc) => (state.members.get(doc.id) ?? []).map((member) => member.userId)),
    );
    return json(res, 200, {
      documents: {
        total: active.length,
        doc: active.filter((doc) => doc.kind === 'doc').length,
        sheet: active.filter((doc) => doc.kind === 'sheet').length,
        deleted: state.docs.filter((doc) => doc.deletedAt).length,
      },
      activeDocuments24h: 4,
      distinctMembers: distinct.size,
      memberships,
      versions: state.docs.reduce((sum, doc) => sum + doc.versionCount, 0),
      opLogRows: 120000,
    });
  }

  // GET /audit-logs
  if (req.method === 'GET' && parts.length === 1 && parts[0] === 'audit-logs') {
    const action = url.searchParams.get('action') ?? '';
    const operatorFilter = url.searchParams.get('operatorId') ?? '';
    const targetId = url.searchParams.get('targetId') ?? '';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const { page, pageSize, offset } = readPaging(url);

    const filtered = state.auditLogs.filter((log) => {
      if (action && log.action !== action) return false;
      if (operatorFilter && log.operatorId !== operatorFilter) return false;
      if (targetId && log.targetId !== targetId) return false;
      if (from && new Date(log.createdAt) < new Date(from)) return false;
      if (to && new Date(log.createdAt) > new Date(to)) return false;
      return true;
    });

    return json(res, 200, {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize,
    });
  }

  return error(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    console.error('[mock-admin] 处理失败', err);
    error(res, 500, 'mock server error');
  }
});

server.listen(PORT, () => {
  console.log(`[mock-admin] http://localhost:${PORT}（token=${TOKEN || 'disabled'}）`);
  console.log('[mock-admin] 契约：docs/openapi-admin.yaml；重置数据：POST /__reset');
});
