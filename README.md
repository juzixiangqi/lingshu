# 灵枢协同办公套件

飞书风格的多人协同办公套件：文档、电子表格、思维导图，支持实时协同、评论、版本、导出与后台管理。

## 技术栈

- 前端：React 19 + Vite + TipTap 3（文档）、Univer（表格）、mind-elixir（导图）
- 协同：Hocuspocus + Yjs，多分片一致性哈希路由
- 后端：Node.js + Hono + PostgreSQL + Redis
- 管理端：Vue 3 + Element Plus（`admin-web`，基于 vue-pure-admin，独立 pnpm 项目）
- 对象存储：MinIO（S3 兼容，可选）

## 目录结构

```
apps/web       用户端前端（React）
apps/api       业务 API（Hono）
apps/collab    协同网关（Hocuspocus，分片）
packages/shared 共享类型与工具
admin-web      管理控制台（Vue，独立依赖）
docker-compose.yml PostgreSQL / Redis / MinIO
```

## 环境要求

- Node.js >= 22.12
- pnpm 10（`corepack enable` 后自动使用）
- Docker Desktop（PostgreSQL、Redis；MinIO 可选）

## 快速开始

1. 安装依赖

```powershell
pnpm install
```

2. 准备环境变量（仓库根目录）

```powershell
Copy-Item .env.example .env
```

开发默认值即可直接跑通：Postgres `lingshu/lingshu@localhost:5432`、Redis `localhost:6379`、API `8787`。

3. 启动基础设施

```powershell
pnpm infra:up
```

只启动 Postgres 和 Redis。需要附件/图片上传时再加 MinIO：

```powershell
docker compose --profile storage up -d
```

4. 初始化数据库

```powershell
pnpm db:init
```

5. 启动全部服务

```powershell
pnpm dev
```

该命令先构建 `@lingshu/shared`，再并行启动三个进程：

| 服务 | 地址 |
|---|---|
| 用户端 | http://localhost:5173 |
| API | http://localhost:8787 |
| 协同网关（分片 A） | ws://localhost:1234 |

打开 http://localhost:5173，首次使用点「没有账号？去注册」创建账号（密码至少 8 位）。

需要第二个协同分片时，另开终端执行：

```powershell
pnpm --filter @lingshu/collab dev:shard-b
```

端口 1235，与 `.env` 中 `COLLAB_SHARDS` 的配置对应。

## 管理端

`admin-web` 是独立项目，需要单独安装依赖：

```powershell
Set-Location admin-web
pnpm install
Copy-Item .env.development.example .env.development
pnpm dev
```

然后访问 http://localhost:8848，默认账号 `admin` / `admin123`。

> Windows 下 `admin-web` 的 `pnpm dev` 脚本把 `NODE_OPTIONS` 写成前缀形式，PowerShell 会解析失败。可以直接用：
>
> ```powershell
> $env:NODE_OPTIONS='--max-old-space-size=4096'; pnpm exec vite
> ```

管理端的数据接口走 `/internal/admin`，由 Vite 代理到 API。要让「文档管理 / 分片 / 审计 / 回收站」页面拿到真实数据，需要在根 `.env` 里设置：

```env
INTERNAL_ADMIN_TOKEN=dev-admin-token
```

并与 `admin-web/.env.development` 的 `VITE_DOCS_ADMIN_TOKEN` 保持一致；该值为空时 `/internal/admin/*` 统一返回 404。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动用户端 + API + 协同网关 |
| `pnpm build` | 构建全部 workspace |
| `pnpm typecheck` | 全量 TypeScript 检查 |
| `pnpm test` | 运行单元测试（Vitest） |
| `pnpm db:init` | 应用数据库 schema |
| `pnpm infra:up` / `infra:down` / `infra:reset` | 启动 / 停止 / 清空基础设施 |
| `pnpm --filter @lingshu/collab dev:shard-b` | 启动协同分片 B（1235） |

## 关键环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AUTH_MODE` | `local` | `local` 使用本地账号密码；`im` 信任 IM 签发 token |
| `API_PORT` | `8787` | API 端口 |
| `DATABASE_URL` | `postgres://lingshu:lingshu@localhost:5432/lingshu` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `JWT_SECRET` | `dev-only-change-me` | 登录令牌签名，生产必须更换 |
| `COLLAB_SHARDS` | `ws://localhost:1234\|ws://localhost:1235` | 协同分片列表，`\|` 分隔 |
| `SHARD_ID` / `COLLAB_PORT` | `shard-a` / `1234` | 当前分片标识与端口 |
| `S3_ENDPOINT` / `S3_PORT` | `localhost` / `9000` | MinIO 地址 |
| `S3_BUCKET` | `lingshu` | 附件与图片桶名 |
| `INTERNAL_ADMIN_TOKEN` | 空 | 管理端服务令牌，空值关闭管理接口 |

完整说明见 `.env.example`。

## 常见问题

- **协同状态一直显示未连接**：确认 `pnpm dev` 中的 collab 进程已启动、1234 端口未被占用，且 `.env` 的 `COLLAB_SHARDS` 与运行分片一致。
- **图片/附件上传失败**：MinIO 默认不随 `infra:up` 启动，需要 `docker compose --profile storage up -d`；MinIO 官方镜像已从 Docker Hub 下架，新机器需从内网仓库或离线 tar 导入。
- **管理端页面提示 404 或未授权**：根 `.env` 的 `INTERNAL_ADMIN_TOKEN` 与 `admin-web/.env.development` 的 `VITE_DOCS_ADMIN_TOKEN` 不一致，或 API 未重启。
- **端口被占用**：`5173`、`8787`、`1234`、`8848` 任一被占用时，先结束占用进程再启动；`admin-web` 端口由 `admin-web/.env` 的 `VITE_PORT` 控制。
- **数据库需要重置**：`pnpm infra:reset` 会删除数据卷，之后重新执行 `pnpm db:init`。
