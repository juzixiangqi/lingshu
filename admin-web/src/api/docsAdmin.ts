import axios from "axios";

/**
 * 灵枢文档协同 · 管理端接口封装。
 * 契约：docs/openapi-admin.yaml；外网开发默认指向本地 Mock（pnpm mock:admin）。
 */
export type DocKind = "doc" | "sheet" | "mindmap";
export type DocRole = "owner" | "editor" | "spectator";

export interface AdminUserBrief {
  id: string;
  imUserId: string | null;
  email: string;
  displayName: string;
}

export interface AdminDoc {
  id: string;
  kind: DocKind;
  title: string;
  owner: AdminUserBrief;
  memberCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMember {
  userId: string;
  imUserId: string | null;
  email: string;
  displayName: string;
  role: DocRole;
  joinedAt: string;
}

export interface AdminDocDetail {
  doc: AdminDoc;
  members: AdminMember[];
  lastSavedAt: string | null;
  versionCount: number;
}

export interface AdminUser {
  id: string;
  imUserId: string | null;
  email: string;
  displayName: string;
  docCount: number;
}

export interface AdminStats {
  documents: { total: number; doc: number; sheet: number; mindmap: number; deleted: number };
  activeDocuments24h: number;
  distinctMembers: number;
  memberships: number;
  versions: number;
  opLogRows: number;
}

export interface AuditLog {
  id: string;
  operatorId: string;
  operatorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AdminShardStatus {
  url: string;
  reachable: boolean;
  statusCode: number | null;
  shardId: string | null;
  documents: number | null;
  connections: number | null;
  uptimeSeconds: number | null;
  lastHeartbeatAt: string | null;
  error: string | null;
}

export interface AdminShardOverview {
  items: AdminShardStatus[];
  healthy: number;
  total: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const baseURL =
  (import.meta.env.VITE_DOCS_ADMIN_BASE_URL as string | undefined) ||
  "http://localhost:9100";
const serviceToken =
  (import.meta.env.VITE_DOCS_ADMIN_TOKEN as string | undefined) || "mock-token";
const operatorId =
  (import.meta.env.VITE_DOCS_ADMIN_OPERATOR_ID as string | undefined) || "admin-1";
const rawOperatorName =
  (import.meta.env.VITE_DOCS_ADMIN_OPERATOR_NAME as string | undefined) || "管理员";

/** HTTP 头只允许 ASCII：中文昵称需要 URL 编码，已编码的值不重复编码。 */
const operatorName = rawOperatorName.includes("%")
  ? rawOperatorName
  : encodeURIComponent(rawOperatorName);

const client = axios.create({ baseURL, timeout: 10_000 });

client.interceptors.request.use(config => {
  config.headers.set("X-Service-Token", serviceToken);
  config.headers.set("X-Operator-Id", operatorId);
  config.headers.set("X-Operator-Name", operatorName);
  return config;
});

export interface DocQuery {
  keyword?: string;
  kind?: DocKind | "";
  ownerId?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export function listDocs(params: DocQuery): Promise<Paginated<AdminDoc>> {
  return client.get<Paginated<AdminDoc>>("/docs", { params }).then(res => res.data);
}

export function getDoc(id: string): Promise<AdminDocDetail> {
  return client.get<AdminDocDetail>(`/docs/${id}`).then(res => res.data);
}

export function removeDoc(id: string): Promise<{ deletedAt: string }> {
  return client.delete<{ deletedAt: string }>(`/docs/${id}`).then(res => res.data);
}

export function restoreDoc(id: string): Promise<{ doc: AdminDoc }> {
  return client.post<{ doc: AdminDoc }>(`/docs/${id}/restore`).then(res => res.data);
}

export function listMembers(id: string): Promise<{ members: AdminMember[] }> {
  return client.get<{ members: AdminMember[] }>(`/docs/${id}/members`).then(res => res.data);
}

export function removeMember(id: string, userId: string): Promise<{ members: AdminMember[] }> {
  return client
    .delete<{ members: AdminMember[] }>(`/docs/${id}/members/${userId}`)
    .then(res => res.data);
}

export function listUsers(params: {
  keyword?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<AdminUser>> {
  return client.get<Paginated<AdminUser>>("/users", { params }).then(res => res.data);
}

export function getStats(): Promise<AdminStats> {
  return client.get<AdminStats>("/stats").then(res => res.data);
}

export function listAuditLogs(params: {
  action?: string;
  operatorId?: string;
  targetId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<AuditLog>> {
  return client.get<Paginated<AuditLog>>("/audit-logs", { params }).then(res => res.data);
}

/** 分片运行状态：可达性由 API 探测，文档数/连接数来自分片心跳。 */
export function listShards(): Promise<AdminShardOverview> {
  return client.get<AdminShardOverview>("/shards").then(res => res.data);
}
