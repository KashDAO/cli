/**
 * Shared helpers for reading from `process.stdin`.
 *
 * Every command that accepts piped input (the `--from-stdin` /
 * `--token-stdin` family, `webhooks replay -`, `config import -`,
 * `protocol userop submit -`) routes through this module so the
 * BOM-stripping and trim semantics stay uniform.
 *
 * **Why BOM-stripping matters.** Notepad, VSCode (when
 * `files.encoding=utf8bom`), some Excel exports, and many Windows
 * tools prepend U+FEFF to UTF-8 files. Pasting that file's contents
 * through a pipe sends those three bytes verbatim into the CLI. The
 * downstream consumer then sees `'\uFEFFkash_live_…'` instead of
 * `'kash_live_…'` — the prefix check fails, the HMAC over the
 * captured webhook body diverges from what the receiver expects,
 * the JSON parser chokes on the leading non-whitespace character.
 *
 * One line of defence here removes a whole class of "works on my
 * Mac, fails on Windows" reports.
 */

/** UTF-8 BOM (U+FEFF in UTF-8 form). Three bytes, code-point one. */
const UTF8_BOM = '\uFEFF';

/**
 * Slurp every byte from stdin, decode as UTF-8, strip a leading BOM,
 * and trim surrounding whitespace.
 *
 * Trim is included because most consumers want it — secret-store
 * commands (`pass`, `op read`) commonly emit a trailing newline that
 * fails downstream prefix/length checks. Callers that need the raw
 * shape (HMAC computation over webhook body bytes, where every byte
 * is signed) should use {@link readStdinExact} instead.
 */
export async function readStdinTrimmed(): Promise<string> {
  const text = await slurp();
  return stripBom(text).trim();
}

/**
 * Slurp every byte from stdin and decode as UTF-8 with a leading BOM
 * removed if present. Does NOT trim trailing whitespace — call sites
 * that sign the bytes (webhook replay) need byte-exact fidelity with
 * what the receiver will recompute.
 */
export async function readStdinExact(): Promise<string> {
  const text = await slurp();
  return stripBom(text);
}

/**
 * Strip a leading UTF-8 BOM, if present. Idempotent — calling it on
 * a string that doesn't have a BOM is a no-op.
 */
export function stripBom(s: string): string {
  return s.startsWith(UTF8_BOM) ? s.slice(1) : s;
}

async function slurp(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
