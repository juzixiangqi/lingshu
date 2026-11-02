import { Hono } from 'hono';
import type { AppNotification, DocKind, NotificationKind } from '@lingshu/shared';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  document_id: string;
  document_title: string;
  document_kind: DocKind;
  actor_name: string | null;
  excerpt: string;
  read_at: Date | null;
  created_at: Date;
}

interface UnreadRow {
  unread: string;
}

/** 面板只取最近若干条，避免一次拉完整历史。 */
const NOTIFICATION_LIMIT = 20;

interface ReadBody {
  ids?: string[];
}

export const notificationsRoutes = new Hono();

notificationsRoutes.use('*', requireAuth);

async function unreadCount(userId: string): Promise<number> {
  const rows = await query<UnreadRow>(
    `select count(*)::text as unread
       from notifications n join documents d on d.id = n.document_id
      where n.user_id = $1 and n.read_at is null and d.deleted_at is null`,
    [userId],
  );
  return Number(rows[0]?.unread ?? 0);
}

/** 站内通知列表：兜底通道，客户端轮询未读数。 */
notificationsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await query<NotificationRow>(
    `select n.id, n.kind, n.document_id, d.title as document_title, d.kind as document_kind,
            u.display_name as actor_name, n.excerpt, n.read_at, n.created_at
       from notifications n
       join documents d on d.id = n.document_id
       left join users u on u.id = n.actor_id
      where n.user_id = $1 and d.deleted_at is null
      order by n.created_at desc
      limit ${NOTIFICATION_LIMIT}`,
    [user.id],
  );

  const notifications: AppNotification[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentKind: row.document_kind,
    actorName: row.actor_name ?? '已注销成员',
    excerpt: row.excerpt,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  }));

  return c.json({ notifications, unread: await unreadCount(user.id) });
});

/** 标记已读：带 ids 只标记指定条目，不带则全部已读。 */
notificationsRoutes.post('/read', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as ReadBody;
  const ids = (body.ids ?? []).filter((id) => /^\d+$/.test(id));

  if (ids.length) {
    await query(
      `update notifications set read_at = now() where user_id = $1 and read_at is null and id = any($2::bigint[])`,
      [user.id, ids],
    );
  } else {
    await query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [
      user.id,
    ]);
  }

  return c.json({ unread: await unreadCount(user.id) });
});
