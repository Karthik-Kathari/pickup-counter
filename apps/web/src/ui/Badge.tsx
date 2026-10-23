import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'accent' | 'success' | 'warning' | 'error' | 'info';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  mono?: boolean;
  className?: string;
}

export default function Badge({
  children,
  variant = 'default',
  size = 'md',
  icon,
  mono = false,
  className = '',
}: BadgeProps) {
  const classBase = [
    'badge',
    `badge--${variant}`,
    `badge--${size}`,
    mono ? 'badge--mono' : '',
    className.trim(),
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classBase}>
      {icon && (
        <span className="badge__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="badge__label">{children}</span>
    </span>
  );
}
