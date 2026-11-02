import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface FindState {
  term: string;
  /** 当前命中序号，-1 表示没有命中 */
  active: number;
}

export const EMPTY_FIND: FindState = { term: '', active: -1 };

export const FIND_KEY = new PluginKey<FindState>('docFind');

/**
 * 在文本块内做大小写不敏感的子串匹配。
 *
 * 逐文本块拼接内容并记录每个字符的文档位置，这样关键词跨 mark（如“协同”加粗、
 * “编辑”正常）时也能命中；跨段落的匹配不处理，避免把块结构边界算进正文。
 */
export function findMatches(doc: PMNode, term: string): Array<{ from: number; to: number }> {
  const needle = term.trim().toLowerCase();
  const matches: Array<{ from: number; to: number }> = [];
  if (!needle) return matches;

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const start = pos + 1 + offset;
      const value = child.text ?? '';
      for (let index = 0; index < value.length; index += 1) {
        positions.push(start + index);
        text += value[index];
      }
    });
    const haystack = text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const from = positions[index];
      const to = positions[index + needle.length - 1];
      if (from !== undefined && to !== undefined) matches.push({ from, to: to + 1 });
      index = haystack.indexOf(needle, index + needle.length);
    }
    // 文本块内部已经整体处理，不再深入子节点
    return false;
  });

  return matches;
}

/** 把查找状态写入插件，装饰与计数都跟随它更新。 */
export function setFindState(editor: Editor, term: string, active: number): void {
  editor.view.dispatch(editor.state.tr.setMeta(FIND_KEY, { term, active }));
}

/** 关闭查找：清空关键词与高亮。 */
export function clearFind(editor: Editor): void {
  setFindState(editor, '', -1);
}

/**
 * 查找高亮扩展：命中项打 `doc-find-hit`，当前项额外带 `doc-find-hit-active`。
 * 装饰是纯视图层，不写入 Y.Doc，因此不会污染协同内容，也不会被其他端持久化。
 */
export function createFindExtension() {
  return Extension.create({
    name: 'docFind',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: FIND_KEY,
          state: {
            init: () => EMPTY_FIND,
            apply(transaction, value) {
              const meta = transaction.getMeta(FIND_KEY) as FindState | undefined;
              return meta ?? value;
            },
          },
          props: {
            decorations(state) {
              const current = FIND_KEY.getState(state) ?? EMPTY_FIND;
              if (!current.term) return DecorationSet.empty;
              const matches = findMatches(state.doc, current.term);
              return DecorationSet.create(
                state.doc,
                matches.map((match, index) =>
                  Decoration.inline(match.from, match.to, {
                    class: index === current.active ? 'doc-find-hit doc-find-hit-active' : 'doc-find-hit',
                  }),
                ),
              );
            },
          },
        }),
      ];
    },
  });
}
