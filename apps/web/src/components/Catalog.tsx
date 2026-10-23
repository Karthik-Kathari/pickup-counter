import ProductCard from './ProductCard';

interface Product {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
  availableUnits: number;
}

export interface CatalogProps {
  products: readonly Product[];
  loading: boolean;
  error: string | null;
  cart: Record<string, number>;
  onAdd: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
}

export default function Catalog({
  products,
  loading,
  error,
  cart,
  onAdd,
  onDecrement,
  onRemove,
}: CatalogProps) {
  if (loading) {
    return (
      <section className="catalog" aria-busy="true">
        <div className="catalog__header">
          <h2 className="catalog__title">Catalog</h2>
          <p className="catalog__meta">Loading products…</p>
        </div>
        <ul className="catalog__grid" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="catalog__skeleton" />
          ))}
        </ul>
      </section>
    );
  }

  if (error) {
    return (
      <section className="catalog">
        <div className="catalog__header">
          <h2 className="catalog__title">Catalog</h2>
        </div>
        <div className="catalog__error" role="alert">
          <p className="catalog__error-text">{error}</p>
          <button type="button" className="catalog__retry" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (products.length === 0) {
    return (
      <section className="catalog">
        <div className="catalog__header">
          <h2 className="catalog__title">Catalog</h2>
        </div>
        <div className="catalog__empty" role="status">
          <p className="catalog__empty-text">
            No products available right now. Please check back later.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="catalog">
      <div className="catalog__header">
        <h2 className="catalog__title">Catalog</h2>
        <p className="catalog__meta">{products.length} items available</p>
      </div>
      <ul className="catalog__grid">
        {products.map((product) => (
          <li key={product.id} className="catalog__grid-item">
            <ProductCard
              id={product.id}
              name={product.name}
              pricePaise={product.pricePaise}
              stockQuantity={product.stockQuantity}
              availableUnits={product.availableUnits}
              quantity={cart[product.id] ?? 0}
              onIncrement={() => onAdd(product.id)}
              onDecrement={() => onDecrement(product.id)}
              onRemove={() => onRemove(product.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
