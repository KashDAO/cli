/**
 * `kash webhooks replay <body-file> --target <url> --secret <s>` —
 * sign a captured webhook payload with a local secret and POST it to
 * a target URL. Pairs with `kash webhooks verify` for round-trip
 * testing against a development tunnel (ngrok, cloudflared) or a
 * local server.
 *
 * **Why a built-in.** The signing format is `t=<unix-ms>,v1=<hex>`
 * (Stripe-compatible). Replicating the HMAC + header construction in
 * shell + jq is tedious and error-prone; this command does it
 * deterministically.
 *
 * **Privacy.** The body is read verbatim and forwarded — `kash
 * webhooks replay` is intentionally a thin wrapper over
 * `fetch(target)`, NOT an event reformatter. If your captured payload
 * contains PII, redact it locally before passing it in.
 *
 * **Custom timestamp.** Defaults to `Date.now()`. Pass `--timestamp-ms`
 * to replay an old payload — useful for testing the receiver's
 * replay-window enforcement (e.g. "does my server reject deliveries
 * older than 5 minutes?").
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Command } from 'commander';

import { CliError, CliValidationError, toCliError } from '../../errors.js';
import { parsePositiveInt, readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

type ReplayOptions = {
  target: string;
  secret?: string;
  secretFile?: string;
  secretEnv?: string;
  timestampMs?: string;
  signatureHeader?: string;
  timeoutMs?: string;
  dryRun?: boolean;
  refusePrivateAddresses?: boolean;
};

const SIGNATURE_HEADER_DEFAULT = 'X-Kash-Signature';

export const replayWebhookCommand = new Command('replay')
  .description('Re-sign a captured webhook payload and POST it to a target URL.')
  .argument('[body]', 'path to a JSON body file (omit or pass "-" for stdin)')
  .requiredOption('-t, --target <url>', 'destination URL (e.g. ngrok tunnel or localhost endpoint)')
  .option('-s, --secret <secret>', 'webhook signing secret (overrides KASH_WEBHOOK_SECRET)')
  .option(
    '--secret-file <path>',
    'read the signing secret from a file (preferred — keeps the value out of argv and env)'
  )
  .option(
    '--secret-env <name>',
    'read the signing secret from this environment variable (default: KASH_WEBHOOK_SECRET)'
  )
  .option(
    '--timestamp-ms <ms>',
    'unix-ms timestamp for the signature header (default: current time)'
  )
  .option(
    '--signature-header <name>',
    `override the signature header name (default: ${SIGNATURE_HEADER_DEFAULT})`
  )
  .option('--timeout-ms <ms>', 'fetch timeout (default 10000)')
  .option(
    '--dry-run',
    'compute the signature header and inspect the would-be POST without sending it'
  )
  .option(
    '--refuse-private-addresses',
    'hard-fail (instead of warning) when --target is a loopback / private / link-local address — recommended for CI'
  )
  .addHelpText(
    'after',
    `
Examples:
  # Auto-reads KASH_WEBHOOK_SECRET (matches \`kash webhooks verify\`).
  $ KASH_WEBHOOK_SECRET=whsec_… kash webhooks replay payload.json -t http://localhost:3000/webhook

  # Explicit secret file (preferred — keeps the value out of argv/env).
  $ kash webhooks replay payload.json -t http://localhost:3000/webhook --secret-file ~/.kash/webhook.secret

  # Pipe captured payload from stdin.
  $ cat payload.json | kash webhooks replay - -t … -s whsec_…

  # CI guardrails: refuse private targets + inspect the signed bytes
  # before sending.
  $ kash webhooks replay payload.json -t https://api.example.com --secret-file s.txt --refuse-private-addresses
  $ kash webhooks replay payload.json -t https://api.example.com --secret-file s.txt --dry-run --json

Notes:
  - The signature format is \`t=<unix-ms>,v1=<hex-hmac-sha256>\` —
    Stripe-compatible. The receiver verifies via \`kash webhooks verify\`
    or the SDK's \`webhooks.verifySignature\`.
  - Defaults the timestamp to \`Date.now()\`. Pass \`--timestamp-ms\`
    with an old timestamp to test the receiver's replay-window
    rejection (the SDK's default is 5 min).
  - Secret resolution order: --secret > --secret-file > --secret-env
    > KASH_WEBHOOK_SECRET. --secret-file is preferred — it keeps the
    value out of argv (where \`ps\` could see it) and out of env (where
    a child process would inherit it).
  - --dry-run is safe to run anywhere — it never opens a network
    socket. Use it to inspect the signature header before pointing
    a fresh receiver at production traffic.
`
  )
  .action(async (body: string | undefined, options: ReplayOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    try {
      // Resolve secret: --secret > --secret-file > --secret-env > KASH_WEBHOOK_SECRET.
      // Refuse if all are missing/empty.
      const secret = await resolveSecret(options);

      // Resolve target (URL validation + private-address policy). The
      // policy is hard-refuse when --refuse-private-addresses is set
      // (recommended for CI), otherwise warn-only (the historical
      // default — needed for local-tunnel testing).
      const targetUrl = validateTarget(options.target, {
        refusePrivate: options.refusePrivateAddresses === true,
      });

      // Read the body verbatim. We sign whatever bytes the user
      // captured — bit-exact match is what the receiver's verifier
      // expects.
      const rawBody = await readBody(body);

      const timestampMs = options.timestampMs
        ? parsePositiveInt(options.timestampMs, 'timestamp-ms')
        : Date.now();
      const timeoutMs = options.timeoutMs
        ? parsePositiveInt(options.timeoutMs, 'timeout-ms')
        : 10_000;

      // Compute HMAC: `t=<ms>,v1=<hex>` over the canonical
      // `<timestamp>.<body>` payload. Same shape `verifySignature`
      // checks against.
      const headerName = options.signatureHeader ?? SIGNATURE_HEADER_DEFAULT;
      const headerValue = computeSignatureHeader(rawBody, secret, timestampMs);

      // --dry-run short-circuit: emit the would-be POST envelope and
      // return without opening a network socket. Useful for previewing
      // the signature against a fresh receiver before pointing real
      // traffic at it.
      if (options.dryRun === true) {
        if (globals.json) {
          printJson({
            targetUrl,
            headerName,
            headerValue,
            timestampMs,
            bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
            dryRun: true,
          });
          return;
        }
        print('');
        log.success('Dry run — signature computed, no request sent.');
        print(`  ${style.dim('Target  ')} ${targetUrl}`);
        print(`  ${style.dim('Header  ')} ${headerName}: ${headerValue}`);
        print(`  ${style.dim('Body    ')} ${String(Buffer.byteLength(rawBody, 'utf8'))} bytes`);
        log.info('Re-run without --dry-run to send.');
        return;
      }

      // POST. Use `fetch` (Node 22+ ships it). Bound by a timeout so
      // a wedged target doesn't hang the CLI.
      const result = await deliver({
        targetUrl,
        body: rawBody,
        headerName,
        headerValue,
        timeoutMs,
      });

      if (globals.json) {
        printJson({
          targetUrl,
          headerName,
          headerValue,
          timestampMs,
          status: result.status,
          ok: result.ok,
          durationMs: result.durationMs,
          responseBody: result.body,
        });
        return;
      }

      // Human mode: brief result + the response body for inspection.
      print('');
      if (result.ok) {
        log.success(`Delivered in ${String(result.durationMs)}ms — HTTP ${String(result.status)}.`);
      } else {
        log.error(
          `Receiver returned HTTP ${String(result.status)} (after ${String(result.durationMs)}ms).`
        );
      }
      print(`  ${style.dim('Target  ')} ${targetUrl}`);
      print(`  ${style.dim('Header  ')} ${headerName}: ${headerValue}`);
      if (result.body.length > 0) {
        print('');
        print(style.dim('--- Response body ---'));
        print(result.body);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveSecret(options: ReplayOptions): Promise<string> {
  // Resolution order matches `kash webhooks verify` so the two
  // commands are interchangeable from the operator's POV:
  //   1. --secret (explicit; convenient but lands in argv)
  //   2. --secret-file (preferred — value never crosses argv/env)
  //   3. --secret-env <NAME> (read from named env var)
  //   4. KASH_WEBHOOK_SECRET (default env, no flag needed)
  if (options.secret !== undefined) return options.secret;
  if (options.secretFile !== undefined) {
    try {
      const raw = await readFile(options.secretFile, 'utf8');
      // Strip a trailing newline that text editors append; secrets
      // never include leading/trailing whitespace.
      return raw.trim();
    } catch {
      throw new CliValidationError(
        `--secret-file: failed to read ${options.secretFile}.`,
        'Verify the file exists and is readable.',
        'secret-file'
      );
    }
  }
  if (options.secretEnv !== undefined) {
    const value = process.env[options.secretEnv];
    if (!value || value.length === 0) {
      throw new CliError(`--secret-env ${options.secretEnv} is not set or empty.`, {
        code: 'INVALID_INPUT',
        recoverable: true,
        suggestion: `Set ${options.secretEnv}=<webhook-secret> before re-running.`,
      });
    }
    return value;
  }
  const fromEnv = process.env['KASH_WEBHOOK_SECRET'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  throw new CliValidationError(
    'A signing secret is required.',
    'Pass --secret-file (preferred), --secret, --secret-env <NAME>, or set KASH_WEBHOOK_SECRET.',
    'secret'
  );
}

function validateTarget(raw: string, policy: { refusePrivate: boolean }): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliValidationError(
      '--target must be a valid URL.',
      `Got "${raw}". Include the scheme (http:// or https://).`,
      'target'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliValidationError(
      `--target must use http:// or https:// (got "${url.protocol}").`,
      undefined,
      'target'
    );
  }
  // SSRF guard: by default warn when the target host is a loopback /
  // private / link-local address. `kash webhooks replay` is a
  // developer tool, not a server, so the risk is bounded — but a
  // misconfigured run against `169.254.169.254` (cloud metadata
  // service) or a VPN-bound private range can still exfiltrate
  // sensitive data through the signed POST body. The default warn
  // (instead of refuse) preserves local-tunnel testing (the common
  // case: `localhost:3000`, `127.0.0.1:3000`).
  //
  // CI runs and production-flavoured tests should pass
  // `--refuse-private-addresses` to upgrade the warning to a hard
  // failure — the policy parameter does that.
  if (policy.refusePrivate && isPrivateAddress(url)) {
    throw new CliValidationError(
      `--target points at a private address (${url.hostname}) and --refuse-private-addresses is set.`,
      'Drop the flag to allow private targets, or change --target to a public URL.',
      'target'
    );
  }
  warnIfPrivateAddress(url);
  return url.toString();
}

/**
 * Best-effort literal-IP-shape check. Matches:
 *
 *   - IPv4 loopback (127/8 — silent, expected for dev tunnels)
 *   - IPv4 link-local (169.254/16 — louder warning; cloud metadata
 *     services live here)
 *   - IPv4 private ranges (10/8, 172.16/12, 192.168/16)
 *   - IPv6 loopback (::1)
 *   - IPv6 link-local (fe80::/10)
 *   - IPv6 unique local (fc00::/7, which covers fc00:: and fd00::)
 *
 * Hostnames are intentionally NOT resolved here — full DNS resolution
 * would couple this CLI command to an async resolver and add a
 * network round-trip on every replay. That means cloud metadata
 * hostnames like `metadata.google.internal` are NOT caught (they
 * resolve to `169.254.169.254` only at request time); operators
 * relying on hostname-based aliases for sensitive endpoints must
 * audit their `--target` values themselves. The literal-IP check
 * here catches the most common foot-gun: a copy-pasted
 * `169.254.169.254` or private-range URL.
 *
 * The IPv4 octet regex bounds octets to 0–255 explicitly so a
 * pathological host like `999.999.999.999` (which `URL` happily
 * accepts as a hostname string) does not silently coerce into a
 * matching octet via `parseInt`.
 */
export function warnIfPrivateAddress(url: URL): void {
  // `url.hostname` keeps the surrounding [...] for IPv6 literals
  // (per the WHATWG URL spec — Node, browsers, and the URL standard
  // all agree). Strip them for the prefix matching below so the
  // regexes deal with bare hex hextets.
  const rawHost = url.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  // IPv6 loopback.
  if (host === '::1') {
    emitPrivateWarning(rawHost);
    return;
  }

  // Localhost name (and `*.localhost` per RFC 6761) — silent.
  if (host === 'localhost' || host.endsWith('.localhost')) return;

  // IPv6 link-local (fe80::/10) — first 10 bits are 1111 1110 10.
  // The leading hextet `fexx` ranges from fe80 to febf. The textual
  // prefix is therefore `fe` followed by one of `8`, `9`, `a`, `b`,
  // followed by any hex digit, followed by either `:` (short form,
  // e.g. `fe80::1`) or another hex digit then `:` (full form,
  // e.g. `fe80:0:…`). Match case-insensitively.
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(host)) {
    emitLinkLocalWarning(rawHost);
    return;
  }

  // IPv6 unique-local (fc00::/7) — first 7 bits are 1111 110, so any
  // address whose leading hextet starts with `fc` or `fd`. Allow up
  // to two more hex digits before the `:` separator (covers `fc::`,
  // `fc1::`, `fcab::`, `fd00::`, etc.).
  if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) {
    emitPrivateWarning(rawHost);
    return;
  }

  // IPv4 octet match — bounded 0..255 so `999.999.999.999` doesn't
  // silently match. `URL` accepts these strings as hostnames, so the
  // bound matters.
  const ipv4 =
    /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.exec(
      host
    );
  if (!ipv4) return; // hostname (no DNS check — see jsdoc)
  const [, a, b] = ipv4;
  const oct1 = Number.parseInt(a!, 10);
  const oct2 = Number.parseInt(b!, 10);
  if (oct1 === 127) return; // loopback — expected for `127.0.0.1` etc.
  if (oct1 === 10) {
    emitPrivateWarning(host);
    return;
  }
  if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) {
    emitPrivateWarning(host);
    return;
  }
  if (oct1 === 192 && oct2 === 168) {
    emitPrivateWarning(host);
    return;
  }
  if (oct1 === 169 && oct2 === 254) {
    emitLinkLocalWarning(host);
    return;
  }
}

/**
 * Pure predicate version of {@link warnIfPrivateAddress} — same set
 * of literal-IP shapes (loopback, link-local, RFC1918 private,
 * IPv6 ::1 / fe80::/10 / fc00::/7), but returns a boolean instead of
 * writing to stderr. Used by the `--refuse-private-addresses` policy
 * to hard-fail the run; the warn-only path stays as before.
 *
 * Hostnames that aren't literal IPs are treated as "not private"
 * (same documented limitation as the warning function — no DNS).
 */
export function isPrivateAddress(url: URL): boolean {
  const rawHost = url.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  if (host === '::1') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true;

  const ipv4 =
    /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.exec(
      host
    );
  if (!ipv4) return false;
  const oct1 = Number.parseInt(ipv4[1]!, 10);
  const oct2 = Number.parseInt(ipv4[2]!, 10);
  if (oct1 === 127) return true; // loopback
  if (oct1 === 10) return true;
  if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true;
  if (oct1 === 192 && oct2 === 168) return true;
  if (oct1 === 169 && oct2 === 254) return true; // link-local
  return false;
}

function emitLinkLocalWarning(host: string): void {
  // Worth a louder warning since link-local is the textbook SSRF
  // target — AWS / GCP / Azure metadata services live here.
  process.stderr.write(
    `\u26a0  --target points at a link-local address (${host}). This range hosts cloud metadata services. Verify the target is intentional.\n`
  );
}

function emitPrivateWarning(host: string): void {
  process.stderr.write(
    `\u26a0  --target points at a private address (${host}). Verify this is your dev tunnel and not an internal service.\n`
  );
}

async function readBody(file: string | undefined): Promise<string> {
  if (file !== undefined && file !== '-') {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (cause) {
      throw new CliError(`Failed to read ${file}.`, {
        code: 'CONFIGURATION',
        recoverable: true,
        suggestion: 'Verify the path exists and is readable.',
        cause,
      });
    }
    // Strip the BOM here too — the file branch is the more common
    // case when operators are testing with captured payloads dropped
    // by Notepad or VSCode-with-utf8bom.
    const { stripBom } = await import('../../utils/stdin.js');
    return stripBom(raw);
  }
  // Stdin.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Buffer) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk as Uint8Array));
  }
  if (chunks.length === 0) {
    throw new CliValidationError(
      'No input received on stdin.',
      'Pass a file path or pipe a webhook body into stdin.'
    );
  }
  // Strip a leading UTF-8 BOM. Notepad / VSCode-with-utf8bom and many
  // Windows tools prepend U+FEFF; without the strip the receiver
  // would HMAC-verify a body that starts with the BOM, but its own
  // JSON.parse would fail (BOM isn't valid leading whitespace in
  // JSON). Strip on read so the signature matches the parsed body.
  const { stripBom } = await import('../../utils/stdin.js');
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Build the Stripe-compatible signature header. Format is exactly
 * `t=<unix-ms>,v1=<hex-hmac-sha256>` — same shape the SDK's
 * `parseSignatureHeader` accepts. We replicate the math here rather
 * than reaching into the SDK's private helpers (which aren't
 * exported); the impl is small and the algorithm is stable.
 */
export function computeSignatureHeader(body: string, secret: string, timestampMs: number): string {
  const payload = `${String(timestampMs)}.${body}`;
  const hex = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${String(timestampMs)},v1=${hex}`;
}

type DeliveryResult = {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly durationMs: number;
};

async function deliver(args: {
  readonly targetUrl: string;
  readonly body: string;
  readonly headerName: string;
  readonly headerValue: string;
  readonly timeoutMs: number;
}): Promise<DeliveryResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  // The CLI is a published-to-npm public package that intentionally
  // has zero `@kashdao/*` runtime deps beyond `@kashdao/sdk` and
  // `@kashdao/protocol-sdk` (enforced by sync-to-public-mirror.ts).
  // Pulling in `@kashdao/http-client` would break that invariant.
  // The webhook replay is to a USER-supplied URL (already SSRF-guarded
  // by `--refuse-private-addresses` upstream of this call); the call
  // is one-shot, has a caller-set timeout via AbortController, and
  // propagates failures explicitly via `DeliveryResult`.
  try {
    const response = await /* eslint-disable-line @kashdao/no-bare-fetch */ fetch(args.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [args.headerName]: args.headerValue,
      },
      body: args.body,
      signal: controller.signal,
    });
    const responseBody = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: responseBody,
      durationMs: Date.now() - start,
    };
  } catch (cause) {
    // Timeout detection. `AbortError` covers most cases, but Node's
    // fetch can surface a header-stage timeout via `cause.cause` with
    // an UND_ERR_HEADERS_TIMEOUT-style code in which `name` is not
    // `AbortError`. The AbortController is the authoritative signal:
    // if we triggered it, this is a timeout regardless of the error's
    // visible shape.
    const wasAborted = controller.signal.aborted;
    const looksLikeAbort = cause instanceof Error && cause.name === 'AbortError';
    if (wasAborted || looksLikeAbort) {
      throw new CliError(`Delivery timed out after ${String(args.timeoutMs)}ms.`, {
        code: 'TIMEOUT',
        recoverable: true,
        suggestion: 'Raise --timeout-ms or check the target endpoint is responsive.',
        cause,
      });
    }
    throw new CliError(
      `Delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        code: 'NETWORK',
        recoverable: true,
        suggestion: 'Verify the target URL is reachable from this machine.',
        cause,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}
