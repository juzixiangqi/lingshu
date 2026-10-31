import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApiDatabase, resetApiDatabase, setupApiDatabase } from './db.js';
import { api, dbQuery, devLogin, readJson, registerUser } from './fixtures.js';

let env: { devLoginEnabled: boolean };

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
  env.devLoginEnabled = true;
});

describe('POST /api/auth/register', () => {
  it('注册成功后签发 token 并落库 scrypt 哈希', async () => {
    const response = await api('/api/auth/register', {
      body: { email: 'Owner@Example.COM ', password: 'password123', displayName: ' 所有者 ' },
    });
    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body.user.email).toBe('owner@example.com');
    expect(body.user.displayName).toBe('所有者');
    expect(typeof body.token).toBe('string');

    const rows = await dbQuery<{ password_hash: string }>(
      'select password_hash from users where email = $1',
      ['owner@example.com'],
    );
    const { verifyPassword } = await import('../password.js');
    expect(await verifyPassword('password123', rows[0]!.password_hash)).toBe(true);
    expect(await verifyPassword('wrong-password', rows[0]!.password_hash)).toBe(false);
  });

  it('未提供 displayName 时取邮箱前缀', async () => {
    const response = await api('/api/auth/register', {
      body: { email: 'alice@example.com', password: 'password123' },
    });
    const body = await readJson(response);
    expect(body.user.displayName).toBe('alice');
  });

  it('重复注册返回 409', async () => {
    await registerUser('dup@example.com');
    const response = await api('/api/auth/register', {
      body: { email: 'DUP@example.com', password: 'password123' },
    });
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toContain('已注册');
  });

  it('邮箱非法或密码长度不合法返回 400', async () => {
    for (const body of [
      { email: 'not-an-email', password: 'password123' },
      { email: 'x@example.com', password: 'short' },
      { email: 'y@example.com', password: 'a'.repeat(129) },
      { email: 'z@example.com' },
    ]) {
      const response = await api('/api/auth/register', { body });
      expect(response.status).toBe(400);
    }
  });

  it('无法解析的 JSON 体按空对象处理并返回 400', async () => {
    const response = await api('/api/auth/register', {
      rawBody: '{not-json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await registerUser('login@example.com', 'password123', '登录用户');
  });

  it('正确密码登录成功', async () => {
    const response = await api('/api/auth/login', {
      body: { email: ' LOGIN@example.com', password: 'password123' },
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.user.displayName).toBe('登录用户');
    expect(typeof body.token).toBe('string');
  });

  it('密码错误返回 401', async () => {
    const response = await api('/api/auth/login', {
      body: { email: 'login@example.com', password: 'wrong-password' },
    });
    expect(response.status).toBe(401);
  });

  it('账号不存在或参数缺失返回 401', async () => {
    for (const body of [
      { email: 'nobody@example.com', password: 'password123' },
      { email: 'bad', password: 'password123' },
      { email: 'login@example.com' },
      {},
    ]) {
      const response = await api('/api/auth/login', { body });
      expect(response.status).toBe(401);
    }
  });

  it('dev 用户没有密码哈希时不能密码登录', async () => {
    await devLogin('dev-nopass@example.com');
    const response = await api('/api/auth/login', {
      body: { email: 'dev-nopass@example.com', password: 'password123' },
    });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/auth/me 与 requireAuth', () => {
  it('无 token / 非法 token 返回 401，合法 token 返回当前用户', async () => {
    expect((await api('/api/auth/me')).status).toBe(401);

    const badToken = await api('/api/auth/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(badToken.status).toBe(401);

    const wrongScheme = await api('/api/auth/me', {
      headers: { authorization: 'Basic abc' },
    });
    expect(wrongScheme.status).toBe(401);

    const session = await registerUser('me@example.com');
    const response = await api('/api/auth/me', { token: session.token });
    expect(response.status).toBe(200);
    expect((await readJson(response)).user.email).toBe('me@example.com');
  });
});

describe('POST /api/auth/dev-login', () => {
  it('开启时创建用户，重复邮箱更新展示名', async () => {
    const first = await devLogin('dev@example.com', '开发者 A');
    expect(first.user.email).toBe('dev@example.com');
    expect(first.user.displayName).toBe('开发者 A');

    const second = await devLogin('DEV@example.com', '开发者 B');
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe('开发者 B');
  });

  it('未提供邮箱与展示名时生成默认值', async () => {
    const session = await devLogin();
    expect(session.user.email).toMatch(/^dev-.*@lingshu\.local$/);
    expect(session.user.displayName.length).toBeGreaterThan(0);
    expect(session.token).toBeTypeOf('string');
  });

  it('关闭时返回 403', async () => {
    env.devLoginEnabled = false;
    const response = await api('/api/auth/dev-login', { body: { email: 'closed@example.com' } });
    expect(response.status).toBe(403);
    expect((await readJson(response)).error).toContain('dev-login 已关闭');
  });
});
