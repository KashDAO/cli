/**
 * Friendly-intro suggestions for the bare `kash` invocation.
 *
 * Hoisted out of `index.ts` so:
 *   1. The list is testable in isolation (without spinning up the
 *      full bare-invocation pipeline).
 *   2. Adding/removing curated suggestions doesn't churn the entry
 *      point.
 *   3. Both the human and `--json` renderers consume the same source
 *      of truth.
 */

export type IntroSuggestion = {
  /** Short label for human mode. */
  readonly title: string;
  /** Concrete command line a user can copy + run. */
  readonly command: string;
  /** One-sentence description of the suggestion. */
  readonly description: string;
};

/**
 * Curated 4-suggestion landing for the bare `kash` invocation. Tuned
 * for first-contact users and AI agents — covers (auth → discover →
 * trade → introspection).
 */
export const INTRO_SUGGESTIONS: readonly IntroSuggestion[] = [
  {
    title: 'Authenticate',
    command: 'kash setup',
    description: 'Interactive first-run wizard.',
  },
  {
    title: 'Browse markets',
    command: 'kash markets list --status ACTIVE',
    description: 'List active prediction markets.',
  },
  {
    title: 'Place a trade and wait',
    command: 'kash trade buy <market-id> --outcome 0 --amount 10 --wait',
    description: 'Buy outcome tokens, block on settlement.',
  },
  {
    title: 'For agents',
    command: 'kash docs --json --quiet',
    description:
      'Full machine-readable command surface. `--json --quiet` is the universal agent mode — every command emits a stable JSON envelope on stdout.',
  },
];

/** Dashboard URL surfaced alongside the suggestions. */
export const DOCS_URL = 'https://kash.bot/docs/cli';

export type IntroEnvelope = {
  readonly name: 'kash';
  readonly version: string;
  readonly docsUrl: string;
  readonly suggestions: readonly IntroSuggestion[];
  readonly hint: string;
};

/**
 * Compose the JSON-mode intro envelope. Pure function so callers
 * (and tests) can pin to the contract shape.
 */
export function buildIntroEnvelope(version: string): IntroEnvelope {
  return {
    name: 'kash',
    version,
    docsUrl: DOCS_URL,
    suggestions: INTRO_SUGGESTIONS,
    hint: 'Run `kash --help` for the full command list, or `kash docs --json --quiet` for the machine-readable surface (matches the agent suggestion above).',
  };
}
