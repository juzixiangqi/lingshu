import { useCallback, useEffect, useState } from 'react';
import type { DocRole, DocVersion, DocVersionSnapshot } from '@lingshu/shared';
import { fetchVersionSnapshot, listVersions } from '../lib/api';

const PRECISION_LABEL = {
  content: '内容级',
  snapshot: '快照级',
} as const;

const PRECISION_HINT = {
  content: '7 天内：可恢复到该快照时刻的完整内容',
  snapshot: '超出 7 天：仅保留快照级回滚',
} as const;

interface VersionPanelProps {
  docId: string;
  role: DocRole;
  /** 把快照内容写回当前协同文档；文档与表格由各自页面实现。 */
  onRestore: (snapshot: DocVersionSnapshot) => Promise<void>;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 版本历史面板。
 * 列表来自快照历史表；精度按 op 流保留窗口标注，不承诺 7 天以外的逐字回滚。
 */
export function VersionPanel({ docId, role, onRestore }: VersionPanelProps) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setVersions(await listVersions(docId));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '版本列表获取失败');
    }
  }, [docId]);

  useEffect(() => {
    void listVersions(docId)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [docId]);

  const writable = role !== 'spectator';

  async function handleRestore(version: DocVersion): Promise<void> {
    const confirmed = window.confirm(
      `恢复到 ${formatTime(version.createdAt)} 的版本？\n当前内容会被替换，在线成员会同步看到结果。`,
    );
    if (!confirmed) return;

    setBusyId(version.id);
    setError('');
    setNotice('');
    try {
      const snapshot = await fetchVersionSnapshot(docId, version.id);
      await onRestore(snapshot);
      setNotice(`已恢复到版本 #${version.version}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen((value) => !value);
          void refresh();
        }}
      >
        版本历史（{versions.length}）
      </button>
      {open ? (
        <div className="member-overlay" onClick={() => setOpen(false)}>
          <aside className="member-panel" onClick={(event) => event.stopPropagation()}>
            <header className="member-header">
              <strong>版本历史</strong>
              <button className="link-button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </header>

            <p className="muted">
              每 30 秒或 500 次更新落一次快照。7 天内为内容级回滚，超出窗口仅保留每日快照。
            </p>

            {error ? <p className="error">{error}</p> : null}
            {notice ? <p className="muted">{notice}</p> : null}

            {versions.length === 0 ? (
              <p className="muted">暂无历史版本，首次自动保存后会出现。</p>
            ) : (
              <ul className="member-list">
                {versions.map((version) => (
                  <li key={version.id} className="member-item">
                    <div>
                      <span className="member-name">版本 #{version.version}</span>
                      <span className="muted"> {formatTime(version.createdAt)}</span>
                    </div>
                    <div className="member-actions">
                      <span className="doc-role" title={PRECISION_HINT[version.precision]}>
                        {PRECISION_LABEL[version.precision]}
                      </span>
                      {writable ? (
                        <button
                          disabled={busyId !== ''}
                          onClick={() => void handleRestore(version)}
                        >
                          {busyId === version.id ? '恢复中…' : '恢复'}
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      ) : null}
    </>
  );
}
