import { describe, expect, it } from 'vitest';
import { addColumns, applyEdits, docRefName, findAt, formatYamlScalar, indexYaml, setColumnDescription } from '../src';

const SRC = `version: 2

models:
  # A comment that must survive
  - name: stg_customers
    description: One row per customer
    columns:
      - name: customer_id   # the key
        description: "{{ doc('col_x') }}"
      - name: first_name
      - name: last_name
        description:
        data_tests: [not_null]

sources:
  - name: crm
    tables:
      - name: customers
        columns:
          - {name: id}
`;

describe('indexYaml', () => {
  const idx = indexYaml(SRC);

  it('finds models, sources and columns', () => {
    expect(idx.resources.map((r) => [r.kind, r.sourceName, r.name])).toEqual([
      ['model', undefined, 'stg_customers'],
      ['source', 'crm', 'customers'],
    ]);
    const m = idx.resources[0];
    expect(m.description?.value).toBe('One row per customer');
    expect(m.columns.map((c) => c.name)).toEqual(['customer_id', 'first_name', 'last_name']);
    expect(m.columns[0].description?.value).toBe("{{ doc('col_x') }}");
    expect(m.columns[0].keyIndent).toBe(8);
    expect(m.columns[2].description?.value).toBe('');
    expect(idx.resources[1].columns[0].flow).toBe(true);
  });

  it('finds the column at an offset', () => {
    const off = SRC.indexOf('first_name');
    expect(findAt(idx, off)?.column?.name).toBe('first_name');
  });

  it('reads doc() references', () => {
    expect(docRefName("{{ doc('col_x') }}")).toBe('col_x');
    expect(docRefName('{{doc("pkg", "col_y")}}')).toBe('col_y');
    expect(docRefName("Text {{ doc('a') }}")).toBeUndefined();
  });
});

describe('edits', () => {
  const idx = indexYaml(SRC);
  const model = idx.resources[0];

  it('inserts a description after the name and keeps comments', () => {
    const out = applyEdits(SRC, [setColumnDescription(idx, model.columns[1], 'Customer first name')]);
    expect(out).toContain('      - name: first_name\n        description: Customer first name\n      - name: last_name');
    expect(out).toContain('# A comment that must survive');
    expect(out).toContain('# the key');
  });

  it('fills an empty description', () => {
    const out = applyEdits(SRC, [setColumnDescription(idx, model.columns[2], "{{ doc('col_y') }}")]);
    expect(out).toContain(`        description: "{{ doc('col_y') }}"\n        data_tests: [not_null]`);
  });

  it('replaces an existing description', () => {
    const out = applyEdits(SRC, [setColumnDescription(idx, model.columns[0], 'New: text')]);
    expect(out).toContain('      - name: customer_id   # the key\n        description: "New: text"\n');
  });

  it('handles flow mappings', () => {
    const src = idx.resources[1];
    const out = applyEdits(SRC, [setColumnDescription(idx, src.columns[0], 'Id')]);
    expect(out).toContain('- {name: id, description: "Id"}');
  });

  it('adds columns after the last one', () => {
    const edit = addColumns(idx, model, [{ name: 'created_at' }, { name: 'email', description: 'E-mail' }])!;
    const out = applyEdits(SRC, [edit]);
    expect(out).toContain('        data_tests: [not_null]\n      - name: created_at\n      - name: email\n        description: E-mail\n\nsources:');
    expect(indexYaml(out).resources[0].columns.map((c) => c.name)).toEqual(['customer_id', 'first_name', 'last_name', 'created_at', 'email']);
  });

  it('creates a columns key when missing', () => {
    const text = 'models:\n  - name: a\n    description: x\n  - name: b\n';
    const i = indexYaml(text);
    const out = applyEdits(text, [addColumns(i, i.resources[0], [{ name: 'id' }])!]);
    expect(out).toBe('models:\n  - name: a\n    description: x\n    columns:\n      - name: id\n  - name: b\n');
  });

  it('keeps CRLF line endings', () => {
    const text = 'models:\r\n  - name: a\r\n    columns:\r\n      - name: id\r\n';
    const i = indexYaml(text);
    const out = applyEdits(text, [setColumnDescription(i, i.resources[0].columns[0], 'Id')]);
    expect(out).toBe('models:\r\n  - name: a\r\n    columns:\r\n      - name: id\r\n        description: Id\r\n');
  });

  it('formats scalars safely', () => {
    expect(formatYamlScalar('Plain text (ok)', 0)).toBe('Plain text (ok)');
    expect(formatYamlScalar('a: b', 0)).toBe('"a: b"');
    expect(formatYamlScalar('yes', 0)).toBe('"yes"');
    expect(formatYamlScalar('#x', 0)).toBe('"#x"');
    expect(formatYamlScalar("{{ doc('x') }}", 0)).toBe(`"{{ doc('x') }}"`);
    expect(formatYamlScalar('line 1\nline 2', 4)).toBe('|\n      line 1\n      line 2');
  });
});
