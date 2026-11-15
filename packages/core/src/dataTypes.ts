/**
 * Comparing data types written in different ways by different tools and
 * warehouses (`int` / `INTEGER` / `int4`, `varchar(255)` / `character varying`).
 */

const ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int8: 'bigint',
  bigint: 'bigint',
  int2: 'smallint',
  smallint: 'smallint',
  int64: 'bigint',
  float: 'double',
  float8: 'double',
  float64: 'double',
  'double precision': 'double',
  double: 'double',
  float4: 'real',
  real: 'real',
  bool: 'boolean',
  boolean: 'boolean',
  varchar: 'string',
  'character varying': 'string',
  text: 'string',
  string: 'string',
  char: 'string',
  character: 'string',
  nvarchar: 'string',
  numeric: 'numeric',
  decimal: 'numeric',
  number: 'numeric',
  timestamp: 'timestamp',
  'timestamp without time zone': 'timestamp',
  timestamp_ntz: 'timestamp',
  datetime: 'timestamp',
  timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  timestamp_tz: 'timestamptz',
  timestamp_ltz: 'timestamptz',
};

/** A canonical form for comparing two types: lower-case, aliases merged, size/precision ignored. */
export function normalizeType(type: string): string {
  const base = type
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[base] ?? base;
}

export function sameType(a: string, b: string): boolean {
  return normalizeType(a) === normalizeType(b);
}

export type TypeCase = 'lower' | 'upper' | 'asIs';

export function formatType(type: string, typeCase: TypeCase = 'lower'): string {
  const t = type.trim();
  return typeCase === 'lower' ? t.toLowerCase() : typeCase === 'upper' ? t.toUpperCase() : t;
}
