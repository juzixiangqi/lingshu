import { useEffect, useRef, useState } from 'react';
import type { DocKind } from '@lingshu/shared';
import { DEFAULT_DOC_ICON, DOC_ICON_PRESETS } from '../lib/docIcons';

interface DocIconPickerProps {
  icon: string | null;
  kind: DocKind;
  editable: boolean;
  /** 保存失败由页面统一提示；这里只负责关闭面板 */
  onChange: (icon: string | null) => Promise<void>;
}

/**
 * 封面图标：点击标题左侧图标弹出候选面板。
 * 只读成员只展示图标，不渲染可点击入口。
 */
export function DocIconPicker({ icon, kind, editable, onChange }: DocIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = async (next: string | null): Promise<void> => {
    setOpen(false);
    if (next === icon) return;
    setSaving(true);
    try {
      await onChange(next);
    } catch {
      // 失败提示由页面统一展示，这里只保证面板可再次打开
    } finally {
      setSaving(false);
    }
  };

  const shown = icon || DEFAULT_DOC_ICON[kind];

  if (!editable) {
    return <span className="doc-icon-static" aria-label="文档图标">{shown}</span>;
  }

  return (
    <div className="doc-icon-picker" ref={rootRef}>
      <button
        type="button"
        className="doc-icon-button"
        title="设置封面图标"
        aria-expanded={open}
        aria-label="设置封面图标"
        disabled={saving}
        onClick={() => setOpen((value) => !value)}
      >
        {shown}
      </button>
      {open ? (
        <div className="doc-icon-menu" role="menu">
          {DOC_ICON_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="menuitem"
              className={preset === icon ? 'doc-icon-option active' : 'doc-icon-option'}
              onClick={() => void choose(preset)}
            >
              {preset}
            </button>
          ))}
          {icon ? (
            <button type="button" className="doc-icon-remove" onClick={() => void choose(null)}>
              移除图标
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
