/**
 * A dbt project on disk: `dbt_project.yml`, the manifest, optional catalog,
 * the YAML property files and the Markdown files with doc blocks.
 *
 * YAML and Markdown contents can be overridden in memory (for unsaved editor
 * buffers) with {@link DbtProject.setFileText}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Catalog, Manifest, parseCatalog, parseManifest, Resource } from './manifest';
import { indexYaml, YamlFileIndex, YamlResource } from './yamlIndex';
import { parseDocBlocks, ParsedDocBlock } from './docsBlocks';

export interface ProjectConfig {
  name: string;
  modelPaths: string[];
  seedPaths: string[];
  snapshotPaths: string[];
  docsPaths: string[];
  targetPath: string;
}

export interface LoadOptions {
  /** Manifest path, absolute or relative to the project root. Default `<target-path>/manifest.json`. */
  manifestPath?: string;
  /** Catalog path. Default `<target-path>/catalog.json` (optional, ignored if missing). */
  catalogPath?: string;
}

export interface DocBlockLocation extends ParsedDocBlock {
  file: string;
}

const IGNORED_DIRS = new Set(['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'logs', '.git', '.venv', 'venv']);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function readProjectConfig(root: string): ProjectConfig {
  const file = path.join(root, 'dbt_project.yml');
  const raw = (parseYaml(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const list = (key: string, fallback: string[]): string[] => {
    const v = raw[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;
  };
  const modelPaths = list('model-paths', list('source-paths', ['models']));
  const seedPaths = list('seed-paths', list('data-paths', ['seeds']));
  const snapshotPaths = list('snapshot-paths', ['snapshots']);
  const macroPaths = list('macro-paths', ['macros']);
  const analysisPaths = list('analysis-paths', ['analyses']);
  const testPaths = list('test-paths', ['tests']);
  return {
    name: typeof raw.name === 'string' ? raw.name : path.basename(root),
    modelPaths,
    seedPaths,
    snapshotPaths,
    docsPaths: list('docs-paths', [...modelPaths, ...seedPaths, ...snapshotPaths, ...macroPaths, ...analysisPaths, ...testPaths]),
    targetPath: typeof raw['target-path'] === 'string' ? (raw['target-path'] as string) : 'target',
  };
}

function walk(dir: string, exts: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), exts, out);
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      out.push(path.join(dir, e.name));
    }
  }
}

export class DbtProject {
  readonly yamlFiles = new Map<string, YamlFileIndex>();
  readonly docFiles = new Map<string, ParsedDocBlock[]>();
  private resourceYaml?: Map<string, { file: string; resource: YamlResource }>;
  private docBlockIndex?: Map<string, DocBlockLocation>;
  /** Monotonic version, bumped on every change; useful for caching. */
  version = 0;

  constructor(
    readonly root: string,
    readonly config: ProjectConfig,
    public manifest: Manifest,
    public catalog: Catalog | undefined,
    readonly manifestPath: string,
  ) {}

  static load(root: string, options: LoadOptions = {}): DbtProject {
    const config = readProjectConfig(root);
    const manifestPath = path.resolve(root, options.manifestPath ?? path.join(config.targetPath, 'manifest.json'));
    const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const catalogPath = path.resolve(root, options.catalogPath ?? path.join(config.targetPath, 'catalog.json'));
    let catalog: Catalog | undefined;
    if (fs.existsSync(catalogPath)) {
      try {
        catalog = parseCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')));
      } catch {
        catalog = undefined;
      }
    }
    const project = new DbtProject(root, config, manifest, catalog, manifestPath);
    project.scanFiles();
    return project;
  }

  /** Re-read the YAML and Markdown files from disk. */
  scanFiles(): void {
    this.yamlFiles.clear();
    this.docFiles.clear();
    const yamlDirs = new Set([...this.config.modelPaths, ...this.config.seedPaths, ...this.config.snapshotPaths]);
    const yamlPaths: string[] = [];
    for (const d of yamlDirs) walk(path.join(this.root, d), ['.yml', '.yaml'], yamlPaths);
    // Files referenced by the manifest, even if they live elsewhere.
    for (const r of this.manifest.resources.values()) {
      if (r.packageName === this.manifest.projectName && r.yamlPath) yamlPaths.push(path.join(this.root, r.yamlPath));
    }
    for (const abs of new Set(yamlPaths)) {
      try {
        this.setFileText(this.relative(abs), fs.readFileSync(abs, 'utf8'), false);
      } catch {
        /* unreadable or missing file */
      }
    }
    const mdPaths: string[] = [];
    for (const d of new Set(this.config.docsPaths)) walk(path.join(this.root, d), ['.md'], mdPaths);
    for (const abs of new Set(mdPaths)) {
      try {
        this.setFileText(this.relative(abs), fs.readFileSync(abs, 'utf8'), false);
      } catch {
        /* ignore */
      }
    }
    this.invalidate();
  }

  reloadManifest(options: LoadOptions = {}): void {
    this.manifest = parseManifest(JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')));
    const catalogPath = path.resolve(this.root, options.catalogPath ?? path.join(this.config.targetPath, 'catalog.json'));
    this.catalog = fs.existsSync(catalogPath) ? parseCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))) : undefined;
    this.invalidate();
  }

  relative(absPath: string): string {
    return toPosix(path.relative(this.root, absPath));
  }

  absolute(relPath: string): string {
    return path.join(this.root, relPath);
  }

  /** True if the (relative) path is inside this project. */
  contains(absPath: string): boolean {
    const rel = path.relative(this.root, absPath);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * Update the in-memory content of a YAML or Markdown file (relative path).
   * Returns true if the file is relevant to the project.
   */
  setFileText(relPath: string, text: string, invalidate = true): boolean {
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
      if (path.posix.basename(lower) === 'dbt_project.yml' || lower.endsWith('packages.yml') || lower.endsWith('dependencies.yml')) {
        return false;
      }
      this.yamlFiles.set(relPath, indexYaml(text));
    } else if (lower.endsWith('.md')) {
      this.docFiles.set(relPath, parseDocBlocks(text));
    } else {
      return false;
    }
    if (invalidate) this.invalidate();
    return true;
  }

  removeFile(relPath: string): void {
    this.yamlFiles.delete(relPath);
    this.docFiles.delete(relPath);
    this.invalidate();
  }

  invalidate(): void {
    this.resourceYaml = undefined;
    this.docBlockIndex = undefined;
    this.version++;
  }

  /** Resources that belong to this project (not installed packages). */
  ownResources(): Resource[] {
    return [...this.manifest.resources.values()].filter((r) => r.packageName === this.manifest.projectName);
  }

  /** The YAML entry for a resource (from the in-memory YAML, not the manifest). */
  yamlFor(resource: Resource): { file: string; resource: YamlResource } | undefined {
    if (!this.resourceYaml) this.buildResourceYaml();
    return this.resourceYaml!.get(resource.uniqueId);
  }

  /** Find the manifest resource for an entry in a YAML file. */
  resourceForYaml(yr: YamlResource): Resource | undefined {
    for (const r of this.manifest.resources.values()) {
      if (r.packageName !== this.manifest.projectName || r.kind !== yr.kind) continue;
      if (r.name !== yr.name) continue;
      if (r.kind === 'source' && r.sourceName !== yr.sourceName) continue;
      return r;
    }
    return undefined;
  }

  private buildResourceYaml(): void {
    const map = new Map<string, { file: string; resource: YamlResource }>();
    const byKey = new Map<string, Resource[]>();
    for (const r of this.ownResources()) {
      const key = `${r.kind}:${r.sourceName ?? ''}:${r.name}`;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    for (const [file, index] of this.yamlFiles) {
      for (const yr of index.resources) {
        const candidates = byKey.get(`${yr.kind}:${yr.sourceName ?? ''}:${yr.name}`) ?? [];
        for (const r of candidates) {
          const existing = map.get(r.uniqueId);
          // Prefer the file the manifest says documents the resource.
          if (!existing || (r.yamlPath === file && existing.file !== file)) map.set(r.uniqueId, { file, resource: yr });
        }
      }
    }
    this.resourceYaml = map;
  }

  /** All doc blocks, from the Markdown files on disk/in memory, falling back to the manifest. Keyed by name. */
  docBlocks(): Map<string, DocBlockLocation> {
    if (this.docBlockIndex) return this.docBlockIndex;
    const map = new Map<string, DocBlockLocation>();
    for (const doc of this.manifest.docs.values()) {
      if (doc.name === '__overview__') continue;
      map.set(doc.name, {
        name: doc.name,
        contents: doc.contents.trim(),
        file: doc.originalFilePath,
        start: -1,
        end: -1,
        nameRange: [-1, -1],
      });
    }
    for (const [file, blocks] of this.docFiles) {
      for (const b of blocks) map.set(b.name, { ...b, file });
    }
    this.docBlockIndex = map;
    return map;
  }

  /** Markdown files that can hold doc blocks (relative paths). */
  docFilePaths(): string[] {
    return [...this.docFiles.keys()].sort();
  }
}

/** Find dbt projects (directories with `dbt_project.yml`) below a directory. */
export function findProjects(dir: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const visit = (d: string, depth: number) => {
    if (fs.existsSync(path.join(d, 'dbt_project.yml'))) found.push(d);
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) visit(path.join(d, e.name), depth + 1);
    }
  };
  visit(dir, 0);
  return found;
}
