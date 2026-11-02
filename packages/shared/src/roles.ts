import type { DocRole, DocSummary } from './types.js';

/** 拥有写权限的角色。spectator 永远不会被计入写者。 */
export const WRITE_ROLES: readonly DocRole[] = ['owner', 'editor'];

export function canWrite(role: DocRole): boolean {
  return role === 'owner' || role === 'editor';
}

export function isSpectator(role: DocRole): boolean {
  return role === 'spectator';
}

/** 有人存在感（presence）但不应广播光标坐标的角色。 */
export function broadcastsCursor(role: DocRole): boolean {
  return canWrite(role);
}

export function pickTitle(kind: DocSummary['kind']): string {
  if (kind === 'doc') return '未命名文档';
  if (kind === 'mindmap') return '未命名导图';
  return '未命名表格';
}
