import type { JSONContent } from '@tiptap/core';

const INDENT = '  ';

/** 只转义会破坏 Markdown 结构的字符，中文标点保持原样。 */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (char) => `\\${char}`);
}

/** 行内 marks 按顺序包裹，先处理内层（代码），再叠加强调与链接。 */
function renderMarks(text: string, marks: JSONContent['marks'] = []): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = `**${out}**`;
        break;
      case 'italic':
        out = `*${out}*`;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'underline':
        out = `<u>${out}</u>`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'highlight':
        out = `==${out}==`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        if (href) out = `[${out}](${href})`;
        break;
      }
      default:
        // commentMark 等协同专用标记不导出，避免泄漏内部 id
        break;
    }
  }
  return out;
}

function renderInline(nodes: JSONContent[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return renderMarks(escapeText(node.text ?? ''), node.marks);
      if (node.type === 'hardBreak') return '  \n';
      if (node.type === 'mention') return `@${String(node.attrs?.label ?? '')}`;
      if (node.type === 'image') {
        return `![${String(node.attrs?.alt ?? '')}](${String(node.attrs?.src ?? '')})`;
      }
      // 未知行内节点退化为纯文本，保证内容不丢
      return renderInline(node.content);
    })
    .join('');
}

function renderCell(cell: JSONContent): string {
  return (cell.content ?? [])
    .map((child) =>
      child.type === 'paragraph' ? renderInline(child.content) : renderBlocks([child], 0).join(' '),
    )
    .join('<br>')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function renderTable(table: JSONContent): string {
  const rows = table.content ?? [];
  const first = rows[0];
  if (!first) return '';
  const cellsOf = (row: JSONContent): string[] => (row.content ?? []).map(renderCell);
  const header = cellsOf(first);
  const width = Math.max(header.length, ...rows.slice(1).map((row) => (row.content ?? []).length));
  const padCells = (cells: string[]): string[] => [
    ...cells,
    ...Array<string>(Math.max(0, width - cells.length)).fill(''),
  ];
  const lines = [
    `| ${padCells(header).join(' | ')} |`,
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${padCells(cellsOf(row)).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function renderList(list: JSONContent, depth: number): string {
  const ordered = list.type === 'orderedList';
  const start = Number(list.attrs?.start ?? 1);
  const pad = INDENT.repeat(depth);
  return (list.content ?? [])
    .map((item, index) => {
      const marker = ordered ? `${start + index}. ` : '- ';
      const lines: string[] = [];
      (item.content ?? []).forEach((child, childIndex) => {
        if (child.type === 'paragraph') {
          const text = renderInline(child.content);
          lines.push(childIndex === 0 ? `${pad}${marker}${text}` : `${pad}${INDENT}${text}`);
          return;
        }
        if (child.type === 'bulletList' || child.type === 'orderedList') {
          lines.push(renderList(child, depth + 1));
          return;
        }
        if (child.type === 'taskList') {
          lines.push(renderTaskList(child, depth + 1));
          return;
        }
        lines.push(renderBlocks([child], depth + 1).join('\n'));
      });
      return lines.join('\n');
    })
    .join('\n');
}

function renderTaskList(list: JSONContent, depth: number): string {
  const pad = INDENT.repeat(depth);
  return (list.content ?? [])
    .map((item) => {
      const checked = Boolean(item.attrs?.checked);
      const first = (item.content ?? []).find((child) => child.type === 'paragraph');
      const text = first ? renderInline(first.content) : '';
      const lines = [`${pad}- [${checked ? 'x' : ' '}] ${text}`];
      for (const child of item.content ?? []) {
        if (child.type === 'taskList') lines.push(renderTaskList(child, depth + 1));
      }
      return lines.join('\n');
    })
    .join('\n');
}

function renderBlocks(nodes: JSONContent[], depth = 0): string[] {
  const pad = INDENT.repeat(depth);
  return nodes.flatMap((node) => {
    switch (node.type) {
      case 'paragraph': {
        const text = renderInline(node.content);
        return text ? [`${pad}${text}`] : [''];
      }
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
        return [`${'#'.repeat(level)} ${renderInline(node.content)}`];
      }
      case 'bulletList':
      case 'orderedList':
        return [renderList(node, depth)];
      case 'taskList':
        return [renderTaskList(node, depth)];
      case 'blockquote': {
        const inner = renderBlocks(node.content ?? []).join('\n\n');
        return inner
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'));
      }
      case 'codeBlock': {
        const code = (node.content ?? []).map((child) => child.text ?? '').join('');
        const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
        return [`\`\`\`${language}\n${code}\n\`\`\``];
      }
      case 'horizontalRule':
        return ['---'];
      case 'image':
        return [`![${String(node.attrs?.alt ?? '')}](${String(node.attrs?.src ?? '')})`];
      case 'attachment':
        return [`[附件：${String(node.attrs?.name ?? '附件')}](${String(node.attrs?.src ?? '')})`];
      case 'embeddedMindmap':
        return [`[🧠 ${String(node.attrs?.title ?? '思维导图')}](/mind/${String(node.attrs?.docId ?? '')})`];
      case 'table':
        return [renderTable(node)];
      default:
        return node.content ? renderBlocks(node.content, depth) : [];
    }
  });
}

/**
 * 把编辑器文档（ProseMirror JSON）转换成 Markdown。
 * 覆盖当前 schema 的全部节点：标题、列表、任务清单、引用、代码块、表格、图片、附件与 @提及。
 */
export function docToMarkdown(content: JSONContent): string {
  const body = renderBlocks(content.content ?? [], 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body ? `${body}\n` : '';
}
