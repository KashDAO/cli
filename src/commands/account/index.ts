/**
 * `kash account` — read-only account-scoped surfaces for the
 * authenticating API key.
 *
 * Currently just `usage` (per-key telemetry). Future siblings could
 * include `keys list / revoke` if those flows ever migrate from the
 * webapp Settings page into the CLI.
 */

import { Command } from 'commander';

import { usageCommand } from './usage.js';

export const accountCommand = new Command('account')
  .description('Read-only account surfaces (usage telemetry, etc.).')
  .addCommand(usageCommand);
