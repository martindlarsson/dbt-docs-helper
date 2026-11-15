/**
 * Detecting a manifest that is out of date.
 *
 * Only changes that the manifest is actually needed for count: SQL and
 * Python models, seeds and `dbt_project.yml` (lineage, new models, config).
 * YAML and Markdown are read directly from disk/the editor, so editing
 * documentation never makes the manifest "stale". The one exception is a
 * source table defined in YAML that the manifest does not know yet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DbtProject } from './project';

export interface StalenessResult {
  stale: boolean;
  manifestTime: number;
  /** Newest project file that is newer than the manifest, if any (relative path). */
  newestFile?: string;
  newestTime?: number;
  /** Human-readable reason, e.g. "models/orders.sql changed" or "new source crm.payments". */
  reason?: string;
}

/** File types whose changes need a new manifest. */
export const STALE_EXTENSIONS = ['.sql', '.py', '.csv'];
const SKIP = new Set(['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'logs', '.git']);

function newestIn(dir: string, exts: string[], best: { file?: string; time: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith('.')) newestIn(p, exts, best);
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      try {
        const t = fs.statSync(p).mtimeMs;
        if (t > best.time) {
          best.time = t;
          best.file = p;
        }
      } catch {
        /* ignore */
      }
    }
  }
}

/** Source tables defined in YAML that are not in the manifest yet (`source.table`). */
export function sourcesMissingFromManifest(project: DbtProject): string[] {
  const missing: string[] = [];
  for (const index of project.yamlFiles.values()) {
    for (const yr of index.resources) {
      if (yr.kind === 'source' && !project.resourceForYaml(yr)) missing.push(`${yr.sourceName}.${yr.name}`);
    }
  }
  return missing;
}

/**
 * Compare the manifest's modification time with the project's SQL, Python
 * and CSV files and `dbt_project.yml`. `toleranceMs` avoids false alarms
 * from clocks and from files written during the same `dbt parse`.
 */
export function checkStaleness(project: DbtProject, toleranceMs = 2000): StalenessResult {
  let manifestTime = 0;
  try {
    manifestTime = fs.statSync(project.manifestPath).mtimeMs;
  } catch {
    return { stale: true, manifestTime: 0, reason: 'manifest.json is missing' };
  }
  const best: { file?: string; time: number } = { time: 0 };
  const c = project.config;
  for (const d of new Set([...c.modelPaths, ...c.seedPaths, ...c.snapshotPaths])) {
    newestIn(path.join(project.root, d), STALE_EXTENSIONS, best);
  }
  try {
    const t = fs.statSync(path.join(project.root, 'dbt_project.yml')).mtimeMs;
    if (t > best.time) {
      best.time = t;
      best.file = path.join(project.root, 'dbt_project.yml');
    }
  } catch {
    /* ignore */
  }
  if (best.time > manifestTime + toleranceMs && best.file) {
    const file = project.relative(best.file);
    return { stale: true, manifestTime, newestFile: file, newestTime: best.time, reason: `${file} changed` };
  }
  const sources = sourcesMissingFromManifest(project);
  if (sources.length > 0) {
    return { stale: true, manifestTime, reason: `new source${sources.length === 1 ? '' : 's'} ${sources.join(', ')}` };
  }
  return { stale: false, manifestTime };
}
