import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { Editor, Extension } from '@tiptap/core';
import { Highlight } from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { TextAlign } from '@tiptap/extension-text-align';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Mention from '@tiptap/extension-mention';
import * as Y from 'yjs';
import { LIMITS, type DocDetail, type DocMember, type DocRole, type DocVersionSnapshot } from '@lingshu/shared';
import {
  getCurrentUser,
  getDoc,
  getToken,
  listMembers,
  notifyMention,
  renameDoc,
  updateDocIcon,
  uploadDocImage,
} from '../lib/api';
import {
  collabStatusLabel,
  connectDocument,
  decodeSnapshot,
  destroySession,
  type CollabSession,
} from '../lib/collab';
import { createMentionExtension } from '../lib/mention';
import { createSlashExtension } from '../lib/slash';
import { DocAttachment } from '../lib/attachment';
import { DocImage } from '../lib/image';
import { EmbeddedMindmap } from '../lib/embedMindmap';
import { CommentMark, removeCommentAnchor } from '../lib/commentMark';
import { createFindExtension } from '../lib/find';
import { findDocTemplate, isContentTemplate, type DocTemplate } from '../lib/docTemplates';
import { useSaveStatus } from '../lib/saveStatus';
import { DocFormatMenu, DocTableMenu, DocToolbar } from '../components/DocToolbar';
import { DocFindBar } from '../components/DocFindBar';
import { DocIconPicker } from '../components/DocIconPicker';
import { BlockHandle } from '../components/BlockHandle';
import { CommentPanel, type CommentDraft } from '../components/CommentPanel';
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

/**
 * 正文基础扩展：在线编辑器与版本恢复用的临时编辑器必须保持同一套 schema，
 * 否则历史快照里的表格、任务清单等节点会在转换时被丢弃。
 */
function createDocExtensions() {
  return [
    // 协同模式下撤销由 Yjs 的 UndoManager 负责，关闭本地历史
    StarterKit.configure({ undoRedo: false }),
    TableKit.configure({}),
    TaskList.configure({}),
    TaskItem.configure({ nested: true }),
    Highlight.configure({}),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    DocImage,
    DocAttachment,
    // 内嵌导图卡片只存引用，版本快照恢复时需要同一 schema 才能保留
    EmbeddedMindmap,
    // 评论锚点也是正文 schema 的一部分，历史快照恢复时同样要能解析
    CommentMark,
  ];
}

type RestoreHandler = (snapshot: DocVersionSnapshot) => Promise<void>;

/** 粘贴/拖拽图片的本地预校验，与工具栏上传的 5 MB 上限保持一致。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 一次最多插入 5 张，避免误拖整个相册时长时间占用上传队列。 */
const MAX_PASTED_IMAGES = 5;

/**
 * 粘贴或拖入的图片先直传 MinIO，再以 image 节点写入正文。
 * 上传是异步的，回来时编辑器可能已重建，因此直接用当时的 ProseMirror view 派发事务，
 * 而不是依赖闭包里的 editor 实例。
 */
function insertPastedImages(
  view: EditorView,
  docId: string,
  files: File[],
  pos: number,
  onError: (message: string) => void,
): void {
  const images = files.filter((file) => file.type.startsWith('image/')).slice(0, MAX_PASTED_IMAGES);
  if (!images.length) return;
  void (async () => {
    let at = pos;
    for (const file of images) {
      if (file.size > MAX_IMAGE_BYTES) {
        onError(`图片不能超过 5 MB：${file.name}`);
        continue;
      }
      try {
        const src = await uploadDocImage(docId, file);
        const imageType = view.state.schema.nodes.image;
        if (!imageType) return;
        const node = imageType.create({ src, alt: file.name });
        const insertAt = Math.min(at, view.state.doc.content.size);
        view.dispatch(view.state.tr.insert(insertAt, node));
        at = insertAt + node.nodeSize;
      } catch (error) {
        onError(error instanceof Error ? error.message : '图片上传失败');
      }
    }
  })();
}

interface EditorProps {
  detail: DocDetail;
  session: CollabSession;
  /** 新建时选择的模板：仅在空文档上写入一次，写完通知页面清掉 URL 参数 */
  template?: DocTemplate;
  onTemplateApplied: () => void;
  /** 把版本恢复能力注册给页面顶栏的版本面板。 */
  registerRestore: (handler: RestoreHandler | null) => void;
  /** 协同连接状态文案，显示在正文底部的状态行 */
  statusText: string;
  /** 保存状态文案，显示在正文底部的状态行 */
  saveText: string;
}

/**
 * 文档协同：TipTap + Yjs，正文走 `<docId>/body` 单个 Y.Doc。
 * spectator 不渲染远端光标（不订阅 awareness），与适配层的一致治理规则对齐。
 */
function CollabEditor({
  detail,
  session,
  template,
  onTemplateApplied,
  registerRestore,
  statusText,
  saveText,
}: EditorProps) {
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

  // 粘贴/拖拽图片的失败提示，几秒后自动消失（先于 useEditor 声明，供 editorProps 引用）
  const [uploadError, setUploadError] = useState('');
  // 查找条显隐由页面统一管理，工具栏按钮与 Ctrl+F 都走这里
  const [findOpen, setFindOpen] = useState(false);

  const editor = useEditor(
    {
      editable,
      extensions: [
        ...createDocExtensions(),
        CharLimit,
        // 查找高亮只影响本地视图，不写入协同文档
        createFindExtension(),
        Collaboration.configure({ document: session.doc }),
        mention,
        ...(editable
          ? [
              CollaborationCaret.configure({
                provider: session.provider,
                user: { name: user?.displayName ?? '匿名', color: '#2f6fed' },
              }),
              // 斜杠命令只对可写角色挂：只读成员没有输入，不需要插入菜单
              createSlashExtension(),
            ]
          : []),
      ],
      editorProps: {
        attributes: { class: 'editor-surface' },
        // 截图粘贴与文件拖入都直接走上传链路，正文与其他在线成员即时收敛
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!editable || !files.some((file) => file.type.startsWith('image/'))) return false;
          event.preventDefault();
          insertPastedImages(view, detail.id, files, view.state.selection.from, setUploadError);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || !editable || !files.some((file) => file.type.startsWith('image/'))) {
            return false;
          }
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          insertPastedImages(view, detail.id, files, at ?? view.state.selection.from, setUploadError);
          return true;
        },
      },
    },
    [session, editable, user?.displayName, detail.id],
  );

  // 模板内容只写入一次，且必须落在空文档上：等协同首次同步完成，避免覆盖远端已有内容
  const templateAppliedRef = useRef(false);
  useEffect(() => {
    if (!editor || !editable || !template || !isContentTemplate(template)) return;
    const apply = (): void => {
      if (templateAppliedRef.current || !editor.isEmpty) return;
      templateAppliedRef.current = true;
      editor.commands.setContent(template.html);
      onTemplateApplied();
    };
    if (session.provider.isSynced) {
      apply();
      return;
    }
    session.provider.on('synced', apply);
    return () => {
      session.provider.off('synced', apply);
    };
  }, [editor, editable, template, session, onTemplateApplied]);

  const [chars, setChars] = useState(0);
  const [blocked, setBlocked] = useState(false);
  // 待填内容的评论草稿：锚点已进正文，提交落库、取消摘锚点
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  // 块手柄以正文容器为定位基准
  const mainRef = useRef<HTMLDivElement | null>(null);

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
    if (!uploadError) return;
    const timer = window.setTimeout(() => setUploadError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [uploadError]);

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
          ...createDocExtensions(),
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

  /**
   * 划词评论：先在正文打上协同锚点（commentMark），再等用户在面板里填内容。
   * 锚点先行是因为它是协同事务，提交评论只是落库；取消草稿时把锚点摘掉。
   */
  const requestComment = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const excerpt = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const commentId = crypto.randomUUID();
    editor.chain().setMark('commentMark', { commentId }).run();
    setCommentDraft({ commentId, excerpt });
  }, [editor]);

  const discardCommentDraft = useCallback(() => {
    if (editor && commentDraft) removeCommentAnchor(editor, commentDraft.commentId);
    setCommentDraft(null);
  }, [editor, commentDraft]);

  const atLimit = chars >= LIMITS.maxDocChars;

  return (
    <div className="editor-layout">
      <div className="editor-main" ref={mainRef}>
        {editor ? (
          <DocFindBar
            editor={editor}
            open={findOpen}
            onOpen={() => setFindOpen(true)}
            onClose={() => setFindOpen(false)}
          />
        ) : null}
        <DocToolbar
          editor={editor}
          editable={editable}
          docId={detail.id}
          title={detail.title}
          onFind={() => setFindOpen(true)}
        />
        <EditorContent editor={editor} />
        {editor ? (
          <>
            <DocFormatMenu editor={editor} editable={editable} onRequestComment={requestComment} />
            <DocTableMenu editor={editor} editable={editable} />
            <BlockHandle editor={editor} editable={editable} docId={detail.id} containerRef={mainRef} />
          </>
        ) : null}
        <div className="editor-footer">
          <span className={atLimit || blocked || uploadError ? 'error' : 'muted'}>
            {uploadError ||
              `${chars} / ${LIMITS.maxDocChars} 字${
                atLimit ? ' · 已达单文档上限，继续输入会被拦截；请拆分为多篇（一期不支持自动分片）' : ''
              }${blocked ? ' · 本次输入超出 8 万字上限，已拦截；请拆分为多篇' : ''}`}
          </span>
          <span className="muted">
            {statusText} · {saveText}
          </span>
        </div>
      </div>
      {editor ? <DocOutline editor={editor} /> : null}
      {editor && user ? (
        <CommentPanel
          editor={editor}
          docId={detail.id}
          role={detail.role}
          userId={user.id}
          draft={commentDraft}
          onDiscardDraft={discardCommentDraft}
          onDraftSubmitted={() => setCommentDraft(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 右侧大纲：从正文标题实时抽取，点击跳到对应标题。
 * 没有标题时整体不渲染，不占用正文宽度。
 */
function DocOutline({ editor }: { editor: Editor }) {
  const [items, setItems] = useState<Array<{ pos: number; level: number; text: string }>>([]);

  useEffect(() => {
    const collect = (): void => {
      const list: Array<{ pos: number; level: number; text: string }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading' && node.textContent.trim()) {
          list.push({ pos, level: node.attrs.level as number, text: node.textContent });
        }
      });
      setItems(list);
    };
    collect();
    editor.on('update', collect);
    return () => {
      editor.off('update', collect);
    };
  }, [editor]);

  if (!items.length) return null;

  return (
    <aside className="doc-outline" aria-label="大纲">
      <h2 className="doc-outline-title">大纲</h2>
      <ul className="doc-outline-list">
        {items.map((item) => (
          <li key={`${item.pos}-${item.level}`}>
            <button
              type="button"
              className={`doc-outline-item level-${item.level}`}
              onClick={() => editor.chain().focus().setTextSelection(item.pos + 1).scrollIntoView().run()}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const MAX_TITLE_CHARS = 120;

/**
 * 顶部标题：点击就地重命名，Enter / 失焦保存，Esc 取消。
 * 标题不进协同正文，保存走 PATCH，成功后用服务端返回值刷新页面状态。
 */
function DocTitleEditor({
  title,
  editable,
  onSave,
}: {
  title: string;
  editable: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // 防止 Enter 与随后的 blur 触发两次提交
  const savingRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commit = async (): Promise<void> => {
    if (savingRef.current) return;
    const next = draft.trim();
    if (!next || next === title) {
      setEditing(false);
      setDraft(title);
      return;
    }
    savingRef.current = true;
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // 失败时保持编辑态，错误提示由页面顶部统一展示
    } finally {
      savingRef.current = false;
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="doc-title-button"
        title={editable ? '点击重命名' : '只读成员不能修改标题'}
        disabled={!editable}
        onClick={() => {
          if (!editable) return;
          setDraft(title);
          setEditing(true);
        }}
      >
        {title || '未命名文档'}
      </button>
    );
  }

  return (
    <input
      className="doc-title-input"
      value={draft}
      maxLength={MAX_TITLE_CHARS}
      autoFocus
      aria-label="文档标题"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false;
          setEditing(false);
          setDraft(title);
          return;
        }
        void commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function DocEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  // 新建时从列表页带来 ?template=xxx，应用一次后清掉，刷新不会重复写入
  const [searchParams] = useSearchParams();
  const template = findDocTemplate(searchParams.get('template'));
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState('连接中');
  const [error, setError] = useState('');
  // 正文宽度：标准（便于阅读）与全宽（便于大表格/长段落对照）
  const [wide, setWide] = useState(false);
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

  const handleRename = useCallback(
    async (next: string) => {
      if (!detail) return;
      try {
        const updated = await renameDoc(detail.id, next);
        setDetail(updated);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '重命名失败');
        throw err;
      }
    },
    [detail],
  );

  const handleDocIcon = useCallback(
    async (next: string | null) => {
      if (!detail) return;
      try {
        const updated = await updateDocIcon(detail.id, next);
        setDetail(updated);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '设置图标失败');
        throw err;
      }
    },
    [detail],
  );

  const handleTemplateApplied = useCallback(() => {
    if (!searchParams.has('template')) return;
    navigate(`/doc/${id}`, { replace: true });
  }, [id, navigate, searchParams]);

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
    <div className={wide ? 'page page-wide' : 'page'}>
      <header className="topbar">
        <div>
          <div className="doc-title-row">
            {detail ? (
              <DocIconPicker
                icon={detail.icon}
                kind={detail.kind}
                editable={detail.role !== 'spectator'}
                onChange={handleDocIcon}
              />
            ) : null}
            {detail ? (
              <DocTitleEditor
                title={detail.title}
                editable={detail.role !== 'spectator'}
                onSave={handleRename}
              />
            ) : (
              <h1>文档</h1>
            )}
          </div>
          <p className="muted">{detail ? ROLE_LABEL[detail.role] : '加载中…'}</p>
        </div>
        <div className="actions">
          <NotificationBell />
          {detail ? <VersionPanel docId={detail.id} role={detail.role} onRestore={restore} /> : null}
          {detail ? <MemberPanel docId={detail.id} role={detail.role} /> : null}
          <button title="切换正文显示宽度" onClick={() => setWide((value) => !value)}>
            {wide ? '标准宽度' : '全宽'}
          </button>
          <button onClick={() => navigate('/')}>返回列表</button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <main className="editor-shell">
        {detail && session ? (
          <CollabEditor
            detail={detail}
            session={session}
            template={template}
            onTemplateApplied={handleTemplateApplied}
            registerRestore={registerRestore}
            statusText={status}
            saveText={save.text}
          />
        ) : null}
      </main>
    </div>
  );
}
