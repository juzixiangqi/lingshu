/**
 * 设计文档中的硬性限额。
 * 这些数字是验收基线的一部分，改动需要同步修改设计文档与验收用例。
 */
export const LIMITS = {
  /** 单篇文档字数上限（一期不做分片加载，超限引导拆分） */
  maxDocChars: 80_000,
  /** 封面图标字符上限（按码点计数），防止把整段文本塞进图标字段 */
  maxIconChars: 8,
  /** 单文档并发连接硬上限 */
  maxConnectionsPerDoc: 200,
  /** 200 人场景下同时广播光标的写者上限，超出折叠为聚合标记 */
  maxBroadcastCursors: 20,
  /** 客户端光标广播的最小间隔（10 次/秒），比服务端 awarenes 合并窗口更粗 */
  cursorBroadcastIntervalMs: 100,
  /** 光标槽位的失效窗口：超过该时长未更新则让位给其他人 */
  cursorOwnerStaleMs: 5_000,
  /**
   * 被裁剪的 awareness 状态的放行间隔。
   * y-protocols 要求状态每 30s 至少更新一次，否则服务端会按超时移除该客户端；
   * 这里定期放行一次完整状态，既刷新服务端 meta，又不放大流量。
   */
  awarenessRepublishMs: 10_000,
  /** 客户端 awareness 更新频率上限对应的最小间隔 */
  awarenessThrottleMs: 40,
  /** 快照落盘：时间阈值 */
  snapshotIntervalMs: 30_000,
  /** 快照落盘：update 数量阈值 */
  snapshotUpdateThreshold: 500,
  /** op 流保留窗口，超出后仅保留快照级回滚 */
  opLogRetentionDays: 7,
} as const;
