import type { DocKind } from '@lingshu/shared';

/** 没有设置封面图标时，按文档类型兜底的图标 */
export const DEFAULT_DOC_ICON: Record<DocKind, string> = {
  doc: '📄',
  sheet: '📊',
  mindmap: '🧠',
};

/** 图标面板的候选集：覆盖文档、表格、导图常用语义，不引入额外依赖 */
export const DOC_ICON_PRESETS = [
  '📄',
  '📝',
  '📋',
  '📅',
  '🗒️',
  '📊',
  '📈',
  '🎯',
  '🚀',
  '💡',
  '✅',
  '🔥',
  '⭐️',
  '📌',
  '📁',
  '🗂️',
  '🤝',
  '🏷️',
  '🧾',
  '🎉',
  '🛠️',
  '🧠',
];
