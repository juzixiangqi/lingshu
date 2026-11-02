import type { Connection } from '@hocuspocus/server';
import type { CollabContext, DocRole } from '@lingshu/shared';
import { query } from '../db.js';

interface LiveEntry {
  socketId: string;
  documentId: string;
  userId: string;
  role: DocRole;
  connection: Connection<CollabContext>;
}

interface MemberRoleRow {
  user_id: string;
  role: DocRole;
}

/**
 * 每个文档当前在线的连接。
 * 成员被移除或角色变更后，API 通过 Redis 事件触发这里重新校验并断开连接，
 * 而不是等客户端下一次重连才生效。
 */
const byDocument = new Map<string, Map<string, LiveEntry>>();

export function addLiveConnection(entry: LiveEntry): void {
  const group = byDocument.get(entry.documentId) ?? new Map<string, LiveEntry>();
  group.set(entry.socketId, entry);
  byDocument.set(entry.documentId, group);
}

export function removeLiveConnection(documentId: string, socketId: string): void {
  const group = byDocument.get(documentId);
  if (!group) return;
  group.delete(socketId);
  if (group.size === 0) byDocument.delete(documentId);
}

/**
 * 重新校验该文档所有在线成员的角色，角色失效或变化的连接立即关闭。
 * 文档被软删除后，这里的角色集合为空，所有连接会被一并断开。
 */
export async function syncDocumentMembership(documentId: string): Promise<void> {
  const group = byDocument.get(documentId);
  if (!group || group.size === 0) return;

  const userIds = [...new Set([...group.values()].map((entry) => entry.userId))];
  const rows = await query<MemberRoleRow>(
    `select m.user_id, m.role from doc_members m
       join documents d on d.id = m.document_id and d.deleted_at is null
      where m.document_id = $1 and m.user_id = any($2::uuid[])`,
    [documentId, userIds],
  );
  const roles = new Map(rows.map((row) => [row.user_id, row.role]));

  for (const entry of [...group.values()]) {
    const role = roles.get(entry.userId);
    if (!role || role !== entry.role) {
      console.log(
        `[collab] 成员权限变更，断开连接 doc=${documentId} user=${entry.userId} ` +
          `${entry.role} -> ${role ?? 'removed'}`,
      );
      entry.connection.close();
    }
  }
}
