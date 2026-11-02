import { Mark } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

/**
 * 划词评论锚点。作为协同 Mark 写进正文 Y.Doc：
 * - 位置随协同编辑自动迁移，多端即时收敛，无需相对位置换算；
 * - commentId 与 doc_comments 表主键一致，面板按 id 对照；
 * - 对应文本被删除后锚点自然消失，面板侧标记为“原文已删除”。
 */
export const CommentMark = Mark.create({
  name: 'commentMark',
  // 不包裹后续输入，也不与其他 commentMark 重叠（一段文本只属于一条评论）
  inclusive: false,
  excludes: 'commentMark',

  addAttributes() {
    return {
      commentId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      { 'data-comment-id': HTMLAttributes.commentId as string, class: 'doc-comment' },
      0,
    ];
  },
});

/** 正文中现存的所有评论锚点 id，用于识别“原文已删除”的评论。 */
export function collectCommentIds(editor: Editor): Set<string> {
  const ids = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'commentMark' && typeof mark.attrs.commentId === 'string') {
        ids.add(mark.attrs.commentId);
      }
    }
  });
  return ids;
}

/** 精确移除某一条评论的锚点（同段文本上可能有其他评论，必须逐段移除）。 */
export function removeCommentAnchor(editor: Editor, commentId: string): void {
  const ranges: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const hit = node.marks.some(
      (mark) => mark.type.name === 'commentMark' && mark.attrs.commentId === commentId,
    );
    if (hit) ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  if (!ranges.length) return;
  const markType = editor.state.schema.marks.commentMark;
  const tr = editor.state.tr;
  for (const range of ranges) tr.removeMark(range.from, range.to, markType);
  editor.view.dispatch(tr);
}

/** 面板点击评论时，把选区落到锚点首段上，触发编辑器滚动定位。 */
export function revealCommentAnchor(editor: Editor, commentId: string): boolean {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isText) return;
    const hit = node.marks.some(
      (mark) => mark.type.name === 'commentMark' && mark.attrs.commentId === commentId,
    );
    if (hit) {
      from = pos;
      to = pos + node.nodeSize;
    }
  });
  if (from < 0) return false;
  editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
  return true;
}
