select
    id as order_id,
    user_id as customer_id,
    order_date,
    status,
    created_at
from {{ ref('raw_orders') }}
