import Button from '../ui/Button';

export interface CartPanelItem {
  productId: string;
  name: string;
  pricePaise: number;
  quantity: number;
}

interface CartPanelProps {
  items: CartPanelItem[];
  cartCount: number;
  placing: boolean;
  error: string | null;
  onPlaceOrder: () => void;
  onRemoveItem: (productId: string) => void;
  className?: string;
}

export default function CartPanel({
  items,
  cartCount,
  placing,
  error,
  onPlaceOrder,
  onRemoveItem,
  className = '',
}: CartPanelProps) {
  return (
    <div className={`cart-panel ${className}`.trim()}>
      <div className="cart-panel__header">
        <h2 className="cart-panel__title">Your order</h2>
        {cartCount > 0 && (
          <span className="cart-panel__badge">
            {cartCount} item{cartCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="cart-panel__empty">Cart is empty — add something from the catalog above.</p>
      ) : (
        <>
          <ul className="cart-panel__list" aria-label="Cart items">
            {items.map((item) => (
              <li key={item.productId} className="cart-panel__item">
                <span className="cart-panel__item-desc">
                  <span className="cart-panel__item-name">{item.name}</span>
                  <span className="cart-panel__item-qty">× {item.quantity}</span>
                  <span className="cart-panel__item-price">
                    {' '}
                    <span className="cart-panel__item-unit">(@</span>
                    <span className="cart-panel__item-unit-price">
                      {formatPaise(item.pricePaise)}
                    </span>
                    <span className="cart-panel__item-unit">each)</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="cart-panel__remove"
                  onClick={() => onRemoveItem(item.productId)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <p className="cart-panel__note">
            The total is calculated by the server when the order is placed — prices are read from
            the catalog at that moment.
          </p>

          <div className="cart-panel__actions">
            <Button variant="primary" size="lg" fullWidth loading={placing} onClick={onPlaceOrder}>
              {placing ? 'Placing order…' : 'Place order'}
            </Button>
          </div>
        </>
      )}

      {error !== null && <p className="cart-panel__error">{error}</p>}
    </div>
  );
}

function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${rupees.toString()}.${String(rest).padStart(2, '0')}`;
}
