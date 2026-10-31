import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const schemaPath = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

const sql = await readFile(schemaPath, 'utf8');
await pool.query(sql);
console.log(`[db] schema applied: ${schemaPath}`);
await pool.end();
