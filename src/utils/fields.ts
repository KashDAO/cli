/**
 * `--fields` projection helpers.
 *
 * Implements `gh`-style dot-path field selection for `--json` output.
 * Reduces tokens for AI agents and noise for humans piping responses
 * through `jq`. Applied AFTER schema validation so the projected
 * payload is a strict subset of the wire shape — never a re-shape.
 *
 * Path syntax:
 *   - Comma-separated list:        `id,title,status`
 *   - Dot-separated nested paths:  `pagination.cursor`
 *   - Array splay (implicit):      `outcomes.label` against an array of
 *                                  outcome objects yields
 *                                  `[{label}, {label}, …]`. Sub-fields
 *                                  group: `outcomes.label,outcomes.tokenAddress`
 *                                  yields `[{label, tokenAddress}, …]`.
 *
 * Paginated envelopes (`{ data: [...], pagination?: {...} }`) are
 * detected and the projection runs against each entry in `data`. Other
 * top-level keys (pagination, meta) pass through unchanged.
 *
 * Missing paths silently drop (matches jq semantics; surfacing every
 * typo as an INVALID_INPUT would be more friction than it's worth).
 */

import { CliValidationError } from '../errors.js';

/**
 * Validate a single path segment. Restricted to the conservative
 * "JSON-ish identifier" subset so we don't accidentally accept paths
 * that overlap with future jq-syntax extensions (`[*]`, `?`, etc.).
 */
const SEGMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the comma-separated `--fields` value into an array of
 * dot-segmented paths. Throws `INVALID_INPUT` on empty entries or bad
 * segments so an agent gets a clear error envelope.
 */
export function parseFieldsList(raw: string): ReadonlyArray<readonly string[]> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CliValidationError(
      '--fields must list at least one path.',
      'Pass a comma-separated list, e.g. `--fields id,title,status`.',
      'fields'
    );
  }
  const paths: string[][] = [];
  for (const rawPath of trimmed.split(',')) {
    const path = rawPath.trim();
    if (path === '') {
      throw new CliValidationError(
        '--fields contains an empty entry.',
        'Strip leading/trailing commas or extra whitespace, e.g. `id,title` (not `,id,title,`).',
        'fields'
      );
    }
    const segments = path.split('.');
    for (const segment of segments) {
      if (!SEGMENT_REGEX.test(segment)) {
        throw new CliValidationError(
          `--fields path "${path}" contains an invalid segment "${segment}".`,
          'Segments must match `[A-Za-z_][A-Za-z0-9_]*`. Use `parent.child` for nested fields.',
          'fields'
        );
      }
    }
    paths.push(segments);
  }
  return paths;
}

/**
 * Project a value against a parsed field list. The value is preserved
 * structurally — paginated envelopes pass through with their `data`
 * array projected; arrays are projected element-wise; objects are
 * narrowed to the requested fields.
 */
export function projectFields(value: unknown, paths: ReadonlyArray<readonly string[]>): unknown {
  if (paths.length === 0) return value;
  if (value === null || value === undefined) return value;

  // Paginated envelope: project entries, preserve pagination/meta unchanged.
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    const envelope = value as Record<string, unknown> & { data: unknown[] };
    return {
      ...envelope,
      data: envelope.data.map((item) => projectObject(item, paths)),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => projectObject(item, paths));
  }

  return projectObject(value, paths);
}

/**
 * Core recursive projection. Groups requested paths by their head
 * segment so sub-fields of the same parent collapse into a single
 * sub-projection (rather than overwriting each other).
 */
function projectObject(obj: unknown, paths: ReadonlyArray<readonly string[]>): unknown {
  if (obj === null || obj === undefined) return obj;

  // Array values: recurse into each element with the same paths.
  if (Array.isArray(obj)) {
    return obj.map((item) => projectObject(item, paths));
  }

  // Primitives: nothing to project.
  if (typeof obj !== 'object') return obj;

  // Group paths by head segment so `outcomes.label,outcomes.token` collapse
  // to a single recursive call into `outcomes` with sub-paths `[label]`
  // and `[token]`.
  const groups = new Map<string, Array<readonly string[]>>();
  for (const path of paths) {
    if (path.length === 0) continue;
    const head = path[0]!;
    const rest = path.slice(1);
    const existing = groups.get(head) ?? [];
    existing.push(rest);
    groups.set(head, existing);
  }

  const result: Record<string, unknown> = {};
  const source = obj as Record<string, unknown>;
  for (const [head, subPaths] of groups) {
    if (!(head in source)) continue;
    const value = source[head];

    // If any sub-path is empty, the user asked for the whole subtree —
    // include it as-is and skip narrower projections under the same head.
    const includeWhole = subPaths.some((p) => p.length === 0);
    if (includeWhole) {
      result[head] = value;
      continue;
    }
    result[head] = projectObject(value, subPaths);
  }
  return result;
}
