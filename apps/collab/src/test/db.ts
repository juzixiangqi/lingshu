import { pool } from '../db.js';
import {
  applySchema,
  ensureTestDatabase,
  truncateAll,
} from '../../../api/src/test/db-utils.js';

export async function setupCollabDatabase(): Promise<void> {
  await ensureTestDatabase();
  await applySchema(pool);
}

export async function resetCollabDatabase(): Promise<void> {
  await truncateAll(pool);
}

export async function closeCollabDatabase(): Promise<void> {
  await pool.end();
}
