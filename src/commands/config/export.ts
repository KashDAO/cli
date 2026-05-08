/**
 * `kash config export` — dump the entire multi-profile config to
 * stdout (or a file via `--out`).
 *
 * **Default redaction.** API keys are replaced with the literal string
 * `<redacted>` so the dump is safe to commit to a shared bucket or
 * paste into a support ticket. Pass `--include-secrets` to opt into
 * round-trippable export (e.g. moving a profile to a new machine).
 *
 * **Round-trip pairing.** Output of this command is the canonical
 * input for `kash config import`. The file format mirrors the
 * on-disk shape: `{ version: 1, currentProfile, profiles: {...} }`.
 */

import { writeFile } from 'node:fs/promises';

import { Command } from 'commander';

import { CliError, toCliError } from '../../errors.js';
import { readWholeFile, type CliFile, type CliConfig } from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson } from '../../utils/output.js';

const REDACTED = '<redacted>';

type ExportOptions = {
  out?: string;
  includeSecrets?: boolean;
};

export const exportConfigCommand = new Command('export')
  .description('Dump the entire multi-profile config (API keys redacted by default).')
  .option('-o, --out <path>', 'write to a file instead of stdout (mode 0600)')
  .option('--include-secrets', 'include raw API keys in the export (round-trippable)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config export                                    # safe-by-default; redacted JSON to stdout
  $ kash config export --out kash-config.json             # write to a file (mode 0600)
  $ kash config export --include-secrets --out kash.json  # round-trippable (DO NOT commit)

Notes:
  - Without --include-secrets, every \`apiKey\` is replaced with \`${REDACTED}\` —
    safe to commit and share for debugging without leaking credentials.
  - The output is the canonical input for \`kash config import\`. Imports
    refuse to apply a profile whose apiKey is still \`${REDACTED}\`.
  - Use --out to route to a file the CLI can write at mode 0600. Stdout
    inherits whatever umask the parent shell has.
`
  )
  .action(async (options: ExportOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    try {
      const file = await readWholeFile({
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });

      // Walk every profile and redact apiKey unless the caller asked
      // to include secrets. Other direct-mode fields (rpcUrl,
      // smartAccount, bundlerUrl, signerKeyRef) are kept as-is —
      // they're configuration, not secrets. Raw private keys never
      // live in the config (signerKeyRef is a `file:`/`env:` pointer).
      const sanitized: CliFile = {
        ...file,
        profiles: Object.fromEntries(
          Object.entries(file.profiles).map(([name, profile]) => [
            name,
            sanitizeProfile(profile, options.includeSecrets ?? false),
          ])
        ),
      };

      const payload = JSON.stringify(sanitized, null, 2);

      if (options.out) {
        try {
          await writeFile(options.out, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
          if (!globals.json) {
            log.success(`Wrote ${options.out} (mode 0600).`);
            if (!options.includeSecrets) {
              log.info(
                `Secrets redacted. Pass --include-secrets to produce a round-trippable export.`
              );
            }
          }
        } catch (cause) {
          throw new CliError(`Failed to write ${options.out}.`, {
            code: 'CONFIGURATION',
            recoverable: true,
            suggestion: 'Verify the path is writable and the parent directory exists.',
            cause,
          });
        }
        return;
      }

      // No --out: dump JSON to stdout. Honor --json by emitting the
      // file shape (same payload, but routed through printJson so
      // pretty/compact respects --quiet). Without --json we still emit
      // JSON because that's the only sensible export format — but skip
      // the human-mode banner.
      if (globals.json) {
        printJson(sanitized);
      } else {
        // Plain stdout. Append a header to stderr (so it doesn't
        // pollute the JSON pipe) noting the redaction policy.
        if (!options.includeSecrets) {
          log.info(`API keys redacted. Pass --include-secrets for round-trippable export.`);
        }
        print(payload);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

function sanitizeProfile(profile: CliConfig, includeSecrets: boolean): CliConfig {
  if (includeSecrets) return profile;
  if (profile.apiKey === undefined) return profile;
  // Use a marker the importer can detect; real keys never collide
  // because they all start with `kash_`.
  return { ...profile, apiKey: REDACTED };
}

export { REDACTED as REDACTED_API_KEY_MARKER };
