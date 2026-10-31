import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { LIMITS, type DocDetail, type DocRole } from '@lingshu/shared';
import { getCurrentUser, getDoc, getToken } from '../lib/api';
import { connectDocument, destroySession, type CollabSession } from '../lib/collab';
import { useSaveStatus } from '../lib/saveStatus';
import { MemberPanel } from '../components/MemberPanel';

const ROLE_LABEL: Record<DocRole, string> = {
  owner: '所有者',
  editor: '可编辑',
  spectator: '只读',
};

/** 超限拦截时广播给 UI，用于提示本次输入被拦截（不改写 ProseMirror 状态）。 */
const LIMIT_EVENT = 'lingshu:doc-limit';

/**
 * 单文档字数上限（8 万字）。达到上限后拦截继续输入的本地事务，引导拆分。
 * 远端协同事务与撤销事务必须放行，否则多端内容会在上限边界处无法收敛。
 */
const CharLimit = Extension.create({
  name: 'charLimit',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => {
          if (!transaction.docChanged) return true;
          if (transaction.getMeta('y-sync') || transaction.getMeta('addToHistory') === false) return true;
          if (transaction.doc.textContent.length <= LIMITS.maxDocChars) return true;
          window.dispatchEvent(new Event(LIMIT_EVENT));
          return false;
        },
      }),
    ];
  },
});

interface EditorProps {
  detail: DocDetail;
  session: CollabSession;
}

/**
 * 文档协同：TipTap + Yjs，正文走 `<docId>/body` 单个 Y.Doc。
 * spectator 不渲染远端光标（不订阅 awareness），与适配层的一致治理规则对齐。
 */
function CollabEditor({ detail, session }: EditorProps) {
  const user = getCurrentUser();
  const editable = detail.role !== 'spectator';

  const editor = useEditor(
    {
      editable,
      extensions: [
        // 协同模式下撤销由 Yjs 的 UndoManager 负责，关闭本地历史
        StarterKit.configure({ undoRedo: false }),
        CharLimit,
        Collaboration.configure({ document: session.doc }),
        ...(editable
          ? [
              CollaborationCaret.configure({
                provider: session.provider,
                user: { name: user?.displayName ?? '匿名', color: '#2f6fed' },
              }),
            ]
          : []),
      ],
      editorProps: {
        attributes: { class: 'editor-surface' },
      },
    },
    [session, editable, user?.displayName],
  );

  const [chars, setChars] = useState(0);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!editor) return;
    const update = () => setChars(editor.getText().length);
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  // 用户继续输入/粘贴导致超限时，给出即时反馈并引导拆分
  useEffect(() => {
    let timer: number | undefined;
    const onBlocked = (): void => {
      setBlocked(true);
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setBlocked(false), 4_000);
    };
    window.addEventListener(LIMIT_EVENT, onBlocked);
    return () => {
      window.removeEventListener(LIMIT_EVENT, onBlocked);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  /**
   * awareness 治理（客户端两层）：
   * - 范围：光标在视口外时不广播，滚动进入后由下一次移动触发上报；
   * - 频率：光标广播按 LIMITS.cursorBroadcastIntervalMs 节流（尾帧补发，避免停在旧位置）。
   * 服务端还会再做一次数量上限与角色分层，客户端治理只是第一道闸。
   */
  useEffect(() => {
    const awareness = session.provider.awareness;
    if (!editor || !awareness || !editable) return;

    const send = awareness.setLocalStateField.bind(awareness);
    let lastSentAt = 0;
    let pending: { anchor: number; head: number } | null = null;
    let timer: number | undefined;

    const inViewport = (position: { anchor: number; head: number }): boolean => {
      try {
        const line = editor.view.coordsAtPos(position.head);
        const box = editor.view.dom.getBoundingClientRect();
        // 上下各留 200px 缓冲，减少滚动时的抖动
        return line.top >= box.top - 200 && line.bottom <= box.bottom + 200;
      } catch {
        return false;
      }
    };

    const flush = (): void => {
      timer = undefined;
      if (!pending) return;
      lastSentAt = Date.now();
      send('cursor', pending);
    };

    awareness.setLocalStateField = (field: string, value: unknown) => {
      if (field !== 'cursor') {
        send(field, value);
        return;
      }
      pending = value as { anchor: number; head: number };
      if (!inViewport(pending)) return;
      const now = Date.now();
      if (now - lastSentAt >= LIMITS.cursorBroadcastIntervalMs) {
        lastSentAt = now;
        send('cursor', pending);
        return;
      }
      if (timer === undefined) {
        timer = window.setTimeout(flush, LIMITS.cursorBroadcastIntervalMs - (now - lastSentAt));
      }
    };

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      awareness.setLocalStateField = send;
    };
  }, [editor, editable, session]);

  const atLimit = chars >= LIMITS.maxDocChars;

  return (
    <>
      <div className="editor-status">
        <span className={atLimit ? 'error' : 'muted'}>
          {chars} / {LIMITS.maxDocChars} 字
        </span>
        {atLimit ? (
          <span className="error">已达单文档上限，继续输入会被拦截；请拆分为多篇（一期不支持自动分片）</span>
        ) : null}
        {blocked ? (
          <span className="error">本次输入超出 8 万字上限，已拦截；请拆分为多篇</span>
        ) : null}
      </div>
      <EditorContent editor={editor} />
    </>
  );
}

export function DocEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState('连接中');
  const [error, setError] = useState('');
  const save = useSaveStatus(id, session);

  useEffect(() => {
    let cancelled = false;
    let created: CollabSession | null = null;

    void (async () => {
      try {
        const doc = await getDoc(id);
        if (cancelled) return;
        setDetail(doc);

        const documentName = doc.collab.documentNames[0];
        if (!documentName) throw new Error('文档缺少协同目标');

        created = connectDocument(doc, documentName);
        created.provider.on('status', (event: { status: string }) => setStatus(event.status));
        created.provider.on('synced', () => setStatus('已同步'));
        if (!cancelled) setSession(created);
      } catch (err) {
        if (cancelled) return;
        if (!getToken()) {
          navigate('/login', { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : '打开文档失败');
      }
    })();

    return () => {
      cancelled = true;
      if (created) destroySession(created);
    };
  }, [id]);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>{detail?.title ?? '文档'}</h1>
          <p className="muted">
            {detail ? `${ROLE_LABEL[detail.role]} · ${status} · ${save.text}` : '加载中…'}
          </p>
        </div>
        <div className="actions">
          {detail ? <MemberPanel docId={detail.id} role={detail.role} /> : null}
          <button onClick={() => navigate('/')}>返回列表</button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <main className="editor-shell">
        {detail && session ? <CollabEditor detail={detail} session={session} /> : null}
      </main>
    </div>
  );
}
