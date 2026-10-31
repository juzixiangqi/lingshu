import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const HASH_PREFIX = 'scrypt';

async function derive(password: string, salt: string): Promise<Buffer> {
  return (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
}

/** 生成 `scrypt$<salt>$<hex>`，与运行时无原生依赖。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `${HASH_PREFIX}$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [prefix, salt, hash] = stored.split('$');
  if (prefix !== HASH_PREFIX || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(expected, actual);
}
