// M0 红线压测：单文档 200 并发（50 active editor + 150 spectator）
// 用法：node apps/web/scripts/m0-loadtest.mjs [--editors 50] [--spectators 150]
//        [--awareness-hz 20] [--warmup 5] [--duration 30] [--api http://localhost:8787]
//
// 说明：本脚本只能测服务端 CPU、广播流量、内容/awareness 延迟。
// 设计文档里的“客户端编辑区 ≥30fps”是 DOM/Canvas 渲染指标，必须在真实浏览器里测。

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const execFileAsync = promisify(execFile);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const API = arg('api', 'http://localhost:8787');
const EDITORS = Number(arg('editors', 50));
const SPECTATORS = Number(arg('spectators', 150));
const AWARENESS_HZ = Number(arg('awareness-hz', 20));
const WARMUP_MS = Number(arg('warmup', 5)) * 1000;
const DURATION_MS = Number(arg('duration', 30)) * 1000;
const CONNECT_BATCH = 25;
const MAX_BROADCAST_CURSORS = Number(arg('max-cursors', 20));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function login(email, displayName) {
  return api('/api/auth/dev-login', { method: 'POST', body: { email, displayName } });
}

/** 每条连接一个 provider；统计收到的字节数用于估算服务端出站流量。 */
function openClient({ url, name, token, label, onUpdate }) {
  const doc = new Y.Doc();
  const text = doc.getText('content');

  let receivedBytes = 0;
  let receivedMessages = 0;
  let synced = false;

  const count = (size) => {
    receivedBytes += size;
    receivedMessages += 1;
  };

  const provider = new HocuspocusProvider({
    url,
    name,
    token,
    document: doc,
    onSynced: () => {
      synced = true;
    },
    // 统计服务端下行流量：event.data 是原始帧
    onMessage: ({ event }) => count(event?.data?.byteLength ?? event?.data?.length ?? 0),
  });

  text.observe(() => onUpdate?.(text.toString()));

  return {
    label,
    doc,
    text,
    provider,
    get synced() {
      return synced;
    },
    get receivedBytes() {
      return receivedBytes;
    },
    get receivedMessages() {
      return receivedMessages;
    },
    resetCounters() {
      receivedBytes = 0;
      receivedMessages = 0;
    },
    close() {
      try {
        provider.destroy();
      } catch {
        /* 忽略关闭异常 */
      }
      doc.destroy();
    },
  };
}

function waitSynced(client, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (client.synced) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`${client.label} 连接超时`));
      }
    }, 100);
  });
}

async function portPid(port) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop).OwningProcess`,
  ]);
  const pid = Number(String(stdout).trim());
  if (!Number.isFinite(pid)) throw new Error(`无法定位端口 ${port} 的进程`);
  return pid;
}

/** 用 PowerShell 采样目标进程的 CPU 时间（Windows 下 Node 无法直接读取其它进程）。 */
function startCpuSampler(pid, durationMs) {
  const ticks = Math.ceil(durationMs / 1000);
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    '$prev = $p.CPU',
    '$tprev = [DateTime]::Now',
    `for ($i = 0; $i -lt ${ticks}; $i++) {`,
    '  Start-Sleep -Seconds 1',
    '  $p.Refresh()',
    '  $cur = $p.CPU',
    '  $now = [DateTime]::Now',
    '  $dt = ($now - $tprev).TotalSeconds',
    '  "{0},{1}" -f ($cur - $prev), $dt',
    '  $prev = $cur',
    '  $tprev = $now',
    '}',
  ].join('; ');

  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script]);
  const rows = [];
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [cpu, dt] = trimmed.split(',');
      if (Number.isFinite(Number(cpu)) && Number(dt) > 0) rows.push({ cpu: Number(cpu), dt: Number(dt) });
    }
  });
  return { rows, done: new Promise((resolve) => child.on('close', resolve)) };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`=== M0 单文档 200 并发压测 ===`);
  console.log(`目标：${EDITORS} editor + ${SPECTATORS} spectator，awareness ${AWARENESS_HZ}/s，测量 ${DURATION_MS / 1000}s\n`);

  const editorUser = await login('m0-editor@lingshu.local', 'M0 编辑者');
  const spectatorUser = await login('m0-spectator@lingshu.local', 'M0 旁观者');

  // --doc 复用已存在的文档：浏览器帧率实测需要压测端和浏览器加入同一篇文档
  const existingDoc = arg('doc', '');
  let docId;
  if (existingDoc) {
    docId = existingDoc;
  } else {
    const created = await api('/api/docs', {
      token: editorUser.token,
      method: 'POST',
      body: { kind: 'doc', title: `M0 压测 ${new Date().toISOString()}` },
    });
    docId = created.doc.id;
  }

  await api(`/api/docs/${docId}/members`, {
    token: spectatorUser.token,
    method: 'POST',
    body: { role: 'spectator' },
  });

  const detail = await api(`/api/docs/${docId}`, { token: editorUser.token });
  const url = detail.doc.collab.url;
  const documentName = detail.doc.collab.documentNames[0];
  const port = Number(new URL(url).port);
  const pid = await portPid(port);
  console.log(`文档 ${docId}\n分片 ${url}（pid=${pid}）\nY.Doc ${documentName}\n`);

  // ---------- 建连 ----------
  const connectStarted = Date.now();
  const clients = [];
  const failed = [];

  const makeClient = (token, label, onUpdate) => openClient({ url, name: documentName, token, label, onUpdate });

  const editorClients = Array.from({ length: EDITORS }, (_, i) => makeClient(editorUser.token, `editor-${i}`));
  const spectatorClients = Array.from({ length: SPECTATORS }, (_, i) =>
    makeClient(spectatorUser.token, `spectator-${i}`),
  );
  clients.push(...editorClients, ...spectatorClients);

  for (let i = 0; i < clients.length; i += CONNECT_BATCH) {
    const batch = clients.slice(i, i + CONNECT_BATCH);
    const settled = await Promise.allSettled(batch.map((client) => waitSynced(client)));
    settled.forEach((result, index) => {
      if (result.status === 'rejected') failed.push(`${batch[index].label}: ${result.reason?.message ?? result.reason}`);
    });
    console.log(`  已连接 ${Math.min(i + CONNECT_BATCH, clients.length)}/${clients.length}`);
  }
  const connectMs = Date.now() - connectStarted;
  check('200 连接全部建立', failed.length === 0 && clients.every((c) => c.synced),
    failed.length ? `失败 ${failed.length}：${failed.slice(0, 3).join(' | ')}` : `${connectMs}ms`);

  // ---------- 预热 ----------
  // editor-0 不写光标，作为纯观察者：它的 awareness 只反映服务端真正广播出去的内容
  editorClients.forEach((client, index) => {
    if (index === 0) return;
    client.provider.setAwarenessField('user', { name: `编辑者${index}`, color: '#2b6cb0' });
  });
  editorClients[0].provider.setAwarenessField('user', { name: '观察者', color: '#2b6cb0' });
  spectatorClients.forEach((client, index) => {
    client.provider.setAwarenessField('user', { name: `旁观者${index}`, color: '#718096' });
  });
  await sleep(WARMUP_MS);
  clients.forEach((client) => client.resetCounters());

  // ---------- 测量 ----------
  const cpuSampler = startCpuSampler(pid, DURATION_MS);

  const cursorWrites = { count: 0 };
  const awarenessTimer = setInterval(() => {
    for (const client of editorClients.slice(1)) {
      client.provider.setAwarenessField('cursor', {
        anchor: Math.floor(Math.random() * 100),
        head: Math.floor(Math.random() * 100),
      });
      cursorWrites.count += 1;
    }
    // spectator 也尝试上报光标：服务端必须剥离，否则这条检查会失败
    for (const client of spectatorClients) {
      client.provider.setAwarenessField('cursor', {
        anchor: Math.floor(Math.random() * 100),
        head: Math.floor(Math.random() * 100),
      });
      cursorWrites.count += 1;
    }
  }, Math.round(1000 / AWARENESS_HZ));

  // 内容更新延迟：一个 editor 写入 nonce，其余 199 个客户端记录收到时间
  const nonce = `M0-${Math.random().toString(36).slice(2, 10)}`;
  const latencies = [];
  const emitAt = {};
  clients.forEach((client) => {
    const original = client.text.toString();
    const observer = () => {
      if (!emitAt.value) return;
      const current = client.text.toString();
      if (current.includes(nonce) && current !== original && !client.recorded) {
        client.recorded = true;
        if (client !== clients[0]) latencies.push(Date.now() - emitAt.value);
      }
    };
    client.observeUpdate = observer;
  });
  clients.forEach((client) => client.text.observe(client.observeUpdate));

  const contentDelay = 8000;
  setTimeout(() => {
    emitAt.value = Date.now();
    editorClients[0].text.insert(0, nonce);
  }, contentDelay);

  console.log(`\n测量中（${DURATION_MS / 1000}s）…`);
  await Promise.all([sleep(DURATION_MS), cpuSampler.done]);
  clearInterval(awarenessTimer);

  const cpuPercents = cpuSampler.rows.map((row) => (row.cpu / row.dt) * 100);
  const cpuAvg = cpuPercents.reduce((sum, value) => sum + value, 0) / Math.max(cpuPercents.length, 1);
  const cpuP95 = percentile(cpuPercents, 95);

  const totalBytes = clients.reduce((sum, client) => sum + client.receivedBytes, 0);
  const totalMessages = clients.reduce((sum, client) => sum + client.receivedMessages, 0);
  const bytesPerSecond = totalBytes / (DURATION_MS / 1000);

  // 观察者（editor-0）从不写光标，它看到的光标数量就是服务端真实广播出去的数量
  const observerStates = editorClients[0].provider.awareness.getStates();
  const spectatorStates = spectatorClients[0].provider.awareness.getStates();
  const cursorStates = [...observerStates.values()].filter((state) => state.cursor).length;

  // 诊断：spectator-0 视角缺失了谁的状态
  const missingToSpectator = clients
    .filter((client) => !spectatorStates.has(client.provider.awareness.clientID))
    .map((client) => client.label);

  const latencyP50 = percentile(latencies, 50);
  const latencyP95 = percentile(latencies, 95);

  console.log('');
  check('服务端 CPU 均值 < 70%（单核）', cpuAvg < 70, `${cpuAvg.toFixed(1)}%`);
  check('服务端 CPU p95 < 70%（单核）', cpuP95 < 70, `${cpuP95.toFixed(1)}%`);
  check('editor 侧 awareness 状态数 = 200', observerStates.size === 200, `${observerStates.size}`);
  check('spectator 侧 awareness 状态数 = 200', spectatorStates.size === 200,
    `${spectatorStates.size}${missingToSpectator.length ? `，缺 ${missingToSpectator.join(',')}` : ''}`);
  check(`带光标的状态被限制在 ${MAX_BROADCAST_CURSORS} 个以内`, cursorStates <= MAX_BROADCAST_CURSORS,
    `观察者视角含 cursor 状态 ${cursorStates} 个（客户端实际上报 ${EDITORS - 1 + SPECTATORS} 个写者）`);
  check('内容更新全部送达', latencies.length === clients.length - 1,
    `${latencies.length}/${clients.length - 1}`);
  check('内容更新 p95 延迟 < 500ms', latencyP95 < 500, `p50=${latencyP50}ms p95=${latencyP95}ms`);

  console.log('\n--- 数据 ---');
  console.log(`awareness 写入量     ${cursorWrites.count} 次（≈${(cursorWrites.count / (DURATION_MS / 1000)).toFixed(0)}/s）`);
  console.log(`客户端接收总流量     ${(totalBytes / 1024).toFixed(1)} KB，${totalMessages} 条消息`);
  console.log(`出站带宽（估算）     ${(bytesPerSecond / 1024).toFixed(1)} KB/s（200 客户端合计）`);
  console.log(`单客户端均摊         ${(totalBytes / clients.length / (DURATION_MS / 1000) / 1024).toFixed(2)} KB/s`);
  console.log(`服务端 CPU           avg=${cpuAvg.toFixed(1)}% max=${(Math.max(...cpuPercents, 0)).toFixed(1)}%`);

  // ---------- 第 201 条连接应被拒 ----------
  const overflowDoc = new Y.Doc();
  let quotaRejected = false;
  const overflow = new HocuspocusProvider({
    url,
    name: documentName,
    token: editorUser.token,
    document: overflowDoc,
    onAuthenticationFailed: () => {
      quotaRejected = true;
    },
  });
  await sleep(1500);
  check('第 201 条连接被配额拒绝', quotaRejected, quotaRejected ? '已拒绝' : '未拒绝（配额未生效）');
  overflow.destroy();
  overflowDoc.destroy();

  clients.forEach((client) => client.close());

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== 结果 ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('LOADTEST ERROR', error);
  process.exit(1);
});
