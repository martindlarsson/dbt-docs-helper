/**
 * Reading `manifest.json` (dbt Core and dbt Fusion) and `catalog.json`
 * into a small, normalised model that the rest of the library works with.
 *
 * Only the fields we need are read, and every field is treated as optional,
 * so that small differences between manifest versions (v10–v12, Fusion) do
 * not break anything.
 */

export type ResourceKind = 'model' | 'seed' | 'snapshot' | 'source';

export interface ColumnInfo {
  /** Column name as written in YAML / the manifest. */
  name: string;
  /** Rendered description (doc() blocks already expanded by dbt). */
  description: string;
  /** Doc block unique ids referenced by the description (dbt >= 1.10). */
  docBlocks: string[];
  dataType?: string;
}

export interface Resource {
  uniqueId: string;
  kind: ResourceKind;
  /** Model/seed/snapshot name, or table name for sources. */
  name: string;
  /** For sources: the source name (`crm` in `source('crm', 'customers')`). */
  sourceName?: string;
  packageName: string;
  /** Path of the SQL/CSV file (or YAML for sources), relative to the project root. */
  originalFilePath: string;
  /** Path of the YAML file that documents this resource, relative to the project root. */
  yamlPath?: string;
  fqn: string[];
  tags: string[];
  owner?: string;
  group?: string;
  description: string;
  /** Upstream resource unique ids (models, seeds, snapshots, sources). */
  dependsOn: string[];
  /** Columns keyed by lower-case name. */
  columns: Map<string, ColumnInfo>;
  rawCode?: string;
  compiledCode?: string;
}

export interface DocBlock {
  uniqueId: string;
  name: string;
  packageName: string;
  originalFilePath: string;
  contents: string;
}

export interface Manifest {
  projectName: string;
  dbtVersion?: string;
  schemaVersion?: string;
  generatedAt?: string;
  resources: Map<string, Resource>;
  docs: Map<string, DocBlock>;
}

const RESOURCE_KINDS: ReadonlySet<string> = new Set(['model', 'seed', 'snapshot']);

/* eslint-disable @typescript-eslint/no-explicit-any */

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** `jaffle://models/staging/_staging.yml` -> `models/staging/_staging.yml` */
export function stripPatchPath(patchPath: unknown): string | undefined {
  if (typeof patchPath !== 'string' || patchPath.length === 0) return undefined;
  const idx = patchPath.indexOf('://');
  return idx >= 0 ? patchPath.slice(idx + 3) : patchPath;
}

function readColumns(raw: any): Map<string, ColumnInfo> {
  const columns = new Map<string, ColumnInfo>();
  if (!raw || typeof raw !== 'object') return columns;
  for (const [key, col] of Object.entries<any>(raw)) {
    const name = str(col?.name) || key;
    columns.set(name.toLowerCase(), {
      name,
      description: str(col?.description),
      docBlocks: strArray(col?.doc_blocks),
      dataType: typeof col?.data_type === 'string' ? col.data_type : undefined,
    });
  }
  return columns;
}

function readOwner(node: any): string | undefined {
  const meta = node?.config?.meta ?? node?.meta ?? {};
  const owner = meta?.owner ?? node?.config?.meta?.owner;
  if (typeof owner === 'string') return owner;
  if (owner && typeof owner === 'object' && typeof owner.name === 'string') return owner.name;
  return undefined;
}

export function parseManifest(json: unknown): Manifest {
  const m = json as any;
  if (!m || typeof m !== 'object' || (!m.nodes && !m.sources)) {
    throw new Error('Not a dbt manifest: missing "nodes"/"sources"');
  }
  const resources = new Map<string, Resource>();

  for (const [uniqueId, node] of Object.entries<any>(m.nodes ?? {})) {
    const kind = str(node?.resource_type);
    if (!RESOURCE_KINDS.has(kind)) continue;
    resources.set(uniqueId, {
      uniqueId,
      kind: kind as ResourceKind,
      name: str(node.name),
      packageName: str(node.package_name),
      originalFilePath: str(node.original_file_path),
      yamlPath: stripPatchPath(node.patch_path),
      fqn: strArray(node.fqn),
      tags: strArray(node.tags ?? node.config?.tags),
      owner: readOwner(node),
      group: typeof node.group === 'string' ? node.group : undefined,
      description: str(node.description),
      dependsOn: strArray(node.depends_on?.nodes),
      columns: readColumns(node.columns),
      rawCode: typeof node.raw_code === 'string' ? node.raw_code : typeof node.raw_sql === 'string' ? node.raw_sql : undefined,
      compiledCode:
        typeof node.compiled_code === 'string' ? node.compiled_code : typeof node.compiled_sql === 'string' ? node.compiled_sql : undefined,
    });
  }

  for (const [uniqueId, src] of Object.entries<any>(m.sources ?? {})) {
    resources.set(uniqueId, {
      uniqueId,
      kind: 'source',
      name: str(src.name),
      sourceName: str(src.source_name),
      packageName: str(src.package_name),
      originalFilePath: str(src.original_file_path),
      // Sources are defined in YAML, so the YAML file is the original file.
      yamlPath: stripPatchPath(src.patch_path) ?? (str(src.original_file_path) || undefined),
      fqn: strArray(src.fqn),
      tags: strArray(src.tags ?? src.config?.tags),
      owner: readOwner(src),
      description: str(src.description),
      dependsOn: [],
      columns: readColumns(src.columns),
    });
  }

  const docs = new Map<string, DocBlock>();
  for (const [uniqueId, doc] of Object.entries<any>(m.docs ?? {})) {
    docs.set(uniqueId, {
      uniqueId,
      name: str(doc.name),
      packageName: str(doc.package_name),
      originalFilePath: str(doc.original_file_path),
      contents: str(doc.block_contents),
    });
  }

  return {
    projectName: str(m.metadata?.project_name),
    dbtVersion: typeof m.metadata?.dbt_version === 'string' ? m.metadata.dbt_version : undefined,
    schemaVersion: typeof m.metadata?.dbt_schema_version === 'string' ? m.metadata.dbt_schema_version : undefined,
    generatedAt: typeof m.metadata?.generated_at === 'string' ? m.metadata.generated_at : undefined,
    resources,
    docs,
  };
}

/** Columns that exist in the warehouse, from `catalog.json` (keyed by unique id, then lower-case name). */
export type Catalog = Map<string, { name: string; type?: string; index: number }[]>;

export function parseCatalog(json: unknown): Catalog {
  const c = json as any;
  const result: Catalog = new Map();
  for (const section of [c?.nodes, c?.sources]) {
    if (!section || typeof section !== 'object') continue;
    for (const [uniqueId, entry] of Object.entries<any>(section)) {
      const cols = Object.values<any>(entry?.columns ?? {})
        .map((col, i) => ({
          name: str(col?.name),
          type: typeof col?.type === 'string' ? col.type : undefined,
          index: typeof col?.index === 'number' ? col.index : i,
        }))
        .filter((col) => col.name.length > 0)
        .sort((a, b) => a.index - b.index);
      result.set(uniqueId, cols);
    }
  }
  return result;
}

/** A short human-readable label: `stg_orders` or `crm.customers`. */
export function resourceLabel(r: Pick<Resource, 'kind' | 'name' | 'sourceName'>): string {
  return r.kind === 'source' && r.sourceName ? `${r.sourceName}.${r.name}` : r.name;
}
