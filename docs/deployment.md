# 灵枢私有化部署（docker compose 离线包）

面向单机/单集群私有化交付：PostgreSQL、Redis、API、协同分片、前端全部docker化，首次在联网构建机产出镜像 tar，之后可在完全离线的内网机器安装。

## 一、组成与端口

| 服务 | 镜像 | 说明 |
|---|---|---|
| web | `lingshu-web:latest` | nginx 托管前端，并把同源 `/api` 反代到 api |
| api | `lingshu-api:latest` | HTTP API，启动时幂等执行建表脚本 |
| collab | `lingshu-collab:latest` | Hocuspocus 协同分片，浏览器直连 |
| postgres | `postgres:16-alpine` | 主库（用户/文档/快照/通知） |
| redis | `redis:7-alpine` | 低频 ACL 事件与缓存，**不进入协同热路径** |

对外只需两个端口：`WEB_PORT`（默认 8080）与协同分片 `COLLAB_PUBLISH_PORT`（默认 1234）。后者由浏览器直连，必须对客户端网络可达（不能只做容器内网）。

## 二、联网构建（构建机）

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File deploy/export-images.ps1
# Linux
bash deploy/export-images.sh
```

产物在 `deploy/dist/`：`lingshu-images.tar`、`docker-compose.yml`、`.env.example`、`DEPLOY.md`。

构建默认走国内镜像源 `registry.npmmirror.com`，内网有私有 npm 源时可覆盖：

```bash
docker compose -f deploy/docker-compose.yml build --build-arg NPM_REGISTRY=https://registry.npmjs.org
```

api/collab 镜像只保留生产依赖：在干净的构建阶段按 workspace 过滤安装（`--prod --filter`），不会把 web 的 univer 或开发依赖带进运行镜像。

## 三、离线安装（目标机）

```bash
# 1. 导入镜像（目标机需已安装 Docker 与 compose 插件）
docker load -i lingshu-images.tar

# 2. 配置
cp .env.example .env
# 至少修改：PUBLIC_HOST（客户端访问的域名/IP）、JWT_SECRET、POSTGRES_PASSWORD

# 3. 启动（只使用已导入镜像，不联网、不构建）
docker compose up -d --no-build --pull never

# 4. 检查
curl http://<PUBLIC_HOST>:8080/api/health
```

`/api/health` 返回 `{"ok":true,"db":true,"redis":true,...}` 即表示主库与 Redis 均正常；Redis 掉线时 `degraded=true` 但 `ok` 仍为 true（协同不受影响）。

首次启动会自动执行 `db-init`（`create table if not exists`），无需手工导入 SQL。

## 四、配置项（deploy/.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PUBLIC_HOST` | 是 | 客户端访问的域名/IP。用于拼接协同分片地址 `ws://<host>:<COLLAB_PUBLISH_PORT>` 与 webhook 文档链接 |
| `WEB_PORT` | 否 | 前端对外端口，默认 8080 |
| `COLLAB_PUBLISH_PORT` | 否 | 协同分片对外端口，默认 1234；被占用时可改，api 的分片地址会自动跟随 |
| `JWT_SECRET` | 是 | 会话签名密钥，务必替换为随机长字符串；**更换后所有用户需重新登录** |
| `POSTGRES_PASSWORD` | 否 | 主库密码，默认 lingshu；生产必须修改 |
| `LINGXI_WEBHOOK_URL` | 否 | @提及 推送通道，留空则只发站内通知 |

## 五、备份与升级

- 数据备份：`docker compose exec postgres pg_dump -U lingshu lingshu > backup.sql`，恢复用 `psql` 导入。
- 快照与版本历史都在主库中（`doc_snapshots` / `doc_snapshot_versions` / `doc_op_log`），备份主库即可覆盖协同内容。
- 升级：在构建机重新导出镜像 → 目标机 `docker load` → `docker compose up -d --no-build --pull never`。建表脚本幂等，新增字段/表会自动补齐。

## 六、横向扩容协同分片

单分片可承载 200 人/文档的硬上限。需要更多总并发时，按 `deploy/docker-compose.yml` 增加 `collab-b` 服务（如发布端口 1235、`SHARD_ID=shard-b`），并把 api 的 `COLLAB_SHARDS` 改为 `ws://<host>:1234|ws://<host>:1235`，重启 api 即可；API 按 `document_id` 一致性哈希分配，同一文档始终落在同一分片。`COLLAB_PUBLISH_PORT` 只作用于内置的单个 collab 服务，新增分片时需为其单独写端口映射。

## 七、故障边界（已验证，见设计文档 §9.9）

| 故障 | 表现 | 恢复 |
|---|---|---|
| Redis 挂 | 成员变更事件暂停、health 标记降级；编辑不受影响 | 恢复后自动重订阅；恢复窗口内发布的 ACL 事件会丢，连接在下一次重连鉴权时失效 |
| 主库挂 | API 返回 503 JSON；新连接无法鉴权；**已建立的协同连接继续工作** | 恢复后接口自动可用，快照继续落盘 |
| 分片挂 | 该分片上的客户端自动重连；新连接进不来 | 分片恢复后自动补同步；未落盘增量由在线客户端补回（最多 30s 窗口） |
| 客户端与分片同时掉 | 最多丢失最后 30s 未落盘内容 | — |

## 八、排障

```bash
docker compose ps
docker compose logs -f api collab
# 单独验证主库连通性
docker compose exec api node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(console.log)"
```

常见问题：

- 前端能打开但登录报错：检查 nginx 的 `/api` 反代与 `api` 健康状态。
- 编辑器一直“连接中”：浏览器到 `ws://<PUBLIC_HOST>:1234` 被防火墙/安全组拦截，或 `PUBLIC_HOST` 配错。
- 跨域：前端走同源反代，正常情况下不涉及 CORS；若把前端单独部署到其他域名，需要自行处理。
