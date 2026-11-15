import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'martindlarsson.dbt-docs-helper';

function root(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('dbt-docs-helper in VS Code', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    await ext.activate();
  });

  it('activates and loads the project', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('dbt-docs-helper.inheritAll'));
  });

  it('provides inlay hints for inheritable columns', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root(), 'models/marts/_marts.yml'));
    await vscode.window.showTextDocument(doc);
    const hints = await waitFor(async () => {
      const h = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        doc.uri,
        new vscode.Range(0, 0, doc.lineCount, 0),
      );
      return h && h.length > 0 ? h : undefined;
    });
    const labels = hints.map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('')));
    assert.ok(labels.some((l) => l.includes('stg_orders')), labels.join('\n'));
  });

  it('offers and applies the inherit quick fix', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root(), 'models/marts/_marts.yml'));
    const line = doc.getText().split('\n').findIndex((l) => l.includes('- name: order_id'));
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      doc.uri,
      new vscode.Range(line, 15, line, 15),
    );
    const inherit = actions.find((a) => a.title.startsWith('Inherit from stg_orders'));
    assert.ok(inherit, actions.map((a) => a.title).join('\n'));
    await vscode.commands.executeCommand(inherit.command!.command, ...(inherit.command!.arguments ?? []));
    assert.ok(doc.getText().includes(`description: "{{ doc('col_stg_orders__order_id') }}"`));
  });

  it('reports diagnostics', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root(), 'models/staging/_staging.yml'));
    await vscode.window.showTextDocument(doc);
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === 'dbt-docs-helper');
      return d.length > 0 ? d : undefined;
    });
    assert.ok(diags.some((d) => d.code === 'missing-description'));
  });

  it('shows a hover with lineage', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root(), 'models/marts/_marts.yml'));
    const line = doc.getText().split('\n').findIndex((l) => l.includes('- name: created_at'));
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, 16));
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
      .join('\n');
    assert.ok(text.includes('Lineage'), text);
  });
});
