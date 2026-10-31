import { useEffect, useState } from 'react';
import type { DocMember, DocRole } from '@lingshu/shared';
import { getCurrentUser, inviteMember, listMembers, removeMember } from '../lib/api';

const ROLE_LABEL: Record<DocRole, string> = {
  owner: '所有者',
  editor: '可编辑',
  spectator: '只读',
};

interface MemberPanelProps {
  docId: string;
  role: DocRole;
}

/**
 * 最小 ACL 面板：成员可查看，仅 owner 可邀请/移除。
 * 邀请按邮箱匹配已注册账号；移除后由 API 发事件，协同分片会立即断开其连接。
 */
export function MemberPanel({ docId, role }: MemberPanelProps) {
  const me = getCurrentUser();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<DocMember[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<DocRole, 'owner'>>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listMembers(docId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [docId]);

  const isOwner = role === 'owner';

  async function handleInvite(): Promise<void> {
    if (!email.trim()) return;
    setBusy(true);
    setError('');
    try {
      setMembers(await inviteMember(docId, email.trim(), inviteRole));
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '邀请失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(member: DocMember): Promise<void> {
    setBusy(true);
    setError('');
    try {
      setMembers(await removeMember(docId, member.userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen((value) => !value)}>成员（{members.length}）</button>
      {open ? (
        <div className="member-overlay" onClick={() => setOpen(false)}>
          <aside className="member-panel" onClick={(event) => event.stopPropagation()}>
            <header className="member-header">
              <strong>文档成员</strong>
              <button className="link-button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </header>

            {error ? <p className="error">{error}</p> : null}

            {isOwner ? (
              <div className="member-invite">
                <input
                  type="email"
                  placeholder="输入已注册的邮箱"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as Exclude<DocRole, 'owner'>)}
                >
                  <option value="editor">可编辑</option>
                  <option value="spectator">只读</option>
                </select>
                <button className="primary" disabled={busy} onClick={() => void handleInvite()}>
                  邀请
                </button>
              </div>
            ) : null}

            <ul className="member-list">
              {members.map((member) => (
                <li key={member.userId} className="member-item">
                  <div>
                    <span className="member-name">
                      {member.displayName}
                      {member.userId === me?.id ? '（我）' : ''}
                    </span>
                    <span className="muted"> {member.email}</span>
                  </div>
                  <div className="member-actions">
                    <span className="doc-role">{ROLE_LABEL[member.role]}</span>
                    {isOwner && member.role !== 'owner' ? (
                      <button disabled={busy} onClick={() => void handleRemove(member)}>
                        移除
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      ) : null}
    </>
  );
}
