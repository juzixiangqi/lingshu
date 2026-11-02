import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { Editor } from '@tiptap/react';
import type { DocComment, DocRole } from '@lingshu/shared';
import { createComment, createCommentReply, listComments, resolveComment } from '../lib/api';
import { collectCommentIds, removeCommentAnchor, revealCommentAnchor } from '../lib/commentMark';

export interface CommentDraft {
  commentId: string;
  excerpt: string;
}

interface CommentPanelProps {
  editor: Editor;
  docId: string;
  role: DocRole;
  userId: string;
  /** 父级已在正文打好锚点、等待填写内容的草稿评论 */
  draft: CommentDraft | null;
  /** 放弃草稿：父级负责移除正文锚点 */
  onDiscardDraft: () => void;
  /** 草稿提交成功：锚点保留，父级只需清掉草稿态 */
  onDraftSubmitted: () => void;
}

/**
 * 划词评论面板。评论数据落库，锚点（commentMark）在正文 Y.Doc 里，
 * 两端通过同一个 commentId 对照；正文里找不到锚点的评论标记为“原文已删除”。
 */
export function CommentPanel({
  editor,
  docId,
  role,
  userId,
  draft,
  onDiscardDraft,
  onDraftSubmitted,
}: CommentPanelProps) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [anchoredIds, setAnchoredIds] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  // 评论默认收起为悬浮胶囊，发起新评论时自动展开
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (draft) setPanelOpen(true);
  }, [draft]);
  // 回复线程：同一时间只展开一条根评论的回复输入框
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);

  const canWrite = role !== 'spectator';

  useEffect(() => {
    let cancelled = false;
    listComments(docId)
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {
        if (!cancelled) setNote('评论加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // 锚点集合随正文协同变化，本地与远端编辑都要重算
  useEffect(() => {
    const refresh = (): void => setAnchoredIds(collectCommentIds(editor));
    refresh();
    editor.on('update', refresh);
    return () => {
      editor.off('update', refresh);
    };
  }, [editor]);

  const submitDraft = useCallback(async (): Promise<void> => {
    if (!draft) return;
    const text = content.trim();
    if (!text) {
      setNote('评论内容不能为空');
      return;
    }
    setBusy(true);
    setNote('');
    try {
      setComments(await createComment(docId, draft.commentId, text, draft.excerpt));
      setContent('');
      onDraftSubmitted();
    } catch (error) {
      setNote(error instanceof Error ? error.message : '评论提交失败');
    } finally {
      setBusy(false);
    }
  }, [draft, content, docId, onDraftSubmitted]);

  const resolve = useCallback(
    async (comment: DocComment): Promise<void> => {
      setBusy(true);
      setNote('');
      try {
        setComments(await resolveComment(docId, comment.id));
        // 解决即摘除正文锚点，高亮随协同事务同步到其他端
        removeCommentAnchor(editor, comment.id);
      } catch (error) {
        setNote(error instanceof Error ? error.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [docId, editor],
  );

  const submitReply = useCallback(
    async (commentId: string): Promise<void> => {
      const text = replyText.trim();
      if (!text) {
        setNote('回复内容不能为空');
        return;
      }
      setReplyBusy(true);
      setNote('');
      try {
        setComments(await createCommentReply(docId, commentId, text));
        setReplyText('');
        setReplyTo(null);
      } catch (error) {
        setNote(error instanceof Error ? error.message : '回复失败');
      } finally {
        setReplyBusy(false);
      }
    },
    [docId, replyText],
  );

  // 回复与根评论同表返回，面板按 parentId 分组渲染
  const roots = comments.filter((comment) => !comment.parentId);
  const repliesOf = (commentId: string): DocComment[] =>
    comments.filter((comment) => comment.parentId === commentId);
  const open = roots.filter((comment) => comment.status === 'open');
  const resolved = roots.filter((comment) => comment.status === 'resolved');

  // 收起态只在右下角留一个入口，避免面板长期占掉正文宽度
  if (!panelOpen) {
    return (
      <button type="button" className="comment-dock" onClick={() => setPanelOpen(true)} aria-label="打开评论">
        评论
        {open.length ? <span className="comment-dock-count">{open.length}</span> : null}
      </button>
    );
  }

  const renderComment = (comment: DocComment): ReactElement => {
    const orphaned = comment.status === 'open' && !anchoredIds.has(comment.id);
    const canResolve = canWrite && comment.status === 'open' && (comment.authorId === userId || role === 'owner');
    return (
      <li key={comment.id} className="comment-item" data-resolved={comment.status === 'resolved'}>
        <button
          type="button"
          className="comment-excerpt"
          title={orphaned ? '原文已被删除' : '定位到原文'}
          onClick={() => {
            if (!revealCommentAnchor(editor, comment.id)) setNote('该评论的原文已被删除');
          }}
        >
          {comment.excerpt || '（无摘录）'}
        </button>
        {orphaned ? <span className="comment-orphan">原文已删除</span> : null}
        <p className="comment-content">{comment.content}</p>
        <p className="comment-meta muted">
          {comment.authorName} · {new Date(comment.createdAt).toLocaleString()}
          {comment.status === 'resolved' ? ' · 已解决' : ''}
        </p>

        {repliesOf(comment.id).length ? (
          <ul className="comment-replies">
            {repliesOf(comment.id).map((reply) => (
              <li key={reply.id} className="comment-reply">
                <p className="comment-content">{reply.content}</p>
                <p className="comment-meta muted">
                  {reply.authorName} · {new Date(reply.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        {canWrite && comment.status === 'open' ? (
          replyTo === comment.id ? (
            <div className="comment-reply-form">
              <textarea
                className="comment-input"
                placeholder="回复这条评论…"
                rows={2}
                maxLength={500}
                value={replyText}
                autoFocus
                onChange={(event) => setReplyText(event.target.value)}
              />
              <div className="comment-draft-actions">
                <button type="button" disabled={replyBusy} onClick={() => void submitReply(comment.id)}>
                  发送
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={replyBusy}
                  onClick={() => {
                    setReplyTo(null);
                    setReplyText('');
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="ghost comment-reply-toggle"
              onClick={() => {
                setReplyTo(comment.id);
                setReplyText('');
              }}
            >
              回复
            </button>
          )
        ) : null}

        {canResolve ? (
          <button type="button" className="comment-resolve" disabled={busy} onClick={() => void resolve(comment)}>
            解决
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <aside className="comment-panel is-open" aria-label="评论">
      <div className="comment-panel-head">
        <h2 className="comment-panel-title">评论（{open.length}）</h2>
        <button type="button" className="ghost comment-panel-close" onClick={() => setPanelOpen(false)}>
          收起
        </button>
      </div>

      {draft ? (
        <div className="comment-draft">
          <p className="comment-excerpt">{draft.excerpt || '（选中内容）'}</p>
          <textarea
            className="comment-input"
            placeholder="输入评论内容…"
            rows={3}
            maxLength={500}
            value={content}
            autoFocus
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="comment-draft-actions">
            <button type="button" disabled={busy} onClick={() => void submitDraft()}>
              提交
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={onDiscardDraft}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {note ? <p className="error comment-note">{note}</p> : null}

      <ul className="comment-list">
        {open.map(renderComment)}
        {!open.length && !draft ? <li className="muted comment-empty">划词后点工具栏「评论」发起讨论</li> : null}
      </ul>

      {resolved.length ? (
        <div className="comment-resolved">
          <button type="button" className="ghost" onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? '收起' : `已解决（${resolved.length}）`}
          </button>
          {showResolved ? <ul className="comment-list">{resolved.map(renderComment)}</ul> : null}
        </div>
      ) : null}
    </aside>
  );
}
