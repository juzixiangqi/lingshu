import type { DocPersistence, Operator, SnapshotPayload } from '../contracts/persistence.js';
import { query } from '../db.js';

interface SnapshotRow {
  snapshot: { format: string; base64: string };
  version: string;
}

/**
 * 快照以 JSONB 存 base64，格式为 { format: 'yjs-v1', base64 }。
 * 每次落盘同时追加一条历史版本；op 流单独入表，仅保留 7 天。
 *
 * 版本裁剪（与设计文档 §3.3 的精度分级对应）：
 * - 7 天内保留全部版本，支撑内容级回滚；
 * - 7–90 天只保留每天最早的一条快照，对应“快照级回滚”；
 * - 90 天以上与超窗口的 op 流一并清理，避免无限膨胀。
 */
export const persistence: DocPersistence = {
  async load(documentName: string): Promise<Uint8Array | null> {
    const rows = await query<SnapshotRow>(
      `select snapshot from doc_snapshots where document_name = $1`,
      [documentName],
    );
    const row = rows[0];
    if (!row) return null;
    return Buffer.from(row.snapshot.base64, 'base64');
  },

  async saveSnapshot(payload: SnapshotPayload): Promise<void> {
    const snapshot = {
      format: 'yjs-v1',
      base64: Buffer.from(payload.state).toString('base64'),
    };
    const rows = await query<SnapshotRow>(
      `insert into doc_snapshots (document_name, document_id, snapshot, version, updated_at)
       values ($1, $2, $3::jsonb, 1, now())
       on conflict (document_name) do update
         set snapshot = excluded.snapshot,
             document_id = excluded.document_id,
             version = doc_snapshots.version + 1,
             updated_at = now()
       returning snapshot, version`,
      [payload.documentName, payload.documentId, JSON.stringify(snapshot)],
    );
    const row = rows[0];
    if (!row) return;

    await query(
      `insert into doc_snapshot_versions
         (document_name, document_id, snapshot, version, created_by, created_by_name)
       values ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        payload.documentName,
        payload.documentId,
        JSON.stringify(row.snapshot),
        row.version,
        payload.operator?.userId ?? null,
        payload.operator?.userName ?? '',
      ],
    );

    await query(
      `delete from doc_snapshot_versions v
        where v.document_name = $1
          and v.created_at < now() - interval '7 days'
          and v.id not in (
            select distinct on (date_trunc('day', w.created_at)) w.id
              from doc_snapshot_versions w
             where w.document_name = $1
               and w.created_at < now() - interval '7 days'
               and w.created_at >= now() - interval '90 days'
             order by date_trunc('day', w.created_at), w.created_at
          )`,
      [payload.documentName],
    );

    await query(
      `delete from doc_op_log
        where document_name = $1 and created_at < now() - interval '7 days'`,
      [payload.documentName],
    );
  },

  async appendOp(
    documentName: string,
    documentId: string,
    update: Uint8Array,
    operator?: Operator | null,
  ): Promise<void> {
    await query(
      `insert into doc_op_log (document_name, document_id, payload, user_id, user_name)
       values ($1, $2, $3::jsonb, $4, $5)`,
      [
        documentName,
        documentId,
        JSON.stringify({ format: 'yjs-update', base64: Buffer.from(update).toString('base64') }),
        operator?.userId ?? null,
        operator?.userName ?? '',
      ],
    );
  },
};
