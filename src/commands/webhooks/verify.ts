/**
 * `kash webhooks verify` — offline HMAC-SHA256 signature verification.
 *
 * Wraps the SDK's `webhooks.verifySignature` so an operator
 * debugging webhook delivery can ad-hoc verify a captured payload
 * against the signing secret. Useful when:
 *
 *   - A webhook receiver rejected an event and the operator wants to
 *     confirm whether the signature was actually valid.
 *   - An agent pipes a captured webhook through `kash webhooks
 *     verify --quiet --json` to check authenticity before acting.
 *
 * Reads the body from `--body-file <path>` (recommended — preserves
 * exact bytes) or `--body <string>` (convenient for short payloads).
 * Reads the secret from `--secret <value>`, `--secret-file <path>`,
 * or `KASH_WEBHOOK_SECRET` env. The signature comes from the captured
 * `X-Kash-Signature` header value.
 */

import { readFile } from 'node:fs/promises';

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

type VerifyOptions = {
  signature: string;
  body?: string;
  bodyFile?: string;
  secret?: string;
  secretFile?: string;
  toleranceMs?: string;
};

export const verifyWebhookCommand = new Command('verify')
  .description('Verify a captured X-Kash-Signature against the raw body and secret.')
  .requiredOption('-s, --signature <header>', 'the X-Kash-Signature header value (e.g. "t=…,v1=…")')
  .option('--body <string>', 'raw request body as a string (use --body-file for binary-safe input)')
  .option('--body-file <path>', 'path to a file containing the raw request body')
  .option('--secret <value>', 'webhook signing secret (overrides KASH_WEBHOOK_SECRET)')
  .option(
    '--secret-file <path>',
    'read secret from a file (preferred over --secret on shared shells)'
  )
  .option(
    '--tolerance-ms <n>',
    'replay-window tolerance in milliseconds (default 300000 = 5 minutes)'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ kash webhooks verify --signature "t=…,v1=…" --body-file event.json
  $ kash webhooks verify -s "$SIG" --body "$BODY" --secret-file ~/.kash/webhook.secret --json
`
  )
  .action(async (options: VerifyOptions, cmd: Command) => {
    const globals = readGlobals(cmd);

    if (options.body !== undefined && options.bodyFile !== undefined) {
      throw new CliValidationError('Pass exactly one of --body or --body-file.', undefined, 'body');
    }
    if (options.body === undefined && options.bodyFile === undefined) {
      throw new CliValidationError('--body or --body-file is required.', undefined, 'body');
    }
    if (options.secret !== undefined && options.secretFile !== undefined) {
      throw new CliValidationError(
        'Pass at most one of --secret or --secret-file.',
        undefined,
        'secret'
      );
    }

    const body =
      options.body !== undefined
        ? options.body
        : await readFileChecked(options.bodyFile!, 'body-file');
    const secret = await resolveSecret(options);
    const toleranceMs =
      options.toleranceMs === undefined
        ? undefined
        : parsePositiveInt(options.toleranceMs, 'tolerance-ms');

    let result;
    try {
      const { client } = await buildClient({ globals });
      result = await client.webhooks.verifySignature(body, options.signature, secret, {
        ...(toleranceMs === undefined ? {} : { toleranceMs }),
      });
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(result);
      return;
    }
    if (result.valid) {
      print(`${style.success('✓')} Signature is valid.`);
    } else {
      log.error(`Signature is INVALID: ${result.reason}`);
    }
  });

async function readFileChecked(path: string, flag: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new CliValidationError(
      `Failed to read ${flag} ${path}: ${(cause as Error).message}`,
      'Verify the path exists and is readable.',
      flag
    );
  }
}

async function resolveSecret(options: VerifyOptions): Promise<string> {
  if (options.secret !== undefined) return options.secret;
  if (options.secretFile !== undefined) {
    const raw = await readFileChecked(options.secretFile, 'secret-file');
    // Strip a trailing newline that text editors append; secrets
    // never include leading/trailing whitespace.
    return raw.trim();
  }
  const fromEnv = process.env['KASH_WEBHOOK_SECRET'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  throw new CliValidationError(
    'Webhook secret not provided.',
    'Pass --secret-file (preferred), --secret, or set KASH_WEBHOOK_SECRET.',
    'secret'
  );
}
