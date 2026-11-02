import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeCollabDatabase, resetCollabDatabase, setupCollabDatabase } from './db.js';

let persistence: typeof import('../impl/persistence.js').persistence;
let query: typeof import('../db.js').query;

beforeAll(async () => {
  await setupCollabDatabase();
  persistence = (await import('../impl/persistence.js')).persistence;
  query = (await import('../db.js')).query;
});

afterAll(async () => {
  await closeCollabDatabase();
});

beforeEach(async () => {
  await resetCollabDatabase();
});

async function seedDocument(): Promise<{ userId: string; documentId: string; documentName: string }> {
  const userId = randomUUID();
  const documentId = randomUUID();
  const documentName = `${documentId}/body`;
  await query(
    `insert into users (id, email, display_name) values ($1, $2, '协作用户')`,
    [userId, `${userId}@example.com`],
  );
  await query(
    `insert into documents (id, owner_id, kind, title) values ($1, $2, 'doc', '协同文档')`,
    [documentId, userId],
  );
  return { userId, documentId, documentName };
}

async function insertVersion(
  documentName: string,
  documentId: string,
  version: number,
  createdAtSql: string,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into doc_snapshot_versions (document_name, document_id, snapshot, version, created_at)
     values ($1, $2, $3::jsonb, $4, ${createdAtSql})
     returning id`,
    [documentName, documentId, JSON.stringify({ format: 'yjs-v1', base64: '' }), version],
  );
  return rows[0]!.id;
}

describe('persistence.load / saveSnapshot / appendOp', () => {
  it('没有快照时返回 null', async () => {
    const { documentName } = await seedDocument();
    expect(await persistence.load(documentName)).toBeNull();
  });

  it('保存快照后可按原字节加载，版本号递增并追加历史版本', async () => {
    const { userId, documentId, documentName } = await seedDocument();
    const first = new Uint8Array([1, 2, 3]);
    await persistence.saveSnapshot({ documentName, documentId, state: first });

    const loaded = await persistence.load(documentName);
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([1, 2, 3]);

    const snapshotRow = await query<{ version: string }>(
      'select version from doc_snapshots where document_name = $1',
      [documentName],
    );
    expect(Number(snapshotRow[0]!.version)).toBe(1);

    const second = new Uint8Array([4, 5]);
    await persistence.saveSnapshot({
      documentName,
      documentId,
      state: second,
      operator: { userId, userName: '协作用户' },
    });

    const updated = await query<{ version: string }>(
      'select version from doc_snapshots where document_name = $1',
      [documentName],
    );
    expect(Number(updated[0]!.version)).toBe(2);
    expect(Array.from((await persistence.load(documentName))!)).toEqual([4, 5]);

    const history = await query<{ version: string; created_by: string | null; created_by_name: string }>(
      'select version, created_by, created_by_name from doc_snapshot_versions where document_name = $1 order by version',
      [documentName],
    );
    expect(history.map((row) => Number(row.version))).toEqual([1, 2]);
    // 第一次落盘没有操作者，第二次记录最后一位编辑者
    expect(history[0]!.created_by).toBeNull();
    expect(history[0]!.created_by_name).toBe('');
    expect(history[1]!.created_by).toBe(userId);
    expect(history[1]!.created_by_name).toBe('协作用户');
  });

  it('appendOp 以 base64 记录 update，并按字节还原，同时记录操作者', async () => {
    const { userId, documentId, documentName } = await seedDocument();
    const update = new Uint8Array([9, 8, 7]);
    await persistence.appendOp(documentName, documentId, update, {
      userId,
      userName: '协作用户',
    });

    const rows = await query<{
      payload: { format: string; base64: string };
      document_id: string;
      user_id: string | null;
      user_name: string;
    }>(
      'select payload, document_id, user_id, user_name from doc_op_log where document_name = $1',
      [documentName],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.document_id).toBe(documentId);
    expect(rows[0]!.payload.format).toBe('yjs-update');
    expect(Array.from(Buffer.from(rows[0]!.payload.base64, 'base64'))).toEqual([9, 8, 7]);
    expect(rows[0]!.user_id).toBe(userId);
    expect(rows[0]!.user_name).toBe('协作用户');
  });

  it('保存快照时裁剪 7 天前 op 流，并保留 7-90 天每天最早一份版本', async () => {
    const { documentId, documentName } = await seedDocument();

    const old100 = await insertVersion(documentName, documentId, 1, `now() - interval '100 days'`);
    const day80Early = await insertVersion(
      documentName,
      documentId,
      2,
      `date_trunc('day', now() - interval '80 days') + interval '1 hour'`,
    );
    const day80Late = await insertVersion(
      documentName,
      documentId,
      3,
      `date_trunc('day', now() - interval '80 days') + interval '6 hours'`,
    );
    const day8 = await insertVersion(documentName, documentId, 4, `now() - interval '8 days'`);
    const recent = await insertVersion(documentName, documentId, 5, `now() - interval '1 day'`);

    await query(
      `insert into doc_op_log (document_name, document_id, payload, created_at)
       values ($1, $2, $3::jsonb, now() - interval '8 days'),
              ($1, $2, $3::jsonb, now())`,
      [documentName, documentId, JSON.stringify({ format: 'yjs-update', base64: '' })],
    );

    await persistence.saveSnapshot({
      documentName,
      documentId,
      state: new Uint8Array([1]),
    });

    const remaining = await query<{ id: string }>(
      'select id from doc_snapshot_versions where document_name = $1 order by id',
      [documentName],
    );
    const ids = remaining.map((row) => String(row.id));
    expect(ids).not.toContain(old100);
    expect(ids).not.toContain(day80Late);
    expect(ids).toContain(day80Early);
    expect(ids).toContain(day8);
    expect(ids).toContain(recent);
    // 新快照本身也追加一条历史版本
    expect(ids).toHaveLength(4);

    const opRows = await query<{ id: string }>('select id from doc_op_log order by id');
    expect(opRows).toHaveLength(1);
    expect(String(opRows[0]!.id)).not.toBe('');
  });

  it('7 天内版本全部保留，不被裁剪', async () => {
    const { documentId, documentName } = await seedDocument();
    const keptA = await insertVersion(documentName, documentId, 1, `now() - interval '6 days'`);
    const keptB = await insertVersion(documentName, documentId, 2, `now() - interval '6 days 1 hour'`);

    await persistence.saveSnapshot({ documentName, documentId, state: new Uint8Array([2]) });

    const remaining = await query<{ id: string }>(
      'select id from doc_snapshot_versions where document_name = $1',
      [documentName],
    );
    const ids = remaining.map((row) => String(row.id));
    expect(ids).toContain(keptA);
    expect(ids).toContain(keptB);
  });
});
