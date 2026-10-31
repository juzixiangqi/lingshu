import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  query: vi.fn(async () => Promise.reject(new Error('database unavailable'))),
  pool: {},
}));

let authenticateDocument: typeof import('../impl/auth.js').authenticateDocument;
let env: { jwtSecret: string };

beforeAll(async () => {
  authenticateDocument = (await import('../impl/auth.js')).authenticateDocument;
  env = (await import('../env.js')).env;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('数据库不可用时的协同鉴权', () => {
  it('拒绝新连接而不是抛出原始堆栈', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await new SignJWT({ email: 'a@b.c', name: '用户' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuedAt()
      .sign(new TextEncoder().encode(env.jwtSecret));

    const result = await authenticateDocument({
      token,
      documentName: `${randomUUID()}/body`,
    });
    expect(result).toEqual({ allowed: false, reason: 'auth temporarily unavailable' });
    expect(warn).toHaveBeenCalled();
  });
});
