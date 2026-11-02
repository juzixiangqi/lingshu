import { mergeAttributes, Node } from '@tiptap/core';

/**
 * 正文图片节点：只保留 src / alt。
 * 上传由工具栏走预签名直传，正文只存对象 URL，不携带二进制。
 */
export const DocImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },
});
