with orders as (select * from {{ ref('stg_orders') }})
select
    c.customer_id,
    c.first_name,
    c.last_name,
    c.created_at,
    count(o.order_id) as number_of_orders
from {{ ref('stg_customers') }} c
left join orders o using (customer_id)
group by 1, 2, 3, 4
