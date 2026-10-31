import type { DocPersistence, SnapshotPayload } from '../contracts/persistence.js';
import { query } from '../db.js';

interface SnapshotRow {
  snapshot: { format: string; base64: string };
}

/**
 * 快照以 JSONB 存 base64，格式为 { format: 'yjs-v1', base64 }。
 * op 流单独入表，仅保留 7 天（清理任务见设计文档 M3 加固项）。
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
    await query(
      `insert into doc_snapshots (document_name, document_id, snapshot, version, updated_at)
       values ($1, $2, $3::jsonb, 1, now())
       on conflict (document_name) do update
         set snapshot = excluded.snapshot,
             document_id = excluded.document_id,
             version = doc_snapshots.version + 1,
             updated_at = now()`,
      [payload.documentName, payload.documentId, JSON.stringify(snapshot)],
    );
  },

  async appendOp(documentName: string, documentId: string, update: Uint8Array): Promise<void> {
    await query(
      `insert into doc_op_log (document_name, document_id, payload) values ($1, $2, $3::jsonb)`,
      [documentName, documentId, JSON.stringify({ format: 'yjs-update', base64: Buffer.from(update).toString('base64') })],
    );
  },
};
