/**
 * 成员变更事件通道。
 * API 在邀请/移除成员后向该通道发布 documentId，协同分片订阅后重新校验
 * 连接成员的当前角色：被移除或角色变更的连接立即断开，重连时再走鉴权。
 * 设计约束：Redis 不进入 update/awareness 广播热路径，只承载这类低频控制事件。
 */
export const ACL_EVENT_CHANNEL = 'lingshu:acl';

export interface AclChangeEvent {
  documentId: string;
}

/**
 * 表格版本恢复的一次性协同消息。
 * opLog 被整体替换后，其他客户端无法增量应用，必须重载页面重建 Univer；
 * 协同分片只转发这一种控制消息，避免客户端把网关当广播器。
 */
export const RESTORE_STATELESS_PAYLOAD = JSON.stringify({ type: 'lingshu:restore' });
