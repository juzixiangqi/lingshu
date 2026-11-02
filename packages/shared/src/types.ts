export type DocKind = 'doc' | 'sheet' | 'mindmap';

export type DocRole = 'owner' | 'editor' | 'spectator';

export interface DocSummary {
  id: string;
  kind: DocKind;
  title: string;
  /** 封面图标（emoji）；为空表示使用类型默认图标 */
  icon: string | null;
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
  /** 触发该版本的最后一个编辑者；服务端本地写入或历史数据为空串 */
  createdByName: string;
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

/** 站内通知来源：@提及 与文档评论。 */
export type NotificationKind = 'mention' | 'comment';

/** 划词评论状态：open 挂在正文锚点上，resolved 已从正文移除锚点、仅留档。 */
export type CommentStatus = 'open' | 'resolved';

/**
 * 划词评论。锚点不进库：正文里的 commentMark（协同 Mark）携带同一个 id，
 * 位置随协同编辑自动迁移；正文对应文本被删除后，该评论即为“原文已删除”。
 */
export interface DocComment {
  id: string;
  documentId: string;
  authorId: string | null;
  authorName: string;
  content: string;
  /** 被评论的原文摘录，锚点丢失后仍能看出在评论什么；回复恒为空串 */
  excerpt: string;
  status: CommentStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  /** 回复所属的根评论 id；根评论为 null。回复没有正文锚点，不参与孤儿判定 */
  parentId: string | null;
  createdAt: string;
}

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
