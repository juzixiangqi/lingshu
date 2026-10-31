// M0 客户端帧率实测：真实 Edge 里打开文档页，同时让 Node 压测端拉起 200 人协同，测渲染帧率。
// 用法：node apps/web/scripts/m0-fps.mjs [--seconds 20] [--editors 49] [--spectators 150]
//
// 与 m0-loadtest.mjs 的分工：那个脚本测服务端 CPU / 带宽 / 广播延迟；
// 脚本测不了 DOM 渲染，本脚本补上“客户端编辑区 ≥30fps”这条红线。

import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WEB = 'http://localhost:5173';
const API = 'http://localhost:8787';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const SECONDS = Number(arg('seconds', 20));
const EDITORS = Number(arg('editors', 49));
const SPECTATORS = Number(arg('spectators', 150));

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

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  console.log('=== M0 客户端帧率实测（Edge + 200 人协同） ===\n');

  // 1) 起 Vite 开发服务器
  const vite = spawn('pnpm', ['--filter', '@lingshu/web', 'dev', '--', '--port', '5173', '--strictPort'], {
    cwd: 'e:\\IT\\Project\\lingshu',
    shell: true,
    stdio: 'ignore',
  });
  await waitHttp(`${WEB}/`);

  // 2) 用压测端同一身份建文档，浏览器随后以该身份打开（等价于“自己也在会上”）
  const user = await api('/api/auth/dev-login', {
    method: 'POST',
    body: { email: 'm0-editor@lingshu.local', displayName: 'M0 浏览器编辑者' },
  });
  const created = await api('/api/docs', {
    token: user.token,
    method: 'POST',
    body: { kind: 'doc', title: `M0 帧率实测 ${new Date().toISOString()}` },
  });
  const docId = created.doc.id;
  console.log(`文档 ${docId}`);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(
    ([token, sessionUser]) => {
      localStorage.setItem('lingshu.token', token);
      localStorage.setItem('lingshu.user', sessionUser);
    },
    [user.token, JSON.stringify(user.user)],
  );
  await page.goto(`${WEB}/doc/${docId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.editor-surface', { timeout: 30000 });
  await page.waitForFunction(() => document.body.innerText.includes('已同步'), null, { timeout: 20000 });
  console.log('浏览器已同步，启动 200 人压测…\n');

  // 3) 拉起压测端（49 editor + 150 spectator + 浏览器自身 = 200 连接）
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

  // 等压测端进入测量阶段（预热结束、200 连接稳定）
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('压测端未进入测量阶段')), 60000);
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
  console.log('压测已进入测量阶段，开始采样帧率…');

  // 4) 采样：一边持续输入（制造真实的重渲染负载），一边记录 rAF 间隔
  await page.click('.editor-surface');
  const typing = setInterval(() => {
    page.keyboard.type(' 协同压测').catch(() => undefined);
  }, 1000);

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
    SECONDS * 1000,
  );

  clearInterval(typing);
  load.kill();
  killTree(load);

  // 5) 指标
  const total = frames.reduce((sum, value) => sum + value, 0);
  const avgFps = frames.length / (total / 1000);
  const p95Interval = percentile(frames, 95);
  const worstFps = 1000 / Math.max(...frames);
  const slowFrames = frames.filter((value) => value > 1000 / 30).length;

  console.log('');
  console.log(`采样帧数        ${frames.length}`);
  console.log(`平均帧率        ${avgFps.toFixed(1)} fps`);
  console.log(`帧间隔 p95      ${p95Interval.toFixed(1)} ms`);
  console.log(`最差 1 帧      ${worstFps.toFixed(1)} fps`);
  console.log(`低于 30fps 的帧 ${slowFrames} / ${frames.length}`);

  const passed = avgFps >= 30;
  console.log(`\n=== ${passed ? 'PASS' : 'FAIL'} 客户端编辑区 ≥30fps ===`);

  await browser.close();
  killTree(vite);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error('FPS ERROR', error);
  process.exit(1);
});
