/**
 * A deliberately small SQL "reader" used to trace columns to their upstream
 * model. It is not a SQL parser: it understands the common dbt style
 *
 *   with orders as (select * from {{ ref('stg_orders') }})
 *   select o.order_id, c.id as customer_id, status
 *   from orders o join {{ ref('stg_customers') }} c ...
 *
 * and gives up (returns nothing) for anything it does not recognise. Callers
 * fall back to plain name matching in that case.
 */

export type RelationRef = { kind: 'ref'; name: string } | { kind: 'source'; sourceName: string; name: string };

export interface SelectItem {
  /** Output column name (alias, or the column itself). */
  output: string;
  /** Column name in the relation it is selected from. */
  column: string;
  /** Table alias/qualifier, if the column was written as `alias.column`. */
  qualifier?: string;
  /**
   * True when the output is an expression (`sum(p.amount) as amount`) that
   * references exactly one column. `column`/`qualifier` are that column.
   */
  transformed?: boolean;
}

export interface SqlAnalysis {
  /** Lower-case alias / CTE name -> relation. */
  relations: Map<string, RelationRef>;
  /** Lower-case output column -> select item. Only "simple" items (a bare column, optionally aliased). */
  selects: Map<string, SelectItem>;
  /** Names of all output columns that could be read from the final select, in order (no `*`). */
  outputs: string[];
  /** Lower-case output column -> type of a top-level cast (`cast(x as date)`, `x::date`). */
  casts: Map<string, string>;
}

const TYPE = String.raw`([a-z_][\w ]*?(?:\s*\([\d\s,]+\))?)`;
const CAST_FN = new RegExp(String.raw`^(?:try_|safe_)?cast\s*\(([\s\S]+)\s+as\s+${TYPE}\s*\)$`, 'i');
const CAST_OP = new RegExp(String.raw`^([\s\S]+?)::\s*${TYPE}$`, 'i');

/** The type of a top-level cast expression, if the expression is one. */
export function castType(expression: string): string | undefined {
  const e = expression.trim();
  const m = CAST_FN.exec(e) ?? CAST_OP.exec(e);
  return m ? m[2].trim().replace(/\s+/g, ' ') : undefined;
}

const KEYWORDS = new Set([
  'where', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'on', 'using', 'group', 'order', 'limit',
  'union', 'having', 'qualify', 'window', 'select', 'from', 'with', 'as', 'natural', 'lateral', 'and', 'or',
  'when', 'then', 'else', 'end', 'case', 'not', 'null', 'is', 'in', 'distinct', 'all', 'except', 'intersect',
]);

const REF = String.raw`\{\{-?\s*ref\(\s*['"]([\w.-]+)['"]\s*(?:,\s*['"]([\w.-]+)['"]\s*)?(?:,\s*v(?:ersion)?\s*=\s*[^)]*)?\)\s*-?\}\}`;
const SOURCE = String.raw`\{\{-?\s*source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)\s*-?\}\}`;

function stripComments(sql: string): string {
  return sql
    .replace(/\{#[\s\S]*?#\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function refFromMatch(m: RegExpExecArray | RegExpMatchArray, isSource: boolean): RelationRef {
  if (isSource) return { kind: 'source', sourceName: m[1], name: m[2] };
  // ref('package', 'model') has two arguments; the model is the last one.
  return { kind: 'ref', name: m[2] ?? m[1] };
}

export function analyzeSql(rawSql: string | undefined): SqlAnalysis {
  const relations = new Map<string, RelationRef>();
  const selects = new Map<string, SelectItem>();
  const outputs: string[] = [];
  const casts = new Map<string, string>();
  if (!rawSql) return { relations, selects, outputs, casts };
  const sql = stripComments(rawSql);

  // Import CTEs: `name as ( select * from {{ ref('x') }} )`
  for (const [re, isSource] of [
    [new RegExp(String.raw`(\w+)\s+as\s*\(\s*select\s+\*\s+from\s+${REF}\s*(?:\w+\s*)?\)`, 'gi'), false],
    [new RegExp(String.raw`(\w+)\s+as\s*\(\s*select\s+\*\s+from\s+${SOURCE}\s*(?:\w+\s*)?\)`, 'gi'), true],
  ] as const) {
    for (const m of sql.matchAll(re)) {
      relations.set(m[1].toLowerCase(), refFromMatch([m[0], m[2], m[3]] as unknown as RegExpMatchArray, isSource));
    }
  }

  // Direct references with optional alias: `{{ ref('x') }} [as] alias`
  for (const [re, isSource] of [
    [new RegExp(String.raw`${REF}(?:\s+(?:as\s+)?(\w+))?`, 'gi'), false],
    [new RegExp(String.raw`${SOURCE}(?:\s+(?:as\s+)?(\w+))?`, 'gi'), true],
  ] as const) {
    for (const m of sql.matchAll(re)) {
      const rel = refFromMatch(m, isSource);
      if (!relations.has(rel.name.toLowerCase())) relations.set(rel.name.toLowerCase(), rel);
      const alias = m[3];
      if (alias && !KEYWORDS.has(alias.toLowerCase())) relations.set(alias.toLowerCase(), rel);
    }
  }

  // CTE aliases of CTEs: `from orders o` where `orders` is an import CTE.
  for (const m of sql.matchAll(/\b(?:from|join)\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
    const target = relations.get(m[1].toLowerCase());
    const alias = m[2];
    if (target && alias && !KEYWORDS.has(alias.toLowerCase()) && !relations.has(alias.toLowerCase())) {
      relations.set(alias.toLowerCase(), target);
    }
  }

  // Simple select items in the *last* select of the statement (the final output).
  const lastSelect = finalSelectList(sql);
  if (lastSelect) {
    for (const part of splitTopLevel(lastSelect)) {
      const outName = /\s+as\s+("?)(\w+)\1\s*$/i.exec(part)?.[2] ?? /^\s*(?:distinct\s+)?(?:\w+\.)?(\w+)\s*$/i.exec(part)?.[1];
      if (outName && !KEYWORDS.has(outName.toLowerCase())) outputs.push(outName);
      const aliased = /^([\s\S]*?)\s+as\s+"?(\w+)"?\s*$/i.exec(part.trim());
      const cast = aliased ? castType(aliased[1]) : castType(part);
      const castOutput = aliased ? aliased[2] : /^\s*(?:\w+\.)?(\w+)\s*::/.exec(part)?.[1];
      if (cast && castOutput) {
        casts.set(castOutput.toLowerCase(), cast);
        if (!aliased) outputs.push(castOutput);
      }
      const m = /^\s*(?:distinct\s+)?(?:(\w+)\.)?(\w+)(?:\s+(?:as\s+)?(\w+))?\s*$/i.exec(part);
      if (!m) {
        const expr = expressionItem(part);
        if (expr) selects.set(expr.output.toLowerCase(), expr);
        continue;
      }
      const [, qualifier, column, alias] = m;
      if (KEYWORDS.has(column.toLowerCase()) && !qualifier) continue;
      const output = alias ?? column;
      selects.set(output.toLowerCase(), { output, column, qualifier });
    }
  }
  return { relations, selects, outputs, casts };
}

/** Bodies of CTEs: lower-case name -> text inside the parentheses. */
function cteBodies(sql: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const m of sql.matchAll(/(\w+)\s+as\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) {
          bodies.set(m[1].toLowerCase(), sql.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

/**
 * The select list that produces the model's output. Follows the common
 * `select * from final` pattern into the `final` CTE (a few levels deep).
 */
function finalSelectList(sql: string): string | undefined {
  const bodies = cteBodies(sql);
  let current = sql;
  for (let depth = 0; depth < 5; depth++) {
    const list = findLastTopLevelSelect(current);
    if (list === undefined) return undefined;
    if (list.trim() !== '*') return list;
    const from = /^\s*from\s+(\w+)\s*(?:;\s*)?$/i.exec(textAfterLastSelectList(current));
    const body = from ? bodies.get(from[1].toLowerCase()) : undefined;
    if (!body) return undefined;
    current = body;
  }
  return undefined;
}

function textAfterLastSelectList(sql: string): string {
  const list = findLastTopLevelSelect(sql) ?? '';
  const idx = sql.toLowerCase().lastIndexOf(list.toLowerCase());
  return idx >= 0 ? sql.slice(idx + list.length) : '';
}

/** Text between the last top-level `select` and its `from`. */
function findLastTopLevelSelect(sql: string): string | undefined {
  let depth = 0;
  let lastSelectEnd = -1;
  let fromAfter = -1;
  const lower = sql.toLowerCase();
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === "'" ) {
      const close = sql.indexOf("'", i + 1);
      if (close < 0) break;
      i = close;
    } else if (depth === 0 && isWordAt(lower, i, 'select')) {
      lastSelectEnd = i + 6;
      fromAfter = -1;
    } else if (depth === 0 && lastSelectEnd >= 0 && fromAfter < 0 && isWordAt(lower, i, 'from')) {
      fromAfter = i;
    }
  }
  if (lastSelectEnd < 0) return undefined;
  return sql.slice(lastSelectEnd, fromAfter >= 0 ? fromAfter : sql.length);
}

function isWordAt(lower: string, i: number, word: string): boolean {
  if (!lower.startsWith(word, i)) return false;
  const before = i === 0 ? ' ' : lower[i - 1];
  const after = lower[i + word.length] ?? ' ';
  return !/\w/.test(before) && !/\w/.test(after);
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

const FUNCTION_WORDS = new Set([...KEYWORDS, 'cast', 'coalesce', 'sum', 'count', 'min', 'max', 'avg', 'round', 'nullif', 'over',
  'partition', 'by', 'desc', 'asc', 'true', 'false', 'interval', 'date', 'timestamp', 'varchar', 'int', 'integer', 'bigint',
  'numeric', 'decimal', 'string', 'text', 'boolean', 'float', 'double', 'lower', 'upper', 'trim', 'abs', 'if', 'iff', 'like',
  'between', 'extract', 'day', 'month', 'year', 'week', 'hour', 'minute', 'second', 'current_date', 'current_timestamp']);

/** `expr as alias` where expr references exactly one column. */
function expressionItem(part: string): SelectItem | undefined {
  const m = /^([\s\S]*\S)\s+as\s+(\w+)\s*$/i.exec(part.trim());
  if (!m) return undefined;
  const [, expr, output] = m;
  const withoutStrings = expr.replace(/'(?:[^']|'')*'/g, ' ');
  const refs = new Map<string, { qualifier?: string; column: string }>();
  for (const r of withoutStrings.matchAll(/(?<![\w.])(?:(\w+)\.)?([A-Za-z_]\w*)\b(?!\s*\()/g)) {
    const [, qualifier, column] = r;
    if (!qualifier && FUNCTION_WORDS.has(column.toLowerCase())) continue;
    refs.set(`${qualifier ?? ''}.${column}`.toLowerCase(), { qualifier, column });
  }
  if (refs.size !== 1) return undefined;
  const [{ qualifier, column }] = refs.values();
  // A cast keeps the meaning of the column: treat it as passed through.
  return { output, column, qualifier, transformed: castType(expr) === undefined };
}
