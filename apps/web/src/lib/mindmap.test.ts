import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MIND_ROOT_ID,
  initializeMind,
  mindDataFromTree,
  readTree,
  treeFromMindData,
  treeSignature,
  writeTree,
  type MindNodeMap,
  type MindNodeRecord,
} from './mindmap';

function createMap(): MindNodeMap {
  const doc = new Y.Doc();
  return doc.getMap<MindNodeRecord>('nodes');
}

describe('思维导图数据转换', () => {
  it('mind-elixir 树可还原为相同的树结构与顺序', () => {
    const data = {
      nodeData: {
        id: MIND_ROOT_ID,
        topic: '中心主题',
        children: [
          { id: 'a', topic: '分支 A', children: [{ id: 'a1', topic: '子主题 A1' }] },
          { id: 'b', topic: '分支 B', expanded: false },
        ],
      },
    };
    const tree = treeFromMindData(data);
    expect([...tree.keys()]).toEqual([MIND_ROOT_ID, 'a', 'a1', 'b']);
    expect(tree.get('a')?.parentId).toBe(MIND_ROOT_ID);
    expect(tree.get('a')?.order).toBe(0);
    expect(tree.get('a1')?.order).toBe(0);
    expect(tree.get('b')?.order).toBe(1);
    expect(tree.get('b')?.expanded).toBe(false);

    const restored = mindDataFromTree(tree);
    expect(restored?.nodeData.topic).toBe('中心主题');
    expect(restored?.nodeData.children?.map((n) => n.id)).toEqual(['a', 'b']);
    expect(restored?.nodeData.children?.[1]?.expanded).toBe(false);
  });

  it('写回时只保留根节点可达的记录', () => {
    const nodes = createMap();
    initializeMind(nodes, '灵枢导图');
    expect(nodes.has(MIND_ROOT_ID)).toBe(true);

    const tree = new Map<string, MindNodeRecord>([
      [MIND_ROOT_ID, nodes.get(MIND_ROOT_ID)!],
      ['child', { topic: '分支', parentId: MIND_ROOT_ID, order: 0, expanded: true }],
    ]);
    // 模拟异常写入留下的不可达节点：写回时应被清除
    nodes.set('orphan', { topic: '孤儿', parentId: null, order: 1, expanded: true });
    writeTree(nodes, tree);
    expect(readTree(nodes).size).toBe(2);
    expect(nodes.has('orphan')).toBe(false);
    expect(treeSignature(readTree(nodes))).toBe(
      treeSignature(
        new Map([
          [MIND_ROOT_ID, nodes.get(MIND_ROOT_ID)!],
          ['child', nodes.get('child')!],
        ]),
      ),
    );
  });

  it('修改节点文本只更新对应记录', () => {
    const nodes = createMap();
    initializeMind(nodes, '根');
    const record = nodes.get(MIND_ROOT_ID)!;
    const tree = readTree(nodes);
    tree.set(MIND_ROOT_ID, { ...record, topic: '新标题' });
    writeTree(nodes, tree);
    expect(nodes.get(MIND_ROOT_ID)?.topic).toBe('新标题');
  });

  it('空文档初始化幂等，不覆盖已有根节点', () => {
    const nodes = createMap();
    initializeMind(nodes, '标题');
    initializeMind(nodes, '另一个标题');
    expect(nodes.size).toBe(1);
    expect(nodes.get(MIND_ROOT_ID)?.topic).toBe('标题');
  });

  it('根节点缺失时无法渲染', () => {
    expect(mindDataFromTree(readTree(createMap()))).toBeNull();
  });
});
