import { jwtVerify } from 'jose';
import {
  ImUserInfoUnavailableError,
  createImUserResolver,
  docIdFromDocumentName,
  type CollabContext,
  type DocRole,
} from '@lingshu/shared';
import { env } from '../env.js';
import { query } from '../db.js';
import type { AuthInput, AuthResult, AuthenticateDocument } from '../contracts/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

interface MemberRoleRow {
  role: DocRole;
}

interface MemberRow extends MemberRoleRow {
  id: string;
  email: string;
  display_name: string;
}

const imResolver =
  env.authMode === 'im'
    ? createImUserResolver({
        userinfoUrl: env.im.userinfoUrl,
        tokenHeader: env.im.tokenHeader,
        tokenPrefix: env.im.tokenPrefix,
        timeoutMs: env.im.timeoutMs,
        cacheTtlMs: env.im.cacheTtlMs,
      })
    : null;

async function resolveLocalUser(token: string): Promise<CollabContext['user'] | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(env.jwtSecret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ''),
      displayName: String(payload.name ?? ''),
    };
  } catch {
    return null;
  }
}

type ImMemberResult =
  | { status: 'ok'; user: CollabContext['user']; role: DocRole }
  | { status: 'invalid-token' }
  | { status: 'not-member' };

/** im 模式：IM userId 经 users.im_user_id 映射到本地 uuid，再查文档角色。 */
async function resolveImMember(token: string, documentId: string): Promise<ImMemberResult> {
  const identity = await imResolver!(token);
  if (!identity) return { status: 'invalid-token' };

  const rows = await query<MemberRow>(
    `select m.role, u.id, u.email, u.display_name
       from doc_members m
       join users u on u.id = m.user_id
      where m.document_id = $1 and u.im_user_id = $2`,
    [documentId, identity.imUserId],
  );
  const row = rows[0];
  if (!row) return { status: 'not-member' };
  return {
    status: 'ok',
    user: { id: row.id, email: row.email, displayName: row.display_name },
    role: row.role,
  };
}

export const authenticateDocument: AuthenticateDocument = async (input: AuthInput): Promise<AuthResult> => {
  if (!input.token) {
    return { allowed: false, reason: 'missing token' };
  }

  const documentId = docIdFromDocumentName(input.documentName);
  if (!UUID_RE.test(documentId)) {
    return { allowed: false, reason: 'invalid document name' };
  }

  let user: CollabContext['user'];
  let role: DocRole | undefined;

  try {
    if (env.authMode === 'im') {
      const member = await resolveImMember(input.token, documentId);
      if (member.status !== 'ok') {
        return {
          allowed: false,
          reason: member.status === 'invalid-token' ? 'invalid token' : 'not a member',
        };
      }
      user = member.user;
      role = member.role;
    } else {
      const local = await resolveLocalUser(input.token);
      if (!local) return { allowed: false, reason: 'invalid token' };
      user = local;
      const rows = await query<MemberRoleRow>(
        `select role from doc_members where document_id = $1 and user_id = $2`,
        [documentId, local.id],
      );
      role = rows[0]?.role;
    }
  } catch (error) {
    if (error instanceof ImUserInfoUnavailableError) {
      return { allowed: false, reason: 'auth temporarily unavailable' };
    }
    // 主库不可用时拒绝新连接而不是抛出原始堆栈；已建立的连接继续在内存中协同
    console.warn('[collab] 鉴权查询失败（主库可能不可用）', error instanceof Error ? error.message : error);
    return { allowed: false, reason: 'auth temporarily unavailable' };
  }

  if (!role) {
    return { allowed: false, reason: 'not a member' };
  }

  return {
    allowed: true,
    context: { user, role, documentId },
    // spectator 只读：不产生 update 广播，只接收收敛后的状态
    readOnly: role === 'spectator',
  };
};
