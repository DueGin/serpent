import { createElement, Fragment, type ReactNode } from 'react';

interface MarkdownProps {
  markdown: string;
  className?: string;
}

interface ListItem {
  ordered: boolean;
  value: string;
  marker: string;
}

function parseListItem(line: string): ListItem | null {
  const match = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
  if (!match) return null;
  return {
    ordered: /^\d/.test(match[1]),
    value: match[2],
    marker: match[1],
  };
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  const source = line.trim();

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\' && source[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function tableAlignments(line: string): Array<'left' | 'center' | 'right'> | null {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns: Array<'left' | 'center' | 'right'> = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return aligns;
}

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index].includes('|') && tableAlignments(lines[index + 1]) !== null;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^\s*(```|#{1,6}\s+|([-+*]|\d+[.)])\s+)/.test(line) || isTableStart(lines, index);
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.startsWith('//')) return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1].toLowerCase();
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return null;
  return href;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(<Fragment key={`${keyPrefix}-text-${part}`}>{text.slice(cursor, match.index)}</Fragment>);
    const key = `${keyPrefix}-part-${part}`;
    if (match[1] !== undefined) {
      nodes.push(<code className="markdown-inline-code" key={key}>{match[1]}</code>);
    } else {
      const href = safeHref(match[3]);
      if (href) {
        const external = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            className="markdown-link"
            href={href}
            key={key}
            {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
          >
            {match[2]}
          </a>,
        );
      } else {
        nodes.push(<Fragment key={key}>{match[2]}</Fragment>);
      }
    }
    cursor = pattern.lastIndex;
    part += 1;
  }

  if (cursor < text.length) nodes.push(<Fragment key={`${keyPrefix}-text-${part}`}>{text.slice(cursor)}</Fragment>);
  return nodes;
}

export function Markdown({ markdown, className }: MarkdownProps) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const key = `block-${index}`;
    const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(lines[index]);
    if (fence) {
      const language = fence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="markdown-code" key={key}>
          <code className={language ? `language-${language}` : undefined}>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading) {
      blocks.push(createElement(
        `h${heading[1].length}`,
        { className: 'markdown-heading', key },
        renderInline(heading[2], key),
      ));
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const alignments = tableAlignments(lines[index + 1]) || [];
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={key}>
          <table className="markdown-table">
            <thead>
              <tr>{headers.map((header, cellIndex) => (
                <th key={`${key}-head-${cellIndex}`} style={{ textAlign: alignments[cellIndex] }}>
                  {renderInline(header, `${key}-head-${cellIndex}`)}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`} style={{ textAlign: alignments[cellIndex] }}>
                      {renderInline(row[cellIndex] || '', `${key}-row-${rowIndex}-cell-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const firstItem = parseListItem(lines[index]);
    if (firstItem) {
      const ordered = firstItem.ordered;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const item = parseListItem(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(item);
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`${key}-item-${itemIndex}`}>{renderInline(item.value, `${key}-item-${itemIndex}`)}</li>
      ));
      blocks.push(ordered
        ? <ol className="markdown-list" start={Number.parseInt(firstItem.marker, 10)} key={key}>{children}</ol>
        : <ul className="markdown-list" key={key}>{children}</ul>);
      continue;
    }

    const paragraph = [lines[index].trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p className="markdown-paragraph" key={key}>{renderInline(paragraph.join(' '), key)}</p>);
  }

  return <div className={['markdown', className].filter(Boolean).join(' ')}>{blocks}</div>;
}
