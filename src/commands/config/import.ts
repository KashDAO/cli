/**
 * `kash config import` — merge a config bundle (produced by
 * `kash config export`) into the local config file.
 *
 * **Source.** Reads from `<file>` argument, or stdin when no argument
 * is given. The input must match the v1 file shape; anything else is
 * rejected as INVALID_INPUT.
 *
 * **Merge policy.** Profiles in the imported file are merged into the
 * existing profiles map. By default, existing profiles with the same
 * name are OVERWRITTEN. Pass `--no-overwrite` to skip those — useful
 * when restoring a backup against a partial config.
 *
 * **Redaction guard.** Profiles whose `apiKey` is still the literal
 * marker (`<redacted>` from `config export` without
 * `--include-secrets`) are refused with a clear error. We don't want
 * to silently overwrite a working key with a placeholder string.
 *
 * **currentProfile.** If the imported file specifies a
 * `currentProfile`, we use it — but only if that profile actually
 * lands in the merged file. Otherwise we keep the existing
 * `currentProfile` unchanged.
 */

import { readFile } from 'node:fs/promises';

import { Command } from 'commander';

import { CliError, toCliError } from '../../errors.js';
import {
  cliFileSchema,
  readWholeFile,
  writeWholeFile,
  type CliFile,
  type CliConfig,
} from '../../utils/config-store.js';
import { readGlobals } from '../../utils/global-options.js';
import { log, print, printJson, style } from '../../utils/output.js';

import { REDACTED_API_KEY_MARKER } from './export.js';

type ImportOptions = {
  // Commander stores `--no-overwrite` as `{ overwrite: false }` —
  // the default for a `--no-X` boolean option is `true`, so the
  // explicit `false` means the user passed `--no-overwrite`.
  overwrite?: boolean;
  dryRun?: boolean;
};

export const importConfigCommand = new Command('import')
  .description('Merge a `kash config export` bundle into the local config (mode 0600).')
  .argument('[file]', 'path to a JSON bundle (omit to read from stdin)')
  .option('--no-overwrite', 'skip profiles whose name already exists locally')
  .option('--dry-run', 'preview the merge without writing to disk')
  .addHelpText(
    'after',
    `
Examples:
  $ kash config import kash.json
  $ kash config export --include-secrets | ssh prod-host kash config import
  $ kash config import kash.json --no-overwrite       # never replace existing profiles
  $ kash config import kash.json --dry-run --json     # preview the merged result

Notes:
  - The input format is exactly what \`kash config export\` produces.
  - Profiles whose apiKey is still \`${REDACTED_API_KEY_MARKER}\` are refused — re-export
    with --include-secrets to get a round-trippable bundle.
  - --dry-run emits the merged file shape without persisting it. Useful
    for diffing against the on-disk file before committing to a write.
`
  )
  .action(async (file: string | undefined, options: ImportOptions, cmd: Command) => {
    const globals = readGlobals(cmd);
    try {
      const raw = await readSource(file);
      // Redaction check runs first on the raw JSON so users get the
      // "you exported without --include-secrets" message rather than
      // a generic schema-validation error (because `<redacted>`
      // doesn't match the `kash_` prefix the schema enforces).
      validateRedactionRaw(raw);
      const parsed = parseAndValidate(raw);

      const existing = await readWholeFile({
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });
      const merged = mergeFiles(existing, parsed, options.overwrite === false);

      if (options.dryRun === true) {
        if (globals.json) {
          printJson({ merged, written: false });
        } else {
          log.info('Dry run — no changes written.');
          print(JSON.stringify(merged, null, 2));
        }
        return;
      }

      await writeWholeFile(merged, {
        ...(globals.configPath === undefined ? {} : { configPath: globals.configPath }),
      });

      if (globals.json) {
        printJson({
          merged,
          written: true,
          profiles: Object.keys(merged.profiles).sort(),
          currentProfile: merged.currentProfile ?? null,
        });
        return;
      }

      const importedNames = Object.keys(parsed.profiles);
      const merged_n = Object.keys(merged.profiles).length;
      log.success(
        `Imported ${String(importedNames.length)} profile(s); local config now has ${String(merged_n)} profile(s).`
      );
      if (merged.currentProfile) {
        log.info(`Active profile: ${style.bold(merged.currentProfile)}`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });

async function readSource(file: string | undefined): Promise<string> {
  if (file !== undefined) {
    try {
      return await readFile(file, 'utf8');
    } catch (cause) {
      throw new CliError(`Failed to read ${file}.`, {
        code: 'CONFIGURATION',
        recoverable: true,
        suggestion: 'Verify the path exists and is readable.',
        cause,
      });
    }
  }
  // No file: read from stdin. process.stdin is async iterable in Node 22+.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    // process.stdin emits Buffer in binary streams and string in
    // text mode; coerce both into Buffer so concat is well-typed.
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Buffer) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
  }
  if (chunks.length === 0) {
    throw new CliError('No input received on stdin.', {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion: 'Pass a path argument or pipe a `kash config export` bundle into stdin.',
    });
  }
  // Strip a leading UTF-8 BOM. Notepad / VSCode-with-utf8bom and many
  // Windows tools prepend U+FEFF to UTF-8 files; without the strip,
  // `JSON.parse` chokes on the leading non-whitespace character.
  const { stripBom } = await import('../../utils/stdin.js');
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}

function parseAndValidate(raw: string): CliFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CliError('Input is not valid JSON.', {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion:
        'The bundle must match the output of `kash config export`. Re-run that command and pipe the result.',
      cause,
    });
  }
  const result = cliFileSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new CliError(
      `Input does not match the config file shape${
        first ? `: ${first.path.join('.')}: ${first.message}` : '.'
      }`,
      {
        code: 'INVALID_INPUT',
        recoverable: true,
        suggestion: 'Re-export from a known-good machine via `kash config export`.',
      }
    );
  }
  return result.data;
}

/**
 * Cheap raw-text scan for the redaction marker before strict schema
 * validation runs. The marker is a literal sentinel that real API
 * keys can't collide with (real keys start with `kash_`), so a
 * substring check is safe.
 */
function validateRedactionRaw(raw: string): void {
  if (raw.includes(`"apiKey": "${REDACTED_API_KEY_MARKER}"`)) {
    throw new CliError('Bundle contains redacted API keys — cannot import.', {
      code: 'INVALID_INPUT',
      recoverable: true,
      suggestion:
        'Re-run `kash config export --include-secrets` on the source machine to produce a round-trippable bundle.',
    });
  }
}

function mergeFiles(existing: CliFile, incoming: CliFile, noOverwrite: boolean): CliFile {
  const profiles: Record<string, CliConfig> = { ...existing.profiles };
  for (const [name, profile] of Object.entries(incoming.profiles)) {
    if (noOverwrite && name in profiles) continue;
    profiles[name] = profile;
  }

  // Decide currentProfile: incoming wins only if it points at a real
  // profile post-merge. Otherwise keep the existing setting.
  let currentProfile = existing.currentProfile;
  if (incoming.currentProfile && incoming.currentProfile in profiles) {
    currentProfile = incoming.currentProfile;
  }

  return {
    version: 1,
    ...(currentProfile === undefined ? {} : { currentProfile }),
    profiles,
  };
}
