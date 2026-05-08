/**
 * `kash protocol decode-revert <0x…>` — decode raw revert data
 * emitted by the Market contract or EntryPoint into a human-readable
 * `(name, args)` pair.
 *
 * Pure offline operation: matches the first 4 bytes of revert data
 * against the custom errors in the vendored ABIs (Market first,
 * EntryPoint as fallback). No RPC required.
 *
 * Useful when debugging stuck UserOps: `getUserOperationReceipt`
 * returns hex revert data; pipe it into this command to identify
 * which custom error was thrown.
 */

import { Command } from 'commander';

import { CliValidationError, toCliError } from '../../errors.js';
import { readGlobals } from '../../utils/global-options.js';
import { print, printJson, style } from '../../utils/output.js';

const HEX_DATA_RE = /^0x[0-9a-fA-F]+$/;

export const decodeRevertCommand = new Command('decode-revert')
  .description('Decode raw revert data into (name, args) using the Market + EntryPoint ABIs.')
  .argument('<data>', 'raw revert data (0x-prefixed hex)')
  .addHelpText(
    'after',
    `
Examples:
  $ kash protocol decode-revert 0x4e487b710000000000000000000000000000000000000000000000000000000000000011
  $ kash protocol decode-revert 0x... --json --quiet | jq -r '.name'

Notes:
  - Returns \`null\` if the selector doesn't match any known error
    (the data may be raw \`Error(string)\` or vendor-specific).
  - The \`args\` array stringifies bigint values to preserve precision.
`
  )
  .action(async (data: string, _opts, cmd: Command) => {
    const globals = readGlobals(cmd);

    if (!HEX_DATA_RE.test(data) || data.length < 10) {
      throw new CliValidationError(
        '<data> must be 0x-prefixed hex with at least a 4-byte selector.',
        `Got "${data}".`,
        'data'
      );
    }

    try {
      // Lazy-load protocol-sdk so this offline helper doesn't pull
      // viem on every CLI invocation.
      const { decodeMarketRevert } = await import('@kashdao/protocol-sdk');
      const decoded = decodeMarketRevert(data as `0x${string}`);

      // Stringify bigint args defensively — JSON.stringify chokes on
      // them and consumers can re-parse the strings if they need
      // precision.
      const args = decoded?.args.map((a) => (typeof a === 'bigint' ? a.toString() : a)) ?? null;

      const payload = decoded === null ? null : { name: decoded.name, args };

      if (globals.json) {
        printJson(payload);
        return;
      }

      if (decoded === null) {
        print('');
        print(`  ${style.dim('No match — selector not in Market or EntryPoint ABIs.')}`);
        print(`  ${style.dim('Data: ')}${data.slice(0, 10)}${data.length > 10 ? '…' : ''}`);
        return;
      }

      print('');
      print(`  ${style.dim('Error  ')} ${style.bold(decoded.name)}`);
      if (args && args.length > 0) {
        print(`  ${style.dim('Args   ')}`);
        for (const [i, arg] of args.entries()) {
          print(`    [${String(i)}] ${String(arg)}`);
        }
      } else {
        print(`  ${style.dim('Args   ')} (none)`);
      }
    } catch (cause) {
      throw toCliError(cause);
    }
  });
