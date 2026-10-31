import { pool } from '../db.js';
import { applySchema, ensureTestDatabase, truncateAll } from './db-utils.js';

/** API 测试文件在 beforeAll 调用；会先建库再应用 schema.sql。 */
export async function setupApiDatabase(): Promise<void> {
  await ensureTestDatabase();
  await applySchema(pool);
}

export async function resetApiDatabase(): Promise<void> {
  await truncateAll(pool);
}

export async function closeApiDatabase(): Promise<void> {
  await pool.end();
}
