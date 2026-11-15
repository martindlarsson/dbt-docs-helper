/**
 * `{% docs name %} … {% enddocs %}` blocks in Markdown files, and the
 * naming convention for new column blocks.
 */
import type { Resource } from './manifest';

export interface ParsedDocBlock {
  name: string;
  contents: string;
  /** Offset of `{% docs` */
  start: number;
  /** Offset just after `{% enddocs %}` */
  end: number;
  /** Offset range of the name inside the opening tag. */
  nameRange: [number, number];
}

const BLOCK_RE = /\{%-?\s*docs\s+([A-Za-z_][\w]*)\s*-?%\}([\s\S]*?)\{%-?\s*enddocs\s*-?%\}/g;

export function parseDocBlocks(text: string): ParsedDocBlock[] {
  const blocks: ParsedDocBlock[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const start = m.index ?? 0;
    const nameStart = start + m[0].indexOf(m[1], 2);
    blocks.push({
      name: m[1],
      contents: m[2].trim(),
      start,
      end: start + m[0].length,
      nameRange: [nameStart, nameStart + m[1].length],
    });
  }
  return blocks;
}

/** Text to append to a docs file to add a new block. */
export function docBlockAppendText(existingText: string, name: string, contents: string): string {
  let prefix = '';
  if (existingText.length > 0) {
    prefix = existingText.endsWith('\n\n') ? '' : existingText.endsWith('\n') ? '\n' : '\n\n';
  }
  return `${prefix}{% docs ${name} %}\n${contents.trim()}\n{% enddocs %}\n`;
}

export const DEFAULT_NAME_PATTERN = 'col_{model}__{column}';

/** Make a string safe to use as (part of) a doc block name. */
export function sanitizeName(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * Build a block name from the pattern. `{model}` is the model/seed/snapshot
 * name, or `{source}_{table}` for sources. `{source}`, `{table}` and
 * `{column}` are also available.
 */
export function docBlockName(
  pattern: string,
  origin: Pick<Resource, 'kind' | 'name' | 'sourceName'>,
  column: string,
): string {
  const model = origin.kind === 'source' && origin.sourceName ? `${origin.sourceName}_${origin.name}` : origin.name;
  const name = pattern
    .replace(/\{model\}/g, sanitizeName(model))
    .replace(/\{source\}/g, sanitizeName(origin.sourceName ?? ''))
    .replace(/\{table\}/g, sanitizeName(origin.name))
    .replace(/\{column\}/g, sanitizeName(column));
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
}

/**
 * Reverse of {@link docBlockName}: extract the `{model}` part of a block
 * name, if it matches the pattern. Used to warn about blocks whose model no
 * longer exists.
 */
export function modelPartOfBlockName(pattern: string, blockName: string): string | undefined {
  if (!pattern.includes('{model}')) return undefined;
  const escaped = pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const reSrc = escaped
    .replace(/\{model\}/g, '(?<model>[a-z0-9_]+?)')
    .replace(/\{(column|source|table)\}/g, '[a-z0-9_]+');
  const m = new RegExp(`^${reSrc}$`).exec(blockName);
  return m?.groups?.model;
}

export function docRef(name: string): string {
  return `{{ doc('${name}') }}`;
}
