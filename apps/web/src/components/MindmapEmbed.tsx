import { useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

/**
 * 文档内的导图卡片。
 * 抽屉里用 iframe 打开导图页的嵌入模式（?embed=1），复用现有协同编辑与渲染逻辑，
 * 卡片本身只同步 id / 标题 / 图标，不复制导图数据。
 */
export function MindmapEmbedView({ node, editor, deleteNode, selected }: NodeViewProps) {
  const docId = String(node.attrs.docId ?? '');
  const title = String(node.attrs.title ?? '思维导图');
  const icon = node.attrs.icon ? String(node.attrs.icon) : '🧠';
  const [open, setOpen] = useState(false);

  return (
    <NodeViewWrapper
      className={selected ? 'doc-mindmap-card selected' : 'doc-mindmap-card'}
      contentEditable={false}
    >
      <button
        type="button"
        className="doc-mindmap-open"
        disabled={!docId}
        onClick={() => docId && setOpen(true)}
      >
        <span className="doc-mindmap-icon">{icon}</span>
        <span className="doc-mindmap-info">
          <span className="doc-mindmap-title">{title}</span>
          <span className="doc-mindmap-meta">思维导图 · 点击打开编辑</span>
        </span>
        <span className="doc-mindmap-action">打开</span>
      </button>
      {editor.isEditable ? (
        <button
          type="button"
          className="doc-mindmap-remove"
          title="从正文移除（不会删除原导图）"
          onClick={() => deleteNode()}
        >
          移除
        </button>
      ) : null}

      {open ? (
        <div className="mindmap-embed-overlay" onClick={() => setOpen(false)}>
          <aside className="mindmap-embed-drawer" onClick={(event) => event.stopPropagation()}>
            <header className="mindmap-embed-header">
              <span className="mindmap-embed-heading">
                {icon} {title}
              </span>
              <a className="link-button" href={`/mind/${docId}`} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
              <button type="button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </header>
            <iframe className="mindmap-embed-frame" title={title} src={`/mind/${docId}?embed=1`} />
          </aside>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
