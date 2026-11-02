# 灵枢文档协同 · 管理端接入方案

> 状态：方案确认稿（2026-11-01，按 HuLa-Server 鉴权方式修订）
> 前置：M0 / M1 / M2 已完成，IM 统一登录（`AUTH_MODE=im`）已落地并验证。
> IM 实现：HuLa-Server（luohuo，Spring Cloud + Sa-Token + 网关），用户身份与 token 校验以它为准。
> 管理端：独立系统，有自己的账号与鉴权，通过既有服务间方式调用 IM API；Lingshu 只负责向它提供内部管理 API，不参与其登录与菜单权限。

## 一、结论与范围

不新建独立管理端。管理能力全部收敛为 Lingshu 的一组内部 API，由公司现有的独立管理端后端代理，管理界面复用该管理端已有的菜单与登录态。

| 归属 | 承担内容 |
|---|---|
| IM（HuLa-Server） | 用户端身份：token 签发与校验、`/oauth/anyone/getUserInfo` |
| 现有管理端（独立系统） | 管理员登录、菜单与权限、管理页面、代理转发、操作人身份 |
| Lingshu | 用户端页面（独立 Web 站）、协同服务、文档数据、内部管理 API |
| 不做 | Lingshu 自己的后台 UI、第二套账号体系、第二套 RBAC |

本期管理端页面范围（最小可用）：

1. 文档总览（搜索 / 按类型 / 按创建人 / 分页）
2. 文档详情（基本信息、成员列表、最近保存时间）
3. 回收站（列表 / 恢复）
4. 成员权限查看与移除（仅管理员操作）
5. 审计日志
6. 运行状态（分片健康、活跃文档数）— 第二期

## 二、整体架构

```
IM 客户端 / IM Web ──入口链接──> docs.内网域名（Lingshu Web，独立站）
现有管理端(Vue) ──> 管理端后端(Spring Boot) ──X-Service-Token──> Lingshu /internal/admin/*
Lingshu Web/API/Collab ── Token 头 ──> luohuo-gateway ──> /oauth/anyone/getUserInfo
Lingshu ──> 独立 PostgreSQL + 独立 Redis
```

要点：

- `/internal/admin/*` 不对公网/浏览器暴露，只允许现有管理端后端在内网调用。
- 用户端与管理端的身份来源不同：用户端用 IM 用户 token，管理端用 service token + 操作人标识。

## 三、身份与鉴权

### 3.1 用户端（已完成）

HuLa-Server 的鉴权事实（源码核对）：

| 项 | 实现 | 依据 |
|---|---|---|
| 认证框架 | Sa-Token，网关 `luohuo-gateway` 统一校验 | `StpInterfaceServiceImpl`、网关路由配置 |
| 登录接口 | `POST /oauth/anyTenant/login`，body 含 `grantType=PASSWORD`、`account`、`password`、`clientId`、`systemType`、`deviceType` | `RootController` |
| 当前用户接口 | `GET /oauth/anyone/getUserInfo` | `UserInfoController` |
| token 请求头 | `Token`，无前缀 | Nacos `common.yml`：`token-name: Token`、`token-prefix:` 空 |
| token 形态 | 不透明字符串（非 JWT），无法本地验签 | Sa-Token 机制 |
| 用户 ID | 返回 `data.id`（账号 ID）与 `data.uid`（员工 ID）；`ContextUtil.getUserId()` 取账号 ID | `DefUserInfoResultVO`、`OauthUserBiz` |
| token 生命周期 | 有效期 30 天；100 分钟无操作失效 | `timeout: 2592000`、`active-timeout: 6000` |
| 并发登录 | `is-concurrent: false`，新登录挤掉旧 token | `common.yml` |

Lingshu 的落地方式：

- `AUTH_MODE=im` 时，用 IM token 调 `GET /oauth/anyone/getUserInfo`（经网关），合法性由 IM 校验，不解析签名。
- 首次访问写入本地镜像：`users.im_user_id` 取 IM 的 `data.id`（账号 ID）；业务表继续用本地 uuid，不改 `doc_members` 主键。
- token 缓存 60 秒，同时兼顾 `active-timeout`：缓存周期内定期访问 IM，可避免 100 分钟无操作被判失效。
- IM 服务不可用返回 503，token 无效返回 401。
- 入口链接：`http://docs.内网域名/?token=<IM 当前 Token>`，前端存入本地会话后清理地址栏。
- Lingshu 对外仍用 `Authorization: Bearer <token>` 接收前端请求，只是调 IM 时改成 `Token: <token>`。

### 3.2 管理端

- 鉴权头：`X-Service-Token: <INTERNAL_ADMIN_TOKEN>`，与用户 token 完全隔离。
- 可选 IP 白名单：`INTERNAL_ADMIN_IPS`（逗号分隔，取 `X-Forwarded-For` 首段）。
- 操作人透传：管理端后端带 `X-Operator-Id`、`X-Operator-Name`，取管理端自己的账号（管理员与 IM 用户不是同一身份，两者不需要映射）。
  `X-Operator-Name` 允许为空；含中文或空格时必须用 URL 编码（`encodeURIComponent` / `URLEncoder.encode`），HTTP 头不能直接放非 ASCII 字符。
- 菜单与按钮权限完全由管理端自己的模型维护，Lingshu 不建模；Lingshu 只认 service token。
- 管理端如何获得调用 IM 的能力（固定服务凭证、服务账号登录、网关白名单等）沿用其既有做法，与 Lingshu 无关。

### 3.3 已知约束

- token 不是 JWT，Lingshu 无法脱离 IM 独立校验；IM 不可用时用户端直接不可用（返回 503）。这是选择“零侵入”的代价，可接受。
- `active-timeout=100 分钟`：用户只编辑文档、完全不调用 IM 接口时，token 可能被判定失效。现有 60 秒缓存 + 文档页轮询会持续刷新活跃时间，需在联调时实测确认。
- `is-concurrent=false`：同一账号在别处重新登录会挤掉旧 token，正在编辑的文档页会 401 并跳回入口页。需在前端给出明确提示（“账号已在其他设备登录”）。
- 管理端的 `admin` 是独立系统的账号，不是 IM 用户，其登录态在 Lingshu 用户端无效。不要用它打开文档页，也不要指望它能通过 Lingshu 的用户鉴权。
- 网关路由：`/oauth/**` 会被 StripPrefix=1，所以 IM_USERINFO_URL 必须是带网关前缀的完整地址，不能直连 oauth 服务。

## 四、数据模型增量

```sql
-- 回收站：软删除
alter table documents add column if not exists deleted_at timestamptz;
create index if not exists documents_deleted_at_idx on documents (deleted_at);

-- 管理操作审计
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
```

配套改动：

- 用户端所有文档查询补 `d.deleted_at is null`（列表、详情、成员、版本、存储、@提及）。
- 协同侧 `onAuthenticate` 拒绝已软删除文档；删除时复用 Redis ACL 事件，立即断开该文档在线连接，避免“删了还在编辑”。
- 回收站保留 30 天，之后由定时任务物理删除（级联清理 `doc_members` / `doc_snapshots` / `doc_snapshot_versions` / `doc_op_log`）。
- 管理端删除/恢复不校验文档成员关系，只校验 service token。

## 五、管理 API 契约

统一约定：

- Base：`/internal/admin`
- 鉴权：`X-Service-Token`，缺失或错误 → `401`
- 分页：`page` 从 1 开始，`pageSize` 默认 20、上限 100
- 时间：ISO 8601 字符串（UTC），前端本地化展示
- 错误包络：`{ "error": "人类可读的错误信息" }`，配合 HTTP 状态码
- 响应包络：直接返回业务对象，不再套 `code/msg/data`

### 5.1 文档总览

`GET /internal/admin/docs`

| 参数 | 类型 | 说明 |
|---|---|---|
| keyword | string | 标题模糊匹配 |
| kind | `doc` / `sheet` | 可选 |
| ownerId | string | IM userId 或本地 uuid，二者都支持 |
| includeDeleted | boolean | 默认 false |
| deletedOnly | boolean | 只列回收站文档，供回收站页面使用 |
| page / pageSize | number | 分页 |

响应：

```json
{
  "items": [{
    "id": "uuid",
    "kind": "doc",
    "title": "季度复盘",
    "owner": { "id": "uuid", "imUserId": "7", "displayName": "张三", "email": "zhangsan@corp.local" },
    "memberCount": 12,
    "deletedAt": null,
    "createdAt": "2026-10-31T02:00:00.000Z",
    "updatedAt": "2026-11-01T01:10:00.000Z"
  }],
  "total": 128, "page": 1, "pageSize": 20
}
```

### 5.2 文档详情

`GET /internal/admin/docs/:id`

响应追加 `members`（成员列表）、`lastSavedAt`（最近快照时间）、`versionCount`、`onlineCount`（可选，第二期）。

### 5.3 删除与恢复

- `DELETE /internal/admin/docs/:id` → 软删除，写审计，返回 `{ "deletedAt": "..." }`
- `POST /internal/admin/docs/:id/restore` → 恢复，写审计

### 5.4 成员管理

- `GET /internal/admin/docs/:id/members` → `{ members: [{ userId, imUserId, displayName, email, role, joinedAt }] }`
- `DELETE /internal/admin/docs/:id/members/:userId` → 移除成员并立即断开其连接；所有者不可被移除（`409`）

### 5.5 用户检索（辅助）

`GET /internal/admin/users?keyword=&page=&pageSize=`

返回镜像用户：`{ id, imUserId, email, displayName, docCount }`，用于“按人查文档”。

### 5.6 概览统计

`GET /internal/admin/stats`

```json
{
  "documents": { "total": 128, "doc": 90, "sheet": 38, "deleted": 4 },
  "activeDocuments24h": 21,
  "distinctMembers": 57,
  "memberships": 240,
  "versions": 1850,
  "opLogRows": 120000
}
```

### 5.7 运行状态（第二期）

`GET /internal/admin/shard-health`

依赖协同分片新增内部 HTTP 健康端点：

```
GET /health → { "shardId": "shard-a", "documents": 12, "connections": 87, "uptimeSeconds": 3600 }
```

聚合结果：

```json
{ "shards": [{ "url": "ws://collab-a:1234", "shardId": "shard-a", "reachable": true, "documents": 12, "connections": 87 }] }
```

### 5.8 审计日志

`GET /internal/admin/audit-logs?action=&operatorId=&targetId=&from=&to=&page=&pageSize=`

| action | 触发点 |
|---|---|
| `doc.delete` | 回收站删除 |
| `doc.restore` | 回收站恢复 |
| `doc.member.remove` | 管理端移除成员 |
| `doc.owner.transfer` | （预留）所有者转让 |

## 六、前端开发方式

### 6.1 外网开发（推荐路径）

- 脚手架：`vue-pure-admin`（Vue 3 + Vite + Element Plus）。选择理由：组件库与多数国内管理端（含若依、luohuo 系前端）一致，回流时只替换请求层与路由。
- 契约：`docs/openapi-admin.yaml`（OpenAPI 3.0.3，9 个操作、9 个 schema），AI 生成页面时以它为准。
- Mock：`pnpm mock:admin`（`tools/admin-mock/server.mjs`），默认 `http://localhost:9100`，服务令牌 `mock-token`，含 8 份种子文档与成员/审计数据，`POST /__reset` 可重置。
- 目录约定：所有请求集中在 `src/api/docsAdmin.ts`，页面不直接 `fetch`，便于回流。

### 6.2 回流到现有管理端

1. 复制页面目录到现有管理端前端的 `src/views/docs-admin/*`。
2. 替换请求层为该管理端自己的 `request`（baseURL 指向其后端 `/admin/docs/*`）。
3. 菜单与按钮权限：按该管理端自己的菜单表与权限规范注册，权限字符建议：

| 权限字符 | 用途 |
|---|---|
| `docs:admin:list` | 文档总览、详情、成员列表 |
| `docs:admin:remove` | 删除 / 恢复 / 移除成员 |
| `docs:admin:audit` | 审计日志 |
| `docs:admin:monitor` | 运行状态 |

4. 组件库差异（Ant Design ↔ Element Plus）在回流阶段处理，不要在外网阶段就混用。

### 6.3 交付物清单

| 交付物 | 用途 |
|---|---|
| `openapi.yaml` | 内网 AI 生成页面的唯一契约来源 |
| Mock 服务 | 外网可运行、可点击的演示环境 |
| 2 个样板页完整代码（列表页 + 详情页） | 供内网 AI 参照组件用法与交互风格 |
| 集成约定说明 | base path、鉴权头、分页、错误包络、权限字符 |

## 七、现有管理端接入

1. 管理前端新增“文档协同”菜单（父级按其现有分组规范）。
2. 管理后端新增 `DocsAdminController`，统一前缀 `/admin/docs`，转发到 Lingshu `/internal/admin/*`。
3. 转发时注入：
   - `X-Service-Token`（与 Lingshu 的 `INTERNAL_ADMIN_TOKEN` 一致）
   - `X-Operator-Id` / `X-Operator-Name`（取管理端自己的登录账号，不要用 IM 用户信息；Name 含中文时需 URL 编码）
4. 响应直接透传，不二次包装，避免前端出现两套包络。
5. 代理层负责：超时（建议 5s）、错误码映射、并发限流（可选）。
6. 鉴权归属：管理端用自己的登录态与角色判断“谁能看文档协同菜单”；Lingshu 不参与。管理端调用 IM 的既有凭证（服务账号、固定 token 或网关白名单）保持不变，Lingshu 不需要知道。

## 八、部署与配置

### 8.1 新增环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_MODE` | `local` | `im` 时启用 IM 统一登录 |
| `IM_USERINFO_URL` | 空 | HuLa：`http://gateway:端口/oauth/anyone/getUserInfo`；若依：`http://im:端口/getInfo` |
| `IM_TOKEN_HEADER` | `Token` | HuLa 用 `Token`；若依用 `Authorization` |
| `IM_TOKEN_PREFIX` | 空 | HuLa 留空；若依填 `Bearer`（尾部空格自动补齐） |
| `IM_USERINFO_TIMEOUT_MS` | `5000` | 身份服务超时 |
| `IM_USER_CACHE_TTL_MS` | `60000` | token → 用户信息缓存 |
| `INTERNAL_ADMIN_TOKEN` | 空 | 管理 API 服务令牌，留空则管理路由整体关闭 |
| `INTERNAL_ADMIN_IPS` | 空 | 管理 API 来源 IP 白名单，留空则不限制 |

### 8.2 网关路径

| 路径 | 去向 | 暴露范围 |
|---|---|---|
| `/docs/` | Lingshu Web | 内网用户 |
| `/docs-api/` | Lingshu API | 内网用户 |
| `/docs-collab/` | Collab（WebSocket） | 内网用户 |
| `/internal/admin/*` | Lingshu API | 仅 IM 管理后端（不配置公网 location） |

## 九、分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1（已完成） | 软删除 / 审计表、管理 API（5.1–5.6、5.8）、鉴权中间件 | 20 项断言全部通过，用户端与协同均正确过滤已删文档，typecheck/build 通过 |
| P2（已完成） | 分片心跳上报、`GET /internal/admin/shards` 可达性探测与聚合、运行状态页 | 停掉分片后页面与接口均标记不可达；恢复后自动回到在线 |
| P3（已完成） | OpenAPI 文档 + Mock + 外网管理端页面 | 契约与 Mock 已交付；admin-web 页面已对接真实 API 并验证（文档/回收站/成员/用户/审计/运行状态） |
| P4 | 回流现有管理端、菜单权限、内网联调 | 管理员可在现有管理端完成全流程操作 |

## 十、风险与待确认

| 风险 | 影响 | 处理 |
|---|---|---|
| token `active-timeout` 100 分钟 | 长时间只编辑、不调 IM 接口的会话可能失效 | 60s 缓存会持续触达 IM；联调实测，必要时缩短缓存或加心跳 |
| `is-concurrent=false` 互踢 | 用户切换设备后旧 token 失效，编辑页 401 | 前端明确提示“账号已在其他设备登录”，引导重新从 IM 进入 |
| 软删除与在线协同冲突 | 成员仍在编辑已删文档 | 删除时发 ACL 事件断开连接，鉴权拒绝已删文档 |
| 管理 API 被公网访问 | 数据泄露 | service token + IP 白名单 + 网关不暴露路径 |
| 回流时组件库/请求层风格不一致 | 返工 | 外网阶段限定 Element Plus，请求集中在单一 api 文件 |
| 审计日志缺操作人 | 无法追溯 | 强制要求 `X-Operator-Id`，缺失时记录为 `unknown` 并返回 400 |
| 统计口径（活跃/存储）未定 | 页面数字无意义 | P1 先只做文档数与成员数，存储与活跃在 P2 定义 |

### 待确认

1. 现有管理端的菜单表/权限模型结构，以及“文档协同”菜单挂在哪个分组、由哪些角色可见。
2. 现有管理端后端调用 IM API 的凭证形式（固定 token / 服务账号 / 网关白名单），只影响它自己的实现，不影响 Lingshu。
3. 回收站保留期是否确认为 30 天。
4. 是否需要“所有者转让”能力（当前只有移除成员）。
5. 统计页是否需要存储用量（依赖 MinIO 附件功能，当前一期未启用）。
6. @提及 是否要从 Lingshu webhook 改成直接调 IM 消息接口（需要 IM 提供内部发消息 API）。

## 附录：若依兼容说明（可选，当前部署未使用）

Lingshu 的 IM 解析器同时兼容若依，切换只需改环境变量；实际部署以 HuLa-Server 为准，本节仅作备查。

| 项 | HuLa-Server（luohuo） | 若依 RuoYi |
|---|---|---|
| 认证框架 | Sa-Token（网关统一校验） | Spring Security + JWT |
| token 形态 | 不透明字符串 | JWT |
| token 请求头 | `Token`，无前缀 | `Authorization: Bearer <jwt>` |
| 当前用户接口 | `GET /oauth/anyone/getUserInfo` | `GET /getInfo` |
| 响应结构 | `{ code: 200, data: { id, uid, nickName, email } }` | `{ code: 200, user: { userId, userName, nickName, email } }` |
| 用户 ID | `data.id`（账号 ID）/ `data.uid`（员工 ID） | `user.userId` |
| token 有效期 | 30 天 + 100 分钟活跃超时 | 默认 30 分钟 |
| 并发登录 | 新登录挤掉旧 token | 由配置决定 |

Lingshu 的解析器同时兼容这两种响应结构，切换时只需改 3 个环境变量：
`IM_USERINFO_URL`、`IM_TOKEN_HEADER`、`IM_TOKEN_PREFIX`。
