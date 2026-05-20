/**
 * CLI README internal anchor links ↔ heading slugs.
 *
 * Mirrors round BP for the SDK — same pattern, applied to the CLI
 * README. The TOC + inline section pointers MUST slug correctly
 * against the actual headings, or GitHub renders broken anchors
 * (live blue text but click-to-nowhere).
 *
 * Round BP found two broken anchors in the SDK README from the
 * `&` slugification gotcha (heading "Rate limits & retries" slugs
 * to `rate-limits-retries` — single dash — but the TOC had
 * `#rate-limits--retries` with double dash). This round runs the
 * same check on the CLI README.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));
const README = readFileSync(README_PATH, 'utf8');

/**
 * GitHub-flavoured slugifier. Identical algorithm to round BP.
 *
 *   1. Lowercase
 *   2. Strip backticks (heading code-fences)
 *   3. Strip any non-word, non-whitespace, non-dash char (`&`, `/`,
 *      `:`, etc.)
 *   4. Collapse whitespace runs to single dash
 *   5. Collapse dash runs to single dash
 *   6. Trim leading/trailing dashes
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractHeadingSlugs(text: string): readonly string[] {
  const slugs = new Set<string>();
  let inCodeFence = false;
  for (const rawLine of text.split('\n')) {
    if (/^```/.test(rawLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(rawLine);
    if (!m) continue;
    slugs.add(slugify(m[2]!));
  }
  return [...slugs];
}

function extractAnchorReferences(text: string): readonly string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(#([a-z][\w-]*)\)/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

const HEADING_SLUGS = new Set(extractHeadingSlugs(README));
const ANCHOR_REFS = extractAnchorReferences(README);

describe('packages/cli/README.md ↔ heading anchor links validity', () => {
  it('sanity floor: README has heading slugs and anchor references', () => {
    expect(HEADING_SLUGS.size).toBeGreaterThanOrEqual(5);
    expect(ANCHOR_REFS.length).toBeGreaterThanOrEqual(5);
    // Anchor a few load-bearing CLI README sections.
    for (const required of ['install', 'commands', 'configuration-reference'] as const) {
      expect(
        HEADING_SLUGS.has(required),
        `README must have a heading slugged "${required}". ` +
          `Current slugs: ${[...HEADING_SLUGS].sort().join(', ')}.`
      ).toBe(true);
    }
  });

  it.each([...ANCHOR_REFS].sort().map((a) => [a] as const))(
    'README anchor "#%s" resolves to a real heading slug',
    (anchor) => {
      expect(
        HEADING_SLUGS.has(anchor),
        `README references "#${anchor}" but no heading on this page slugs to that anchor. ` +
          `Either rename the link to match an existing heading, or restore the heading. ` +
          `Available heading slugs: ${[...HEADING_SLUGS].sort().join(', ')}.`
      ).toBe(true);
    }
  );
});
