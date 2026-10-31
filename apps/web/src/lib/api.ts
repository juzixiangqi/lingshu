import type {
  AppNotification,
  DocDetail,
  DocKind,
  DocMember,
  DocRole,
  DocVersion,
  DocVersionSnapshot,
  SessionUser,
  StorageState,
} from '@lingshu/shared';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8787';
const TOKEN_KEY = 'lingshu.token';
const USER_KEY = 'lingshu.user';

interface ErrorBody {
  error?: string;
}

interface AuthResponse {
  token: string;
  user: SessionUser;
}

/**
 * IM 统一登录的入口链接可携带 ?token=<IM JWT>。
 * 首次打开时写入本地会话并清掉地址栏里的 token，避免被复制传播。
 */
function bootstrapTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  url.searchParams.delete('token');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

bootstrapTokenFromUrl();

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 后端当前的登录模式：local（自建账号）或 im（从 IM 进入）。 */
export async function getAuthMode(): Promise<'local' | 'im'> {
  const response = await fetch(`${BASE_URL}/api/auth/mode`);
  const data = (await response.json().catch(() => ({}))) as { mode?: string };
  return data.mode === 'im' ? 'im' : 'local';
}

/** 用当前 token 拉一次用户信息，并写回本地缓存（IM 入口只带 token，不带用户信息）。 */
export async function fetchMe(): Promise<SessionUser> {
  const data = await request<{ user: SessionUser }>('/api/auth/me');
  const token = getToken();
  if (token) setSession(token, data.user);
  return data.user;
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

export function logout(): void {
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
    logout();
    throw new Error('登录已失效，请重新登录');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

async function submitAuth(path: 'login' | 'register', body: Record<string, string>): Promise<SessionUser> {
  const response = await fetch(`${BASE_URL}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Partial<AuthResponse> & ErrorBody;
  if (!response.ok || !data.token || !data.user) {
    throw new Error(data.error ?? `请求失败（${response.status}）`);
  }
  setSession(data.token, data.user);
  return data.user;
}

export function login(email: string, password: string): Promise<SessionUser> {
  return submitAuth('login', { email, password });
}

export function register(email: string, password: string, displayName: string): Promise<SessionUser> {
  return submitAuth('register', { email, password, displayName });
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

export async function listMembers(id: string): Promise<DocMember[]> {
  const data = await request<{ members: DocMember[] }>(`/api/docs/${id}/members`);
  return data.members;
}

export async function inviteMember(
  id: string,
  email: string,
  role: Exclude<DocRole, 'owner'>,
): Promise<DocMember[]> {
  const data = await request<{ members: DocMember[] }>(`/api/docs/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
  return data.members;
}

export async function removeMember(id: string, userId: string): Promise<DocMember[]> {
  const data = await request<{ members: DocMember[] }>(`/api/docs/${id}/members/${userId}`, {
    method: 'DELETE',
  });
  return data.members;
}

export async function getStorageState(id: string): Promise<StorageState> {
  const data = await request<{ storage: StorageState }>(`/api/docs/${id}/storage`);
  return data.storage;
}

export async function listVersions(id: string): Promise<DocVersion[]> {
  const data = await request<{ versions: DocVersion[] }>(`/api/docs/${id}/versions`);
  return data.versions;
}

/** 取回历史版本的快照内容；仅 owner / editor 可用，spectator 会被服务端拒绝。 */
export async function fetchVersionSnapshot(
  id: string,
  versionId: string,
): Promise<DocVersionSnapshot> {
  const data = await request<{ version: DocVersionSnapshot }>(
    `/api/docs/${id}/versions/${versionId}/restore`,
    { method: 'POST' },
  );
  return data.version;
}

/** 站内通知：兜底展示 @提及，面板轮询该接口拿未读数。 */
export async function listNotifications(): Promise<{
  notifications: AppNotification[];
  unread: number;
}> {
  return request<{ notifications: AppNotification[]; unread: number }>('/api/notifications');
}

export async function markNotificationsRead(ids?: string[]): Promise<number> {
  const data = await request<{ unread: number }>('/api/notifications/read', {
    method: 'POST',
    body: JSON.stringify(ids?.length ? { ids } : {}),
  });
  return data.unread;
}

/**
 * 上报 @提及。通知落库与 webhook 推送都在服务端完成，
 * 客户端只负责把被提及的成员与上下文摘要带上。
 */
export async function notifyMention(
  docId: string,
  userIds: string[],
  excerpt: string,
): Promise<{ delivered: number; webhook: string }> {
  return request<{ delivered: number; webhook: string }>(`/api/docs/${docId}/mentions`, {
    method: 'POST',
    body: JSON.stringify({ userIds, excerpt }),
  });
}
