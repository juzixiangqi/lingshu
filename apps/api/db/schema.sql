-- 灵枢协同办公套件 · 初始表结构
-- 执行方式：pnpm db:init

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- 账号密码登录。scrypt$<salt>$<hash>；历史 dev 用户为空，需注册后才可密码登录
alter table users add column if not exists password_hash text;

-- IM（若依）统一登录：users 降级为 IM 用户的本地镜像，im_user_id 保存 IM 侧 userId。
-- 文档权限仍以本地 uuid 关联，IM 用户 ID 的类型（Long/字符串）不影响业务表。
alter table users add column if not exists im_user_id text;
create unique index if not exists users_im_user_id_key on users (im_user_id);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('doc', 'sheet', 'mindmap')),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 管理端回收站：软删除。用户端查询、协同鉴权都必须过滤 deleted_at。
alter table documents add column if not exists deleted_at timestamptz;
create index if not exists documents_deleted_at_idx on documents (deleted_at);

-- 思维导图（图）接入：老库原地放宽 kind 约束。
alter table documents drop constraint if exists documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('doc', 'sheet', 'mindmap'));

-- 封面图标（emoji）。为空时前端按 kind 兜底默认图标，不强制每篇都设置。
alter table documents add column if not exists icon text;

create table if not exists doc_members (
  document_id uuid not null references documents (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'spectator')),
  created_at timestamptz not null default now(),
  primary key (document_id, user_id)
);

-- Y.Doc 快照。document_name 命名见 @lingshu/shared 的 documents.ts
create table if not exists doc_snapshots (
  document_name text primary key,
  document_id uuid references documents (id) on delete cascade,
  snapshot jsonb not null,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists doc_snapshots_document_id_idx on doc_snapshots (document_id);

-- 快照历史：每次落盘追加一条，供版本列表与回滚使用。
-- 7 天内保留全部版本；7–90 天只保留每天最早的一条；90 天以上清理（见 persistence.ts 的裁剪逻辑）。
create table if not exists doc_snapshot_versions (
  id bigserial primary key,
  document_name text not null,
  document_id uuid references documents (id) on delete cascade,
  snapshot jsonb not null,
  version bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists doc_snapshot_versions_name_time_idx
  on doc_snapshot_versions (document_name, created_at desc);

-- 版本归属：记录触发本次落盘的最后一位编辑者，供版本历史显示“由谁产生”。
-- 服务端本地写入或历史数据没有操作者，保持 null / 空串。
alter table doc_snapshot_versions
  add column if not exists created_by uuid references users (id) on delete set null;
alter table doc_snapshot_versions
  add column if not exists created_by_name text not null default '';

-- op 流：仅保留 7 天，用于近期内容级回滚；超出窗口后只保留快照级回滚
create table if not exists doc_op_log (
  id bigserial primary key,
  document_name text not null,
  document_id uuid references documents (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists doc_op_log_name_time_idx on doc_op_log (document_name, created_at desc);

-- 操作归属：每批协同 update 记录写入者，用于回答“谁改过这篇文档”。
-- onChange 回调拿不到鉴权用户时（服务端本地写入、回放）保持 null / 空串。
alter table doc_op_log add column if not exists user_id uuid references users (id) on delete set null;
alter table doc_op_log add column if not exists user_name text not null default '';
create index if not exists doc_op_log_user_time_idx on doc_op_log (user_id, created_at desc);

-- 站内通知：@提及 的兜底通道。webhook 推送失败或未配置时，用户仍能在顶栏看到未读提醒。
create table if not exists notifications (
  id bigserial primary key,
  user_id uuid not null references users (id) on delete cascade,
  document_id uuid not null references documents (id) on delete cascade,
  kind text not null check (kind in ('mention')),
  actor_id uuid references users (id) on delete set null,
  excerpt text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_time_idx
  on notifications (user_id, created_at desc);

-- 评论也会写站内通知，放宽 kind 约束（老库上原地升级）
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('mention', 'comment'));

-- 划词评论：锚点不落库（正文 commentMark 携带同一 id，随协同编辑自动迁移），
-- 这里只存线程数据。excerpt 冗余一份原文摘录，锚点丢失后评论仍有上下文。
create table if not exists doc_comments (
  id uuid primary key,
  document_id uuid not null references documents (id) on delete cascade,
  author_id uuid references users (id) on delete set null,
  content text not null,
  excerpt text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references users (id) on delete set null,
  resolved_at timestamptz,
  -- 回复线程：回复与根评论同表，parent_id 指向根评论；只支持一层回复
  parent_id uuid references doc_comments (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists doc_comments_document_time_idx
  on doc_comments (document_id, created_at);

-- 回复线程：老库原地补 parent_id
alter table doc_comments
  add column if not exists parent_id uuid references doc_comments (id) on delete cascade;

create index if not exists doc_comments_parent_idx
  on doc_comments (parent_id);

-- 管理端操作审计：操作人来自管理端自己的账号体系，与 IM 用户无关。
create table if not exists admin_audit_logs (
  id bigserial primary key,
  operator_id text not null,
  operator_name text not null default '',
  action text not null,
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_time_idx on admin_audit_logs (created_at desc);
