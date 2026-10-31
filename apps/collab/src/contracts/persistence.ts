/**
 * =====================================================================
 * 人工管控点：协同持久化契约
 * =====================================================================
 * 快照落盘策略（30 秒 / 500 次 update 一次）与 op 流保留窗口（7 天）
 * 属于可承受故障模式的一部分，接口与验收用例由人工定义。
 *
 * 验收要点：
 *  1. 分片崩溃后，客户端重连能拿到最近一次快照，不出现空白文档。
 *  2. PostgreSQL 主库故障时，快照写入失败不得抛出到协同广播路径。
 *  3. op 流只用于 7 天内内容级回滚，超出窗口仅保留快照级回滚。
 * =====================================================================
 */

export interface SnapshotPayload {
  documentName: string;
  documentId: string;
  /** Y.encodeStateAsUpdate 的完整状态 */
  state: Uint8Array;
}

export interface DocPersistence {
  load(documentName: string): Promise<Uint8Array | null>;
  saveSnapshot(payload: SnapshotPayload): Promise<void>;
  appendOp(documentName: string, documentId: string, update: Uint8Array): Promise<void>;
}
