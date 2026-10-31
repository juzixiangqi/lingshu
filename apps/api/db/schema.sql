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

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('doc', 'sheet')),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

-- op 流：仅保留 7 天，用于近期内容级回滚；超出窗口后只保留快照级回滚
create table if not exists doc_op_log (
  id bigserial primary key,
  document_name text not null,
  document_id uuid references documents (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists doc_op_log_name_time_idx on doc_op_log (document_name, created_at desc);

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
