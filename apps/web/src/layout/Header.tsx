interface HeaderProps {
  brand: string;
  tagline: string;
  cartCount: number;
}

export default function Header({ brand, tagline, cartCount }: HeaderProps) {
  return (
    <header className="site-header">
      <div className="site-header__brand">
        <h1 className="site-header__title">{brand}</h1>
        <p className="site-header__tagline">{tagline}</p>
      </div>
      {cartCount > 0 ? (
        <span className="site-header__cart-badge" aria-live="polite" aria-atomic="true">
          {cartCount} in cart
        </span>
      ) : null}
    </header>
  );
}
