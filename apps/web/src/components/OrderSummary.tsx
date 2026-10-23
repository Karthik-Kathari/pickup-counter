import Badge from '../ui/Badge';

interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

interface OrderSummaryProps {
  orderId: string;
  items: OrderItem[];
  totalPaise: number;
  paidAt?: string;
  pickedUpAt?: string;
  className?: string;
}

export default function OrderSummary({
  orderId,
  items,
  totalPaise,
  paidAt,
  pickedUpAt,
  className = '',
}: OrderSummaryProps) {
  return (
    <div className={`order-summary ${className}`.trim()}>
      <div className="order-summary__header">
        <h2 className="order-summary__title">
          <Badge variant="accent" mono>
            {orderId.slice(0, 8)}
          </Badge>
        </h2>
        <p className="order-summary__meta">Order reference</p>
      </div>

      <ul className="order-summary__list" aria-label="Order items">
        {items.map((item) => (
          <li key={item.productId} className="order-summary__item">
            <span className="order-summary__item-desc">
              <span className="order-summary__item-name">{item.name}</span>
              <span className="order-summary__item-qty">× {item.quantity}</span>
            </span>
            <span className="order-summary__item-price">
              {formatPaise(item.lineTotalPaise)}
              <span className="order-summary__item-unit">
                {' '}
                ({formatPaise(item.unitPricePaise)} each)
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="order-summary__total">
        <span className="order-summary__total-label">Total (server-computed)</span>
        <span className="order-summary__total-amount">{formatPaise(totalPaise)}</span>
      </div>

      {paidAt && (
        <p className="order-summary__timestamp">
          Paid at{' '}
          <time dateTime={paidAt} title={paidAt}>
            {formatDateTime(paidAt)}
          </time>
        </p>
      )}

      {pickedUpAt && (
        <p className="order-summary__timestamp">
          Picked up at{' '}
          <time dateTime={pickedUpAt} title={pickedUpAt}>
            {formatDateTime(pickedUpAt)}
          </time>
        </p>
      )}
    </div>
  );
}

function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${rupees.toString()}.${String(rest).padStart(2, '0')}`;
}

function formatDateTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}
