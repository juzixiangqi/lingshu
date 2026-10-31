import { Hono } from 'hono';
import type { SessionUser } from '@lingshu/shared';
import { issueToken, requireAuth } from '../auth.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../password.js';
import { query } from '../db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface RegisterBody {
  email?: string;
  password?: string;
  displayName?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface DevLoginBody {
  email?: string;
  displayName?: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
}

function normalizeEmail(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

function displayNameFor(body: RegisterBody, email: string): string {
  const explicit = body.displayName?.trim();
  if (explicit) return explicit.slice(0, 40);
  return email.split('@')[0]?.slice(0, 40) || '灵枢用户';
}

function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export const authRoutes = new Hono();

const IM_MODE_ERROR = '当前为 IM 统一登录模式，请从 IM 进入';

/** 前端据此决定展示登录表单还是“请从 IM 进入”的提示。 */
authRoutes.get('/mode', (c) => c.json({ mode: env.authMode }));

/** 账号密码注册，成功后直接签发会话 token。 */
authRoutes.post('/register', async (c) => {
  if (env.authMode === 'im') return c.json({ error: IM_MODE_ERROR }, 403);
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const email = normalizeEmail(body.email);
  const password = body.password ?? '';

  if (!EMAIL_RE.test(email)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    return c.json({ error: `密码长度需在 ${MIN_PASSWORD_LENGTH}–128 位之间` }, 400);
  }

  const passwordHash = await hashPassword(password);
  const rows = await query<UserRow>(
    `insert into users (email, display_name, password_hash)
     values ($1, $2, $3)
     on conflict (email) do nothing
     returning id, email, display_name, password_hash`,
    [email, displayNameFor(body, email), passwordHash],
  );
  const row = rows[0];
  if (!row) {
    return c.json({ error: '该邮箱已注册，请直接登录' }, 409);
  }

  const user = toSessionUser(row);
  return c.json({ token: await issueToken(user), user }, 201);
});

authRoutes.post('/login', async (c) => {
  if (env.authMode === 'im') return c.json({ error: IM_MODE_ERROR }, 403);
  const body = (await c.req.json().catch(() => ({}))) as LoginBody;
  const email = normalizeEmail(body.email);
  const password = body.password ?? '';
  if (!EMAIL_RE.test(email) || password.length === 0) {
    return c.json({ error: '邮箱或密码不正确' }, 401);
  }

  const rows = await query<UserRow>(
    `select id, email, display_name, password_hash from users where email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return c.json({ error: '邮箱或密码不正确' }, 401);
  }

  const user = toSessionUser(row);
  return c.json({ token: await issueToken(user), user });
});

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') });
});

/**
 * 本地开发与 M0 压测脚本用的免密登录，生产环境由 DEV_LOGIN_ENABLED=false 关闭。
 */
authRoutes.post('/dev-login', async (c) => {
  if (env.authMode === 'im') return c.json({ error: IM_MODE_ERROR }, 403);
  if (!env.devLoginEnabled) {
    return c.json({ error: 'dev-login 已关闭' }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as DevLoginBody;
  const email = normalizeEmail(body.email) || `dev-${Math.random().toString(36).slice(2, 8)}@lingshu.local`;
  const displayName = body.displayName?.trim() || `开发者 ${Math.random().toString(36).slice(2, 8)}`;

  const rows = await query<UserRow>(
    `insert into users (email, display_name)
     values ($1, $2)
     on conflict (email) do update set display_name = excluded.display_name
     returning id, email, display_name, password_hash`,
    [email, displayName],
  );
  const row = rows[0];
  if (!row) {
    return c.json({ error: 'failed to create user' }, 500);
  }

  const user = toSessionUser(row);
  return c.json({ token: await issueToken(user), user });
});
