import { useEffect, useReducer, useRef, useState, type ChangeEvent } from 'react';
import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { uploadDocAttachment, uploadDocImage } from '../lib/api';
import { docToMarkdown } from '../lib/docExport';
import * as DOC_UPLOAD from '../lib/docUpload';
import { InsertMindmapDialog } from './InsertMindmapDialog';

const ATTACHMENT_MIME = DOC_UPLOAD.ATTACHMENT_MIME;
const MAX_ATTACHMENT_BYTES = DOC_UPLOAD.MAX_ATTACHMENT_BYTES;

interface DocToolbarProps {
  editor: Editor | null;
  editable: boolean;
  docId: string;
  /** 导出文件命名取自文档标题 */
  title: string;
  /** 打开页面级查找条（也支持 Ctrl+F） */
  onFind: () => void;
}

interface DocFormatMenuProps {
  editor: Editor;
  editable: boolean;
  /** 划词后点击「评论」：由页面侧完成打锚点与打开面板（需要持有评论状态）。 */
  onRequestComment: () => void;
}

/** 文件名去掉 Windows / macOS 不允许的字符，并兜底空标题。 */
function exportFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, ' ').trim();
  return cleaned || '未命名文档';
}

/**
 * 顶部工具条只保留撤销/重做与「插入」入口。
 * 格式类操作改为随选区浮出的气泡条（见 DocFormatMenu），表格结构操作归 DocTableMenu，
 * 正文上方不再常驻一整排按钮。只读成员没有写操作，仅保留查找与导出。
 */
export function DocToolbar({ editor, editable, docId, title, onFind }: DocToolbarProps) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [mindmapOpen, setMindmapOpen] = useState(false);
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const attachRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editor) return;
    const update = (): void => refresh();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  // 点击工具条外关闭插入菜单，避免菜单常驻遮住正文
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  if (!editor) return null;

  const chain = () => editor.chain().focus();

  /** 导出 Markdown：本地生成 Blob 直接下载，不依赖服务端。只读成员也可用。 */
  const exportMarkdown = (): void => {
    const markdown = docToMarkdown(editor.getJSON());
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${exportFileName(title)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /** 菜单项执行完即收起菜单，把视线还给正文。 */
  const run = (command: () => void): void => {
    command();
    setMenuOpen(false);
  };

  // 只读成员没有写操作，工具条只保留查找与导出
  if (!editable) {
    return (
      <div className="doc-toolbar" role="toolbar" aria-label="文档操作" ref={rootRef}>
        <button type="button" className="doc-tool" title="查找正文（Ctrl+F）" onClick={onFind}>
          查找
        </button>
        <button
          type="button"
          className="doc-tool doc-export"
          title="导出为 Markdown 文件"
          onClick={exportMarkdown}
        >
          导出 Markdown
        </button>
      </div>
    );
  }

  /** 图片先直传 MinIO，成功后以普通图片节点写入正文，其他在线成员即时收敛。 */
  const onPickImage = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNote('请选择图片文件');
      return;
    }
    if (file.size > DOC_UPLOAD.MAX_IMAGE_BYTES) {
      setNote('图片不能超过 5 MB');
      return;
    }
    setUploading(true);
    setNote('');
    try {
      const src = await uploadDocImage(docId, file);
      chain().insertContent({ type: 'image', attrs: { src, alt: file.name } }).run();
    } catch (error) {
      setNote(error instanceof Error ? error.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  /** 附件走同一条预签名链路，正文只落一个可下载的链接节点。 */
  const onPickAttachment = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const contentType = ATTACHMENT_MIME[ext];
    if (!contentType) {
      setNote('仅支持 PDF / Word / Excel / PPT / ZIP / TXT / CSV 附件');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setNote('附件不能超过 20 MB');
      return;
    }
    setUploadingAttachment(true);
    setNote('');
    try {
      const src = await uploadDocAttachment(docId, file, contentType);
      chain()
        .insertContent({ type: 'attachment', attrs: { src, name: file.name, size: file.size } })
        .run();
    } catch (error) {
      setNote(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      setUploadingAttachment(false);
    }
  };

  return (
    <div className="doc-toolbar" role="toolbar" aria-label="文档操作" ref={rootRef}>
      <button
        type="button"
        className="doc-tool"
        title="撤销"
        disabled={!editor.can().undo()}
        onClick={() => chain().undo().run()}
      >
        撤销
      </button>
      <button
        type="button"
        className="doc-tool"
        title="重做"
        disabled={!editor.can().redo()}
        onClick={() => chain().redo().run()}
      >
        重做
      </button>
      <button type="button" className="doc-tool" title="查找正文（Ctrl+F）" onClick={onFind}>
        查找
      </button>

      <span className="doc-toolbar-divider" />

      <div className="doc-insert">
        <button
          type="button"
          className="doc-tool"
          title="插入内容"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          + 插入
        </button>
        {menuOpen ? (
          <div className="doc-insert-menu" role="menu">
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleHeading({ level: 1 }).run())}>
              标题 1
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleHeading({ level: 2 }).run())}>
              标题 2
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleHeading({ level: 3 }).run())}>
              标题 3
            </button>
            <span className="doc-insert-divider" />
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleBulletList().run())}>
              无序列表
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleOrderedList().run())}>
              有序列表
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleTaskList().run())}>
              任务清单
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleBlockquote().run())}>
              引用
            </button>
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().toggleCodeBlock().run())}>
              代码块
            </button>
            <span className="doc-insert-divider" />
            <button type="button" className="doc-insert-item" onClick={() => run(() => chain().setHorizontalRule().run())}>
              分割线
            </button>
            <button
              type="button"
              className="doc-insert-item"
              onClick={() => run(() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
            >
              表格（3×3）
            </button>
            <button
              type="button"
              className="doc-insert-item"
              onClick={() => {
                setMenuOpen(false);
                setMindmapOpen(true);
              }}
            >
              思维导图
            </button>
            <button
              type="button"
              className="doc-insert-item"
              disabled={uploading}
              onClick={() => {
                setMenuOpen(false);
                fileRef.current?.click();
              }}
            >
              {uploading ? '图片上传中…' : '图片'}
            </button>
            <button
              type="button"
              className="doc-insert-item"
              disabled={uploadingAttachment}
              onClick={() => {
                setMenuOpen(false);
                attachRef.current?.click();
              }}
            >
              {uploadingAttachment ? '附件上传中…' : '附件'}
            </button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="doc-tool doc-export"
        title="导出为 Markdown 文件"
        onClick={exportMarkdown}
      >
        导出 Markdown
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => void onPickImage(event)}
      />
      <input
        ref={attachRef}
        type="file"
        accept=".pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv"
        hidden
        onChange={(event) => void onPickAttachment(event)}
      />

      {note ? <span className="doc-tool-note error">{note}</span> : null}

      <InsertMindmapDialog
        open={mindmapOpen}
        onClose={() => setMindmapOpen(false)}
        onPick={(doc) => {
          chain()
            .insertContent({
              type: 'embeddedMindmap',
              attrs: { docId: doc.id, title: doc.title, icon: doc.icon },
            })
            .run();
        }}
      />
    </div>
  );
}

/**
 * 选区气泡条：选中文字才出现，承载高频格式操作。
 * 表格内不显示这一组，交给 DocTableMenu，避免两个气泡叠在一起。
 */
export function DocFormatMenu({ editor, editable, onRequestComment }: DocFormatMenuProps) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  // 链接输入用浮层替代 window.prompt；打开时记录选区，避免输入框获焦后选区丢失
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState('');
  const linkRangeRef = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const update = (): void => refresh();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  // 选区变化（气泡条收起或换选内容）时关闭链接浮层，避免残留
  useEffect(() => {
    const reset = (): void => setLinkOpen(false);
    editor.on('selectionUpdate', reset);
    return () => {
      editor.off('selectionUpdate', reset);
    };
  }, [editor]);

  if (!editable) return null;

  const chain = () => editor.chain().focus();
  const active = (name: string): boolean => editor.isActive(name);

  /** 链接按钮：已有链接时取消，否则打开输入浮层。 */
  const toggleLink = (): void => {
    if (active('link')) {
      chain().extendMarkRange('link').unsetLink().run();
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to) return;
    linkRangeRef.current = { from, to };
    setLinkHref('https://');
    setLinkOpen(true);
  };

  /** 允许带协议、mailto/tel、站内绝对路径与锚点，其余补成 https。 */
  const normalizeHref = (raw: string): string | null => {
    const value = raw.trim();
    if (!value) return null;
    if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(value)) return value;
    return `https://${value}`;
  };

  const applyLink = (): void => {
    const range = linkRangeRef.current;
    const href = normalizeHref(linkHref);
    setLinkOpen(false);
    if (!range || !href) return;
    editor
      .chain()
      .focus()
      .setTextSelection(range)
      .extendMarkRange('link')
      .setLink({ href })
      .run();
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: current }) => !current.state.selection.empty && !current.isActive('table')}
    >
      <div className="doc-bubble" onMouseDown={(event) => event.preventDefault()}>
        <button
          type="button"
          className="doc-tool"
          data-active={active('bold')}
          title="加粗"
          onClick={() => chain().toggleBold().run()}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={active('italic')}
          title="斜体"
          onClick={() => chain().toggleItalic().run()}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={active('underline')}
          title="下划线"
          onClick={() => chain().toggleUnderline().run()}
        >
          <span className="doc-bubble-underline">U</span>
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={active('strike')}
          title="删除线"
          onClick={() => chain().toggleStrike().run()}
        >
          <span className="doc-bubble-strike">S</span>
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={active('code')}
          title="行内代码"
          onClick={() => chain().toggleCode().run()}
        >
          {'</>'}
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={active('highlight')}
          title="高亮"
          onClick={() => chain().toggleHighlight().run()}
        >
          高亮
        </button>

        <span className="doc-toolbar-divider" />

        <button
          type="button"
          className="doc-tool"
          data-active={editor.isActive({ textAlign: 'left' })}
          title="左对齐"
          onClick={() => chain().setTextAlign('left').run()}
        >
          左
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={editor.isActive({ textAlign: 'center' })}
          title="居中"
          onClick={() => chain().setTextAlign('center').run()}
        >
          中
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={editor.isActive({ textAlign: 'right' })}
          title="右对齐"
          onClick={() => chain().setTextAlign('right').run()}
        >
          右
        </button>
        <button
          type="button"
          className="doc-tool"
          data-active={editor.isActive({ textAlign: 'justify' })}
          title="两端对齐"
          onClick={() => chain().setTextAlign('justify').run()}
        >
          两端
        </button>

        <span className="doc-toolbar-divider" />

        <button type="button" className="doc-tool" data-active={active('link')} title="链接" onClick={toggleLink}>
          链接
        </button>
        <button type="button" className="doc-tool" title="对选中内容发起评论" onClick={onRequestComment}>
          评论
        </button>
        <button type="button" className="doc-tool" title="清除格式" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
          清除
        </button>

        {linkOpen ? (
          <div className="doc-link-editor" onMouseDown={(event) => event.stopPropagation()}>
            <input
              className="doc-link-input"
              autoFocus
              value={linkHref}
              placeholder="粘贴或输入链接，回车确认"
              aria-label="链接地址"
              onChange={(event) => setLinkHref(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setLinkOpen(false);
                }
              }}
            />
            <button type="button" className="doc-tool" onClick={applyLink}>
              确定
            </button>
          </div>
        ) : null}
      </div>
    </BubbleMenu>
  );
}

/**
 * 表格气泡：光标落在表格内时浮出结构操作。
 * 选中单元格文字时会与格式气泡重叠，因此格式气泡在表格内让位。
 */
export function DocTableMenu({ editor, editable }: { editor: Editor; editable: boolean }) {
  if (!editable) return null;

  const chain = () => editor.chain().focus();

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="docTableMenu"
      shouldShow={({ editor: current }) => current.isActive('table')}
    >
      <div className="doc-bubble" onMouseDown={(event) => event.preventDefault()}>
        <button type="button" className="doc-tool" title="在下方插入一行" onClick={() => chain().addRowAfter().run()}>
          加行
        </button>
        <button type="button" className="doc-tool" title="在右侧插入一列" onClick={() => chain().addColumnAfter().run()}>
          加列
        </button>
        <button type="button" className="doc-tool" title="删除当前行" onClick={() => chain().deleteRow().run()}>
          删行
        </button>
        <button type="button" className="doc-tool" title="删除当前列" onClick={() => chain().deleteColumn().run()}>
          删列
        </button>
        <button type="button" className="doc-tool" title="合并选中的单元格" onClick={() => chain().mergeCells().run()}>
          合并
        </button>
        <button type="button" className="doc-tool" title="拆分当前单元格" onClick={() => chain().splitCell().run()}>
          拆分
        </button>
        <button type="button" className="doc-tool" title="删除整个表格" onClick={() => chain().deleteTable().run()}>
          删表
        </button>
      </div>
    </BubbleMenu>
  );
}
