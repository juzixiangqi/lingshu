import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeCollabDatabase, resetCollabDatabase, setupCollabDatabase } from './db.js';

let query: typeof import('../db.js').query;
let authenticateDocument: typeof import('../impl/auth.js').authenticateDocument;
let env: { jwtSecret: string };

beforeAll(async () => {
  await setupCollabDatabase();
  query = (await import('../db.js')).query;
  authenticateDocument = (await import('../impl/auth.js')).authenticateDocument;
  env = (await import('../env.js')).env;
});

afterAll(async () => {
  await closeCollabDatabase();
});

beforeEach(async () => {
  await resetCollabDatabase();
});

const encoder = new TextEncoder();

async function tokenFor(userId: string, secret = env.jwtSecret): Promise<string> {
  return new SignJWT({ email: 'user@example.com', name: '协作用户' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(secret));
}

async function seedMembership(role: 'owner' | 'editor' | 'spectator') {
  const userId = randomUUID();
  const documentId = randomUUID();
  await query(`insert into users (id, email, display_name) values ($1, $2, '协作用户')`, [
    userId,
    `${userId}@example.com`,
  ]);
  await query(`insert into documents (id, owner_id, kind, title) values ($1, $2, 'doc', '文档')`, [
    documentId,
    userId,
  ]);
  await query(
    `insert into doc_members (document_id, user_id, role) values ($1, $2, $3)`,
    [documentId, userId, role],
  );
  return { userId, documentId, token: await tokenFor(userId) };
}

describe('authenticateDocument', () => {
  it('缺少 token 时拒绝', async () => {
    const result = await authenticateDocument({ token: '', documentName: 'x/body' });
    expect(result).toEqual({ allowed: false, reason: 'missing token' });
  });

  it('token 无效或没有 subject 时拒绝', async () => {
    const documentName = `${randomUUID()}/body`;
    const badToken = await tokenFor(randomUUID(), 'other-secret');
    const invalid = await authenticateDocument({ token: badToken, documentName });
    expect(invalid).toEqual({ allowed: false, reason: 'invalid token' });

    const noSubject = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(encoder.encode(env.jwtSecret));
    const result = await authenticateDocument({ token: noSubject, documentName });
    expect(result).toEqual({ allowed: false, reason: 'invalid token' });
  });

  it('documentName 无法反解出 UUID 时拒绝', async () => {
    const { userId } = await seedMembership('editor');
    const token = await tokenFor(userId);
    const result = await authenticateDocument({ token, documentName: 'not-a-uuid/body' });
    expect(result).toEqual({ allowed: false, reason: 'invalid document name' });
  });

  it('非文档成员拒绝', async () => {
    const { documentId } = await seedMembership('editor');
    const token = await tokenFor(randomUUID());
    const result = await authenticateDocument({ token, documentName: `${documentId}/body` });
    expect(result).toEqual({ allowed: false, reason: 'not a member' });
  });

  it('spectator 允许连接但 readOnly=true', async () => {
    const { documentId, userId, token } = await seedMembership('spectator');
    const result = await authenticateDocument({ token, documentName: `${documentId}/body` });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.readOnly).toBe(true);
    expect(result.context).toEqual({
      user: { id: userId, email: 'user@example.com', displayName: '协作用户' },
      role: 'spectator',
      documentId,
    });
  });

  it('owner/editor 允许连接且 readOnly=false，sheet 文档名同样可鉴权', async () => {
    const { documentId, userId, token } = await seedMembership('editor');
    const result = await authenticateDocument({ token, documentName: `${documentId}/sheet/main` });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.readOnly).toBe(false);
    expect(result.context.role).toBe('editor');
    expect(result.context.user.id).toBe(userId);

    const owner = await seedMembership('owner');
    const ownerResult = await authenticateDocument({
      token: owner.token,
      documentName: `${owner.documentId}/workbook`,
    });
    expect(ownerResult.allowed).toBe(true);
    if (!ownerResult.allowed) return;
    expect(ownerResult.readOnly).toBe(false);
    expect(ownerResult.context.role).toBe('owner');
  });
});
