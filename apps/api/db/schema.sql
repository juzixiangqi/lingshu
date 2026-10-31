-- 灵枢协同办公套件 · 初始表结构
-- 执行方式：pnpm db:init

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

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

-- op 流：仅保留 7 天，用于近期内容级回滚；超出窗口后只保留快照级回滚
create table if not exists doc_op_log (
  id bigserial primary key,
  document_name text not null,
  document_id uuid references documents (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists doc_op_log_name_time_idx on doc_op_log (document_name, created_at desc);
