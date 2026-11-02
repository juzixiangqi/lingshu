import { useEffect, useState } from 'react';
import type { DocSummary } from '@lingshu/shared';
import { createDoc, listDocs } from '../lib/api';
import { DEFAULT_DOC_ICON } from '../lib/docIcons';

interface InsertMindmapDialogProps {
  open: boolean;
  onClose: () => void;
  /** 选中已有导图或新建完成后回调，由工具条负责插入块 */
  onPick: (doc: DocSummary) => void;
}

/**
 * 插入导图：列出可访问的导图文档，支持搜索与就地新建。
 * 新建后正文只插入引用卡片，导图本身仍出现在文档列表里。
 */
export function InsertMindmapDialog({ open, onClose, onPick }: InsertMindmapDialogProps) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const list = await listDocs();
        if (cancelled) return;
        setDocs(list.filter((doc) => doc.kind === 'mindmap'));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载导图失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = keyword.trim()
    ? docs.filter((doc) => doc.title.toLowerCase().includes(keyword.trim().toLowerCase()))
    : docs;

  const createAndPick = async (): Promise<void> => {
    setCreating(true);
    setError('');
    try {
      const doc = await createDoc('mindmap');
      setDocs((prev) => [doc, ...prev]);
      onPick(doc);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建导图失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="doc-template-overlay" onClick={onClose}>
      <div
        className="doc-template-dialog insert-mindmap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="插入思维导图"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="doc-template-header">
          <div>
            <h2>插入思维导图</h2>
            <p className="muted">选择已有导图，或在正文里新建一张。</p>
          </div>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="insert-mindmap-search">
          <input
            type="search"
            placeholder="搜索导图标题"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            autoFocus
          />
          <button type="button" className="primary" disabled={creating} onClick={() => void createAndPick()}>
            {creating ? '新建中…' : '＋ 新建导图'}
          </button>
        </div>

        {error ? <p className="error">{error}</p> : null}

        {loading ? (
          <p className="muted">加载中…</p>
        ) : filtered.length === 0 ? (
          <p className="muted">{docs.length === 0 ? '还没有导图，点右上角新建一张。' : '没有匹配的导图。'}</p>
        ) : (
          <ul className="insert-mindmap-list">
            {filtered.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  className="insert-mindmap-item"
                  onClick={() => {
                    onPick(doc);
                    onClose();
                  }}
                >
                  <span>{doc.icon || DEFAULT_DOC_ICON.mindmap}</span>
                  <span className="insert-mindmap-title">{doc.title}</span>
                  <span className="muted">{doc.role === 'spectator' ? '只读' : '可编辑'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
