import './load-env.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigError, loadConfig } from './config.js';
import { sendSignedEvent } from './webhook-sender.js';

/**
 * CLI for acceptance criterion C14:
 *
 *   npm run -w apps/api send-webhook -- --order-id <uuid> --amount <paise> \
 *       [--event-id <id>] [--status captured] [--url http://localhost:3001]
 *
 * Signs the payload with WEBHOOK_SECRET from the environment (never from
 * argv — command lines are visible in process listings) and prints the
 * API's REAL response: the HTTP status plus the response body verbatim.
 * The signature value itself is never printed.
 */

const USAGE = `Usage:
  npm run -w apps/api send-webhook -- --order-id <uuid> --amount <paise> [options]

Options:
  --order-id <uuid>   Order to pay (required)
  --amount <paise>    Integer amount in paise; must equal the order total
                      for the order to become paid (required)
  --event-id <id>    Provider event id (default: evt-cli-<random>)
  --status <status>  Provider status (default: captured)
  --url <origin>     API origin (default: http://localhost:<API_PORT>)
  --help              Show this help`;

const argvSchema = z.object({
  orderId: z.string().uuid('--order-id must be a valid UUID'),
  amountPaise: z
    .number()
    .int('--amount must be an integer number of paise')
    .min(0, '--amount must be >= 0'),
  eventId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  url: z.string().url('--url must be a valid http(s) origin').optional(),
});

type ParsedArgs = { ok: true; values: z.infer<typeof argvSchema> } | { ok: false; error: string };

/** Minimal, dependency-free flag parser: --key value pairs only. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      return { ok: false, error: USAGE };
    }
    if (token === undefined || !token.startsWith('--')) {
      return { ok: false, error: `Unexpected argument "${token ?? ''}"\n${USAGE}` };
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, error: `Missing value for --${key}\n${USAGE}` };
    }
    raw[key] = value;
    i += 1;
  }

  const known = new Set(['order-id', 'amount', 'event-id', 'status', 'url']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      return { ok: false, error: `Unknown option --${key}\n${USAGE}` };
    }
  }

  const amount = Number(raw.amount);
  const result = argvSchema.safeParse({
    orderId: raw['order-id'],
    amountPaise: amount,
    eventId: raw['event-id'],
    status: raw.status,
    url: raw.url,
  });
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('\n') };
  }
  return { ok: true, values: result.data };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(parsed.error === USAGE ? 0 : 1);
  }

  let secret: string;
  let apiPort: number;
  try {
    const config = loadConfig(process.env);
    secret = config.webhookSecret;
    apiPort = config.apiPort;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[send-webhook] refusing to run: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const values = parsed.values;
  const eventId = values.eventId ?? `evt-cli-${randomUUID()}`;
  const baseUrl = values.url ?? `http://localhost:${apiPort.toString()}`;

  void sendSignedEvent({
    baseUrl,
    secret,
    eventId,
    orderId: values.orderId,
    amountPaise: values.amountPaise,
    status: values.status,
  })
    .then((result) => {
      console.log(
        `POST ${baseUrl}/payments/webhook ` +
          `(eventId=${eventId}, orderId=${values.orderId}, amountPaise=${values.amountPaise})`,
      );
      console.log(`HTTP ${result.status}`);
      console.log(JSON.stringify(result.body, null, 2));
      // 2xx: the API acknowledged the delivery (paid / acknowledged outcome).
      process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[send-webhook] request failed: ${message}`);
      process.exit(1);
    });
}

main();
