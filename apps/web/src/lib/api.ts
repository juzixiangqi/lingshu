import type { DocDetail, DocKind, DocRole, SessionUser } from '@lingshu/shared';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8787';
const TOKEN_KEY = 'lingshu.token';
const USER_KEY = 'lingshu.user';

interface ErrorBody {
  error?: string;
}

interface DevLoginResponse {
  token: string;
  user: SessionUser;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getCurrentUser(): SessionUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

function setSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) {
    clearSession();
    throw new Error('登录已失效，请刷新页面');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

/** 开发期免密登录；M1 换成企业 SSO 后由 SSO 回调写入同一份 token。 */
export async function ensureSession(): Promise<SessionUser> {
  const cached = getCurrentUser();
  if (getToken() && cached) return cached;

  const suffix = Math.random().toString(36).slice(2, 8);
  const response = await fetch(`${BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: `访客 ${suffix}` }),
  });
  if (!response.ok) throw new Error('开发登录失败，请确认 API 服务已启动');
  const data = (await response.json()) as DevLoginResponse;
  setSession(data.token, data.user);
  return data.user;
}

/** 换一个身份，用于在同一台机器上验证多用户协同。 */
export async function switchIdentity(): Promise<SessionUser> {
  clearSession();
  return ensureSession();
}

export async function listDocs(): Promise<DocDetail[]> {
  const data = await request<{ docs: DocDetail[] }>('/api/docs');
  return data.docs;
}

export async function getDoc(id: string): Promise<DocDetail> {
  const data = await request<{ doc: DocDetail }>(`/api/docs/${id}`);
  return data.doc;
}

export async function createDoc(kind: DocKind): Promise<DocDetail> {
  const data = await request<{ doc: DocDetail }>('/api/docs', {
    method: 'POST',
    body: JSON.stringify({ kind }),
  });
  return data.doc;
}

export async function setMyRole(id: string, role: Exclude<DocRole, 'owner'>): Promise<DocDetail> {
  const data = await request<{ doc: DocDetail }>(`/api/docs/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
  return data.doc;
}
