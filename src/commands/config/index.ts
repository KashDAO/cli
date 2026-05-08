/**
 * `kash config` — inspect and edit the local CLI configuration.
 */

import { Command } from 'commander';

import { exportConfigCommand } from './export.js';
import { importConfigCommand } from './import.js';
import { profilesCommand } from './profiles.js';
import { removeProfileCommand } from './remove.js';
import { resetConfigCommand } from './reset.js';
import { setConfigCommand } from './set.js';
import { showConfigCommand } from './show.js';
import { useProfileCommand } from './use.js';

export const configCommand = new Command('config')
  .description('Inspect and edit ~/.kash/config.json (multi-profile).')
  .addCommand(showConfigCommand)
  .addCommand(setConfigCommand)
  .addCommand(profilesCommand)
  .addCommand(useProfileCommand)
  .addCommand(removeProfileCommand)
  .addCommand(resetConfigCommand)
  .addCommand(exportConfigCommand)
  .addCommand(importConfigCommand);
