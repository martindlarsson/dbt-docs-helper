import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __open, __reset, __showEditor, __state, __webviewView } from '../mock/vscode';
import { activate } from '../../src/extension';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/jaffle');

let root: string;
let api: any;
let view: ReturnType<typeof __webviewView>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddh-summary-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const now = new Date();
  fs.utimesSync(path.join(root, 'target/manifest.json'), now, now);
  __reset(root);
  api = await activate({ subscriptions: [], extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')), workspaceState: { get() {}, async update() {} } } as any);
  view = __webviewView();
  __state.webviewProviders.get('dbt-docs-helper.model').resolveWebviewView(view);
});

const last = () => view.posted[view.posted.length - 1];

describe('model summary view', () => {
  it('serves a page with a strict content security policy', () => {
    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.html).toMatch(/default-src 'none'; style-src vscode-resource:; script-src 'nonce-[A-Za-z0-9]{32}'/);
    expect(view.webview.html).toContain('media/summary.js');
  });

  it('asks the user to open a model when nothing is open', () => {
    expect(last()).toEqual({ type: 'empty', message: 'Open a model, seed or YAML file to see its summary.' });
  });

  it('follows the SQL file in the editor', () => {
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    expect(last().type).toBe('summary');
    expect(last().summary).toMatchObject({ label: 'orders', counts: { inheritable: 4 } });
    __showEditor(__open(path.join(root, 'seeds/raw_orders.csv')) as any);
    expect(last().summary.label).toBe('raw_orders');
  });

  it('follows the cursor in a YAML file with several models', () => {
    const doc = __open(path.join(root, 'models/staging/_staging.yml'));
    __showEditor(doc as any, doc.getText().indexOf('stg_payments'));
    expect(last().summary.label).toBe('stg_payments');
    __showEditor(doc as any, doc.getText().indexOf('stg_orders'));
    expect(last().summary.label).toBe('stg_orders');
    // A file unrelated to a model keeps the last summary.
    __showEditor(__open(path.join(root, 'models/_docs/columns.md')) as any);
    expect(last().summary.label).toBe('stg_orders');
  });

  it('runs fixes from the webview on the shown model', async () => {
    const marts = __open(path.join(root, 'models/marts/_marts.yml'));
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    view.send({ type: 'action', action: 'inherit', column: 'order_id' });
    await new Promise((r) => setTimeout(r, 0));
    expect(marts.getText()).toContain(`      - name: order_id\n        description: "{{ doc('col_stg_orders__order_id') }}"`);

    __state.inputBoxAnswers.push('The status of the order');
    view.send({ type: 'action', action: 'edit', column: 'status' });
    await new Promise((r) => setTimeout(r, 0));
    expect(marts.getText()).toContain('      - name: status\n        description: The status of the order');

    __state.inputBoxAnswers.push('One row per order');
    view.send({ type: 'action', action: 'editModel' });
    await new Promise((r) => setTimeout(r, 0));
    expect(marts.getText()).toContain('  - name: orders\n    description: One row per order');
  });

  it('refreshes after an edit', async () => {
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    view.send({ type: 'action', action: 'inheritAll' });
    await new Promise((r) => setTimeout(r, 300));
    expect(last().summary.counts).toMatchObject({ documented: 4, inheritable: 1 });
  });

  it('ignores files outside the project and unknown actions', async () => {
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    const before = __state.textDocuments.length;
    view.send({ type: 'open', file: '../../etc/passwd', offset: 0 });
    view.send({ type: 'action', action: 'rm -rf', column: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(__state.textDocuments.length).toBe(before);
  });

  it('is exposed for tests', () => {
    expect(api.modelSummary).toBeDefined();
  });
});
