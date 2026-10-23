import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      iconPosition = 'start',
      fullWidth = false,
      className = '',
      disabled,
      children,
      ...rest
    },
    ref,
  ) => {
    const classBase = [
      'btn',
      `btn--${variant}`,
      `btn--${size}`,
      fullWidth ? 'btn--full' : '',
      loading ? 'btn--loading' : '',
      className.trim(),
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        className={classBase}
        disabled={disabled || loading}
        aria-busy={loading}
        {...rest}
      >
        <span className="btn__content">
          {loading && <span className="btn__spinner" aria-hidden="true" />}
          {icon && iconPosition === 'start' && (
            <span className="btn__icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {children != null && <span className="btn__label">{children}</span>}
          {icon && iconPosition === 'end' && (
            <span className="btn__icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {loading && !children && (
            <span className="btn__label" aria-hidden="true">
              Processing…
            </span>
          )}{' '}
        </span>
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
