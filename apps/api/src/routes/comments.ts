import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { DocComment, DocRole } from '@lingshu/shared';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMENT_CONTENT_LIMIT = 500;
const COMMENT_EXCERPT_LIMIT = 200;

interface CommentRow {
  id: string;
  document_id: string;
  author_id: string | null;
  author_name: string | null;
  content: string;
  excerpt: string;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: Date | null;
  parent_id: string | null;
  created_at: Date;
}

function toComment(row: CommentRow): DocComment {
  return {
    id: row.id,
    documentId: row.document_id,
    authorId: row.author_id,
    authorName: row.author_name ?? '已注销成员',
    content: row.content,
    excerpt: row.excerpt,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    parentId: row.parent_id,
    createdAt: row.created_at.toISOString(),
  };
}

async function roleOf(documentId: string, userId: string): Promise<DocRole | null> {
  const rows = await query<{ role: DocRole }>(
    `select m.role from doc_members m join documents d on d.id = m.document_id
      where m.document_id = $1 and m.user_id = $2 and d.deleted_at is null`,
    [documentId, userId],
  );
  return rows[0]?.role ?? null;
}

async function listComments(documentId: string): Promise<DocComment[]> {
  const rows = await query<CommentRow>(
    `select c.id, c.document_id, c.author_id, u.display_name as author_name,
            c.content, c.excerpt, c.status, c.resolved_by, c.resolved_at, c.parent_id, c.created_at
       from doc_comments c left join users u on u.id = c.author_id
      where c.document_id = $1
      order by c.created_at, c.id`,
    [documentId],
  );
  return rows.map(toComment);
}

export const commentsRoutes = new Hono();

commentsRoutes.use('*', requireAuth);

/**
 * 评论列表：成员可见（含只读）。锚点在正文 commentMark 上，
 * 客户端按 id 对照，正文里没有对应锚点的即“原文已删除”。
 */
commentsRoutes.get('/:id/comments', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  if (!(await roleOf(id, user.id))) return c.json({ error: 'not found' }, 404);
  return c.json({ comments: await listComments(id) });
});

/**
 * 发起评论：可写角色。id 由客户端生成，与正文 commentMark 的 commentId 一致，
 * 服务端不校验锚点是否真的写进了正文（写锚点是协同事务，失败由客户端兜底回滚）。
 * 创建后给文档所有者写一条站内通知（作者本人除外）。
 */
commentsRoutes.post('/:id/comments', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (role === 'spectator') return c.json({ error: '只读成员不能评论' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    content?: string;
    excerpt?: string;
  };
  const commentId = body.id ?? '';
  if (!UUID_RE.test(commentId)) return c.json({ error: 'invalid comment id' }, 400);

  const content = (body.content ?? '').trim().slice(0, COMMENT_CONTENT_LIMIT);
  if (!content) return c.json({ error: '评论内容不能为空' }, 400);
  const excerpt = (body.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, COMMENT_EXCERPT_LIMIT);

  const inserted = await query<{ id: string }>(
    `insert into doc_comments (id, document_id, author_id, content, excerpt)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing
     returning id`,
    [commentId, id, user.id, content, excerpt],
  );
  if (!inserted.length) return c.json({ error: '评论已存在，请刷新后重试' }, 409);

  // 站内通知所有者（兜底通道，与 @提及 同一张表）
  await query(
    `insert into notifications (user_id, document_id, kind, actor_id, excerpt)
     select d.owner_id, d.id, 'comment', $2, $3
       from documents d
      where d.id = $1 and d.owner_id <> $2`,
    [id, user.id, content.slice(0, COMMENT_EXCERPT_LIMIT)],
  );

  const comments = await listComments(id);
  return c.json({ comments }, 201);
});

/**
 * 回复评论：可写角色，只支持对根评论回复（一层线程，不做无限嵌套）。
 * 回复没有正文锚点，id 由服务端生成；落库后给父评论作者写一条站内通知。
 */
commentsRoutes.post('/:id/comments/:commentId/replies', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  if (!UUID_RE.test(id) || !UUID_RE.test(commentId)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  if (role === 'spectator') return c.json({ error: '只读成员不能回复' }, 403);

  const rows = await query<{ author_id: string | null; parent_id: string | null; status: string }>(
    `select author_id, parent_id, status from doc_comments where id = $1 and document_id = $2`,
    [commentId, id],
  );
  const parent = rows[0];
  if (!parent) return c.json({ error: '评论不存在' }, 404);
  if (parent.parent_id) return c.json({ error: '只支持对根评论回复' }, 400);
  if (parent.status !== 'open') return c.json({ error: '该评论已解决，无法回复' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = (body.content ?? '').trim().slice(0, COMMENT_CONTENT_LIMIT);
  if (!content) return c.json({ error: '回复内容不能为空' }, 400);

  await query(
    `insert into doc_comments (id, document_id, author_id, content, parent_id)
     values ($1, $2, $3, $4, $5)`,
    [randomUUID(), id, user.id, content, commentId],
  );

  // 通知父评论作者（作者本人回复自己时不打扰）
  if (parent.author_id && parent.author_id !== user.id) {
    await query(
      `insert into notifications (user_id, document_id, kind, actor_id, excerpt)
       values ($1, $2, 'comment', $3, $4)`,
      [parent.author_id, id, user.id, content.slice(0, COMMENT_EXCERPT_LIMIT)],
    );
  }

  return c.json({ comments: await listComments(id) }, 201);
});

/**
 * 解决评论：仅评论作者或文档所有者。
 * 解决后客户端会把正文里的 commentMark 一并移除，评论只留在面板存档。
 */
commentsRoutes.patch('/:id/comments/:commentId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const commentId = c.req.param('commentId');
  if (!UUID_RE.test(id) || !UUID_RE.test(commentId)) return c.json({ error: 'invalid id' }, 400);

  const role = await roleOf(id, user.id);
  if (!role) return c.json({ error: 'not found' }, 404);

  const rows = await query<{ author_id: string | null; status: string; parent_id: string | null }>(
    `select author_id, status, parent_id from doc_comments where id = $1 and document_id = $2`,
    [commentId, id],
  );
  const comment = rows[0];
  if (!comment) return c.json({ error: '评论不存在' }, 404);
  if (comment.parent_id) return c.json({ error: '只有根评论可以解决' }, 400);
  if (comment.author_id !== user.id && role !== 'owner') {
    return c.json({ error: '仅评论作者或所有者可解决' }, 403);
  }

  await query(
    `update doc_comments
        set status = 'resolved', resolved_by = $3, resolved_at = now()
      where id = $1 and document_id = $2 and status = 'open'`,
    [commentId, id, user.id],
  );

  return c.json({ comments: await listComments(id) });
});
