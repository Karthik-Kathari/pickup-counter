interface QuantityControlProps {
  value: number;
  min?: number;
  max: number;
  onDecrement: () => void;
  onIncrement: () => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export default function QuantityControl({
  value,
  min = 0,
  max,
  onDecrement,
  onIncrement,
  label,
  disabled = false,
  className = '',
}: QuantityControlProps) {
  return (
    <div
      className={`qty-control ${className}`.trim()}
      role={label ? 'group' : undefined}
      aria-label={label ?? undefined}
    >
      <button
        type="button"
        className="qty-control__btn qty-control__btn--minus"
        onClick={onDecrement}
        disabled={disabled || value <= min}
        aria-label={label ? `Remove one ${label}` : 'Decrease quantity'}
        aria-disabled={value <= min || disabled}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span className="qty-control__value" aria-live="polite" aria-atomic="true">
        {value}
      </span>
      <button
        type="button"
        className="qty-control__btn qty-control__btn--plus"
        onClick={onIncrement}
        disabled={disabled || value >= max}
        aria-label={label ? `Add one ${label}` : 'Increase quantity'}
        aria-disabled={value >= max || disabled}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
