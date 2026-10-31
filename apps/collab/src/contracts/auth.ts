import type { CollabContext } from '@lingshu/shared';

/**
 * =====================================================================
 * 人工管控点：协同鉴权契约
 * =====================================================================
 * 设计文档明确要求：权限钩子（onAuthenticate / onLoadDocument）不交给 AI
 * 自由发挥。本文件的类型定义与验收用例由人工维护；AI 只允许在
 * src/impl/auth.ts 中填充实现，且不得修改本文件的语义。
 *
 * 验收要点：
 *  1. 无 token 或 token 无效 → 拒绝，且不加载文档。
 *  2. 非文档成员 → 拒绝。
 *  3. spectator → 允许连接，但 readOnly 必须为 true，且不广播光标坐标。
 *  4. documentName 必须能反解出真实 document_id，禁止跨文档伪造。
 * =====================================================================
 */

export interface AuthInput {
  /** Hocuspocus provider 传入的 token（JWT） */
  token: string;
  /** 客户端请求连接的 Y.Doc 名称，形如 `<docId>/body` */
  documentName: string;
}

export type AuthResult =
  | { allowed: true; context: CollabContext; readOnly: boolean }
  | { allowed: false; reason: string };

export type AuthenticateDocument = (input: AuthInput) => Promise<AuthResult>;
