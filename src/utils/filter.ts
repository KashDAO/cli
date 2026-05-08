/**
 * `--filter` boolean DSL — narrows JSON output by predicate.
 *
 * Tiny intentionally: just enough to keep agents and shell pipelines
 * from reaching for `jq` for the common case. Pulling in a full
 * jq-compatible parser would (a) add weight to a CLI we're optimising
 * for cold-start, and (b) widen the contract surface beyond what we
 * can stably support.
 *
 * **Grammar** (informal):
 *
 *   filter      := or
 *   or          := and (`||` and)*
 *   and         := comparison (`&&` comparison)*
 *   comparison  := path op value
 *   op          := `==` | `!=` | `<=` | `>=` | `<` | `>`
 *   path        := identifier (`.` identifier)*
 *   value       := bareWord | number | true | false | null
 *
 * `bareWord` is `[A-Za-z_][A-Za-z0-9_]*` (e.g. `ACTIVE`, `buy`).
 * Numbers are decimal (`8453`, `0.62`).
 *
 * **Type coercion:** `<`, `>`, `<=`, `>=` only fire when both sides
 * coerce to finite numbers. `==` and `!=` first try strict equality,
 * then a number-coerce comparison so `outcomeCount==2` works whether
 * the field is a number or a numeric string.
 *
 * **Paginated envelopes:** filter applies to the entries inside
 * `data` (mirroring `--fields`); other top-level keys (pagination,
 * meta) pass through unchanged.
 *
 * Future extensions (kept off the surface for now): `~` regex,
 * `in [a,b,c]`, parenthesised sub-expressions. Most users reach for
 * `jq` once they need any of those — adding them piecemeal would
 * lock us into a dialect.
 */

import { CliValidationError } from '../errors.js';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type FilterAst =
  | { readonly kind: 'or'; readonly left: FilterAst; readonly right: FilterAst }
  | { readonly kind: 'and'; readonly left: FilterAst; readonly right: FilterAst }
  | {
      readonly kind: 'cmp';
      readonly path: readonly string[];
      readonly op: '==' | '!=' | '<' | '<=' | '>' | '>=';
      readonly value: string | number | boolean | null;
    };

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'and' | 'or' }
  | { kind: 'op'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' }
  | { kind: 'ident'; value: string }
  | { kind: 'dot' }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'word'; value: string };

const IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (ch === '=' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', op: '==' });
      i += 2;
      continue;
    }
    if (ch === '!' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', op: '!=' });
      i += 2;
      continue;
    }
    if (ch === '<' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', op: '<=' });
      i += 2;
      continue;
    }
    if (ch === '>' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', op: '>=' });
      i += 2;
      continue;
    }
    if (ch === '<') {
      tokens.push({ kind: 'op', op: '<' });
      i += 1;
      continue;
    }
    if (ch === '>') {
      tokens.push({ kind: 'op', op: '>' });
      i += 1;
      continue;
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot' });
      i += 1;
      continue;
    }
    // Number (possibly with decimal). Must come before identifier to
    // catch a leading digit; identifiers start with letter/underscore.
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const numMatch = /^-?\d+(\.\d+)?/.exec(input.slice(i));
      if (numMatch) {
        const raw = numMatch[0];
        const n = Number.parseFloat(raw);
        if (!Number.isFinite(n)) {
          throw filterError(`Invalid number "${raw}" at position ${String(i)}.`);
        }
        tokens.push({ kind: 'number', value: n });
        i += raw.length;
        continue;
      }
    }
    // Identifier or bareword.
    const identMatch = IDENT_REGEX.exec(input.slice(i));
    if (identMatch) {
      const raw = identMatch[0];
      if (raw === 'true' || raw === 'false') {
        tokens.push({ kind: 'bool', value: raw === 'true' });
      } else if (raw === 'null') {
        tokens.push({ kind: 'null' });
      } else {
        tokens.push({ kind: 'ident', value: raw });
      }
      i += raw.length;
      continue;
    }
    throw filterError(`Unexpected character "${ch}" at position ${String(i)}.`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent: or → and → comparison)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): FilterAst {
    const ast = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw filterError(`Unexpected trailing token after position ${String(this.pos)}.`);
    }
    return ast;
  }

  private parseOr(): FilterAst {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.pos += 1;
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): FilterAst {
    let left = this.parseCmp();
    while (this.peek()?.kind === 'and') {
      this.pos += 1;
      const right = this.parseCmp();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseCmp(): FilterAst {
    const path = this.parsePath();
    const opToken = this.peek();
    if (opToken?.kind !== 'op') {
      throw filterError('Expected an operator (`==`, `!=`, `<`, `>`, `<=`, `>=`).');
    }
    this.pos += 1;
    const valueToken = this.peek();
    if (!valueToken) {
      throw filterError('Expected a value after the operator.');
    }
    let value: string | number | boolean | null;
    switch (valueToken.kind) {
      case 'number':
        value = valueToken.value;
        break;
      case 'bool':
        value = valueToken.value;
        break;
      case 'null':
        value = null;
        break;
      case 'ident':
        // Bare-word value (e.g. `ACTIVE`, `buy`). The parser doesn't
        // distinguish "this looks like an enum" from "this looks like
        // a path"; on the right side of an op we always treat it as a
        // string value.
        value = valueToken.value;
        break;
      default:
        throw filterError(`Expected a value, got ${valueToken.kind}.`);
    }
    this.pos += 1;
    return { kind: 'cmp', path, op: opToken.op, value };
  }

  private parsePath(): readonly string[] {
    const parts: string[] = [];
    const first = this.peek();
    if (first?.kind !== 'ident') {
      throw filterError('Expected a field path.');
    }
    parts.push(rejectReservedKey(first.value));
    this.pos += 1;
    while (this.peek()?.kind === 'dot') {
      this.pos += 1;
      const next = this.peek();
      if (next?.kind !== 'ident') {
        throw filterError('Expected a field name after `.`.');
      }
      parts.push(rejectReservedKey(next.value));
      this.pos += 1;
    }
    return parts;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Path segments that would walk into the prototype chain. Filtering
 * is read-only so this isn't prototype pollution per se, but
 * `__proto__.toString` would resolve to a function reference and
 * surface surprising truthy comparisons. Reject at parse time so the
 * AST never carries them and the evaluator stays simple.
 */
const RESERVED_PATH_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function rejectReservedKey(segment: string): string {
  if (RESERVED_PATH_KEYS.has(segment)) {
    throw filterError(
      `Reserved field name "${segment}" is not allowed in --filter paths (prototype-walk guard).`
    );
  }
  return segment;
}

function getAtPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value;
  for (const segment of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    // `Object.hasOwn` ensures we only read direct properties — even
    // though reserved keys are rejected at parse time, this is
    // defence-in-depth against any future code path that constructs
    // an AST without going through `parsePath`.
    if (!Object.hasOwn(cur, segment)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function evaluate(ast: FilterAst, record: unknown): boolean {
  switch (ast.kind) {
    case 'or':
      return evaluate(ast.left, record) || evaluate(ast.right, record);
    case 'and':
      return evaluate(ast.left, record) && evaluate(ast.right, record);
    case 'cmp':
      return evaluateCmp(ast, record);
  }
}

type CmpAst = Extract<FilterAst, { kind: 'cmp' }>;

function evaluateCmp(ast: CmpAst, record: unknown): boolean {
  const actual = getAtPath(record, ast.path);
  const expected = ast.value;

  if (ast.op === '==' || ast.op === '!=') {
    // First try strict equality, then number-coerce both sides so
    // numeric strings like "2" match `outcomeCount==2`.
    let eq = actual === expected;
    if (!eq && typeof actual === 'string' && typeof expected === 'number') {
      const n = Number(actual);
      eq = Number.isFinite(n) && n === expected;
    }
    if (!eq && typeof actual === 'number' && typeof expected === 'string') {
      const n = Number(expected);
      eq = Number.isFinite(n) && n === actual;
    }
    return ast.op === '==' ? eq : !eq;
  }

  // Ordered comparisons require both sides to coerce to finite numbers.
  const a = toFiniteNumber(actual);
  const b = toFiniteNumber(expected);
  if (a === undefined || b === undefined) return false;
  switch (ast.op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      // Unreachable — `==`/`!=` are handled above. The default
      // satisfies the compiler's exhaustiveness check.
      return false;
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseFilter(expr: string): FilterAst {
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw filterError('--filter expression is empty.');
  }
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    throw filterError('--filter expression has no tokens.');
  }
  return new Parser(tokens).parse();
}

/**
 * Apply a parsed filter to a value. Mirrors `projectFields`'s
 * dispatch:
 *   - Paginated envelope (`{ data: [...], ... }`) → narrow `data`
 *     to entries where the predicate is true; preserve other keys.
 *   - Bare array → element-wise.
 *   - Single record → return as-is when matching, `null` when not.
 *
 * The single-record path is uncommon (most filtering is over lists)
 * but is the obvious thing to do — agents that want to short-circuit
 * a `kash trade status` chain can do `kash trade status <id> --filter
 * 'status==completed' --json | …`.
 */
export function applyFilter(value: unknown, ast: FilterAst): unknown {
  if (value === null || value === undefined) return value;

  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    const envelope = value as Record<string, unknown> & { data: unknown[] };
    return {
      ...envelope,
      data: envelope.data.filter((entry) => evaluate(ast, entry)),
    };
  }

  if (Array.isArray(value)) {
    return value.filter((entry) => evaluate(ast, entry));
  }

  // Single record: pass through if matching, null otherwise. Keeps
  // the JSON contract stable (callers can null-check) without
  // breaking pipelines that expect an object.
  return evaluate(ast, value) ? value : null;
}

function filterError(message: string): CliValidationError {
  return new CliValidationError(
    `--filter parse error: ${message}`,
    'See `kash --help` for filter syntax. Examples: `status==ACTIVE`, `side==buy && outcomeCount>2`.',
    'filter'
  );
}
