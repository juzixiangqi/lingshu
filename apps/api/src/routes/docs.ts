import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type {
  DocDetail,
  DocKind,
  DocMember,
  DocRole,
  DocVersion,
  DocVersionSnapshot,
  StorageState,
  VersionPrecision,
} from '@lingshu/shared';
import { LIMITS, documentNamesFor, pickShard, pickTitle } from '@lingshu/shared';
import { requireAuth } from '../auth.js';
import { query, withTransaction } from '../db.js';
import { env } from '../env.js';
import { publishAclChange } from '../redis.js';
import { ensureBucket, presignUpload } from '../storage.js';
import { sendMentionWebhook } from '../webhook.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocRow {
  id: string;
  kind: DocKind;
  title: string;
  icon: string | null;
  role: DocRole;
  updated_at: Date;
}

interface CreateDocBody {
  kind?: DocKind;
  title?: string;
  icon?: string | null;
}

interface DocMetaBody {
  title?: string;
  icon?: string | null;
}

/** 标题上限：与列表展示宽度对齐，超长标题在中台/通知里会被截断。 */
const MAX_TITLE_CHARS = 120;

/**
 * 图标归一化：空串 / null 视为“清空，回退默认图标”；
 * 按码点计数（emoji 常占用多个 UTF-16 单元），防止把整段文本塞进图标字段。
 */
function normalizeIcon(value: unknown): { ok: true; icon: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, icon: null };
  if (typeof value !== 'string') return { ok: false };
  const icon = value.trim();
  if (!icon) return { ok: true, icon: null };
  if (Array.from(icon).length > LIMITS.maxIconChars) return { ok: false };
  return { ok: true, icon };
}

interface InviteBody {
  email?: string;
  role?: 'editor' | 'spectator';
}

interface MembershipRow {
  role: DocRole;
}

interface MemberRow {
  user_id: string;
  role: DocRole;
  email: string;
  display_name: string;
  created_at: Date;
}

interface UserLookupRow {
  id: string;
  email: string;
}

interface SnapshotRow {
  version: string;
  updated_at: Date;
}

function toDetail(row: DocRow): DocDetail {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    icon: row.icon,
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
    `select d.id, d.kind, d.title, d.icon, m.role, d.updated_at
       from documents d
       join doc_members m on m.document_id = d.id
      where m.user_id = $1 and d.deleted_at is null
      order by d.updated_at desc
      limit 100`,
    [user.id],
  );
  return c.json({ docs: rows.map(toDetail) });
});

docsRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as CreateDocBody;
  const kind: DocKind =
    body.kind === 'sheet' ? 'sheet' : body.kind === 'mindmap' ? 'mindmap' : 'doc';
  const title = body.title?.trim() || pickTitle(kind);
  // 模板带过来的封面图标随创建一次写入，避免新建后多发一次 PATCH
  const icon = normalizeIcon(body.icon);
  if (!icon.ok) return c.json({ error: `图标最多 ${LIMITS.maxIconChars} 个字符` }, 400);

  const id = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into documents (owner_id, kind, title, icon) values ($1, $2, $3, $4) returning id`,
      [user.id, kind, title, icon.icon],
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
    `select d.id, d.kind, d.title, d.icon, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2 and d.deleted_at is null`,
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
    `select d.id, d.kind, d.title, d.icon, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2 and d.deleted_at is null`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: toDetail(row) });
});

/**
 * 修改标题 / 封面图标：写者（owner / editor）可直接改，只读成员拒绝。
 * 两者都不参与协同正文，直接落库；改名会刷新 updated_at，只换图标则不动，
 * 避免“设个图标”把文档顶到最近更新第一位。
 */
docsRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (role === 'spectator') return c.json({ error: '只读成员不能修改文档信息' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as DocMetaBody;
  const hasTitle = body.title !== undefined;
  const hasIcon = body.icon !== undefined;
  if (!hasTitle && !hasIcon) return c.json({ error: '没有需要更新的字段' }, 400);

  let title: string | null = null;
  if (hasTitle) {
    title = (body.title ?? '').trim();
    if (!title) return c.json({ error: '标题不能为空' }, 400);
    if (title.length > MAX_TITLE_CHARS) {
      return c.json({ error: `标题不能超过 ${MAX_TITLE_CHARS} 字` }, 400);
    }
  }

  const icon = normalizeIcon(body.icon);
  if (!icon.ok) return c.json({ error: `图标最多 ${LIMITS.maxIconChars} 个字符` }, 400);

  await query(
    `update documents
        set title = coalesce($2, title),
            icon = case when $3 then $4 else icon end,
            updated_at = case when $2 is null then updated_at else now() end
      where id = $1 and deleted_at is null`,
    [id, title, hasIcon, icon.icon],
  );

  const rows = await query<DocRow>(
    `select d.id, d.kind, d.title, d.icon, m.role, d.updated_at
       from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2 and d.deleted_at is null`,
    [id, user.id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: toDetail(row) });
});

async function roleOf(documentId: string, userId: string): Promise<DocRole | null> {
  const rows = await query<MembershipRow>(
    `select m.role from doc_members m join documents d on d.id = m.document_id
      where m.document_id = $1 and m.user_id = $2 and d.deleted_at is null`,
    [documentId, userId],
  );
  return rows[0]?.role ?? null;
}

async function listMembers(documentId: string): Promise<DocMember[]> {
  const rows = await query<MemberRow>(
    `select m.user_id, m.role, u.email, u.display_name, m.created_at
       from doc_members m join users u on u.id = m.user_id
      where m.document_id = $1
      order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.created_at`,
    [documentId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.created_at.toISOString(),
  }));
}

/** 成员列表：成员可见，非成员一律 404，不暴露文档是否存在。 */
docsRoutes.get('/:id/members', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  return c.json({ members: await listMembers(id) });
});

/**
 * 仅 owner 可按邮箱邀请已有账号。角色只允许 editor / spectator；
 * 邀请成功后发布成员变更事件，协同分片会立即按新角色重新校验连接。
 */
docsRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  if ((await roleOf(id, user.id)) !== 'owner') {
    return c.json({ error: '仅所有者可邀请成员' }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as InviteBody;
  const email = (body.email ?? '').trim().toLowerCase();
  const role = body.role === 'spectator' ? 'spectator' : 'editor';
  if (!email) return c.json({ error: '请填写成员邮箱' }, 400);

  const users = await query<UserLookupRow>(`select id, email from users where email = $1`, [email]);
  const target = users[0];
  if (!target) {
    return c.json({ error: `该邮箱尚未注册灵枢账号：${email}` }, 404);
  }

  const currentRole = await roleOf(id, target.id);
  if (currentRole === 'owner') {
    return c.json({ error: '不能修改所有者的角色' }, 409);
  }

  await query(
    `insert into doc_members (document_id, user_id, role) values ($1, $2, $3)
     on conflict (document_id, user_id) do update set role = excluded.role`,
    [id, target.id, role],
  );
  await publishAclChange(id);

  return c.json({ members: await listMembers(id) }, currentRole ? 200 : 201);
});

/** 移除成员：仅 owner；所有者本身不可移除。事件发出后该成员在当前文档的连接立即断开。 */
docsRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) return c.json({ error: 'invalid id' }, 400);

  if ((await roleOf(id, user.id)) !== 'owner') {
    return c.json({ error: '仅所有者可移除成员' }, 403);
  }

  const targetRole = await roleOf(id, userId);
  if (!targetRole) return c.json({ error: '成员不存在' }, 404);
  if (targetRole === 'owner') return c.json({ error: '不能移除所有者' }, 409);

  await query(`delete from doc_members where document_id = $1 and user_id = $2`, [id, userId]);
  await publishAclChange(id);

  return c.json({ members: await listMembers(id) });
});

/** 最近一次快照落库时间，用于编辑器展示“已保存 / 保存中”。 */
docsRoutes.get('/:id/storage', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  if (!(await roleOf(id, user.id))) return c.json({ error: 'not found' }, 404);

  const rows = await query<SnapshotRow>(
    `select version, updated_at from doc_snapshots
      where document_id = $1
      order by updated_at desc
      limit 1`,
    [id],
  );
  const row = rows[0];
  const storage: StorageState = {
    savedAt: row ? row.updated_at.toISOString() : null,
    version: row ? Number(row.version) : 0,
  };
  return c.json({ storage });
});

/** 图片与附件的类型白名单；前端先校验，服务端按声明值再校验一次。 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const ATTACHMENT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * 生成文件预签名上传地址。浏览器直传 MinIO，不经过 API 中转；
 * 读取走 `/api/files/...` 代理，避免把 MinIO 暴露给客户端。
 */
docsRoutes.post('/:id/uploads', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (role === 'spectator') return c.json({ error: '只读成员不能上传文件' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    contentType?: string;
    size?: number;
    category?: 'image' | 'attachment';
  };
  const category = body.category === 'attachment' ? 'attachment' : 'image';
  const contentType = (body.contentType ?? '').toLowerCase();
  const ext = (category === 'attachment' ? ATTACHMENT_EXT : IMAGE_EXT)[contentType];
  if (!ext) {
    return c.json(
      {
        error:
          category === 'attachment'
            ? '仅支持 PDF / Word / Excel / PPT / ZIP / TXT / CSV 附件'
            : '仅支持 PNG / JPEG / GIF / WebP 图片',
      },
      400,
    );
  }

  const size = Number(body.size ?? 0);
  const limit = category === 'attachment' ? MAX_ATTACHMENT_BYTES : MAX_IMAGE_BYTES;
  if (!Number.isFinite(size) || size <= 0 || size > limit) {
    return c.json(
      { error: category === 'attachment' ? '附件大小需在 1 字节到 20 MB 之间' : '图片大小需在 1 字节到 5 MB 之间' },
      400,
    );
  }

  await ensureBucket();
  const file = `${randomUUID()}.${ext}`;
  const objectName = `docs/${id}/${file}`;
  return c.json({
    uploadUrl: await presignUpload(objectName, 600),
    fileUrl: `/api/files/docs/${id}/${file}`,
  });
});

interface DocAccessRow {
  kind: DocKind;
  role: DocRole;
}

interface VersionRow {
  id: string;
  document_name: string;
  version: string;
  created_at: Date;
  created_by_name: string;
}

interface VersionSnapshotRow extends VersionRow {
  snapshot: { format: string; base64: string };
}

/** 版本列表条数上限：200 人 30 秒一版，7 天内全量也远超一屏，列表只取最近若干条。 */
const VERSION_LIMIT = 60;

/**
 * 版本精度：7 天内保留完整 op 流，可回滚到该快照时刻的完整内容（内容级）；
 * 超出窗口仅保留每天最早一份快照（快照级）。
 */
function versionPrecision(createdAt: Date): VersionPrecision {
  const cutoff = Date.now() - LIMITS.opLogRetentionDays * 24 * 60 * 60 * 1000;
  return createdAt.getTime() >= cutoff ? 'content' : 'snapshot';
}

async function docAccess(documentId: string, userId: string): Promise<DocAccessRow | null> {
  const rows = await query<DocAccessRow>(
    `select d.kind, m.role from documents d join doc_members m on m.document_id = d.id
      where d.id = $1 and m.user_id = $2 and d.deleted_at is null`,
    [documentId, userId],
  );
  return rows[0] ?? null;
}

/** 版本历史列表：成员可见，按时间倒序。 */
docsRoutes.get('/:id/versions', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const access = await docAccess(id, user.id);
  if (!access) return c.json({ error: 'not found' }, 404);

  const rows = await query<VersionRow>(
    `select id, document_name, version, created_at, created_by_name
       from doc_snapshot_versions
      where document_name = any($1)
      order by created_at desc
      limit ${VERSION_LIMIT}`,
    [documentNamesFor(id, access.kind)],
  );

  const versions: DocVersion[] = rows.map((row) => ({
    id: row.id,
    documentName: row.document_name,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    precision: versionPrecision(row.created_at),
    createdByName: row.created_by_name,
  }));
  return c.json({ versions });
});

/**
 * 恢复历史版本：仅可写角色可取回快照内容。
 * 真正的回滚由持有协同连接的客户端把快照内容写回当前 Y.Doc，
 * 这样删除与插入都走正常协同事务，在线成员无需重连即可收敛。
 */
docsRoutes.post('/:id/versions/:versionId/restore', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  if (!UUID_RE.test(id) || !/^\d+$/.test(versionId)) return c.json({ error: 'invalid id' }, 400);

  const access = await docAccess(id, user.id);
  if (!access) return c.json({ error: 'not found' }, 404);
  if (access.role === 'spectator') return c.json({ error: '只读成员不能恢复历史版本' }, 403);

  const rows = await query<VersionSnapshotRow>(
    `select id, document_name, version, created_at, created_by_name, snapshot
       from doc_snapshot_versions
      where id = $1`,
    [versionId],
  );
  const row = rows[0];
  // 只允许恢复属于该文档的 Y.Doc，避免越权读取其他文档的快照
  if (!row || !documentNamesFor(id, access.kind).includes(row.document_name)) {
    return c.json({ error: '版本不存在' }, 404);
  }

  const version: DocVersionSnapshot = {
    id: row.id,
    documentName: row.document_name,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    precision: versionPrecision(row.created_at),
    createdByName: row.created_by_name,
    format: row.snapshot.format,
    base64: row.snapshot.base64,
  };
  return c.json({ version });
});

interface MentionBody {
  userIds?: string[];
  excerpt?: string;
}

interface MentionTargetRow {
  user_id: string;
  email: string;
  display_name: string;
}

interface DocTitleRow {
  title: string;
  kind: DocKind;
}

/** 单次提及最多通知的人数，防止误操作把整篇成员列表刷一遍。 */
const MENTION_TARGET_LIMIT = 20;
const MENTION_EXCERPT_LIMIT = 200;

/**
 * @提及：写站内通知（兜底）+ 推送外部 webhook（灵犀）。
 * 只允许可写角色，且只能提及当前文档的成员；通知先落库，webhook 失败不影响提及成功。
 */
docsRoutes.post('/:id/mentions', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const access = await docAccess(id, user.id);
  if (!access) return c.json({ error: 'not found' }, 404);
  if (access.role === 'spectator') return c.json({ error: '只读成员不能提及他人' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as MentionBody;
  const userIds = Array.from(
    new Set((body.userIds ?? []).filter((userId) => UUID_RE.test(userId) && userId !== user.id)),
  ).slice(0, MENTION_TARGET_LIMIT);
  if (!userIds.length) return c.json({ delivered: 0, webhook: 'skipped' });

  const excerpt = (body.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, MENTION_EXCERPT_LIMIT);

  // 只允许提及同文档成员，避免借提及接口给任意用户发通知
  const targets = await query<MentionTargetRow>(
    `select m.user_id, u.email, u.display_name
       from doc_members m join users u on u.id = m.user_id
      where m.document_id = $1 and m.user_id = any($2::uuid[])`,
    [id, userIds],
  );
  if (!targets.length) return c.json({ delivered: 0, webhook: 'skipped' });

  await query(
    `insert into notifications (user_id, document_id, kind, actor_id, excerpt)
     select unnest($1::uuid[]), $2, 'mention', $3, $4`,
    [targets.map((target) => target.user_id), id, user.id, excerpt],
  );

  const docs = await query<DocTitleRow>(`select title, kind from documents where id = $1`, [id]);
  const doc = docs[0];
  const webhook = doc
    ? await sendMentionWebhook({
        type: 'mention',
        documentId: id,
        documentTitle: doc.title,
        documentKind: doc.kind,
        url: `${env.webBaseUrl}${doc.kind === 'sheet' ? '/sheet' : '/doc'}/${id}`,
        actor: { id: user.id, displayName: user.displayName },
        recipients: targets.map((target) => ({
          id: target.user_id,
          displayName: target.display_name,
          email: target.email,
        })),
        excerpt,
        occurredAt: new Date().toISOString(),
      })
    : 'skipped';

  return c.json({ delivered: targets.length, webhook });
});
