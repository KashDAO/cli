/**
 * `kash` — official command-line interface for the Kash public API.
 *
 * The binary is a thin wrapper over `@kashdao/sdk`. Every command
 * resolves its config (file → env), constructs a KashClient, and
 * defers to the SDK for the actual work. This file is only the
 * Commander wiring: registration, global flags, and the top-level
 * error boundary.
 *
 * **Cold-start strategy.** Plain `kash --version` and `kash -V` are the
 * single hottest invocation in CI/agent contexts (every health probe,
 * every doctor script). We short-circuit them before any of the
 * subcommand modules load — they pull `@kashdao/sdk`, `chalk`, `ora`,
 * etc., none of which `--version` needs. The full Commander tree is
 * built only when the user actually asks for a real command.
 */

import { isDebugOn, shouldPromoteDebug } from './utils/debug-hint.js';
import { CLI_VERSION } from './version.js';

// ── SIGPIPE-safe stdout/stderr ──────────────────────────────────────
//
// `kash <cmd> | head` is a common shell pattern; without this guard,
// when `head` closes the pipe early Node throws `EPIPE` from the next
// `process.stdout.write`, which surfaces as exit code 1 — surprising
// for users piping output into `head`/`less`/`column`. We treat
// EPIPE / EIO as a clean exit (0): downstream told us to stop, we
// stop. Any other write error still propagates so real I/O failures
// aren't masked.
//
// Two listeners are needed:
//   1. `'error'` on the streams catches EPIPE delivered as an event
//      (async writes / future flushes).
//   2. `'uncaughtException'` catches EPIPE thrown synchronously by a
//      `process.stdout.write` call when the pipe is already closed —
//      this is what `head -c 5` triggers and the stream listener
//      doesn't see.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'EIO') {
      process.exit(0);
    }
    throw err;
  });
}
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'EIO') {
    process.exit(0);
  }
  // Re-throw so Node's default handler logs and exits with 1.
  throw err;
});

// ── Fast path: plain `--version` / `-V` ─────────────────────────────
//
// Short-circuits before commander, the SDK, and every command module
// are imported. The structured `--version --json` path still needs
// `buildVersionManifest` (which reads `os` info) and `printJson`, but
// even those load lazily so the simpler `kash --version` only pays
// for `version.js`.
const argv = process.argv;
if (argv[2] === '--version' || argv[2] === '-V') {
  if (argv.slice(3).includes('--json')) {
    const [{ buildVersionManifest }, { printJson }] = await Promise.all([
      import('./commands/version.js'),
      import('./utils/output.js'),
    ]);
    printJson(buildVersionManifest());
  } else {
    process.stdout.write(`${CLI_VERSION}\n`);
  }
  process.exit(0);
}

// ── Fast path: `kash --help --json` / `kash --json --help` ──────────
//
// Commander's default `--help` renderer emits human-formatted text —
// useful for operators, useless for AI agents probing the surface.
// When `--help` is paired with `--json` (any order, no other args),
// route to the structured `kash docs --json --quiet` envelope. That's
// the canonical machine-readable help and pinning to it keeps the
// agent contract clean.
//
// We don't try to handle `kash <subcommand> --help --json` — those
// fall through to Commander's text help, and the right answer for
// agents is to fetch the full tree once via `kash docs --json` and
// drill down.
{
  const tail = argv.slice(2);
  const helpIdx = tail.indexOf('--help');
  const dashHIdx = tail.indexOf('-h');
  const hasHelp = helpIdx !== -1 || dashHIdx !== -1;
  const hasJson = tail.includes('--json');
  const hasOther = tail.some(
    (t) => t !== '--help' && t !== '-h' && t !== '--json' && t !== '--quiet'
  );
  if (hasHelp && hasJson && !hasOther) {
    // Use the existing docs command via its describeCommand walker.
    // We need a fully-built program to walk, so we let the eager
    // imports below run and handle this in the docs command's own
    // action. Mark it with the flag and let it fall through.
    process.argv = [argv[0]!, argv[1]!, 'docs', '--json'];
    if (tail.includes('--quiet')) process.argv.push('--quiet');
  }
}

// ── Friendly intro: `kash` (no args, optionally with --json) ─────────
//
// Default Commander behaviour for a no-args invocation is to dump
// `--help`, which is overwhelming on first contact. Show a curated
// landing instead. Detected by argv length: pure `kash`, `kash --json`,
// or `kash --quiet` (with no other tokens) trip this path.
//
// **Quiet contracts.** CI environments and orchestrators that spawn
// `kash` with no extra args shouldn't see decorative output. Honour
// `--quiet`, `KASH_QUIET=1` (env mirror — same truthy parser as
// `KASH_DEBUG`), and the de-facto-standard `NO_COLOR`/`CI` are
// deliberately NOT included because they have unrelated semantics.
// In quiet mode we exit 0 with no output at all — no JSON envelope
// either, since a script triggering this path didn't ask for it.
//
// Anything else (`kash foo`, `kash --help`, `kash markets …`) falls
// through to Commander as before.
const onlyArgs = argv.slice(2);
const isBareInvocation =
  onlyArgs.length === 0 ||
  (onlyArgs.length === 1 && (onlyArgs[0] === '--json' || onlyArgs[0] === '--quiet'));
if (isBareInvocation) {
  const wantsJson = onlyArgs.includes('--json');
  const wantsQuiet = onlyArgs.includes('--quiet') || isTruthyEnv(process.env['KASH_QUIET']);

  // Quiet mode: emit nothing — neither the human banner nor the JSON
  // envelope. CI scripts that bare-invoke `kash` to test the binary
  // works don't need decorative output. (`--json` still wins if the
  // user is explicit about wanting structured output.)
  if (wantsQuiet && !wantsJson) {
    process.exit(0);
  }

  const { buildIntroEnvelope, INTRO_SUGGESTIONS, DOCS_URL } = await import('./utils/intro.js');
  if (wantsJson) {
    const { printJson } = await import('./utils/output.js');
    printJson(buildIntroEnvelope(CLI_VERSION));
  } else {
    const { print, style } = await import('./utils/output.js');
    print('');
    print(`${style.bold('kash')} ${style.dim(`v${CLI_VERSION}`)} — Kash prediction markets CLI`);
    print('');
    for (const s of INTRO_SUGGESTIONS) {
      print(`  ${style.bold(s.title)}`);
      print(`    ${style.cyan(s.command)}`);
      print(`    ${style.dim(s.description)}`);
      print('');
    }
    print(
      `${style.dim('Run')} ${style.cyan('kash --help')} ${style.dim('for the full command list.')}`
    );
    print(`${style.dim('Docs:')} ${DOCS_URL}`);
    print('');
  }
  process.exit(0);
}

/**
 * Mirror of the `isTruthyEnv` helper in `utils/global-options.ts`.
 * Inlined here so the bare-invocation fast path doesn't pay for the
 * full import. Same truth values: `1`, `true`, `yes`, `on`
 * (case-insensitive). Empty string and `0` are falsy.
 */
function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Eager imports below run only for invocations that actually need a
// command. The SDK-heavy modules still load — Commander needs every
// subcommand registered up-front to render `--help` correctly — but
// individual commands lazy-load their own dependencies (`omelette`,
// `zod-to-json-schema`, `@kashdao/protocol-sdk`, `viem`) inside their
// action handlers.
const { Command } = await import('commander');
const { authCommand } = await import('./commands/auth/index.js');
const { configCommand } = await import('./commands/config/index.js');
const { buildDocsCommand } = await import('./commands/docs.js');
const { eoaCommand } = await import('./commands/eoa/index.js');
const { explainCommand } = await import('./commands/explain.js');
const { accountCommand } = await import('./commands/account/index.js');
const { healthCommand } = await import('./commands/health.js');
const { marketsCommand } = await import('./commands/markets/index.js');
const { portfolioCommand } = await import('./commands/portfolio/index.js');
const { protocolCommand } = await import('./commands/protocol/index.js');
const { quoteCommand } = await import('./commands/quote/index.js');
const { schemaCommand } = await import('./commands/schema.js');
const { setupCommand } = await import('./commands/setup.js');
const { traceCommand } = await import('./commands/trace.js');
const { tradeCommand } = await import('./commands/trade/index.js');
const { withRetryCommand } = await import('./commands/with-retry.js');
const { versionCommand } = await import('./commands/version.js');
const { webhooksCommand } = await import('./commands/webhooks/index.js');
const { createCompletionCommand, initCompletion } = await import('./completion.js');
const { EXIT_CODES, toCliError } = await import('./errors.js');
const { readGlobals } = await import('./utils/global-options.js');
const { configureOutput, log, printJson } = await import('./utils/output.js');

import type { CliError } from './errors.js';

const program = new Command();

program
  .name('kash')
  .description('Official command-line interface for the Kash public API.')
  .version(CLI_VERSION, '-V, --version', 'output the CLI version')
  // Output controls
  .option('--json', 'emit machine-readable JSON instead of human-formatted output', false)
  .option(
    '--quiet',
    'suppress spinners, progress, informational logs, AND human-mode tables (pair with --json — bare --quiet on a list/get command produces no stdout at all by design)',
    false
  )
  .option('--no-color', 'disable ANSI color in human-mode output')
  .option(
    '--debug',
    'emit SDK request/response/retry/error traces to stderr; pairs with --json for NDJSON traces',
    false
  )
  // Config selection
  .option(
    '-p, --profile <name>',
    'pick a named profile from ~/.kash/config.json (overrides KASH_PROFILE)'
  )
  .option(
    '--config <path>',
    'use an explicit config file path instead of ~/.kash/config.json (overrides KASH_CONFIG)'
  )
  // SDK overrides — useful for staging tests, CI matrix builds, agent retry tuning
  .option('--base-url <url>', 'override the API base URL for this invocation only')
  .option('--max-retries <n>', 'override the SDK retry budget for this invocation only')
  .option('--timeout-ms <n>', 'override the SDK request timeout (ms) for this invocation only')
  .option(
    '--api-version <date>',
    "pin against a public-API contract date (sent as 'X-Kash-Api-Version: <date>'). " +
      'Omit to let the server use its canonical default.'
  )
  // Output projection — applied only on --json/--ndjson output
  .option(
    '--fields <list>',
    'comma-separated dot-paths to project on JSON output (e.g. id,title,outcomes.label)'
  )
  .option(
    '--filter <expr>',
    "boolean predicate on JSON entries (e.g. 'status==ACTIVE && outcomeCount>2')"
  )
  .hook('preAction', (thisCommand) => {
    const globals = readGlobals(thisCommand);
    configureOutput({
      quiet: globals.quiet,
      noColor: globals.noColor,
      fields: globals.fields,
      filter: globals.filter,
    });
  })
  .addHelpText(
    'after',
    `
Common workflows:
  First-time setup          kash setup
  Switch / inspect profile  kash su <name>
  Browse markets            kash markets list --status ACTIVE
  Place a trade and wait    kash trade buy <id> --outcome 0 --amount 10 --wait
  Inspect portfolio         kash portfolio show && kash portfolio positions

For AI agents:
  Universal agent mode      kash <any-command> --json --quiet
  Discover all commands     kash docs --json --quiet
  Get a request schema      kash schema CreateTradeBody --json
  Recover from an error     kash explain RATE_LIMITED --json
  Stream paginated reads    kash markets list --ndjson

Exit codes:
  0  success
  1  generic error (validation, server, network, …)
  2  auth failure (missing or invalid API key, missing scope)

Run \`kash <command> --help\` for command-specific help and examples.
Docs: https://kash.bot/docs/cli
`
  );

// Hand control of Commander's exit behaviour to our top-level error
// boundary. Without this, Commander calls `process.exit(1)` directly
// on unknown commands / unknown options, skipping our structured
// error envelope. With `exitOverride`, Commander throws a
// `CommanderError` we can map to a `CliError` (see `toCliError` in
// errors.ts).
//
// Help and version short-circuits still get filtered there — they
// surface as `commander.help`/`commander.helpDisplayed`/`commander.version`
// codes which the mapper detects and treats as clean exits.
program.exitOverride();

// Register top-level command groups.
program.addCommand(authCommand);
program.addCommand(accountCommand);
program.addCommand(marketsCommand);
program.addCommand(quoteCommand);
program.addCommand(tradeCommand);
program.addCommand(portfolioCommand);
program.addCommand(protocolCommand);
program.addCommand(eoaCommand);
program.addCommand(webhooksCommand);
program.addCommand(configCommand);
program.addCommand(healthCommand);
program.addCommand(versionCommand);
program.addCommand(explainCommand);
program.addCommand(schemaCommand);
program.addCommand(setupCommand);
program.addCommand(traceCommand);
program.addCommand(withRetryCommand);
program.addCommand(buildDocsCommand(() => program));
program.addCommand(createCompletionCommand());

// Append a per-command "More: <docs-url>" footer to every top-level
// `--help` page. Done after every command is registered so we walk
// the fully-populated tree once.
const { attachDocsFooters } = await import('./utils/help-footer.js');
attachDocsFooters(program);

// Initialize shell completion before parseAsync — omelette needs to
// see the args first to detect a completion request. Now async because
// `initCompletion` lazy-imports omelette only when the args look like
// a completion handshake.
await initCompletion();

try {
  await program.parseAsync(process.argv);
  // Let Node exit naturally on success so any buffered stdout writes
  // (NDJSON streams, large `--all` exports through a pipe) flush
  // cleanly. Calling `process.exit` here would truncate the buffer
  // when stdout is connected to a slow consumer. The error path
  // still calls `process.exit` because we want a deterministic exit
  // code; data loss isn't a concern when we already failed.
} catch (rawError) {
  const error = toCliError(rawError);
  // Clean exits (e.g. `--help` and `--version` short-circuits surfaced
  // via Commander's `exitOverride`) bypass the error renderer — they
  // already wrote their output to stdout and there's nothing to add.
  if (error.code === 'NOOP' && error.exitCode === EXIT_CODES.OK) {
    process.exit(0);
  }
  emitError(error);
  process.exit(error.exitCode);
}

/**
 * Render the error using whichever output mode is currently active.
 * In JSON mode we stay machine-readable so an AI agent can branch on
 * `code` without parsing prose; in human mode we surface the
 * suggestion (when available) and the request id (when available).
 *
 * `readGlobals` itself can throw when a flag value is malformed
 * (`--base-url not-a-url`, `--max-retries 99`). On the error path
 * we shouldn't double-throw — fall back to a minimal mode (sniff the
 * raw argv for `--json` / `--quiet`) so the original error is still
 * surfaced cleanly.
 */
function emitError(error: CliError): void {
  const json = safeReadJsonFlag();
  if (json) {
    printJson(error.toEnvelope());
    return;
  }
  log.error(`[${error.code}] ${error.message}`);
  if (error.suggestion) {
    log.detail('Suggestion', error.suggestion);
  }
  if (error.retryAfterMs !== undefined) {
    log.detail('Retry after', `${String(Math.round(error.retryAfterMs / 1000))}s`);
  }
  if (error.docsUrl) {
    log.detail('Docs', error.docsUrl);
  }
  if (error.requestId) {
    log.detail('Request ID', error.requestId);
  }
  // Always promote the explainer for the structured-actions catalog —
  // it's the deepest source of recovery info the CLI ships with and
  // every catalog entry has a `kash explain CODE` payload. Skipped
  // when the code itself isn't in the catalog (UNEXPECTED, etc.) to
  // avoid pointing the user at an empty page.
  if (error.code !== 'UNEXPECTED') {
    log.detail('More', `kash explain ${error.code}`);
  }
  // For non-trivial failures, surface --debug as the next-step lever.
  // It enables verbose request/response logging on the SDK's HTTP
  // path — the natural diagnostic when an error keeps recurring.
  // Skipped when --debug is already on (don't suggest what they're
  // already doing) and on plain validation errors (the user needs to
  // fix input, not log more bytes).
  if (!isDebugOn(process.argv, process.env) && shouldPromoteDebug(error.code)) {
    log.detail('Debug', 'Re-run with --debug for verbose HTTP logs.');
  }
}

/**
 * Inspect the raw argv for `--json` without re-running validation —
 * used on the error path so a malformed flag value (which is what
 * triggered the error in the first place) doesn't double-throw and
 * obscure the original failure.
 */
function safeReadJsonFlag(): boolean {
  return process.argv.slice(2).includes('--json');
}
