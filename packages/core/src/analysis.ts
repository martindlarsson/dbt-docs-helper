/**
 * The analysis: for every column of every resource in the project, is it
 * documented, can it inherit a description from upstream, or must it be
 * written by hand? Plus docs-block candidates, conflicting descriptions and
 * doc blocks that point at models that no longer exist.
 */
import type { Resource } from './manifest';
import { resourceLabel } from './manifest';
import type { DbtProject } from './project';
import { analyzeSql, SqlAnalysis } from './sql';
import { sameType } from './dataTypes';
import { docRefName, hasDocRef, YamlColumn, YamlResource } from './yamlIndex';

export type InheritanceKind = 'passthrough' | 'renamed' | 'transformed';

export interface InheritanceCandidate {
  /** Unique id of the resource the description comes from. */
  fromId: string;
  fromLabel: string;
  fromColumn: string;
  /** Rendered description. */
  description: string;
  /** Raw YAML description, if known (may be a `{{ doc() }}` reference). */
  rawDescription?: string;
  /** Doc block the upstream column links to (name), if any. */
  docBlock?: string;
  kind: InheritanceKind;
  /** How the link was found: by reading the SQL, or only by matching names. */
  via: 'sql' | 'name';
  /** Resource ids from this resource up to (and including) the origin. */
  chain: string[];
}

export type ColumnStatus = 'documented' | 'inheritable' | 'missing';

export interface TypeSuggestion {
  type: string;
  /** warehouse: catalog.json; cast: a cast in the model SQL; seed: seed column_types; upstream: lineage. */
  source: 'warehouse' | 'cast' | 'seed' | 'upstream';
  /** For `upstream`: `model.column` the type comes from. */
  from?: string;
}

export interface ColumnReport {
  resourceId: string;
  name: string;
  status: ColumnStatus;
  /** Raw description from YAML (or rendered from the manifest when YAML is not available). */
  rawDescription: string;
  /** Rendered description (doc refs expanded). */
  description: string;
  docBlock?: string;
  candidates: InheritanceCandidate[];
  /** The column is in the warehouse (catalog.json) but not in YAML. */
  notInYaml: boolean;
  yaml?: { file: string; column: YamlColumn };
  /** `data_type` as written in YAML (or in the manifest when there is no YAML). */
  dataType?: string;
  /** The type the column most likely has, and where that comes from. */
  typeSuggestion?: TypeSuggestion;
  /** YAML says one type, the warehouse (catalog.json) another. */
  typeMismatch?: { yaml: string; warehouse: string };
}

export interface ResourceReport {
  resource: Resource;
  label: string;
  /** Model description present? */
  hasDescription: boolean;
  columns: ColumnReport[];
  yaml?: { file: string; resource: YamlResource };
  folder: string;
  layer: string;
}

export interface AnalysisOptions {
  /** Max number of upstream hops to follow. */
  maxDepth?: number;
  /** Layer names to recognise from folders / fqn. */
  layers?: string[];
}

export const DEFAULT_LAYERS = ['staging', 'intermediate', 'marts', 'mart', 'core', 'base', 'reporting'];

export class Analysis {
  readonly resources = new Map<string, ResourceReport>();
  private sqlCache = new Map<string, SqlAnalysis>();
  private maxDepth: number;
  private layers: string[];

  constructor(readonly project: DbtProject, options: AnalysisOptions = {}) {
    this.maxDepth = options.maxDepth ?? 12;
    this.layers = options.layers ?? DEFAULT_LAYERS;
    for (const r of project.ownResources()) {
      this.resources.set(r.uniqueId, this.analyzeResource(r));
    }
  }

  // ---------------------------------------------------------------------------
  // Columns as currently written (YAML first, manifest second)

  /** Current raw + rendered description of a column in any resource (including packages). */
  columnText(resource: Resource, columnLower: string): { name: string; raw: string; rendered: string; docBlock?: string } | undefined {
    const yaml = this.project.yamlFor(resource);
    const yc = yaml?.resource.columns.find((c) => c.name.toLowerCase() === columnLower);
    const mc = resource.columns.get(columnLower);
    if (yc) {
      const raw = yc.description?.value ?? '';
      return { name: yc.name, raw, rendered: this.render(raw, mc?.description), docBlock: docRefName(raw) };
    }
    if (yaml && !mc) return undefined;
    if (!mc) return undefined;
    const docBlockId = mc.docBlocks[0];
    const docBlock = docBlockId ? docBlockId.split('.').pop() : undefined;
    const singleRef = docBlock && this.project.docBlocks().get(docBlock)?.contents.trim() === mc.description.trim();
    return {
      name: mc.name,
      raw: singleRef ? `{{ doc('${docBlock}') }}` : mc.description,
      rendered: mc.description,
      docBlock: singleRef ? docBlock : undefined,
    };
  }

  /** Render a raw description: expand `{{ doc('x') }}` using the known doc blocks. */
  render(raw: string, fallback?: string): string {
    if (!hasDocRef(raw)) return raw;
    const blocks = this.project.docBlocks();
    let unresolved = false;
    const out = raw.replace(/\{\{-?\s*doc\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3\s*)?\)\s*-?\}\}/g, (_m, _q, a, _q2, b) => {
      const block = blocks.get(b ?? a);
      if (!block) {
        unresolved = true;
        return '';
      }
      return block.contents;
    });
    return unresolved && fallback ? fallback : out.trim();
  }

  private sql(resource: Resource): SqlAnalysis {
    let a = this.sqlCache.get(resource.uniqueId);
    if (!a) {
      a = analyzeSql(resource.rawCode ?? resource.compiledCode);
      this.sqlCache.set(resource.uniqueId, a);
    }
    return a;
  }

  /** Output column names that can be read from the model's SQL, in order. */
  sqlOutputs(resource: Resource): string[] {
    return this.sql(resource).outputs;
  }

  // ---------------------------------------------------------------------------
  // Inheritance

  /** Resolve a relation used in the SQL of `resource` to one of its upstream resources. */
  private resolveRelation(resource: Resource, qualifier: string | undefined): Resource | undefined {
    const sql = this.sql(resource);
    const deps = resource.dependsOn.map((id) => this.project.manifest.resources.get(id)).filter((r): r is Resource => !!r);
    if (!qualifier) {
      // Unqualified column: only unambiguous if there is a single upstream.
      return deps.length === 1 ? deps[0] : undefined;
    }
    const rel = sql.relations.get(qualifier.toLowerCase());
    if (!rel) return undefined;
    return deps.find((d) =>
      rel.kind === 'ref' ? d.kind !== 'source' && d.name.toLowerCase() === rel.name.toLowerCase() : d.kind === 'source' && d.sourceName === rel.sourceName && d.name === rel.name,
    );
  }

  /**
   * Find upstream descriptions for a column. Follows the SQL when it can
   * (`c.id as customer_id`), otherwise matches column names through
   * `depends_on`. Stops at the first upstream column that has a description
   * on each path.
   */
  findInheritance(resource: Resource, column: string): InheritanceCandidate[] {
    const results: InheritanceCandidate[] = [];
    const seen = new Set<string>();
    type Step = { res: Resource; column: string; kind: InheritanceKind; via: 'sql' | 'name'; chain: string[] };
    const queue: Step[] = [];

    const expand = (step: Step) => {
      if (step.chain.length > this.maxDepth) return;
      const { res } = step;
      const select = this.sql(res).selects.get(step.column.toLowerCase());
      if (select) {
        const upstream = this.resolveRelation(res, select.qualifier);
        if (upstream) {
          const renamed = select.column.toLowerCase() !== step.column.toLowerCase();
          const kind: InheritanceKind =
            select.transformed || step.kind === 'transformed'
              ? 'transformed'
              : renamed || step.kind === 'renamed'
                ? 'renamed'
                : 'passthrough';
          queue.push({
            res: upstream,
            column: select.column,
            kind,
            via: step.via,
            chain: [...step.chain, upstream.uniqueId],
          });
          return;
        }
      }
      // Fall back to matching names in every upstream resource.
      for (const id of res.dependsOn) {
        const up = this.project.manifest.resources.get(id);
        if (!up) continue;
        queue.push({ res: up, column: step.column, kind: step.kind, via: 'name', chain: [...step.chain, up.uniqueId] });
      }
    };

    expand({ res: resource, column, kind: 'passthrough', via: 'sql', chain: [resource.uniqueId] });
    while (queue.length > 0) {
      const step = queue.shift()!;
      const key = `${step.res.uniqueId}|${step.column.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = this.columnText(step.res, step.column.toLowerCase());
      if (text && text.rendered.trim().length > 0) {
        results.push({
          fromId: step.res.uniqueId,
          fromLabel: resourceLabel(step.res),
          fromColumn: text.name,
          description: text.rendered,
          rawDescription: text.raw,
          docBlock: text.docBlock,
          kind: step.kind,
          via: step.via,
          chain: step.chain,
        });
        continue;
      }
      expand(step);
    }

    // SQL-traced first, then closest; drop duplicates of the same text.
    results.sort((a, b) => (a.via === b.via ? a.chain.length - b.chain.length : a.via === 'sql' ? -1 : 1));
    const unique: InheritanceCandidate[] = [];
    const texts = new Set<string>();
    for (const c of results) {
      const t = c.description.trim();
      if (texts.has(t)) continue;
      texts.add(t);
      unique.push(c);
    }
    return unique;
  }

  /**
   * The resource where a column originates: the most upstream resource on the
   * traced path where the column still has the same name.
   */
  originOf(resource: Resource, column: string): { resource: Resource; column: string } {
    let current = { resource, column };
    for (let i = 0; i < this.maxDepth; i++) {
      const select = this.sql(current.resource).selects.get(current.column.toLowerCase());
      let next: Resource | undefined;
      let nextColumn = current.column;
      if (select) {
        // Only follow plain pass-through: a renamed or transformed column is a new column.
        if (select.transformed || select.column.toLowerCase() !== current.column.toLowerCase()) break;
        next = this.resolveRelation(current.resource, select.qualifier);
        nextColumn = select.column;
      }
      if (!next) {
        // Name match through a single upstream that has the column.
        const ups = current.resource.dependsOn
          .map((id) => this.project.manifest.resources.get(id))
          .filter((r): r is Resource => !!r && !!this.columnText(r, current.column.toLowerCase()));
        if (ups.length === 1) next = ups[0];
      }
      if (!next || !this.hasColumn(next, nextColumn)) break;
      current = { resource: next, column: nextColumn };
    }
    return current;
  }

  // ---------------------------------------------------------------------------
  // Data types

  /** The type of a column in the warehouse (catalog.json). */
  warehouseType(resource: Resource, column: string): string | undefined {
    const lower = column.toLowerCase();
    return this.project.catalog?.get(resource.uniqueId)?.find((c) => c.name.toLowerCase() === lower)?.type;
  }

  /** `data_type` declared for a column: YAML first, then the manifest. */
  declaredType(resource: Resource, column: string): string | undefined {
    const lower = column.toLowerCase();
    const yaml = this.project.yamlFor(resource);
    const yc = yaml?.resource.columns.find((c) => c.name.toLowerCase() === lower);
    if (yc?.dataType?.value) return yc.dataType.value;
    if (yaml && yc) return undefined;
    return resource.columns.get(lower)?.dataType || undefined;
  }

  /** A type known for the column in this resource itself, without following lineage. */
  private localType(resource: Resource, column: string, includeDeclared: boolean): TypeSuggestion | undefined {
    const lower = column.toLowerCase();
    const warehouse = this.warehouseType(resource, column);
    if (warehouse) return { type: warehouse, source: 'warehouse' };
    const cast = this.sql(resource).casts.get(lower);
    if (cast) return { type: cast, source: 'cast' };
    const seed = resource.columnTypes?.get(lower);
    if (seed) return { type: seed, source: 'seed' };
    if (includeDeclared) {
      const declared = this.declaredType(resource, column);
      if (declared) return { type: declared, source: 'upstream', from: `${resourceLabel(resource)}.${column}` };
    }
    return undefined;
  }

  /**
   * The type a column most likely has: from the warehouse, a cast in the
   * SQL, seed `column_types`, or else from upstream, following columns that
   * are passed through or renamed (not transformed).
   */
  suggestType(resource: Resource, column: string): TypeSuggestion | undefined {
    const own = this.localType(resource, column, false);
    if (own) return own;
    let current = { resource, column };
    for (let i = 0; i < this.maxDepth; i++) {
      const select = this.sql(current.resource).selects.get(current.column.toLowerCase());
      let next: Resource | undefined;
      let nextColumn = current.column;
      if (select) {
        if (select.transformed) return undefined;
        next = this.resolveRelation(current.resource, select.qualifier);
        nextColumn = select.column;
      }
      if (!next) {
        const ups = current.resource.dependsOn
          .map((id) => this.project.manifest.resources.get(id))
          .filter((r): r is Resource => !!r && this.hasColumn(r, current.column));
        if (ups.length === 1) next = ups[0];
      }
      if (!next) return undefined;
      const found = this.localType(next, nextColumn, true);
      if (found) return { ...found, source: 'upstream', from: found.from ?? `${resourceLabel(next)}.${nextColumn}` };
      current = { resource: next, column: nextColumn };
    }
    return undefined;
  }

  private hasColumn(resource: Resource, column: string): boolean {
    const lower = column.toLowerCase();
    if (this.columnText(resource, lower)) return true;
    return !!this.project.catalog?.get(resource.uniqueId)?.some((c) => c.name.toLowerCase() === lower);
  }

  // ---------------------------------------------------------------------------

  private layerOf(resource: Resource): string {
    const parts = [...resource.originalFilePath.split('/'), ...resource.fqn].map((p) => p.toLowerCase());
    for (const layer of this.layers) if (parts.includes(layer)) return layer;
    if (resource.kind === 'source') return 'sources';
    if (resource.kind === 'seed') return 'seeds';
    if (resource.kind === 'snapshot') return 'snapshots';
    return 'other';
  }

  private analyzeResource(resource: Resource): ResourceReport {
    const yaml = this.project.yamlFor(resource);
    const columns: ColumnReport[] = [];
    const names: { name: string; yamlColumn?: YamlColumn; notInYaml: boolean }[] = [];
    const seen = new Set<string>();
    if (yaml) {
      for (const yc of yaml.resource.columns) {
        if (seen.has(yc.name.toLowerCase())) continue;
        seen.add(yc.name.toLowerCase());
        names.push({ name: yc.name, yamlColumn: yc, notInYaml: false });
      }
    } else {
      for (const mc of resource.columns.values()) {
        seen.add(mc.name.toLowerCase());
        names.push({ name: mc.name, notInYaml: false });
      }
    }
    for (const cc of this.project.catalog?.get(resource.uniqueId) ?? []) {
      if (seen.has(cc.name.toLowerCase())) continue;
      seen.add(cc.name.toLowerCase());
      names.push({ name: cc.name, notInYaml: true });
    }

    for (const { name, yamlColumn, notInYaml } of names) {
      const text = notInYaml ? undefined : this.columnText(resource, name.toLowerCase());
      const raw = text?.raw ?? '';
      const documented = (text?.rendered ?? '').trim().length > 0 || raw.trim().length > 0;
      const candidates = documented ? [] : this.findInheritance(resource, name);
      columns.push({
        resourceId: resource.uniqueId,
        name: text?.name ?? name,
        status: documented ? 'documented' : candidates.length > 0 ? 'inheritable' : 'missing',
        rawDescription: raw,
        description: text?.rendered ?? '',
        docBlock: text?.docBlock,
        candidates,
        notInYaml,
        yaml: yaml && yamlColumn ? { file: yaml.file, column: yamlColumn } : undefined,
        ...this.typeInfo(resource, name, notInYaml),
      });
    }

    const description = yaml ? (yaml.resource.description?.value ?? '') : resource.description;
    const folder = resource.originalFilePath.split('/').slice(0, -1).join('/') || '.';
    return {
      resource,
      label: resourceLabel(resource),
      hasDescription: description.trim().length > 0,
      columns,
      yaml,
      folder,
      layer: this.layerOf(resource),
    };
  }

  private typeInfo(resource: Resource, column: string, notInYaml: boolean): Pick<ColumnReport, 'dataType' | 'typeSuggestion' | 'typeMismatch'> {
    const dataType = notInYaml ? undefined : this.declaredType(resource, column);
    const typeSuggestion = this.suggestType(resource, column);
    const warehouse = this.warehouseType(resource, column);
    const typeMismatch = dataType && warehouse && !sameType(dataType, warehouse) ? { yaml: dataType, warehouse } : undefined;
    return { dataType, typeSuggestion, typeMismatch };
  }

  /** All column reports. */
  columns(): ColumnReport[] {
    return [...this.resources.values()].flatMap((r) => r.columns);
  }
}

/** The value to write when inheriting: the same doc() reference, or the text. */
export function inheritedValue(c: InheritanceCandidate): string {
  return c.docBlock ? `{{ doc('${c.docBlock}') }}` : c.description;
}

/**
 * True when a column can be inherited without asking: a single upstream
 * text, passed through unchanged and traced in the SQL.
 */
export function isSafeInheritance(column: ColumnReport): boolean {
  if (column.status !== 'inheritable' || !column.yaml || column.candidates.length !== 1) return false;
  const c = column.candidates[0];
  return c.kind === 'passthrough' && c.via === 'sql';
}
