import type { ReactNode } from 'react';
import Badge from './Badge';

type StatusVariant = 'pending' | 'paid' | 'picked_up' | 'expired' | 'review' | 'error' | 'info';

interface StatusBannerProps {
  variant: StatusVariant;
  children: ReactNode;
  code?: string;
  title?: string;
  action?: ReactNode;
  className?: string;
}

// A text marker paired with each variant so state is never conveyed by colour
// alone (WCAG 1.4.1). Kept as plain glyphs so no icon dependency is added.
const VARIANT_GLYPH: Record<StatusVariant, string> = {
  pending: '◷',
  paid: '✓',
  picked_up: '✓',
  expired: '!',
  review: '!',
  error: '✕',
  info: 'i',
};

export default function StatusBanner({
  variant,
  children,
  code,
  title,
  action,
  className = '',
}: StatusBannerProps) {
  const classBase = `status-banner status-banner--${variant} ${className.trim()}`.trim();
  const isAlert = variant === 'error';

  return (
    <div className={classBase} role={isAlert ? 'alert' : 'status'}>
      <span className="status-banner__glyph" aria-hidden="true">
        {VARIANT_GLYPH[variant]}
      </span>
      <div className="status-banner__content">
        <div className="status-banner__body">
          {title ? <span className="status-banner__title">{title}</span> : null}
          <span className="status-banner__message">{children}</span>
          {code ? (
            <Badge variant="default" size="sm" mono>
              {code}
            </Badge>
          ) : null}
        </div>
        {action ? <div className="status-banner__action">{action}</div> : null}
      </div>
    </div>
  );
}
