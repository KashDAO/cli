/**
 * Unit tests for the `--filter` DSL.
 *
 * Two layers:
 *   1. `parseFilter` — lexer + parser. Accepts valid expressions,
 *      rejects malformed ones with `INVALID_INPUT` + the `filter` field.
 *   2. `applyFilter` — evaluator. Pagination envelope handling,
 *      bare-array handling, single-record null-on-no-match semantics,
 *      and the type-coercion rules for ==/!=/comparison operators.
 */

import { describe, expect, it } from 'vitest';

import { CliValidationError } from '../../src/errors.js';
import { applyFilter, parseFilter } from '../../src/utils/filter.js';

describe('parseFilter — accepts valid expressions', () => {
  it('parses a simple equality', () => {
    const ast = parseFilter('status==ACTIVE');
    expect(ast.kind).toBe('cmp');
  });

  it('parses inequality, less-than, greater-than-equal', () => {
    expect(() => parseFilter('outcomeCount!=2')).not.toThrow();
    expect(() => parseFilter('outcomeCount<10')).not.toThrow();
    expect(() => parseFilter('outcomeCount>=2')).not.toThrow();
  });

  it('parses && (and) and || (or) chains', () => {
    expect(() => parseFilter('a==1 && b==2')).not.toThrow();
    expect(() => parseFilter('a==1 || b==2')).not.toThrow();
    expect(() => parseFilter('a==1 && b==2 || c==3')).not.toThrow();
  });

  it('parses dotted field paths', () => {
    expect(() => parseFilter('outcomes.label==Yes')).not.toThrow();
    expect(() => parseFilter('a.b.c.d==leaf')).not.toThrow();
  });

  it('parses numbers, booleans, null', () => {
    expect(() => parseFilter('count==42')).not.toThrow();
    expect(() => parseFilter('price==0.62')).not.toThrow();
    expect(() => parseFilter('active==true')).not.toThrow();
    expect(() => parseFilter('flagged==false')).not.toThrow();
    expect(() => parseFilter('txHash==null')).not.toThrow();
  });

  it('parses negative numbers', () => {
    expect(() => parseFilter('delta>-5')).not.toThrow();
  });

  it('tolerates internal whitespace', () => {
    expect(() => parseFilter('  status  ==  ACTIVE  ')).not.toThrow();
  });
});

describe('parseFilter — rejects malformed expressions', () => {
  it('rejects empty input', () => {
    expect(() => parseFilter('')).toThrow(CliValidationError);
    expect(() => parseFilter('   ')).toThrow(CliValidationError);
  });

  it('rejects a missing operator', () => {
    expect(() => parseFilter('status')).toThrow(/operator/i);
  });

  it('rejects a missing value', () => {
    expect(() => parseFilter('status==')).toThrow(/value/i);
  });

  it('rejects unknown characters', () => {
    expect(() => parseFilter('status~=ACTIVE')).toThrow(CliValidationError);
    expect(() => parseFilter('status @ ACTIVE')).toThrow(CliValidationError);
  });

  it('rejects a trailing token', () => {
    expect(() => parseFilter('status==ACTIVE foo')).toThrow(/trailing/i);
  });

  it('rejects a single `&` (not `&&`)', () => {
    expect(() => parseFilter('a==1 & b==2')).toThrow(CliValidationError);
  });

  it('attaches the `filter` field name to validation errors', () => {
    try {
      parseFilter('!!!');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliValidationError);
      const cliErr = err as CliValidationError;
      const checkInput = cliErr.actions.find((a) => a.type === 'check_input');
      expect(checkInput && checkInput.type === 'check_input' ? checkInput.field : null).toBe(
        'filter'
      );
    }
  });

  it('rejects __proto__ in path segments (prototype-walk guard)', () => {
    expect(() => parseFilter('__proto__.toString==x')).toThrow(/Reserved field name/);
  });

  it('rejects constructor in path segments', () => {
    expect(() => parseFilter('constructor==Object')).toThrow(/Reserved field name/);
  });

  it('rejects prototype in nested path segments', () => {
    expect(() => parseFilter('a.prototype.b==1')).toThrow(/Reserved field name/);
  });
});

describe('applyFilter — defence-in-depth own-property guard', () => {
  it('does not surface inherited prototype properties', () => {
    // Even if a future code path constructs an AST without going
    // through `parsePath`, the evaluator's `Object.hasOwn` check
    // must not walk into the prototype.
    const ast = parseFilter('toString==anything');
    // `toString` is on Object.prototype — `applyFilter` should NOT
    // resolve it as a field on a plain object.
    const result = applyFilter({}, ast);
    expect(result).toBeNull();
  });
});

describe('applyFilter — paginated envelopes', () => {
  it('narrows the `data` array and preserves pagination', () => {
    const ast = parseFilter('status==ACTIVE');
    const value = {
      data: [
        { id: 'a', status: 'ACTIVE' },
        { id: 'b', status: 'RESOLVED' },
        { id: 'c', status: 'ACTIVE' },
      ],
      pagination: { hasMore: false, cursor: null },
    };
    const out = applyFilter(value, ast) as {
      data: { id: string }[];
      pagination: { hasMore: boolean };
    };
    expect(out.data.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out.pagination).toEqual({ hasMore: false, cursor: null });
  });
});

describe('applyFilter — bare arrays', () => {
  it('filters element-wise', () => {
    const ast = parseFilter('side==buy');
    const value = [
      { id: '1', side: 'buy' },
      { id: '2', side: 'sell' },
      { id: '3', side: 'buy' },
    ];
    expect(applyFilter(value, ast)).toEqual([
      { id: '1', side: 'buy' },
      { id: '3', side: 'buy' },
    ]);
  });
});

describe('applyFilter — single records', () => {
  it('returns the record when matching', () => {
    const ast = parseFilter('status==ACTIVE');
    const value = { id: 'm1', status: 'ACTIVE' };
    expect(applyFilter(value, ast)).toEqual(value);
  });

  it('returns null when not matching', () => {
    const ast = parseFilter('status==ACTIVE');
    const value = { id: 'm1', status: 'RESOLVED' };
    expect(applyFilter(value, ast)).toBeNull();
  });
});

describe('applyFilter — type coercion', () => {
  it('coerces a numeric-string field to a number for `==`', () => {
    // outcomeCount may arrive as `2` (number) or `"2"` (string).
    const ast = parseFilter('outcomeCount==2');
    expect(applyFilter({ outcomeCount: 2 }, ast)).not.toBeNull();
    expect(applyFilter({ outcomeCount: '2' }, ast)).not.toBeNull();
  });

  it('coerces a numeric-string field to a number for ordered ops', () => {
    const ast = parseFilter('outcomeCount>1');
    expect(applyFilter({ outcomeCount: 2 }, ast)).not.toBeNull();
    expect(applyFilter({ outcomeCount: '2' }, ast)).not.toBeNull();
    expect(applyFilter({ outcomeCount: 1 }, ast)).toBeNull();
  });

  it('rejects ordered comparisons when either side is non-numeric', () => {
    const ast = parseFilter('status>ACTIVE');
    expect(applyFilter({ status: 'ACTIVE' }, ast)).toBeNull();
    expect(applyFilter({ status: 'RESOLVED' }, ast)).toBeNull();
  });

  it('handles null values for `==null` checks', () => {
    const ast = parseFilter('txHash==null');
    expect(applyFilter({ txHash: null }, ast)).not.toBeNull();
    expect(applyFilter({ txHash: '0xabc' }, ast)).toBeNull();
  });

  it('handles boolean values', () => {
    const ast = parseFilter('active==true');
    expect(applyFilter({ active: true }, ast)).not.toBeNull();
    expect(applyFilter({ active: false }, ast)).toBeNull();
  });

  it('treats missing fields as undefined (no match for ==)', () => {
    const ast = parseFilter('absent==ACTIVE');
    expect(applyFilter({ id: 'x' }, ast)).toBeNull();
  });
});

describe('applyFilter — boolean operators', () => {
  it('&& (and) requires both sides to match', () => {
    const ast = parseFilter('side==buy && status==completed');
    expect(applyFilter({ side: 'buy', status: 'completed' }, ast)).not.toBeNull();
    expect(applyFilter({ side: 'buy', status: 'pending' }, ast)).toBeNull();
    expect(applyFilter({ side: 'sell', status: 'completed' }, ast)).toBeNull();
  });

  it('|| (or) requires either side to match', () => {
    const ast = parseFilter('side==buy || side==sell');
    expect(applyFilter({ side: 'buy' }, ast)).not.toBeNull();
    expect(applyFilter({ side: 'sell' }, ast)).not.toBeNull();
    expect(applyFilter({ side: 'lend' }, ast)).toBeNull();
  });

  it('honours operator precedence: && binds tighter than ||', () => {
    // `a==1 || b==2 && c==3` should parse as `a==1 || (b==2 && c==3)`.
    const ast = parseFilter('a==1 || b==2 && c==3');
    expect(applyFilter({ a: 1 }, ast)).not.toBeNull(); // left side fires
    expect(applyFilter({ b: 2, c: 3 }, ast)).not.toBeNull(); // right && fires
    expect(applyFilter({ b: 2, c: 4 }, ast)).toBeNull(); // && fails
    expect(applyFilter({ a: 9, b: 9, c: 9 }, ast)).toBeNull();
  });
});

describe('applyFilter — dotted paths', () => {
  it('walks nested fields', () => {
    const ast = parseFilter('webhookDelivery.status==delivered');
    const matching = { id: 't1', webhookDelivery: { status: 'delivered' } };
    const notMatching = { id: 't2', webhookDelivery: { status: 'pending' } };
    expect(applyFilter(matching, ast)).not.toBeNull();
    expect(applyFilter(notMatching, ast)).toBeNull();
  });

  it('returns null when intermediate path is missing', () => {
    const ast = parseFilter('webhookDelivery.status==delivered');
    expect(applyFilter({ id: 't3' }, ast)).toBeNull();
    expect(applyFilter({ id: 't4', webhookDelivery: null }, ast)).toBeNull();
  });
});
