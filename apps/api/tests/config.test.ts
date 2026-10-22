import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * Unit tests for environment validation (no database required).
 * Values that may contain secrets are never echoed into error messages —
 * these tests assert that property directly.
 */

describe('loadConfig', () => {
  it('applies safe local defaults in development', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.apiPort).toBe(3001);
    expect(config.holdTtlSeconds).toBe(120);
    expect(config.databaseUrl).toMatch(/^postgres/);
    expect(config.webhookSecret.length).toBeGreaterThan(0);
    expect(config.testDatabaseUrl).toBeUndefined();
  });

  it('parses valid explicit values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pw@dbhost:5433/some_db',
      TEST_DATABASE_URL: 'postgres://user:pw@dbhost:5433/some_test_db',
      API_PORT: '8080',
      HOLD_TTL_SECONDS: '60',
      WEBHOOK_SECRET: 'a-sufficiently-long-shared-secret',
    });
    expect(config.nodeEnv).toBe('test');
    expect(config.apiPort).toBe(8080);
    expect(config.holdTtlSeconds).toBe(60);
    expect(config.testDatabaseUrl).toBe('postgres://user:pw@dbhost:5433/some_test_db');
  });

  it('requires DATABASE_URL explicitly in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', WEBHOOK_SECRET: 'x'.repeat(40) }),
    ).toThrowError(/DATABASE_URL is required/);
  });

  it('requires WEBHOOK_SECRET explicitly in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h:5432/db' }),
    ).toThrowError(/WEBHOOK_SECRET is required/);
  });

  it('rejects the development placeholder secret in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        WEBHOOK_SECRET: 'change-me-local-dev-secret',
      }),
    ).toThrowError(/must not be the development placeholder/);
  });

  it('rejects a short secret in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        WEBHOOK_SECRET: 'shortsecret',
      }),
    ).toThrowError(/at least 16 characters/);
  });

  it('rejects malformed database URLs without echoing them (no password leak)', () => {
    const leaky = 'postgres://user:super-secret-password@';
    let caught: ConfigError | undefined;
    try {
      loadConfig({ DATABASE_URL: leaky });
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.message).not.toContain('super-secret-password');
    expect(caught!.message).toMatch(/DATABASE_URL must be a valid postgres/);
  });

  it('rejects non-postgres protocols', () => {
    expect(() => loadConfig({ DATABASE_URL: 'http://localhost:5432/db' })).toThrowError(
      /DATABASE_URL must be a valid postgres/,
    );
  });

  it('rejects invalid ports and TTLs', () => {
    expect(() => loadConfig({ API_PORT: '70000' })).toThrowError(/API_PORT must be an integer/);
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrowError(/API_PORT must be an integer/);
    expect(() => loadConfig({ HOLD_TTL_SECONDS: '0' })).toThrowError(
      /HOLD_TTL_SECONDS must be an integer/,
    );
    expect(() => loadConfig({ HOLD_TTL_SECONDS: '999999' })).toThrowError(
      /HOLD_TTL_SECONDS must be an integer/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrowError(/NODE_ENV must be one of/);
  });

  it('never defaults TEST_DATABASE_URL to the development database', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/dev_db' });
    expect(config.testDatabaseUrl).toBeUndefined();
    expect(config.databaseUrl).toBe('postgres://u:p@h:5432/dev_db');
  });

  it('rejects a malformed TEST_DATABASE_URL', () => {
    expect(() => loadConfig({ TEST_DATABASE_URL: 'not-a-url' })).toThrowError(
      /TEST_DATABASE_URL must be a valid postgres/,
    );
  });

  it('collects multiple issues in a single failure', () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({ NODE_ENV: 'production', API_PORT: '0', HOLD_TTL_SECONDS: '-1' });
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.issues.length).toBeGreaterThanOrEqual(3);
  });
});
