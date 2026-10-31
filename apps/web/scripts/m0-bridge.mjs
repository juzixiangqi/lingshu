// M0 ② 验证：Univer 跨 sheet 协同桥无 update 丢失。
// 两个真实 Edge 实例（各自独立 Y.Doc / clientId）加入同一 workbook，交替改写不同 sheet，
// 最后双向读回全部单元格：任何 op 丢失都会表现为两端值不一致。
//
// 用法：node apps/web/scripts/m0-bridge.mjs [--writes 20]

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WEB = 'http://localhost:5173';
const API = 'http://localhost:8787';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const WRITES = Number(arg('writes', 20));
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
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
  return json;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function waitHttp(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* 继续等待 */
    }
    await sleep(500);
  }
  throw new Error(`${url} 在 ${timeoutMs}ms 内未就绪`);
}

async function openSheet(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lingshuSheet?.univerAPI, null, { timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已同步'), null, { timeout: 30000 });
  // bridge 插件在 sheet 类型加载后异步 steady，必须等到服务注册再驱动命令
  await page.waitForFunction(() => window.__lingshuSheet.bridge(), null, { timeout: 30000 });
}

function readCells(page, cells) {
  return page.evaluate((targets) => {
    const workbook = window.__lingshuSheet.univerAPI.getActiveWorkbook();
    return targets.map(([sheetId, a1]) => {
      const range = workbook.getSheetBySheetId(sheetId)?.getRange(a1);
      const value = range?.getValue();
      if (value === undefined || value === null) return null;
      return typeof value === 'object' ? value.v ?? null : value;
    });
  }, cells);
}

async function main() {
  console.log('=== M0 ② Univer 跨 sheet 协同桥验证 ===\n');

  const vite = spawn('pnpm', ['--filter', '@lingshu/web', 'dev', '--', '--port', '5173', '--strictPort'], {
    cwd: 'e:\\IT\\Project\\lingshu',
    shell: true,
    stdio: 'ignore',
  });
  await waitHttp(`${WEB}/`);

  const user = await api('/api/auth/dev-login', {
    method: 'POST',
    body: { email: 'm0-bridge@lingshu.local', displayName: 'M0 桥接验证' },
  });
  const created = await api('/api/docs', {
    token: user.token,
    method: 'POST',
    body: { kind: 'sheet', title: `M0 桥接 ${new Date().toISOString()}` },
  });
  const docId = created.doc.id;
  console.log(`文档 ${docId}（${created.doc.collab.documentNames.join(', ')}）\n`);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const pages = [await browser.newPage({ viewport: { width: 1440, height: 900 } }), await browser.newPage({ viewport: { width: 1440, height: 900 } })];
  for (const page of pages) {
    await page.addInitScript(
      ([token, sessionUser]) => {
        localStorage.setItem('lingshu.token', token);
        localStorage.setItem('lingshu.user', sessionUser);
      },
      [user.token, JSON.stringify(user.user)],
    );
    page.on('console', (message) => {
      const text = message.text();
      if (/CollabBridge|Replay|error/i.test(text)) console.log(`  [console] ${text.slice(0, 300)}`);
    });
    page.on('pageerror', (error) => console.log(`  [pageerror] ${String(error).slice(0, 300)}`));
  }

  await openSheet(pages[0], `${WEB}/sheet/${docId}`);
  console.log('A 端已同步');
  await openSheet(pages[1], `${WEB}/sheet/${docId}`);
  console.log('B 端已同步\n');

  // 交替在两个客户端、三个 sheet 上写入，覆盖“同一 sheet 双写”和“跨 sheet 并发写”
  const sheets = ['s1', 's2', 's3'];
  const targets = [];
  for (let i = 0; i < WRITES; i += 1) {
    const sheetId = sheets[i % sheets.length];
    const a1 = `A${i + 1}`;
    const value = `V${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
    const page = pages[i % pages.length];
    await page.evaluate(
      ([targetSheet, cell, cellValue]) => {
        const workbook = window.__lingshuSheet.univerAPI.getActiveWorkbook();
        workbook.getSheetBySheetId(targetSheet).getRange(cell).setValue(cellValue);
      },
      [sheetId, a1, value],
    );
    targets.push([sheetId, a1, value]);
    await sleep(60);
  }
  console.log(`已写入 ${targets.length} 个单元格，等待广播收敛…`);
  await sleep(3000);

  const opCounts = await Promise.all(
    pages.map((page) => page.evaluate(() => window.__lingshuSheet.doc.getArray('opLog').length)),
  );
  console.log(`op 流条数         A=${opCounts[0]} B=${opCounts[1]}（应为 ${targets.length}）`);

  const probes = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        const doc = window.__lingshuSheet.doc;
        let service = 'none';
        try {
          service = window.__lingshuSheet.bridge() ? 'registered' : 'missing';
        } catch (error) {
          service = `throw: ${String(error).slice(0, 80)}`;
        }
        return { presence: doc.getMap('presence').size, meta: doc.getMap('meta').size, service };
      }),
    ),
  );
  console.log(`桥状态            ${probes.map((probe) => `presence=${probe.presence} meta=${probe.meta} service=${probe.service}`).join(' | ')}`);

  const registries = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        try {
          const services = window.__lingshuSheet.services();
          return { self: window.__lingshuSheet.clientId, keys: Array.from(services.keys ? services.keys() : Object.keys(services)) };
        } catch (error) {
          return { self: '?', error: String(error).slice(0, 120) };
        }
      }),
    ),
  );
  console.log(`服务注册表        ${registries.map((item) => JSON.stringify(item)).join(' | ')}`);

  const cells = targets.map(([sheetId, a1]) => [sheetId, a1]);
  const expected = targets.map(([, , value]) => value);
  const readA = await readCells(pages[0], cells);
  const readB = await readCells(pages[1], cells);

  const same = (left, right) => left.every((value, index) => value === right[index]);
  const matchExpected = (actual) => actual.every((value, index) => value === expected[index]);
  const countMismatch = (actual) => actual.filter((value, index) => value !== expected[index]).length;

  console.log('');
  console.log(`A 端一致率         ${targets.length - countMismatch(readA)}/${targets.length}`);
  console.log(`B 端一致率         ${targets.length - countMismatch(readB)}/${targets.length}`);
  console.log(`两端最终值一致     ${same(readA, readB) ? '是' : '否'}`);

  const passed = matchExpected(readA) && matchExpected(readB);
  console.log(`\n=== ${passed ? 'PASS' : 'FAIL'} 跨 sheet 无 update 丢失 ===`);

  await browser.close();
  killTree(vite);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error('BRIDGE ERROR', error);
  process.exit(1);
});
