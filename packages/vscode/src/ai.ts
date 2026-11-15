/**
 * Opt-in AI suggestions through the VS Code Language Model API, using a
 * model the user already has in the editor (e.g. GitHub Copilot). Nothing
 * is written without the user confirming the text.
 */
import * as vscode from 'vscode';
import type { Analysis, ColumnReport, ResourceReport } from '@dbt-docs-helper/core';
import { settings } from './config';

export function buildPrompt(analysis: Analysis, resource: ResourceReport, column: ColumnReport): string {
  const r = resource.resource;
  const lines: string[] = [];
  lines.push(
    'You write column descriptions for dbt documentation.',
    'Write ONE short description (max 2 sentences) for the column below. Describe what the value means for a business user,',
    'not how it is computed, unless the computation is the meaning. Do not repeat the column name. Answer with the description only.',
    '',
    `Model: ${resource.label} (${r.kind})`,
  );
  if (r.description) lines.push(`Model description: ${r.description}`);
  lines.push(`Column: ${column.name}`);
  const others = resource.columns.filter((c) => c !== column && c.description).slice(0, 15);
  if (others.length) {
    lines.push('', 'Other columns in the same model:');
    for (const c of others) lines.push(`- ${c.name}: ${c.description.replace(/\s+/g, ' ')}`);
  }
  const ups = analysis.findInheritance(r, column.name);
  if (ups.length) {
    lines.push('', 'Upstream descriptions of the same or a related column:');
    for (const u of ups.slice(0, 3)) lines.push(`- ${u.fromLabel}.${u.fromColumn} (${u.kind}): ${u.description}`);
  }
  const sql = r.rawCode ?? r.compiledCode;
  if (sql) {
    lines.push('', 'SQL of the model:', '```sql', sql.length > 6000 ? `${sql.slice(0, 6000)}\n-- (truncated)` : sql, '```');
  }
  return lines.join('\n');
}

export async function suggestWithAi(analysis: Analysis, resource: ResourceReport, column: ColumnReport): Promise<string | undefined> {
  if (!settings.aiEnabled()) {
    const choice = await vscode.window.showInformationMessage(
      'dbt-docs-helper: AI suggestions are turned off. They send the model SQL and nearby descriptions to the language model you use in VS Code.',
      'Turn on',
    );
    if (choice !== 'Turn on') return undefined;
    await vscode.workspace.getConfiguration('dbt-docs-helper').update('ai.enabled', true, vscode.ConfigurationTarget.Global);
  }
  const lm = (vscode as { lm?: typeof vscode.lm }).lm;
  if (!lm?.selectChatModels) {
    void vscode.window.showWarningMessage('dbt-docs-helper: this editor does not provide the VS Code Language Model API.');
    return undefined;
  }
  const family = settings.aiModelFamily();
  const models = await lm.selectChatModels(family ? { family } : {});
  if (models.length === 0) {
    void vscode.window.showWarningMessage('dbt-docs-helper: no language model is available. Install and sign in to e.g. GitHub Copilot.');
    return undefined;
  }
  const model = models[0];
  const prompt = buildPrompt(analysis, resource, column);
  const suggestion = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Asking ${model.name} for a description of ${column.name}…`, cancellable: true },
    async (_progress, token) => {
      try {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
        let text = '';
        for await (const part of response.text) text += part;
        return text.trim().replace(/^["']|["']$/g, '');
      } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
          void vscode.window.showWarningMessage(`dbt-docs-helper: ${err.message}`);
        } else if (!token.isCancellationRequested) {
          void vscode.window.showWarningMessage(`dbt-docs-helper: AI request failed: ${err instanceof Error ? err.message : err}`);
        }
        return undefined;
      }
    },
  );
  if (!suggestion) return undefined;
  return vscode.window.showInputBox({
    title: `Description for ${resource.label}.${column.name} (suggested by ${model.name})`,
    value: suggestion,
    prompt: 'Edit the text and press Enter to save, or Escape to cancel.',
  });
}
