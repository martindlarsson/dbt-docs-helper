import { describe, expect, it } from 'vitest';
import { addResourceEntry, applyEdits, indexYaml, newPropertiesFile, parseDocBlocks, removeDescription, replaceDocBlockContents } from '../src';

describe('removeDescription', () => {
  it('removes a plain description line and keeps comments around it', () => {
    const text = 'models:\n  - name: a  # keep\n    description: Old\n    columns:\n      - name: id\n        description: |\n          Line 1\n          Line 2\n        data_tests: [unique]\n';
    const idx = indexYaml(text);
    const m = idx.resources[0];
    expect(applyEdits(text, [removeDescription(idx, m)!])).toBe(
      'models:\n  - name: a  # keep\n    columns:\n      - name: id\n        description: |\n          Line 1\n          Line 2\n        data_tests: [unique]\n',
    );
    expect(applyEdits(text, [removeDescription(idx, m.columns[0])!])).toBe(
      'models:\n  - name: a  # keep\n    description: Old\n    columns:\n      - name: id\n        data_tests: [unique]\n',
    );
  });

  it('returns undefined without a description', () => {
    const idx = indexYaml('models:\n  - name: a\n');
    expect(removeDescription(idx, idx.resources[0])).toBeUndefined();
  });
});

describe('addResourceEntry', () => {
  const entry = { name: 'orders', description: 'One row per order', columns: [{ name: 'order_id', description: 'Id: unique' }, { name: 'amount' }] };

  it('appends to an existing models list, with its indentation', () => {
    const text = 'version: 2\nmodels:\n    - name: a\n      description: A\n\n# trailing comment\n';
    const out = applyEdits(text, [addResourceEntry(indexYaml(text), 'model', entry)!]);
    expect(out).toBe(
      'version: 2\nmodels:\n    - name: a\n      description: A\n    - name: orders\n      description: One row per order\n      columns:\n        - name: order_id\n          description: "Id: unique"\n        - name: amount\n\n# trailing comment\n',
    );
    expect(indexYaml(out).resources.map((r) => r.name)).toEqual(['a', 'orders']);
  });

  it('adds a models list when the file only has sources', () => {
    const text = 'version: 2\nsources:\n  - name: crm\n    tables:\n      - name: customers\n';
    const out = applyEdits(text, [addResourceEntry(indexYaml(text), 'model', { name: 'stg' })!]);
    expect(out).toBe(`${text}\nmodels:\n  - name: stg\n`);
    expect(indexYaml(out).resources.map((r) => [r.kind, r.name])).toEqual([
      ['source', 'customers'],
      ['model', 'stg'],
    ]);
  });

  it('fills an empty models key', () => {
    const text = 'version: 2\nmodels:\n';
    const out = applyEdits(text, [addResourceEntry(indexYaml(text), 'model', { name: 'm' })!]);
    expect(out).toBe('version: 2\nmodels:\n  - name: m\n');
  });

  it('writes a new file', () => {
    expect(newPropertiesFile('seed', { name: 'raw', columns: [{ name: 'id', description: 'Id' }] })).toBe(
      'version: 2\n\nseeds:\n  - name: raw\n    columns:\n      - name: id\n        description: Id\n',
    );
  });
});

describe('replaceDocBlockContents', () => {
  it('keeps the tags (including whitespace control)', () => {
    const text = 'Intro\n\n{%- docs a -%}\nOld text\n{%- enddocs -%}\n\n{% docs b %}B{% enddocs %}\n';
    const [a] = parseDocBlocks(text);
    expect(applyEdits(text, [replaceDocBlockContents(text, a, 'New\ntext ')])).toBe(
      'Intro\n\n{%- docs a -%}\nNew\ntext\n{%- enddocs -%}\n\n{% docs b %}B{% enddocs %}\n',
    );
  });
});
