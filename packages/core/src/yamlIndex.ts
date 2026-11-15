/**
 * Index of a dbt properties file (`schema.yml`, `_models.yml`, …).
 *
 * We parse with the `yaml` library and keep the source offsets of every
 * resource, column, name and description, so that the editor can place
 * hints/diagnostics and so that edits can be made as small text edits that
 * keep comments, ordering and quoting intact.
 */
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, Pair, Scalar, YAMLMap, YAMLSeq, Node } from 'yaml';
import type { ResourceKind } from './manifest';

export type OffsetRange = [start: number, end: number];

export interface YamlDescription {
  /** The raw (unrendered) description, e.g. `{{ doc('col_x') }}`. */
  value: string;
  keyRange: OffsetRange;
  /** Range of the value in the text. Empty (start === end) when the key has no value. */
  valueRange: OffsetRange;
}

export interface YamlColumn {
  name: string;
  /** Range of the column name value. */
  nameRange: OffsetRange;
  /** Range of the whole column mapping. */
  range: OffsetRange;
  /** Column (0-based) where the keys of this mapping start. */
  keyIndent: number;
  flow: boolean;
  description?: YamlDescription;
  /** `data_type:` of the column, if present. */
  dataType?: YamlDescription;
}

export interface YamlResource {
  kind: ResourceKind;
  name: string;
  /** For sources: the name of the source the table belongs to. */
  sourceName?: string;
  nameRange: OffsetRange;
  range: OffsetRange;
  keyIndent: number;
  flow: boolean;
  description?: YamlDescription;
  columns: YamlColumn[];
  /** Information about the `columns:` key, if present. */
  columnsKey?: { keyRange: OffsetRange; flow: boolean; empty: boolean };
  /** End offset of the last key/value pair of the resource mapping. */
  lastValueEnd: number;
}

/** A top-level list such as `models:` or `seeds:`. */
export interface YamlSection {
  key: string;
  keyRange: OffsetRange;
  /** End offset of the last item, or of the key when the list is empty. */
  end: number;
  /** Column of the `-` of the items (key column + 2 when empty). */
  dashIndent: number;
  flow: boolean;
  empty: boolean;
}

export interface YamlFileIndex {
  text: string;
  resources: YamlResource[];
  sections: YamlSection[];
  errors: string[];
  /** Offsets where each line starts. */
  lineStarts: number[];
}

const SECTION_KINDS: Record<string, ResourceKind> = {
  models: 'model',
  seeds: 'seed',
  snapshots: 'snapshot',
};

function nodeRange(node: Node | null | undefined): OffsetRange | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? [r[0], r[1]] : undefined;
}

function scalarString(node: unknown): string | undefined {
  if (isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  return undefined;
}

function getPair(map: YAMLMap, key: string): Pair | undefined {
  for (const item of map.items) {
    if (isPair(item) && isScalar(item.key) && item.key.value === key) return item as Pair;
  }
  return undefined;
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineStarts[lo] };
}

function columnOf(lineStarts: number[], offset: number): number {
  return offsetToPosition(lineStarts, offset).character;
}

function readDescription(map: YAMLMap, text: string, key = 'description'): YamlDescription | undefined {
  const pair = getPair(map, key);
  if (!pair) return undefined;
  const keyRange = nodeRange(pair.key as Node)!;
  const value = pair.value as Node | null;
  const valueRange = nodeRange(value);
  const raw = scalarString(value);
  if (!valueRange || raw === undefined || valueRange[0] === valueRange[1]) {
    // `description:` with no value. Place an empty range right after the colon.
    const colon = text.indexOf(':', keyRange[1]);
    const at = colon >= 0 ? colon + 1 : keyRange[1];
    return { value: raw ?? '', keyRange, valueRange: [at, at] };
  }
  return { value: raw, keyRange, valueRange };
}

function readColumns(map: YAMLMap, text: string, lineStarts: number[]): Pick<YamlResource, 'columns' | 'columnsKey'> {
  const pair = getPair(map, 'columns');
  if (!pair) return { columns: [] };
  const seq = pair.value;
  const columnsKey = {
    keyRange: nodeRange(pair.key as Node)!,
    flow: isSeq(seq) ? Boolean((seq as YAMLSeq).flow) : false,
    empty: !isSeq(seq) || (seq as YAMLSeq).items.length === 0,
  };
  const columns: YamlColumn[] = [];
  if (isSeq(seq)) {
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const namePair = getPair(item, 'name');
      const name = scalarString(namePair?.value);
      const nameRange = nodeRange(namePair?.value as Node);
      const range = nodeRange(item);
      if (name === undefined || !nameRange || !range) continue;
      columns.push({
        name,
        nameRange,
        range,
        keyIndent: columnOf(lineStarts, nodeRange(namePair!.key as Node)![0]),
        flow: Boolean(item.flow),
        description: readDescription(item, text),
        dataType: readDescription(item, text, 'data_type'),
      });
    }
  }
  return { columns, columnsKey };
}

function lastValueEnd(map: YAMLMap): number {
  let end = nodeRange(map)?.[1] ?? 0;
  const last = map.items[map.items.length - 1];
  if (isPair(last)) {
    const r = nodeRange(last.value as Node) ?? nodeRange(last.key as Node);
    if (r) end = r[1];
  }
  return end;
}

function readResource(
  item: YAMLMap,
  kind: ResourceKind,
  text: string,
  lineStarts: number[],
  sourceName?: string,
): YamlResource | undefined {
  const namePair = getPair(item, 'name');
  const name = scalarString(namePair?.value);
  const nameRange = nodeRange(namePair?.value as Node);
  const range = nodeRange(item);
  if (name === undefined || !nameRange || !range) return undefined;
  return {
    kind,
    name,
    sourceName,
    nameRange,
    range,
    keyIndent: columnOf(lineStarts, nodeRange(namePair!.key as Node)![0]),
    flow: Boolean(item.flow),
    description: readDescription(item, text),
    ...readColumns(item, text, lineStarts),
    lastValueEnd: lastValueEnd(item),
  };
}

export function indexYaml(text: string): YamlFileIndex {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false, uniqueKeys: false });
  const lineStarts = computeLineStarts(text);
  const errors = doc.errors.map((e) => e.message);
  const resources: YamlResource[] = [];
  const sections: YamlSection[] = [];
  const root = doc.contents;
  if (!isMap(root)) return { text, resources, errors, lineStarts, sections };

  for (const section of root.items) {
    if (!isPair(section) || !isScalar(section.key)) continue;
    const key = String(section.key.value);
    const seq = section.value;
    const keyRange = nodeRange(section.key as Node)!;
    const keyColumn = columnOf(lineStarts, keyRange[0]);
    if (!isSeq(seq)) {
      // `models:` with nothing (or null) after it.
      if (seq === null || (isScalar(seq) && seq.value === null)) {
        sections.push({ key, keyRange, end: keyRange[1], dashIndent: keyColumn + 2, flow: false, empty: true });
      }
      continue;
    }
    const lastItem = seq.items[seq.items.length - 1] as Node | undefined;
    const firstItem = seq.items[0] as Node | undefined;
    let dashIndent = keyColumn + 2;
    if (firstItem && nodeRange(firstItem)) {
      const start = nodeRange(firstItem)![0];
      const lineStart = lineStarts[offsetToPosition(lineStarts, start).line];
      const dash = text.slice(lineStart, start).lastIndexOf('-');
      if (dash >= 0) dashIndent = dash;
    }
    sections.push({
      key,
      keyRange,
      end: (lastItem && nodeRange(lastItem)?.[1]) ?? keyRange[1],
      dashIndent,
      flow: Boolean(seq.flow),
      empty: seq.items.length === 0,
    });
    const kind = SECTION_KINDS[key];
    if (kind) {
      for (const item of seq.items) {
        if (!isMap(item)) continue;
        const r = readResource(item, kind, text, lineStarts);
        if (r) resources.push(r);
      }
    } else if (key === 'sources') {
      for (const src of seq.items) {
        if (!isMap(src)) continue;
        const sourceName = scalarString(getPair(src, 'name')?.value);
        const tables = getPair(src, 'tables')?.value;
        if (!sourceName || !isSeq(tables)) continue;
        for (const table of tables.items) {
          if (!isMap(table)) continue;
          const r = readResource(table, 'source', text, lineStarts, sourceName);
          if (r) resources.push(r);
        }
      }
    }
  }
  return { text, resources, errors, lineStarts, sections };
}

/** Find the resource and column at an offset, if any. */
export function findAt(
  index: YamlFileIndex,
  offset: number,
): { resource: YamlResource; column?: YamlColumn } | undefined {
  for (const resource of index.resources) {
    if (offset < resource.range[0] || offset > resource.range[1]) continue;
    for (const column of resource.columns) {
      if (offset >= column.range[0] && offset <= column.range[1]) return { resource, column };
    }
    return { resource };
  }
  return undefined;
}

/** Name of the doc block referenced by a raw description that is *only* a doc() call. */
export function docRefName(rawDescription: string | undefined): string | undefined {
  if (!rawDescription) return undefined;
  const m = /^\s*\{\{-?\s*doc\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3\s*)?\)\s*-?\}\}\s*$/.exec(rawDescription);
  if (!m) return undefined;
  // doc('package', 'name') has two arguments: the second is the name.
  return m[4] ?? m[2];
}

/** True if the raw description contains any doc() reference. */
export function hasDocRef(rawDescription: string | undefined): boolean {
  return !!rawDescription && /\{\{-?\s*doc\(/.test(rawDescription);
}

