import { useEffect, useReducer, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import { EMPTY_FIND, FIND_KEY, clearFind, findMatches, setFindState } from '../lib/find';

interface DocFindBarProps {
  editor: Editor;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * 文档内查找：Ctrl+F 打开，命中项在正文里高亮，Enter / Shift+Enter 切换。
 * 高亮是纯视图装饰，不写进 Y.Doc，协同成员不会因此看到额外内容。
 */
export function DocFindBar({ editor, open, onOpen, onClose }: DocFindBarProps) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 正文或查找状态变化后重算命中数量（别的成员改正文也要跟着刷新）
  useEffect(() => {
    const update = (): void => refresh();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        onOpen();
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpen, onClose, open]);

  // 打开或再次按 Ctrl+F 时聚焦并全选，方便直接覆盖上次关键词
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 关闭时清掉高亮，避免正文残留黄色标记
  useEffect(() => {
    if (open) return;
    clearFind(editor);
  }, [editor, open]);

  if (!open) return null;

  const state = FIND_KEY.getState(editor.state) ?? EMPTY_FIND;
  const matches = state.term ? findMatches(editor.state.doc, state.term) : [];

  const reveal = (index: number, term: string): void => {
    const match = findMatches(editor.state.doc, term)[index];
    if (!match) return;
    editor.chain().setTextSelection(match).scrollIntoView().run();
  };

  const applyTerm = (next: string): void => {
    setFindState(editor, next, next ? 0 : -1);
    reveal(0, next);
  };

  const move = (step: 1 | -1): void => {
    if (!matches.length) return;
    const next = (Math.max(0, state.active) + step + matches.length) % matches.length;
    setFindState(editor, state.term, next);
    reveal(next, state.term);
  };

  const close = (): void => {
    clearFind(editor);
    onClose();
  };

  return (
    <div className="doc-find-bar" role="search">
      <input
        ref={inputRef}
        className="doc-find-input"
        type="search"
        placeholder="查找正文"
        aria-label="查找正文"
        value={state.term}
        onChange={(event) => applyTerm(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      />
      <span className="doc-find-count muted">
        {state.term
          ? matches.length
            ? `${Math.max(0, state.active) + 1} / ${matches.length}`
            : '无结果'
          : ''}
      </span>
      <button
        type="button"
        className="doc-tool"
        title="上一个（Shift+Enter）"
        disabled={!matches.length}
        onClick={() => move(-1)}
      >
        上一个
      </button>
      <button
        type="button"
        className="doc-tool"
        title="下一个（Enter）"
        disabled={!matches.length}
        onClick={() => move(1)}
      >
        下一个
      </button>
      <button type="button" className="doc-tool" title="关闭（Esc）" onClick={close}>
        关闭
      </button>
    </div>
  );
}
