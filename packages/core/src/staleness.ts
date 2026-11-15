/**
 * Detecting a manifest that is older than the project files.
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
}

const EXTS = ['.sql', '.yml', '.yaml', '.csv', '.md', '.py'];
const SKIP = new Set(['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'logs', '.git']);

function newestIn(dir: string, best: { file?: string; time: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith('.')) newestIn(p, best);
    } else if (EXTS.some((x) => e.name.toLowerCase().endsWith(x))) {
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

/**
 * Compare the manifest's modification time with the project's SQL, YAML,
 * CSV and Markdown files. `toleranceMs` avoids false alarms from clocks and
 * from files written during the same `dbt parse`.
 */
export function checkStaleness(project: DbtProject, toleranceMs = 2000): StalenessResult {
  let manifestTime = 0;
  try {
    manifestTime = fs.statSync(project.manifestPath).mtimeMs;
  } catch {
    return { stale: true, manifestTime: 0 };
  }
  const best: { file?: string; time: number } = { time: 0 };
  const c = project.config;
  for (const d of new Set([...c.modelPaths, ...c.seedPaths, ...c.snapshotPaths, ...c.docsPaths])) {
    newestIn(path.join(project.root, d), best);
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
  const stale = best.time > manifestTime + toleranceMs;
  return {
    stale,
    manifestTime,
    newestFile: stale && best.file ? project.relative(best.file) : undefined,
    newestTime: stale ? best.time : undefined,
  };
}
