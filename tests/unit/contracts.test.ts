/**
 * Contract regression tests.
 *
 * These tests are gatekeepers for the SemVer-stable contracts the CLI
 * exposes — the error envelope, the version manifest, the config
 * envelope, and the command tree. They fail loudly when the runtime
 * shape drifts from the published Zod schemas, so a contract change
 * always requires a deliberate update to both the schema and the
 * tests.
 */

import { describe, expect, it } from 'vitest';

import {
  CliConfigEnvelopeSchema,
  CliErrorEnvelopeSchema,
  VersionManifestSchema,
} from '../../src/cli-schemas.js';
import { buildVersionManifest } from '../../src/commands/version.js';
import { ERROR_CATALOG, ERROR_CODES } from '../../src/error-catalog.js';
import { CliError, CliValidationError } from '../../src/errors.js';

/**
 * Strict assertion helper: validates that `value` matches the schema
 * AND that the parsed result equals the input (no silent field drop).
 *
 * `safeParse({}).success === true` would pass for a permissive
 * `z.unknown()` schema; pinning the parsed value catches that
 * regression. Use this everywhere the contract is the *exact* shape.
 */
function assertSchemaMatch<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: T
): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(value);
}

describe('contract: CliErrorEnvelope', () => {
  it('a baseline CliError serialises to a value matching the published schema', () => {
    const err = new CliError('boom', { code: 'NOT_FOUND' });
    assertSchemaMatch(CliErrorEnvelopeSchema, err.toEnvelope());
  });

  it('a CliError with every optional field set still validates', () => {
    const err = new CliError('rate limited', {
      code: 'RATE_LIMITED',
      suggestion: 'wait',
      retryAfterMs: 30_000,
      docsUrl: 'https://kash.bot/docs/api/rate-limits',
      requestId: 'req_abc',
      actions: [
        {
          type: 'wait_and_retry',
          delayMs: 30_000,
          description: 'Wait 30s.',
        },
      ],
    });
    assertSchemaMatch(CliErrorEnvelopeSchema, err.toEnvelope());
  });

  it('CliValidationError envelopes also match the schema', () => {
    const err = new CliValidationError('bad amount', 'try a positive number', 'amount');
    assertSchemaMatch(CliErrorEnvelopeSchema, err.toEnvelope());
  });
});

describe('contract: VersionManifest', () => {
  it('buildVersionManifest matches the published schema', () => {
    assertSchemaMatch(VersionManifestSchema, buildVersionManifest());
  });
});

describe('contract: CliConfigEnvelope', () => {
  it('a typical config envelope matches the published schema', () => {
    // Hand-rolled to match what `kash config show --json` and
    // `kash auth status --json` actually emit. The component tests
    // exercise the real commands; this test pins the shape itself.
    // Direct-mode fields are always present (`null` when unset) so
    // the shape stays uniform across pure-custodial and direct-mode
    // profiles — agents pin one schema, no optionality branches.
    const envelope = {
      profile: 'default',
      authenticated: true,
      apiKey: 'kash_liv...abcd',
      baseUrl: 'https://api.kash.bot/v1',
      defaultChainId: 8453,
      rpcUrl: null,
      smartAccount: null,
      bundlerUrl: null,
      bundlerProvider: null,
      signerKeyRef: null,
      sources: {
        apiKey: 'file' as const,
        baseUrl: 'default' as const,
        defaultChainId: 'default' as const,
        profile: 'default' as const,
        rpcUrl: 'unset' as const,
        smartAccount: 'unset' as const,
        bundlerUrl: 'unset' as const,
        bundlerProvider: 'unset' as const,
        signerKeyRef: 'unset' as const,
      },
    };
    assertSchemaMatch(CliConfigEnvelopeSchema, envelope);
  });

  it('apiKey may be null when unauthenticated', () => {
    const envelope = {
      profile: 'default',
      authenticated: false,
      apiKey: null,
      baseUrl: 'https://api.kash.bot/v1',
      defaultChainId: 8453,
      rpcUrl: null,
      smartAccount: null,
      bundlerUrl: null,
      bundlerProvider: null,
      signerKeyRef: null,
      sources: {
        apiKey: 'unset' as const,
        baseUrl: 'default' as const,
        defaultChainId: 'default' as const,
        profile: 'default' as const,
        rpcUrl: 'unset' as const,
        smartAccount: 'unset' as const,
        bundlerUrl: 'unset' as const,
        bundlerProvider: 'unset' as const,
        signerKeyRef: 'unset' as const,
      },
    };
    assertSchemaMatch(CliConfigEnvelopeSchema, envelope);
  });

  it('a fully-populated direct-mode profile matches the schema', () => {
    // Pin: every direct-mode field carries a real value, sources track
    // file-vs-env attribution.
    const envelope = {
      profile: 'staging',
      authenticated: true,
      apiKey: 'kash_test...abcd',
      baseUrl: 'https://api.kash.bot/v1',
      defaultChainId: 8453,
      rpcUrl: 'https://rpc.example.com',
      smartAccount: '0xfedcba0987654321fedcba0987654321fedcba09',
      bundlerUrl: 'https://bundler.example.com',
      bundlerProvider: 'flashbots' as const,
      signerKeyRef: 'env:STAGING_SIGNER_KEY',
      sources: {
        apiKey: 'file' as const,
        baseUrl: 'default' as const,
        defaultChainId: 'default' as const,
        profile: 'flag' as const,
        rpcUrl: 'file' as const,
        smartAccount: 'file' as const,
        bundlerUrl: 'file' as const,
        bundlerProvider: 'file' as const,
        signerKeyRef: 'env' as const,
      },
    };
    assertSchemaMatch(CliConfigEnvelopeSchema, envelope);
  });
});

describe('contract: ERROR_CATALOG ⊆ codes producible by toCliError', () => {
  it('every catalog code appears in the runtime registry (no orphan entries)', () => {
    // Sanity: ERROR_CODES should be derived from ERROR_CATALOG and
    // therefore identical. Pinning this prevents accidental
    // duplicate entries (which would silently shadow each other in
    // the Map).
    expect(ERROR_CODES.size).toBe(ERROR_CATALOG.length);
    for (const entry of ERROR_CATALOG) {
      expect(ERROR_CODES.has(entry.code)).toBe(true);
    }
  });

  it('every catalog action validates against CliErrorAction discriminated union', async () => {
    // If anyone adds an entry with a typo'd `type`, the union would
    // reject it. Catches drift as the catalog grows.
    const { CliErrorActionSchema } = await import('../../src/cli-schemas.js');
    for (const entry of ERROR_CATALOG) {
      for (const action of entry.actions) {
        const result = CliErrorActionSchema.safeParse(action);
        expect(result.success).toBe(true);
      }
    }
  });

  it('every run_command action with <placeholder> tokens carries template:true', () => {
    // Agents that auto-execute `run_command` actions look at
    // `template`. A literal `<id>` reaching the shell would fail.
    // This contract test ensures the catalog never re-introduces a
    // templated command without the flag.
    const PLACEHOLDER_RE = /<[^>]+>/;
    for (const entry of ERROR_CATALOG) {
      for (const action of entry.actions) {
        if (action.type !== 'run_command') continue;
        const looksTemplated = PLACEHOLDER_RE.test(action.command);
        if (looksTemplated) {
          expect(
            action.template,
            `${entry.code}: command "${action.command}" looks templated but template flag is missing`
          ).toBe(true);
        } else {
          // Concrete commands must NOT carry the flag — otherwise
          // agents skip safe-to-run actions thinking they need
          // substitution.
          expect(
            action.template ?? false,
            `${entry.code}: command "${action.command}" is concrete but template flag is set`
          ).toBe(false);
        }
      }
    }
  });
});
