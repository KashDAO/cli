/**
 * Unit tests for the bare-invocation intro module. Pure data + pure
 * envelope-builder, no IO — exercised in isolation here so the
 * `index.ts` short-circuit doesn't have to be the only place that
 * ever sees this contract.
 */

import { describe, expect, it } from 'vitest';

import {
  buildIntroEnvelope,
  DOCS_URL,
  INTRO_SUGGESTIONS,
  type IntroSuggestion,
} from '../../../src/utils/intro.js';

describe('INTRO_SUGGESTIONS', () => {
  it('exposes exactly four curated entries (auth/discover/trade/agent)', () => {
    expect(INTRO_SUGGESTIONS).toHaveLength(4);
  });

  it('every entry has a non-empty title, command, and description', () => {
    for (const s of INTRO_SUGGESTIONS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.command.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('every command starts with `kash ` (single binary contract)', () => {
    for (const s of INTRO_SUGGESTIONS) {
      expect(s.command.startsWith('kash ')).toBe(true);
    }
  });

  it('the agent-focused suggestion points at `kash docs --json`', () => {
    // Load-bearing for the README's "AI agent surface" claim.
    const agent = INTRO_SUGGESTIONS.find((s) => s.title.toLowerCase().includes('agent'));
    expect(agent).toBeDefined();
    expect(agent?.command).toContain('docs');
    expect(agent?.command).toContain('--json');
  });
});

describe('buildIntroEnvelope', () => {
  it('emits the stable JSON envelope shape', () => {
    const env = buildIntroEnvelope('1.2.3');
    expect(env.name).toBe('kash');
    expect(env.version).toBe('1.2.3');
    expect(env.docsUrl).toBe(DOCS_URL);
    expect(env.suggestions).toBe(INTRO_SUGGESTIONS); // same reference — no copy
    expect(typeof env.hint).toBe('string');
  });

  it('hint mentions both `--help` and `docs --json` so agents see both paths', () => {
    const env = buildIntroEnvelope('1.0.0');
    expect(env.hint).toContain('--help');
    expect(env.hint).toContain('docs --json');
  });

  it('serialises to JSON without throwing or producing functions', () => {
    const env = buildIntroEnvelope('0.0.0');
    const serialised = JSON.stringify(env);
    const parsed = JSON.parse(serialised) as { suggestions: IntroSuggestion[] };
    expect(parsed.suggestions).toHaveLength(INTRO_SUGGESTIONS.length);
  });
});
