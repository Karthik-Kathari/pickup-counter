import { createHmac } from 'node:crypto';

/**
 * Signed webhook delivery (acceptance criterion C14).
 *
 * This is the demo stand-in for the payment provider: it builds the exact
 * JSON payload, computes X-Signature = HMAC-SHA256(secret, rawBody) over the
 * EXACT bytes on the wire (I8 — the signature covers the string we send, not
 * a re-serialization), and POSTs it to /payments/webhook, returning the
 * API's real HTTP status and parsed response body.
 *
 * The secret is only ever passed in as a value by the caller (the CLI reads
 * it from the validated environment; tests inject their fixture). It is
 * never logged, echoed, or included in the result.
 */

export interface SendSignedEventInput {
  /** API origin, e.g. http://localhost:3001 (no trailing slash needed). */
  baseUrl: string;
  /** Shared WEBHOOK_SECRET used by both sides. */
  secret: string;
  eventId: string;
  orderId: string;
  amountPaise: number;
  /** Provider status; the API supports 'captured'. Defaults to 'captured'. */
  status?: string;
}

export interface SendSignedEventResult {
  /** HTTP status actually returned by the API. */
  status: number;
  /** Parsed JSON response body (or the raw text if it was not JSON). */
  body: unknown;
}

export async function sendSignedEvent(input: SendSignedEventInput): Promise<SendSignedEventResult> {
  const payload = {
    eventId: input.eventId,
    orderId: input.orderId,
    amountPaise: input.amountPaise,
    status: input.status ?? 'captured',
  };
  // Stringify once: these exact bytes are both signed and transmitted.
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', input.secret).update(rawBody).digest('hex');

  const url = `${input.baseUrl.replace(/\/+$/, '')}/payments/webhook`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body: rawBody,
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Keep the raw text when the response is not JSON.
  }
  return { status: response.status, body };
}
