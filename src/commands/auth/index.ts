/**
 * `kash auth` — credential management.
 *
 * Users issue a key from the Kash dashboard and run `auth set-key`
 * (or set `KASH_API_KEY` in their environment). A future browser-based
 * login flow may be added; for now, key issuance lives on the dashboard.
 */

import { Command } from 'commander';

import { logoutCommand } from './logout.js';
import { setKeyCommand } from './set-key.js';
import { statusCommand } from './status.js';

export const authCommand = new Command('auth')
  .description('Manage local API credentials.')
  .addCommand(setKeyCommand)
  .addCommand(statusCommand)
  .addCommand(logoutCommand);
