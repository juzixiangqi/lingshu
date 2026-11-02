import { createImUserResolver, type ImUserInfo, type SessionUser } from '@lingshu/shared';
import { query } from './db.js';
import { env } from './env.js';

/**
 * IM 统一登录的落地层：
 * 1. 用 IM token 调 IM 的用户接口换取身份（由 shared 的解析器负责缓存）；
 *    HuLa 是 /oauth/anyone/getUserInfo，若依是 /getInfo，两者都由配置决定；
 * 2. 把 IM 用户镜像成本地 users 行，业务表继续用本地 uuid，避免全库改 user_id 类型。
 */
const resolver =
  env.authMode === 'im'
    ? createImUserResolver({
        userinfoUrl: env.im.userinfoUrl,
        tokenHeader: env.im.tokenHeader,
        tokenPrefix: env.im.tokenPrefix,
        timeoutMs: env.im.timeoutMs,
        cacheTtlMs: env.im.cacheTtlMs,
      })
    : null;

interface MirrorRow {
  id: string;
  email: string;
  display_name: string;
}

export function imAuthEnabled(): boolean {
  return resolver !== null;
}

export function imAuthConfigured(): boolean {
  return env.im.userinfoUrl.length > 0;
}

/** 返回本地会话用户；token 无效返回 null，IM 服务不可用则抛出 ImUserInfoUnavailableError。 */
export async function resolveImSessionUser(token: string): Promise<SessionUser | null> {
  if (!resolver) return null;
  const info = await resolver(token);
  if (!info) return null;
  return mirrorUser(info);
}

async function mirrorUser(info: ImUserInfo): Promise<SessionUser> {
  const existing = await query<MirrorRow>(
    `select id, email, display_name from users where im_user_id = $1`,
    [info.imUserId],
  );
  const row = existing[0];
  if (row) {
    if (row.display_name !== info.displayName) {
      await query(`update users set display_name = $2 where id = $1`, [row.id, info.displayName]);
    }
    return { id: row.id, email: row.email, displayName: info.displayName };
  }
  return insertMirror(info, info.email);
}

async function insertMirror(info: ImUserInfo, email: string): Promise<SessionUser> {
  try {
    const rows = await query<MirrorRow>(
      `insert into users (im_user_id, email, display_name)
       values ($1, $2, $3)
       on conflict (im_user_id) do update set display_name = excluded.display_name
       returning id, email, display_name`,
      [info.imUserId, email, info.displayName],
    );
    const row = rows[0];
    if (!row) throw new Error('IM 用户镜像写入失败');
    return { id: row.id, email: row.email, displayName: row.display_name };
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 邮箱已被本地历史账号占用：退回由 IM 用户 ID 生成的占位邮箱，保证登录不被阻断
    if (code === '23505' && email !== `${info.imUserId}@im.local`) {
      return insertMirror(info, `${info.imUserId}@im.local`);
    }
    throw error;
  }
}
