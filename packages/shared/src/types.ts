export type DocKind = 'doc' | 'sheet';

export type DocRole = 'owner' | 'editor' | 'spectator';

export interface DocSummary {
  id: string;
  kind: DocKind;
  title: string;
  role: DocRole;
  updatedAt: string;
}

export interface CollabTarget {
  /** 该文档所属协同分片的 WebSocket 地址 */
  url: string;
  /** 需要连接的 Y.Doc 名称（表格为 workbook + sheet 分片，文档为单个 body） */
  documentNames: string[];
}

export interface DocDetail extends DocSummary {
  collab: CollabTarget;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

/** 文档成员，用于 owner 的成员管理面板。 */
export interface DocMember {
  userId: string;
  email: string;
  displayName: string;
  role: DocRole;
  joinedAt: string;
}

/** 快照落盘状态，用于编辑器的自动保存提示。 */
export interface StorageState {
  savedAt: string | null;
  version: number;
}

/**
 * 版本历史条目。precision 由快照时间与 op 流保留窗口决定：
 * - content：7 天内，可恢复到该快照时刻的完整内容；
 * - snapshot：超出 7 天，仅保留快照级回滚。
 */
export type VersionPrecision = 'content' | 'snapshot';

export interface DocVersion {
  id: string;
  documentName: string;
  version: number;
  createdAt: string;
  precision: VersionPrecision;
}

/** 恢复所需的快照内容，仅对可写角色返回。 */
export interface DocVersionSnapshot extends DocVersion {
  format: string;
  base64: string;
}

/**
 * Hocuspocus 鉴权上下文中携带的信息。
 * 契约由人工定义，AI 只填充实现。
 */
export interface CollabContext {
  user: SessionUser;
  role: DocRole;
  documentId: string;
}

/** 站内通知来源。一期只有 @提及 一种。 */
export type NotificationKind = 'mention';

/** 站内通知条目，兜底展示在顶栏铃铛面板里。 */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  documentId: string;
  documentTitle: string;
  documentKind: DocKind;
  actorName: string;
  excerpt: string;
  readAt: string | null;
  createdAt: string;
}
