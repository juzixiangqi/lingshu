import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { findMatches } from './find';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
  },
});

function paragraph(...parts: Array<{ text: string; bold?: boolean }>) {
  return schema.node(
    'paragraph',
    null,
    parts.map((part) =>
      schema.text(part.text, part.bold ? [schema.mark('bold')] : undefined),
    ),
  );
}

describe('文档内查找', () => {
  it('跨 mark 的连续文本可以命中', () => {
    const doc = schema.node('doc', null, [paragraph({ text: '协同', bold: true }, { text: '编辑' })]);
    const matches = findMatches(doc, '协同编辑');
    expect(matches).toEqual([{ from: 1, to: 5 }]);
  });

  it('大小写不敏感且返回全部命中', () => {
    const doc = schema.node('doc', null, [
      paragraph({ text: 'Release 与 release' }),
      paragraph({ text: 'Release 第三处' }),
    ]);
    const matches = findMatches(doc, 'release');
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ from: 1, to: 8 });
  });

  it('不跨段落匹配', () => {
    const doc = schema.node('doc', null, [paragraph({ text: '灵枢' }), paragraph({ text: '协同' })]);
    expect(findMatches(doc, '灵枢协同')).toEqual([]);
  });

  it('空关键词与空白关键词不产生命中', () => {
    const doc = schema.node('doc', null, [paragraph({ text: '灵枢协同' })]);
    expect(findMatches(doc, '')).toEqual([]);
    expect(findMatches(doc, '   ')).toEqual([]);
  });
});
