import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MindmapEmbedView } from '../components/MindmapEmbed';

export interface EmbeddedMindmapAttrs {
  /** 导图文档 id，卡片只保存引用，导图数据仍在自己的 Y.Doc 里 */
  docId: string;
  title: string;
  icon: string | null;
}

/**
 * 文档内嵌思维导图：atom 块节点，正文只存 id + 标题/图标快照，
 * 点击卡片在右侧抽屉打开原导图编辑，避免把导图数据复制进文档。
 */
export const EmbeddedMindmap = Node.create({
  name: 'embeddedMindmap',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      docId: { default: '' },
      title: { default: '思维导图' },
      icon: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-mindmap-id]',
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return {
            docId: el.getAttribute('data-mindmap-id') ?? '',
            title: el.getAttribute('data-mindmap-title') ?? '思维导图',
            icon: el.getAttribute('data-mindmap-icon') || null,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-mindmap-id': node.attrs.docId,
        'data-mindmap-title': node.attrs.title,
        'data-mindmap-icon': node.attrs.icon ?? '',
        class: 'doc-mindmap-embed',
      }),
      `${node.attrs.icon ?? '🧠'} ${node.attrs.title}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MindmapEmbedView);
  },
});
