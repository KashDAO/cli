/**
 * Version manifest must include every field an AI agent or issue
 * triage would want when the user reports a bug. Keep this list
 * stable — additions are minor bumps, removals are major bumps.
 */

import { describe, expect, it } from 'vitest';

import { buildVersionManifest } from '../../../src/commands/version.js';
import { CLI_VERSION } from '../../../src/version.js';

describe('buildVersionManifest', () => {
  it('returns the documented shape', () => {
    const manifest = buildVersionManifest();
    expect(manifest).toMatchObject({
      cli: CLI_VERSION,
      sdk: expect.any(String),
      node: expect.stringMatching(/^v\d+/),
      platform: expect.any(String),
      release: expect.any(String),
      arch: expect.any(String),
    });
  });

  it('reports a real SDK version (not "unknown") when @kashdao/sdk resolves', () => {
    const manifest = buildVersionManifest();
    expect(manifest.sdk).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Capabilities are the agent feature-detection contract. Tests pin
  // the load-bearing tokens — a missing one means a regression in
  // what the CLI claims to support, and an agent that pins to it
  // will misbehave.
  it('advertises the load-bearing agent capabilities', () => {
    const manifest = buildVersionManifest();
    expect(manifest.capabilities).toBeDefined();
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        // Output / agent surface
        'json-envelope',
        'json-quiet',
        'fields-projection',
        'filter-dsl',
        'ndjson-streaming',
        // Error surface
        'kash-explain',
        'structured-actions',
        // Trade modes
        'trade-place',
        'protocol-trade',
        'eoa-trade',
        'partial-completion-records',
        // Webhooks
        'webhooks-replay',
        'webhooks-replay-dry-run',
        'webhooks-replay-refuse-private',
      ])
    );
  });

  it('does NOT advertise capabilities for features that have not shipped', () => {
    // Pin: until the MCP server is implemented, agents must not see
    // `mcp-server` in the capability set. When MCP ships, add it to
    // ADVERTISED_CAPABILITIES and update this test (or delete it —
    // its job will be done).
    const manifest = buildVersionManifest();
    expect(manifest.capabilities).not.toContain('mcp-server');
  });
});
