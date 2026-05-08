/**
 * Component tests for the AI-agent first-class surface:
 * `kash explain`, `kash schema`, `kash docs`, `kash version`.
 *
 * These commands are pure (no SDK calls) so the harness doesn't mock
 * buildClient. Everything is exercised against captured stdout.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { explainCommand } from '../../src/commands/explain.js';
import { schemaCommand } from '../../src/commands/schema.js';
import { buildDocsCommand } from '../../src/commands/docs.js';
import { versionCommand } from '../../src/commands/version.js';
import { configureOutput } from '../../src/utils/output.js';
import { captureStreams, parseJsonStdout, runViaProgram, wrapInProgram } from './harness.js';

describe('kash explain', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('returns the catalog entry as JSON for a known code', async () => {
    const { program, leafName } = wrapInProgram(explainCommand);
    await runViaProgram(program, leafName, ['RATE_LIMITED'], ['--json']);

    const json = parseJsonStdout(capture) as {
      code: string;
      recoverable: boolean;
      actions: { type: string }[];
    };
    expect(json.code).toBe('RATE_LIMITED');
    expect(json.recoverable).toBe(true);
    expect(json.actions.some((a) => a.type === 'open_url')).toBe(true);
  });

  it('lists every code when called with no argument', async () => {
    const { program, leafName } = wrapInProgram(explainCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as { codes: { code: string }[] };
    const codes = json.codes.map((c) => c.code);
    expect(codes).toContain('AUTH_REQUIRED');
    expect(codes).toContain('RATE_LIMITED');
    expect(codes).toContain('UNEXPECTED');
  });

  it('rejects an unknown code with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(explainCommand);
    await expect(runViaProgram(program, leafName, ['NOPE_NOT_A_CODE'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('kash schema', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('emits a JSON Schema for CreateTradeBody (unwrapped, top-level)', async () => {
    const { program, leafName } = wrapInProgram(schemaCommand);
    await runViaProgram(program, leafName, ['CreateTradeBody'], ['--json']);

    // Schema is emitted unwrapped — top-level `type` and `properties`
    // (no `$ref`/`definitions` wrapper).
    const json = parseJsonStdout(capture) as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties)).toEqual(
      expect.arrayContaining(['marketId', 'outcomeIndex', 'amount', 'side'])
    );
  });

  it('emits the full catalog when called with no argument and --json', async () => {
    const { program, leafName } = wrapInProgram(schemaCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as { schemas: Record<string, unknown> };
    expect(Object.keys(json.schemas)).toEqual(
      expect.arrayContaining([
        // CLI-owned contracts must be present so agents can validate
        // every shape the CLI itself emits.
        'CliErrorEnvelope',
        'CliErrorAction',
        'CliConfigEnvelope',
        'VersionManifest',
        // SDK request/response shapes — agents need these to validate
        // every wire payload, including the high-value 202 + webhook
        // routes which were missing in the first audit pass.
        'CreateTradeBody',
        'CreateTradeAcceptedResponse',
        'ConfirmTradeBody',
        'ConfirmTradeResponse',
        'TradeResource',
        'MarketResource',
        'PortfolioSummary',
        'RotateWebhookSecretResponse',
        'RedeliverWebhookResponse',
      ])
    );
  });

  it('CliErrorEnvelope schema round-trips: real envelopes validate against the published schema', async () => {
    // Fetch the JSON Schema as `kash schema CliErrorEnvelope --json`
    // would emit it, then verify a real CliError envelope conforms.
    // This catches drift in either direction: schema changes that
    // don't track the runtime, or runtime changes that don't track
    // the schema.
    const { program, leafName } = wrapInProgram(schemaCommand);
    await runViaProgram(program, leafName, ['CliErrorEnvelope'], ['--json']);

    const jsonSchema = parseJsonStdout(capture) as Record<string, unknown>;
    expect(jsonSchema['type']).toBe('object');
    const properties = jsonSchema['properties'] as Record<string, unknown>;
    const errorProps = (properties['error'] as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(errorProps)).toEqual(
      expect.arrayContaining(['code', 'message', 'recoverable', 'actions'])
    );

    // And a runtime envelope from a CliError validates against the
    // published Zod schema (the same schema used to derive the JSON
    // Schema above), so all three artefacts agree.
    const { CliErrorEnvelopeSchema } = await import('../../src/cli-schemas.js');
    const { CliError } = await import('../../src/errors.js');
    const envelope = new CliError('boom', { code: 'NOT_FOUND' }).toEnvelope();
    const result = CliErrorEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(envelope);
  });

  it('rejects an unknown name with INVALID_INPUT', async () => {
    const { program, leafName } = wrapInProgram(schemaCommand);
    await expect(runViaProgram(program, leafName, ['NopeSchema'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('kash docs', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('emits the full command tree as JSON', async () => {
    // Build a minimal program tree the docs command can introspect.
    // We use the same pattern the real binary uses: pass a getter that
    // returns the in-progress program.
    const { program, leafName } = (() => {
      // Build a stub root program with one leaf to keep the tree small.
      const docs = buildDocsCommand(() => program);
      const wrapper = wrapInProgram(docs);
      return wrapper;
    })();

    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as {
      name: string;
      subcommands: { name: string }[];
    };
    expect(json.name).toBe('kash');
    // The leaf we registered should be in the tree.
    expect(json.subcommands.some((s) => s.name === 'docs')).toBe(true);
  });
});

describe('kash version', () => {
  let teardown: () => void;
  let capture: { stdout: string; stderr: string };

  beforeEach(() => {
    const c = captureStreams();
    teardown = c.restore;
    capture = c.capture;
    configureOutput({ quiet: false, noColor: true });
  });
  afterEach(() => teardown());

  it('emits a manifest containing cli/sdk/node/platform fields in --json mode', async () => {
    const { program, leafName } = wrapInProgram(versionCommand);
    await runViaProgram(program, leafName, [], ['--json']);

    const json = parseJsonStdout(capture) as Record<string, string>;
    expect(json['cli']).toMatch(/^\d+\.\d+\.\d+/);
    expect(json['sdk']).toMatch(/^\d+\.\d+\.\d+/);
    expect(json['node']).toMatch(/^v\d+/);
    expect(json['platform']).toBeTypeOf('string');
    expect(json['arch']).toBeTypeOf('string');
  });

  it('renders a human summary by default', async () => {
    const { program, leafName } = wrapInProgram(versionCommand);
    await runViaProgram(program, leafName, []);
    expect(capture.stdout).toContain('@kashdao/cli');
    expect(capture.stdout).toContain('@kashdao/sdk');
  });
});
