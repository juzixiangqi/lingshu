import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocDetail, DocKind, SessionUser } from '@lingshu/shared';
import { createDoc, fetchMe, getCurrentUser, getToken, listDocs, logout } from '../lib/api';
import { DOC_TEMPLATES, isContentTemplate, type DocTemplate } from '../lib/docTemplates';
import { DEFAULT_DOC_ICON } from '../lib/docIcons';
import { NotificationBell } from '../components/NotificationBell';

const KIND_LABEL: Record<DocKind, string> = {
  doc: '笺 · 文档',
  sheet: '筹 · 表格',
  mindmap: '图 · 导图',
};

function docPath(doc: Pick<DocDetail, 'id' | 'kind'>): string {
  if (doc.kind === 'sheet') return `/sheet/${doc.id}`;
  if (doc.kind === 'mindmap') return `/mind/${doc.id}`;
  return `/doc/${doc.id}`;
}

const ROLE_LABEL: Record<DocDetail['role'], string> = {
  owner: '所有者',
  editor: '可编辑',
  spectator: '只读',
};

/** 列表里的“最近更新”用本地时间展示，与飞书文档列表保持一致的心智。 */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function DocListPage() {
  const navigate = useNavigate();
  // IM 入口只带 token，用户信息需要向服务端补拉一次
  const [user, setUser] = useState<SessionUser | null>(getCurrentUser());
  const [docs, setDocs] = useState<DocDetail[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);

  const keyword = query.trim().toLowerCase();
  // 标题或类型都能命中，避免用户记不住“笺/筹/图”的分类名
  const filtered = keyword
    ? docs.filter(
        (doc) => doc.title.toLowerCase().includes(keyword) || KIND_LABEL[doc.kind].includes(keyword),
      )
    : docs;

  async function refresh(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      setDocs(await listDocs());
    } catch (err) {
      if (!getToken()) {
        navigate('/login', { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    if (!getCurrentUser()) {
      void fetchMe()
        .then(setUser)
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!templateOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTemplateOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [templateOpen]);

  /**
   * 新建：选择模板时顺带写入默认标题与封面图标；
   * 有正文的模板通过 ?template= 交给编辑器在空文档上写一次。
   */
  async function handleCreate(kind: DocKind, template?: DocTemplate): Promise<void> {
    try {
      const doc = template?.title
        ? await createDoc(kind, { title: template.title, icon: template.icon })
        : await createDoc(kind);
      if (template && isContentTemplate(template)) {
        navigate(`${docPath(doc)}?template=${template.id}`);
        return;
      }
      navigate(docPath(doc));
    } catch (err) {
      if (!getToken()) {
        navigate('/login', { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : '创建失败');
    }
  }

  function handleLogout(): void {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>灵枢协同办公套件</h1>
          <p className="muted">
            当前身份：{user ? `${user.displayName}（${user.email}）` : '未登录'}
          </p>
        </div>
        <div className="actions">
          <NotificationBell />
          <button onClick={handleLogout}>退出登录</button>
          <button className="primary" onClick={() => setTemplateOpen(true)}>
            新建文档
          </button>
          <button className="primary" onClick={() => void handleCreate('sheet')}>
            新建表格
          </button>
          <button className="primary" onClick={() => void handleCreate('mindmap')}>
            新建导图
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="doc-search">
        <input
          type="search"
          className="doc-search-input"
          placeholder="搜索标题或类型"
          aria-label="搜索文档"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="muted">
          {keyword ? `匹配 ${filtered.length} / ${docs.length} 篇` : `共 ${docs.length} 篇`}
        </span>
      </div>

      {loading ? <p className="muted">加载中…</p> : null}

      <ul className="doc-list">
        {filtered.map((doc) => (
          <li key={doc.id} className="doc-item">
            <button
              className="doc-link"
              onClick={() => navigate(docPath(doc))}
            >
              <span className="doc-icon">{doc.icon || DEFAULT_DOC_ICON[doc.kind]}</span>
              <span className="doc-kind">{KIND_LABEL[doc.kind]}</span>
              <span className="doc-title">{doc.title}</span>
              <span className="doc-role">{ROLE_LABEL[doc.role]}</span>
            </button>
            <span className="muted doc-meta">
              {formatUpdatedAt(doc.updatedAt)} 更新 · 分片 {doc.collab.url}
            </span>
          </li>
        ))}
      </ul>

      {!loading && filtered.length === 0 && !error ? (
        <p className="muted">{docs.length === 0 ? '还没有文档，先新建一篇。' : '没有匹配的文档。'}</p>
      ) : null}

      {templateOpen ? (
        <div className="doc-template-overlay" onClick={() => setTemplateOpen(false)}>
          <div
            className="doc-template-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="选择文档模板"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="doc-template-header">
              <div>
                <h2>新建文档</h2>
                <p className="muted">选个模板先把结构搭好，之后随时可以改。</p>
              </div>
              <button type="button" onClick={() => setTemplateOpen(false)}>
                关闭
              </button>
            </header>
            <div className="doc-template-grid">
              {DOC_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="doc-template-card"
                  onClick={() => {
                    setTemplateOpen(false);
                    void handleCreate('doc', template);
                  }}
                >
                  <span className="doc-template-icon">{template.icon}</span>
                  <span className="doc-template-label">{template.label}</span>
                  <span className="doc-template-desc">{template.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
