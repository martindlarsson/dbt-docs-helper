select
    id as payment_id,
    order_id,
    payment_method,
    amount,
    status
from {{ ref('raw_payments') }}
