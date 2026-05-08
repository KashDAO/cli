/**
 * `kash webhooks` — manage webhook delivery for the authenticating
 * API key.
 */

import { Command } from 'commander';

import { listWebhookEventsCommand } from './list.js';
import { redeliverCommand } from './redeliver.js';
import { replayWebhookCommand } from './replay.js';
import { rotateSecretCommand } from './rotate-secret.js';
import { verifyWebhookCommand } from './verify.js';

export const webhooksCommand = new Command('webhooks')
  .description('Manage webhook delivery, signing secrets, and signature verification.')
  .addCommand(listWebhookEventsCommand)
  .addCommand(rotateSecretCommand)
  .addCommand(redeliverCommand)
  .addCommand(verifyWebhookCommand)
  .addCommand(replayWebhookCommand);
