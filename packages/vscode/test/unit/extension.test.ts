import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
// The alias in vitest.config.ts maps 'vscode' to the mock.
import { __open, __reset, __state } from '../mock/vscode';
import { activate } from '../../src/extension';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/jaffle');

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-docs-helper-ext-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const now = new Date();
  fs.utimesSync(path.join(dir, 'target/manifest.json'), now, now);
  return dir;
}

function lineOf(doc: vscode.TextDocument, needle: string): number {
  const idx = doc.getText().indexOf(needle);
  if (idx < 0) throw new Error(`not found: ${needle}`);
  return doc.positionAt(idx).line;
}

let root: string;
let fakeContext: any;

beforeEach(async () => {
  root = copyFixture();
  __reset(root);
  const state = new Map<string, unknown>();
  fakeContext = {
    subscriptions: [] as { dispose(): void }[],
    workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) },
  };
  await activate(fakeContext);
});

describe('extension (mocked VS Code)', () => {
  it('shows inherited descriptions as inlay hints', () => {
    const doc = __open(path.join(root, 'models/marts/_marts.yml')) as unknown as vscode.TextDocument;
    const hints = __state.inlayProviders[0].provideInlayHints(doc, new vscode.Range(0, 0, 1000, 0)) as vscode.InlayHint[];
    const labels = hints.map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join('')));
    expect(labels).toContain('↳ stg_orders: "Unique identifier of an order."');
    expect(labels).toContain('↳ crm.customers: "When the row was created in the CRM"');
    // hint is placed at the end of the line, after the trailing comment
    const lastName = hints.find((h) => JSON.stringify(h.label).includes('Customer last name'))!;
    expect(lastName.position.line).toBe(lineOf(doc, 'name: last_name   # inherited later'));
    expect(lastName.position.character).toBe('      - name: last_name   # inherited later'.length);
  });

  it('reports diagnostics for open files', () => {
    const file = path.join(root, 'models/staging/_staging.yml');
    __open(file);
    __state.commands.get('dbt-docs-helper.refresh');
    const diags = (__state.diagnostics.get(file) ?? []) as vscode.Diagnostic[];
    const codes = diags.map((d) => d.code);
    expect(codes).toContain('missing-description'); // stg_payments.payment_method
    expect(codes).toContain('inheritable'); // stg_customers.first_name
    expect(codes).toContain('missing-model-description'); // stg_payments
    expect(diags.find((d) => d.code === 'missing-description')!.message).toContain('payment_id');
  });

  it('inherits a doc() reference through a code action', async () => {
    const doc = __open(path.join(root, 'models/marts/_marts.yml')) as unknown as vscode.TextDocument;
    const line = lineOf(doc, '      - name: order_id');
    const range = new vscode.Range(line, 15, line, 15);
    const actions = __state.codeActionProviders[0].provideCodeActions(doc, range, { diagnostics: [] }) as vscode.CodeAction[];
    const titles = actions.map((a) => a.title);
    expect(titles[0]).toBe("Inherit from stg_orders: {{ doc('col_stg_orders__order_id') }}");
    expect(actions[0].isPreferred).toBe(true);
    await vscode.commands.executeCommand(actions[0].command!.command, ...actions[0].command!.arguments!);
    expect(doc.getText()).toContain(`      - name: order_id\n        description: "{{ doc('col_stg_orders__order_id') }}"\n      - name: customer_id`);
  });

  it('hover shows the lineage', () => {
    const doc = __open(path.join(root, 'models/marts/_marts.yml')) as unknown as vscode.TextDocument;
    const line = lineOf(doc, '      - name: created_at');
    const hover = __state.hoverProviders[0].provideHover(doc, new vscode.Position(line, 16)) as vscode.Hover;
    const text = (hover.contents as unknown as vscode.MarkdownString).value;
    expect(text).toContain('**customers.created_at** — can be inherited');
    expect(text).toContain('Lineage: crm.customers → stg_customers → customers');
  });

  it('moves a description to a new doc block and links both columns', async () => {
    const marts = __open(path.join(root, 'models/marts/_marts.yml')) as unknown as vscode.TextDocument;
    const line = lineOf(marts, '      - name: order_date');
    const actions = __state.codeActionProviders[0].provideCodeActions(marts, new vscode.Range(line, 15, line, 15), { diagnostics: [] }) as vscode.CodeAction[];
    const move = actions.find((a) => a.title.startsWith("Move stg_orders.order_date's description"))!;
    expect(move).toBeDefined();
    // 1) block name: accept default, 2) other columns: keep defaults, 3) file: new file, 4) new file path: default
    __state.quickPickAnswers.push((items) => items.filter((i: any) => i.picked));
    __state.quickPickAnswers.push((items) => items[items.length - 1]);
    await vscode.commands.executeCommand(move.command!.command, ...move.command!.arguments!);
    const staging = __open(path.join(root, 'models/staging/_staging.yml'));
    expect(staging.getText()).toContain(`      - name: order_date\n        description: "{{ doc('col_stg_orders__order_date') }}"`);
    expect(marts.getText()).toContain(`      - name: order_date\n        description: "{{ doc('col_stg_orders__order_date') }}"`);
    const docs = __open(path.join(root, 'models/_docs/columns.md')).getText();
    expect(docs).toBe(
      fs.readFileSync(path.join(root, 'models/_docs/columns.md'), 'utf8') +
        '\n{% docs col_stg_orders__order_date %}\nDate the order was placed\n{% enddocs %}\n',
    );
  });

  it('inherits all safe descriptions in a file', async () => {
    const marts = __open(path.join(root, 'models/marts/_marts.yml')) as unknown as vscode.TextDocument;
    await vscode.commands.executeCommand('dbt-docs-helper.inheritAll', marts.uri);
    expect(__state.messages.at(-1)).toContain('inherited 7 descriptions');
    expect(marts.getText()).not.toContain('Payment amount in SEK'); // transformed: not automatic
  });

  it('populates the tree views', () => {
    const coverage = __state.treeProviders.get('dbt-docs-helper.coverage');
    const groups = coverage.getChildren();
    const labels = groups.map((g: unknown) => coverage.getTreeItem(g).label);
    expect(labels).toEqual(['Total', 'marts', 'seeds', 'staging']);
    const work = __state.treeProviders.get('dbt-docs-helper.workList');
    const sections = work.getChildren();
    expect(work.getTreeItem(sections[0]).label).toBe('Write by hand');
    const cands = __state.treeProviders.get('dbt-docs-helper.candidates');
    expect(cands.getChildren().length).toBeGreaterThan(0);
  });

  it('creates a shared doc block from the candidates view, then drops the candidate', async () => {
    const tree = __state.treeProviders.get('dbt-docs-helper.candidates');
    const names = () => tree.getChildren().map((n: any) => tree.getTreeItem(n).label);
    expect(names()).toContain('first_name');
    const node = tree.getChildren().find((n: any) => tree.getTreeItem(n).label === 'first_name');
    // name: default (col_first_name); usages: keep the pre-selected ones; file: the existing columns.md
    __state.quickPickAnswers.push((items) => items.filter((i: any) => i.picked));
    __state.quickPickAnswers.push((items) => items.find((i: any) => i.file === 'models/_docs/columns.md'));
    await vscode.commands.executeCommand('dbt-docs-helper.candidates.createBlock', node);
    const docs = __open(path.join(root, 'models/_docs/columns.md')).getText();
    expect(docs).toContain('{% docs col_first_name %}\nCustomer first name\n{% enddocs %}');
    const marts = __open(path.join(root, 'models/marts/_marts.yml')).getText();
    expect(marts).toContain(`      - name: first_name\n        description: "{{ doc('col_first_name') }}"`);
    expect(names()).not.toContain('first_name');
  });

  it('lists catalog-only columns separately in the work list', async () => {
    const work = __state.treeProviders.get('dbt-docs-helper.workList');
    const sections = work.getChildren();
    expect(sections.map((s: any) => work.getTreeItem(s).label)).toEqual(['Write by hand', 'Can be inherited', 'Not in YAML']);
    const byHand = work.getChildren(sections[0]).map((n: any) => work.getTreeItem(n));
    expect(byHand.every((i: any) => i.command)).toBe(true);
    const notInYaml = work.getChildren(sections[2]);
    const seed = notInYaml.find((n: any) => work.getTreeItem(n).label === 'raw_customers');
    expect(work.getTreeItem(seed).description).toBe('first_name, last_name');
    __state.quickPickAnswers.push((items) => items.find((i: any) => i.label === 'Names only'));
    await vscode.commands.executeCommand('dbt-docs-helper.workList.addColumns', seed);
    const seeds = __open(path.join(root, 'seeds/_seeds.yml')).getText();
    expect(seeds).toContain('      - name: created_at\n      - name: first_name\n      - name: last_name');
    // a seed without a YAML entry opens its CSV file
    const orders = notInYaml.find((n: any) => work.getTreeItem(n).label === 'raw_orders');
    expect(work.getTreeItem(orders).command.arguments[1]).toBe('seeds/raw_orders.csv');
  });

  it('runs the parse command in a terminal', async () => {
    __state.config.set('dbt-docs-helper.parseCommand', 'dbtf parse');
    await vscode.commands.executeCommand('dbt-docs-helper.runParse', root);
    expect(__state.terminalText).toEqual(['dbtf parse']);
  });
});
