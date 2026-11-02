import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { docToMarkdown } from './docExport';

function doc(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content };
}

describe('文档导出 Markdown', () => {
  it('标题、段落与行内 marks 正确输出', () => {
    const markdown = docToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '背景' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '这是' },
            { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
            { type: 'text', text: '与' },
            { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          ],
        },
      ),
    );
    expect(markdown).toContain('## 背景');
    expect(markdown).toContain('这是**加粗**与[链接](https://example.com)');
  });

  it('有序/无序列表与嵌套缩进正确输出', () => {
    const markdown = docToMarkdown(
      doc(
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: '第一项' }] },
                {
                  type: 'orderedList',
                  attrs: { start: 1 },
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: '子项' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第三' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第四' }] }] },
          ],
        },
      ),
    );
    expect(markdown).toContain('- 第一项');
    expect(markdown).toContain('  1. 子项');
    expect(markdown).toContain('3. 第三');
    expect(markdown).toContain('4. 第四');
  });

  it('任务清单、引用与代码块正确输出', () => {
    const markdown = docToMarkdown(
      doc(
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用内容' }] }] },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const a = 1;' }],
        },
      ),
    );
    expect(markdown).toContain('- [x] 已完成');
    expect(markdown).toContain('- [ ] 待办');
    expect(markdown).toContain('> 引用内容');
    expect(markdown).toContain('```ts\nconst a = 1;\n```');
  });

  it('表格补齐列宽并转义竖线', () => {
    const markdown = docToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '名称' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '数量' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A|B' }] }],
              },
            ],
          },
        ],
      }),
    );
    expect(markdown).toContain('| 名称 | 数量 |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| A\\|B |  |');
  });

  it('图片、附件与 @提及正确输出', () => {
    const markdown = docToMarkdown(
      doc(
        { type: 'image', attrs: { src: 'https://cdn/x.png', alt: '截图' } },
        { type: 'attachment', attrs: { src: 'https://cdn/a.pdf', name: '方案.pdf', size: 1024 } },
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { id: 'u1', label: '张三' } }],
        },
      ),
    );
    expect(markdown).toContain('![截图](https://cdn/x.png)');
    expect(markdown).toContain('[附件：方案.pdf](https://cdn/a.pdf)');
    expect(markdown).toContain('@张三');
  });

  it('内嵌导图导出为导图链接', () => {
    const markdown = docToMarkdown(
      doc({ type: 'embeddedMindmap', attrs: { docId: 'mind-1', title: '项目拆解', icon: '🧠' } }),
    );
    expect(markdown).toBe('[🧠 项目拆解](/mind/mind-1)\n');
  });

  it('空文档导出空字符串', () => {
    expect(docToMarkdown(doc())).toBe('');
  });
});
