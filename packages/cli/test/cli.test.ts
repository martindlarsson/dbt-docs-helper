import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexYaml } from '@dbt-docs-helper/core';
import { addColumnsCommand, checkCommand, coverageCommand, dataTypesCommand, inheritCommand, loadAnalysis, missingCommand } from '../src/commands';

const FIXTURE = path.resolve(__dirname, '../../../fixtures/jaffle');

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-docs-helper-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  // Keep the manifest newer than the copied files.
  const now = new Date();
  fs.utimesSync(path.join(dir, 'target/manifest.json'), now, now);
  return dir;
}

const common = { projectDir: FIXTURE, format: 'text' as const };

describe('cli commands', () => {
  it('fails under the threshold', () => {
    const a = loadAnalysis(common);
    const low = coverageCommand(a, { ...common, by: 'layer', failUnder: 50, includeInheritable: false });
    expect(low.exitCode).toBe(1);
    expect(low.output).toContain('FAILED');
    const ok = coverageCommand(a, { ...common, by: 'layer', failUnder: 50, includeInheritable: true });
    expect(ok.exitCode).toBe(0);
  });

  it('prints json', () => {
    const a = loadAnalysis(common);
    const res = coverageCommand(a, { ...common, format: 'json', by: 'kind', includeInheritable: false });
    const json = JSON.parse(res.output);
    expect(json.total.columns).toBe(42);
    expect(json.groups.map((g: { key: string }) => g.key)).toEqual(['model', 'seed', 'source']);
  });

  it('lists hand-written work first', () => {
    const res = missingCommand(loadAnalysis(common), { ...common, format: 'json', onlyMissing: false });
    const items = JSON.parse(res.output) as { status: string }[];
    expect(items[0].status).toBe('missing');
    expect(items[items.length - 1].status).toBe('inheritable');
  });

  it('inherits into YAML with --write, keeping doc() references', () => {
    const dir = copyFixture();
    const opts = { projectDir: dir, format: 'text' as const, write: true, includeRenamed: false, includeNameMatches: false };
    const res = inheritCommand(loadAnalysis(opts), opts);
    expect(res.output).toContain('Wrote 9 descriptions');
    const marts = fs.readFileSync(path.join(dir, 'models/marts/_marts.yml'), 'utf8');
    expect(marts).toContain(`      - name: order_id\n        description: "{{ doc('col_stg_orders__order_id') }}"`);
    expect(marts).toContain('      - name: last_name   # inherited later\n        description: Customer last name');
    // amount is aggregated (transformed): not written without --include-renamed
    const idx = indexYaml(marts);
    expect(idx.resources[1].columns.find((c) => c.name === 'amount')?.description).toBeUndefined();
    expect(idx.errors).toEqual([]);
  });

  it('adds catalog columns', () => {
    const dir = copyFixture();
    const opts = { projectDir: dir, format: 'text' as const, write: true };
    addColumnsCommand(loadAnalysis(opts), opts);
    const seeds = indexYaml(fs.readFileSync(path.join(dir, 'seeds/_seeds.yml'), 'utf8'));
    expect(seeds.resources[0].columns.map((c) => c.name)).toEqual(['id', 'created_at', 'first_name', 'last_name']);
  });

  it('check reports stale manifests', () => {
    const dir = copyFixture();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'models/marts/orders.sql'), future, future);
    const opts = { projectDir: dir, format: 'text' as const, by: 'folder' as const, includeInheritable: false, failOnStale: true, failOnOrphans: false, failOnTypeMismatch: false };
    const res = checkCommand(loadAnalysis(opts), opts);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('models/marts/orders.sql');
  });

  it('lists and writes data types', () => {
    const dir = copyFixture();
    const marts = path.join(dir, 'models/marts/_marts.yml');
    fs.writeFileSync(marts, fs.readFileSync(marts, 'utf8').replace('      - name: order_date\n', '      - name: order_date\n        data_type: timestamp\n'));
    const base = { projectDir: dir, format: 'json' as const, fixMismatches: false, typeCase: 'lower' as const };
    const listed = JSON.parse(dataTypesCommand(loadAnalysis(base), { ...base, write: false }).output);
    expect(listed.columns.find((c: { resource: string; column: string }) => c.resource === 'orders' && c.column === 'order_date')).toMatchObject({
      yaml: 'timestamp',
      known: 'DATE',
      status: 'mismatch',
    });
    // Without --fix-mismatches the wrong type stays.
    dataTypesCommand(loadAnalysis(base), { ...base, write: true });
    expect(fs.readFileSync(marts, 'utf8')).toContain('      - name: order_date\n        data_type: timestamp\n');
    expect(fs.readFileSync(marts, 'utf8')).toContain('      - name: order_id\n        data_type: integer\n');
    dataTypesCommand(loadAnalysis(base), { ...base, write: true, fixMismatches: true });
    expect(fs.readFileSync(marts, 'utf8')).toContain('      - name: order_date\n        data_type: date\n');

    const opts = { projectDir: dir, format: 'text' as const, by: 'folder' as const, includeInheritable: false, failOnStale: false, failOnOrphans: false, failOnTypeMismatch: true };
    expect(checkCommand(loadAnalysis(opts), opts).exitCode).toBe(0);
  });

  it('check fails on a data_type that differs from the warehouse', () => {
    const dir = copyFixture();
    const marts = path.join(dir, 'models/marts/_marts.yml');
    fs.writeFileSync(marts, fs.readFileSync(marts, 'utf8').replace('      - name: status\n', '      - name: status\n        data_type: integer\n'));
    const opts = { projectDir: dir, format: 'text' as const, by: 'folder' as const, includeInheritable: false, failOnStale: false, failOnOrphans: false, failOnTypeMismatch: true };
    const res = checkCommand(loadAnalysis(opts), opts);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('ERROR: orders.status: data_type is integer, but VARCHAR in the warehouse.');
  });
});
