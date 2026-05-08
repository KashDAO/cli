/**
 * Unit tests for `--fields` projection helpers.
 *
 * These tests exercise `parseFieldsList` (input validation) and
 * `projectFields` (the actual projection logic) directly. The
 * integration with `printJson` / `writeNdjson` is covered separately
 * by component tests against commands that emit JSON.
 */

import { describe, expect, it } from 'vitest';

import { CliValidationError } from '../../src/errors.js';
import { parseFieldsList, projectFields } from '../../src/utils/fields.js';

describe('parseFieldsList', () => {
  it('parses a single top-level field', () => {
    expect(parseFieldsList('id')).toEqual([['id']]);
  });

  it('parses a comma-separated list', () => {
    expect(parseFieldsList('id,title,status')).toEqual([['id'], ['title'], ['status']]);
  });

  it('parses dot-segmented nested paths', () => {
    expect(parseFieldsList('outcomes.label')).toEqual([['outcomes', 'label']]);
    expect(parseFieldsList('a.b.c')).toEqual([['a', 'b', 'c']]);
  });

  it('tolerates surrounding whitespace per entry', () => {
    expect(parseFieldsList(' id , title , outcomes.label ')).toEqual([
      ['id'],
      ['title'],
      ['outcomes', 'label'],
    ]);
  });

  it('rejects an empty string with INVALID_INPUT', () => {
    expect(() => parseFieldsList('')).toThrow(CliValidationError);
    expect(() => parseFieldsList('   ')).toThrow(CliValidationError);
  });

  it('rejects empty entries (leading/trailing/double commas)', () => {
    expect(() => parseFieldsList(',id')).toThrow(/empty entry/);
    expect(() => parseFieldsList('id,')).toThrow(/empty entry/);
    expect(() => parseFieldsList('id,,title')).toThrow(/empty entry/);
  });

  it('rejects bad segments (numbers-first, special chars, jq-style splay)', () => {
    expect(() => parseFieldsList('1id')).toThrow(/invalid segment/);
    expect(() => parseFieldsList('id-with-dash')).toThrow(/invalid segment/);
    expect(() => parseFieldsList('outcomes[].label')).toThrow(/invalid segment/);
    expect(() => parseFieldsList('outcomes.[*].label')).toThrow(/invalid segment/);
  });

  it('attaches the `fields` field name to validation errors via check_input action', () => {
    try {
      parseFieldsList('1bad');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliValidationError);
      const cliErr = err as CliValidationError;
      const checkInput = cliErr.actions.find((a) => a.type === 'check_input');
      expect(checkInput).toBeDefined();
      expect(checkInput && checkInput.type === 'check_input' ? checkInput.field : null).toBe(
        'fields'
      );
    }
  });
});

describe('projectFields', () => {
  it('returns the value unchanged when paths is empty', () => {
    const v = { id: 1, title: 'x' };
    expect(projectFields(v, [])).toBe(v);
  });

  it('passes through null / undefined', () => {
    expect(projectFields(null, [['id']])).toBe(null);
    expect(projectFields(undefined, [['id']])).toBe(undefined);
  });

  it('narrows a single object to the requested fields', () => {
    const value = { id: '1', title: 'Trump 2028', status: 'ACTIVE', extra: 'noise' };
    expect(projectFields(value, parseFieldsList('id,title'))).toEqual({
      id: '1',
      title: 'Trump 2028',
    });
  });

  it('drops missing fields silently (no nulls inserted)', () => {
    const value = { id: '1' };
    expect(projectFields(value, parseFieldsList('id,doesNotExist'))).toEqual({ id: '1' });
  });

  it('projects a paginated envelope by narrowing each entry in `data`', () => {
    const value = {
      data: [
        { id: '1', title: 'A', status: 'ACTIVE' },
        { id: '2', title: 'B', status: 'RESOLVED' },
      ],
      pagination: { hasMore: false, cursor: null },
    };
    const projected = projectFields(value, parseFieldsList('id,status')) as Record<string, unknown>;
    expect(projected.data).toEqual([
      { id: '1', status: 'ACTIVE' },
      { id: '2', status: 'RESOLVED' },
    ]);
    // pagination passes through unchanged
    expect(projected.pagination).toEqual({ hasMore: false, cursor: null });
  });

  it('projects a bare array element-wise', () => {
    const value = [
      { id: 'a', x: 1 },
      { id: 'b', x: 2 },
    ];
    expect(projectFields(value, parseFieldsList('id'))).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('groups sibling sub-paths under the same parent into one sub-projection', () => {
    const value = {
      id: 'm1',
      outcomes: [
        { label: 'Yes', tokenAddress: '0xa', weight: 1 },
        { label: 'No', tokenAddress: '0xb', weight: 1 },
      ],
    };
    const projected = projectFields(
      value,
      parseFieldsList('id,outcomes.label,outcomes.tokenAddress')
    );
    expect(projected).toEqual({
      id: 'm1',
      outcomes: [
        { label: 'Yes', tokenAddress: '0xa' },
        { label: 'No', tokenAddress: '0xb' },
      ],
    });
  });

  it('including a head with no sub-path takes the whole subtree', () => {
    // `outcomes` (no sub-path) wins over `outcomes.label` — the user asked
    // for everything under `outcomes`, narrower paths are redundant.
    const value = {
      outcomes: [{ label: 'Yes', tokenAddress: '0xa' }],
    };
    expect(projectFields(value, parseFieldsList('outcomes,outcomes.label'))).toEqual(value);
  });

  it('preserves primitive leaves (numbers, booleans, null) intact', () => {
    const value = { id: 'x', count: 0, active: false, txHash: null };
    expect(projectFields(value, parseFieldsList('count,active,txHash'))).toEqual({
      count: 0,
      active: false,
      txHash: null,
    });
  });

  it('handles deeply nested paths', () => {
    const value = { a: { b: { c: { d: 'leaf', e: 'other' } } } };
    expect(projectFields(value, parseFieldsList('a.b.c.d'))).toEqual({
      a: { b: { c: { d: 'leaf' } } },
    });
  });

  it('handles arrays nested at multiple levels', () => {
    const value = {
      markets: [
        { id: 'm1', outcomes: [{ label: 'Yes', extra: 1 }] },
        { id: 'm2', outcomes: [{ label: 'No', extra: 2 }] },
      ],
    };
    expect(projectFields(value, parseFieldsList('markets.id,markets.outcomes.label'))).toEqual({
      markets: [
        { id: 'm1', outcomes: [{ label: 'Yes' }] },
        { id: 'm2', outcomes: [{ label: 'No' }] },
      ],
    });
  });
});
