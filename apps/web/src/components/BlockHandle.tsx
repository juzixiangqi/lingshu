import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { uploadDocAttachment, uploadDocImage } from '../lib/api';
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, ATTACHMENT_MIME } from '../lib/docUpload';
import { InsertMindmapDialog } from './InsertMindmapDialog';

interface HoverBlock {
  /** 顶层块在文档中的起始位置 */
  pos: number;
  /** 顶层块节点大小，用于计算插入/删除范围 */
  size: number;
  /** 相对编辑器容器的定位坐标 */
  top: number;
  left: number;
}

interface DropTarget {
  /** 松手后把块插入到文档的哪个位置 */
  insertPos: number;
  /** 插入指示线相对容器的纵坐标 */
  top: number;
}

interface BlockHandleProps {
  editor: Editor;
  editable: boolean;
  /** 当前文档 id，图片/附件走与工具栏相同的预签名上传 */
  docId: string;
  /** 定位基准：正文容器（position: relative） */
  containerRef: RefObject<HTMLDivElement | null>;
}

type InsertKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'hr'
  | 'table';

/** 行首「+」菜单可插入的块类型，结构和顶部工具条的插入项保持一致。 */
const INSERT_ITEMS: Array<{ kind: InsertKind; label: string }> = [
  { kind: 'paragraph', label: '正文' },
  { kind: 'h1', label: '标题 1' },
  { kind: 'h2', label: '标题 2' },
  { kind: 'h3', label: '标题 3' },
  { kind: 'bulletList', label: '无序列表' },
  { kind: 'orderedList', label: '有序列表' },
  { kind: 'taskList', label: '任务清单' },
  { kind: 'blockquote', label: '引用' },
  { kind: 'codeBlock', label: '代码块' },
  { kind: 'hr', label: '分割线' },
  { kind: 'table', label: '表格（3×3）' },
];

function tableJson(rows = 3, cols = 3): JSONContent {
  return {
    type: 'table',
    content: Array.from({ length: rows }, (_, row) => ({
      type: 'tableRow',
      content: Array.from({ length: cols }, () => ({
        type: row === 0 ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph' }],
      })),
    })),
  };
}

function blockContent(kind: InsertKind): JSONContent {
  switch (kind) {
    case 'h1':
      return { type: 'heading', attrs: { level: 1 } };
    case 'h2':
      return { type: 'heading', attrs: { level: 2 } };
    case 'h3':
      return { type: 'heading', attrs: { level: 3 } };
    case 'bulletList':
      return { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] };
    case 'orderedList':
      return {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
      };
    case 'taskList':
      return {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] },
        ],
      };
    case 'blockquote':
      return { type: 'blockquote', content: [{ type: 'paragraph' }] };
    case 'codeBlock':
      return { type: 'codeBlock' };
    case 'hr':
      return { type: 'horizontalRule' };
    case 'table':
      return tableJson();
    default:
      return { type: 'paragraph' };
  }
}

/**
 * 块级 hover 手柄：鼠标移到某一行时，左侧浮现「+」「⋮」「⠿」。
 * - 「+」弹出插入菜单（正文、标题、列表、引用、代码块、表格、图片、附件、思维导图等），在当前块下方插入；
 * - 「⋮」提供上/下插入空行、复制、删除；
 * - 「⠿」按住拖动排序，松手时按单事务完成移动。
 * 所有操作都走编辑器命令，保证与协同事务一致。
 */
export function BlockHandle({ editor, editable, docId, containerRef }: BlockHandleProps) {
  const [block, setBlock] = useState<HoverBlock | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [mindmapOpen, setMindmapOpen] = useState(false);
  const [inserting, setInserting] = useState<'image' | 'attachment' | null>(null);
  const [insertError, setInsertError] = useState('');
  const [dragLine, setDragLine] = useState<number | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  /** 打开文件选择/导图弹窗前记录插入点，避免期间 hover 换块导致位置漂移 */
  const insertPosRef = useRef<number | null>(null);
  const dragRef = useRef<{ pos: number; size: number } | null>(null);
  const dropRef = useRef<DropTarget | null>(null);

  useEffect(() => {
    if (!editable) return;
    const view = editor.view;

    const containerRect = (): DOMRect =>
      containerRef.current?.getBoundingClientRect() ?? view.dom.getBoundingClientRect();

    /**
     * 用鼠标坐标反查文档位置，比 posAtDOM 更稳：
     * 空段落、嵌套块（任务清单/表格）都能落到正确的顶层块上。
     */
    const locate = (pointer: { clientX: number; clientY: number }): HoverBlock | null => {
      const surface = view.dom.getBoundingClientRect();
      if (pointer.clientY < surface.top || pointer.clientY > surface.bottom) return null;
      const coords = view.posAtCoords({ left: pointer.clientX, top: pointer.clientY });
      if (!coords) return null;
      const $pos = view.state.doc.resolve(coords.pos);
      if ($pos.depth < 1) return null;
      const pos = $pos.before(1);
      const blockNode = $pos.node(1);
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return null;
      const rect = dom.getBoundingClientRect();
      const container = containerRect();
      return {
        pos,
        size: blockNode.nodeSize,
        top: rect.top - container.top + 2,
        left: rect.left - container.left - 34,
      };
    };

    /** 拖动时按鼠标落在目标块的上半/下半决定插入点，并给出指示线位置。 */
    const computeDrop = (pointer: { clientX: number; clientY: number }): DropTarget | null => {
      const surface = view.dom.getBoundingClientRect();
      if (pointer.clientY < surface.top || pointer.clientY > surface.bottom) return null;
      const coords = view.posAtCoords({ left: pointer.clientX, top: pointer.clientY });
      if (!coords) return null;
      const $pos = view.state.doc.resolve(coords.pos);
      if ($pos.depth < 1) return null;
      const blockPos = $pos.before(1);
      const blockNode = $pos.node(1);
      const dom = view.nodeDOM(blockPos);
      if (!(dom instanceof HTMLElement)) return null;
      const rect = dom.getBoundingClientRect();
      const below = pointer.clientY > rect.top + rect.height / 2;
      const container = containerRect();
      return {
        insertPos: below ? blockPos + blockNode.nodeSize : blockPos,
        top: (below ? rect.bottom : rect.top) - container.top,
      };
    };

    // 指针事件按帧合并：posAtCoords 在长文档里不便宜，逐条 mousemove 计算会掉帧
    let hoverFrame = 0;
    let pendingPointer: { clientX: number; clientY: number } | null = null;

    // 拖拽靠近视口上下边缘时自动滚动，长文档才能把块拖到视口外
    let lastPointer: { clientX: number; clientY: number } | null = null;
    let scrollFrame = 0;

    const autoScroll = (): void => {
      if (!dragRef.current) {
        scrollFrame = 0;
        return;
      }
      // 首次 mousemove 之前还没有指针坐标，先空转等待
      if (lastPointer) {
        const margin = 80;
        const height = window.innerHeight;
        let delta = 0;
        if (lastPointer.clientY < margin) {
          delta = -Math.ceil((margin - lastPointer.clientY) / 3);
        } else if (lastPointer.clientY > height - margin) {
          delta = Math.ceil((lastPointer.clientY - (height - margin)) / 3);
        }
        if (delta) {
          window.scrollBy(0, delta);
          const drop = computeDrop(lastPointer);
          dropRef.current = drop;
          setDragLine(drop ? drop.top : null);
        }
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    const applyPointer = (pointer: { clientX: number; clientY: number }): void => {
      // 拖动中只更新落点指示线，不再跟随 hover 换块
      if (dragRef.current) {
        lastPointer = pointer;
        const drop = computeDrop(pointer);
        dropRef.current = drop;
        setDragLine(drop ? drop.top : null);
        return;
      }
      const next = locate(pointer);
      setBlock(next);
      if (!next) {
        setMenuOpen(false);
        setInsertMenuOpen(false);
      }
    };

    const onMove = (event: MouseEvent): void => {
      // 鼠标落在手柄自身时保持当前块，否则点按钮的瞬间会先被判定为「离开」
      if (handleRef.current?.contains(event.target as Node)) return;
      pendingPointer = { clientX: event.clientX, clientY: event.clientY };
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (pendingPointer) applyPointer(pendingPointer);
      });
    };

    /** 拖拽把手按下后启动自动滚动循环，松手时由 onUp 停止 */
    const onDragStart = (): void => {
      lastPointer = null;
      if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
    };

    const onUp = (): void => {
      const source = dragRef.current;
      if (!source) return;
      if (scrollFrame) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
      }
      lastPointer = null;
      const drop = dropRef.current;
      dragRef.current = null;
      dropRef.current = null;
      setDragLine(null);
      if (!drop) return;
      // 落在自身前后视为未移动
      if (drop.insertPos === source.pos || drop.insertPos === source.pos + source.size) return;
      const node = editor.state.doc.nodeAt(source.pos);
      if (!node) return;
      // 先删后插：目标在源之后时，删除会让后续位置整体前移一个块
      const target = drop.insertPos > source.pos ? drop.insertPos - source.size : drop.insertPos;
      editor
        .chain()
        .focus()
        .deleteRange({ from: source.pos, to: source.pos + source.size })
        .insertContentAt(target, node.toJSON())
        .run();
      setBlock(null);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('lingshu:drag-start', onDragStart);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('lingshu:drag-start', onDragStart);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
    };
  }, [editor, editable, containerRef]);

  // 上传失败的提示挂在手柄下方，过几秒自动消失，不打断继续编辑
  useEffect(() => {
    if (!insertError) return;
    const timer = window.setTimeout(() => setInsertError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [insertError]);

  if (!editable || !block) return null;

  const insertParagraph = (at: number): void => {
    editor.chain().focus().insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1).run();
    setMenuOpen(false);
  };

  /** 行首「+」选完块类型后：在当前块下方插入，并把光标落到新块里。 */
  const insertBlock = (kind: InsertKind): void => {
    editor
      .chain()
      .focus()
      .insertContentAt(block.pos + block.size, blockContent(kind))
      .run();
    setInsertMenuOpen(false);
  };

  /** 媒体类块统一插到记录好的位置，并夹在文档末尾之前。 */
  const insertNodeAt = (pos: number, node: JSONContent): void => {
    const at = Math.min(pos, editor.state.doc.content.size);
    editor.chain().focus().insertContentAt(at, node).run();
  };

  const targetPos = (): number => insertPosRef.current ?? block.pos + block.size;

  const onPickImage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setInsertError('请选择图片文件');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setInsertError('图片不能超过 5 MB');
      return;
    }
    setInserting('image');
    try {
      const src = await uploadDocImage(docId, file);
      insertNodeAt(targetPos(), { type: 'image', attrs: { src, alt: file.name } });
    } catch (error) {
      setInsertError(error instanceof Error ? error.message : '图片上传失败');
    } finally {
      setInserting(null);
    }
  };

  const onPickAttachment = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const contentType = ATTACHMENT_MIME[ext];
    if (!contentType) {
      setInsertError('仅支持 PDF / Word / Excel / PPT / ZIP / TXT / CSV 附件');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setInsertError('附件不能超过 20 MB');
      return;
    }
    setInserting('attachment');
    try {
      const src = await uploadDocAttachment(docId, file, contentType);
      insertNodeAt(targetPos(), {
        type: 'attachment',
        attrs: { src, name: file.name, size: file.size },
      });
    } catch (error) {
      setInsertError(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      setInserting(null);
    }
  };

  const currentNode = editor.state.doc.nodeAt(block.pos);

  const duplicate = (): void => {
    if (!currentNode) return;
    editor.chain().focus().insertContentAt(block.pos + block.size, currentNode.toJSON()).run();
    setMenuOpen(false);
  };

  const remove = (): void => {
    editor.chain().focus().deleteRange({ from: block.pos, to: block.pos + block.size }).run();
    setBlock(null);
    setMenuOpen(false);
  };

  return (
    <>
      <div
        ref={handleRef}
        className="block-handle"
        style={{ top: `${block.top}px`, left: `${block.left}px` }}
      >
        <button
          type="button"
          className="block-handle-btn"
          title="插入内容"
          aria-expanded={insertMenuOpen}
          onClick={() => {
            setInsertMenuOpen((value) => !value);
            setMenuOpen(false);
          }}
        >
          +
        </button>
        <button
          type="button"
          className="block-handle-btn"
          title="块操作"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((value) => !value);
            setInsertMenuOpen(false);
          }}
        >
          ⋮
        </button>
        <button
          type="button"
          className="block-handle-btn block-handle-grip"
          title="拖动排序"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragRef.current = { pos: block.pos, size: block.size };
            setMenuOpen(false);
            setInsertMenuOpen(false);
            window.dispatchEvent(new Event('lingshu:drag-start'));
          }}
        >
          ⠿
        </button>
        {insertMenuOpen ? (
          <div
            className="block-handle-menu block-insert-menu"
            role="menu"
            onMouseDown={(event) => event.preventDefault()}
          >
            {INSERT_ITEMS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className="doc-insert-item"
                onClick={() => insertBlock(item.kind)}
              >
                {item.label}
              </button>
            ))}
            <span className="doc-insert-divider" />
            <button
              type="button"
              className="doc-insert-item"
              disabled={inserting !== null}
              onClick={() => {
                insertPosRef.current = block.pos + block.size;
                setInsertMenuOpen(false);
                imageInputRef.current?.click();
              }}
            >
              {inserting === 'image' ? '图片上传中…' : '图片'}
            </button>
            <button
              type="button"
              className="doc-insert-item"
              disabled={inserting !== null}
              onClick={() => {
                insertPosRef.current = block.pos + block.size;
                setInsertMenuOpen(false);
                attachmentInputRef.current?.click();
              }}
            >
              {inserting === 'attachment' ? '附件上传中…' : '附件'}
            </button>
            <button
              type="button"
              className="doc-insert-item"
              onClick={() => {
                insertPosRef.current = block.pos + block.size;
                setInsertMenuOpen(false);
                setMindmapOpen(true);
              }}
            >
              思维导图
            </button>
          </div>
        ) : null}
        {menuOpen ? (
          <div className="block-handle-menu" role="menu" onMouseDown={(event) => event.preventDefault()}>
            <button type="button" className="doc-insert-item" onClick={() => insertParagraph(block.pos)}>
              在上方插入空行
            </button>
            <button type="button" className="doc-insert-item" onClick={() => insertParagraph(block.pos + block.size)}>
              在下方插入空行
            </button>
            <button type="button" className="doc-insert-item" onClick={duplicate}>
              复制本块
            </button>
            <button type="button" className="doc-insert-item" onClick={remove}>
              删除本块
            </button>
          </div>
        ) : null}
        {insertError ? <span className="block-handle-note">{insertError}</span> : null}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(event) => void onPickImage(event)}
        />
        <input
          ref={attachmentInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv"
          hidden
          onChange={(event) => void onPickAttachment(event)}
        />
      </div>
      <InsertMindmapDialog
        open={mindmapOpen}
        onClose={() => setMindmapOpen(false)}
        onPick={(doc) => {
          insertNodeAt(targetPos(), {
            type: 'embeddedMindmap',
            attrs: { docId: doc.id, title: doc.title, icon: doc.icon },
          });
        }}
      />
      {dragLine !== null ? <div className="block-drop-line" style={{ top: `${dragLine}px` }} /> : null}
    </>
  );
}
