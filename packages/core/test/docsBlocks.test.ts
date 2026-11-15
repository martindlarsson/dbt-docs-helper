import { describe, expect, it } from 'vitest';
import { docBlockAppendText, docBlockName, modelPartOfBlockName, parseDocBlocks } from '../src';

describe('doc blocks', () => {
  it('parses blocks', () => {
    const text = `{% docs a %}\nHello\n{% enddocs %}\n\n{%- docs b_c -%}World{%- enddocs -%}`;
    const blocks = parseDocBlocks(text);
    expect(blocks.map((b) => [b.name, b.contents])).toEqual([
      ['a', 'Hello'],
      ['b_c', 'World'],
    ]);
    expect(text.slice(...blocks[1].nameRange)).toBe('b_c');
  });

  it('appends blocks with blank-line separation', () => {
    expect(docBlockAppendText('', 'x', 'Text')).toBe('{% docs x %}\nText\n{% enddocs %}\n');
    expect(docBlockAppendText('a\n', 'x', 'T')).toBe('\n{% docs x %}\nT\n{% enddocs %}\n');
    expect(docBlockAppendText('a', 'x', 'T')).toBe('\n\n{% docs x %}\nT\n{% enddocs %}\n');
  });

  it('builds names from the pattern', () => {
    expect(docBlockName('col_{model}__{column}', { kind: 'model', name: 'stg_customers' }, 'customer_id')).toBe(
      'col_stg_customers__customer_id',
    );
    expect(docBlockName('col_{model}__{column}', { kind: 'source', name: 'customers', sourceName: 'crm' }, 'Id')).toBe(
      'col_crm_customers__id',
    );
    expect(docBlockName('{column}', { kind: 'model', name: 'm' }, '1st')).toBe('_1st');
  });

  it('extracts the model part', () => {
    expect(modelPartOfBlockName('col_{model}__{column}', 'col_stg_orders__order_id')).toBe('stg_orders');
    expect(modelPartOfBlockName('col_{model}__{column}', 'something_else')).toBeUndefined();
  });
});
