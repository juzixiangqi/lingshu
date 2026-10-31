import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';

const { Client } = pg;

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://lingshu:lingshu@localhost:5432/lingshu_test';

const SCHEMA_PATH = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

/** 若测试库不存在则创建（需要连接 pg 默认维护库，因此使用独立的短连接）。 */
export async function ensureTestDatabase(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const databaseName = url.pathname.replace(/^\//, '') || 'lingshu_test';
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`create database "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function applySchema(pool: Pool): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
}

/** 清空业务表；重启 identity 避免 bigserial 计数在用例间累积影响断言。 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `truncate table notifications, doc_op_log, doc_snapshot_versions, doc_snapshots,
       doc_members, documents, users restart identity cascade`,
  );
}
