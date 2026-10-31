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
