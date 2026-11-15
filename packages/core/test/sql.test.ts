import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../src';

describe('analyzeSql', () => {
  it('reads aliases, import CTEs and simple select items', () => {
    const a = analyzeSql(`
      with orders as (select * from {{ ref('stg_orders') }}),
      payments as (select * from {{ ref('stg_payments') }})
      select
          o.order_id,
          c.id as customer_id,   -- renamed
          status,
          sum(p.amount) as amount,
          cast(o.created_at as date) as created_date,
          count(*) as n
      from orders o
      left join payments p using (order_id)
      join {{ source('crm', 'customers') }} as c on c.id = o.customer_id
    `);
    expect(a.relations.get('o')).toEqual({ kind: 'ref', name: 'stg_orders' });
    expect(a.relations.get('orders')).toEqual({ kind: 'ref', name: 'stg_orders' });
    expect(a.relations.get('p')).toEqual({ kind: 'ref', name: 'stg_payments' });
    expect(a.relations.get('c')).toEqual({ kind: 'source', sourceName: 'crm', name: 'customers' });
    expect(a.selects.get('order_id')).toEqual({ output: 'order_id', column: 'order_id', qualifier: 'o' });
    expect(a.selects.get('customer_id')).toEqual({ output: 'customer_id', column: 'id', qualifier: 'c' });
    expect(a.selects.get('status')?.qualifier).toBeUndefined();
    expect(a.selects.get('amount')).toMatchObject({ column: 'amount', qualifier: 'p', transformed: true });
    expect(a.selects.get('created_date')).toMatchObject({ column: 'created_at', qualifier: 'o', transformed: false });
    expect(a.casts.get('created_date')).toBe('date');
    expect(a.selects.has('n')).toBe(false);
  });

  it('follows select * from final', () => {
    const a = analyzeSql(`
      with src as (select * from {{ ref('a') }}),
      final as (select s.x as y, s.z from src s)
      select * from final
    `);
    expect(a.selects.get('y')).toEqual({ output: 'y', column: 'x', qualifier: 's' });
    expect(a.relations.get('s')).toEqual({ kind: 'ref', name: 'a' });
  });

  it('handles two-argument ref and missing SQL', () => {
    expect(analyzeSql(`select * from {{ ref('pkg', 'm') }}`).relations.get('m')).toEqual({ kind: 'ref', name: 'm' });
    expect(analyzeSql(undefined).selects.size).toBe(0);
  });
});
