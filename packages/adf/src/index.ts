export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfResult {
  markdown: string;
  /** 遇到无法识别的节点类型时记录，内容以纯文本保留。 */
  warnings: string[];
}

function applyMarks(text: string, marks: AdfMark[] = []): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        out = `[${out}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

class Converter {
  readonly warnings: string[] = [];

  inline(nodes: AdfNode[] = []): string {
    return nodes.map((n) => this.inlineNode(n)).join('');
  }

  private inlineNode(node: AdfNode): string {
    switch (node.type) {
      case 'text':
        return applyMarks(node.text ?? '', node.marks);
      case 'hardBreak':
        return '  \n';
      case 'mention':
        return String(node.attrs?.text ?? '@unknown');
      case 'emoji':
        return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
      case 'inlineCard':
        return String(node.attrs?.url ?? '');
      default:
        return this.fallback(node);
    }
  }

  block(node: AdfNode, indent = ''): string {
    switch (node.type) {
      case 'paragraph':
        return `${indent}${this.inline(node.content)}`;
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        return `${'#'.repeat(level)} ${this.inline(node.content)}`;
      }
      case 'bulletList':
        return this.list(node, indent, false);
      case 'orderedList':
        return this.list(node, indent, true);
      case 'codeBlock': {
        const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
        const body = (node.content ?? []).map((c) => c.text ?? '').join('');
        return `\`\`\`${lang}\n${body}\n\`\`\``;
      }
      case 'blockquote':
        return this.blocks(node.content)
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
      case 'rule':
        return '---';
      case 'panel':
        return this.blocks(node.content);
      case 'table':
        return this.table(node);
      default:
        return this.fallback(node);
    }
  }

  blocks(nodes: AdfNode[] = []): string {
    return nodes.map((n) => this.block(n)).join('\n\n');
  }

  private list(node: AdfNode, indent: string, ordered: boolean): string {
    return (node.content ?? [])
      .map((item, i) => {
        const marker = ordered ? `${i + 1}.` : '-';
        const children = item.content ?? [];
        const parts = children.map((child, idx) => {
          if (child.type === 'bulletList' || child.type === 'orderedList') {
            return this.list(child, `${indent}  `, child.type === 'orderedList');
          }
          const text = this.block(child);
          return idx === 0 ? text : `${indent}  ${text}`;
        });
        return `${indent}${marker} ${parts.join('\n')}`;
      })
      .join('\n');
  }

  private table(node: AdfNode): string {
    const rows = (node.content ?? []).map((row) =>
      (row.content ?? []).map((cell) =>
        this.blocks(cell.content).replace(/\n+/g, ' ').replace(/\|/g, '\\|'),
      ),
    );
    if (rows.length === 0) return '';
    const header = rows[0]!;
    const sep = header.map(() => '---');
    const lines = [header, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`);
    return lines.join('\n');
  }

  private fallback(node: AdfNode): string {
    this.warnings.push(`未知节点类型: ${node.type}`);
    if (node.text) return node.text;
    if (node.content) return this.inline(node.content);
    return '';
  }
}

/** 把 ADF 文档转成 Markdown。输入为 null 或空文档时返回空字符串。 */
export function adfToMarkdown(doc: AdfNode | null | undefined): AdfResult {
  if (!doc) return { markdown: '', warnings: [] };
  const converter = new Converter();
  const markdown = converter.blocks(doc.content).trim();
  return { markdown, warnings: converter.warnings };
}
