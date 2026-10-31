/**
 * 若依（RuoYi）IM 统一登录的用户信息解析。
 *
 * 只做两件事：带 IM token 调 /getInfo，把响应归一化成本系统的用户身份。
 * token 的合法性完全由 IM 侧校验，这里不重复解析 JWT 签名，
 * 这样 IM 轮换密钥或改用其它 token 方案时，本项目不需要同步改配置。
 */

export interface ImUserConfig {
  /** 若依 /getInfo 的完整地址，如 http://im.internal:8080/getInfo；留空视为未配置 */
  userinfoUrl: string;
  /** token 所在的请求头，默认 Authorization */
  tokenHeader?: string;
  /** token 前缀，默认 "Bearer "（含末尾空格，留空则不加前缀） */
  tokenPrefix?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
}

export interface ImUserInfo {
  imUserId: string;
  email: string;
  displayName: string;
}

/** IM 身份服务不可用（网络失败、超时、5xx），与“token 无效”区分开，便于上层返回 503。 */
export class ImUserInfoUnavailableError extends Error {
  constructor(message = 'IM 身份服务不可用') {
    super(message);
    this.name = 'ImUserInfoUnavailableError';
  }
}

export type ImUserResolver = (token: string) => Promise<ImUserInfo | null>;

interface CacheEntry {
  user: ImUserInfo | null;
  expiresAt: number;
}

interface RuoYiUserinfoBody {
  code?: number;
  msg?: string;
  user?: {
    userId?: number | string;
    userName?: string;
    nickName?: string;
    email?: string;
  };
}

/** 若依里邮箱是选填项，缺失时用 IM 用户 ID 兜底，保证本系统 users.email 非空唯一。 */
const FALLBACK_EMAIL_DOMAIN = 'im.local';

function normalize(body: RuoYiUserinfoBody): ImUserInfo | null {
  const raw = body.user;
  if (!raw || raw.userId === undefined || raw.userId === null) return null;

  const imUserId = String(raw.userId).trim();
  if (!imUserId) return null;

  const email = (raw.email ?? '').trim().toLowerCase();
  const displayName = (raw.nickName || raw.userName || '').trim().slice(0, 40);

  return {
    imUserId,
    email: email || `${imUserId}@${FALLBACK_EMAIL_DOMAIN}`,
    displayName: displayName || `用户 ${imUserId}`,
  };
}

/**
 * 创建带缓存的解析器。
 * 缓存按 token 维度保存：若依 token 失效后会在 /getInfo 返回 401，
 * 这里把“无效”也缓存一个周期，避免伪造 token 反复穿透到 IM。
 */
export function createImUserResolver(config: ImUserConfig): ImUserResolver {
  const cache = new Map<string, CacheEntry>();
  const ttlMs = config.cacheTtlMs ?? 60_000;
  const maxEntries = config.cacheMaxEntries ?? 5_000;
  const tokenHeader = config.tokenHeader ?? 'Authorization';
  const rawPrefix = config.tokenPrefix ?? 'Bearer ';
  // .env 里的值会被 dotenv 去掉尾部空格，这里统一补一个，避免拼成 "Bearerabc"
  const tokenPrefix = rawPrefix.length > 0 && !rawPrefix.endsWith(' ') ? `${rawPrefix} ` : rawPrefix;
  const timeoutMs = config.timeoutMs ?? 5_000;

  function remember(token: string, user: ImUserInfo | null): void {
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(token, { user, expiresAt: Date.now() + ttlMs });
  }

  return async (token) => {
    if (!config.userinfoUrl) {
      throw new ImUserInfoUnavailableError('未配置 IM_USERINFO_URL，无法校验 IM 身份');
    }

    const cached = cache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    let response: Response;
    try {
      response = await fetch(config.userinfoUrl, {
        headers: { [tokenHeader]: `${tokenPrefix}${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ImUserInfoUnavailableError(
        error instanceof Error ? error.message : 'IM 身份服务请求失败',
      );
    }

    if (response.status === 401 || response.status === 403) {
      remember(token, null);
      return null;
    }
    if (!response.ok) {
      throw new ImUserInfoUnavailableError(`IM 身份服务返回 ${response.status}`);
    }

    let body: RuoYiUserinfoBody;
    try {
      body = (await response.json()) as RuoYiUserinfoBody;
    } catch {
      throw new ImUserInfoUnavailableError('IM 身份服务返回了非 JSON 响应');
    }

    const user = normalize(body);
    // 若依在 token 失效时也可能返回 HTTP 200 + code=401
    remember(token, user);
    return user;
  };
}
