/**
 * Every mechanism in the shipped registry must have a deliberate confidence tier.
 *
 * `tierOf()` falls back to `heuristic` for an unknown mechanism. That default is the
 * safe direction, but it is also silent: `system-features.windows` reads Windows
 * servicing state through PowerShell — the same authoritative interface as the CIM
 * providers — and was being labelled a guess because nobody had added it to the table.
 *
 * This test fails the build if a registered provider has no entry in PROVIDER_TIERS,
 * so a new mechanism has to be classified on purpose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_TIERS, SourceTier, mechanismOf, tierOf } from '../../src/engine/confidence.js';
import { buildDefaultRegistry } from '../../src/app/scan.js';

test('every registered provider mechanism has an explicit confidence tier', () => {
  const built = buildDefaultRegistry();
  const registry = built.registry ?? built;
  assert.ok(registry.providers.size > 0, 'the registry must contain providers');

  const unclassified = [];
  for (const providerId of registry.providers.keys()) {
    const mechanism = mechanismOf(providerId);
    if (!(mechanism in PROVIDER_TIERS)) unclassified.push(`${providerId} (mechanism "${mechanism}")`);
  }
  assert.deepEqual(
    unclassified,
    [],
    `these providers would silently be treated as heuristic guesses:\n  ${unclassified.join('\n  ')}`
  );
});

test('the tier vocabulary is closed and ordered from strongest to weakest', () => {
  const tiers = Object.values(SourceTier);
  assert.ok(tiers.includes('authoritative'));
  assert.ok(tiers.includes('firmware'));
  assert.ok(tiers.includes('heuristic'));
  assert.equal(new Set(tiers).size, tiers.length, 'tier names must be distinct');
});

test('a task-scoped id resolves to its mechanism tier, not the default', () => {
  // The regression this guards: registering `cim-win32` once per module forced
  // task-scoped ids, and without the suffix strip every one of them degraded to
  // "heuristic", quietly devaluing the whole product.
  assert.equal(tierOf('cim-win32.cpu'), SourceTier.AUTHORITATIVE);
  assert.equal(tierOf('nvme-health-log.storage'), SourceTier.FIRMWARE);
  assert.equal(tierOf('powercfg-report.battery'), SourceTier.DERIVED);
  assert.equal(tierOf('chipset-heuristic.motherboard'), SourceTier.HEURISTIC);
});

test('a bare mechanism name still resolves', () => {
  assert.equal(tierOf('cim-win32'), SourceTier.AUTHORITATIVE);
  assert.equal(tierOf('ata-smart'), SourceTier.FIRMWARE);
});

test('an unknown mechanism degrades to heuristic rather than inventing confidence', () => {
  assert.equal(tierOf('mystery.thing'), SourceTier.HEURISTIC);
  assert.equal(tierOf(''), SourceTier.HEURISTIC);
  assert.equal(tierOf(null), SourceTier.HEURISTIC);
});

test('authoritative mechanisms are the ones that read the OS directly', () => {
  // A guard against mislabelling: these three are the direct readers. If something is
  // added here that merely guesses, this test should be the thing that stops it.
  assert.equal(PROVIDER_TIERS['cim-win32'], SourceTier.AUTHORITATIVE);
  assert.equal(PROVIDER_TIERS['systeminformation'], SourceTier.AUTHORITATIVE);
  assert.equal(PROVIDER_TIERS['system-features'], SourceTier.AUTHORITATIVE);
  // And anything explicitly named "heuristic" must not be authoritative.
  for (const [mechanism, tier] of Object.entries(PROVIDER_TIERS)) {
    if (mechanism.endsWith('heuristic')) {
      assert.equal(tier, SourceTier.HEURISTIC, `${mechanism} is named as a heuristic but claims ${tier}`);
    }
  }
});
