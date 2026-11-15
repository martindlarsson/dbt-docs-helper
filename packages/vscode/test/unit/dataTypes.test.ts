import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __open, __reset, __showEditor, __state } from '../mock/vscode';
import { activate } from '../../src/extension';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/jaffle');
let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddh-types-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  // A data_type that differs from the warehouse (DATE).
  const marts = path.join(root, 'models/marts/_marts.yml');
  fs.writeFileSync(marts, fs.readFileSync(marts, 'utf8').replace('      - name: order_date\n', '      - name: order_date\n        data_type: timestamp\n'));
  const now = new Date();
  fs.utimesSync(path.join(root, 'target/manifest.json'), now, now);
  __reset(root);
  await activate({ subscriptions: [], extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')), workspaceState: { get() {}, async update() {} } } as any);
});

const lineOf = (doc: any, needle: string) => doc.positionAt(doc.getText().indexOf(needle)).line;

describe('data types', () => {
  it('warns when YAML and the warehouse disagree, and fixes it', async () => {
    const file = path.join(root, 'models/marts/_marts.yml');
    const doc = __open(file) as any;
    const diag = (__state.diagnostics.get(file) ?? []).find((d: any) => d.code === 'data-type-mismatch')!;
    expect(diag.message).toBe('order_date: data_type is timestamp, but the column is DATE in the warehouse.');
    const line = lineOf(doc, '- name: order_date');
    const actions = __state.codeActionProviders[0].provideCodeActions(doc, new vscode.Range(line, 15, line, 15), { diagnostics: [diag] });
    const fix = actions.find((a: any) => a.title === 'Change data_type to DATE (as in the warehouse)');
    expect(fix.isPreferred).toBe(true);
    await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    expect(doc.getText()).toContain('      - name: order_date\n        data_type: date\n');
  });

  it('offers the known type for a column without data_type', async () => {
    const doc = __open(path.join(root, 'models/marts/_marts.yml')) as any;
    const line = lineOf(doc, '- name: status');
    const actions = __state.codeActionProviders[0].provideCodeActions(doc, new vscode.Range(line, 12, line, 12), { diagnostics: [] });
    const set = actions.find((a: any) => a.title.startsWith('Set data_type'));
    expect(set.title).toBe('Set data_type: varchar (warehouse)');
    __state.config.set('dbt-docs-helper.dataTypes.case', 'upper');
    await vscode.commands.executeCommand(set.command.command, ...set.command.arguments);
    expect(doc.getText()).toContain('      - name: status\n        data_type: VARCHAR\n      - name: amount');
  });

  it('sets all known data types in a file', async () => {
    const doc = __open(path.join(root, 'models/marts/_marts.yml')) as any;
    await vscode.commands.executeCommand('dbt-docs-helper.setAllDataTypes', doc.uri);
    const text = doc.getText();
    // 4 + 5 missing in the two models; the mismatch is left alone without fixMismatches
    expect(__state.messages.at(-1)).toBe('dbt-docs-helper: set 9 data types.');
    expect(text).toContain('      - name: number_of_orders\n        description: Number of orders placed by the customer\n        data_type: bigint');
    expect(text).toContain('      - name: order_date\n        data_type: timestamp\n');
  });

  it('writes types from the documentation editor', async () => {
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    await vscode.commands.executeCommand('dbt-docs-helper.openDocEditor');
    const panel = __state.panels[0];
    const summary = panel.posted.filter((m: any) => m.type === 'summary').at(-1).summary;
    expect(summary.counts).toMatchObject({ typesToSet: 4, typeMismatches: 1 });
    const read = () => fs.readFileSync(path.join(root, 'models/marts/_marts.yml'), 'utf8');
    panel.send({ type: 'saveType', column: 'amount', value: ' NUMERIC(18,2) ' });
    await new Promise((r) => setTimeout(r, 0));
    expect(read()).toContain('      - name: amount\n        data_type: numeric(18,2)\n');
    panel.send({ type: 'saveType', column: 'order_date', value: '' });
    await new Promise((r) => setTimeout(r, 0));
    expect(read()).toContain('      - name: order_date\n      - name: status');
    panel.send({ type: 'action', action: 'setAllTypes' });
    await new Promise((r) => setTimeout(r, 0));
    expect(read()).toContain('      - name: order_id\n        data_type: integer\n');
  });

  it('can report missing data types when asked to', async () => {
    __state.config.set('dbt-docs-helper.diagnostics.dataTypeMissing', 'information');
    const file = path.join(root, 'models/staging/_staging.yml');
    __open(file);
    const missing = (__state.diagnostics.get(file) ?? []).filter((d: any) => d.code === 'data-type-missing');
    expect(missing.find((d: any) => d.message.startsWith('order_date'))!.message).toBe('order_date has no data_type; it is DATE (in the warehouse).');
  });
});
