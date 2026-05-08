#!/usr/bin/env node
/**
 * Generate a Markdown command reference for `@kashdao/cli`.
 *
 * Mirrors the role of `pnpm docs` in the sibling `@kashdao/sdk` and
 * `@kashdao/protocol-sdk` packages — except instead of TypeDoc (which
 * has nothing useful to document for a binary) we render the live
 * command tree the binary itself exposes via `kash docs --json`. This
 * keeps the generated reference perfectly in sync with the actual CLI:
 * every command, argument, option, alias, and default value the binary
 * exposes is what the doc lists.
 *
 * Output: `docs/COMMANDS.md` — flat, GitHub-renderable, headings deep-
 * linkable. Suitable to ship to a docs site (docs.kash.bot/cli) or read
 * directly on GitHub.
 *
 * Run:
 *   pnpm docs
 *   # or, equivalently:
 *   node scripts/generate-docs.mjs
 *
 * Requires the binary to be built (`pnpm build` first). The npm script
 * sequences this for you.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const DIST_ENTRY = join(PKG_DIR, 'dist', 'index.js');
const OUT_DIR = join(PKG_DIR, 'docs');
const OUT_FILE = join(OUT_DIR, 'COMMANDS.md');

if (!existsSync(DIST_ENTRY)) {
  console.error(`ERROR: ${DIST_ENTRY} does not exist. Run \`pnpm build\` first.`);
  process.exit(1);
}

console.log('→ invoking kash docs --json');
const result = spawnSync(process.execPath, [DIST_ENTRY, 'docs', '--json'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KASH_QUIET: '1',
  },
});
if (result.status !== 0) {
  console.error(`ERROR: \`kash docs --json\` exited with status ${result.status}`);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

/** @typedef {{
 *   flags: string,
 *   long?: string,
 *   short?: string,
 *   aliases: readonly string[],
 *   description: string,
 *   required: boolean,
 *   optional: boolean,
 *   defaultValue?: unknown,
 *   choices?: readonly string[],
 * }} Option
 */
/** @typedef {{
 *   name: string,
 *   required: boolean,
 *   variadic: boolean,
 *   description: string,
 * }} Argument
 */
/** @typedef {{
 *   name: string,
 *   fullName: string,
 *   description: string,
 *   aliases: readonly string[],
 *   arguments: readonly Argument[],
 *   options: readonly Option[],
 *   subcommands: readonly Command[],
 * }} Command
 */

const tree = JSON.parse(result.stdout);

const lines = [];

lines.push('# `kash` — command reference', '');
lines.push(
  '> **This file is auto-generated** by `scripts/generate-docs.mjs` from the live ',
  '> output of `kash docs --json`. Do not hand-edit. Regenerate with `pnpm docs` ',
  '> after any command-tree change.',
  ''
);
lines.push(
  'Every command, flag, argument, alias, and default value below is sourced ',
  'directly from the built binary, so the doc cannot drift from runtime ',
  'behaviour. For machine-readable use, prefer `kash docs --json` itself; this ',
  'file is for humans and search-engine indexing.',
  ''
);
lines.push('## Top-level usage', '');
lines.push('```sh');
lines.push(`${tree.fullName} [global flags] <command> [args]`);
lines.push('```', '');

if (tree.options && tree.options.length) {
  lines.push('### Global flags', '');
  lines.push(...renderOptionsTable(tree.options));
  lines.push('');
}

lines.push('## Commands', '');
for (const cmd of (tree.subcommands ?? []).filter((c) => c.name !== 'help')) {
  renderCommand(cmd, 3);
}

writeOutput();
console.log(`✓ wrote ${OUT_FILE}`);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * @param {Command} cmd
 * @param {number} depth — heading depth (## = 2, ### = 3 …)
 */
function renderCommand(cmd, depth) {
  const heading = '#'.repeat(Math.min(depth, 6));
  lines.push(`${heading} \`${cmd.fullName}\``, '');
  if (cmd.description) {
    lines.push(cmd.description, '');
  }
  if (cmd.aliases?.length) {
    lines.push(`**Aliases:** ${cmd.aliases.map((a) => `\`${a}\``).join(', ')}`, '');
  }
  if (cmd.arguments?.length) {
    lines.push('**Arguments**', '');
    for (const arg of cmd.arguments) {
      const decoration = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
      const variadic = arg.variadic ? ' …' : '';
      const desc = arg.description ? ` — ${arg.description}` : '';
      lines.push(`- \`${decoration}${variadic}\`${desc}`);
    }
    lines.push('');
  }
  if (cmd.options?.length) {
    lines.push('**Options**', '');
    lines.push(...renderOptionsTable(cmd.options));
    lines.push('');
  }
  for (const sub of (cmd.subcommands ?? []).filter((c) => c.name !== 'help')) {
    renderCommand(sub, depth + 1);
  }
}

/** @param {readonly Option[]} options */
function renderOptionsTable(options) {
  const rows = ['| Flag | Description | Default |', '| --- | --- | --- |'];
  for (const opt of options) {
    const flag = `\`${opt.flags}\``;
    const desc = (opt.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    let dflt = '';
    if (opt.defaultValue !== undefined && opt.defaultValue !== null && opt.defaultValue !== '') {
      dflt = `\`${JSON.stringify(opt.defaultValue)}\``;
    }
    rows.push(`| ${flag} | ${desc} | ${dflt} |`);
  }
  return rows;
}

function writeOutput() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, lines.join('\n') + '\n');
}
