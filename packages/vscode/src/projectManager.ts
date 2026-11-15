/**
 * Keeps one {@link DbtProject} + {@link Analysis} per dbt project in the
 * workspace, in sync with the manifest, the files on disk and unsaved editor
 * buffers.
 */
import { spawn } from 'node:child_process';
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
  /** Error from the last background parse, if it failed. */
  parseError?: string;
}

/** Extensions that keep manifest.json up to date in the background. */
const BACKGROUND_PARSERS = ['dbtLabsInc.dbt', 'innoverio.vscode-dbt-power-user'];
/** Wait this long before telling the user, so a background parse can finish. */
const STALE_GRACE_MS = 30_000;
/** A manifest written this soon after we started a parse is ours. */
const OWN_PARSE_WINDOW_MS = 5 * 60_000;

export class ProjectManager implements vscode.Disposable {
  private states = new Map<string, ProjectState>();
  private analyses = new Map<string, { version: number; analysis: Analysis }>();
  private failed = new Map<string, string>();
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  private changeTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  /** Projects we already showed the stale notification for (this session). */
  private notified = new Set<string>();
  /** When each project first became stale. */
  private staleSince = new Map<string, number>();
  /** Projects whose manifest is rewritten by something other than us. */
  private externalUpdates = new Set<string>();
  private lastOwnParse = new Map<string, number>();
  private parseRunning = new Set<string>();
  private parseAgain = new Set<string>();
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
        this.onManifestWritten(state.project.root);
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
  //
  // Goal: never nag. Documentation edits do not count (see core/staleness.ts).
  // In "auto" mode a notification is shown at most once per session, only
  // after a grace period, and never when something else (the dbt extension
  // with Fusion, dbt Power User, a terminal) keeps the manifest up to date.

  private scheduleStaleCheck(delay = 1500): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.checkStale(), delay);
  }

  /** True if another extension that refreshes manifest.json is installed. */
  private backgroundExtension(): string | undefined {
    const extensions = (vscode as { extensions?: typeof vscode.extensions }).extensions;
    if (!extensions?.getExtension) return undefined;
    for (const id of BACKGROUND_PARSERS) {
      const ext = extensions.getExtension(id);
      if (ext) return ext.packageJSON?.displayName ?? id;
    }
    return undefined;
  }

  /** Effective behaviour for a project. */
  staleMode(root: string): 'statusBar' | 'notification' | 'autoParse' | 'off' {
    const mode = settings.staleManifest(vscode.Uri.file(root));
    if (mode !== 'auto') return mode;
    if (this.externalUpdates.has(root) || this.backgroundExtension()) return 'statusBar';
    return 'notification';
  }

  /** Called when the manifest changed on disk. */
  private onManifestWritten(root: string): void {
    const ownRun = this.parseRunning.has(root) || Date.now() - (this.lastOwnParse.get(root) ?? 0) < OWN_PARSE_WINDOW_MS;
    if (!ownRun && !this.externalUpdates.has(root)) {
      this.externalUpdates.add(root);
      this.output.appendLine(`manifest.json in ${root} is kept up to date by another tool; stale warnings stay in the status bar.`);
    }
    this.staleSince.delete(root);
  }

  private checkStale(): void {
    let changed = false;
    for (const state of this.states.values()) {
      const root = state.project.root;
      const result = checkStaleness(state.project);
      if (result.stale !== state.stale?.stale || result.reason !== state.stale?.reason) changed = true;
      state.stale = result;
      if (!result.stale) {
        this.staleSince.delete(root);
        continue;
      }
      const mode = this.staleMode(root);
      if (mode === 'autoParse') {
        this.runParseInBackground(root);
      } else if (mode === 'notification' && !this.notified.has(root)) {
        const since = this.staleSince.get(root) ?? Date.now();
        this.staleSince.set(root, since);
        const wait = since + STALE_GRACE_MS - Date.now();
        if (wait > 0) {
          // Give a background parse a chance to finish first.
          if (this.graceTimer) clearTimeout(this.graceTimer);
          this.graceTimer = setTimeout(() => this.checkStale(), wait + 100);
        } else {
          this.notifyStale(state);
        }
      }
    }
    if (changed) this.changeEmitter.fire();
  }

  private notifyStale(state: ProjectState): void {
    const root = state.project.root;
    this.notified.add(root);
    const reason = state.stale?.reason ? ` (${state.stale.reason})` : '';
    void vscode.window
      .showInformationMessage(
        `dbt-docs-helper: manifest.json for "${state.project.config.name}" is out of date${reason}. Lineage for new or changed models may be missing.`,
        'Run dbt parse',
        'Always run automatically',
        "Don't show again",
      )
      .then(async (choice) => {
        const config = vscode.workspace.getConfiguration('dbt-docs-helper', vscode.Uri.file(root));
        if (choice === 'Run dbt parse') this.runParse(root);
        else if (choice === 'Always run automatically') {
          await config.update('staleManifest', 'autoParse', vscode.ConfigurationTarget.Workspace);
          this.runParseInBackground(root);
        } else if (choice === "Don't show again") {
          await config.update('staleManifest', 'statusBar', vscode.ConfigurationTarget.Global);
        }
      });
  }

  /** True while a background parse runs for the project. */
  isParsing(root: string): boolean {
    return this.parseRunning.has(root);
  }

  /** Run the parse command without a terminal; output goes to the log. */
  runParseInBackground(root: string): void {
    if (vscode.workspace.isTrusted === false) return;
    if (this.parseRunning.has(root)) {
      this.parseAgain.add(root);
      return;
    }
    const command = settings.parseCommand(vscode.Uri.file(root));
    this.parseRunning.add(root);
    this.lastOwnParse.set(root, Date.now());
    this.changeEmitter.fire();
    this.output.appendLine(`$ ${command}   (in ${root})`);
    const child = spawn(command, { cwd: root, shell: true, env: process.env });
    const log = (data: Buffer) => this.output.append(data.toString());
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    const done = (code: number | null, error?: Error) => {
      this.parseRunning.delete(root);
      this.lastOwnParse.set(root, Date.now());
      const state = this.states.get(root);
      if (state) state.parseError = code === 0 ? undefined : error?.message ?? `"${command}" exited with code ${code}. See the dbt-docs-helper log.`;
      this.output.appendLine(code === 0 ? 'parse finished' : `parse failed: ${state?.parseError}`);
      this.changeEmitter.fire();
      if (this.parseAgain.delete(root)) this.scheduleStaleCheck();
    };
    child.on('error', (err) => done(null, err));
    child.on('close', (code) => done(code));
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
    this.lastOwnParse.set(cwd, Date.now());
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
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.disposables.forEach((d) => d.dispose());
    this.changeEmitter.dispose();
    this.output.dispose();
  }

  get extensionContext(): vscode.ExtensionContext {
    return this.context;
  }
}
