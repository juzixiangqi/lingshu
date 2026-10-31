// M0 ③ 验证：一致性哈希路由，广播不跨分片。
// 检查项：
//   1. 同一文档反复查询，分片地址恒定
//   2. 多个文档在分片间有真实分布（不是全挤在一个分片）
//   3. 文档所属分片内写入，能被同分片其他连接收到
//   4. 同文档挂在“非所属分片”的连接收不到任何消息、内容与 awareness
//
// 用法：node apps/web/scripts/m0-routing.mjs [--docs 16] [--api http://localhost:8787]

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const API = arg('api', 'http://localhost:8787');
const DOC_COUNT = Number(arg('docs', 16));

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

/** 一条协同连接；正确分片的连接既写又读，错误分片的连接只观察。 */
function openClient({ url, name, token, label }) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  let receivedMessages = 0;
  let synced = false;

  const provider = new HocuspocusProvider({
    url,
    name,
    token,
    document: doc,
    onSynced: () => {
      synced = true;
    },
    onMessage: () => {
      receivedMessages += 1;
    },
  });

  return {
    label,
    url,
    doc,
    text,
    provider,
    get synced() {
      return synced;
    },
    get receivedMessages() {
      return receivedMessages;
    },
    resetCounter() {
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

async function waitSynced(client, timeoutMs = 20000) {
  const started = Date.now();
  while (!client.synced) {
    if (Date.now() - started > timeoutMs) throw new Error(`${client.label} 连接超时`);
    await sleep(100);
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('=== M0 ③ 一致性哈希路由 / 不跨分片广播验证 ===\n');

  const health = await api('/api/health');
  const shards = health.shards ?? [];
  if (shards.length < 2) throw new Error(`需要至少 2 个分片，当前 ${JSON.stringify(shards)}`);
  console.log(`分片列表 ${shards.join(', ')}\n`);

  const user = await api('/api/auth/dev-login', {
    method: 'POST',
    body: { email: 'm0-routing@lingshu.local', displayName: 'M0 路由验证' },
  });
  const token = user.token;

  // ---------- 建文档，收集每个文档被分配的分片 ----------
  const docs = [];
  for (let i = 0; i < DOC_COUNT; i += 1) {
    const created = await api('/api/docs', {
      token,
      method: 'POST',
      body: { kind: 'doc', title: `M0 路由 ${i} ${new Date().toISOString()}` },
    });
    const detail = await api(`/api/docs/${created.doc.id}`, { token });
    docs.push({ id: created.doc.id, url: detail.doc.collab.url, name: detail.doc.collab.documentNames[0] });
  }

  const counts = Object.fromEntries(shards.map((shard) => [shard, 0]));
  for (const item of docs) counts[item.url] = (counts[item.url] ?? 0) + 1;
  console.log(`分配结果 ${shards.map((shard) => `${shard}=${counts[shard]}`).join(' | ')}\n`);

  // 1) 同一文档重复查询，分片恒定
  const repeated = await Promise.all(docs.slice(0, 5).map((item) => api(`/api/docs/${item.id}`, { token })));
  const stable = repeated.every((detail, index) => detail.doc.collab.url === docs[index].url);
  check('同一文档重复查询分片恒定', stable, repeated.map((detail) => detail.doc.collab.url.split(':').pop()).join(','));

  // 2) 分片有真实分布
  const usedShards = shards.filter((shard) => counts[shard] > 0);
  check('文档在分片间有分布', usedShards.length === shards.length,
    `${DOC_COUNT} 篇覆盖 ${usedShards.length}/${shards.length} 个分片`);

  // 3) + 4) 每个分片各取一篇文档，验证分片内送达、跨分片零广播
  for (const shard of shards) {
    const target = docs.find((item) => item.url === shard);
    if (!target) continue;
    const otherShard = shards.find((item) => item !== shard);

    const writer = openClient({ url: shard, name: target.name, token, label: '写入者' });
    const reader = openClient({ url: shard, name: target.name, token, label: '同分片读者' });
    const stray = openClient({ url: otherShard, name: target.name, token, label: '异分片观察者' });
    await Promise.all([waitSynced(writer), waitSynced(reader), waitSynced(stray)]);

    // 预热期内容同步完成后清零，只统计随后的广播
    await sleep(500);
    [writer, reader, stray].forEach((client) => client.resetCounter());

    const nonce = `ROUTE-${Math.random().toString(36).slice(2, 8)}`;
    const receivedAt = { value: 0 };
    const onUpdate = () => {
      if (!receivedAt.value && reader.text.toString().includes(nonce)) receivedAt.value = Date.now();
    };
    reader.text.observe(onUpdate);

    const emitAt = Date.now();
    writer.text.insert(0, nonce);
    writer.provider.setAwarenessField('user', { name: `路由写入者 ${nonce}`, color: '#2b6cb0' });

    await sleep(2000);
    reader.text.unobserve(onUpdate);

    check(`[${shard}] 同分片读者收到内容更新`, receivedAt.value > 0,
      receivedAt.value ? `${receivedAt.value - emitAt}ms` : '未收到');
    check(`[${shard}] 异分片观察者零广播`, stray.receivedMessages === 0, `${stray.receivedMessages} 条消息`);
    check(`[${shard}] 异分片观察者无内容`, !stray.text.toString().includes(nonce),
      JSON.stringify(stray.text.toString().slice(0, 40)));
    const strayStates = writer.provider.awareness.clientID;
    check(`[${shard}] 异分片无 awareness`, ![...stray.provider.awareness.getStates().keys()].includes(strayStates),
      `异分片状态数 ${stray.provider.awareness.getStates().size}`);

    [writer, reader, stray].forEach((client) => client.close());
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n=== ${passed === results.length ? 'PASS' : 'FAIL'} 路由与分片隔离（${passed}/${results.length}） ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('ROUTING ERROR', error);
  process.exit(1);
});
