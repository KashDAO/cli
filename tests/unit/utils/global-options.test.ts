/**
 * Unit tests for `readGlobals` — verifies global-flag → typed-options
 * resolution.
 *
 * Currently focused on the env-var bridges (`KASH_DEBUG` for `--debug`)
 * since those have side-effects on process.env that need explicit
 * setup/teardown. Flag-only behaviour is exercised end-to-end by the
 * component tests.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliValidationError } from '../../../src/errors.js';
import {
  parseOptionalPositiveFloat,
  parseOptionalPositiveInt,
  parsePositiveFloat,
  parsePositiveInt,
  readGlobals,
} from '../../../src/utils/global-options.js';

/**
 * Build a minimal program that mirrors the real binary's globals so
 * `readGlobals` has the same shape to read against.
 */
function buildProgramWithLeaf(): { program: Command; leaf: Command } {
  const program = new Command()
    .name('kash')
    .exitOverride()
    .option('--json', '', false)
    .option('--quiet', '', false)
    .option('--no-color', '')
    .option('--debug', '', false)
    .option('-p, --profile <name>')
    .option('--config <path>')
    .option('--base-url <url>')
    .option('--max-retries <n>')
    .option('--timeout-ms <n>')
    .option('--fields <list>');
  // The leaf command is what `readGlobals` is called against — it uses
  // `optsWithGlobals` which walks up to the parent.
  const leaf = new Command('test').action(() => {
    // Action filled per-test via `cmd.action()` override below.
  });
  program.addCommand(leaf);
  return { program, leaf };
}

describe('readGlobals — KASH_DEBUG env mirror', () => {
  let originalDebug: string | undefined;

  beforeEach(() => {
    originalDebug = process.env['KASH_DEBUG'];
    delete process.env['KASH_DEBUG'];
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env['KASH_DEBUG'];
    } else {
      process.env['KASH_DEBUG'] = originalDebug;
    }
  });

  it('returns debug:false when neither flag nor env is set', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    let captured: ReturnType<typeof readGlobals> | undefined;
    leaf.action((_args, cmd: Command) => {
      captured = readGlobals(cmd);
    });
    await program.parseAsync(['test'], { from: 'user' });
    expect(captured?.debug).toBe(false);
  });

  it('returns debug:true when --debug is passed', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    let captured: ReturnType<typeof readGlobals> | undefined;
    leaf.action((_args, cmd: Command) => {
      captured = readGlobals(cmd);
    });
    await program.parseAsync(['--debug', 'test'], { from: 'user' });
    expect(captured?.debug).toBe(true);
  });

  it('returns debug:true when KASH_DEBUG=1 even without --debug flag', async () => {
    process.env['KASH_DEBUG'] = '1';
    const { program, leaf } = buildProgramWithLeaf();
    let captured: ReturnType<typeof readGlobals> | undefined;
    leaf.action((_args, cmd: Command) => {
      captured = readGlobals(cmd);
    });
    await program.parseAsync(['test'], { from: 'user' });
    expect(captured?.debug).toBe(true);
  });

  it('accepts other truthy KASH_DEBUG values: true, yes, on', async () => {
    for (const value of ['true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
      process.env['KASH_DEBUG'] = value;
      const { program, leaf } = buildProgramWithLeaf();
      let captured: ReturnType<typeof readGlobals> | undefined;
      leaf.action((_args, cmd: Command) => {
        captured = readGlobals(cmd);
      });
      await program.parseAsync(['test'], { from: 'user' });
      expect(captured?.debug, `KASH_DEBUG=${value}`).toBe(true);
    }
  });

  it('treats falsy KASH_DEBUG values as off (0, false, empty)', async () => {
    for (const value of ['', '0', 'false', 'FALSE', 'no', 'off']) {
      process.env['KASH_DEBUG'] = value;
      const { program, leaf } = buildProgramWithLeaf();
      let captured: ReturnType<typeof readGlobals> | undefined;
      leaf.action((_args, cmd: Command) => {
        captured = readGlobals(cmd);
      });
      await program.parseAsync(['test'], { from: 'user' });
      expect(captured?.debug, `KASH_DEBUG=${JSON.stringify(value)}`).toBe(false);
    }
  });
});

describe('parsePositiveInt + parseOptionalPositiveInt', () => {
  it('accepts a positive integer', () => {
    expect(parsePositiveInt('42', 'limit')).toBe(42);
  });

  it('throws on zero (must be strictly positive)', () => {
    expect(() => parsePositiveInt('0', 'limit')).toThrow(CliValidationError);
  });

  it('throws on negative', () => {
    expect(() => parsePositiveInt('-5', 'limit')).toThrow(CliValidationError);
  });

  it('throws on non-numeric', () => {
    expect(() => parsePositiveInt('abc', 'limit')).toThrow(CliValidationError);
  });

  // Pre-fix `parseInt('1.5', 10) === 1` and `parseInt('1e3', 10) === 1`
  // both silently truncated to 1, accepting an obvious typo as a
  // valid value. Pin the strict shape so a regression surfaces.
  it('rejects decimal input even when integer-shaped (1.5 → no longer silently truncates to 1)', () => {
    expect(() => parsePositiveInt('1.5', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('100.0', 'limit')).toThrow(CliValidationError);
  });

  it('rejects scientific notation (1e3 → no longer silently truncates to 1)', () => {
    expect(() => parsePositiveInt('1e3', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('5E2', 'limit')).toThrow(CliValidationError);
  });

  it('rejects hex / octal / binary literals', () => {
    expect(() => parsePositiveInt('0x10', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('0o10', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('0b10', 'limit')).toThrow(CliValidationError);
  });

  it('accepts a leading + (no other sign forms)', () => {
    expect(parsePositiveInt('+42', 'limit')).toBe(42);
  });

  it('rejects whitespace inside or around the number', () => {
    expect(() => parsePositiveInt(' 42', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('42 ', 'limit')).toThrow(CliValidationError);
    expect(() => parsePositiveInt('1 2', 'limit')).toThrow(CliValidationError);
  });

  it('parseOptional returns undefined for undefined input', () => {
    expect(parseOptionalPositiveInt(undefined, 'limit')).toBeUndefined();
  });

  it('parseOptional validates when input is present', () => {
    expect(parseOptionalPositiveInt('7', 'limit')).toBe(7);
  });

  it('parseOptional throws on malformed input', () => {
    expect(() => parseOptionalPositiveInt('-1', 'limit')).toThrow(CliValidationError);
  });
});

describe('parsePositiveFloat + parseOptionalPositiveFloat', () => {
  it('accepts a positive float', () => {
    expect(parsePositiveFloat('1.5', 'multiplier')).toBe(1.5);
  });

  it('accepts a positive integer-shaped float', () => {
    expect(parsePositiveFloat('2', 'multiplier')).toBe(2);
  });

  it('throws on zero', () => {
    expect(() => parsePositiveFloat('0', 'multiplier')).toThrow(CliValidationError);
  });

  it('throws on negative', () => {
    expect(() => parsePositiveFloat('-1.5', 'multiplier')).toThrow(CliValidationError);
  });

  it('throws on Infinity', () => {
    expect(() => parsePositiveFloat('Infinity', 'multiplier')).toThrow(CliValidationError);
  });

  it('throws on NaN', () => {
    expect(() => parsePositiveFloat('not-a-number', 'multiplier')).toThrow(CliValidationError);
  });

  it('parseOptional returns undefined for undefined input', () => {
    expect(parseOptionalPositiveFloat(undefined, 'multiplier')).toBeUndefined();
  });

  it('parseOptional validates when input is present', () => {
    expect(parseOptionalPositiveFloat('0.5', 'multiplier')).toBe(0.5);
  });
});

describe('--base-url scheme validation', () => {
  // Exercises the parseUrl helper indirectly through the global flag
  // — we drive readGlobals through a Commander program (the same
  // shape the binary uses) and assert that non-http(s) schemes are
  // rejected. The new URL() check passes for `file:`, `data:`, etc.
  // — only the explicit scheme check rejects them.

  function buildProgramWithLeaf() {
    const program = new Command()
      .name('kash')
      .exitOverride()
      .option('--json', '', false)
      .option('--quiet', '', false)
      .option('--no-color', '')
      .option('--debug', '', false)
      .option('-p, --profile <name>')
      .option('--config <path>')
      .option('--base-url <url>')
      .option('--max-retries <n>')
      .option('--timeout-ms <n>')
      .option('--fields <list>');
    const leaf = new Command('test').action(() => undefined);
    program.addCommand(leaf);
    return { program, leaf };
  }

  it('accepts http://', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    let captured: ReturnType<typeof readGlobals> | undefined;
    leaf.action((_args, cmd: Command) => {
      captured = readGlobals(cmd);
    });
    await program.parseAsync(['--base-url', 'http://example.com', 'test'], { from: 'user' });
    expect(captured?.baseUrl).toBe('http://example.com');
  });

  it('accepts https://', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    let captured: ReturnType<typeof readGlobals> | undefined;
    leaf.action((_args, cmd: Command) => {
      captured = readGlobals(cmd);
    });
    await program.parseAsync(['--base-url', 'https://api.kash.bot/v1', 'test'], { from: 'user' });
    expect(captured?.baseUrl).toBe('https://api.kash.bot/v1');
  });

  it('rejects file:// schemes', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    leaf.action((_args, cmd: Command) => {
      readGlobals(cmd);
    });
    await expect(
      program.parseAsync(['--base-url', 'file:///etc/passwd', 'test'], { from: 'user' })
    ).rejects.toThrow(/must use http:\/\/ or https:\/\//);
  });

  it('rejects data: URI schemes', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    leaf.action((_args, cmd: Command) => {
      readGlobals(cmd);
    });
    await expect(
      program.parseAsync(['--base-url', 'data:text/plain;base64,YWJj', 'test'], { from: 'user' })
    ).rejects.toThrow(/must use http:\/\/ or https:\/\//);
  });

  it('rejects javascript: URLs', async () => {
    const { program, leaf } = buildProgramWithLeaf();
    leaf.action((_args, cmd: Command) => {
      readGlobals(cmd);
    });
    await expect(
      program.parseAsync(['--base-url', 'javascript:alert(1)', 'test'], { from: 'user' })
    ).rejects.toThrow(/must use http:\/\/ or https:\/\//);
  });
});
