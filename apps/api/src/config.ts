/**
 * Validated environment configuration (zod-backed).
 *
 * `loadConfig` is a pure function of an environment record so it can be unit
 * tested without touching `process.env`. Validation fails fast (the server
 * exits with a clear message) and never echoes values back, because values may
 * contain secrets (e.g. the password inside DATABASE_URL, WEBHOOK_SECRET).
 *
 * Defaults mirror `.env.example` and are safe for local development only.
 * Production requires DATABASE_URL and WEBHOOK_SECRET to be supplied
 * explicitly; the dev placeholder secret is rejected outright.
 */

import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  /** Optional: integration tests refuse to run without it (never defaulted to the dev DB). */
  testDatabaseUrl: string | undefined;
  apiPort: number;
  holdTtlSeconds: number;
  webhookSecret: string;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid configuration — ${issues.join(' | ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Local-development defaults; identical to `.env.example`. */
const DEV_DEFAULTS = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/pickup_counter',
  API_PORT: '3001',
  HOLD_TTL_SECONDS: '120',
  WEBHOOK_SECRET: 'change-me-local-dev-secret',
} as const;

const DEV_PLACEHOLDER_SECRET = DEV_DEFAULTS.WEBHOOK_SECRET;
const NODE_ENVS = ['development', 'test', 'production'] as const;
const HOLD_TTL_MAX_SECONDS = 86_400;

const ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'API_PORT',
  'HOLD_TTL_SECONDS',
  'WEBHOOK_SECRET',
] as const;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const protocolOk = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    const hostOk = url.hostname.length > 0;
    const databaseOk = url.pathname.trim().length > 1;
    return protocolOk && hostOk && databaseOk;
  } catch {
    return false;
  }
}

/**
 * String-typed integer with bounds. Custom messages state the expectation and
 * deliberately never echo the offending value.
 */
function integerField(name: string, fallback: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? String(fallback) : raw))
    .superRefine((raw, ctx) => {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be an integer between ${min} and ${max} (value not shown)`,
        });
      }
    })
    .transform((raw) => Number(raw));
}

function addIssue(issues: string[], message: string): void {
  issues.push(message);
}

/**
 * Cross-field policy checks. These run on the raw source regardless of
 * field-level parse success, so a single failure reports EVERY problem
 * (zod v3 skips outer refinements once a nested field fails).
 */
function collectPolicyIssues(source: Record<string, string | undefined>, issues: string[]): void {
  const production = source.NODE_ENV === 'production';

  // DATABASE_URL: required in production; must look like a postgres URL.
  // The message never includes the value — it can contain a password.
  const databaseUrl = source.DATABASE_URL;
  if (production && (databaseUrl === undefined || databaseUrl.trim() === '')) {
    addIssue(issues, 'DATABASE_URL is required when NODE_ENV=production');
  } else if (
    databaseUrl !== undefined &&
    databaseUrl.trim() !== '' &&
    !isPostgresUrl(databaseUrl)
  ) {
    addIssue(issues, 'DATABASE_URL must be a valid postgres:// or postgresql:// connection string');
  }

  // TEST_DATABASE_URL: optional, but if present it must be valid. It is
  // never defaulted to the development database — tests must be explicit.
  const testDatabaseUrl = source.TEST_DATABASE_URL;
  if (
    testDatabaseUrl !== undefined &&
    testDatabaseUrl.trim() !== '' &&
    !isPostgresUrl(testDatabaseUrl)
  ) {
    addIssue(
      issues,
      'TEST_DATABASE_URL must be a valid postgres:// or postgresql:// connection string',
    );
  }

  // WEBHOOK_SECRET: required in production; the dev placeholder is banned there.
  const webhookSecret = source.WEBHOOK_SECRET;
  if (production && (webhookSecret === undefined || webhookSecret.trim() === '')) {
    addIssue(issues, 'WEBHOOK_SECRET is required when NODE_ENV=production');
  } else if (webhookSecret !== undefined && webhookSecret.trim() !== '') {
    if (production && webhookSecret === DEV_PLACEHOLDER_SECRET) {
      addIssue(
        issues,
        'WEBHOOK_SECRET must not be the development placeholder when NODE_ENV=production',
      );
    }
    if (production && webhookSecret.length < 16) {
      addIssue(issues, 'WEBHOOK_SECRET must be at least 16 characters when NODE_ENV=production');
    }
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS, {
    errorMap: () => ({ message: 'NODE_ENV must be one of: development, test, production' }),
  }),
  DATABASE_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),
  API_PORT: integerField('API_PORT', 3001, 1, 65_535),
  HOLD_TTL_SECONDS: integerField('HOLD_TTL_SECONDS', 120, 1, HOLD_TTL_MAX_SECONDS),
  WEBHOOK_SECRET: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Copy only the keys we know about; apply dev defaults for missing/empty
  // values outside production (production must be explicit).
  const production = env.NODE_ENV === 'production';
  const source: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      source[key] = value;
    }
  }
  if (!production) {
    source.DATABASE_URL ??= DEV_DEFAULTS.DATABASE_URL;
    source.API_PORT ??= DEV_DEFAULTS.API_PORT;
    source.HOLD_TTL_SECONDS ??= DEV_DEFAULTS.HOLD_TTL_SECONDS;
    source.WEBHOOK_SECRET ??= DEV_DEFAULTS.WEBHOOK_SECRET;
  }
  source.NODE_ENV ??= 'development';

  const result = envSchema.safeParse(source);
  const issues: string[] = result.success ? [] : result.error.issues.map((issue) => issue.message);
  collectPolicyIssues(source, issues);
  if (issues.length > 0) {
    throw new ConfigError([...new Set(issues)]);
  }

  const data = result.success ? result.data : undefined;
  if (data === undefined) {
    // Unreachable: any parse failure produces at least one issue above.
    throw new ConfigError(['configuration could not be parsed']);
  }
  return {
    nodeEnv: data.NODE_ENV,
    databaseUrl: data.DATABASE_URL ?? DEV_DEFAULTS.DATABASE_URL,
    testDatabaseUrl:
      data.TEST_DATABASE_URL !== undefined && data.TEST_DATABASE_URL.trim() !== ''
        ? data.TEST_DATABASE_URL
        : undefined,
    apiPort: data.API_PORT,
    holdTtlSeconds: data.HOLD_TTL_SECONDS,
    webhookSecret: data.WEBHOOK_SECRET ?? DEV_DEFAULTS.WEBHOOK_SECRET,
  };
}
