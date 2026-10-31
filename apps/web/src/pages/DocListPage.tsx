import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocDetail, DocKind, SessionUser } from '@lingshu/shared';
import { createDoc, fetchMe, getCurrentUser, getToken, listDocs, logout } from '../lib/api';
import { NotificationBell } from '../components/NotificationBell';

const KIND_LABEL: Record<DocKind, string> = {
  doc: '笺 · 文档',
  sheet: '筹 · 表格',
};

const ROLE_LABEL: Record<DocDetail['role'], string> = {
  owner: '所有者',
  editor: '可编辑',
  spectator: '只读',
};

export function DocListPage() {
  const navigate = useNavigate();
  // IM 入口只带 token，用户信息需要向服务端补拉一次
  const [user, setUser] = useState<SessionUser | null>(getCurrentUser());
  const [docs, setDocs] = useState<DocDetail[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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

  async function handleCreate(kind: DocKind): Promise<void> {
    try {
      const doc = await createDoc(kind);
      navigate(kind === 'sheet' ? `/sheet/${doc.id}` : `/doc/${doc.id}`);
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
          <button className="primary" onClick={() => void handleCreate('doc')}>
            新建文档
          </button>
          <button className="primary" onClick={() => void handleCreate('sheet')}>
            新建表格
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">加载中…</p> : null}

      <ul className="doc-list">
        {docs.map((doc) => (
          <li key={doc.id} className="doc-item">
            <button
              className="doc-link"
              onClick={() => navigate(doc.kind === 'sheet' ? `/sheet/${doc.id}` : `/doc/${doc.id}`)}
            >
              <span className="doc-kind">{KIND_LABEL[doc.kind]}</span>
              <span className="doc-title">{doc.title}</span>
              <span className="doc-role">{ROLE_LABEL[doc.role]}</span>
            </button>
            <span className="muted doc-meta">
              分片 {doc.collab.url} · {doc.collab.documentNames.join(' / ')}
            </span>
          </li>
        ))}
      </ul>

      {!loading && docs.length === 0 && !error ? (
        <p className="muted">还没有文档，先新建一篇。</p>
      ) : null}
    </div>
  );
}
