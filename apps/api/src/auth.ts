import { SignJWT, jwtVerify } from 'jose';
import { createMiddleware } from 'hono/factory';
import type { SessionUser } from '@lingshu/shared';
import { env } from './env.js';

const encoder = new TextEncoder();

function secretKey(): Uint8Array {
  return encoder.encode(env.jwtSecret);
}

export async function issueToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.displayName })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secretKey());
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ''),
      displayName: String(payload.name ?? ''),
    };
  } catch {
    return null;
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser;
  }
}

export const requireAuth = createMiddleware(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = token ? await verifyToken(token) : null;
  if (!user) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('user', user);
  await next();
});
