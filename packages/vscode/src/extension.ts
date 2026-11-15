import * as vscode from 'vscode';
import { coverage, percent } from '@dbt-docs-helper/core';
import { Commands } from './commands';
import { SECTION, settings } from './config';
import { Diagnostics } from './diagnostics';
import { ProjectManager } from './projectManager';
import { CodeActions, Hover, InlayHints, YAML_SELECTOR } from './providers';
import { addColumnsArgs, candidateArg, CandidatesTree, CoverageTree, TreeNode, WorkListTree } from './trees';

export interface ExtensionApi {
  manager: ProjectManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const manager = new ProjectManager(context);
  context.subscriptions.push(manager);

  new Commands(manager).register(context);
  context.subscriptions.push(new Diagnostics(manager));

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(YAML_SELECTOR, new InlayHints(manager)),
    vscode.languages.registerHoverProvider(YAML_SELECTOR, new Hover(manager)),
    vscode.languages.registerCodeActionsProvider(YAML_SELECTOR, new CodeActions(manager), { providedCodeActionKinds: CodeActions.kinds }),
  );

  const coverageTree = new CoverageTree(manager);
  const workTree = new WorkListTree(manager);
  const candidatesTree = new CandidatesTree(manager);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbt-docs-helper.coverage', coverageTree),
    vscode.window.registerTreeDataProvider('dbt-docs-helper.workList', workTree),
    vscode.window.registerTreeDataProvider('dbt-docs-helper.candidates', candidatesTree),
    vscode.commands.registerCommand('dbt-docs-helper.coverage.groupBy', async () => {
      const options = [
        { label: 'layer', description: 'staging / intermediate / marts' },
        { label: 'folder' },
        { label: 'tag' },
        { label: 'owner', description: 'meta.owner or group' },
        { label: 'kind', description: 'model / seed / snapshot / source' },
      ];
      const pick = await vscode.window.showQuickPick(options, { placeHolder: `Group coverage by (now: ${settings.groupBy()})` });
      if (!pick) return;
      await vscode.workspace.getConfiguration(SECTION).update('coverage.groupBy', pick.label, vscode.ConfigurationTarget.Workspace);
      coverageTree.refresh();
    }),
    vscode.commands.registerCommand('dbt-docs-helper.workList.addColumns', (node: TreeNode) => {
      const args = addColumnsArgs(node);
      if (args) return vscode.commands.executeCommand('dbt-docs-helper.addMissingColumns', ...args);
      return undefined;
    }),
    vscode.commands.registerCommand('dbt-docs-helper.candidates.createBlock', (node: TreeNode) => {
      const arg = candidateArg(node);
      if (arg) return vscode.commands.executeCommand('dbt-docs-helper.createDocsBlockForCandidate', arg);
      return undefined;
    }),
  );

  // Status bar: coverage of the project of the active editor (or the first project).
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.dbt-docs-helper';
  context.subscriptions.push(status);
  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    const state = (editor && manager.projectFor(editor.document.uri)) ?? manager.projects()[0];
    if (!state) {
      status.hide();
      return;
    }
    const total = coverage(manager.analysis(state.project)).total;
    const pct = percent(total, settings.includeInheritable()).toFixed(0);
    status.text = `${state.stale?.stale ? '$(warning)' : '$(book)'} Docs ${pct}%`;
    status.tooltip = new vscode.MarkdownString(
      `**dbt-docs-helper** — ${state.project.config.name}\n\n` +
        `${total.documented} of ${total.columns} columns documented, ${total.inheritable} can be inherited, ${total.missing} must be written.` +
        (state.stale?.stale ? `\n\n⚠ manifest.json is older than ${state.stale.newestFile ?? 'the project files'}.` : ''),
    );
    status.show();
  };
  context.subscriptions.push(manager.onDidChange(updateStatus), vscode.window.onDidChangeActiveTextEditor(updateStatus));

  await manager.discover();
  updateStatus();
  return { manager };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
