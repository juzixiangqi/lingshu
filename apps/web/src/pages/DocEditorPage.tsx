import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Mention from '@tiptap/extension-mention';
import * as Y from 'yjs';
import { LIMITS, type DocDetail, type DocMember, type DocRole, type DocVersionSnapshot } from '@lingshu/shared';
import { getCurrentUser, getDoc, getToken, listMembers, notifyMention } from '../lib/api';
import {
  collabStatusLabel,
  connectDocument,
  decodeSnapshot,
  destroySession,
  type CollabSession,
} from '../lib/collab';
import { createMentionExtension } from '../lib/mention';
import { useSaveStatus } from '../lib/saveStatus';
import { MemberPanel } from '../components/MemberPanel';
import { NotificationBell } from '../components/NotificationBell';
import { VersionPanel } from '../components/VersionPanel';

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

type RestoreHandler = (snapshot: DocVersionSnapshot) => Promise<void>;

interface EditorProps {
  detail: DocDetail;
  session: CollabSession;
  /** 把版本恢复能力注册给页面顶栏的版本面板。 */
  registerRestore: (handler: RestoreHandler | null) => void;
}

/**
 * 文档协同：TipTap + Yjs，正文走 `<docId>/body` 单个 Y.Doc。
 * spectator 不渲染远端光标（不订阅 awareness），与适配层的一致治理规则对齐。
 */
function CollabEditor({ detail, session, registerRestore }: EditorProps) {
  const user = getCurrentUser();
  const editable = detail.role !== 'spectator';

  // 成员列表用 ref 保存：@提及 候选取自这里，成员刷新时不必重建编辑器
  const membersRef = useRef<DocMember[]>([]);
  useEffect(() => {
    void listMembers(detail.id)
      .then((members) => {
        // 不给自己弹出候选：服务端也会过滤，避免误发通知
        membersRef.current = members.filter((member) => member.userId !== user?.id);
      })
      .catch(() => {
        membersRef.current = [];
      });
  }, [detail.id, user?.id]);

  /**
   * 所有角色都要注册 mention 节点：只读成员虽然不能输入，但正文里已有的提及必须能解析，
   * 否则旁观端打开文档会丢内容。候选弹窗只对可写角色挂。
   */
  const mention = editable
    ? createMentionExtension({
        getMembers: () => membersRef.current,
        onMention: (member, excerpt) => {
          void notifyMention(detail.id, [member.userId], excerpt).catch(() => {
            // 通知失败不影响编辑本身，站内通知由其他端重试
          });
        },
      })
    : Mention.configure({ HTMLAttributes: { class: 'doc-mention' } });

  const editor = useEditor(
    {
      editable,
      extensions: [
        // 协同模式下撤销由 Yjs 的 UndoManager 负责，关闭本地历史
        StarterKit.configure({ undoRedo: false }),
        CharLimit,
        Collaboration.configure({ document: session.doc }),
        mention,
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
    [session, editable, user?.displayName, detail.id],
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

  useEffect(() => {
    if (!editor) {
      registerRestore(null);
      return;
    }
    /**
     * 版本恢复：把历史快照先还原成一个临时协同编辑器，取其 ProseMirror JSON，
     * 再通过 setContent 写回当前编辑器。这样删除与插入都走正常协同事务，
     * 在线成员无需重连即可收敛；直接改写 Y.Doc 反而无法表达删除后重新插入。
     */
    registerRestore(async (snapshot) => {
      if (snapshot.documentName !== session.documentName) {
        throw new Error('该版本不属于当前文档');
      }
      const restored = new Y.Doc();
      Y.applyUpdate(restored, decodeSnapshot(snapshot.base64));
      // 临时编辑器挂在一个游离节点上，只为复用 y-sync 的 Y.Doc → JSON 转换
      const temp = new Editor({
        element: document.createElement('div'),
        extensions: [
          StarterKit.configure({ undoRedo: false }),
          // 历史版本里可能含 @提及 节点，临时编辑器也要注册，否则转换时会丢节点
          Mention.configure({ HTMLAttributes: { class: 'doc-mention' } }),
          Collaboration.configure({ document: restored }),
        ],
      });
      try {
        editor.commands.setContent(temp.getJSON());
      } finally {
        temp.destroy();
        restored.destroy();
      }
    });
    return () => registerRestore(null);
  }, [editor, session, registerRestore]);

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

  // 版本面板与编辑器解耦：编辑器就绪后把自己的恢复实现注册进来
  const restoreRef = useRef<RestoreHandler | null>(null);
  const registerRestore = useCallback((handler: RestoreHandler | null) => {
    restoreRef.current = handler;
  }, []);

  const restore = useCallback(async (snapshot: DocVersionSnapshot) => {
    const handler = restoreRef.current;
    if (!handler) throw new Error('编辑器尚未就绪，请稍后重试');
    await handler(snapshot);
  }, []);

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
        created.provider.on('status', (event: { status: string }) => {
          setStatus(collabStatusLabel(event.status));
          // M1 验收：以 WebSocket 连接建立为起点，统计“同步 + 解析正文”的客户端耗时
          if (import.meta.env.DEV && event.status === 'connected') {
            const scope = window as unknown as Record<string, unknown>;
            if (!scope.__lingshuDocConnectedAt) scope.__lingshuDocConnectedAt = performance.now();
          }
        });
        /**
         * 服务端用 CLOSE 消息关闭“文档连接”时（成员被移除/降权），WebSocket 本身仍然开着，
         * 状态事件不会变成 disconnected。不显式处理的话界面会一直显示“已同步”，
         * 而实际编辑已经不再广播。
         */
        created.provider.on('close', ({ event }: { event?: { code?: number } }) => {
          if (event?.code !== 1000) return;
          setStatus('已被移出本文档');
          setError('你已不在该文档的协作成员中，本地编辑不会再同步');
        });
        created.provider.on('synced', () => {
          setStatus('已同步');
          if (import.meta.env.DEV) {
            const scope = window as unknown as Record<string, unknown>;
            if (!scope.__lingshuDocSyncAt) scope.__lingshuDocSyncAt = performance.now();
          }
        });
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
          <NotificationBell />
          {detail ? <VersionPanel docId={detail.id} role={detail.role} onRestore={restore} /> : null}
          {detail ? <MemberPanel docId={detail.id} role={detail.role} /> : null}
          <button onClick={() => navigate('/')}>返回列表</button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <main className="editor-shell">
        {detail && session ? (
          <CollabEditor detail={detail} session={session} registerRestore={registerRestore} />
        ) : null}
      </main>
    </div>
  );
}
