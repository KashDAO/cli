/**
 * Shared "place a trade" implementation for `buy` and `sell`.
 *
 * The two commands differ only in the `side` field, so the heavy
 * lifting — input validation, idempotency wiring, optional polling,
 * 202-confirmation rendering — lives here.
 */

import ora from 'ora';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { capitalize, colorStatus, formatUsdcDecimal, shortId } from '../../utils/formatting.js';
import { parsePositiveInt } from '../../utils/global-options.js';
import { isQuiet, log, print, printJson, style } from '../../utils/output.js';
import { parseOutcomeIndex, validateUsdcDecimalShape } from '../../utils/trade-input.js';

import type { GlobalOptions } from '../../utils/global-options.js';
import type { KashClient, TradeResource, TradeSide } from '@kashdao/sdk';

export type PlaceTradeOptions = {
  outcome: string;
  amount: string;
  wait?: boolean;
  idempotencyKey?: string;
  autoIdempotencyKey?: boolean;
  clientRequestId?: string;
  timeout?: string;
  pollInterval?: string;
  dryRun?: boolean;
};

export type PlaceTradeArgs = {
  marketId: string;
  side: TradeSide;
  options: PlaceTradeOptions;
  globals: GlobalOptions;
};

export async function placeTrade({
  marketId,
  side,
  options,
  globals,
}: PlaceTradeArgs): Promise<void> {
  const json = globals.json;
  // marketId is enforced as a required positional by Commander; no
  // defensive check needed here. Same for --outcome / --amount, which
  // are `requiredOption`s — but we re-validate their *values* (range,
  // format) below since Commander only enforces presence.
  // Markets carry 2-8 outcomes (per @kashdao/constants), so a valid
  // outcome index is in [0, 7]. Bouncing out-of-range values here
  // gives the agent INVALID_INPUT with a clear field name, instead of
  // a server-side `KashValidationError` half a round-trip later.
  const outcomeIndex = parseOutcomeIndex(options.outcome);
  const amount = options.amount?.trim();
  if (!amount) {
    throw new CliValidationError(
      '--amount is required.',
      'Use a USDC decimal like "10" or "12.50".'
    );
  }
  // Shape-only validator — public-API mode ships the decimal string
  // verbatim to the SDK rather than converting to atomic units, so we
  // only need the shape pin here. `validateUsdcDecimalShape` is the
  // shared primitive that backs `decimalToAtomicUsdc` in SA/EOA mode.
  validateUsdcDecimalShape(amount, 'amount');

  const timeoutMs = options.timeout ? parsePositiveInt(options.timeout, 'timeout') : 60_000;
  const pollIntervalMs = options.pollInterval
    ? parsePositiveInt(options.pollInterval, 'poll-interval')
    : 2_000;

  // Resolve idempotency key. Explicit --idempotency-key wins; otherwise
  // --auto-idempotency-key generates a UUID v4. The resolved value is
  // surfaced on the response so an agent that retries a transient
  // failure can re-use the same key.
  let resolvedIdempotencyKey = options.idempotencyKey;
  if (resolvedIdempotencyKey === undefined && options.autoIdempotencyKey) {
    // `@kashdao/cli` is a published npm package and cannot depend on
    // workspace-only `@kashdao/utils`. `crypto.randomUUID()` is the
    // right primitive here.
    // eslint-disable-next-line no-restricted-properties
    resolvedIdempotencyKey = crypto.randomUUID();
    if (!json) {
      log.detail('Generated Idempotency-Key', resolvedIdempotencyKey);
    }
  }

  // --dry-run short-circuits before the network call. We still validate
  // inputs (above) and resolve the idempotency key so the envelope
  // accurately reflects what a real invocation would send. Crucially,
  // we do NOT instantiate the SDK client — `buildClient` would fail on
  // a missing API key, but a dry-run preview should work without auth
  // so agents can plan trades against an unconfigured profile.
  if (options.dryRun === true) {
    const wouldSend = {
      marketId,
      outcomeIndex,
      amount,
      side,
      ...(options.clientRequestId === undefined
        ? {}
        : { clientRequestId: options.clientRequestId }),
    };
    const envelope = {
      wouldSend,
      idempotencyKey: resolvedIdempotencyKey ?? null,
      endpoint: { method: 'POST' as const, path: '/v1/trades' as const },
    };
    if (json) {
      printJson(envelope);
      return;
    }
    print('');
    print(style.bold('Dry run — no request sent.'));
    print(`  ${style.dim('Endpoint   ')} POST /v1/trades`);
    print(`  ${style.dim('Market     ')} ${marketId}`);
    print(`  ${style.dim('Side       ')} ${side}`);
    print(`  ${style.dim('Outcome    ')} ${String(outcomeIndex)}`);
    print(`  ${style.dim('Amount     ')} ${amount} USDC`);
    if (options.clientRequestId !== undefined) {
      print(`  ${style.dim('Client req ')} ${options.clientRequestId}`);
    }
    if (resolvedIdempotencyKey !== undefined) {
      print(`  ${style.dim('Idem. key  ')} ${resolvedIdempotencyKey}`);
    }
    print('');
    print(style.dim('Re-run without --dry-run to submit.'));
    return;
  }

  let response;
  try {
    const { client } = await buildClient({ requireAuth: true, globals });
    response = await client.trades.create(
      {
        marketId,
        outcomeIndex,
        amount,
        side,
        ...(options.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      },
      resolvedIdempotencyKey === undefined ? {} : { idempotencyKey: resolvedIdempotencyKey }
    );

    // Attach the idempotency key (if we generated one) so agents that
    // retry can re-use it. Empty when neither flag was provided.
    const augment = <T extends object>(payload: T): T & { idempotencyKey?: string } =>
      resolvedIdempotencyKey === undefined
        ? (payload as T & { idempotencyKey?: string })
        : { ...payload, idempotencyKey: resolvedIdempotencyKey };

    // The flat result (TradeResource + idempotent + optional confirmation) —
    // see SDK's `TradeCreateResult`.
    if (response.confirmation) {
      if (json) {
        printJson(augment(response));
        return;
      }
      log.warn(
        'High-value trade — server returned 202. Confirm with `kash trade confirm <id> <token>`.'
      );
      print(`  ${style.dim('Trade id   ')} ${response.id}`);
      print(`  ${style.dim('Status     ')} ${colorStatus(response.status)}`);
      print(`  ${style.dim('Token      ')} ${response.confirmation.token}`);
      print(`  ${style.dim('Expires    ')} ${response.confirmation.expiresAt}`);
      return;
    }

    if (!options.wait) {
      if (json) {
        printJson(augment(response));
        return;
      }
      log.success(
        `${capitalize(side)} accepted${response.idempotent ? ' (idempotent replay)' : ''}: ${shortId(response.id)}`
      );
      print(`  ${style.dim('Trade id   ')} ${response.id}`);
      print(`  ${style.dim('Status     ')} ${colorStatus(response.status)}`);
      print(`  ${style.dim('Amount     ')} ${formatUsdcDecimal(response.amount)}`);
      log.info("Run 'kash trade status <id> --poll' to follow it to completion.");
      return;
    }

    // --wait: poll until terminal. Partial-completion guard: the
    // `client.trades.create` above already succeeded — `response.id`
    // is server-assigned and the trade exists in the API. If the
    // poll fails (timeout, transient network), surface the id so
    // the operator can resume via `kash trade status <id> --poll`
    // instead of losing the pointer to a created-but-unconfirmed
    // trade. Symmetric to the SA-mode userop / EOA-mode tx hash
    // partial-completion seams.
    let completed: TradeResource;
    try {
      completed = await waitForCompletion(client, response, {
        timeoutMs,
        pollIntervalMs,
        json,
      });
    } catch (waitCause) {
      if (json) {
        printJson({
          id: response.id,
          status: response.status,
          waited: false,
          partial: true,
        });
      } else {
        log.warn(
          `Trade created but poll did not reach a terminal state. Resume with: kash trade status ${response.id} --poll`
        );
      }
      throw waitCause;
    }

    if (json) {
      printJson(augment({ ...completed, idempotent: response.idempotent, waited: true }));
      return;
    }
    renderTerminal(completed);
  } catch (cause) {
    throw toCliError(cause);
  }
}

async function waitForCompletion(
  client: KashClient,
  initial: TradeResource,
  opts: { timeoutMs: number; pollIntervalMs: number; json: boolean }
): Promise<TradeResource> {
  // Wire SIGINT/SIGTERM to abort the in-flight poll cleanly. The
  // shape mirrors `trade status --poll`: register on entry, unwire
  // in the finally block. Without this, Ctrl-C during a 60s wait
  // leaves the in-flight HTTP request stranded — process tear-down
  // works via the global SIGPIPE handler but the SDK fetch never
  // sees the cancellation.
  const ac = new AbortController();
  const onSig = (): void => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    if (opts.json || isQuiet()) {
      return await client.trades.waitForCompletion(initial.id, {
        timeoutMs: opts.timeoutMs,
        pollIntervalMs: opts.pollIntervalMs,
        signal: ac.signal,
      });
    }
    const spinner = ora({
      text: `Waiting for trade ${shortId(initial.id)}…`,
      stream: process.stderr,
    }).start();
    try {
      const completed = await client.trades.waitForCompletion(initial.id, {
        timeoutMs: opts.timeoutMs,
        pollIntervalMs: opts.pollIntervalMs,
        signal: ac.signal,
        onStatus: (trade) => {
          spinner.text = `Trade ${shortId(trade.id)} — status: ${trade.status}`;
        },
      });
      if (completed.status === 'completed') {
        spinner.succeed(`Trade ${shortId(completed.id)} completed.`);
      } else {
        spinner.fail(`Trade ${shortId(completed.id)} ${completed.status}.`);
      }
      return completed;
    } catch (cause) {
      spinner.fail('Polling stopped.');
      throw cause;
    }
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

function renderTerminal(trade: TradeResource): void {
  print('');
  print(`  ${style.dim('Trade id   ')} ${trade.id}`);
  print(`  ${style.dim('Status     ')} ${colorStatus(trade.status)}`);
  print(`  ${style.dim('Amount     ')} ${formatUsdcDecimal(trade.amount)}`);
  // Use explicit null checks for nullable fields rather than truthy
  // checks. `if (trade.errorMessage)` would silently hide a literal
  // empty-string error (`""`), which the API can return for "errored
  // but with no human message." Same for `tokensOut`/`txHash`: `"0"`
  // is a valid string but `Boolean("0") === true`, so truthy checks
  // happen to work today but are accidentally correct.
  if (trade.txHash !== null) {
    print(`  ${style.dim('Tx hash    ')} ${trade.txHash}`);
  }
  if (trade.tokensOut !== null) {
    print(`  ${style.dim('Tokens out ')} ${trade.tokensOut}`);
  }
  if (trade.errorMessage !== null || trade.errorCode !== null) {
    print(
      `  ${style.dim('Error      ')} [${trade.errorCode ?? 'UNKNOWN'}] ${trade.errorMessage ?? ''}`
    );
    log.info(`Inspect the full timeline: kash trace ${trade.correlationId}`);
  }
}

// `parseOutcomeIndex` and `validateUsdcDecimalShape` live in
// `utils/trade-input.ts` — single source of truth across SA, EOA,
// and public-API modes. Imports at the top of this file.
