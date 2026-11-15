/**
 * A summary of one resource (model, seed, snapshot or source): description,
 * columns with status, and the resources up- and downstream. Plain data, so
 * that it can be sent to a webview or printed by the CLI.
 */
import type { Analysis, ColumnStatus, InheritanceCandidate, InheritanceKind } from './analysis';
import type { DbtProject } from './project';
import { resourceLabel, Resource, ResourceKind } from './manifest';
import { docRefName } from './yamlIndex';

export interface SummaryLocation {
  /** File relative to the project root. */
  file: string;
  /** Offset in the file (YAML), or 0 for the start of the file. */
  offset: number;
}

export interface SummaryColumn {
  name: string;
  status: ColumnStatus;
  /** Rendered description (doc() expanded). */
  description: string;
  /** Description as written in YAML (may be `{{ doc('x') }}`); what the user edits. */
  rawDescription: string;
  /**
   * Where the column is known from: YAML, only the manifest (its YAML entry is gone), the
   * warehouse (catalog.json) or the model SQL. Anything but `yaml` is added to YAML on edit.
   */
  source: 'yaml' | 'manifest' | 'catalog' | 'sql';
  docBlock?: string;
  /** For a linked doc block: its file and how many columns use it. */
  docBlockFile?: string;
  docBlockUsages?: number;
  dataType?: string;
  notInYaml: boolean;
  /** Best upstream description when the column is not documented. */
  inherit?: { from: string; fromColumn: string; description: string; kind: InheritanceKind; docBlock?: string; safe: boolean };
  /** Number of other upstream candidates. */
  moreCandidates: number;
  location?: SummaryLocation;
}

export interface SummaryRelation {
  uniqueId: string;
  label: string;
  kind: ResourceKind;
  /** Column coverage of that resource, when it belongs to this project. */
  coverage?: number;
  location?: SummaryLocation;
}

export interface ModelSummary {
  uniqueId: string;
  label: string;
  kind: ResourceKind;
  /** Rendered model description (doc() expanded). */
  description: string;
  /** Model description as written in YAML. */
  rawDescription: string;
  docBlock?: string;
  /** Path of the SQL/CSV file (sources: the YAML file). */
  file: string;
  yamlFile?: string;
  tags: string[];
  owner?: string;
  materialized?: string;
  layer: string;
  counts: { columns: number; documented: number; inheritable: number; missing: number; notInYaml: number };
  columns: SummaryColumn[];
  upstream: SummaryRelation[];
  downstream: SummaryRelation[];
  locations: { source?: SummaryLocation; yaml?: SummaryLocation };
}

/** Reverse of `depends_on`: resource id -> ids of resources that depend on it. */
export function downstreamIndex(project: DbtProject): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of project.manifest.resources.values()) {
    for (const dep of r.dependsOn) {
      const list = map.get(dep) ?? [];
      list.push(r.uniqueId);
      map.set(dep, list);
    }
  }
  return map;
}

/** The resource whose SQL/Python/CSV file is `relPath` (relative to the project). */
export function resourceForFile(project: DbtProject, relPath: string): Resource | undefined {
  for (const r of project.manifest.resources.values()) {
    if (r.kind !== 'source' && r.originalFilePath === relPath && r.packageName === project.manifest.projectName) return r;
  }
  return undefined;
}

function sourceLocation(r: Resource): SummaryLocation | undefined {
  return r.originalFilePath ? { file: r.originalFilePath, offset: 0 } : undefined;
}

export function modelSummary(analysis: Analysis, uniqueId: string, downstream?: Map<string, string[]>): ModelSummary | undefined {
  const project = analysis.project;
  const resource = project.manifest.resources.get(uniqueId);
  if (!resource) return undefined;
  const report = analysis.resources.get(uniqueId);
  const yaml = report?.yaml ?? project.yamlFor(resource);

  const blockUsages = new Map<string, number>();
  for (const r of analysis.resources.values()) {
    for (const c of r.columns) if (c.docBlock) blockUsages.set(c.docBlock, (blockUsages.get(c.docBlock) ?? 0) + 1);
  }
  const blocks = project.docBlocks();
  const inheritOf = (candidates: InheritanceCandidate[]): SummaryColumn['inherit'] => {
    const k = candidates[0];
    if (!k) return undefined;
    const safe = candidates.length === 1 && k.kind === 'passthrough' && k.via === 'sql';
    return { from: k.fromLabel, fromColumn: k.fromColumn, description: k.description, kind: k.kind, docBlock: k.docBlock, safe };
  };

  const columns: SummaryColumn[] = (report?.columns ?? []).map((c) => {
    return {
      name: c.name,
      status: c.status,
      description: c.description,
      rawDescription: c.rawDescription,
      source: c.yaml ? 'yaml' : c.notInYaml ? 'catalog' : 'manifest',
      docBlock: c.docBlock,
      docBlockFile: c.docBlock ? blocks.get(c.docBlock)?.file : undefined,
      docBlockUsages: c.docBlock ? blockUsages.get(c.docBlock) ?? 1 : undefined,
      dataType: resource.columns.get(c.name.toLowerCase())?.dataType ?? project.catalog?.get(uniqueId)?.find((x) => x.name.toLowerCase() === c.name.toLowerCase())?.type,
      notInYaml: !c.yaml,
      inherit: inheritOf(c.candidates),
      moreCandidates: Math.max(0, c.candidates.length - 1),
      location: c.yaml ? { file: c.yaml.file, offset: c.yaml.column.nameRange[0] } : undefined,
    };
  });

  // Columns that are only in the SQL (e.g. a new model that has not been built yet).
  if (resource.kind === 'model' || resource.kind === 'snapshot') {
    const known = new Set(columns.map((c) => c.name.toLowerCase()));
    for (const name of analysis.sqlOutputs(resource)) {
      if (known.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      const candidates = analysis.findInheritance(resource, name);
      columns.push({
        name,
        status: candidates.length > 0 ? 'inheritable' : 'missing',
        description: '',
        rawDescription: '',
        source: 'sql',
        notInYaml: true,
        inherit: inheritOf(candidates),
        moreCandidates: Math.max(0, candidates.length - 1),
      });
    }
  }

  const relation = (id: string): SummaryRelation => {
    const r = project.manifest.resources.get(id);
    const rep = analysis.resources.get(id);
    if (!r) return { uniqueId: id, label: id.split('.').slice(2).join('.'), kind: 'model' };
    const cols = rep?.columns ?? [];
    const y = rep?.yaml;
    return {
      uniqueId: id,
      label: resourceLabel(r),
      kind: r.kind,
      coverage: rep && cols.length > 0 ? Math.round((100 * cols.filter((c) => c.status === 'documented').length) / cols.length) : undefined,
      location: r.kind === 'source' ? (y ? { file: y.file, offset: y.resource.nameRange[0] } : sourceLocation(r)) : sourceLocation(r),
    };
  };

  const down = (downstream ?? downstreamIndex(project)).get(uniqueId) ?? [];
  const rawDescription = yaml?.resource.description?.value;
  const description = rawDescription !== undefined ? analysis.render(rawDescription, resource.description) : resource.description;
  const count = (s: ColumnStatus) => columns.filter((c) => c.status === s).length;

  return {
    uniqueId,
    label: resourceLabel(resource),
    kind: resource.kind,
    description,
    rawDescription: rawDescription ?? (yaml ? '' : resource.description),
    docBlock: docRefName(rawDescription),
    file: resource.originalFilePath,
    yamlFile: yaml?.file,
    tags: resource.tags,
    owner: resource.owner ?? resource.group,
    materialized: resource.materialized,
    layer: report?.layer ?? '',
    counts: {
      columns: columns.length,
      documented: count('documented'),
      inheritable: count('inheritable'),
      missing: count('missing'),
      notInYaml: columns.filter((c) => c.notInYaml).length,
    },
    columns,
    upstream: resource.dependsOn.map(relation).sort((a, b) => a.label.localeCompare(b.label)),
    downstream: down.map(relation).sort((a, b) => a.label.localeCompare(b.label)),
    locations: {
      source: resource.kind === 'source' ? undefined : sourceLocation(resource),
      yaml: yaml ? { file: yaml.file, offset: yaml.resource.nameRange[0] } : undefined,
    },
  };
}
