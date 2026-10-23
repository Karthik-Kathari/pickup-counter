import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

export default function Card({ children, className = '', padded = true }: CardProps) {
  const classBase = ['card', padded ? 'card--padded' : '', className.trim()]
    .filter(Boolean)
    .join(' ');

  return <div className={classBase}>{children}</div>;
}

export function CardHeader({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card__header ${className}`.trim()}>{children}</div>;
}

export function CardTitle({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <h2 className={`card__title ${className}`.trim()}>{children}</h2>;
}

export function CardSection({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card__section ${className}`.trim()}>{children}</div>;
}
