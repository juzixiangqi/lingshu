import { Hono, type Context } from 'hono';
import {
  SHARD_HEALTH_KEY_PREFIX,
  documentNamesFor,
  type DocKind,
  type DocRole,
  type ShardHeartbeat,
} from '@lingshu/shared';
import { requireAdminService, writeAudit } from '../admin.js';
import { query } from '../db.js';
import { env } from '../env.js';
import { publishAclChange, redis } from '../redis.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocRow {
  id: string;
  kind: DocKind;
  title: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  owner_id: string;
  im_user_id: string | null;
  email: string;
  display_name: string;
  member_count: string;
}

interface MemberRow {
  user_id: string;
  role: DocRole;
  im_user_id: string | null;
  email: string;
  display_name: string;
  created_at: Date;
}

interface UserRow {
  id: string;
  im_user_id: string | null;
  email: string;
  display_name: string;
  doc_count: string;
}

interface AuditRow {
  id: string;
  operator_id: string;
  operator_name: string;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

function paging(c: Context): { page: number; pageSize: number; offset: number } {
  const rawPage = Number(c.req.query('page') ?? 1);
  const rawSize = Number(c.req.query('pageSize') ?? 20);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const pageSize = Number.isFinite(rawSize) ? Math.min(100, Math.max(1, Math.floor(rawSize))) : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function toDoc(row: DocRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    owner: {
      id: row.owner_id,
      imUserId: row.im_user_id,
      email: row.email,
      displayName: row.display_name,
    },
    memberCount: Number(row.member_count),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMember(row: MemberRow) {
  return {
    userId: row.user_id,
    imUserId: row.im_user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.created_at.toISOString(),
  };
}

const DOC_FIELDS = `
  d.id, d.kind, d.title, d.created_at, d.updated_at, d.deleted_at,
  u.id as owner_id, u.im_user_id, u.email, u.display_name,
  (select count(*) from doc_members m where m.document_id = d.id) as member_count`;

async function findDoc(documentId: string): Promise<DocRow | null> {
  const rows = await query<DocRow>(
    `select ${DOC_FIELDS}
       from documents d join users u on u.id = d.owner_id
      where d.id = $1`,
    [documentId],
  );
  return rows[0] ?? null;
}

async function listMembers(documentId: string): Promise<MemberRow[]> {
  return query<MemberRow>(
    `select m.user_id, m.role, u.im_user_id, u.email, u.display_name, m.created_at
       from doc_members m join users u on u.id = m.user_id
      where m.document_id = $1
      order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.created_at`,
    [documentId],
  );
}

function parseTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 分片探测走普通 HTTP：Hocuspocus 对任意 GET 都会返回 200，用于判断进程是否存活。 */
function toHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return url.toString();
  } catch {
    return null;
  }
}

function shardPort(raw: string): number | null {
  try {
    const port = Number(new URL(raw).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function probeShard(raw: string): Promise<{
  reachable: boolean;
  statusCode: number | null;
  error: string | null;
}> {
  const target = toHttpUrl(raw);
  if (!target) return { reachable: false, statusCode: null, error: '分片地址不合法' };
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(2_000) });
    if (response.body) await response.body.cancel().catch(() => undefined);
    return { reachable: true, statusCode: response.status, error: null };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      error: error instanceof Error ? error.message : '连接失败',
    };
  }
}

/** 心跳来自 Redis；Redis 不可用时返回空数组，页面仍能靠探测结果展示可达性。 */
async function readShardHeartbeats(): Promise<ShardHeartbeat[]> {
  try {
    if (redis.status === 'wait') await redis.connect();
    const keys = await redis.keys(`${SHARD_HEALTH_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const values = await redis.mget(...keys);
    return values.flatMap((value) => {
      if (!value) return [];
      try {
        const parsed = JSON.parse(value) as ShardHeartbeat;
        return typeof parsed.shardId === 'string' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export const internalAdminRoutes = new Hono();

internalAdminRoutes.use('*', requireAdminService);

/** 文档总览：支持标题、类型、创建人过滤与分页，默认不含回收站。 */
internalAdminRoutes.get('/docs', async (c) => {
  const { page, pageSize, offset } = paging(c);
  const keyword = (c.req.query('keyword') ?? '').trim();
  const kindParam = (c.req.query('kind') ?? '').trim();
  const kind =
    kindParam === 'doc' || kindParam === 'sheet' || kindParam === 'mindmap' ? kindParam : '';
  const ownerId = (c.req.query('ownerId') ?? '').trim();
  const deletedOnly = c.req.query('deletedOnly') === 'true';
  const includeDeleted = c.req.query('includeDeleted') === 'true' || deletedOnly;

  const filter = `
    where ($1 = '' or d.title ilike '%' || $1 || '%')
      and ($2 = '' or d.kind = $2)
      and ($3 = '' or u.im_user_id = $3 or u.id::text = $3)
      and ($4::boolean or d.deleted_at is null)
      and (not $5::boolean or d.deleted_at is not null)`;

  const totalRows = await query<{ total: string }>(
    `select count(*)::text as total from documents d join users u on u.id = d.owner_id ${filter}`,
    [keyword, kind, ownerId, includeDeleted, deletedOnly],
  );

  const rows = await query<DocRow>(
    `select ${DOC_FIELDS}
       from documents d join users u on u.id = d.owner_id
       ${filter}
      order by d.updated_at desc
      limit $6 offset $7`,
    [keyword, kind, ownerId, includeDeleted, deletedOnly, pageSize, offset],
  );

  return c.json({ items: rows.map(toDoc), total: Number(totalRows[0]?.total ?? 0), page, pageSize });
});

/** 文档详情：基础信息 + 成员 + 最近落盘时间 + 版本数。 */
internalAdminRoutes.get('/docs/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const doc = await findDoc(id);
  if (!doc) return c.json({ error: 'not found' }, 404);

  const names = documentNamesFor(doc.id, doc.kind);
  const savedRows = await query<{ last_saved_at: Date | null }>(
    `select max(updated_at) as last_saved_at from doc_snapshots where document_name = any($1)`,
    [names],
  );
  const versionRows = await query<{ total: string }>(
    `select count(*)::text as total from doc_snapshot_versions where document_name = any($1)`,
    [names],
  );
  const lastSavedAt = savedRows[0]?.last_saved_at ?? null;

  return c.json({
    doc: toDoc(doc),
    members: (await listMembers(id)).map(toMember),
    lastSavedAt: lastSavedAt ? lastSavedAt.toISOString() : null,
    versionCount: Number(versionRows[0]?.total ?? 0),
  });
});

/** 软删除：进入回收站，并通知协同分片断开该文档的在线连接。 */
internalAdminRoutes.delete('/docs/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const rows = await query<{ deleted_at: Date }>(
    `update documents set deleted_at = now() where id = $1 and deleted_at is null returning deleted_at`,
    [id],
  );
  const deletedAt = rows[0]?.deleted_at;
  if (!deletedAt) {
    const exists = await query<{ deleted_at: Date | null }>(
      `select deleted_at from documents where id = $1`,
      [id],
    );
    return exists[0] ? c.json({ error: '文档已在回收站' }, 409) : c.json({ error: 'not found' }, 404);
  }

  await publishAclChange(id);
  await writeAudit({
    operator: c.get('adminOperator'),
    action: 'doc.delete',
    targetType: 'document',
    targetId: id,
  });

  return c.json({ deletedAt: deletedAt.toISOString() });
});

/** 从回收站恢复。 */
internalAdminRoutes.post('/docs/:id/restore', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const rows = await query<{ id: string }>(
    `update documents set deleted_at = null where id = $1 and deleted_at is not null returning id`,
    [id],
  );
  if (!rows[0]) {
    const exists = await query<{ id: string }>(`select id from documents where id = $1`, [id]);
    return exists[0] ? c.json({ error: '文档不在回收站' }, 409) : c.json({ error: 'not found' }, 404);
  }

  await writeAudit({
    operator: c.get('adminOperator'),
    action: 'doc.restore',
    targetType: 'document',
    targetId: id,
  });

  const restored = await findDoc(id);
  return c.json({ doc: restored ? toDoc(restored) : null });
});

internalAdminRoutes.get('/docs/:id/members', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);
  const doc = await findDoc(id);
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ members: (await listMembers(id)).map(toMember) });
});

/** 管理端移除成员：所有者不可移除，移除后立即断开其协同连接。 */
internalAdminRoutes.delete('/docs/:id/members/:userId', async (c) => {
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) return c.json({ error: 'invalid id' }, 400);

  const rows = await query<{ role: DocRole }>(
    `select role from doc_members where document_id = $1 and user_id = $2`,
    [id, userId],
  );
  const role = rows[0]?.role;
  if (!role) return c.json({ error: '成员不存在' }, 404);
  if (role === 'owner') return c.json({ error: '不能移除所有者' }, 409);

  await query(`delete from doc_members where document_id = $1 and user_id = $2`, [id, userId]);
  await publishAclChange(id);
  await writeAudit({
    operator: c.get('adminOperator'),
    action: 'doc.member.remove',
    targetType: 'document_member',
    targetId: id,
    detail: { userId, role },
  });

  return c.json({ members: (await listMembers(id)).map(toMember) });
});

/** 用户检索：返回镜像用户与其参与的文档数，用于“按人查文档”。 */
internalAdminRoutes.get('/users', async (c) => {
  const { page, pageSize, offset } = paging(c);
  const keyword = (c.req.query('keyword') ?? '').trim();

  const filter = `
    where ($1 = '' or u.email ilike '%' || $1 || '%'
                 or u.display_name ilike '%' || $1 || '%'
                 or u.im_user_id = $1)`;

  const totalRows = await query<{ total: string }>(
    `select count(*)::text as total from users u ${filter}`,
    [keyword],
  );
  const rows = await query<UserRow>(
    `select u.id, u.im_user_id, u.email, u.display_name,
            (select count(*)
               from doc_members m join documents d on d.id = m.document_id
              where m.user_id = u.id and d.deleted_at is null) as doc_count
       from users u
       ${filter}
      order by u.created_at desc
      limit $2 offset $3`,
    [keyword, pageSize, offset],
  );

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      imUserId: row.im_user_id,
      email: row.email,
      displayName: row.display_name,
      docCount: Number(row.doc_count),
    })),
    total: Number(totalRows[0]?.total ?? 0),
    page,
    pageSize,
  });
});

/** 概览统计：只统计未删除文档，活跃度按最近 24 小时有快照落盘的文档数。 */
internalAdminRoutes.get('/stats', async (c) => {
  const docRows = await query<{
    total: string;
    doc: string;
    sheet: string;
    mindmap: string;
    deleted: string;
  }>(
    `select
       (count(*) filter (where deleted_at is null))::text as total,
       (count(*) filter (where deleted_at is null and kind = 'doc'))::text as doc,
       (count(*) filter (where deleted_at is null and kind = 'sheet'))::text as sheet,
       (count(*) filter (where deleted_at is null and kind = 'mindmap'))::text as mindmap,
       (count(*) filter (where deleted_at is not null))::text as deleted
     from documents`,
  );

  const memberRows = await query<{ memberships: string; distinct_members: string }>(
    `select count(*)::text as memberships, count(distinct m.user_id)::text as distinct_members
       from doc_members m join documents d on d.id = m.document_id
      where d.deleted_at is null`,
  );

  const activeRows = await query<{ active: string }>(
    `select count(distinct v.document_id)::text as active
       from doc_snapshot_versions v join documents d on d.id = v.document_id
      where d.deleted_at is null and v.created_at >= now() - interval '24 hours'`,
  );

  const versionRows = await query<{ total: string }>(
    `select count(*)::text as total from doc_snapshot_versions`,
  );
  const opRows = await query<{ total: string }>(`select count(*)::text as total from doc_op_log`);

  const docs = docRows[0];
  const members = memberRows[0];

  return c.json({
    documents: {
      total: Number(docs?.total ?? 0),
      doc: Number(docs?.doc ?? 0),
      sheet: Number(docs?.sheet ?? 0),
      mindmap: Number(docs?.mindmap ?? 0),
      deleted: Number(docs?.deleted ?? 0),
    },
    activeDocuments24h: Number(activeRows[0]?.active ?? 0),
    distinctMembers: Number(members?.distinct_members ?? 0),
    memberships: Number(members?.memberships ?? 0),
    versions: Number(versionRows[0]?.total ?? 0),
    opLogRows: Number(opRows[0]?.total ?? 0),
  });
});

/** 分片运行状态：逐分片探测可达性，并合并心跳里的文档数/连接数。 */
internalAdminRoutes.get('/shards', async (c) => {
  const heartbeats = await readShardHeartbeats();

  const items = await Promise.all(
    env.collabShards.map(async (raw) => {
      const probe = await probeShard(raw);
      const port = shardPort(raw);
      const heartbeat = port === null ? null : (heartbeats.find((item) => item.port === port) ?? null);
      const startedAt = heartbeat ? Date.parse(heartbeat.startedAt) : Number.NaN;

      return {
        url: raw,
        reachable: probe.reachable,
        statusCode: probe.statusCode,
        shardId: heartbeat?.shardId ?? null,
        documents: heartbeat?.documents ?? null,
        connections: heartbeat?.connections ?? null,
        uptimeSeconds: Number.isFinite(startedAt)
          ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
          : null,
        lastHeartbeatAt: heartbeat?.at ?? null,
        error: probe.error,
      };
    }),
  );

  return c.json({
    items,
    healthy: items.filter((item) => item.reachable).length,
    total: items.length,
  });
});

/** 审计日志：按操作类型、操作人、目标与时间范围过滤。 */
internalAdminRoutes.get('/audit-logs', async (c) => {
  const { page, pageSize, offset } = paging(c);
  const action = (c.req.query('action') ?? '').trim();
  const operatorId = (c.req.query('operatorId') ?? '').trim();
  const targetId = (c.req.query('targetId') ?? '').trim();
  const from = parseTime(c.req.query('from'));
  const to = parseTime(c.req.query('to'));

  const filter = `
    where ($1 = '' or action = $1)
      and ($2 = '' or operator_id = $2)
      and ($3 = '' or target_id = $3)
      and ($4::timestamptz is null or created_at >= $4::timestamptz)
      and ($5::timestamptz is null or created_at <= $5::timestamptz)`;

  const totalRows = await query<{ total: string }>(
    `select count(*)::text as total from admin_audit_logs ${filter}`,
    [action, operatorId, targetId, from, to],
  );

  const rows = await query<AuditRow>(
    `select id::text, operator_id, operator_name, action, target_type, target_id, detail, created_at
       from admin_audit_logs
       ${filter}
      order by created_at desc
      limit $6 offset $7`,
    [action, operatorId, targetId, from, to, pageSize, offset],
  );

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      operatorId: row.operator_id,
      operatorName: row.operator_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail,
      createdAt: row.created_at.toISOString(),
    })),
    total: Number(totalRows[0]?.total ?? 0),
    page,
    pageSize,
  });
});
