/**
 * `kash webhooks redeliver <eventId>` — re-queue an existing webhook
 * for delivery. Useful when a downstream receiver was offline.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { buildClient } from '../../utils/client.js';
import { formatDate, shortId } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

/**
 * Event ID shape: a UUID v1/v3/v4/v5 — matches what
 * `WebhookEventResourceSchema.id` (`z.string().uuid()`) accepts. We
 * pre-flight the shape so a typo (a trade id with surrounding
 * quotes, a partial paste, the wrong field) surfaces as
 * `INVALID_INPUT` before we burn an API round-trip.
 */
const EVENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const redeliverCommand = new Command('redeliver')
  .description('Re-queue a webhook event for delivery.')
  .argument('<eventId>', 'webhook event UUID')
  .addHelpText(
    'after',
    `
Examples:
  $ kash webhooks redeliver 99999999-9999-9999-9999-999999999999
  $ kash webhooks redeliver "$(kash webhooks list --json --quiet | jq -r '.data[0].id')"
`
  )
  .action(async (eventId: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);
    if (!EVENT_ID_REGEX.test(eventId)) {
      throw new CliValidationError(
        `<eventId> must be a UUID.`,
        `Got "${eventId}". Look up the id in \`kash webhooks list --json --quiet | jq -r '.data[].id'\`.`,
        'eventId'
      );
    }
    let event;
    try {
      const { client } = await buildClient({ requireAuth: true, globals });
      event = await client.webhooks.redeliver(eventId);
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      printJson(event);
      return;
    }

    // All labels are padded to 16 chars so the values line up in a
    // visually consistent column. Show the FULL event id (not a
    // shortId) so the operator can correlate against logs / docs
    // without re-running `kash webhooks list`.
    log.success(`Re-delivery queued for ${event.id}.`);
    print(`  ${style.dim('Event id        ')} ${event.id}`);
    print(`  ${style.dim('Event type      ')} ${event.eventType}`);
    print(`  ${style.dim('Emitted at      ')} ${formatDate(event.emittedAt)}`);
    print(`  ${style.dim('Attempts        ')} ${String(event.deliveryAttempts)}`);
    if (event.lastDeliveredAt) {
      print(`  ${style.dim('Last delivered  ')} ${formatDate(event.lastDeliveredAt)}`);
    }
    // Also keep `shortId` available for CI logs that don't want the
    // full UUID — surface as a hint, not the primary value.
    log.detail('Short id', shortId(event.id));
  });
