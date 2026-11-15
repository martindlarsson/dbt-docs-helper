import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Analysis,
  blocksWithText,
  conflicts,
  coverage,
  DbtProject,
  docsBlockCandidates,
  orphanDocBlocks,
  percent,
  workList,
} from '../src';

const ROOT = path.resolve(__dirname, '../../../fixtures/jaffle');

function load() {
  const project = DbtProject.load(ROOT);
  return { project, analysis: new Analysis(project) };
}

function column(a: Analysis, id: string, name: string) {
  const c = a.resources.get(id)!.columns.find((c) => c.name === name);
  if (!c) throw new Error(`no column ${id}.${name}`);
  return c;
}

describe('analysis of the jaffle fixture', () => {
  const { project, analysis } = load();

  it('loads the project', () => {
    expect(project.manifest.projectName).toBe('jaffle');
    expect(project.config.modelPaths).toEqual(['models']);
    expect(project.yamlFiles.has('models/staging/_staging.yml')).toBe(true);
    expect(project.docBlocks().get('col_stg_orders__order_id')?.contents).toBe('Unique identifier of an order.');
  });

  it('inherits pass-through columns and keeps doc() references', () => {
    const c = column(analysis, 'model.jaffle.orders', 'order_id');
    expect(c.status).toBe('inheritable');
    expect(c.candidates[0]).toMatchObject({
      fromLabel: 'stg_orders',
      kind: 'passthrough',
      via: 'sql',
      docBlock: 'col_stg_orders__order_id',
      rawDescription: "{{ doc('col_stg_orders__order_id') }}",
    });
  });

  it('follows the SQL through the right upstream', () => {
    // customers.created_at comes from stg_customers (alias c), which inherits from the crm source.
    const c = column(analysis, 'model.jaffle.customers', 'created_at');
    expect(c.candidates[0].fromLabel).toBe('crm.customers');
    expect(c.candidates[0].chain).toEqual(['model.jaffle.customers', 'model.jaffle.stg_customers', 'source.jaffle.crm.customers']);
  });

  it('marks aggregated columns as transformed', () => {
    const c = column(analysis, 'model.jaffle.orders', 'amount');
    expect(c.candidates[0]).toMatchObject({ fromLabel: 'stg_payments', kind: 'transformed' });
  });

  it('reports missing columns that cannot be inherited', () => {
    expect(column(analysis, 'model.jaffle.stg_payments', 'payment_method').status).toBe('missing');
    expect(column(analysis, 'model.jaffle.stg_customers', 'customer_id').status).toBe('documented');
  });

  it('adds columns from the catalog that are not in YAML', () => {
    const c = column(analysis, 'seed.jaffle.raw_orders', 'user_id');
    expect(c.notInYaml).toBe(true);
    expect(c.status).toBe('missing');
  });

  it('computes coverage', () => {
    const report = coverage(analysis, 'layer');
    expect(report.groups.map((g) => g.key)).toEqual(['marts', 'seeds', 'staging']);
    const marts = report.groups[0];
    expect(marts).toMatchObject({ columns: 10, documented: 2, inheritable: 8, missing: 0 });
    expect(percent(marts)).toBe(20);
    expect(percent(marts, true)).toBe(100);
    const t = report.total;
    expect(t.documented + t.inheritable + t.missing).toBe(t.columns);
  });

  it('puts the hand-written work first', () => {
    const list = workList(analysis);
    const firstInheritable = list.findIndex((i) => i.column.status === 'inheritable');
    expect(list.slice(0, firstInheritable).every((i) => i.column.status === 'missing')).toBe(true);
  });

  it('suggests docs-block candidates', () => {
    const cands = docsBlockCandidates(analysis, { minModels: 3 });
    const orderId = cands.find((c) => c.column === 'order_id')!;
    expect(orderId.sameText).toBe(true);
    expect(orderId.suggestedName).toBe('col_stg_orders__order_id');
    const customerId = cands.find((c) => c.column === 'customer_id')!;
    expect(customerId.sameText).toBe(false);
    expect(customerId.suggestedName).toBe('col_stg_customers__customer_id');
    const first = cands.find((c) => c.column === 'first_name')!;
    expect(first.suggestedName).toBe('col_crm_customers__first_name');
  });

  it('finds conflicting descriptions', () => {
    expect(conflicts(analysis).map((c) => c.column)).toContain('customer_id');
  });

  it('finds blocks by text and has no orphans', () => {
    expect(blocksWithText(analysis, '  unique identifier of an ORDER. ')).toEqual(['col_stg_orders__order_id']);
    expect(orphanDocBlocks(analysis)).toEqual([]);
  });

  it('uses unsaved YAML buffers', () => {
    const p = DbtProject.load(ROOT);
    const file = 'models/staging/_staging.yml';
    const text = p.yamlFiles.get(file)!.text.replace(
      '      - name: payment_method\n',
      '      - name: payment_method\n        description: How the customer paid\n',
    );
    p.setFileText(file, text);
    const a = new Analysis(p);
    expect(column(a, 'model.jaffle.stg_payments', 'payment_method')).toMatchObject({
      status: 'documented',
      description: 'How the customer paid',
    });
  });

  it('detects orphaned blocks', () => {
    const p = DbtProject.load(ROOT);
    p.setFileText('models/_docs/columns.md', '{% docs col_old_model__id %}\nx\n{% enddocs %}\n');
    expect(orphanDocBlocks(new Analysis(p)).map((o) => o.model)).toEqual(['old_model']);
  });
});
