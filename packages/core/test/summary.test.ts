import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Analysis, DbtProject, modelSummary, resourceForFile } from '../src';

const ROOT = path.resolve(__dirname, '../../../fixtures/jaffle');

describe('modelSummary', () => {
  const project = DbtProject.load(ROOT);
  const analysis = new Analysis(project);

  it('finds the resource of a SQL file', () => {
    expect(resourceForFile(project, 'models/marts/orders.sql')?.uniqueId).toBe('model.jaffle.orders');
    expect(resourceForFile(project, 'seeds/raw_orders.csv')?.uniqueId).toBe('seed.jaffle.raw_orders');
    expect(resourceForFile(project, 'models/nope.sql')).toBeUndefined();
  });

  it('summarises a mart', () => {
    const s = modelSummary(analysis, 'model.jaffle.orders')!;
    expect(s).toMatchObject({
      label: 'orders',
      kind: 'model',
      description: 'Order mart',
      file: 'models/marts/orders.sql',
      yamlFile: 'models/marts/_marts.yml',
      materialized: 'view',
      layer: 'marts',
      counts: { columns: 5, documented: 1, inheritable: 4, missing: 0, notInYaml: 0 },
    });
    expect(s.upstream.map((u) => u.label)).toEqual(['stg_orders', 'stg_payments']);
    expect(s.downstream).toEqual([]);
    const orderId = s.columns.find((c) => c.name === 'order_id')!;
    expect(orderId.inherit).toMatchObject({ from: 'stg_orders', docBlock: 'col_stg_orders__order_id', safe: true });
    expect(orderId.location?.file).toBe('models/marts/_marts.yml');
    expect(s.columns.find((c) => c.name === 'amount')!.inherit).toMatchObject({ kind: 'transformed', safe: false });
    expect(s.columns.find((c) => c.name === 'customer_id')!.dataType).toBe('INTEGER');
  });

  it('lists downstream models with their coverage', () => {
    const s = modelSummary(analysis, 'model.jaffle.stg_orders')!;
    expect(s.downstream.map((d) => [d.label, d.coverage])).toEqual([
      ['customers', 20],
      ['orders', 20],
    ]);
    expect(s.downstream[0].location).toEqual({ file: 'models/marts/customers.sql', offset: 0 });
  });

  it('summarises sources and seeds', () => {
    const src = modelSummary(analysis, 'source.jaffle.crm.customers')!;
    expect(src.label).toBe('crm.customers');
    expect(src.locations.source).toBeUndefined();
    expect(src.locations.yaml?.file).toBe('models/staging/_sources.yml');
    expect(src.downstream.map((d) => d.label)).toEqual(['stg_customers']);
    const seed = modelSummary(analysis, 'seed.jaffle.raw_orders')!;
    expect(seed.counts.notInYaml).toBe(5);
    expect(seed.yamlFile).toBeUndefined();
  });
});
