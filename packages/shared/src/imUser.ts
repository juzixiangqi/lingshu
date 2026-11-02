/**
 * IM 统一登录的用户信息解析。
 *
 * 兼容两种 IM 实现：
 * - HuLa-Server（luohuo）：GET /oauth/anyone/getUserInfo，Sa-Token 不透明 token，
 *   请求头 default「Token」且无前缀；响应 { code: 200, data: { id, uid, ... } }
 * - 若依 RuoYi：GET /getInfo，JWT + Bearer；响应 { code: 200, user: { userId, ... } }
 *
 * token 的合法性完全由 IM 侧校验，这里不解析签名，
 * 这样 IM 换实现或轮换密钥时，本项目只需改配置。
 */

export interface ImUserConfig {
  /**
   * 取当前用户的完整地址：
   * HuLa 为 http://im-gateway:8080/oauth/anyone/getUserInfo，
   * 若依为 http://im:8080/getInfo。留空视为未配置。
   */
  userinfoUrl: string;
  /** token 所在的请求头：HuLa 为 Token，若依为 Authorization */
  tokenHeader?: string;
  /** token 前缀：HuLa 为空，若依为 Bearer（末尾空格会自动补齐） */
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

interface ImUserinfoBody {
  code?: number;
  msg?: string;
  /** 若依：GET /getInfo */
  user?: {
    userId?: number | string;
    userName?: string;
    nickName?: string;
    email?: string;
  };
  /** HuLa（luohuo-oauth）：GET /oauth/anyone/getUserInfo */
  data?: {
    id?: number | string;
    uid?: number | string;
    username?: string;
    nickName?: string;
    email?: string;
  };
}

/** IM 里邮箱是选填项，缺失时用 IM 用户 ID 兜底，保证本系统 users.email 非空唯一。 */
const FALLBACK_EMAIL_DOMAIN = 'im.local';

function toImUser(
  rawId: number | string | undefined | null,
  email: string | undefined,
  name: string | undefined,
): ImUserInfo | null {
  if (rawId === undefined || rawId === null) return null;

  const imUserId = String(rawId).trim();
  if (!imUserId) return null;

  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const displayName = (name ?? '').trim().slice(0, 40);

  return {
    imUserId,
    email: normalizedEmail || `${imUserId}@${FALLBACK_EMAIL_DOMAIN}`,
    displayName: displayName || `用户 ${imUserId}`,
  };
}

function normalize(body: ImUserinfoBody): ImUserInfo | null {
  const hula = body.data;
  if (hula) {
    // 账号 id 优先：员工 id 可能随组织架构变动重建，账号 id 更稳定
    return toImUser(hula.id ?? hula.uid, hula.email, hula.nickName || hula.username);
  }

  const ruoyi = body.user;
  if (ruoyi) {
    return toImUser(ruoyi.userId, ruoyi.email, ruoyi.nickName || ruoyi.userName);
  }

  return null;
}

/**
 * 创建带缓存的解析器。
 * 缓存按 token 维度保存：token 失效后 IM 会返回 401 或 code 非 200，
 * 这里把“无效”也缓存一个周期，避免伪造 token 反复穿透到 IM。
 */
export function createImUserResolver(config: ImUserConfig): ImUserResolver {
  const cache = new Map<string, CacheEntry>();
  const ttlMs = config.cacheTtlMs ?? 60_000;
  const maxEntries = config.cacheMaxEntries ?? 5_000;
  const tokenHeader = config.tokenHeader ?? 'Token';
  const rawPrefix = config.tokenPrefix ?? '';
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

    let body: ImUserinfoBody;
    try {
      body = (await response.json()) as ImUserinfoBody;
    } catch {
      throw new ImUserInfoUnavailableError('IM 身份服务返回了非 JSON 响应');
    }

    const user = normalize(body);
    // 两种 IM 在 token 失效时都可能返回 HTTP 200 + 业务错误码，这里按“无用户信息”处理
    remember(token, user);
    return user;
  };
}
