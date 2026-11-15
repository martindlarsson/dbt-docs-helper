/**
 * The documentation editor: a webview where you write the model and column
 * descriptions of the model open in the editor, without opening the YAML.
 *
 * It is shown as an editor tab beside the SQL file (`openPanel`) and, more
 * compactly, in the side bar. Both follow the active editor. Edits are
 * written to YAML (or to the doc block's Markdown file) and saved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addColumns,
  addResourceEntry,
  downstreamIndex,
  findAt,
  modelSummary,
  ModelSummary,
  newPropertiesFile,
  NewResourceEntry,
  removeDescription,
  removeColumnDataType,
  setColumnDataType,
  formatType,
  replaceDocBlockContents,
  resourceForFile,
  setColumnDescription,
  setResourceDescription,
  TextEdit,
} from '@dbt-docs-helper/core';
import { settings } from './config';
import { ProjectManager, ProjectState } from './projectManager';
import { ColumnRef, fileUri, toRange } from './util';

export const MODEL_VIEW_ID = 'dbt-docs-helper.model';
export const PANEL_TYPE = 'dbt-docs-helper.docEditor';

type ColumnAction = 'inherit' | 'link' | 'move' | 'ai' | 'unlink';
type ModelAction = 'inheritAll' | 'addColumns' | 'setAllTypes';

/** Messages from the webview. Anything else is ignored. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; file: string; offset: number }
  | { type: 'openPanel' }
  | { type: 'save'; target: 'model'; value: string }
  | { type: 'save'; target: 'column'; column: string; value: string }
  | { type: 'saveBlock'; block: string; value: string }
  | { type: 'saveType'; column: string; value: string }
  | { type: 'action'; action: ColumnAction; column: string }
  | { type: 'action'; action: ModelAction };

export type ToWebview =
  | { type: 'summary'; summary: ModelSummary; aiEnabled: boolean; stale: boolean; host: 'panel' | 'view' }
  | { type: 'empty'; message: string; host: 'panel' | 'view' }
  | { type: 'saved'; file: string }
  | { type: 'error'; message: string };

const COLUMN_COMMANDS: Record<Exclude<ColumnAction, 'unlink'>, string> = {
  inherit: 'dbt-docs-helper.inherit',
  link: 'dbt-docs-helper.linkDocsBlock',
  move: 'dbt-docs-helper.moveToDocsBlock',
  ai: 'dbt-docs-helper.suggestWithAi',
};

interface Host {
  kind: 'panel' | 'view';
  webview: vscode.Webview;
  visible(): boolean;
}

export class DocEditor implements vscode.WebviewViewProvider, vscode.Disposable {
  private hosts = new Set<Host>();
  private panel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private selectionTimer?: NodeJS.Timeout;
  /** The resource shown; kept while the editor shows something unrelated (or the panel has focus). */
  private current?: { root: string; uniqueId: string };
  /** Last message per host kind; also used by tests. */
  readonly lastMessage = new Map<'panel' | 'view', ToWebview>();

  constructor(
    private readonly manager: ProjectManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!/\.ya?ml$/i.test(e.textEditor.document.uri.fsPath)) return;
        if (this.selectionTimer) clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => this.update(), 150);
      }),
      manager.onDidChange(() => this.update()),
    );
  }

  // ---------------------------------------------------------------------------
  // Hosts

  private setup(webview: vscode.Webview, kind: 'panel' | 'view', isVisible: () => boolean): Host {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = webviewHtml(
      webview.cspSource,
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'summary.css')).toString(),
      webview.asWebviewUri(vscode.Uri.joinPath(media, 'summary.js')).toString(),
      nonce(),
      kind,
    );
    const host: Host = { kind, webview, visible: isVisible };
    this.hosts.add(host);
    this.disposables.push(webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m, host)));
    return host;
  }

  /** Side bar view. */
  resolveWebviewView(view: vscode.WebviewView): void {
    const host = this.setup(view.webview, 'view', () => view.visible !== false);
    this.disposables.push(view.onDidChangeVisibility(() => this.update()));
    view.onDidDispose(() => this.hosts.delete(host));
    this.update();
  }

  /** Open (or reveal) the editor tab beside the current editor. */
  openPanel(): void {
    const target = this.target();
    if (target) this.current = target;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      this.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'Docs',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
    );
    this.adoptPanel(panel);
  }

  /** Take over a panel: a new one, or one VS Code restores after a restart. */
  adoptPanel(panel: vscode.WebviewPanel): void {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'activity.svg');
    this.panel = panel;
    const host = this.setup(panel.webview, 'panel', () => panel.visible !== false);
    panel.onDidDispose(() => {
      this.hosts.delete(host);
      this.panel = undefined;
    });
    this.update();
  }

  // ---------------------------------------------------------------------------
  // What to show

  update(): void {
    const target = this.target();
    if (target) this.current = target;
    const state = this.state();
    if (!state || !this.current) {
      this.postAll((host) => ({
        type: 'empty',
        host,
        message: this.manager.projects().length === 0 ? 'No dbt project with a manifest.json was found.' : 'Open a model’s SQL file (or its YAML) to document it here.',
      }));
      return;
    }
    const analysis = this.manager.analysis(state.project);
    const summary = modelSummary(analysis, this.current.uniqueId, downstreamIndex(state.project));
    if (!summary) {
      this.postAll((host) => ({ type: 'empty', host, message: 'This model is not in manifest.json yet. Run dbt parse.' }));
      return;
    }
    if (this.panel) this.panel.title = `Docs: ${summary.label}`;
    const stale = !!state.stale?.stale && this.manager.staleMode(state.project.root) !== 'off';
    this.postAll((host) => ({ type: 'summary', summary, aiEnabled: settings.aiEnabled(), stale, host }));
  }

  private target(): { root: string; uniqueId: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const state = this.manager.projectFor(editor.document.uri);
    if (!state) return undefined;
    const project = state.project;
    const rel = project.relative(editor.document.uri.fsPath);
    if (/\.ya?ml$/i.test(rel)) {
      const index = project.yamlFiles.get(rel);
      if (!index || index.resources.length === 0) return undefined;
      const hit = findAt(index, editor.document.offsetAt(editor.selection.active))?.resource;
      const sameFile = this.current?.root === project.root && index.resources.some((yr) => project.resourceForYaml(yr)?.uniqueId === this.current?.uniqueId);
      if (!hit && sameFile) return this.current;
      const r = project.resourceForYaml(hit ?? index.resources[0]);
      return r ? { root: project.root, uniqueId: r.uniqueId } : undefined;
    }
    const r = resourceForFile(project, rel);
    return r ? { root: project.root, uniqueId: r.uniqueId } : undefined;
  }

  private state(): ProjectState | undefined {
    return this.current && this.manager.projects().find((s) => s.project.root === this.current!.root);
  }

  private postAll(make: (host: 'panel' | 'view') => ToWebview): void {
    for (const host of this.hosts) {
      const message = make(host.kind);
      this.lastMessage.set(host.kind, message);
      if (host.visible()) void host.webview.postMessage(message);
    }
    // Keep a message for tests and for hosts that are created later.
    if (this.hosts.size === 0) this.lastMessage.set('view', make('view'));
  }

  private notify(host: Host | undefined, message: ToWebview): void {
    if (host) void host.webview.postMessage(message);
    else for (const h of this.hosts) void h.webview.postMessage(message);
  }

  // ---------------------------------------------------------------------------
  // Messages

  async onMessage(m: FromWebview, host?: Host): Promise<void> {
    if (m.type === 'ready') {
      const last = host && this.lastMessage.get(host.kind);
      if (last && host) void host.webview.postMessage(last);
      else this.update();
      return;
    }
    if (m.type === 'openPanel') {
      this.openPanel();
      return;
    }
    const state = this.state();
    if (!state || !this.current) return;
    const root = state.project.root;
    const resourceId = this.current.uniqueId;
    try {
      if (m.type === 'open') {
        if (typeof m.file !== 'string' || typeof m.offset !== 'number') return;
        if (!state.project.contains(state.project.absolute(m.file))) return;
        await vscode.commands.executeCommand('dbt-docs-helper.openLocation', root, m.file, m.offset);
      } else if (m.type === 'save') {
        if (typeof m.value !== 'string') return;
        const file = m.target === 'model' ? await this.saveModel(state, resourceId, m.value) : typeof m.column === 'string' ? await this.saveColumn(state, resourceId, m.column, m.value) : undefined;
        if (file) this.notify(host, { type: 'saved', file });
      } else if (m.type === 'saveType') {
        if (typeof m.column !== 'string' || typeof m.value !== 'string') return;
        const file = await this.saveType(state, resourceId, m.column, m.value);
        if (file) this.notify(host, { type: 'saved', file });
      } else if (m.type === 'saveBlock') {
        if (typeof m.block !== 'string' || typeof m.value !== 'string') return;
        const file = await this.saveBlock(state, m.block, m.value);
        if (file) this.notify(host, { type: 'saved', file });
      } else if (m.type === 'action') {
        await this.withAutoSave(state, async () => {
          if ('column' in m && typeof m.column === 'string') {
            const ref: ColumnRef = { root, resourceId, column: m.column };
            if (m.action === 'unlink') await this.unlink(state, ref);
            else if (m.action in COLUMN_COMMANDS) {
              await vscode.commands.executeCommand(COLUMN_COMMANDS[m.action as keyof typeof COLUMN_COMMANDS], ref, ...(m.action === 'inherit' ? [0] : []));
            }
          } else if (m.action === 'inheritAll') {
            await vscode.commands.executeCommand('dbt-docs-helper.inheritAll', { root, resourceId });
          } else if (m.action === 'setAllTypes') {
            await vscode.commands.executeCommand('dbt-docs-helper.setAllDataTypes', { root, resourceId }, true);
          } else if (m.action === 'addColumns') {
            await vscode.commands.executeCommand('dbt-docs-helper.addMissingColumns', root, resourceId);
          }
        });
      }
    } catch (err) {
      this.notify(host, { type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Writing

  /** Run `fn`, then save project files it left unsaved (if they were saved before). */
  private async withAutoSave(state: ProjectState, fn: () => Promise<void>): Promise<string[]> {
    const before = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
    await fn();
    const saved: string[] = [];
    if (!settings.docEditorAutoSave()) return saved;
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || before.has(doc.uri.toString()) || !state.project.contains(doc.uri.fsPath)) continue;
      if (!/\.(ya?ml|md)$/i.test(doc.uri.fsPath)) continue;
      if (await doc.save()) saved.push(state.project.relative(doc.uri.fsPath));
    }
    return saved;
  }

  private async apply(state: ProjectState, edit: vscode.WorkspaceEdit, file: string): Promise<string> {
    await this.withAutoSave(state, async () => {
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not update ${file}.`);
    });
    return file;
  }

  private textEdit(edit: vscode.WorkspaceEdit, state: ProjectState, file: string, te: TextEdit): void {
    const index = state.project.yamlFiles.get(file);
    if (!index) throw new Error(`${file} is not loaded.`);
    edit.replace(fileUri(state.project, file), toRange(index, [te.start, te.end]), te.newText);
  }

  async saveColumn(state: ProjectState, resourceId: string, column: string, raw: string): Promise<string | undefined> {
    const value = raw.replace(/\s+$/, '').replace(/^\s+/, '');
    const analysis = this.manager.analysis(state.project);
    const report = analysis.resources.get(resourceId);
    if (!report) return undefined;
    const col = report.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
    const edit = new vscode.WorkspaceEdit();
    if (col?.yaml) {
      if (value === col.rawDescription) return undefined;
      const index = state.project.yamlFiles.get(col.yaml.file)!;
      const te = value === '' ? removeDescription(index, col.yaml.column) : setColumnDescription(index, col.yaml.column, value);
      if (!te) return undefined;
      this.textEdit(edit, state, col.yaml.file, te);
      return this.apply(state, edit, col.yaml.file);
    }
    if (value === '') return undefined;
    if (report.yaml) {
      const index = state.project.yamlFiles.get(report.yaml.file)!;
      const te = addColumns(index, report.yaml.resource, [{ name: column, description: value }]);
      if (!te) throw new Error('Cannot add columns to an inline (flow-style) YAML entry.');
      this.textEdit(edit, state, report.yaml.file, te);
      return this.apply(state, edit, report.yaml.file);
    }
    return this.createEntry(state, resourceId, { columns: { [column]: { description: value } } });
  }

  /** Set `data_type` of a column (empty removes it), adding the column or the model to YAML if needed. */
  async saveType(state: ProjectState, resourceId: string, column: string, raw: string): Promise<string | undefined> {
    const typed = raw.trim();
    const value = typed && formatType(typed, settings.typeCase(vscode.Uri.file(state.project.root)));
    const report = this.manager.analysis(state.project).resources.get(resourceId);
    if (!report) return undefined;
    const col = report.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
    const edit = new vscode.WorkspaceEdit();
    if (col?.yaml) {
      if (value === (col.yaml.column.dataType?.value ?? '')) return undefined;
      const index = state.project.yamlFiles.get(col.yaml.file)!;
      const te = value === '' ? removeColumnDataType(index, col.yaml.column) : setColumnDataType(index, col.yaml.column, value);
      if (!te) return undefined;
      this.textEdit(edit, state, col.yaml.file, te);
      return this.apply(state, edit, col.yaml.file);
    }
    if (value === '') return undefined;
    if (report.yaml) {
      const index = state.project.yamlFiles.get(report.yaml.file)!;
      const te = addColumns(index, report.yaml.resource, [{ name: column, dataType: value }]);
      if (!te) throw new Error('Cannot add columns to an inline (flow-style) YAML entry.');
      this.textEdit(edit, state, report.yaml.file, te);
      return this.apply(state, edit, report.yaml.file);
    }
    return this.createEntry(state, resourceId, { columns: { [column]: { dataType: value } } });
  }

  async saveModel(state: ProjectState, resourceId: string, raw: string): Promise<string | undefined> {
    const value = raw.trim();
    const report = this.manager.analysis(state.project).resources.get(resourceId);
    if (!report) return undefined;
    if (report.yaml) {
      const current = report.yaml.resource.description?.value ?? '';
      if (value === current) return undefined;
      const index = state.project.yamlFiles.get(report.yaml.file)!;
      const te = value === '' ? removeDescription(index, report.yaml.resource) : setResourceDescription(index, report.yaml.resource, value);
      if (!te) return undefined;
      const edit = new vscode.WorkspaceEdit();
      this.textEdit(edit, state, report.yaml.file, te);
      return this.apply(state, edit, report.yaml.file);
    }
    if (value === '') return undefined;
    return this.createEntry(state, resourceId, { description: value });
  }

  /** Create the YAML entry of a model that has none, with all its known columns. */
  private async createEntry(
    state: ProjectState,
    resourceId: string,
    values: { description?: string; columns?: Record<string, { description?: string; dataType?: string }> },
  ): Promise<string | undefined> {
    const project = state.project;
    const resource = project.manifest.resources.get(resourceId);
    if (!resource || resource.kind === 'source') return undefined;
    const summary = modelSummary(this.manager.analysis(project), resourceId);
    const entry: NewResourceEntry = {
      name: resource.name,
      description: values.description,
      columns: (summary?.columns ?? []).map((c) => ({ name: c.name, ...values.columns?.[c.name] })),
    };
    for (const [name, v] of Object.entries(values.columns ?? {})) {
      if (!entry.columns!.some((c) => c.name === name)) entry.columns!.push({ name, ...v });
    }
    const file = await this.chooseYamlFile(project, resource.originalFilePath, resource.kind);
    if (!file) return undefined;
    const edit = new vscode.WorkspaceEdit();
    const index = project.yamlFiles.get(file);
    const uri = fileUri(project, file);
    if (index) {
      const te = addResourceEntry(index, resource.kind, entry);
      if (!te) throw new Error(`Cannot add to the inline list in ${file}.`);
      this.textEdit(edit, state, file, te);
      return this.apply(state, edit, file);
    }
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), newPropertiesFile(resource.kind, entry));
    await vscode.workspace.applyEdit(edit);
    if (settings.docEditorAutoSave()) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
    }
    return file;
  }

  /** YAML file for a new entry: one in the same folder, or a new `_<folder>__models.yml`. */
  private async chooseYamlFile(project: ProjectState['project'], sourceFile: string, kind: 'model' | 'seed' | 'snapshot'): Promise<string | undefined> {
    const dir = path.posix.dirname(sourceFile);
    const section = `${kind}s`;
    const inDir = [...project.yamlFiles.entries()]
      .filter(([f]) => path.posix.dirname(f) === dir)
      .sort(([a, ia], [b, ib]) => Number(ib.sections.some((s) => s.key === section)) - Number(ia.sections.some((s) => s.key === section)) || a.localeCompare(b));
    const withSection = inDir.filter(([, i]) => i.sections.some((s) => s.key === section));
    if (withSection.length === 1) return withSection[0][0];
    const folder = path.posix.basename(dir === '.' ? project.config.name : dir);
    const suggested = `${dir === '.' ? '' : `${dir}/`}_${folder}__${section}.yml`;
    if (inDir.length > 0) {
      const pick = await vscode.window.showQuickPick(
        [...inDir.map(([f]) => ({ label: f, file: f })), { label: `$(new-file) New file ${suggested}`, file: '' }],
        { title: `Which YAML file should document this ${kind}?` },
      );
      if (!pick) return undefined;
      if (pick.file) return pick.file;
    }
    const file = await vscode.window.showInputBox({
      title: `New YAML file for this ${kind} (relative to the dbt project)`,
      value: suggested,
      validateInput: (v) => (/\.ya?ml$/i.test(v) ? undefined : 'Use a .yml file.'),
    });
    return file?.replace(/\\/g, '/');
  }

  /** Replace the text of a doc block (changes it for every column that uses it). */
  async saveBlock(state: ProjectState, name: string, raw: string): Promise<string | undefined> {
    const value = raw.trim();
    const block = state.project.docBlocks().get(name);
    if (!block || block.start < 0 || value === '' || value === block.contents.trim()) return undefined;
    const uri = fileUri(state.project, block.file);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    const text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
    const te = replaceDocBlockContents(text, block, value);
    const lines = text.slice(0, te.start).split('\n');
    const endLines = text.slice(0, te.end).split('\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(lines.length - 1, lines[lines.length - 1].length, endLines.length - 1, endLines[endLines.length - 1].length),
      te.newText,
    );
    return this.apply(state, edit, block.file);
  }

  /** Replace a doc() reference with the block's text, so it can be edited for this column only. */
  private async unlink(state: ProjectState, ref: ColumnRef): Promise<void> {
    const report = this.manager.analysis(state.project).resources.get(ref.resourceId);
    const col = report?.columns.find((c) => c.name.toLowerCase() === ref.column.toLowerCase());
    if (!col?.yaml || !col.docBlock) return;
    const index = state.project.yamlFiles.get(col.yaml.file)!;
    const edit = new vscode.WorkspaceEdit();
    this.textEdit(edit, state, col.yaml.file, setColumnDescription(index, col.yaml.column, col.description));
    await vscode.workspace.applyEdit(edit);
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** The static page; the content is rendered by media/summary.js from the posted data. */
export function webviewHtml(cspSource: string, cssUri: string, scriptUri: string, nonceValue: string, host: 'panel' | 'view' = 'view'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonceValue}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>Docs</title>
</head>
<body class="host-${host}">
<main id="app"><p class="empty">Loading…</p></main>
<script nonce="${nonceValue}" src="${scriptUri}"></script>
</body>
</html>`;
}
