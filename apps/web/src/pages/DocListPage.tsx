import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocDetail, DocKind } from '@lingshu/shared';
import {
  createDoc,
  ensureSession,
  getCurrentUser,
  listDocs,
  switchIdentity,
} from '../lib/api';

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
  const [docs, setDocs] = useState<DocDetail[]>([]);
  const [userName, setUserName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const user = await ensureSession();
      setUserName(user.displayName);
      setDocs(await listDocs());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(kind: DocKind): Promise<void> {
    try {
      const doc = await createDoc(kind);
      navigate(kind === 'sheet' ? `/sheet/${doc.id}` : `/doc/${doc.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  }

  async function handleSwitch(): Promise<void> {
    await switchIdentity();
    await refresh();
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>灵枢协同办公套件</h1>
          <p className="muted">
            当前身份：{userName || getCurrentUser()?.displayName || '未登录'}
          </p>
        </div>
        <div className="actions">
          <button onClick={() => void handleSwitch()}>切换身份</button>
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
