/**
 * JSON (de)serialisation helpers for ERC-4337 v0.7 UserOps.
 *
 * Two consumers share this module:
 *
 *   - `kash protocol trade` (SA mode) emits the prepared UserOp on the
 *     `--print-userop` path so an external signer can consume it.
 *   - `kash protocol userop build / sign / submit / wait` round-trips
 *     UserOps through disk and stdin via the same JSON shape.
 *
 * Both entered the codebase with their own local copy of the bigint→
 * string encoder, which is a real-money divergence risk: a UserOp
 * round-tripped through `trade --print-userop | userop sign --in -`
 * is the textbook "operator builds + offline signs" flow, and any
 * field that one side stringifies but the other does not would silently
 * change the call's gas semantics.
 *
 * The encoder is the load-bearing primitive; the decoder lives in
 * `userop.ts` next to the `UnsignedUserOp` field-shape declarations
 * that drive its bigint-field whitelist.
 */

/**
 * Convert a UserOp's bigint fields (`nonce`, `callGasLimit`, gas
 * limits, fees, etc.) to decimal strings so the envelope round-trips
 * through `JSON.stringify`. Non-bigint fields pass through untouched.
 *
 * The shape is the inverse of `userop.ts:deserializeUserOp` — keep
 * the two in lockstep when adding new bigint fields to the SDK's
 * UnsignedUserOp.
 */
export function serializeUserOp(userOp: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(userOp)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
