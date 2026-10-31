// M3 故障演练：杀 Redis / 杀主库 / 杀协同分片
// 用法：node apps/web/scripts/m3-faults.mjs [--gate redis|db|shard|all] [--api-port 8789]
//        [--shard-port 1241] [--pg-port 5433] [--redis-port 6380] [--keep]
//
// 隔离策略：演练使用独立的 PG(5433) / Redis(6380) 容器与独立 API(8789) / 分片(1241) 进程，
// 不触碰开发环境里的 5432 / 6379 / 8787 / 1234，避免演练污染日常调试数据。
//
// 三个演练的口径：
//   ① 杀 Redis：只影响 ACL 事件通道，API 与协同热路径继续可用，标记为“降级”；
//   ② 杀主库：API 返回 503、新连接无法鉴权，已建立的协同连接继续工作，恢复后快照补落盘；
//   ③ 杀分片：在线客户端自动重连并把未落盘增量补回服务端；若分片宕机期间客户端也关闭，
//      未落盘的内容会丢，丢失窗口上界为快照间隔（30s）。

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const API_PORT = Number(arg('api-port', 8789));
const API = `http://localhost:${API_PORT}`;
const SHARD_PORT = Number(arg('shard-port', 1241));
const PG_PORT = Number(arg('pg-port', 5433));
const REDIS_PORT = Number(arg('redis-port', 6380));
const GATE = arg('gate', 'all');
const KEEP = process.argv.includes('--keep');

const JWT_SECRET = 'dev-only-change-me';
const DATABASE_URL = `postgres://lingshu:lingshu@localhost:${PG_PORT}/lingshu`;
const REDIS_URL = `redis://localhost:${REDIS_PORT}`;
const PG_CONTAINER = 'lingshu-m3-pg';
const REDIS_CONTAINER = 'lingshu-m3-redis';
const FIELD = 'm3-drill';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/** 不抛错的版本：断言 503 这类“预期失败”的响应时需要看状态码。 */
async function rawApi(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function healthJson() {
  const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3_000) });
  return response.json();
}

async function waitHealth(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await healthJson();
      if (predicate(health)) return health;
    } catch {
      // 服务尚未就绪
    }
    await sleep(500);
  }
  throw new Error(`等待健康状态超时：${label}`);
}

function login(email, displayName) {
  return api('/api/auth/dev-login', { method: 'POST', body: { email, displayName } });
}

async function createDoc(token, title) {
  const { doc } = await api('/api/docs', { token, method: 'POST', body: { kind: 'doc', title } });
  return doc;
}

async function invite(token, docId, email, role) {
  return api(`/api/docs/${docId}/members`, { token, method: 'POST', body: { email, role } });
}

async function removeMember(token, docId, userId) {
  return rawApi(`/api/docs/${docId}/members/${userId}`, { token, method: 'DELETE' });
}

async function storageOf(token, docId) {
  const { storage } = await api(`/api/docs/${docId}/storage`, { token });
  return storage;
}

/** 一条真实的 Hocuspocus 连接；与浏览器端共用同一套 provider，行为等价。 */
function connectClient(detail, token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: detail.collab.url,
    name: detail.collab.documentNames[0],
    token,
    document: doc,
  });
  const state = {
    doc,
    provider,
    status: 'connecting',
    synced: false,
    syncedTimes: 0,
    disconnectedTimes: 0,
    authenticationFailed: false,
    /** 服务端主动关闭“文档连接”（如成员被移除）：socket 仍在，但该文档已停止同步 */
    documentClosed: false,
  };
  provider.on('status', ({ status }) => {
    state.status = status;
    if (status === 'disconnected') state.disconnectedTimes += 1;
  });
  provider.on('synced', () => {
    state.synced = true;
    state.syncedTimes += 1;
  });
  provider.on('authenticationFailed', () => {
    state.authenticationFailed = true;
  });
  provider.on('close', ({ event }) => {
    if (event?.code === 1000) state.documentClosed = true;
  });
  return state;
}

/** 轮询任意条件；用于“事件在窗口内发生过”这类无法只看瞬时状态的断言。 */
async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return { value, elapsed: Date.now() - startedAt };
    await sleep(200);
  }
  return null;
}

async function waitStatus(client, wanted, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (client.status === wanted) return Date.now() - startedAt;
    await sleep(200);
  }
  return null;
}

async function waitSynced(client, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (client.synced) return true;
    await sleep(200);
  }
  return false;
}

function textOf(client) {
  return client.doc.getText(FIELD).toString();
}

async function waitText(client, expected, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (client.doc.getText(FIELD).toString().includes(expected)) return true;
    await sleep(200);
  }
  return false;
}

function disconnect(client) {
  if (!client) return;
  client.provider.destroy();
  client.doc.destroy();
}

/* ---------------------------------------------------------------- 容器与进程 */

async function docker(args, allowFail = false) {
  try {
    return await exec('docker', args, { windowsHide: true });
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

async function waitContainerReady(container, timeoutMs = 40_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = await docker(
      container === PG_CONTAINER
        ? ['exec', container, 'pg_isready', '-U', 'lingshu', '-d', 'lingshu']
        : ['exec', container, 'redis-cli', 'ping'],
      true,
    );
    const text = `${output?.stdout ?? ''}${output?.stderr ?? ''}`;
    if (text.includes('accepting connections') || text.includes('PONG')) return;
    await sleep(500);
  }
  throw new Error(`容器未就绪：${container}`);
}

async function startInfra() {
  await docker(['rm', '-f', PG_CONTAINER, REDIS_CONTAINER], true);
  await docker([
    'run', '-d', '--name', PG_CONTAINER,
    '-e', 'POSTGRES_USER=lingshu', '-e', 'POSTGRES_PASSWORD=lingshu', '-e', 'POSTGRES_DB=lingshu',
    '-p', `${PG_PORT}:5432`, 'postgres:16-alpine',
  ]);
  await docker(['run', '-d', '--name', REDIS_CONTAINER, '-p', `${REDIS_PORT}:6379`, 'redis:7-alpine']);
  await Promise.all([waitContainerReady(PG_CONTAINER), waitContainerReady(REDIS_CONTAINER)]);
  console.log(`[m3] 演练依赖已就绪：PG=${PG_PORT} Redis=${REDIS_PORT}`);
}

async function stopContainer(name) {
  await docker(['stop', name]);
}

async function startContainer(name) {
  await docker(['start', name]);
  await waitContainerReady(name);
}

function runShell(command, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ output });
      else reject(new Error(`${command} 退出码 ${code}\n${output.slice(-1500)}`));
    });
  });
}

function startService(label, command, cwd, extraEnv) {
  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...extraEnv },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  const collect = (data) => {
    logs.push(data.toString());
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.warn(`[m3] ${label} 退出码 ${code}`);
  });
  return { label, child, logs: () => logs.join('') };
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  await exec('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => undefined);
  await sleep(500);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

async function waitPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await portOpen(port)) return;
    await sleep(300);
  }
  throw new Error(`端口 ${port} 未就绪`);
}

let apiService = null;
let shardService = null;

async function startApi() {
  apiService = startService('api', 'pnpm exec tsx src/index.ts', `${ROOT}/apps/api`, {
    API_PORT: String(API_PORT),
    DATABASE_URL,
    REDIS_URL,
    JWT_SECRET,
    COLLAB_SHARDS: `ws://localhost:${SHARD_PORT}`,
    DEV_LOGIN_ENABLED: 'true',
    LINGXI_WEBHOOK_URL: '',
  });
  await waitHealth((health) => health.ok === true && health.redis === true, 30_000, 'API 启动');
}

async function startShard() {
  shardService = startService(
    'collab',
    `pnpm exec tsx src/index.ts --shard m3-drill --port ${SHARD_PORT}`,
    `${ROOT}/apps/collab`,
    { DATABASE_URL, REDIS_URL, JWT_SECRET },
  );
  await waitPort(SHARD_PORT, 30_000);
}

async function restartShard() {
  await killTree(shardService?.child);
  await startShard();
}

/* ---------------------------------------------------------------- 演练一：杀 Redis */

async function gateRedis() {
  console.log('\n=== 演练一：杀 Redis（ACL 事件通道） ===');
  const owner = await login('m3-redis-owner@lingshu.local', '演练所有者');
  const editor = await login('m3-redis-editor@lingshu.local', '演练编辑者');
  const extra = await login('m3-redis-extra@lingshu.local', '演练新成员');

  const detail = await createDoc(owner.token, 'M3 Redis 演练');
  await invite(owner.token, detail.id, editor.user.email, 'editor');

  const a = connectClient(detail, owner.token);
  const b = connectClient(detail, editor.token);
  await Promise.all([waitSynced(a), waitSynced(b)]);
  check('故障前：两端协同连接已建立', a.synced && b.synced);

  a.doc.getText(FIELD).insert(0, 'base');
  check('故障前：编辑可同步', await waitText(b, 'base'));

  await stopContainer(REDIS_CONTAINER);
  await sleep(1_500);

  const health = await healthJson();
  check(
    'Redis 停机：health 返回 redis=false、db=true、degraded=true',
    health.db === true && health.redis === false && health.degraded === true,
    JSON.stringify({ ok: health.ok, db: health.db, redis: health.redis, degraded: health.degraded }),
  );

  const list = await rawApi('/api/docs', { token: owner.token });
  check('Redis 停机：文档列表接口不受影响', list.status === 200, `status=${list.status}`);

  const invited = await rawApi(`/api/docs/${detail.id}/members`, {
    token: owner.token,
    method: 'POST',
    body: { email: extra.user.email, role: 'editor' },
  });
  check(
    'Redis 停机：邀请成员仍成功（事件发布失败不影响落库）',
    invited.status === 200 || invited.status === 201,
    `status=${invited.status}`,
  );

  a.doc.getText(FIELD).insert('base'.length, '-offline');
  check('Redis 停机：协同编辑热路径不依赖 Redis', await waitText(b, '-offline'));

  await startContainer(REDIS_CONTAINER);
  const recovered = await waitHealth((value) => value.redis === true, 30_000, 'Redis 恢复');
  check('Redis 恢复：health 回到 redis=true', recovered.redis === true);

  // 等 API 与分片两侧的订阅都重新就绪；订阅重连期间发布的 ACL 事件会丢失（已作为边界记录）
  await sleep(4_000);
  const removed = await removeMember(owner.token, detail.id, editor.user.id);
  const revoked = () => b.disconnectedTimes > 0 || b.authenticationFailed || b.documentClosed;
  const observed =
    (await waitFor(() => revoked() && shardService.logs().includes('成员权限变更'), 12_000)) ??
    (await waitFor(revoked, 2_000));
  check(
    'Redis 恢复：移除成员后在线连接被立即断开',
    removed.status === 200 && observed !== null,
    `status=${removed.status} 观测=${observed ? `${observed.elapsed}ms` : '超时'}`,
  );
  if (observed === null) console.log('[debug] 分片日志：\n' + shardService.logs().slice(-1_500));

  disconnect(a);
  disconnect(b);
}

/* ---------------------------------------------------------------- 演练二：杀主库 */

async function gateDatabase() {
  console.log('\n=== 演练二：杀主库（PostgreSQL） ===');
  const owner = await login('m3-db-owner@lingshu.local', '演练所有者');
  const editor = await login('m3-db-editor@lingshu.local', '演练编辑者');
  const late = await login('m3-db-late@lingshu.local', '演练后到成员');

  const detail = await createDoc(owner.token, 'M3 主库演练');
  await invite(owner.token, detail.id, editor.user.email, 'editor');

  const a = connectClient(detail, owner.token);
  const b = connectClient(detail, editor.token);
  await Promise.all([waitSynced(a), waitSynced(b)]);
  const before = await storageOf(owner.token, detail.id);

  a.doc.getText(FIELD).insert(0, 'pre-outage');
  check('故障前：编辑可同步', await waitText(b, 'pre-outage'));

  await stopContainer(PG_CONTAINER);
  await sleep(1_500);

  const health = await healthJson();
  check(
    '主库停机：health 返回 db=false、ok=false',
    health.db === false && health.ok === false,
    JSON.stringify({ ok: health.ok, db: health.db }),
  );

  const list = await rawApi('/api/docs', { token: owner.token });
  check(
    '主库停机：API 返回 503 且为 JSON',
    list.status === 503 && typeof list.json?.error === 'string',
    `status=${list.status} body=${JSON.stringify(list.json)}`,
  );

  a.doc.getText(FIELD).insert('pre-outage'.length, '-during-outage');
  check('主库停机：已建立的协同连接继续工作', await waitText(b, '-during-outage'));

  const c = connectClient(detail, late.token);
  const cSynced = await waitSynced(c, 5_000);
  check(
    '主库停机：新连接无法鉴权，不能进文档',
    cSynced === false,
    `synced=${cSynced} status=${c.status} authFailed=${c.authenticationFailed}`,
  );
  disconnect(c);

  await startContainer(PG_CONTAINER);
  const recovered = await waitHealth((value) => value.db === true, 40_000, '主库恢复');
  check('主库恢复：health 回到 db=true', recovered.db === true);

  const listAfter = await rawApi('/api/docs', { token: owner.token });
  check('主库恢复：API 恢复 200', listAfter.status === 200, `status=${listAfter.status}`);

  // 断开所有连接触发文档卸载，把停机期间积累的内存状态整份落盘
  disconnect(a);
  disconnect(b);
  await sleep(3_000);

  const after = await storageOf(owner.token, detail.id);
  check(
    '主库恢复：停机期间的内容随卸载落盘',
    after.version > before.version && after.savedAt !== null,
    `version ${before.version} -> ${after.version}`,
  );

  const reader = connectClient(detail, owner.token);
  const synced = await waitSynced(reader, 15_000);
  check('主库恢复：重新打开文档能读到停机期间的内容', synced && textOf(reader).includes('-during-outage'), `"${textOf(reader)}"`);
  disconnect(reader);
}

/* ---------------------------------------------------------------- 演练三：杀分片 */

async function gateShard() {
  console.log('\n=== 演练三：杀协同分片 ===');
  const owner = await login('m3-shard-owner@lingshu.local', '演练所有者');
  const detail = await createDoc(owner.token, 'M3 分片演练');

  const a = connectClient(detail, owner.token);
  check('故障前：连接分片成功', await waitSynced(a));

  a.doc.getText(FIELD).insert(0, 'persisted-marker');
  // 快照 debounce 上限 30s，写入后必须等它真正落盘再制造故障
  let persisted = false;
  const waitStartedAt = Date.now();
  while (Date.now() - waitStartedAt < 45_000) {
    const storage = await storageOf(owner.token, detail.id).catch(() => null);
    if (storage && storage.version > 0 && storage.savedAt) {
      persisted = true;
      break;
    }
    await sleep(1_000);
  }
  check('故障前：编辑内容落盘', persisted);

  a.doc.getText(FIELD).insert('persisted-marker'.length, '-volatile-marker');
  await sleep(300);

  await killTree(shardService?.child);
  const disconnectedIn = await waitStatus(a, 'disconnected', 12_000);
  check(
    '分片被杀：客户端进入 disconnected 并开始重连',
    disconnectedIn !== null,
    `耗时=${disconnectedIn ?? '超时'}ms`,
  );

  const detailWhileDown = await rawApi(`/api/docs/${detail.id}`, { token: owner.token });
  check(
    '分片被杀：API 仍能提供文档与分片地址',
    detailWhileDown.status === 200 && typeof detailWhileDown.json?.doc?.collab?.url === 'string',
    `status=${detailWhileDown.status}`,
  );

  const blocked = connectClient(detail, owner.token);
  const blockedSynced = await waitSynced(blocked, 3_000);
  check('分片被杀：新连接进不来', blockedSynced === false);
  disconnect(blocked);

  await startShard();
  const reconnectedIn = await waitStatus(a, 'connected', 30_000);
  const resynced = await waitSynced(a, 30_000);
  check(
    '分片恢复：客户端自动重连并重新同步',
    reconnectedIn !== null && resynced,
    `重连耗时=${reconnectedIn ?? '超时'}ms`,
  );

  // 第二个客户端确认“未落盘增量已由在线客户端补回服务端”
  const verifier = connectClient(detail, owner.token);
  const verifierSynced = await waitSynced(verifier, 15_000);
  check(
    '分片恢复：在线客户端把未落盘增量补回服务端',
    verifierSynced && textOf(verifier).includes('-volatile-marker'),
    `"${textOf(verifier)}"`,
  );

  // 分片宕机期间客户端也关闭（关标签页 / 进程崩溃）→ 未落盘内容无人补发
  a.doc.getText(FIELD).insert(0, 'tabclose-marker-');
  await sleep(300);
  await killTree(shardService?.child);
  disconnect(a);
  disconnect(verifier);

  await startShard();
  const fresh = connectClient(detail, owner.token);
  const freshSynced = await waitSynced(fresh, 15_000);
  const freshText = textOf(fresh);
  check(
    '分片恢复：客户端同时关闭时，未落盘内容按快照间隔丢失（≤30s）',
    freshSynced && freshText.includes('persisted-marker') && !freshText.includes('tabclose-marker'),
    `"${freshText}"`,
  );
  disconnect(fresh);
}

/* ---------------------------------------------------------------- 入口 */

async function main() {
  console.log(`[m3] 故障演练 gate=${GATE} API=${API} 分片=${SHARD_PORT}`);

  await startInfra();
  await runShell('pnpm --filter @lingshu/api db:init', {
    env: { ...process.env, DATABASE_URL },
  });

  await startApi();
  await startShard();

  try {
    if (GATE === 'all' || GATE === 'redis') await gateRedis();
    if (GATE === 'all' || GATE === 'db') await gateDatabase();
    if (GATE === 'all' || GATE === 'shard') await gateShard();
  } finally {
    await killTree(apiService?.child);
    await killTree(shardService?.child);
    if (!KEEP) {
      await docker(['rm', '-f', PG_CONTAINER, REDIS_CONTAINER], true);
    } else {
      console.log(`[m3] 已保留容器 ${PG_CONTAINER} / ${REDIS_CONTAINER}（--keep）`);
    }
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n总计 ${passed}/${results.length} 项通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n[m3] 演练异常终止', error);
  if (apiService) console.error('[m3] API 日志尾部\n' + apiService.logs().slice(-1_200));
  if (shardService) console.error('[m3] 分片日志尾部\n' + shardService.logs().slice(-1_200));
  process.exitCode = 1;
});
