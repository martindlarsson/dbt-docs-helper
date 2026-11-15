/**
 * Keeps one {@link DbtProject} + {@link Analysis} per dbt project in the
 * workspace, in sync with the manifest, the files on disk and unsaved editor
 * buffers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Analysis, checkStaleness, DbtProject, StalenessResult } from '@dbt-docs-helper/core';
import { settings } from './config';

export interface ProjectState {
  project: DbtProject;
  /** Null when the manifest could not be loaded. */
  error?: string;
  stale?: StalenessResult;
}

export class ProjectManager implements vscode.Disposable {
  private states = new Map<string, ProjectState>();
  private analyses = new Map<string, { version: number; analysis: Analysis }>();
  private failed = new Map<string, string>();
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  private changeTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private warnedStale = new Set<string>();
  readonly onDidChange = this.changeEmitter.event;
  readonly output = vscode.window.createOutputChannel('dbt-docs-helper');

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml,md,json,sql,csv}');
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => this.onDiskChange(uri)),
      watcher.onDidCreate((uri) => this.onDiskChange(uri)),
      watcher.onDidDelete((uri) => this.onDiskDelete(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onBufferChange(e.document)),
      vscode.workspace.onDidOpenTextDocument((d) => this.onBufferChange(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onBufferClose(d)),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleStaleCheck()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dbt-docs-helper.manifestPath') || e.affectsConfiguration('dbt-docs-helper.catalogPath')) void this.discover();
        else if (e.affectsConfiguration('dbt-docs-helper')) {
          this.analyses.clear();
          this.fireChange(0);
        }
      }),
    );
  }

  /** Find and load all dbt projects in the workspace. */
  async discover(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/dbt_project.yml', '{**/dbt_packages/**,**/dbt_modules/**,**/node_modules/**,**/target/**}');
    this.states.clear();
    this.analyses.clear();
    this.failed.clear();
    for (const file of files) {
      const root = path.dirname(file.fsPath);
      this.load(root);
    }
    vscode.commands.executeCommand('setContext', 'dbt-docs-helper.hasProject', this.states.size > 0);
    this.fireChange(0);
    this.scheduleStaleCheck(0);
  }

  private load(root: string): void {
    const scope = vscode.Uri.file(root);
    const catalog = settings.catalogPath(scope);
    try {
      const project = DbtProject.load(root, { manifestPath: settings.manifestPath(scope), catalogPath: catalog || undefined });
      // Unsaved buffers win over the files on disk.
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && project.contains(doc.uri.fsPath) && doc.isDirty) {
          project.setFileText(project.relative(doc.uri.fsPath), doc.getText(), false);
        }
      }
      project.invalidate();
      this.states.set(root, { project });
      this.failed.delete(root);
      this.output.appendLine(
        `Loaded ${root}: ${project.ownResources().length} resources, manifest ${project.manifest.schemaVersion ?? '?'} (dbt ${project.manifest.dbtVersion ?? '?'})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.states.delete(root);
      this.failed.set(root, message);
      this.output.appendLine(`Could not load ${root}: ${message}`);
    }
  }

  /** Projects whose manifest could not be read (root -> error). */
  failures(): Map<string, string> {
    return this.failed;
  }

  projects(): ProjectState[] {
    return [...this.states.values()];
  }

  /** The (deepest) project that contains a file. */
  projectFor(uri: vscode.Uri): ProjectState | undefined {
    if (uri.scheme !== 'file' && uri.scheme !== 'untitled') return undefined;
    let best: ProjectState | undefined;
    for (const state of this.states.values()) {
      if (state.project.contains(uri.fsPath) && (!best || state.project.root.length > best.project.root.length)) best = state;
    }
    return best;
  }

  /** Current analysis for a project, recomputed if anything changed. */
  analysis(project: DbtProject): Analysis {
    const cached = this.analyses.get(project.root);
    if (cached && cached.version === project.version) return cached.analysis;
    const started = Date.now();
    const analysis = new Analysis(project, { layers: settings.layers() });
    this.analyses.set(project.root, { version: project.version, analysis });
    const ms = Date.now() - started;
    if (ms > 500) this.output.appendLine(`Analysis of ${project.root} took ${ms} ms`);
    return analysis;
  }

  analysisFor(uri: vscode.Uri): { state: ProjectState; analysis: Analysis } | undefined {
    const state = this.projectFor(uri);
    if (!state) return undefined;
    return { state, analysis: this.analysis(state.project) };
  }

  // ---------------------------------------------------------------------------

  private isManifest(state: ProjectState, uri: vscode.Uri): boolean {
    const p = path.normalize(uri.fsPath);
    const catalog = path.join(path.dirname(state.project.manifestPath), 'catalog.json');
    return p === path.normalize(state.project.manifestPath) || p === path.normalize(catalog);
  }

  private onDiskChange(uri: vscode.Uri): void {
    if (path.basename(uri.fsPath) === 'dbt_project.yml') {
      void this.discover();
      return;
    }
    // A manifest for a project that failed to load may have appeared.
    if (uri.fsPath.endsWith('manifest.json')) {
      for (const root of this.failed.keys()) {
        if (uri.fsPath.startsWith(root)) {
          this.load(root);
          this.fireChange();
        }
      }
    }
    const state = this.projectFor(uri);
    if (!state) return;
    if (this.isManifest(state, uri)) {
      try {
        state.project.reloadManifest({ catalogPath: settings.catalogPath(uri) || undefined });
        this.warnedStale.delete(state.project.root);
        this.output.appendLine(`Reloaded manifest for ${state.project.root}`);
      } catch (err) {
        this.output.appendLine(`Could not reload manifest: ${err instanceof Error ? err.message : err}`);
        return;
      }
      this.fireChange();
      this.scheduleStaleCheck();
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open && open.isDirty) return;
    if (!/\.(ya?ml|md)$/i.test(uri.fsPath)) {
      this.scheduleStaleCheck();
      return;
    }
    try {
      const text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
      if (state.project.setFileText(state.project.relative(uri.fsPath), text)) this.fireChange();
    } catch {
      /* file vanished */
    }
    this.scheduleStaleCheck();
  }

  private onDiskDelete(uri: vscode.Uri): void {
    const state = this.projectFor(uri);
    if (!state) return;
    state.project.removeFile(state.project.relative(uri.fsPath));
    this.fireChange();
  }

  private onBufferChange(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || !/\.(ya?ml|md)$/i.test(doc.uri.fsPath)) return;
    const state = this.projectFor(doc.uri);
    if (!state) return;
    const rel = state.project.relative(doc.uri.fsPath);
    const text = doc.getText();
    const current = state.project.yamlFiles.get(rel)?.text;
    if (current === text) return;
    if (state.project.setFileText(rel, text)) this.fireChange();
  }

  private onBufferClose(doc: vscode.TextDocument): void {
    // Revert to the file on disk when an unsaved buffer is closed.
    if (doc.uri.scheme !== 'file' || !/\.(ya?ml|md)$/i.test(doc.uri.fsPath)) return;
    const state = this.projectFor(doc.uri);
    if (!state) return;
    try {
      const text = fs.readFileSync(doc.uri.fsPath, 'utf8');
      if (state.project.setFileText(state.project.relative(doc.uri.fsPath), text)) this.fireChange();
    } catch {
      state.project.removeFile(state.project.relative(doc.uri.fsPath));
      this.fireChange();
    }
  }

  private fireChange(delay = 250): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.changeEmitter.fire(), delay);
  }

  // ---------------------------------------------------------------------------
  // Stale manifest

  private scheduleStaleCheck(delay = 1500): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.checkStale(), delay);
  }

  private checkStale(): void {
    let changed = false;
    for (const state of this.states.values()) {
      const result = checkStaleness(state.project);
      if (result.stale !== state.stale?.stale) changed = true;
      state.stale = result;
      if (result.stale && settings.staleManifestWarning(vscode.Uri.file(state.project.root)) && !this.warnedStale.has(state.project.root)) {
        this.warnedStale.add(state.project.root);
        const name = state.project.config.name;
        const newest = result.newestFile ? ` than ${result.newestFile}` : '';
        void vscode.window
          .showWarningMessage(
            `dbt-docs-helper: manifest.json for "${name}" is older${newest}. Upstream descriptions and lineage may be out of date.`,
            'Run dbt parse',
            'Ignore',
          )
          .then((choice) => {
            if (choice === 'Run dbt parse') void vscode.commands.executeCommand('dbt-docs-helper.runParse', state.project.root);
          });
      }
    }
    if (changed) this.changeEmitter.fire();
  }

  /** Run the configured parse command in a terminal. */
  runParse(root?: string): void {
    if (vscode.workspace.isTrusted === false) {
      void vscode.window.showWarningMessage('dbt-docs-helper: trust this workspace to run dbt parse from the editor.');
      return;
    }
    const state = root ? this.states.get(root) : this.projects()[0];
    const cwd = state?.project.root ?? root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const command = settings.parseCommand(vscode.Uri.file(cwd));
    const name = 'dbt-docs-helper';
    let terminal = vscode.window.terminals.find((t) => t.name === name && (t.creationOptions as vscode.TerminalOptions).cwd === cwd);
    if (!terminal) terminal = vscode.window.createTerminal({ name, cwd });
    terminal.show(true);
    terminal.sendText(command);
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
    this.output.dispose();
  }

  get extensionContext(): vscode.ExtensionContext {
    return this.context;
  }
}
