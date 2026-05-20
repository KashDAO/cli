/**
 * packages/cli/README.md ↔ registered top-level commands drift.
 *
 * The README walks customers through dozens of `kash <top> <sub>`
 * invocations. The actual top-level surface is registered in
 * `packages/cli/src/index.ts` via `program.addCommand(...)`. If
 * anyone renames a top-level command (e.g. `trade` → `trades`) but
 * the README still shows the old name, every customer who copies the
 * documented invocation hits "unknown command". Same drift class as
 * round AH (bin name) and round AL (kash-admin bin name).
 *
 * The check is scoped to TOP-LEVEL command names — subcommand-level
 * drift is harder to drift accidentally (subcommands live in the
 * same files as their parent and share local PRs). The top-level
 * addCommand calls are the most exposed surface.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const INDEX_SOURCE = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8');
const README = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');

/**
 * Read ONLY the top-level command entry points (one level deep under
 * src/commands/). Each top-level lives at either
 * `src/commands/<top>.ts` or `src/commands/<top>/index.ts`. Deeper
 * files like `src/commands/protocol/trade.ts` are subcommand
 * implementations and may reuse variable names (e.g. tradeCommand
 * appears in both `trade/index.ts` AND `protocol/trade.ts`). Walking
 * the whole tree would shadow the top-level binding with whichever
 * file the iterator visits last.
 *
 * Returns `varName → cliName` for the top-level surface only. The
 * source-of-truth is the `new Command('<name>')` literal exported
 * from that entry point.
 */
function loadVarToCliName(): ReadonlyMap<string, string> {
  const root = resolve(packageRoot, 'src/commands');
  const out = new Map<string, string>();
  const RE = /export\s+const\s+(\w+)\s*=\s*new\s+Command\(\s*['"]([\w-]+)['"]/g;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    let filePath: string | null = null;
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      filePath = join(root, entry.name);
    } else if (entry.isDirectory()) {
      const indexPath = join(root, entry.name, 'index.ts');
      try {
        readFileSync(indexPath, 'utf8'); // existence probe
        filePath = indexPath;
      } catch {
        continue;
      }
    }
    if (filePath === null) continue;
    const src = readFileSync(filePath, 'utf8');
    for (const m of src.matchAll(RE)) {
      out.set(m[1]!, m[2]!);
    }
  }
  return out;
}

const VAR_TO_NAME = loadVarToCliName();

/**
 * Extract every variable passed to `program.addCommand(...)` in
 * src/index.ts. Factory-built additions like
 * `program.addCommand(buildDocsCommand(...))` capture the factory name
 * (`buildDocsCommand`) — those don't resolve via the var→name map and
 * are surfaced explicitly so the failure message names them.
 */
function extractRegisteredVars(source: string): readonly string[] {
  const out = new Set<string>();
  // Strip single-line comments first — a `// program.addCommand(foo)`
  // line should NOT count as a registered command. We process
  // line-by-line so block comments don't accidentally swallow
  // intervening code.
  const decommented = source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  for (const m of decommented.matchAll(/program\.addCommand\(\s*(\w+)/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

const REGISTERED_VARS = extractRegisteredVars(INDEX_SOURCE);

// Map each registered variable to its CLI-level name. Factory-built
// additions (buildDocsCommand etc.) fall back to a sentinel — the
// per-name assertion below tolerates them by also accepting the
// well-known factory names.
const FACTORY_TO_NAMES = new Map<string, readonly string[]>([
  ['buildDocsCommand', ['docs']],
  ['createCompletionCommand', ['completion']],
]);

const REGISTERED_NAMES = new Set<string>();
for (const v of REGISTERED_VARS) {
  const name = VAR_TO_NAME.get(v);
  if (name !== undefined) {
    REGISTERED_NAMES.add(name);
    continue;
  }
  for (const factoryName of FACTORY_TO_NAMES.get(v) ?? []) {
    REGISTERED_NAMES.add(factoryName);
  }
}

/**
 * Extract every `kash <token>` reference from the README. The regex
 * tolerates surrounding markdown (backticks, $ prompts, code fences)
 * and skips a few well-known noise tokens that look command-shaped
 * but aren't (`kash_live_…` in prose, partial-word matches at the
 * end of code-fence lines).
 */
function extractReadmeTopLevels(text: string): readonly string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bkash\s+([a-z][a-z-]+)\b/g)) {
    const cmd = m[1]!;
    // Noise filter — these are prose-tokens that pattern-match but
    // aren't actual subcommands.
    if (
      cmd.startsWith('kash_') ||
      cmd === 'live' ||
      cmd === 'test' ||
      // Sentence-fragment false-positives. Caught during round AY
      // bring-up when "you'll see the kash command print …" leaked
      // into the extraction. `command` and `su` (partial of `setup`)
      // are not real top-levels — pin them out explicitly.
      cmd === 'command' ||
      cmd === 'su'
    ) {
      continue;
    }
    out.add(cmd);
  }
  return [...out];
}

const README_TOP_LEVELS = extractReadmeTopLevels(README);

describe('packages/cli/README.md ↔ src/index.ts top-level command drift', () => {
  it('sanity floor: at least the load-bearing commands are registered', () => {
    expect(REGISTERED_NAMES.size).toBeGreaterThan(0);
    for (const required of ['auth', 'markets', 'trade', 'webhooks', 'config'] as const) {
      expect(
        REGISTERED_NAMES.has(required),
        `top-level command "${required}" must be registered in src/index.ts. ` +
          `Currently registered: ${[...REGISTERED_NAMES].sort().join(', ')}.`
      ).toBe(true);
    }
  });

  it('sanity floor: README references at least the load-bearing commands', () => {
    for (const required of ['auth', 'markets', 'webhooks'] as const) {
      expect(
        README_TOP_LEVELS.includes(required),
        `README must reference \`kash ${required}\``
      ).toBe(true);
    }
  });

  it.each(README_TOP_LEVELS.map((c) => [c] as const))(
    'README references "kash %s" — that top-level command is registered',
    (cmd) => {
      expect(
        REGISTERED_NAMES.has(cmd),
        `README references \`kash ${cmd}\` but no top-level command of that name is registered in src/index.ts. ` +
          `Registered top-levels: ${[...REGISTERED_NAMES].sort().join(', ')}. ` +
          `Either rename the README invocation, register the command, or (if "${cmd}" is a prose-token false positive) ` +
          `add it to the noise filter in extractReadmeTopLevels.`
      ).toBe(true);
    }
  );
});
