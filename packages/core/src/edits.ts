/**
 * Minimal text edits to dbt YAML files. Instead of re-serialising the whole
 * document (which would lose comments and formatting), we insert or replace
 * just the text that changes.
 */
import { offsetToPosition, YamlColumn, YamlDescription, YamlFileIndex, YamlResource } from './yamlIndex';

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
  return setKey(index, target, 'description', target.description, description, target.nameRange[1]);
}

/**
 * Set `key: value` in a mapping: replace the existing value, or insert a
 * new line after `afterOffset`'s line with the mapping's indentation.
 */
function setKey(
  index: YamlFileIndex,
  target: Pick<YamlColumn, 'nameRange' | 'keyIndent' | 'flow'>,
  key: string,
  existing: YamlDescription | undefined,
  value: string,
  afterOffset: number,
): TextEdit {
  const { text } = index;
  if (existing) {
    const [start, end] = existing.valueRange;
    const scalar = target.flow ? JSON.stringify(value) : formatYamlScalar(value, target.keyIndent);
    const needsSpace = start === end && text[start - 1] === ':';
    return { start, end, newText: (needsSpace ? ' ' : '') + scalar };
  }
  if (target.flow) {
    const at = target.nameRange[1];
    return { start: at, end: at, newText: `, ${key}: ${JSON.stringify(value)}` };
  }
  const at = insertPointAtLineEnd(text, afterOffset);
  const nl = newline(text);
  const scalar = formatYamlScalar(value, target.keyIndent).replace(/\n/g, nl);
  return { start: at, end: at, newText: `${nl}${' '.repeat(target.keyIndent)}${key}: ${scalar}` };
}

/** Set (insert or replace) `data_type` of a column; a new key goes after the description, or the name. */
export function setColumnDataType(index: YamlFileIndex, column: YamlColumn, dataType: string): TextEdit {
  const after = column.description ? Math.max(column.description.valueRange[1], column.description.keyRange[1]) : column.nameRange[1];
  return setKey(index, column, 'data_type', column.dataType, dataType, after);
}

/** Remove `data_type` from a column. */
export function removeColumnDataType(index: YamlFileIndex, column: YamlColumn): TextEdit | undefined {
  return removeKey(index, column, column.dataType);
}

/**
 * Add column entries (name only, or name + description) to a resource.
 * Appends after the last existing column, or creates a `columns:` key.
 */
export function addColumns(
  index: YamlFileIndex,
  resource: YamlResource,
  columns: { name: string; description?: string; dataType?: string }[],
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
        if (c.dataType) s += `${nl}${keyPad}data_type: ${formatYamlScalar(c.dataType, dashIndent + keyOffset)}`;
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

/**
 * Remove the `description:` of a column or resource (block style only):
 * deletes its whole line(s). Returns undefined when there is nothing to remove.
 */
export function removeDescription(
  index: YamlFileIndex,
  target: Pick<YamlColumn, 'description' | 'flow'>,
): TextEdit | undefined {
  return removeKey(index, target, target.description);
}

function removeKey(index: YamlFileIndex, target: Pick<YamlColumn, 'flow'>, d: YamlDescription | undefined): TextEdit | undefined {
  if (!d) return undefined;
  if (target.flow) return { start: d.valueRange[0], end: d.valueRange[1], newText: '""' };
  const { text, lineStarts } = index;
  const start = lineStarts[offsetToPosition(lineStarts, d.keyRange[0]).line];
  // End: after the newline that ends the value (block scalars span several lines).
  let end = Math.max(d.valueRange[1], d.keyRange[1]);
  if (end > 0 && text[end - 1] === '\n') return { start, end, newText: '' };
  const nl = text.indexOf('\n', end);
  end = nl < 0 ? text.length : nl + 1;
  return { start, end, newText: '' };
}

export interface NewResourceEntry {
  name: string;
  description?: string;
  columns?: { name: string; description?: string; dataType?: string }[];
}

const SECTION_FOR_KIND: Record<string, string> = { model: 'models', seed: 'seeds', snapshot: 'snapshots' };

function renderEntry(entry: NewResourceEntry, dashIndent: number, nl: string): string {
  const key = ' '.repeat(dashIndent + 2);
  const lines = [`${' '.repeat(dashIndent)}- name: ${formatYamlScalar(entry.name, dashIndent + 2)}`];
  if (entry.description) lines.push(`${key}description: ${formatYamlScalar(entry.description, dashIndent + 2).replace(/\n/g, nl)}`);
  if (entry.columns && entry.columns.length > 0) {
    lines.push(`${key}columns:`);
    for (const c of entry.columns) {
      lines.push(`${key}  - name: ${formatYamlScalar(c.name, dashIndent + 6)}`);
      if (c.description) lines.push(`${key}    description: ${formatYamlScalar(c.description, dashIndent + 6).replace(/\n/g, nl)}`);
      if (c.dataType) lines.push(`${key}    data_type: ${formatYamlScalar(c.dataType, dashIndent + 6)}`);
    }
  }
  return lines.join(nl);
}

/**
 * Add a model/seed/snapshot entry to an existing properties file: appended to
 * its `models:` (etc.) list, or in a new list at the end of the file.
 */
export function addResourceEntry(index: YamlFileIndex, kind: 'model' | 'seed' | 'snapshot', entry: NewResourceEntry): TextEdit | undefined {
  const { text } = index;
  const nl = newline(text);
  const key = SECTION_FOR_KIND[kind];
  const section = index.sections.find((s) => s.key === key);
  if (section?.flow) return undefined;
  if (section && !section.empty) {
    const at = insertPointAtLineEnd(text, section.end);
    return { start: at, end: at, newText: nl + renderEntry(entry, section.dashIndent, nl) };
  }
  if (section && section.empty) {
    const at = insertPointAtLineEnd(text, section.keyRange[1]);
    // Replace whatever follows the key on its line (`: []`, `:`, a null).
    return { start: section.keyRange[1], end: at, newText: `:${nl}${renderEntry(entry, section.dashIndent, nl)}` };
  }
  const trimmedEnd = text.replace(/\s+$/, '').length;
  const prefix = trimmedEnd === 0 ? '' : nl + nl;
  return { start: trimmedEnd, end: text.length, newText: `${prefix}${key}:${nl}${renderEntry(entry, 2, nl)}${nl}` };
}

/** Text of a new properties file holding one entry. */
export function newPropertiesFile(kind: 'model' | 'seed' | 'snapshot', entry: NewResourceEntry): string {
  return `version: 2\n\n${SECTION_FOR_KIND[kind]}:\n${renderEntry(entry, 2, '\n')}\n`;
}

/** Replace the contents of a `{% docs %}` block (offsets from parseDocBlocks), keeping its tags. */
export function replaceDocBlockContents(
  text: string,
  block: { start: number; end: number; name: string },
  contents: string,
): TextEdit {
  const original = text.slice(block.start, block.end);
  const open = /^\{%-?\s*docs\s+\w+\s*-?%\}/.exec(original)?.[0] ?? `{% docs ${block.name} %}`;
  const close = /\{%-?\s*enddocs\s*-?%\}$/.exec(original)?.[0] ?? '{% enddocs %}';
  const nl = newline(text);
  return { start: block.start, end: block.end, newText: `${open}${nl}${contents.trim().replace(/\r?\n/g, nl)}${nl}${close}` };
}
