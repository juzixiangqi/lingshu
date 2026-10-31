import { jwtVerify } from 'jose';
import { docIdFromDocumentName, type CollabContext, type DocRole } from '@lingshu/shared';
import { env } from '../env.js';
import { query } from '../db.js';
import type { AuthInput, AuthResult, AuthenticateDocument } from '../contracts/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

interface MemberRow {
  role: DocRole;
}

async function resolveUser(token: string): Promise<CollabContext['user'] | null> {
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

export const authenticateDocument: AuthenticateDocument = async (input: AuthInput): Promise<AuthResult> => {
  if (!input.token) {
    return { allowed: false, reason: 'missing token' };
  }

  const user = await resolveUser(input.token);
  if (!user) {
    return { allowed: false, reason: 'invalid token' };
  }

  const documentId = docIdFromDocumentName(input.documentName);
  if (!UUID_RE.test(documentId)) {
    return { allowed: false, reason: 'invalid document name' };
  }

  const rows = await query<MemberRow>(
    `select role from doc_members where document_id = $1 and user_id = $2`,
    [documentId, user.id],
  );
  const role = rows[0]?.role;
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
