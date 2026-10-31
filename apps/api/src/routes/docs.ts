import { Hono } from 'hono';
import type { DocDetail, DocKind, DocRole } from '@lingshu/shared';
import { documentNamesFor, pickShard } from '@lingshu/shared';
import { requireAuth } from '../auth.js';
import { query, withTransaction } from '../db.js';
import { env } from '../env.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocRow {
  id: string;
  kind: DocKind;
  title: string;
  role: DocRole;
  updated_at: Date;
}

interface CreateDocBody {
  kind?: DocKind;
  title?: string;
}

interface MemberBody {
  role?: 'editor' | 'spectator';
}

interface MembershipRow {
  role: DocRole;
}

function toDetail(row: DocRow): DocDetail {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    role: row.role,
    updatedAt: row.updated_at.toISOString(),
    collab: {
      // 一致性哈希：同一文档永远落到同一分片，广播不跨分片
      url: pickShard(row.id, env.collabShards),
      documentNames: documentNamesFor(row.id, row.kind),
    },
  };
}

export const docsRoutes = new Hono();

docsRoutes.use('*', requireAuth);

docsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await query<DocRow>(
    `select d.id, d.kind, d.title, m.role, d.updated_at
       from documents d
       join doc_members m on m.document_id = d.id
      where m.user_id = $1
      order by d.updated_at desc
      limit 100`,
    [user.id],
  );
  return c.json({ docs: rows.map(toDetail) });
});

docsRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as CreateDocBody;
  const kind: DocKind = body.kind === 'sheet' ? 'sheet' : 'doc';
  const title = body.title?.trim() || (kind === 'sheet' ? '未命名表格' : '未命名文档');

  const id = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into documents (owner_id, kind, title) values ($1, $2, $3) returning id`,
      [user.id, kind, title],
    );
    const documentId = inserted.rows[0]?.id;
    if (!documentId) throw new Error('创建文档失败');
    await client.query(`insert into doc_members (document_id, user_id, role) values ($1, $2, 'owner')`, [
      documentId,
      user.id,
    ]);
    return documentId;
  });

  const rows = await query<DocRow>(
    `select d.id, d.kind, d.title, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: toDetail(row) }, 201);
});

docsRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const rows = await query<DocRow>(
    `select d.id, d.kind, d.title, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: toDetail(row) });
});

/**
 * 调整当前用户在该文档中的角色，用于验证 editor / spectator 分层。
 * 非成员调用视为“通过文档链接加入”，默认授予请求的角色；
 * owner 不可降级。正式成员邀请与 ACL 由 M1 的 SSO 及权限模块接管。
 */
docsRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as MemberBody;
  const role = body.role === 'spectator' ? 'spectator' : 'editor';

  const existingDoc = await query<{ id: string }>(`select id from documents where id = $1`, [id]);
  if (!existingDoc[0]) return c.json({ error: 'not found' }, 404);

  const current = await query<MembershipRow>(
    `select role from doc_members where document_id = $1 and user_id = $2`,
    [id, user.id],
  );
  if (current[0]?.role === 'owner') return c.json({ error: 'owner 不可降级' }, 409);

  await query(
    `insert into doc_members (document_id, user_id, role) values ($1, $2, $3)
     on conflict (document_id, user_id) do update set role = excluded.role`,
    [id, user.id, role],
  );

  const rows = await query<DocRow>(
    `select d.id, d.kind, d.title, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: toDetail(row) });
});
