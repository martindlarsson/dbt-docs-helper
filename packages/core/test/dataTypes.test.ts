import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Analysis, applyEdits, DbtProject, formatType, indexYaml, normalizeType, removeColumnDataType, sameType, setColumnDataType } from '../src';

const ROOT = path.resolve(__dirname, '../../../fixtures/jaffle');

const col = (a: Analysis, id: string, name: string) => a.resources.get(id)!.columns.find((c) => c.name === name)!;

describe('type names', () => {
  it('treats aliases and sizes as the same type', () => {
    expect(sameType('int', 'INTEGER')).toBe(true);
    expect(sameType('varchar(255)', 'character varying')).toBe(true);
    expect(sameType('timestamp with time zone', 'timestamptz')).toBe(true);
    expect(sameType('numeric(10,2)', 'decimal')).toBe(true);
    expect(sameType('date', 'timestamp')).toBe(false);
    expect(normalizeType(' Double Precision ')).toBe('double');
    expect(formatType('HUGEINT')).toBe('hugeint');
    expect(formatType('date', 'upper')).toBe('DATE');
  });
});

describe('suggestType', () => {
  it('uses the warehouse type when catalog.json is there', () => {
    const a = new Analysis(DbtProject.load(ROOT));
    expect(col(a, 'model.jaffle.orders', 'amount').typeSuggestion).toEqual({ type: 'HUGEINT', source: 'warehouse' });
  });

  describe('without catalog.json', () => {
    const project = DbtProject.load(ROOT);
    project.catalog = undefined;
    const a = new Analysis(project);

    it('reads casts in the SQL', () => {
      expect(col(a, 'model.jaffle.stg_orders', 'order_date').typeSuggestion).toEqual({ type: 'date', source: 'cast' });
    });

    it('follows lineage to a cast upstream', () => {
      expect(col(a, 'model.jaffle.orders', 'order_date').typeSuggestion).toEqual({ type: 'date', source: 'upstream', from: 'stg_orders.order_date' });
    });

    it('uses seed column_types, also through a rename', () => {
      expect(col(a, 'model.jaffle.stg_payments', 'amount').typeSuggestion).toEqual({ type: 'integer', source: 'upstream', from: 'raw_payments.amount' });
    });

    it('does not guess through transformed columns', () => {
      // orders.amount = sum(p.amount): the type can change
      expect(col(a, 'model.jaffle.orders', 'amount').typeSuggestion).toBeUndefined();
    });

    it('follows data_type declared upstream in YAML', () => {
      const p = DbtProject.load(ROOT);
      p.catalog = undefined;
      const file = 'models/staging/_staging.yml';
      p.setFileText(file, p.yamlFiles.get(file)!.text.replace('      - name: first_name\n', '      - name: first_name\n        data_type: varchar(100)\n'));
      const b = new Analysis(p);
      expect(col(b, 'model.jaffle.customers', 'first_name').typeSuggestion).toEqual({ type: 'varchar(100)', source: 'upstream', from: 'stg_customers.first_name' });
      expect(col(b, 'model.jaffle.stg_customers', 'first_name').dataType).toBe('varchar(100)');
    });
  });

  it('flags a YAML data_type that differs from the warehouse', () => {
    const p = DbtProject.load(ROOT);
    const file = 'models/marts/_marts.yml';
    p.setFileText(file, p.yamlFiles.get(file)!.text.replace('      - name: order_date\n', '      - name: order_date\n        data_type: timestamp\n').replace('      - name: status\n', '      - name: status\n        data_type: text\n'));
    const a = new Analysis(p);
    expect(col(a, 'model.jaffle.orders', 'order_date').typeMismatch).toEqual({ yaml: 'timestamp', warehouse: 'DATE' });
    expect(col(a, 'model.jaffle.orders', 'status').typeMismatch).toBeUndefined(); // text = VARCHAR
  });
});

describe('YAML edits for data_type', () => {
  const text = 'models:\n  - name: a\n    columns:\n      - name: id   # key\n        description: |\n          Multi\n          line\n        data_tests: [unique]\n      - name: b\n        data_type: int\n';
  const idx = indexYaml(text);
  const [id, b] = idx.resources[0].columns;

  it('reads data_type', () => {
    expect(b.dataType?.value).toBe('int');
    expect(id.dataType).toBeUndefined();
  });

  it('inserts after the description (also a block scalar)', () => {
    expect(applyEdits(text, [setColumnDataType(idx, id, 'integer')])).toBe(
      'models:\n  - name: a\n    columns:\n      - name: id   # key\n        description: |\n          Multi\n          line\n        data_type: integer\n        data_tests: [unique]\n      - name: b\n        data_type: int\n',
    );
  });

  it('replaces and removes', () => {
    expect(applyEdits(text, [setColumnDataType(idx, b, 'numeric(10,2)')])).toContain('      - name: b\n        data_type: numeric(10,2)\n');
    expect(applyEdits(text, [removeColumnDataType(idx, b)!])).toBe(text.replace('        data_type: int\n', ''));
  });

  it('inserts after the name when there is no description', () => {
    const t = 'models:\n  - name: a\n    columns:\n      - name: x\n        data_tests: [unique]\n';
    const i = indexYaml(t);
    expect(applyEdits(t, [setColumnDataType(i, i.resources[0].columns[0], 'date')])).toBe(
      'models:\n  - name: a\n    columns:\n      - name: x\n        data_type: date\n        data_tests: [unique]\n',
    );
  });
});
