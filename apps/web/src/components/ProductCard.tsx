import QuantityControl from '../ui/QuantityControl';

interface ProductCardProps {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
  availableUnits: number;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
}

export default function ProductCard({
  name,
  pricePaise,
  availableUnits,
  quantity,
  onIncrement,
  onDecrement,
  onRemove,
}: ProductCardProps) {
  const soldOut = availableUnits === 0;

  return (
    <article className="product-card">
      <div className="product-card__header">
        <div className="product-card__name-row">
          <h3 className="product-card__name">{name}</h3>
          {soldOut ? (
            <span className="product-card__badge product-card__badge--soldout">Sold out</span>
          ) : (
            <span className="product-card__availability">
              <span className="product-card__availability-count">{availableUnits}</span>
              <span className="product-card__availability-label">available</span>
            </span>
          )}
        </div>
        <div className="product-card__price">
          <span className="product-card__price-amount">{formatPaise(pricePaise)}</span>
          <span className="product-card__price-label">each</span>
        </div>
      </div>

      <div className="product-card__action">
        {soldOut ? (
          <span className="product-card__soldout-msg">Not available right now</span>
        ) : quantity > 0 ? (
          <QuantityControl
            value={quantity}
            max={availableUnits}
            onDecrement={onDecrement}
            onIncrement={onIncrement}
            label={name}
          />
        ) : (
          <button type="button" className="product-card__add" onClick={onIncrement}>
            Add
          </button>
        )}
      </div>

      {quantity > 0 && (
        <div className="product-card__in-cart">
          <span className="product-card__in-cart-text">In your cart</span>
          <button type="button" className="product-card__remove" onClick={onRemove}>
            Remove all
          </button>
        </div>
      )}
    </article>
  );
}

function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${rupees.toString()}.${String(rest).padStart(2, '0')}`;
}
