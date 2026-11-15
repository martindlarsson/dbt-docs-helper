/**
 * "Model" view: a summary of the model open in the editor (its SQL, Python,
 * CSV or YAML file), with column status, up/downstream resources and the
 * fixes one click away.
 */
import * as vscode from 'vscode';
import { downstreamIndex, findAt, modelSummary, ModelSummary, resourceForFile } from '@dbt-docs-helper/core';
import { settings } from './config';
import { ProjectManager, ProjectState } from './projectManager';
import { ColumnRef } from './util';

export const MODEL_VIEW_ID = 'dbt-docs-helper.model';

/** Messages from the webview. Anything else is ignored. */
type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; file: string; offset: number }
  | { type: 'action'; action: ColumnAction; column: string }
  | { type: 'action'; action: ModelAction };

type ColumnAction = 'inherit' | 'edit' | 'link' | 'move' | 'ai';
type ModelAction = 'inheritAll' | 'addColumns' | 'editModel';

const COLUMN_COMMANDS: Record<ColumnAction, string> = {
  inherit: 'dbt-docs-helper.inherit',
  edit: 'dbt-docs-helper.editDescription',
  link: 'dbt-docs-helper.linkDocsBlock',
  move: 'dbt-docs-helper.moveToDocsBlock',
  ai: 'dbt-docs-helper.suggestWithAi',
};

export type ToWebview =
  | { type: 'summary'; summary: ModelSummary; aiEnabled: boolean; stale: boolean }
  | { type: 'empty'; message: string };

export class ModelSummaryView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private selectionTimer?: NodeJS.Timeout;
  /** The resource shown, kept while the editor shows something unrelated (e.g. a Markdown file). */
  private current?: { root: string; uniqueId: string };
  /** Last message sent; also used by tests. */
  lastMessage?: ToWebview;

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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = webviewHtml(
      view.webview.cspSource,
      view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'summary.css')).toString(),
      view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'summary.js')).toString(),
      nonce(),
    );
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      view.onDidChangeVisibility(() => this.update()),
    );
    view.onDidDispose(() => (this.view = undefined));
    this.update();
  }

  /** Work out which resource to show and send it to the webview. */
  update(): void {
    const target = this.target();
    if (target) this.current = target;
    const state = this.current && this.manager.projects().find((s) => s.project.root === this.current!.root);
    if (!state || !this.current) {
      this.post({ type: 'empty', message: this.manager.projects().length === 0 ? 'No dbt project with a manifest.json was found.' : 'Open a model, seed or YAML file to see its summary.' });
      return;
    }
    const analysis = this.manager.analysis(state.project);
    const summary = modelSummary(analysis, this.current.uniqueId, downstreamIndex(state.project));
    if (!summary) {
      this.post({ type: 'empty', message: 'This model is not in manifest.json yet. Run dbt parse.' });
      return;
    }
    this.post({ type: 'summary', summary, aiEnabled: settings.aiEnabled(), stale: !!state.stale?.stale && this.manager.staleMode(state.project.root) !== 'off' });
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
      const offset = editor.document.offsetAt(editor.selection.active);
      const hit = findAt(index, offset)?.resource;
      // Outside any entry: keep the current one if it lives in this file, else the first one.
      const sameFile = this.current?.root === project.root && index.resources.some((yr) => project.resourceForYaml(yr)?.uniqueId === this.current?.uniqueId);
      if (!hit && sameFile) return this.current;
      const r = project.resourceForYaml(hit ?? index.resources[0]);
      return r ? { root: project.root, uniqueId: r.uniqueId } : undefined;
    }
    const r = resourceForFile(project, rel);
    return r ? { root: project.root, uniqueId: r.uniqueId } : undefined;
  }

  private post(message: ToWebview): void {
    this.lastMessage = message;
    if (this.view?.visible !== false) void this.view?.webview.postMessage(message);
  }

  private state(): ProjectState | undefined {
    return this.current && this.manager.projects().find((s) => s.project.root === this.current!.root);
  }

  async onMessage(m: FromWebview): Promise<void> {
    const state = this.state();
    if (m.type === 'ready') {
      if (this.lastMessage) void this.view?.webview.postMessage(this.lastMessage);
      return;
    }
    if (!state || !this.current) return;
    const root = state.project.root;
    if (m.type === 'open') {
      if (typeof m.file !== 'string' || typeof m.offset !== 'number') return;
      if (!state.project.contains(state.project.absolute(m.file))) return;
      await vscode.commands.executeCommand('dbt-docs-helper.openLocation', root, m.file, m.offset);
      return;
    }
    if (m.type !== 'action') return;
    const resourceId = this.current.uniqueId;
    if ('column' in m && typeof m.column === 'string' && m.action in COLUMN_COMMANDS) {
      const ref: ColumnRef = { root, resourceId, column: m.column };
      await vscode.commands.executeCommand(COLUMN_COMMANDS[m.action as ColumnAction], ref, ...(m.action === 'inherit' ? [0] : []));
    } else if (m.action === 'inheritAll') {
      await vscode.commands.executeCommand('dbt-docs-helper.inheritAll', { root, resourceId });
    } else if (m.action === 'addColumns') {
      await vscode.commands.executeCommand('dbt-docs-helper.addMissingColumns', root, resourceId);
    } else if (m.action === 'editModel') {
      await vscode.commands.executeCommand('dbt-docs-helper.editModelDescription', root, resourceId);
    }
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
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
export function webviewHtml(cspSource: string, cssUri: string, scriptUri: string, nonceValue: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonceValue}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>Model</title>
</head>
<body>
<main id="app"><p class="empty">Loading…</p></main>
<script nonce="${nonceValue}" src="${scriptUri}"></script>
</body>
</html>`;
}
