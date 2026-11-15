/**
 * Minimal text edits to dbt YAML files. Instead of re-serialising the whole
 * document (which would lose comments and formatting), we insert or replace
 * just the text that changes.
 */
import { offsetToPosition, YamlColumn, YamlFileIndex, YamlResource } from './yamlIndex';

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

/** Format a string as a YAML scalar that is safe to put after `key: `. */
export function formatYamlScalar(value: string, indent: number): string {
  if (value.includes('\n')) {
    const pad = ' '.repeat(indent + 2);
    const lines = value.replace(/\s+$/, '').split('\n');
    return `|\n${lines.map((l) => (l.length > 0 ? pad + l : '')).join('\n')}`;
  }
  const plainSafe =
    /^[\p{L}\p{N}(][\p{L}\p{N} _.,;()/\-'%+=<>]*$/u.test(value) &&
    !/\s$/.test(value) &&
    !RESERVED.test(value) &&
    !/^[\d.+-]+$/.test(value);
  if (plainSafe) return value;
  return JSON.stringify(value);
}

function lineEndAt(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === '\n') return offset - 1;
  const nl = text.indexOf('\n', offset);
  return nl < 0 ? text.length : nl;
}

/** Same as lineEndAt, but skips over a trailing `\r` so inserts stay before CRLF. */
function insertPointAtLineEnd(text: string, offset: number): number {
  const end = lineEndAt(text, offset);
  return end > 0 && text[end - 1] === '\r' ? end - 1 : end;
}

function newline(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Set (insert or replace) the description of a column. */
export function setColumnDescription(index: YamlFileIndex, column: YamlColumn, description: string): TextEdit {
  return setDescription(index, column, description);
}

/** Set (insert or replace) the description of a model/source/seed. */
export function setResourceDescription(index: YamlFileIndex, resource: YamlResource, description: string): TextEdit {
  return setDescription(index, resource, description);
}

function setDescription(
  index: YamlFileIndex,
  target: Pick<YamlColumn, 'description' | 'nameRange' | 'keyIndent' | 'flow'>,
  description: string,
): TextEdit {
  const { text } = index;
  if (target.description) {
    const [start, end] = target.description.valueRange;
    const scalar = target.flow ? JSON.stringify(description) : formatYamlScalar(description, target.keyIndent);
    const needsSpace = start === end && text[start - 1] === ':';
    return { start, end, newText: (needsSpace ? ' ' : '') + scalar };
  }
  if (target.flow) {
    const at = target.nameRange[1];
    return { start: at, end: at, newText: `, description: ${JSON.stringify(description)}` };
  }
  const at = insertPointAtLineEnd(text, target.nameRange[1]);
  const nl = newline(text);
  const scalar = formatYamlScalar(description, target.keyIndent).replace(/\n/g, nl);
  return { start: at, end: at, newText: `${nl}${' '.repeat(target.keyIndent)}description: ${scalar}` };
}

/**
 * Add column entries (name only, or name + description) to a resource.
 * Appends after the last existing column, or creates a `columns:` key.
 */
export function addColumns(
  index: YamlFileIndex,
  resource: YamlResource,
  columns: { name: string; description?: string }[],
): TextEdit | undefined {
  if (columns.length === 0) return undefined;
  const { text, lineStarts } = index;
  const nl = newline(text);
  if (resource.flow || resource.columnsKey?.flow) return undefined;

  const render = (dashIndent: number, keyOffset: number) =>
    columns
      .map((c) => {
        const pad = ' '.repeat(dashIndent);
        const keyPad = ' '.repeat(dashIndent + keyOffset);
        let s = `${pad}-${' '.repeat(keyOffset - 1)}name: ${formatYamlScalar(c.name, dashIndent + keyOffset)}`;
        if (c.description) s += `${nl}${keyPad}description: ${formatYamlScalar(c.description, dashIndent + keyOffset).replace(/\n/g, nl)}`;
        return s;
      })
      .join(nl);

  const last = resource.columns[resource.columns.length - 1];
  if (last && !last.flow) {
    const keyStartLine = offsetToPosition(lineStarts, last.range[0]);
    const lineText = text.slice(lineStarts[keyStartLine.line], last.range[0]);
    const dash = lineText.lastIndexOf('-');
    const dashIndent = dash >= 0 ? dash : Math.max(0, last.keyIndent - 2);
    const keyOffset = last.keyIndent - dashIndent;
    const at = insertPointAtLineEnd(text, last.range[1]);
    return { start: at, end: at, newText: nl + render(dashIndent, keyOffset > 0 ? keyOffset : 2) };
  }

  if (resource.columnsKey && resource.columnsKey.empty) {
    // `columns:` or `columns: []`: replace the value.
    const keyEnd = resource.columnsKey.keyRange[1];
    const lineEnd = insertPointAtLineEnd(text, keyEnd);
    const indent = offsetToPosition(lineStarts, resource.columnsKey.keyRange[0]).character;
    return { start: keyEnd, end: lineEnd, newText: `:${nl}${render(indent + 2, 2)}` };
  }

  const at = insertPointAtLineEnd(text, resource.lastValueEnd);
  const indent = resource.keyIndent;
  return { start: at, end: at, newText: `${nl}${' '.repeat(indent)}columns:${nl}${render(indent + 2, 2)}` };
}

/** Apply edits to a string (edits must not overlap). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}
