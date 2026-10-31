import type { Hono } from 'hono';

let appPromise: Promise<{ app: Hono }> | null = null;

export async function loadApp(): Promise<Hono> {
  appPromise ??= import('../app.js');
  return (await appPromise).app;
}

export interface ApiOptions {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

/** 直接调用 Hono 的 fetch 入口，不监听端口。 */
export async function api(path: string, options: ApiOptions = {}): Promise<Response> {
  const app = await loadApp();
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  return app.request(path, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'),
    headers,
    body:
      options.body !== undefined
        ? JSON.stringify(options.body)
        : options.rawBody !== undefined
          ? options.rawBody
          : undefined,
  });
}

export async function readJson<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface TestSession {
  token: string;
  user: { id: string; email: string; displayName: string };
}

export async function registerUser(
  email: string,
  password = 'password123',
  displayName?: string,
): Promise<TestSession> {
  const response = await api('/api/auth/register', {
    body: { email, password, ...(displayName ? { displayName } : {}) },
  });
  const body = await readJson<TestSession & { error?: string }>(response);
  if (!response.ok) throw new Error(`register failed: ${response.status} ${body.error ?? ''}`);
  return body;
}

export async function devLogin(
  email?: string,
  displayName?: string,
): Promise<TestSession> {
  const response = await api('/api/auth/dev-login', {
    body: { ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) },
  });
  const body = await readJson<TestSession & { error?: string }>(response);
  if (!response.ok) throw new Error(`dev-login failed: ${response.status} ${body.error ?? ''}`);
  return body;
}

export async function createDoc(
  token: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return api('/api/docs', { token, body });
}

export async function inviteMember(
  token: string,
  docId: string,
  email: string,
  role: 'editor' | 'spectator' = 'editor',
): Promise<Response> {
  return api(`/api/docs/${docId}/members`, { token, body: { email, role } });
}

/** 直接操作测试库，用于预置快照/版本等接口不便构造的数据。 */
export async function dbQuery<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
  const { query } = await import('../db.js');
  return query<T>(text, values);
}
