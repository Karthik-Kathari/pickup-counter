import { useState } from 'react';

interface WebhookPanelProps {
  orderId: string;
  amountPaise: number;
  className?: string;
}

export default function WebhookPanel({ orderId, amountPaise, className = '' }: WebhookPanelProps) {
  const [copied, setCopied] = useState(false);

  const command = `npm run -w apps/api send-webhook -- --order-id ${orderId} --amount ${amountPaise}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard unavailable; no error shown to the user.
    }
  };

  return (
    <div className={`webhook-panel ${className}`.trim()}>
      <h3 className="webhook-panel__title">How to pay (demo)</h3>
      <p className="webhook-panel__intro">
        The payment provider confirms payment with an HMAC-signed webhook. Trigger it from the
        repository root with:
      </p>
      <div className="webhook-panel__block">
        <pre className="webhook-panel__code">
          <code>{command}</code>
        </pre>
        <div className="webhook-panel__code-actions">
          <button
            type="button"
            className="webhook-panel__copy"
            onClick={handleCopy}
            aria-label="Copy payment command"
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </div>
      </div>
      <p className="webhook-panel__note">
        The amount must equal the order total exactly; a mismatch or a late payment sends the order
        to manual review, never straight to paid.
      </p>
    </div>
  );
}
