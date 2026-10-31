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
 * Hocuspocus 鉴权上下文中携带的信息。
 * 契约由人工定义，AI 只填充实现。
 */
export interface CollabContext {
  user: SessionUser;
  role: DocRole;
  documentId: string;
}
