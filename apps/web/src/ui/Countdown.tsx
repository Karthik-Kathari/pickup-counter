interface CountdownProps {
  value: number;
  label?: string;
  className?: string;
}

export default function Countdown({
  value,
  label = 'hold remaining',
  className = '',
}: CountdownProps) {
  const display = `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const nearZero = value > 0 && value <= 15;

  return (
    <div className={`countdown ${nearZero ? 'countdown--near-zero' : ''} ${className}`.trim()}>
      <span className="countdown__symbol" aria-hidden="true">
        {nearZero ? '●' : '○'}
      </span>
      <span className="countdown__display" aria-live="polite">
        {display}
      </span>
      <span className="countdown__label">{label}</span>
    </div>
  );
}
