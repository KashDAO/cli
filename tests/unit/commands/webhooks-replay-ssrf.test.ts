/**
 * Unit tests for `warnIfPrivateAddress` (SSRF guidance) in
 * `commands/webhooks/replay.ts`.
 *
 * The function is best-effort developer guidance — `kash webhooks
 * replay` is a tool for signing+POSTing test events at local tunnels,
 * so we warn rather than refuse — but the regex bit-math behind
 * IPv6 link-local (fe80::/10) and unique-local (fc00::/7) detection
 * has subtle correctness arguments. These tests pin the boundaries so
 * any future tightening is provably safe.
 *
 * Stderr is captured (the function writes warnings as `\u26a0  ...`
 * lines) and we assert on (a) whether anything was written and (b)
 * which kind of warning ("private" vs "link-local").
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPrivateAddress, warnIfPrivateAddress } from '../../../src/commands/webhooks/replay.js';

let stderrBuf = '';
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrBuf = '';
  originalWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalWrite;
});

function probe(url: string): { warned: boolean; linkLocal: boolean; privateRange: boolean } {
  warnIfPrivateAddress(new URL(url));
  return {
    warned: stderrBuf.length > 0,
    linkLocal: stderrBuf.includes('link-local'),
    privateRange: stderrBuf.includes('private address'),
  };
}

describe('warnIfPrivateAddress — silent (no warning)', () => {
  it('localhost (RFC 6761)', () => {
    expect(probe('http://localhost:3000/hook').warned).toBe(false);
  });

  it('*.localhost subdomains', () => {
    expect(probe('http://api.localhost:3000/hook').warned).toBe(false);
  });

  it('IPv4 loopback 127.0.0.1', () => {
    expect(probe('http://127.0.0.1:3000/hook').warned).toBe(false);
  });

  it('IPv4 loopback elsewhere in 127/8', () => {
    expect(probe('http://127.5.6.7:3000/hook').warned).toBe(false);
  });

  it('public IPv4 address (Google DNS)', () => {
    expect(probe('https://8.8.8.8/hook').warned).toBe(false);
  });

  it('public hostname', () => {
    expect(probe('https://api.example.com/hook').warned).toBe(false);
  });

  // Note: octets above 255 (`256.1.1.1`, `999.999.999.999`) are
  // rejected by Node's URL parser before they reach the SSRF guard,
  // so the bounded-octet regex (0..255) is purely defence-in-depth.
  // We can't construct a URL that exercises the boundary without
  // tripping URL validation first, so the regex bound is asserted by
  // inspection rather than a runtime case.

  it('IPv4 boundary: 172.15.x.x is NOT private (172.16-172.31 is)', () => {
    expect(probe('http://172.15.0.1/hook').warned).toBe(false);
  });

  it('IPv4 boundary: 172.32.x.x is NOT private', () => {
    expect(probe('http://172.32.0.1/hook').warned).toBe(false);
  });
});

describe('warnIfPrivateAddress — private-range warnings', () => {
  it('IPv4 10/8', () => {
    const r = probe('http://10.0.0.1/hook');
    expect(r.privateRange).toBe(true);
    expect(r.linkLocal).toBe(false);
  });

  it('IPv4 172.16/12 lower bound', () => {
    expect(probe('http://172.16.0.1/hook').privateRange).toBe(true);
  });

  it('IPv4 172.16/12 upper bound', () => {
    expect(probe('http://172.31.255.255/hook').privateRange).toBe(true);
  });

  it('IPv4 192.168/16', () => {
    expect(probe('http://192.168.1.1/hook').privateRange).toBe(true);
  });

  it('IPv6 loopback ::1', () => {
    expect(probe('http://[::1]:3000/hook').privateRange).toBe(true);
  });

  it('IPv6 unique-local fc00::/7 — fc00 prefix', () => {
    expect(probe('http://[fc00::1]/hook').privateRange).toBe(true);
  });

  it('IPv6 unique-local fc00::/7 — fd prefix', () => {
    expect(probe('http://[fd00::1]/hook').privateRange).toBe(true);
  });
});

describe('warnIfPrivateAddress — link-local warnings (louder)', () => {
  it('IPv4 link-local 169.254.169.254 (cloud metadata service)', () => {
    const r = probe('http://169.254.169.254/latest/meta-data/');
    expect(r.linkLocal).toBe(true);
    expect(r.privateRange).toBe(false);
  });

  it('IPv4 link-local elsewhere in 169.254/16', () => {
    expect(probe('http://169.254.42.42/hook').linkLocal).toBe(true);
  });

  it('IPv6 link-local fe80::', () => {
    expect(probe('http://[fe80::1]/hook').linkLocal).toBe(true);
  });

  it('IPv6 link-local fe80::/10 lower bound — fe80', () => {
    expect(probe('http://[fe80::1]/hook').linkLocal).toBe(true);
  });

  it('IPv6 link-local fe80::/10 upper bound — febf', () => {
    expect(probe('http://[febf::1]/hook').linkLocal).toBe(true);
  });

  it('IPv6 fec0:: is NOT link-local (deprecated site-local, falls through silent)', () => {
    // fec0::/10 was site-local but is deprecated (RFC 3879). Our
    // regex deliberately doesn't flag it — operators using
    // deprecated address space are on their own.
    expect(probe('http://[fec0::1]/hook').warned).toBe(false);
  });
});

describe('isPrivateAddress — pure predicate (drives --refuse-private-addresses)', () => {
  // Mirrors `warnIfPrivateAddress` boundary tests but asserts on the
  // returned boolean, used by the CLI's hard-fail policy. Same source
  // of truth (the literal-IP regex set), so adding new private ranges
  // here without updating the warner — or vice-versa — would surface
  // as a paired-test failure.
  it('flags localhost / *.localhost / 127.x.x.x', () => {
    expect(isPrivateAddress(new URL('http://localhost/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://api.localhost/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://127.0.0.1/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://127.5.6.7/x'))).toBe(true);
  });

  it('flags every IPv4 private range', () => {
    expect(isPrivateAddress(new URL('http://10.0.0.1/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://172.16.0.1/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://172.31.255.255/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://192.168.1.1/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://169.254.169.254/x'))).toBe(true);
  });

  it('flags IPv6 loopback / link-local / unique-local', () => {
    expect(isPrivateAddress(new URL('http://[::1]/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://[fe80::1]/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://[fc00::1]/x'))).toBe(true);
    expect(isPrivateAddress(new URL('http://[fd00::1]/x'))).toBe(true);
  });

  it('does NOT flag public IPs / hostnames / out-of-range IPv4', () => {
    expect(isPrivateAddress(new URL('http://8.8.8.8/x'))).toBe(false);
    expect(isPrivateAddress(new URL('https://api.example.com/x'))).toBe(false);
    expect(isPrivateAddress(new URL('http://172.15.0.1/x'))).toBe(false); // just outside 172.16/12
    expect(isPrivateAddress(new URL('http://172.32.0.1/x'))).toBe(false);
  });

  it('does NOT flag deprecated site-local fec0::/10 (intentional fall-through)', () => {
    expect(isPrivateAddress(new URL('http://[fec0::1]/x'))).toBe(false);
  });
});
