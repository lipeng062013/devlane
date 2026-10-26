import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from '../src/index';
import type { AdfNode } from '../src/index';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: AdfNode['marks']): AdfNode => ({ type: 'text', text, marks });

describe('adfToMarkdown', () => {
  it('空输入返回空字符串', () => {
    expect(adfToMarkdown(null)).toEqual({ markdown: '', warnings: [] });
    expect(adfToMarkdown(doc())).toEqual({ markdown: '', warnings: [] });
  });

  it('转换段落与行内样式', () => {
    const result = adfToMarkdown(
      doc(p(t('粗', [{ type: 'strong' }]), t('斜', [{ type: 'em' }]), t('码', [{ type: 'code' }]))),
    );
    expect(result.markdown).toBe('**粗***斜*`码`');
  });

  it('转换链接', () => {
    const result = adfToMarkdown(
      doc(p(t('文档', [{ type: 'link', attrs: { href: 'https://example.com' } }]))),
    );
    expect(result.markdown).toBe('[文档](https://example.com)');
  });

  it('转换标题并限制层级到 1 到 6', () => {
    const result = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('验收标准')] },
        { type: 'heading', attrs: { level: 9 }, content: [t('超限')] },
      ),
    );
    expect(result.markdown).toBe('## 验收标准\n\n###### 超限');
  });

  it('转换有序与无序列表及嵌套', () => {
    const item = (text: string, nested?: AdfNode): AdfNode => ({
      type: 'listItem',
      content: nested ? [p(t(text)), nested] : [p(t(text))],
    });
    const nested: AdfNode = { type: 'bulletList', content: [item('子项')] };
    const result = adfToMarkdown(
      doc(
        { type: 'bulletList', content: [item('甲', nested), item('乙')] },
        { type: 'orderedList', content: [item('一'), item('二')] },
      ),
    );
    expect(result.markdown).toBe('- 甲\n  - 子项\n- 乙\n\n1. 一\n2. 二');
  });

  it('转换代码块', () => {
    const result = adfToMarkdown(
      doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] }),
    );
    expect(result.markdown).toBe('```ts\nconst a = 1;\n```');
  });

  it('转换引用块', () => {
    const result = adfToMarkdown(doc({ type: 'blockquote', content: [p(t('引用'))] }));
    expect(result.markdown).toBe('> 引用');
  });

  it('转换表格并转义竖线', () => {
    const cell = (type: string, text: string): AdfNode => ({ type, content: [p(t(text))] });
    const result = adfToMarkdown(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', '字段'), cell('tableHeader', '值')] },
          { type: 'tableRow', content: [cell('tableCell', 'a|b'), cell('tableCell', '1')] },
        ],
      }),
    );
    expect(result.markdown).toBe('| 字段 | 值 |\n| --- | --- |\n| a\\|b | 1 |');
  });

  it('提及节点输出文本', () => {
    const result = adfToMarkdown(doc(p({ type: 'mention', attrs: { text: '@张三' } })));
    expect(result.markdown).toBe('@张三');
  });

  it('未知块节点保留文本并记录警告', () => {
    const result = adfToMarkdown(
      doc({ type: 'extension', content: [t('保留内容')] }, p(t('后续'))),
    );
    expect(result.markdown).toBe('保留内容\n\n后续');
    expect(result.warnings).toEqual(['未知节点类型: extension']);
  });
});
