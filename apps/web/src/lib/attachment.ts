import { Node } from '@tiptap/core';

/**
 * 附件节点：正文只存对象 URL 与展示信息，二进制在 MinIO。
 * 点击链接直接下载，不做内嵌预览（一期范围）。
 */
export const DocAttachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      name: { default: '附件' },
      size: { default: 0 },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-doc-attachment]',
        getAttrs: (element) => {
          const anchor = element as HTMLElement;
          return {
            src: anchor.getAttribute('href'),
            name: anchor.getAttribute('data-name') ?? anchor.textContent ?? '附件',
            size: Number(anchor.getAttribute('data-size') ?? 0),
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const name = String(node.attrs.name ?? '附件');
    return [
      'a',
      {
        class: 'doc-attachment',
        href: node.attrs.src,
        download: name,
        target: '_blank',
        rel: 'noopener noreferrer',
        'data-doc-attachment': 'true',
        'data-name': name,
        'data-size': String(node.attrs.size ?? 0),
      },
      name,
    ];
  },
});
