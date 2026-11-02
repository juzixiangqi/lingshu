import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  /** 除中文标签外额外匹配的拼音/英文关键词 */
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

/**
 * 斜杠命令：空行输入 `/` 唤起插入菜单。
 * 与顶部「+ 插入」覆盖同一批块级结构，把「先找按钮」变成「输入即得」。
 */
const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h1',
    label: '标题 1',
    hint: 'H1',
    keywords: 'biaoti heading1 h1',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    label: '标题 2',
    hint: 'H2',
    keywords: 'biaoti heading2 h2',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    label: '标题 3',
    hint: 'H3',
    keywords: 'biaoti heading3 h3',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet',
    label: '无序列表',
    hint: '•',
    keywords: 'wuxu bullet list',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    label: '有序列表',
    hint: '1.',
    keywords: 'youxu ordered list',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: 'task',
    label: '任务清单',
    hint: '☑',
    keywords: 'renwu task todo checklist',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: 'quote',
    label: '引用',
    hint: '❝',
    keywords: 'yinyong quote blockquote',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: 'code',
    label: '代码块',
    hint: '</>',
    keywords: 'daima code block',
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    label: '分割线',
    hint: '—',
    keywords: 'fengexian divider hr',
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: 'table',
    label: '表格',
    hint: '3×3',
    keywords: 'biaoge table',
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(keyword) || item.keywords.includes(keyword),
  );
}

/**
 * 弹窗沿用 @提及 的原生 DOM 方案，避免为一次性下拉引入 UI 依赖。
 * 选中项通过 Suggestion 的 command 回传，执行时先删掉输入的 `/` 与查询词。
 */
export function createSlashExtension() {
  return Extension.create({
    name: 'slashCommand',

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: '/',
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => filterItems(query),
          command: ({ editor, range, props }) => {
            props.run(editor, range);
          },
          render: () => {
            let popup: HTMLDivElement | null = null;
            let latest: SuggestionProps<SlashItem> | null = null;
            let candidates: SlashItem[] = [];
            let index = 0;
            let select: ((item: SlashItem) => void) | null = null;

            const paint = (): void => {
              if (!popup) return;
              popup.replaceChildren();
              if (!candidates.length) {
                const empty = document.createElement('div');
                empty.className = 'slash-empty';
                empty.textContent = '没有匹配的插入项';
                popup.append(empty);
                return;
              }
              candidates.forEach((item, itemIndex) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = itemIndex === index ? 'slash-item active' : 'slash-item';
                const name = document.createElement('span');
                name.textContent = item.label;
                const hint = document.createElement('span');
                hint.className = 'slash-item-hint';
                hint.textContent = item.hint;
                row.append(name, hint);
                // mousedown 阻止默认行为：否则编辑器先失焦，Suggestion 会提前退出
                row.addEventListener('mousedown', (event) => {
                  event.preventDefault();
                  select?.(item);
                });
                popup?.append(row);
              });
              const rect = latest?.clientRect?.();
              if (rect) {
                const gap = 6;
                // 先恢复 CSS 上限再量真实高度，避免上一次压缩后的高度影响判断
                popup.style.maxHeight = '';
                const height = popup.offsetHeight;
                const width = popup.offsetWidth;
                const belowSpace = window.innerHeight - rect.bottom - gap - 8;
                const aboveSpace = rect.top - gap - 8;
                // 下方放不下且上方更宽裕时向上翻转；两侧都不足时压缩高度而不是被裁掉
                const flip = belowSpace < Math.min(height, 240) && aboveSpace > belowSpace;
                const space = Math.max(80, flip ? aboveSpace : belowSpace);
                const visible = Math.min(height, space);
                popup.style.maxHeight = `${Math.round(space)}px`;
                popup.style.top = `${Math.round(flip ? Math.max(8, rect.top - gap - visible) : rect.bottom + gap)}px`;
                popup.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
              }
            };

            const sync = (props: SuggestionProps<SlashItem>): void => {
              latest = props;
              candidates = props.items;
              index = 0;
              select = props.command;
              if (!popup) {
                popup = document.createElement('div');
                popup.className = 'slash-popup';
                document.body.append(popup);
              }
              paint();
            };

            return {
              onStart: sync,
              onUpdate: sync,
              onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                // 中文输入法组词过程中的回车属于确认候选，不能当作选中命令
                if (event.isComposing) return false;
                if (!candidates.length) return false;
                if (event.key === 'ArrowDown') {
                  index = (index + 1) % candidates.length;
                  paint();
                  return true;
                }
                if (event.key === 'ArrowUp') {
                  index = (index + candidates.length - 1) % candidates.length;
                  paint();
                  return true;
                }
                if (event.key === 'Enter') {
                  const item = candidates[index];
                  if (item) select?.(item);
                  return true;
                }
                return false;
              },
              onExit: () => {
                popup?.remove();
                popup = null;
                latest = null;
                candidates = [];
                select = null;
              },
            };
          },
        }),
      ];
    },
  });
}
