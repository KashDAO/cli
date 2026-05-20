/**
 * `kash auth set-key [key]` — store an API key in `~/.kash/config.json`.
 *
 * Three input paths, each leaves no trace of the key in shell history:
 *
 *   1. Positional `<key>` — convenient for one-off use, but shows up
 *      in `~/.bash_history`. Kept for backward compat.
 *   2. `--from-stdin` — pipe a key from a secret-store (`pass kash`,
 *      `1password read`, `aws secretsmanager`, …). The key is
 *      `.trim()`-ed so trailing newlines from the source are ignored.
 *   3. Interactive prompt (no positional, no flag, TTY available) —
 *      reads from stderr-bound readline so the prompt doesn't taint
 *      stdout pipes. Single newline of input.
 *
 * Validates the prefix client-side (the SDK's config schema enforces
 * the same shape, but failing here gives a clearer error than the
 * generic config error chain). The persisted file is `0600`.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { setCurrentProfile, updateConfig } from '../../utils/config-store.js';
import { redact } from '../../utils/formatting.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, printJson } from '../../utils/output.js';

type SetKeyOptions = {
  fromStdin?: boolean;
  activate?: boolean;
};

export const setKeyCommand = new Command('set-key')
  .description('Store an API key in ~/.kash/config.json (mode 0600).')
  .argument('[key]', 'API key starting with "kash_" (omit to read from stdin or prompt)')
  .option('--from-stdin', 'read the key from stdin (preferred for secret-store integration)')
  .option(
    '--activate',
    "also switch the active profile to the one being written (default: leave the active profile unchanged — `kash auth set-key --profile staging` updates 'staging' but doesn't make it active; pass --activate or run `kash config use staging` separately)"
  )
  .addHelpText(
    'after',
    `
Examples:
  # Interactive prompt (no shell history footprint).
  $ kash auth set-key

  # Pipe from a secret store.
  $ pass show kash/api-key | kash auth set-key --from-stdin
  $ op read "op://Private/kash/api-key" | kash auth set-key --from-stdin

  # Positional (convenient but shows up in ~/.bash_history).
  $ kash auth set-key kash_live_abc...
  $ kash auth set-key kash_test_abc... --profile staging
`
  )
  .action(async (positional: string | undefined, options: SetKeyOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    const key = await resolveKey(positional, options);

    if (!key.startsWith('kash_')) {
      throw new CliValidationError(
        'API keys must start with "kash_".',
        'Request a `kash_test_*` staging key by emailing `engineering@kash.bot` with your intended use case. Self-service issuance and `kash_live_*` keys land with the production launch.'
      );
    }
    let result;
    try {
      result = await updateConfig(
        { apiKey: key },
        {
          ...(globals.profile === undefined ? {} : { profile: globals.profile }),
          ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
        }
      );
      // `--activate` flips the file's `currentProfile` so the next
      // command picks up this profile without needing
      // `kash config use <name>`. Mirrors the all-in-one wizard
      // behaviour of `kash setup`.
      if (options.activate === true) {
        await setCurrentProfile(
          result.profile,
          globals.configPath === undefined ? undefined : { configPath: globals.configPath }
        );
      }
    } catch (cause) {
      throw toCliError(cause);
    }

    if (globals.json) {
      // Surface the actually-written profile (resolved from --profile,
      // KASH_PROFILE, file's currentProfile, or "default") so the JSON
      // contract reports truth, not the unresolved flag value.
      printJson({
        ok: true,
        apiKey: redact(key),
        profile: result.profile,
        // Whether this run also flipped the file's currentProfile.
        // Agents driving multi-profile workflows can chain off this
        // to know if a follow-up `kash config use` is needed.
        activated: options.activate === true,
      });
      return;
    }
    log.success(`API key saved to profile "${result.profile}" (${redact(key)}).`);
    log.detail('Location', globals.configPath ?? '~/.kash/config.json (mode 0600)');
    if (options.activate === true) {
      log.success(`Active profile is now "${result.profile}".`);
    }
  });

/**
 * Resolve the API key from the three supported sources. Order:
 *   1. Positional argument (legacy, less secure — still works).
 *   2. `--from-stdin` (read until EOF, trim, single key per stream).
 *   3. Interactive prompt (TTY only).
 *
 * **Mutual-exclusion guard.** Pre-fix, `kash auth set-key <key>
 * --from-stdin` silently used the positional and dropped the piped
 * secret. That's a real footgun: the operator sees "API key saved"
 * for the WRONG key (the one on argv, possibly a stale value from
 * shell history). We refuse to guess and require the operator to
 * pick one source.
 */
async function resolveKey(positional: string | undefined, options: SetKeyOptions): Promise<string> {
  if (positional !== undefined && positional !== '' && options.fromStdin === true) {
    throw new CliValidationError(
      'Pass either the positional <key> OR --from-stdin, not both.',
      'The positional key would silently win and the piped value would be dropped.'
    );
  }
  if (positional !== undefined && positional !== '') {
    return positional;
  }
  if (options.fromStdin === true) {
    return readFromStdin();
  }
  if (process.stdin.isTTY) {
    return promptInteractively();
  }
  // No positional, no --from-stdin, no TTY — caller's intent is
  // ambiguous. Surface a clear validation error rather than reading
  // stdin silently (which would surprise CI runs that pipe other
  // data into the command).
  throw new CliValidationError(
    'No API key provided.',
    'Pass the key positionally, use --from-stdin to read it from a pipe, or run interactively for a prompt.'
  );
}

async function readFromStdin(): Promise<string> {
  // Use the shared BOM-aware reader. Notepad-saved files (and VSCode
  // with `files.encoding=utf8bom`) prepend U+FEFF; without the strip,
  // the leading three bytes leak into the API key and fail the
  // `kash_` prefix check.
  const { readStdinTrimmed } = await import('../../utils/stdin.js');
  return readStdinTrimmed();
}

async function promptInteractively(): Promise<string> {
  // Use the masked-input prompt so the key never echoes to the
  // terminal (defends against shoulder-surfing, screen recordings,
  // and scroll-back capture). The previous `readline.question` path
  // echoed every keystroke which defeated the "no shell history"
  // promise of this command. Lazy-load `@inquirer/prompts` to keep
  // it off the cold path for non-interactive invocations.
  const { password } = await import('@inquirer/prompts');
  const answer = await password({
    message: 'Paste your API key (kash_live_… or kash_test_…):',
    mask: '*',
  });
  return answer.trim();
}
