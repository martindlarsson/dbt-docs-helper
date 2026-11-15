/**
 * Project-wide insights built on top of {@link Analysis}: coverage,
 * docs-block candidates, conflicting descriptions and orphaned doc blocks.
 */
import type { Analysis, ColumnReport, ResourceReport } from './analysis';
import { DEFAULT_NAME_PATTERN, docBlockName, modelPartOfBlockName } from './docsBlocks';
import type { ResourceKind } from './manifest';

// -----------------------------------------------------------------------------
// Coverage

export type GroupBy = 'folder' | 'layer' | 'tag' | 'kind' | 'owner' | 'resource';

export interface CoverageCounts {
  resources: number;
  resourcesWithDescription: number;
  columns: number;
  documented: number;
  inheritable: number;
  missing: number;
}

export interface CoverageGroup extends CoverageCounts {
  key: string;
}

export interface CoverageReport {
  total: CoverageCounts;
  groups: CoverageGroup[];
}

export function emptyCounts(): CoverageCounts {
  return { resources: 0, resourcesWithDescription: 0, columns: 0, documented: 0, inheritable: 0, missing: 0 };
}

export function addResource(counts: CoverageCounts, r: ResourceReport): void {
  counts.resources++;
  if (r.hasDescription) counts.resourcesWithDescription++;
  for (const c of r.columns) {
    counts.columns++;
    counts[c.status]++;
  }
}

/** Column coverage in percent (0–100). With `includeInheritable`, inheritable columns count as documented. */
export function percent(counts: CoverageCounts, includeInheritable = false): number {
  if (counts.columns === 0) return 100;
  const ok = counts.documented + (includeInheritable ? counts.inheritable : 0);
  return (100 * ok) / counts.columns;
}

export function groupKeys(r: ResourceReport, by: GroupBy): string[] {
  switch (by) {
    case 'folder':
      return [r.folder];
    case 'layer':
      return [r.layer];
    case 'tag':
      return r.resource.tags.length > 0 ? r.resource.tags : ['(no tag)'];
    case 'kind':
      return [r.resource.kind];
    case 'owner':
      return [r.resource.owner ?? r.resource.group ?? '(no owner)'];
    case 'resource':
      return [r.label];
  }
}

export interface CoverageFilter {
  kinds?: ResourceKind[];
}

export function coverage(analysis: Analysis, by: GroupBy = 'folder', filter: CoverageFilter = {}): CoverageReport {
  const total = emptyCounts();
  const groups = new Map<string, CoverageGroup>();
  for (const r of analysis.resources.values()) {
    if (filter.kinds && !filter.kinds.includes(r.resource.kind)) continue;
    addResource(total, r);
    for (const key of groupKeys(r, by)) {
      let g = groups.get(key);
      if (!g) {
        g = { key, ...emptyCounts() };
        groups.set(key, g);
      }
      addResource(g, r);
    }
  }
  return { total, groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

// -----------------------------------------------------------------------------
// Work list: what needs to be written by hand

export interface WorkItem {
  resource: ResourceReport;
  column: ColumnReport;
}

/** Columns without a description: "must be written by hand" first, then inheritable. */
export function workList(analysis: Analysis): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of analysis.resources.values()) {
    for (const c of r.columns) if (c.status !== 'documented') items.push({ resource: r, column: c });
  }
  const rank = (s: string) => (s === 'missing' ? 0 : 1);
  return items.sort(
    (a, b) =>
      rank(a.column.status) - rank(b.column.status) ||
      a.resource.label.localeCompare(b.resource.label) ||
      a.column.name.localeCompare(b.column.name),
  );
}

// -----------------------------------------------------------------------------
// Docs-block candidates and conflicts

export interface ColumnUsage {
  resourceId: string;
  label: string;
  column: ColumnReport;
}

export interface DocsBlockCandidate {
  /** Lower-case column name. */
  column: string;
  usages: ColumnUsage[];
  /** Distinct non-empty descriptions in use. */
  descriptions: string[];
  /** All documented usages have the same text: a strong candidate. */
  sameText: boolean;
  /** Doc blocks already used for this column. */
  docBlocks: string[];
  /** Suggested block name, based on the column's origin. */
  suggestedName: string;
}

export interface CandidateOptions {
  minModels?: number;
  namePattern?: string;
}

function byColumnName(analysis: Analysis): Map<string, ColumnUsage[]> {
  const map = new Map<string, ColumnUsage[]>();
  for (const r of analysis.resources.values()) {
    for (const c of r.columns) {
      const key = c.name.toLowerCase();
      const list = map.get(key) ?? [];
      list.push({ resourceId: r.resource.uniqueId, label: r.label, column: c });
      map.set(key, list);
    }
  }
  return map;
}

/**
 * Columns that occur in at least `minModels` resources and are not all
 * linked to the same doc block already.
 */
export function docsBlockCandidates(analysis: Analysis, options: CandidateOptions = {}): DocsBlockCandidate[] {
  const minModels = options.minModels ?? 3;
  const pattern = options.namePattern ?? DEFAULT_NAME_PATTERN;
  const out: DocsBlockCandidate[] = [];
  for (const [column, usages] of byColumnName(analysis)) {
    if (usages.length < minModels) continue;
    const descriptions = [...new Set(usages.map((u) => u.column.description.trim()).filter((d) => d.length > 0))];
    const docBlocks = [...new Set(usages.map((u) => u.column.docBlock).filter((d): d is string => !!d))];
    const allLinked = docBlocks.length === 1 && usages.every((u) => u.column.docBlock === docBlocks[0]);
    if (allLinked) continue;
    // Name the block after the origin shared by most usages.
    const origins = new Map<string, { origin: ReturnType<Analysis['originOf']>; count: number }>();
    for (const u of usages) {
      const res = analysis.project.manifest.resources.get(u.resourceId)!;
      const o = analysis.originOf(res, u.column.name);
      const key = `${o.resource.uniqueId}|${o.column.toLowerCase()}`;
      const entry = origins.get(key) ?? { origin: o, count: 0 };
      entry.count++;
      origins.set(key, entry);
    }
    const origin = [...origins.values()].sort(
      (a, b) => b.count - a.count || a.origin.resource.name.localeCompare(b.origin.resource.name),
    )[0].origin;
    out.push({
      column,
      usages,
      descriptions,
      sameText: descriptions.length === 1,
      docBlocks,
      suggestedName: docBlocks[0] ?? docBlockName(pattern, origin.resource, origin.column),
    });
  }
  return out.sort((a, b) => Number(b.sameText) - Number(a.sameText) || b.usages.length - a.usages.length || a.column.localeCompare(b.column));
}

export interface Conflict {
  column: string;
  /** Distinct description -> resources using it. */
  variants: { description: string; usages: ColumnUsage[] }[];
}

/** Columns with the same name but different descriptions. */
export function conflicts(analysis: Analysis): Conflict[] {
  const out: Conflict[] = [];
  for (const [column, usages] of byColumnName(analysis)) {
    const variants = new Map<string, ColumnUsage[]>();
    for (const u of usages) {
      const d = u.column.description.trim();
      if (!d) continue;
      const list = variants.get(d) ?? [];
      list.push(u);
      variants.set(d, list);
    }
    if (variants.size > 1) {
      out.push({ column, variants: [...variants].map(([description, us]) => ({ description, usages: us })) });
    }
  }
  return out.sort((a, b) => a.column.localeCompare(b.column));
}

// -----------------------------------------------------------------------------
// Orphaned doc blocks

export interface OrphanBlock {
  name: string;
  file: string;
  model: string;
}

/** Doc blocks whose name follows the pattern but whose `{model}` part matches no resource. */
export function orphanDocBlocks(analysis: Analysis, namePattern = DEFAULT_NAME_PATTERN): OrphanBlock[] {
  const names = new Set<string>();
  for (const r of analysis.project.manifest.resources.values()) {
    const label = r.kind === 'source' && r.sourceName ? `${r.sourceName}_${r.name}` : r.name;
    names.add(label.toLowerCase());
  }
  const out: OrphanBlock[] = [];
  for (const block of analysis.project.docBlocks().values()) {
    const model = modelPartOfBlockName(namePattern, block.name);
    if (!model) continue;
    // Model names may themselves contain "__": accept any split that matches.
    if (names.has(model) || [...names].some((n) => block.name.toLowerCase().includes(`_${n}__`))) continue;
    out.push({ name: block.name, file: block.file, model });
  }
  return out;
}

/** Doc blocks whose contents equal the given text (trimmed, whitespace-normalised). */
export function blocksWithText(analysis: Analysis, text: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(text);
  if (!target) return [];
  return [...analysis.project.docBlocks().values()].filter((b) => norm(b.contents) === target).map((b) => b.name);
}

