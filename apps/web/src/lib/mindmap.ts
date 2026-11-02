import type { MindElixirData, NodeObj } from 'mind-elixir';
import type * as Y from 'yjs';

/** 导图固定根节点 id：避免多端在空文档上并发初始化出两棵树。 */
export const MIND_ROOT_ID = 'root';

/**
 * 扁平节点记录。
 * 结构信息用 parentId + order 表达，mind-elixir 的树形数据在两端做一次性转换。
 * 每个节点是 Y.Map 的一个 independent key，不同分支的并发编辑不会互相覆盖。
 */
export interface MindNodeRecord {
  topic: string;
  parentId: string | null;
  /** 同一父节点下的顺序 */
  order: number;
  expanded: boolean;
}

export type MindTree = Map<string, MindNodeRecord>;
export type MindNodeMap = Y.Map<MindNodeRecord>;

function collect(node: NodeObj, parentId: string | null, order: number, tree: MindTree): void {
  tree.set(node.id, {
    topic: node.topic ?? '',
    parentId,
    order,
    // mind-elixir 的 expanded 省略时视为展开
    expanded: node.expanded !== false,
  });
  (node.children ?? []).forEach((child, index) => collect(child, node.id, index, tree));
}

/** mind-elixir 数据 → 扁平节点表（只保留首版支持的字段）。 */
export function treeFromMindData(data: MindElixirData): MindTree {
  const tree: MindTree = new Map();
  if (data.nodeData) collect(data.nodeData, null, 0, tree);
  return tree;
}

/** 扁平节点表 → mind-elixir 数据；根节点缺失时返回 null。 */
export function mindDataFromTree(tree: MindTree, rootId = MIND_ROOT_ID): MindElixirData | null {
  if (!tree.has(rootId)) return null;

  const childrenOf = new Map<string, string[]>();
  for (const [id, node] of tree) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(id);
    childrenOf.set(node.parentId, list);
  }
  for (const ids of childrenOf.values()) {
    ids.sort((a, b) => (tree.get(a)?.order ?? 0) - (tree.get(b)?.order ?? 0));
  }

  const build = (id: string): NodeObj => {
    const record = tree.get(id)!;
    const children = (childrenOf.get(id) ?? []).map(build);
    return {
      id,
      topic: record.topic,
      expanded: record.expanded,
      ...(children.length ? { children } : {}),
    };
  };

  return { nodeData: build(rootId) };
}

/**
 * 从 Y.Map 读出可渲染的树。
 * 只保留从 root 可达的节点：并发初始化或异常写入产生的孤儿节点不参与渲染，
 * 后续本地写回时会被 writeTree 一并清掉。
 */
export function readTree(nodes: MindNodeMap, rootId = MIND_ROOT_ID): MindTree {
  const all = new Map<string, MindNodeRecord>();
  for (const [id, record] of nodes.entries()) {
    if (record && typeof record === 'object') all.set(id, record);
  }
  if (!all.has(rootId)) return new Map();

  const childrenOf = new Map<string, string[]>();
  for (const [id, node] of all) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(id);
    childrenOf.set(node.parentId, list);
  }

  const tree: MindTree = new Map();
  const visit = (id: string): void => {
    const record = all.get(id);
    if (!record || tree.has(id)) return;
    tree.set(id, record);
    for (const childId of childrenOf.get(id) ?? []) visit(childId);
  };
  visit(rootId);
  return tree;
}

/** 把本地树写回 Y.Map：只 set 有变化的节点，删除已不存在的节点。 */
export function writeTree(nodes: MindNodeMap, tree: MindTree): void {
  const doc = nodes.doc;
  const apply = (): void => {
    for (const key of [...nodes.keys()]) {
      if (!tree.has(key)) nodes.delete(key);
    }
    for (const [id, record] of tree) {
      const previous = nodes.get(id);
      if (
        !previous ||
        previous.topic !== record.topic ||
        previous.parentId !== record.parentId ||
        previous.order !== record.order ||
        previous.expanded !== record.expanded
      ) {
        nodes.set(id, { ...record });
      }
    }
  };
  if (doc) doc.transact(apply);
  else apply();
}

/** 空导图初始化：固定根节点，标题取文档标题。已在协同端保持幂等。 */
export function initializeMind(nodes: MindNodeMap, title: string): void {
  if (nodes.has(MIND_ROOT_ID)) return;
  nodes.set(MIND_ROOT_ID, {
    topic: title.trim() || '中心主题',
    parentId: null,
    order: 0,
    expanded: true,
  });
}

/** 稳定签名，用于判断远端变化是否只是自己刚写回的数据。 */
export function treeSignature(tree: MindTree): string {
  return JSON.stringify([...tree.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
