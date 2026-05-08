/**
 * Invariant: the hand-maintained `COMMANDS` map in `completion.ts`
 * must match the actual command tree produced by `describeCommand`.
 *
 * Adding a subcommand without updating the map silently breaks shell
 * completion. This test catches the drift before it ships.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { describeCommand } from '../../src/commands/docs.js';

// Re-import the COMMANDS map. It's not exported from `completion.ts`
// to keep its surface minimal, so the test reaches in directly via
// the (currently sole) value-export path.
async function loadCompletionMap(): Promise<Record<string, string[]>> {
  // Reading the source file keeps the test honest: any change to the
  // map needs the actual file edit, not a mocked re-export.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const completionPath = resolve(here, '../../src/completion.ts');
  const source = readFileSync(completionPath, 'utf8');
  // Extract the literal `const COMMANDS: Record<string, string[]> = { … };`.
  const match = /const COMMANDS:[^=]+=\s*({[\s\S]+?\n});/.exec(source);
  if (!match) {
    throw new Error('Could not locate COMMANDS map in completion.ts');
  }
  // `eval` is intentional and contained: this is a test file, the
  // input is our own source, and we want the literal as JS.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-assignment
  const fn = new Function(`return ${match[1]!};`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return fn() as Record<string, string[]>;
}

/**
 * Build a tiny Commander program that mirrors the real binary's
 * top-level shape. We don't need to load every leaf — we just need
 * the names of the top-level groups and their direct subcommands,
 * which is exactly what `describeCommand` returns.
 */
async function realProgramTree(): Promise<{
  topLevelNames: ReadonlySet<string>;
  subcommandsByGroup: ReadonlyMap<string, readonly string[]>;
}> {
  // Lazy-load to avoid the program's preAction hooks running at
  // import time. We only need the static structure.
  //
  // Include EVERY top-level command the real binary registers, not
  // just a subset — the drift problem the test catches is "someone
  // added a new top-level group and forgot the COMMANDS map." A
  // partial program lets that drift through silently. Mirror
  // `src/index.ts`'s registration block.
  const { accountCommand } = await import('../../src/commands/account/index.js');
  const { authCommand } = await import('../../src/commands/auth/index.js');
  const { configCommand } = await import('../../src/commands/config/index.js');
  const { eoaCommand } = await import('../../src/commands/eoa/index.js');
  const { explainCommand } = await import('../../src/commands/explain.js');
  const { healthCommand } = await import('../../src/commands/health.js');
  const { marketsCommand } = await import('../../src/commands/markets/index.js');
  const { portfolioCommand } = await import('../../src/commands/portfolio/index.js');
  const { protocolCommand } = await import('../../src/commands/protocol/index.js');
  const { quoteCommand } = await import('../../src/commands/quote/index.js');
  const { schemaCommand } = await import('../../src/commands/schema.js');
  const { setupCommand } = await import('../../src/commands/setup.js');
  const { traceCommand } = await import('../../src/commands/trace.js');
  const { tradeCommand } = await import('../../src/commands/trade/index.js');
  const { versionCommand } = await import('../../src/commands/version.js');
  const { webhooksCommand } = await import('../../src/commands/webhooks/index.js');
  const { withRetryCommand } = await import('../../src/commands/with-retry.js');

  const program = new Command().name('kash');
  program.addCommand(accountCommand);
  program.addCommand(authCommand);
  program.addCommand(configCommand);
  program.addCommand(eoaCommand);
  program.addCommand(explainCommand);
  program.addCommand(healthCommand);
  program.addCommand(marketsCommand);
  program.addCommand(portfolioCommand);
  program.addCommand(protocolCommand);
  program.addCommand(quoteCommand);
  program.addCommand(schemaCommand);
  program.addCommand(setupCommand);
  program.addCommand(traceCommand);
  program.addCommand(tradeCommand);
  program.addCommand(versionCommand);
  program.addCommand(webhooksCommand);
  program.addCommand(withRetryCommand);

  const tree = describeCommand(program);
  const topLevel = new Set(tree.subcommands.map((s) => s.name));
  const byGroup = new Map<string, readonly string[]>();
  for (const sub of tree.subcommands) {
    byGroup.set(
      sub.name,
      sub.subcommands.map((s) => s.name)
    );
  }
  return { topLevelNames: topLevel, subcommandsByGroup: byGroup };
}

describe('docs/completion parity', () => {
  it('every top-level command in the tree has a COMMANDS entry', async () => {
    const map = await loadCompletionMap();
    const { topLevelNames } = await realProgramTree();

    // `docs` is built dynamically via buildDocsCommand and not in our
    // simplified local program; skip it here. Same for `completion`,
    // which is the wrapper we're testing — it self-references in the
    // map.
    for (const name of topLevelNames) {
      expect(map, `missing COMMANDS["${name}"]`).toHaveProperty(name);
    }
  });

  it('every grouped subcommand matches the real Commander tree', async () => {
    const map = await loadCompletionMap();
    const { subcommandsByGroup } = await realProgramTree();

    for (const [group, real] of subcommandsByGroup) {
      const completion = map[group];
      if (completion === undefined) continue; // top-level scalar covered above
      // A leaf with no subcommands has [] in both places.
      expect(new Set(completion)).toEqual(new Set(real));
    }
  });
});
