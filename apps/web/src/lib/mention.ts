import Mention from '@tiptap/extension-mention';
import type { Editor, Range } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type { DocMember } from '@lingshu/shared';

/** 输入 @ 后最多展示的候选人数，面板不宜过长。 */
const CANDIDATE_LIMIT = 6;

interface MentionExtensionOptions {
  /** 用 ref 读取成员列表，避免成员刷新时重建编辑器（重建会丢掉协同状态） */
  getMembers: () => DocMember[];
  /** 选中成员后回调，用于上报 @提及（站内通知 + webhook） */
  onMention: (member: DocMember, excerpt: string) => void;
}

/** 取提及位置前后的正文作为通知摘要，去掉多余空白。 */
function excerptAround(editor: Editor, range: Range): string {
  const from = Math.max(0, range.from - 80);
  const to = Math.min(editor.state.doc.content.size, range.to + 120);
  return editor.state.doc
    .textBetween(from, to, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * @提及：TipTap mention 扩展 + 自建候选弹窗。
 * 弹窗用原生 DOM 渲染并挂在 body 上，避免为一次性的下拉引入额外 UI 依赖。
 */
export function createMentionExtension({ getMembers, onMention }: MentionExtensionOptions) {
  return Mention.configure({
    HTMLAttributes: { class: 'doc-mention' },
    suggestion: {
      char: '@',
      items: ({ query }) => {
        const keyword = query.trim().toLowerCase();
        const members = getMembers();
        const matched = keyword
          ? members.filter(
              (member) =>
                member.displayName.toLowerCase().includes(keyword) ||
                member.email.toLowerCase().includes(keyword),
            )
          : members;
        return matched.slice(0, CANDIDATE_LIMIT);
      },
      command: ({ editor, range, props }) => {
        // 候选来自 items，结构是 DocMember，这里收窄后写入 mention 节点属性
        const member = props as unknown as DocMember;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: 'mention', attrs: { id: member.userId, label: member.displayName } },
            { type: 'text', text: ' ' },
          ])
          .run();
        onMention(member, excerptAround(editor, range));
      },
      render: () => {
        let popup: HTMLDivElement | null = null;
        let latest: SuggestionProps<DocMember> | null = null;
        let candidates: DocMember[] = [];
        let index = 0;
        let select: ((member: DocMember) => void) | null = null;

        const paint = (): void => {
          if (!popup) return;
          popup.replaceChildren();
          if (!candidates.length) {
            const empty = document.createElement('div');
            empty.className = 'mention-empty';
            empty.textContent = '没有匹配的文档成员';
            popup.append(empty);
            return;
          }
          candidates.forEach((member, memberIndex) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = memberIndex === index ? 'mention-item active' : 'mention-item';
            row.textContent = `${member.displayName}（${member.email}）`;
            // mousedown 阻止默认行为，避免编辑器失焦导致候选面板提前关闭
            row.addEventListener('mousedown', (event) => {
              event.preventDefault();
              select?.(member);
            });
            popup?.append(row);
          });
          const rect = latest?.clientRect?.();
          if (rect) {
            popup.style.left = `${Math.round(rect.left)}px`;
            popup.style.top = `${Math.round(rect.bottom + 6)}px`;
          }
        };

        const sync = (props: SuggestionProps<DocMember>): void => {
          latest = props;
          candidates = props.items;
          index = 0;
          select = props.command;
          if (!popup) {
            popup = document.createElement('div');
            popup.className = 'mention-popup';
            document.body.append(popup);
          }
          paint();
        };

        return {
          onStart: sync,
          onUpdate: sync,
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
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
              const member = candidates[index];
              if (member) select?.(member);
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
    },
  });
}
