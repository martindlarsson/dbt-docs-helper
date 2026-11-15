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

async function start(prepare?: (dir: string) => void) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddh-editor-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  prepare?.(root);
  const now = new Date();
  fs.utimesSync(path.join(root, 'target/manifest.json'), now, now);
  __reset(root);
  api = await activate({ subscriptions: [], extensionUri: vscode.Uri.file(path.resolve(__dirname, '../..')), workspaceState: { get() {}, async update() {} } } as any);
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Open orders.sql and the editor tab next to it. */
function openPanel(file = 'models/marts/orders.sql') {
  __showEditor(__open(path.join(root, file)) as any);
  void vscode.commands.executeCommand('dbt-docs-helper.openDocEditor');
  const panel = __state.panels[0];
  const last = () => panel.posted.filter((m: any) => m.type === 'summary' || m.type === 'empty').at(-1);
  return { panel, last, send: async (m: unknown) => { panel.send(m); await tick(); } };
}

describe('documentation editor', () => {
  beforeEach(() => start());

  it('opens beside the SQL file with a strict content security policy', () => {
    const { panel, last } = openPanel();
    expect(panel.viewType).toBe('dbt-docs-helper.docEditor');
    expect(panel.title).toBe('Docs: orders');
    expect(panel.webview.html).toMatch(/default-src 'none'; style-src vscode-resource:; script-src 'nonce-[A-Za-z0-9]{32}'/);
    expect(panel.webview.html).toContain('class="host-panel"');
    expect(last().summary.columns.map((c: any) => [c.name, c.suggestedType.type])).toEqual([
      ['order_id', 'INTEGER'],
      ['customer_id', 'INTEGER'],
      ['order_date', 'DATE'],
      ['status', 'VARCHAR'],
      ['amount', 'HUGEINT'],
    ]);
  });

  it('follows the editor, and the cursor in YAML', () => {
    const { last, panel } = openPanel();
    const yml = __open(path.join(root, 'models/staging/_staging.yml'));
    __showEditor(yml as any, yml.getText().indexOf('stg_payments'));
    expect(last().summary.label).toBe('stg_payments');
    expect(panel.title).toBe('Docs: stg_payments');
    __showEditor(__open(path.join(root, 'models/_docs/columns.md')) as any);
    expect(last().summary.label).toBe('stg_payments');
  });

  it('writes and saves a column description, without opening the YAML', async () => {
    const { panel, send } = openPanel();
    await send({ type: 'save', target: 'column', column: 'status', value: 'Order status  ' });
    expect(read('models/marts/_marts.yml')).toContain('      - name: status\n        description: Order status\n      - name: amount');
    expect(panel.posted.at(-1)).toEqual({ type: 'saved', file: 'models/marts/_marts.yml' });
    // Changing and clearing
    await send({ type: 'save', target: 'column', column: 'status', value: 'Status: placed or shipped' });
    expect(read('models/marts/_marts.yml')).toContain('        description: "Status: placed or shipped"');
    await send({ type: 'save', target: 'column', column: 'customer_id', value: '' });
    expect(read('models/marts/_marts.yml')).toContain('      - name: customer_id\n      - name: order_date');
  });

  it('writes the model description', async () => {
    const { send } = openPanel('models/staging/stg_payments.sql');
    await send({ type: 'save', target: 'model', value: 'One row per payment' });
    expect(read('models/staging/_staging.yml')).toContain('  - name: stg_payments\n    description: One row per payment\n    columns:');
  });

  it('adds a seed that has no YAML entry to the YAML file in its folder', async () => {
    const { send, last } = openPanel('seeds/raw_orders.csv');
    expect(last().summary.yamlFile).toBeUndefined();
    await send({ type: 'save', target: 'column', column: 'user_id', value: 'The customer' });
    const seeds = read('seeds/_seeds.yml');
    expect(seeds).toContain('  - name: raw_orders\n    columns:\n      - name: id\n      - name: user_id\n        description: The customer\n      - name: order_date');
    await tick(300);
    expect(last().summary.yamlFile).toBe('seeds/_seeds.yml');
  });

  it('edits the text of a doc block for every column that uses it', async () => {
    const { send } = openPanel('models/staging/stg_payments.sql');
    await send({ type: 'saveBlock', block: 'col_stg_orders__order_id', value: 'Id of the order.' });
    expect(read('models/_docs/columns.md')).toContain('{% docs col_stg_orders__order_id %}\nId of the order.\n{% enddocs %}');
    expect(read('models/_docs/columns.md')).toContain('{% docs col_crm_customers__id %}');
  });

  it('unlinks a doc block and inherits from upstream, and saves', async () => {
    const { send } = openPanel('models/staging/stg_payments.sql');
    await send({ type: 'action', action: 'unlink', column: 'order_id' });
    expect(read('models/staging/_staging.yml')).toContain('  - name: stg_payments\n    columns:\n      - name: payment_id\n      - name: order_id\n        description: Unique identifier of an order.');
    await tick(300);
    const marts = openPanel();
    await marts.send({ type: 'action', action: 'inherit', column: 'order_date' });
    expect(read('models/marts/_marts.yml')).toContain('      - name: order_date\n        description: Date the order was placed');
  });

  it('ignores unknown messages and files outside the project', async () => {
    const { send } = openPanel();
    const before = read('models/marts/_marts.yml');
    await send({ type: 'open', file: '../../etc/passwd', offset: 0 });
    await send({ type: 'action', action: 'rm -rf', column: 'x' });
    await send({ type: 'save', target: 'column', column: 'status', value: 42 });
    expect(read('models/marts/_marts.yml')).toBe(before);
  });

  it('also works in the side bar', () => {
    const view = __webviewView();
    __state.webviewProviders.get('dbt-docs-helper.model').resolveWebviewView(view);
    __showEditor(__open(path.join(root, 'models/marts/orders.sql')) as any);
    expect(view.posted.at(-1)).toMatchObject({ type: 'summary', host: 'view', summary: { label: 'orders' } });
    expect(view.webview.html).toContain('class="host-view"');
  });
});

describe('documentation editor without a YAML file', () => {
  beforeEach(() =>
    start((dir) => {
      fs.rmSync(path.join(dir, 'models/marts/_marts.yml'));
      fs.rmSync(path.join(dir, 'target/catalog.json'));
    }),
  );

  it('creates a YAML file for the model, with the columns from its SQL', async () => {
    const { send, last } = openPanel();
    expect(last().summary.yamlFile).toBeUndefined();
    await send({ type: 'save', target: 'model', value: 'One row per order' });
    expect(read('models/marts/_marts__models.yml')).toBe(
      'version: 2\n\nmodels:\n  - name: orders\n    description: One row per order\n    columns:\n      - name: order_id\n      - name: customer_id\n      - name: order_date\n      - name: status\n      - name: amount\n',
    );
  });
});
