import { Hono } from 'hono';
import type { SessionUser } from '@lingshu/shared';
import { issueToken } from '../auth.js';
import { query } from '../db.js';

interface DevLoginBody {
  email?: string;
  displayName?: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

export const authRoutes = new Hono();

/**
 * 本地开发用的免密登录。M1 接入企业 SSO 后由 SSO 回调替代本路由。
 */
authRoutes.post('/dev-login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as DevLoginBody;
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = body.email?.trim() || `dev-${suffix}@lingshu.local`;
  const displayName = body.displayName?.trim() || `开发者 ${suffix}`;

  const rows = await query<UserRow>(
    `insert into users (email, display_name)
     values ($1, $2)
     on conflict (email) do update set display_name = excluded.display_name
     returning id, email, display_name`,
    [email, displayName],
  );
  const row = rows[0];
  if (!row) {
    return c.json({ error: 'failed to create user' }, 500);
  }

  const user: SessionUser = { id: row.id, email: row.email, displayName: row.display_name };
  return c.json({ token: await issueToken(user), user });
});
