/**
 * Shell completion (bash + zsh + fish via omelette).
 *
 * The completion tree mirrors the registered command groups. Adding a
 * command means updating both the Commander wiring in `index.ts` and
 * the `COMMANDS` map below — they don't auto-derive because omelette
 * resolves at startup based on positional args, not the Commander
 * instance.
 *
 * **Cold-start.** `omelette` is dynamically imported inside the action
 * handlers and `initCompletion()` rather than at module top — bash/zsh
 * completion is a one-shot install path, and 99% of CLI invocations
 * never hit it. Skipping the eager import shaves ~3ms off every other
 * command.
 */

import { Command } from 'commander';

import { CliError } from './errors.js';
import { log } from './utils/output.js';

const COMMANDS: Record<string, string[]> = {
  auth: ['set-key', 'status', 'logout'],
  account: ['usage'],
  markets: ['list', 'get', 'predictions'],
  quote: ['buy', 'sell'],
  trade: ['buy', 'sell', 'status', 'list', 'confirm'],
  portfolio: ['show', 'positions'],
  protocol: [
    'balance',
    'market',
    'quote',
    'position',
    'allowance',
    'smart-account',
    'fees',
    'token-id',
    'decode-revert',
    'trade',
    'userop',
    'watch',
  ],
  eoa: ['balance', 'market', 'quote', 'position', 'allowance', 'fees', 'trade'],
  webhooks: ['list', 'rotate-secret', 'redeliver', 'verify', 'replay'],
  config: ['show', 'set', 'profiles', 'use', 'remove', 'reset', 'export', 'import'],
  health: [],
  version: [],
  explain: [],
  schema: [],
  setup: [],
  trace: [],
  'with-retry': [],
  docs: [],
  completion: ['install', 'uninstall'],
};

export async function initCompletion(): Promise<void> {
  // Only `kash --compbash`/`--compzsh`/`--compfish` invocations need
  // omelette. For every other command, we'd be paying ~3ms to load a
  // module we never use. Detect the completion-handshake args before
  // touching omelette.
  const argv = process.argv.slice(2);
  const isCompletionArg = argv.some(
    (a) => a === '--compbash' || a === '--compzsh' || a === '--compfish' || a === '--completion'
  );
  if (!isCompletionArg) return;

  const { default: omelette } = await import('omelette');
  const completion = omelette('kash <command> <subcommand>');

  completion.on('command', () => Object.keys(COMMANDS));
  completion.on('subcommand', ({ before }: { before: string }) => COMMANDS[before] ?? []);

  completion.init();
}

export function createCompletionCommand(): Command {
  const cmd = new Command('completion').description('Shell tab-completion utilities.');

  cmd
    .command('install')
    .description('Install bash/zsh/fish completion to your shell config.')
    .action(async () => {
      // Surface which shell omelette will target so users can confirm
      // it picked the right rc file. omelette inspects $SHELL.
      const detectedShell = process.env['SHELL'] ?? '(unknown)';
      log.info(`Detected shell: ${detectedShell}`);
      if (process.platform === 'win32') {
        log.warn('Native Windows shells are not supported by omelette. Use WSL or Git Bash.');
      }

      try {
        const { default: omelette } = await import('omelette');
        const completion = omelette('kash');
        completion.setupShellInitFile();
        log.success('Shell completions installed.');
        log.info('Restart your shell or source your shell config to activate.');
      } catch (cause) {
        // Throw a typed CliError so the top-level boundary in
        // `index.ts` renders the JSON envelope in --json mode and
        // surfaces the catalog's `UNEXPECTED` action — instead of
        // hand-rolling `process.exit(1)`.
        throw new CliError('Failed to install shell completions.', {
          code: 'UNEXPECTED',
          suggestion: 'Verify your shell config is writable and rerun.',
          cause,
        });
      }
    });

  cmd
    .command('uninstall')
    .description('Remove kash completions from your shell config.')
    .action(async () => {
      try {
        const { default: omelette } = await import('omelette');
        const completion = omelette('kash');
        completion.cleanupShellInitFile();
        log.success('Shell completions removed.');
      } catch (cause) {
        throw new CliError('Failed to remove shell completions.', {
          code: 'UNEXPECTED',
          suggestion: 'Verify your shell config is writable and rerun.',
          cause,
        });
      }
    });

  return cmd;
}
