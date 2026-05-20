/**
 * Sync the CLI's `kash docs --json` output → one Mintlify `.mdx` page
 * per top-level command group, into the Kash docs site source tree.
 *
 * Source of truth is the CLI binary itself — `kash docs --json` returns
 * a machine-readable tree of every command, flag, argument, and
 * description. This script renders that tree as Markdown for
 * `https://docs.kash.bot/developer-docs/cli/`.
 *
 * Pipeline:
 *
 *     src/commands/*.ts            (commander.js definitions)
 *           │
 *           │  build
 *           ▼
 *     dist/index.js                ── `kash docs --json` ────────────┐
 *           │                                                        │
 *           │  ↓ this script consumes the JSON ↓                    │
 *           ▼                                                        │
 *     <KASH_DOCS_DIR>/developer-docs/cli/{group}.mdx ◀──────────────┘
 *           │
 *           │  Mintlify deploy
 *           ▼
 *     https://docs.kash.bot/developer-docs/cli/{group}
 *
 * `KASH_DOCS_DIR` defaults to a sibling `../docs` checkout; override
 * to point at any Mintlify-shaped docs tree. The script ALSO patches
 * `docs.json` to register every group page under the "CLI" navigation
 * group so the side nav reflects reality.
 *
 * This script is operator tooling — it's published to the public
 * mirror so contributors can audit how the docs site is generated,
 * but it's not part of the runtime CLI surface.
 *
 * Modes:
 *
 *   tsx scripts/sync-cli-docs.ts            # write the .mdx pages
 *   tsx scripts/sync-cli-docs.ts --check    # drift gate for CI / pre-commit
 *
 * Run from the package root.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const MONOREPO_ROOT = resolve(PKG_DIR, '..', '..');
const CLI_ENTRY = join(PKG_DIR, 'dist', 'index.js');
const DOCS_REPO_DIR = process.env['KASH_DOCS_DIR'] ?? resolve(MONOREPO_ROOT, '..', 'docs');
const OUT_DIR = join(DOCS_REPO_DIR, 'developer-docs', 'cli');
const DOCS_JSON = join(DOCS_REPO_DIR, 'docs.json');

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');

// ---------------------------------------------------------------------------
// 1. Run `kash docs --json` to get the canonical command tree
// ---------------------------------------------------------------------------

if (!existsSync(CLI_ENTRY)) {
  process.stderr.write(
    `sync-cli-docs: CLI dist not found at ${CLI_ENTRY}.\n` +
      `  Run \`pnpm --filter @kashdao/cli build\` first.\n`
  );
  process.exit(1);
}

interface CliOption {
  readonly flags: string;
  readonly long: string;
  readonly short?: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue: unknown;
}

interface CliArgument {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly description: string;
}

interface CliCommand {
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly arguments: readonly CliArgument[];
  readonly options: readonly CliOption[];
  readonly subcommands?: readonly CliCommand[];
}

let tree: CliCommand;
try {
  const out = execFileSync('node', [CLI_ENTRY, 'docs', '--json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  tree = JSON.parse(out) as CliCommand;
} catch (err) {
  process.stderr.write(
    `sync-cli-docs: failed to run \`kash docs --json\`: ${(err as Error).message}\n`
  );
  process.exit(1);
}

const topLevelGroups = (tree.subcommands ?? []).filter(
  (c) => c.subcommands && c.subcommands.length > 0
);
const topLevelLeaves = (tree.subcommands ?? []).filter(
  (c) => !c.subcommands || c.subcommands.length === 0
);

// ---------------------------------------------------------------------------
// 2. Render each top-level group to an MDX page
// ---------------------------------------------------------------------------

interface RenderedPage {
  readonly slug: string;
  readonly mdx: string;
}

function renderFlags(opts: readonly CliOption[]): string {
  if (opts.length === 0) return '';
  const lines: string[] = [
    '',
    '| Flag | Description |',
    '| --- | --- |',
    // `escapeCell()` must run on BOTH columns. The flag column can contain
    // a literal `|` (e.g. `--side <buy|sell>`) which would terminate the
    // markdown table cell early and corrupt the whole row — even when the
    // `|` sits inside a backtick code-span, because markdown tables apply
    // `|` splitting BEFORE code-span detection. Mintlify then silently
    // fails the page build instead of returning 404 — we caught this on
    // the cli/protocol page after a five-step bisect.
    ...opts.map((o) => `| \`${escapeCell(o.flags)}\` | ${escapeCell(o.description)} |`),
    '',
  ];
  return lines.join('\n');
}

function renderArgs(argv: readonly CliArgument[]): string {
  if (argv.length === 0) return '';
  const lines: string[] = [
    '',
    '**Arguments**',
    '',
    ...argv.map(
      (a) =>
        `- \`${a.name}\`${a.required ? '' : ' (optional)'}${
          a.variadic ? ' (variadic)' : ''
        } — ${a.description || '_no description_'}`
    ),
    '',
  ];
  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/**
 * Escape characters that break YAML frontmatter inside the `description`
 * field. Today that's just the apostrophe (since we wrap values in single
 * quotes). `@scope/name` references in Mintlify frontmatter look unusual
 * but are accepted by the build — verified by the working
 * `protocol-sdk/overview.mdx` page which uses the same token.
 */
function escapeFrontmatterDescription(s: string): string {
  return s.replace(/'/g, "\\'");
}

function renderSubcommand(cmd: CliCommand): string {
  const blocks: string[] = [];
  blocks.push(`### \`${cmd.fullName}\``, '');
  if (cmd.description) blocks.push(cmd.description, '');

  if (cmd.arguments.length > 0) blocks.push(renderArgs(cmd.arguments));
  if (cmd.options.length > 0) {
    blocks.push('', '**Options**');
    blocks.push(renderFlags(cmd.options));
  }

  // Nested subcommands (rare — only `protocol smart-account *` etc.).
  for (const sub of cmd.subcommands ?? []) {
    blocks.push(renderSubcommand(sub));
  }

  return blocks.join('\n');
}

function renderGroup(group: CliCommand): string {
  const title = group.name;
  const description = escapeFrontmatterDescription(group.description || `\`${group.fullName}\``);

  const lines: string[] = [
    `---`,
    `title: '${title}'`,
    `description: '${description}'`,
    `---`,
    '',
    group.description ? group.description : '',
    '',
    `> Generated from \`kash docs --json\`. Each command's behaviour is documented in-binary via \`${group.fullName} <subcommand> --help\` — this page is the structured reference.`,
    '',
    `## Usage`,
    '',
    '```bash',
    `${group.fullName} <subcommand> [options]`,
    '```',
    '',
    `## Subcommands`,
    '',
  ];

  for (const sub of group.subcommands ?? []) {
    lines.push(renderSubcommand(sub));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderLeaf(cmd: CliCommand): string {
  const description = escapeFrontmatterDescription(cmd.description || `\`${cmd.fullName}\``);
  const lines: string[] = [
    `---`,
    `title: '${cmd.name}'`,
    `description: '${description}'`,
    `---`,
    '',
    cmd.description,
    '',
    `> Generated from \`kash docs --json\`. Run \`${cmd.fullName} --help\` for full usage and examples.`,
    '',
    `## Usage`,
    '',
    '```bash',
    cmd.fullName +
      (cmd.arguments.length > 0
        ? ' ' + cmd.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')
        : '') +
      ' [options]',
    '```',
    '',
  ];

  if (cmd.arguments.length > 0) lines.push(renderArgs(cmd.arguments));
  if (cmd.options.length > 0) {
    lines.push('', '## Options', '');
    lines.push(renderFlags(cmd.options));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

const pages: RenderedPage[] = [];

for (const group of topLevelGroups) {
  pages.push({
    slug: group.name,
    mdx: renderGroup(group),
  });
}

for (const leaf of topLevelLeaves) {
  // Skip pseudo-commands.
  if (leaf.name === 'help') continue;
  pages.push({
    slug: leaf.name,
    mdx: renderLeaf(leaf),
  });
}

pages.sort((a, b) => a.slug.localeCompare(b.slug));

// ---------------------------------------------------------------------------
// 3. Drift check / write
// ---------------------------------------------------------------------------

let drift = 0;

if (checkMode) {
  for (const page of pages) {
    const path = join(OUT_DIR, `${page.slug}.mdx`);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== page.mdx) {
      drift++;
      process.stderr.write(`  ✗ drift: ${path}\n`);
    }
  }
  if (!existsSync(DOCS_JSON)) {
    process.stderr.write(`  ✗ docs.json missing at ${DOCS_JSON}\n`);
    drift++;
  } else {
    const docsJsonText = readFileSync(DOCS_JSON, 'utf8');
    for (const page of pages) {
      const relPath = `developer-docs/cli/${page.slug}`;
      if (!docsJsonText.includes(`"${relPath}"`)) {
        drift++;
        process.stderr.write(`  ✗ docs.json missing nav entry for cli/${page.slug}\n`);
      }
    }
  }
  if (drift > 0) {
    process.stderr.write(
      `\nsync-cli-docs: ${drift} drift item(s). Re-run without --check to fix.\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `sync-cli-docs: ✓ ${pages.length} pages match the CLI \`docs --json\` output.\n`
  );
  process.exit(0);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
for (const page of pages) {
  const path = join(OUT_DIR, `${page.slug}.mdx`);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing !== page.mdx) {
    writeFileSync(path, page.mdx);
    written++;
  }
}

// ---------------------------------------------------------------------------
// 4. Patch docs.json
// ---------------------------------------------------------------------------

if (!existsSync(DOCS_JSON)) {
  process.stderr.write(`sync-cli-docs: docs.json missing at ${DOCS_JSON}\n`);
  process.exit(1);
}

const docsJsonText = readFileSync(DOCS_JSON, 'utf8');
const docsJson = JSON.parse(docsJsonText) as {
  navigation: {
    tabs: Array<{
      tab: string;
      groups?: Array<{ group: string; pages: string[] }>;
    }>;
  };
};

const developerTab = docsJson.navigation.tabs.find((t) => t.tab === 'Developer Docs');
if (!developerTab || !developerTab.groups) {
  process.stderr.write(
    `sync-cli-docs: 'Developer Docs' tab with groups not found in docs.json — abort.\n`
  );
  process.exit(1);
}

const cliGroupName = 'CLI';
let group = developerTab.groups.find((g) => g.group === cliGroupName);
if (!group) {
  group = { group: cliGroupName, pages: [] };
  developerTab.groups.push(group);
}

// Keep `overview` first; then the auto-generated command pages alphabetically.
const overviewPage = 'developer-docs/cli/overview';
const commandPages = pages.map((p) => `developer-docs/cli/${p.slug}`);
group.pages = [overviewPage, ...commandPages];

const newDocsJsonText = JSON.stringify(docsJson, null, 2) + '\n';
if (newDocsJsonText !== docsJsonText) {
  writeFileSync(DOCS_JSON, newDocsJsonText);
}

process.stdout.write(
  `sync-cli-docs: ✓ wrote ${written} page(s); registered ${pages.length} in docs.json under '${cliGroupName}'.\n`
);
