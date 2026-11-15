import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addColumns,
  Analysis,
  applyEdits,
  checkStaleness,
  conflicts,
  coverage,
  CoverageCounts,
  DbtProject,
  docsBlockCandidates,
  GroupBy,
  inheritedValue,
  orphanDocBlocks,
  percent,
  setColumnDescription,
  TextEdit,
  workList,
} from '@dbt-docs-helper/core';

export type Format = 'text' | 'json' | 'markdown';

export interface CommonOptions {
  projectDir: string;
  manifest?: string;
  format: Format;
}

export interface Result {
  output: string;
  exitCode: number;
}

export function loadAnalysis(opts: CommonOptions): Analysis {
  const project = DbtProject.load(path.resolve(opts.projectDir), { manifestPath: opts.manifest });
  return new Analysis(project);
}

const pct = (n: number) => `${n.toFixed(1)}%`;

function table(rows: string[][], format: Format): string {
  if (format === 'markdown') {
    const [head, ...body] = rows;
    const sep = head.map((_, i) => (i === 0 ? '---' : '---:'));
    return [head, sep, ...body].map((r) => `| ${r.join(' | ')} |`).join('\n');
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r, ri) => {
      const line = r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
      return ri === 0 ? `${line}\n${widths.map((w) => '-'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

function countsRow(key: string, c: CoverageCounts, includeInheritable: boolean): string[] {
  return [
    key,
    String(c.columns),
    String(c.documented),
    String(c.inheritable),
    String(c.missing),
    pct(percent(c, includeInheritable)),
    `${c.resourcesWithDescription}/${c.resources}`,
  ];
}

// -----------------------------------------------------------------------------

export interface CoverageOptions extends CommonOptions {
  by: GroupBy;
  failUnder?: number;
  includeInheritable: boolean;
}

export function coverageCommand(analysis: Analysis, opts: CoverageOptions): Result {
  const report = coverage(analysis, opts.by);
  const total = percent(report.total, opts.includeInheritable);
  const failed = opts.failUnder !== undefined && total < opts.failUnder;
  let output: string;
  if (opts.format === 'json') {
    output = JSON.stringify(
      {
        coverage: Number(total.toFixed(2)),
        coverageWithInheritance: Number(percent(report.total, true).toFixed(2)),
        failUnder: opts.failUnder ?? null,
        passed: !failed,
        total: report.total,
        groups: report.groups.map((g) => ({ ...g, coverage: Number(percent(g, opts.includeInheritable).toFixed(2)) })),
      },
      null,
      2,
    );
  } else {
    const header = [opts.by, 'columns', 'documented', 'inheritable', 'missing', 'coverage', 'described'];
    const rows = [header, ...report.groups.map((g) => countsRow(g.key, g, opts.includeInheritable))];
    rows.push(countsRow(opts.format === 'markdown' ? '**total**' : 'TOTAL', report.total, opts.includeInheritable));
    const title = opts.format === 'markdown' ? '### dbt-docs-helper: documentation coverage\n\n' : '';
    const summary =
      `Column coverage: ${pct(total)}` +
      (opts.includeInheritable ? ' (inheritable counted as documented)' : ` (${pct(percent(report.total, true))} with inheritance)`);
    const verdict =
      opts.failUnder === undefined ? '' : failed ? `\nFAILED: coverage is below ${opts.failUnder}%` : `\nPASSED: coverage is at least ${opts.failUnder}%`;
    output = `${title}${table(rows, opts.format)}\n\n${summary}${verdict}`;
  }
  return { output, exitCode: failed ? 1 : 0 };
}

// -----------------------------------------------------------------------------

export interface MissingOptions extends CommonOptions {
  onlyMissing: boolean;
  limit?: number;
}

export function missingCommand(analysis: Analysis, opts: MissingOptions): Result {
  let items = workList(analysis);
  if (opts.onlyMissing) items = items.filter((i) => i.column.status === 'missing');
  if (opts.limit !== undefined) items = items.slice(0, opts.limit);
  if (opts.format === 'json') {
    return {
      output: JSON.stringify(
        items.map((i) => ({
          resource: i.resource.resource.uniqueId,
          label: i.resource.label,
          column: i.column.name,
          status: i.column.status,
          notInYaml: i.column.notInYaml,
          file: i.column.yaml?.file ?? i.resource.yaml?.file ?? i.resource.resource.yamlPath ?? null,
          inheritFrom: i.column.candidates[0] ? `${i.column.candidates[0].fromLabel}.${i.column.candidates[0].fromColumn}` : null,
        })),
        null,
        2,
      ),
      exitCode: 0,
    };
  }
  const rows = [['resource', 'column', 'status', 'note']];
  for (const i of items) {
    const c = i.column.candidates[0];
    const note = c ? `from ${c.fromLabel}.${c.fromColumn} (${c.kind})` : i.column.notInYaml ? 'not in YAML' : '';
    rows.push([i.resource.label, i.column.name, i.column.status, note]);
  }
  if (rows.length === 1) return { output: 'Nothing to document. 🎉', exitCode: 0 };
  // left-align all columns for this table
  const widths = rows[0].map((_, k) => Math.max(...rows.map((r) => r[k].length)));
  const text =
    opts.format === 'markdown'
      ? [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n')
      : rows.map((r) => r.map((c, k) => c.padEnd(widths[k])).join('  ').trimEnd()).join('\n');
  return { output: text, exitCode: 0 };
}

// -----------------------------------------------------------------------------

export interface CandidatesOptions extends CommonOptions {
  minModels: number;
  namePattern?: string;
}

export function candidatesCommand(analysis: Analysis, opts: CandidatesOptions): Result {
  const list = docsBlockCandidates(analysis, { minModels: opts.minModels, namePattern: opts.namePattern });
  if (opts.format === 'json') {
    return {
      output: JSON.stringify(
        list.map((c) => ({
          column: c.column,
          models: c.usages.map((u) => u.label),
          sameText: c.sameText,
          descriptions: c.descriptions,
          docBlocks: c.docBlocks,
          suggestedName: c.suggestedName,
        })),
        null,
        2,
      ),
      exitCode: 0,
    };
  }
  if (list.length === 0) return { output: `No columns occur in ${opts.minModels} or more models without a shared doc block.`, exitCode: 0 };
  const lines = list.map((c) => {
    const strength = c.sameText ? 'same text everywhere' : c.descriptions.length === 0 ? 'no description yet' : `${c.descriptions.length} different texts`;
    return `${c.column} — ${c.usages.length} models, ${strength} → ${c.suggestedName}`;
  });
  return { output: (opts.format === 'markdown' ? lines.map((l) => `- ${l}`) : lines).join('\n'), exitCode: 0 };
}

export function conflictsCommand(analysis: Analysis, opts: CommonOptions): Result {
  const list = conflicts(analysis);
  if (opts.format === 'json') {
    return {
      output: JSON.stringify(
        list.map((c) => ({ column: c.column, variants: c.variants.map((v) => ({ description: v.description, models: v.usages.map((u) => u.label) })) })),
        null,
        2,
      ),
      exitCode: 0,
    };
  }
  if (list.length === 0) return { output: 'No conflicting descriptions.', exitCode: 0 };
  const out: string[] = [];
  for (const c of list) {
    out.push(c.column);
    for (const v of c.variants) out.push(`  "${v.description}"  (${v.usages.map((u) => u.label).join(', ')})`);
  }
  return { output: out.join('\n'), exitCode: 0 };
}

// -----------------------------------------------------------------------------

export interface InheritOptions extends CommonOptions {
  write: boolean;
  includeRenamed: boolean;
  includeNameMatches: boolean;
  select?: string[];
}

export interface PlannedInheritance {
  file: string;
  resource: string;
  column: string;
  from: string;
  value: string;
  kind: string;
}

export function inheritCommand(analysis: Analysis, opts: InheritOptions): Result {
  const project = analysis.project;
  const planned: PlannedInheritance[] = [];
  const edits = new Map<string, TextEdit[]>();
  for (const r of analysis.resources.values()) {
    if (opts.select && !opts.select.includes(r.label) && !opts.select.includes(r.resource.name)) continue;
    for (const c of r.columns) {
      if (c.status !== 'inheritable' || !c.yaml) continue;
      const cand = c.candidates[0];
      if (!opts.includeRenamed && cand.kind !== 'passthrough') continue;
      if (!opts.includeNameMatches && cand.via !== 'sql') continue;
      // Ambiguous: several different upstream texts. Leave it to a human.
      if (c.candidates.length > 1) continue;
      const value = inheritedValue(cand);
      const index = project.yamlFiles.get(c.yaml.file)!;
      const list = edits.get(c.yaml.file) ?? [];
      list.push(setColumnDescription(index, c.yaml.column, value));
      edits.set(c.yaml.file, list);
      planned.push({ file: c.yaml.file, resource: r.label, column: c.name, from: `${cand.fromLabel}.${cand.fromColumn}`, value, kind: cand.kind });
    }
  }
  if (opts.write) {
    for (const [file, list] of edits) {
      const index = project.yamlFiles.get(file)!;
      fs.writeFileSync(project.absolute(file), applyEdits(index.text, list));
    }
  }
  if (opts.format === 'json') return { output: JSON.stringify({ written: opts.write, changes: planned }, null, 2), exitCode: 0 };
  if (planned.length === 0) return { output: 'Nothing to inherit.', exitCode: 0 };
  const lines = planned.map((p) => `${p.file}: ${p.resource}.${p.column} ← ${p.from}  ${p.value}`);
  lines.push('');
  lines.push(opts.write ? `Wrote ${planned.length} descriptions to ${edits.size} files.` : `${planned.length} descriptions can be inherited. Run with --write to update the YAML files.`);
  return { output: lines.join('\n'), exitCode: 0 };
}

// -----------------------------------------------------------------------------

export interface AddColumnsOptions extends CommonOptions {
  write: boolean;
}

/** Add columns that exist in catalog.json but not in YAML. */
export function addColumnsCommand(analysis: Analysis, opts: AddColumnsOptions): Result {
  const project = analysis.project;
  if (!project.catalog) return { output: 'No catalog.json found. Run `dbt docs generate` first.', exitCode: 2 };
  const edits = new Map<string, TextEdit[]>();
  const lines: string[] = [];
  for (const r of analysis.resources.values()) {
    if (!r.yaml) continue;
    const missing = r.columns.filter((c) => c.notInYaml);
    if (missing.length === 0) continue;
    const index = project.yamlFiles.get(r.yaml.file)!;
    const edit = addColumns(
      index,
      r.yaml.resource,
      missing.map((c) => ({ name: c.name })),
    );
    if (!edit) continue;
    const list = edits.get(r.yaml.file) ?? [];
    list.push(edit);
    edits.set(r.yaml.file, list);
    lines.push(`${r.yaml.file}: ${r.label} + ${missing.map((c) => c.name).join(', ')}`);
  }
  if (opts.write) {
    for (const [file, list] of edits) fs.writeFileSync(project.absolute(file), applyEdits(project.yamlFiles.get(file)!.text, list));
  }
  if (lines.length === 0) return { output: 'All warehouse columns are in YAML.', exitCode: 0 };
  lines.push('', opts.write ? 'YAML files updated.' : 'Run with --write to update the YAML files.');
  return { output: lines.join('\n'), exitCode: 0 };
}

// -----------------------------------------------------------------------------

export interface CheckOptions extends CoverageOptions {
  namePattern?: string;
  failOnStale: boolean;
  failOnOrphans: boolean;
}

/** Everything a CI job wants: coverage threshold, stale manifest and orphaned doc blocks. */
export function checkCommand(analysis: Analysis, opts: CheckOptions): Result {
  const cov = coverageCommand(analysis, { ...opts, format: opts.format === 'json' ? 'json' : opts.format });
  const problems: string[] = [];
  const stale = checkStaleness(analysis.project);
  if (stale.stale) {
    const msg = `manifest.json is older than ${stale.newestFile ?? 'the project files'}. Run \`dbt parse\`.`;
    problems.push(opts.failOnStale ? `ERROR: ${msg}` : `WARNING: ${msg}`);
  }
  const orphans = orphanDocBlocks(analysis, opts.namePattern);
  for (const o of orphans) {
    const msg = `doc block "${o.name}" (${o.file}) refers to model "${o.model}", which does not exist.`;
    problems.push(opts.failOnOrphans ? `ERROR: ${msg}` : `WARNING: ${msg}`);
  }
  const exitCode = cov.exitCode || ((opts.failOnStale && stale.stale) || (opts.failOnOrphans && orphans.length > 0) ? 1 : 0);
  if (opts.format === 'json') {
    const json = JSON.parse(cov.output);
    return {
      output: JSON.stringify({ ...json, stale: stale.stale, orphanDocBlocks: orphans, passed: exitCode === 0 }, null, 2),
      exitCode,
    };
  }
  return { output: [cov.output, ...(problems.length ? ['', ...problems] : [])].join('\n'), exitCode };
}
