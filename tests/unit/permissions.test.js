/**
 * The permission model decides whether a report says "you need administrator rights" or
 * "this machine does not support that". Getting it wrong in the second direction is the
 * failure this product exists to avoid: a capability that was blocked would be reported
 * as absent hardware, which is a lie the user cannot detect.
 *
 * The module had no tests. These assert the distinctions it is built on, including the
 * one that matters most: a probe failure must never be read as "standard user, everything
 * is fine" when the truth is "we do not know".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  blockedCapabilities,
  capability,
  capabilityMatrix,
  detectPermissionState,
  gate,
  requiresAdmin
} from '../../src/platform/permissions.js';
import { Status } from '../../src/core/status.js';

/** A runner that answers the elevation probe with a fixed result. */
function stubRunner({ isWindows = true, powershell = { ok: true, data: [true], error: null }, session = { ok: false, code: 5, error: null } } = {}) {
  return {
    isWindows,
    powershellJson: async () => powershell,
    run: async () => session
  };
}

// ── The capability table ─────────────────────────────────────────────────────

test('every capability declares a label, a boolean requirement and a reason', () => {
  const entries = Object.entries(CAPABILITIES);
  assert.ok(entries.length >= 10, 'the capability table must cover the privileged reads');
  for (const [id, info] of entries) {
    assert.match(id, /^[a-z]+\.[A-Za-z][A-Za-z.]*$/, `capability id "${id}" should be <area>.<thing>`);
    assert.ok(info.label && info.label.length > 8, `${id} needs a human label`);
    assert.equal(typeof info.requiresAdmin, 'boolean', `${id} must state whether it needs elevation`);
    assert.ok(info.reason && info.reason.length > 20, `${id} needs a reason the user can act on`);
  }
});

test('the capability table is frozen, so a provider cannot widen its own access', () => {
  assert.ok(Object.isFrozen(CAPABILITIES));
});

test('an unknown capability is reported as unknown, not as permitted', () => {
  assert.equal(capability('made.up'), null);
  // requiresAdmin defaults false for unknown ids, but gate() throws rather than allowing
  // an unclassified capability through.
  assert.equal(requiresAdmin('made.up'), false);
  assert.throws(() => gate('made.up', { isAdmin: true }), /Unknown capability/);
});

// ── Elevation detection ──────────────────────────────────────────────────────

test('an elevated token is detected from the authoritative probe', async () => {
  const state = await detectPermissionState(stubRunner());
  assert.equal(state.isAdmin, true);
  assert.equal(state.mode, 'elevated');
  assert.match(state.detail, /WindowsPrincipal/);
  assert.ok(state.detectedAt, 'the state must be timestamped for the report');
});

test('a standard-user token is detected without falling through to the fallback', async () => {
  const state = await detectPermissionState(stubRunner({ powershell: { ok: true, data: [false], error: null } }));
  assert.equal(state.isAdmin, false);
  assert.equal(state.mode, 'standard');
  assert.match(state.detail, /WindowsPrincipal/);
});

test('a JSON-encoded boolean is accepted, because PowerShell may serialise it', async () => {
  for (const raw of ['True', 'true', true]) {
    const state = await detectPermissionState(stubRunner({ powershell: { ok: true, data: raw, error: null } }));
    assert.equal(state.isAdmin, true, `"${raw}" should read as elevated`);
  }
});

test('when the authoritative probe fails, the fallback decides — and says so', async () => {
  const elevated = await detectPermissionState(
    stubRunner({ powershell: { ok: false, data: null, error: 'no powershell' }, session: { ok: true, code: 0 } })
  );
  assert.equal(elevated.isAdmin, true);
  assert.match(elevated.detail, /fallback probe/);
  assert.match(elevated.detail, /no powershell/, 'the primary failure must be recorded, not discarded');

  const standard = await detectPermissionState(
    stubRunner({ powershell: { ok: false, data: null, error: 'blocked' }, session: { ok: false, code: 5 } })
  );
  assert.equal(standard.isAdmin, false);
  assert.match(standard.detail, /exit 5/);
});

test('a non-Windows host reports standard mode with that reason', async () => {
  const state = await detectPermissionState(stubRunner({ isWindows: false }));
  assert.equal(state.isWindows, false);
  assert.equal(state.isAdmin, false);
  assert.equal(state.mode, 'standard');
  assert.match(state.detail, /not applicable/i);
});

// ── Gating ───────────────────────────────────────────────────────────────────

test('a capability that needs elevation is refused as PERMISSION_REQUIRED, never unavailable', () => {
  const result = gate('storage.smart', { isAdmin: false }, { source: 'ata-smart.storage' });
  assert.equal(result.allowed, false);
  assert.equal(result.field.status, Status.PERMISSION_REQUIRED);
  // A blocked capability carries a null value and the reason in `error`: there is no
  // value, and pretending otherwise would put a string where a measurement belongs.
  assert.equal(result.field.value, null);
  assert.match(result.field.error, /blocked for standard users/i, 'the reason must explain who is blocked');
  assert.equal(result.field.permissionRequired, true);
  assert.equal(result.field.source, 'ata-smart.storage');
});

test('the same capability is allowed with an elevated token', () => {
  const result = gate('storage.smart', { isAdmin: true }, { value: 'OK', source: 'ata-smart.storage' });
  assert.equal(result.allowed, true);
  assert.equal(result.field.status, Status.PASS);
  assert.equal(result.field.value, 'OK');
});

test('a capability that does not need elevation is allowed for a standard user', () => {
  // battery.cycleCount is firmware-exposed and needs no token; gating it on elevation
  // would have hidden a readable value behind an unnecessary prompt.
  assert.equal(requiresAdmin('battery.cycleCount'), false);
  const result = gate('battery.cycleCount', { isAdmin: false }, { value: 214 });
  assert.equal(result.allowed, true);
  assert.equal(result.field.status, Status.PASS);
  assert.equal(result.field.value, 214);
});

test('a permitted capability with no value returns no field rather than a fake one', () => {
  const result = gate('battery.cycleCount', { isAdmin: false });
  assert.equal(result.allowed, true);
  assert.equal(result.field, null, 'no data must stay no data');
});

// ── The matrix shown to the user ─────────────────────────────────────────────

test('the capability matrix explains every blocked entry', () => {
  const matrix = capabilityMatrix({ isAdmin: false, isWindows: true });
  assert.equal(matrix.length, Object.keys(CAPABILITIES).length);

  for (const entry of matrix) {
    if (entry.status === Status.PERMISSION_REQUIRED) {
      assert.ok(entry.reason && entry.reason.length > 20, `${entry.id} is blocked without explaining why`);
      assert.equal(entry.requiresAdmin, true, `${entry.id} is blocked but claims not to need elevation`);
    } else {
      assert.equal(entry.status, Status.PASS);
      assert.equal(entry.reason, null);
    }
  }
});

test('an elevated session blocks nothing', () => {
  const blocked = blockedCapabilities({ isAdmin: true, isWindows: true });
  assert.deepEqual(blocked, [], 'an elevated run must not report a blocked capability');
  const matrix = capabilityMatrix({ isAdmin: true, isWindows: true });
  assert.ok(matrix.every((entry) => entry.status === Status.PASS));
});

test('a standard session blocks exactly the elevated capabilities', () => {
  const blocked = blockedCapabilities({ isAdmin: false, isWindows: true });
  const expected = Object.entries(CAPABILITIES).filter(([, info]) => info.requiresAdmin).map(([id]) => id);
  assert.deepEqual(blocked.map((entry) => entry.id).sort(), expected.sort());
  assert.ok(blocked.length > 0, 'a standard session must block something, or the model is not being applied');
});

test('the blocked count feeds the score, so it must not be zero by accident', () => {
  // If this ever returns 0 for a standard session, coverage would look better than it is.
  assert.ok(blockedCapabilities({ isAdmin: false }).length >= 5);
});
