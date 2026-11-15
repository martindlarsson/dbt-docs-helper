/**
 * A summary of one resource (model, seed, snapshot or source): description,
 * columns with status, and the resources up- and downstream. Plain data, so
 * that it can be sent to a webview or printed by the CLI.
 */
import type { Analysis, ColumnStatus, InheritanceKind } from './analysis';
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
  description: string;
  docBlock?: string;
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

  const columns: SummaryColumn[] = (report?.columns ?? []).map((c) => {
    const k = c.candidates[0];
    const safe = !!k && c.candidates.length === 1 && k.kind === 'passthrough' && k.via === 'sql';
    return {
      name: c.name,
      status: c.status,
      description: c.description,
      docBlock: c.docBlock,
      dataType: resource.columns.get(c.name.toLowerCase())?.dataType ?? project.catalog?.get(uniqueId)?.find((x) => x.name.toLowerCase() === c.name.toLowerCase())?.type,
      notInYaml: c.notInYaml,
      inherit: k ? { from: k.fromLabel, fromColumn: k.fromColumn, description: k.description, kind: k.kind, docBlock: k.docBlock, safe } : undefined,
      moreCandidates: Math.max(0, c.candidates.length - 1),
      location: c.yaml ? { file: c.yaml.file, offset: c.yaml.column.nameRange[0] } : undefined,
    };
  });

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
