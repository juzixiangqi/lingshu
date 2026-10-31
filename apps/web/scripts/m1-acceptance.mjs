// M1 剩余四条性能验收门。M0 已覆盖“单文档 200 并发 / 跨 sheet 桥 / 分片路由”，
// 这里补上设计文档第 7 节里 M1 剩下的测量：
//   ① sheet   表格单 sheet 200 人协同（1 个真实 Univer 写者 + 199 个读端）
//   ② doc     8 万字文档 200 人打开（测同步耗时与客户端 ProseMirror 解析耗时）
//   ③ fps     真实带 vsync 的 Edge（headful）里 200 人协同时编辑区 ≥30fps
//   ④ bandwidth  spectator 50/100/150 三档，验证出站带宽随旁观者数量亚线性增长
//
// 用法：node apps/web/scripts/m1-acceptance.mjs --gate sheet|doc|fps|bandwidth|all
//       公共参数：--api http://localhost:8787  --web http://localhost:5173

import { spawn } from 'node:child_process';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { chromium } from 'playwright-core';
import * as Y from 'yjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const API = arg('api', 'http://localhost:8787');
const WEB = arg('web', 'http://localhost:5173');
const GATE = arg('gate', 'all');
const CONNECT_BATCH = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function report(title, data) {
  console.log(`\n--- ${title} ---`);
  for (const [key, value] of Object.entries(data)) console.log(`${key.padEnd(20)} ${value}`);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
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

function login(email, displayName) {
  return api('/api/auth/dev-login', { method: 'POST', body: { email, displayName } });
}

async function createDoc(token, kind, title) {
  return api('/api/docs', { token, method: 'POST', body: { kind, title } });
}

async function getDoc(token, docId) {
  return api(`/api/docs/${docId}`, { token });
}

async function invite(token, docId, email, role) {
  await api(`/api/docs/${docId}/members`, { token, method: 'POST', body: { email, role } });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 开发服务沿用已运行的进程；没启动时才拉起来，避免端口冲突。 */
async function ensureWeb() {
  if (await reachable(`${WEB}/`)) return null;
  const vite = spawn('pnpm', ['--filter', '@lingshu/web', 'dev', '--', '--port', '5173', '--strictPort'], {
    cwd: 'e:\\IT\\Project\\lingshu',
    shell: true,
    stdio: 'ignore',
  });
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (await reachable(`${WEB}/`)) return vite;
    await sleep(500);
  }
  killTree(vite);
  throw new Error(`${WEB} 未就绪`);
}

/**
 * 一条协同连接。统计下行字节数与同步耗时；
 * readers 额外记录 syncedAt，用于“200 人打开”的分位数。
 */
function openClient({ url, name, token, label }) {
  const doc = new Y.Doc();
  const startedAt = Date.now();
  let syncedAt = null;
  let receivedBytes = 0;
  let receivedMessages = 0;

  const provider = new HocuspocusProvider({
    url,
    name,
    token,
    document: doc,
    onSynced: () => {
      syncedAt = Date.now();
    },
    onMessage: ({ event }) => {
      receivedBytes += event?.data?.byteLength ?? event?.data?.length ?? 0;
      receivedMessages += 1;
    },
  });

  return {
    label,
    doc,
    provider,
    get synced() {
      return syncedAt !== null;
    },
    get syncedMs() {
      return syncedAt === null ? null : syncedAt - startedAt;
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

async function connectAll(clients) {
  const failed = [];
  for (let i = 0; i < clients.length; i += CONNECT_BATCH) {
    const batch = clients.slice(i, i + CONNECT_BATCH);
    const settled = await Promise.allSettled(
      batch.map(
        (client) =>
          new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
              if (client.synced) {
                clearInterval(timer);
                resolve();
              } else if (Date.now() - started > 20_000) {
                clearInterval(timer);
                reject(new Error(`${client.label} 连接超时`));
              }
            }, 100);
          }),
      ),
    );
    settled.forEach((result, index) => {
      if (result.status === 'rejected') failed.push(batch[index].label);
    });
    console.log(`  已连接 ${Math.min(i + CONNECT_BATCH, clients.length)}/${clients.length}`);
  }
  return failed;
}

async function launchBrowser(headless) {
  return chromium.launch({
    executablePath: EDGE,
    headless,
    args: headless
      ? []
      : ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
}

async function newAuthedPage(browser, token, user) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(
    ([sessionToken, sessionUser]) => {
      localStorage.setItem('lingshu.token', sessionToken);
      localStorage.setItem('lingshu.user', sessionUser);
    },
    [token, JSON.stringify(user.user)],
  );
  // 只打印前几条：压测端会注入合成光标坐标，编辑器渲染远端光标时可能连续抛异常
  let pageErrors = 0;
  page.on('pageerror', (error) => {
    pageErrors += 1;
    if (pageErrors <= 3) console.log(`  [pageerror#${pageErrors}] ${String(error.stack ?? error).slice(0, 800)}`);
  });
  return page;
}

async function openSheetPage(browser, token, user, docId) {
  const page = await newAuthedPage(browser, token, user);
  await page.goto(`${WEB}/sheet/${docId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lingshuSheet?.univerAPI, null, { timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes('已同步'), null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__lingshuSheet.bridge(), null, { timeout: 30_000 });
  return page;
}

// ---------------- ① 表格单 sheet 200 人协同 ----------------

async function gateSheet() {
  console.log('\n=== M1 ① 表格单 sheet 200 人协同 ===\n');
  const WRITES = Number(arg('writes', 40));
  const vite = await ensureWeb();

  const owner = await login('m1-sheet-owner@lingshu.local', 'M1 表格所有者');
  const reader = await login('m1-sheet-reader@lingshu.local', 'M1 表格旁观者');
  const created = await createDoc(owner.token, 'sheet', `M1 单 sheet 压测 ${new Date().toISOString()}`);
  const docId = created.doc.id;
  await invite(owner.token, docId, reader.user.email, 'spectator');

  const detail = await getDoc(owner.token, docId);
  const url = detail.doc.collab.url;
  const documentName = detail.doc.collab.documentNames[0];
  console.log(`文档 ${docId}\n分片 ${url}\nY.Doc ${documentName}（workbook 级 op 流）\n`);

  const browser = await launchBrowser(true);
  const writer = await openSheetPage(browser, owner.token, owner, docId);
  console.log('写者（真实 Univer 客户端）已同步');

  // 199 个读端 + 写者 = 200 条连接
  const readers = Array.from({ length: 199 }, (_, i) =>
    openClient({ url, name: documentName, token: reader.token, label: `reader-${i}` }),
  );
  const failed = await connectAll(readers);
  check('200 条连接全部建立（1 写 + 199 读）', failed.length === 0, failed.length ? `失败 ${failed.length}` : '');

  // 记录每个 op 在各读端的到达时间
  readers.forEach((client) => {
    client.arrivals = [];
    client.recorded = 0;
    const opLog = client.doc.getArray('opLog');
    opLog.observe(() => {
      const now = Date.now();
      while (client.recorded < opLog.length) {
        client.arrivals.push(now);
        client.recorded += 1;
      }
    });
  });

  // 写者在单 sheet 上连续写入；严格串行，保证第 i 次写入对应 opLog 的第 i 条 op
  const writeAt = [];
  const values = [];
  for (let i = 0; i < WRITES; i += 1) {
    const cell = `A${i + 1}`;
    const value = `V${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
    writeAt.push(Date.now());
    await writer.evaluate(
      ([target, cellValue]) => {
        const workbook = window.__lingshuSheet.univerAPI.getActiveWorkbook();
        workbook.getSheetBySheetId(target).getRange(cellValue[0]).setValue(cellValue[1]);
      },
      ['s1', [cell, value]],
    );
    values.push(value);
    await sleep(80);
  }
  console.log(`\n已写入 ${WRITES} 个单元格，等待广播收敛…`);
  await sleep(4_000);

  const writerOps = await writer.evaluate(() => window.__lingshuSheet.doc.getArray('opLog').toArray());
  const readerOps = readers.map((client) => client.doc.getArray('opLog').toArray());
  const writerJson = JSON.stringify(writerOps);
  const mismatch = readerOps.filter((ops) => JSON.stringify(ops) !== writerJson).length;

  check('写者 op 流条数 = 写入次数', writerOps.length === WRITES, `${writerOps.length}/${WRITES}`);
  check('199 个读端 op 流逐条一致（无丢失）', mismatch === 0, mismatch ? `${mismatch} 个读端不一致` : `${WRITES} 条 op × 199 端`);

  // 每个 op 取“最慢读端”的到达时间，算端到端广播延迟
  const latencies = [];
  for (let i = 0; i < Math.min(WRITES, writerOps.length); i += 1) {
    const arrivals = readers.map((client) => client.arrivals[i]).filter((value) => value !== undefined);
    if (!arrivals.length) continue;
    latencies.push(Math.max(...arrivals) - writeAt[i]);
  }
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  check('单 sheet 200 人 op 广播 p95 < 500ms', p95 < 500, `p50=${p50}ms p95=${p95}ms`);

  // 抽检写者最终单元格值
  const sampleCount = Math.min(WRITES, 10);
  const sampled = await writer.evaluate((count) => {
    const workbook = window.__lingshuSheet.univerAPI.getActiveWorkbook();
    return Array.from({ length: count }, (_, i) => {
      const value = workbook.getSheetBySheetId('s1').getRange(`A${i + 1}`).getValue();
      return typeof value === 'object' && value !== null ? value.v : value;
    });
  }, sampleCount);
  const sampledOk = sampled.every((value, index) => value === values[index]);
  check('写者最终单元格值与写入一致', sampledOk, `抽检 ${sampled.length} 个`);

  report('表格单 sheet 200 人协同', {
    '连接总量': '200（1 写 + 199 读）',
    'op 条数': writerOps.length,
    '广播 p50/p95': `${p50}ms / ${p95}ms`,
  });

  readers.forEach((client) => client.close());
  await browser.close();
  killTree(vite);
}

// ---------------- ② 8 万字文档 200 人打开 ----------------

/**
 * 在 Node 侧直接构造 400 个段落 × 200 字 = 80,000 字。
 * TipTap 的 Collaboration 绑定读取 `<docId>/body` 的 XmlFragment('default')，
 * 节点名必须与 StarterKit 的 schema 对齐（paragraph + XmlText）。
 */
function seedLargeDocument(client, paragraphs, charsPerParagraph) {
  const fragment = client.doc.getXmlFragment('default');
  const nodes = [];
  for (let i = 0; i < paragraphs; i += 1) {
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '灵'.repeat(charsPerParagraph));
    paragraph.insert(0, [text]);
    nodes.push(paragraph);
  }
  client.doc.transact(() => fragment.insert(0, nodes));
}

async function gateDoc() {
  console.log('\n=== M1 ② 8 万字文档 200 人打开 ===\n');
  const PARAGRAPHS = 400;
  const CHARS_PER_PARAGRAPH = 200;
  const vite = await ensureWeb();

  const owner = await login('m1-doc-owner@lingshu.local', 'M1 文档所有者');
  const reader = await login('m1-doc-reader@lingshu.local', 'M1 文档旁观者');
  const created = await createDoc(owner.token, 'doc', `M1 8 万字文档 ${new Date().toISOString()}`);
  const docId = created.doc.id;
  await invite(owner.token, docId, reader.user.email, 'spectator');

  const detail = await getDoc(owner.token, docId);
  const url = detail.doc.collab.url;
  const documentName = detail.doc.collab.documentNames[0];

  // 写者：owner 身份，负责把 8 万字灌入 Y.Doc；同时占用 200 配额中的 1 条连接
  const seeder = openClient({ url, name: documentName, token: owner.token, label: 'seeder' });
  await connectAll([seeder]);
  seedLargeDocument(seeder, PARAGRAPHS, CHARS_PER_PARAGRAPH);
  await sleep(3_000);
  console.log(`已写入 ${PARAGRAPHS} 段 × ${CHARS_PER_PARAGRAPH} 字 = ${(PARAGRAPHS * CHARS_PER_PARAGRAPH).toLocaleString()} 字\n`);

  // 197 个读端先占满连接，浏览器页面随后在全量负载下打开
  const readers = Array.from({ length: 197 }, (_, i) =>
    openClient({ url, name: documentName, token: reader.token, label: `reader-${i}` }),
  );
  const failed = await connectAll(readers);
  const readyReaders = readers.filter((client) => client.synced);
  const syncMs = readyReaders.map((client) => client.syncedMs).filter((value) => value !== null);
  const fragmentComplete = readyReaders.filter((client) => client.doc.getXmlFragment('default').length === PARAGRAPHS).length;
  console.log(`\n197 个读端同步 p50=${percentile(syncMs, 50)}ms p95=${percentile(syncMs, 95)}ms`);

  const browser = await launchBrowser(true);
  const editorPage = await newAuthedPage(browser, owner.token, owner);
  const spectatorPage = await newAuthedPage(browser, reader.token, reader);

  const measure = async (page, path) => {
    // 页面在协同连接 / 同步完成时写入 __lingshuDoc*（见 DocEditorPage，仅开发环境）。
    // TipTap 的编辑器先以空 Y.Doc 构造，正文随后按 Yjs 更新增量解析进来，
    // 所以 parse = “WebSocket 已连接 → 正文完整渲染”，排除页面 bundle 与文档元数据请求。
    await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__lingshuDocConnectedAt, null, { timeout: 60_000 });
    const timing = await page.evaluate(
      (threshold) =>
        new Promise((resolve) => {
          const started = performance.now();
          const poll = () => {
            const surface = document.querySelector('.editor-surface');
            const chars = surface?.innerText.length ?? 0;
            if (chars >= threshold) {
              resolve({ connectedAt: window.__lingshuDocConnectedAt, contentReadyAt: performance.now(), chars });
              return;
            }
            if (performance.now() - started > 30_000) {
              resolve({ connectedAt: window.__lingshuDocConnectedAt, contentReadyAt: performance.now(), chars, timeout: true });
              return;
            }
            requestAnimationFrame(poll);
          };
          poll();
        }),
      79_000,
    );
    return { ...timing, parseMs: timing.contentReadyAt - timing.connectedAt };
  };

  const editorTiming = await measure(editorPage, `/doc/${docId}`);
  const spectatorTiming = await measure(spectatorPage, `/doc/${docId}`);
  console.log(`\n编辑端 parse=${editorTiming.parseMs}ms（${editorTiming.chars} 字）`);
  console.log(`旁观端 parse=${spectatorTiming.parseMs}ms（${spectatorTiming.chars} 字）`);

  // 旁观端不渲染远端光标：编辑端移动一次光标后，旁观端不应出现任何协同光标
  await editorPage.click('.editor-surface');
  await editorPage.keyboard.press('ArrowLeft');
  await sleep(1_500);
  const spectatorCarets = await spectatorPage.evaluate(
    () => document.querySelectorAll('.collaboration-cursor__caret').length,
  );

  check('200 条连接全部建立（1 写者 + 197 读端 + 2 浏览器）', failed.length === 0 && readers.every((client) => client.synced), failed.length ? `失败 ${failed.length}` : '');
  check('197 个读端都收到 400 段正文', fragmentComplete === readyReaders.length, `${fragmentComplete}/${readyReaders.length}`);
  check('编辑端 8 万字 parse ≤ 3s', editorTiming.parseMs <= 3_000, `${editorTiming.parseMs}ms`);
  check('旁观端 8 万字 parse ≤ 3s', spectatorTiming.parseMs <= 3_000, `${spectatorTiming.parseMs}ms`);
  check('编辑端正文完整渲染', editorTiming.chars >= 79_000, `${editorTiming.chars} 字`);
  check('旁观端不渲染远端光标', spectatorCarets === 0, `协同光标 ${spectatorCarets} 个`);

  report('8 万字文档 200 人打开', {
    '正文规模': `${PARAGRAPHS} 段 / 80,000 字`,
    '读端同步 p50/p95': `${percentile(syncMs, 50)}ms / ${percentile(syncMs, 95)}ms`,
    '编辑端 parse': `${editorTiming.parseMs}ms`,
    '旁观端 parse': `${spectatorTiming.parseMs}ms`,
    '旁观端协同光标': spectatorCarets,
  });

  readers.forEach((client) => client.close());
  seeder.close();
  await browser.close();
  killTree(vite);
}

// ---------------- ③ 真实带 vsync 的 30fps ----------------

async function gateFps() {
  console.log('\n=== M1 ③ 真实设备（headful vsync）编辑区帧率 ===\n');
  const SECONDS = Number(arg('seconds', 20));
  const EDITORS = 49;
  const SPECTATORS = 150;
  const vite = await ensureWeb();

  // 与 m0-loadtest 的压测身份保持一致：文档需由压测端账号创建，它才有权邀请压测旁观者
  const owner = await login('m0-editor@lingshu.local', 'M1 浏览器编辑者');
  const created = await createDoc(owner.token, 'doc', `M1 帧率实测 ${new Date().toISOString()}`);
  const docId = created.doc.id;

  const browser = await launchBrowser(false);
  const page = await newAuthedPage(browser, owner.token, owner);
  await page.goto(`${WEB}/doc/${docId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lingshuDocSyncAt, null, { timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes('已同步'), null, { timeout: 30_000 });
  await page.bringToFront();
  console.log('浏览器已同步，拉起 49 editor + 150 spectator…\n');

  const load = spawn(
    process.execPath,
    [
      'apps/web/scripts/m0-loadtest.mjs',
      '--doc', docId,
      '--editors', String(EDITORS),
      '--spectators', String(SPECTATORS),
      '--duration', String(SECONDS + 6),
      '--warmup', '5',
    ],
    { cwd: 'e:\\IT\\Project\\lingshu', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('压测端未进入测量阶段')), 60_000);
    load.stdout.on('data', (chunk) => {
      if (String(chunk).includes('测量中')) {
        clearTimeout(timer);
        resolve();
      }
    });
    load.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`压测端提前退出（code=${code}）`));
    });
  });

  await page.click('.editor-surface');
  const typing = setInterval(() => {
    page.keyboard.type(' 协同压测').catch(() => undefined);
  }, 1_000);

  const frames = await page.evaluate(
    (durationMs) =>
      new Promise((resolve) => {
        const intervals = [];
        let last = performance.now();
        const start = last;
        function tick(now) {
          intervals.push(now - last);
          last = now;
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve(intervals);
        }
        requestAnimationFrame(tick);
      }),
    SECONDS * 1_000,
  );

  clearInterval(typing);
  killTree(load);

  const total = frames.reduce((sum, value) => sum + value, 0);
  const avgFps = frames.length / (total / 1_000);
  const p95Interval = percentile(frames, 95);
  const worstFps = 1_000 / Math.max(...frames);
  const slowFrames = frames.filter((value) => value > 1_000 / 30).length;

  check('headful 编辑区平均帧率 ≥ 30fps', avgFps >= 30, `${avgFps.toFixed(1)} fps`);
  report('headful 帧率', {
    '采样帧数': frames.length,
    '平均帧率': `${avgFps.toFixed(1)} fps`,
    '帧间隔 p95': `${p95Interval.toFixed(1)} ms`,
    '最差 1 帧': `${worstFps.toFixed(1)} fps`,
    '低于 30fps 的帧': `${slowFrames} / ${frames.length}`,
  });

  await browser.close();
  killTree(vite);
}

// ---------------- ④ spectator 数量与出站带宽 ----------------

async function measureBandwidth(editors, spectators, durationMs) {
  const owner = await login('m1-band-editor@lingshu.local', 'M1 带宽编辑者');
  const spectatorUser = await login('m1-band-spectator@lingshu.local', 'M1 带宽旁观者');
  const created = await createDoc(owner.token, 'doc', `M1 带宽 ${spectators} ${new Date().toISOString()}`);
  const docId = created.doc.id;
  await invite(owner.token, docId, spectatorUser.user.email, 'spectator');
  const detail = await getDoc(owner.token, docId);
  const url = detail.doc.collab.url;
  const documentName = detail.doc.collab.documentNames[0];

  const editorClients = Array.from({ length: editors }, (_, i) =>
    openClient({ url, name: documentName, token: owner.token, label: `editor-${i}` }),
  );
  const spectatorClients = Array.from({ length: spectators }, (_, i) =>
    openClient({ url, name: documentName, token: spectatorUser.token, label: `spectator-${i}` }),
  );
  const clients = [...editorClients, ...spectatorClients];
  const failed = await connectAll(clients);
  if (failed.length) throw new Error(`${spectators} 档连接失败 ${failed.length} 条`);

  clients.forEach((client, index) => {
    client.provider.setAwarenessField('user', { name: `用户${index}`, color: '#2b6cb0' });
  });
  await sleep(5_000);
  clients.forEach((client) => client.resetCounters());

  const awarenessTimer = setInterval(() => {
    for (const client of editorClients) {
      client.provider.setAwarenessField('cursor', {
        anchor: Math.floor(Math.random() * 100),
        head: Math.floor(Math.random() * 100),
      });
    }
    // spectator 也尝试上报光标，服务端必须剥离，否则会放大流量
    for (const client of spectatorClients) {
      client.provider.setAwarenessField('cursor', {
        anchor: Math.floor(Math.random() * 100),
        head: Math.floor(Math.random() * 100),
      });
    }
  }, 50);

  await sleep(durationMs);
  clearInterval(awarenessTimer);

  const totalBytes = clients.reduce((sum, client) => sum + client.receivedBytes, 0);
  const totalMessages = clients.reduce((sum, client) => sum + client.receivedMessages, 0);
  const bytesPerSecond = totalBytes / (durationMs / 1_000);
  const observer = editorClients[0];
  const cursorStates = [...observer.provider.awareness.getStates().values()].filter((state) => state.cursor).length;
  const observerStates = observer.provider.awareness.getStates().size;

  clients.forEach((client) => client.close());
  return {
    spectators,
    totalClients: clients.length,
    bytesPerSecond,
    totalMessages,
    cursorStates,
    observerStates,
  };
}

async function gateBandwidth() {
  console.log('\n=== M1 ④ spectator 数量与出站带宽 ===\n');
  const EDITORS = 50;
  const DURATION_MS = Number(arg('duration', 20)) * 1_000;
  const tiers = [50, 100, 150];
  const measurements = [];

  for (const spectators of tiers) {
    const result = await measureBandwidth(EDITORS, spectators, DURATION_MS);
    measurements.push(result);
    console.log(
      `  ${EDITORS} editor + ${spectators} spectator → ${(result.bytesPerSecond / 1024).toFixed(1)} KB/s` +
        `（${result.totalMessages.toLocaleString()} 条消息，观察者光标状态 ${result.cursorStates} 个）`,
    );
  }

  const base = measurements.find((item) => item.spectators === 50);
  const middle = measurements.find((item) => item.spectators === 100);
  const top = measurements.find((item) => item.spectators === 150);
  const ratio100 = middle.bytesPerSecond / base.bytesPerSecond;
  const ratio150 = top.bytesPerSecond / base.bytesPerSecond;
  const perSpectatorTop = top.bytesPerSecond / 200;
  const perSpectatorBase = base.bytesPerSecond / 100;

  check('spectator 50 → 100 时带宽增长 < 2 倍（亚线性）', ratio100 < 2, `${ratio100.toFixed(2)}×`);
  check('spectator 50 → 150 时带宽增长 < 3 倍（亚线性）', ratio150 < 3, `${ratio150.toFixed(2)}×`);
  check('三档 spectator 都只保留在线状态（无光标状态泄漏）', measurements.every((item) => item.cursorStates <= 20),
    measurements.map((item) => item.cursorStates).join(' / '));
  check('三档 spectator 均全部建立连接', measurements.every((item) => item.totalClients === 50 + item.spectators),
    measurements.map((item) => item.totalClients).join(' / '));

  report('spectator 出站带宽', {
    '50 spectator': `${(base.bytesPerSecond / 1024).toFixed(1)} KB/s`,
    '100 spectator': `${(middle.bytesPerSecond / 1024).toFixed(1)} KB/s`,
    '150 spectator': `${(top.bytesPerSecond / 1024).toFixed(1)} KB/s`,
    '50→100 倍数': `${ratio100.toFixed(2)}×`,
    '50→150 倍数': `${ratio150.toFixed(2)}×`,
    '单客户端均摊（50/150）': `${(perSpectatorBase / 1024).toFixed(2)} / ${(perSpectatorTop / 1024).toFixed(2)} KB/s`,
  });
}

// ---------------- 入口 ----------------

const gates = {
  sheet: gateSheet,
  doc: gateDoc,
  fps: gateFps,
  bandwidth: gateBandwidth,
};

async function main() {
  const selected = GATE === 'all' ? Object.keys(gates) : [GATE];
  if (selected.some((name) => !gates[name])) throw new Error(`未知 gate：${GATE}`);

  for (const name of selected) {
    try {
      await gates[name]();
    } catch (error) {
      check(`${name} 执行完成`, false, String(error).slice(0, 300));
    }
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\n=== M1 验收 ${passed}/${results.length} 通过 ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('M1 ACCEPTANCE ERROR', error);
  process.exit(1);
});
