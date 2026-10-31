/**
 * 文档一致性哈希路由。
 *
 * 设计约束：同一文档的所有连接必须落在同一个协同分片，
 * 这样 update/awareness 广播不会穿透到其他分片。
 *
 * 实现为纯 JS（不依赖 node:crypto），因此前端也可复用同一份规则，
 * 保证“API 返回的分片地址”与“客户端实际连接的分片”一致。
 */

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

interface RingPoint {
  hash: number;
  shard: string;
}

const ringCache = new Map<string, RingPoint[]>();

function buildRing(shards: readonly string[], virtualNodes: number): RingPoint[] {
  const cacheKey = `${virtualNodes}:${shards.join('|')}`;
  const cached = ringCache.get(cacheKey);
  if (cached) return cached;

  const points: RingPoint[] = [];
  for (const shard of shards) {
    for (let i = 0; i < virtualNodes; i += 1) {
      points.push({ hash: fnv1a32(`${shard}#${i}`), shard });
    }
  }
  points.sort((a, b) => a.hash - b.hash);
  ringCache.set(cacheKey, points);
  return points;
}

/**
 * 按 key（通常是 document_id）选择分片。
 * 分片列表固定时结果稳定；节点增删只会迁移约 1/N 的文档。
 *
 * virtualNodes 取 1024：FNV-1a 对“仅末尾少量字符不同”的分片名（如 ...:1234 / ...:1235）
 * 雪崩不足，64/256 个虚拟节点时环上弧长会明显偏斜（实测 88%/12%、54%/46%）；
 * 1024 时收敛到 49%/51%，建环仍只是「分片数 × virtualNodes」个点。
 */
export function pickShard(key: string, shards: readonly string[], virtualNodes = 1024): string {
  const first = shards[0];
  if (!first) {
    throw new Error('pickShard: 分片列表为空');
  }
  if (shards.length === 1) return first;

  const ring = buildRing(shards, virtualNodes);
  const target = fnv1a32(key);

  // 二分查找第一个 hash >= target 的虚拟节点；找不到则回绕到环首
  let lo = 0;
  let hi = ring.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid]!.hash < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return ring[lo % ring.length]!.shard;
}

/** 归一化分片配置：支持 `a|b|c` 字符串与数组两种输入。 */
export function parseShards(raw: string | readonly string[]): string[] {
  const list: string[] = typeof raw === 'string' ? raw.split('|') : [...raw];
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}
