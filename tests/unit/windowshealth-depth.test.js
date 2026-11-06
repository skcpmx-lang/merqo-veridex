/**
 * Component-store health, adversarially.
 *
 * The existing suite proves the three DISM sentences are read. This one attacks the edges the
 * report depends on: what happens when the output is ambiguous, when the tool times out, when
 * it exits non-zero after printing a verdict, and when it is localized on a machine that is not
 * English. Each of those is a way for a diagnostic tool to say "your system files are fine"
 * without having established it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDismHealth, describeStoreHealth, registerWindowsHealth } from '../../src/diagnostics/windowshealth.js';
import { Status } from '../../src/core/status.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';

function providerOf() {
  const registry = new ProviderRegistry();
  registerWindowsHealth(registry);
  return registry.providers.get('dism.checkhealth');
}

/** Collect with a runner that records every command and answers with `answer`. */
async function collectWith(answer, { isAdmin = true } = {}) {
  const provider = providerOf();
  const calls = [];
  const fields = await provider.collect({
    permissions: { isAdmin },
    runner: {
      run: async (command, args) => {
        calls.push([command, ...(args ?? [])].join(' '));
        return typeof answer === 'function' ? answer(command, args) : answer;
      }
    },
    logger: null,
    timeoutMs: 5000
  });
  return { fields, calls };
}

// ── Invocation ─────────────────────────────────────────────────────────────

test('the only DISM invocation is the read-only CheckHealth form', async () => {
  const { calls } = await collectWith({ ok: true, code: 0, stdout: 'No component store corruption detected.', stderr: '' });
  assert.deepEqual(calls, ['dism.exe /Online /Cleanup-Image /CheckHealth']);

  // The repair switches must never appear in any command the provider builds.
  for (const call of calls) {
    assert.ok(!/RestoreHealth/i.test(call), 'RestoreHealth writes to the store and must never be run');
    assert.ok(!/sfc/i.test(call), 'sfc /scannow is not this module\'s job and must not be run');
    assert.ok(!/\/StartComponentCleanup|\/ResetBase/i.test(call), 'cleanup switches modify the store');
  }
});

test('the provider declares a budget shorter than its own task timeout', () => {
  const provider = providerOf();
  assert.ok(provider.timeoutMs >= 60_000, 'the servicing stack can be slow; the budget must allow for it');
  assert.ok(provider.timeoutMs <= 180_000, 'but a hung check must not hold the scan for minutes');
});

// ── Timeouts ───────────────────────────────────────────────────────────────

test('a timeout is reported as a timeout, not as a failure or a verdict', async () => {
  const { fields } = await collectWith({ ok: false, timedOut: true, code: null, stdout: '', stderr: '' });
  assert.equal(fields.componentStore.status, Status.UNAVAILABLE, 'a timed-out check leaves the store untested');
  assert.match(fields.componentStore.error, /budget|busy/i, 'the reason must name the timeout');
});

// ── Exit codes ─────────────────────────────────────────────────────────────

test('a verdict printed by a DISM run that then failed is not promoted to a pass', async () => {
  // Real DISM exits 0 for all three verdicts. A non-zero exit means DISM itself had trouble,
  // so a healthy sentence from that run cannot be a confident pass.
  const { fields } = await collectWith({
    ok: false,
    code: 1,
    stdout: 'No component store corruption detected.',
    stderr: 'Error: 0x800f081f'
  });
  assert.notEqual(fields.componentStore.status, Status.PASS, 'a failed DISM run must not produce a pass');
  assert.equal(fields.componentStore.status, Status.WARNING);
  assert.match(fields.componentStore.notes.join(' '), /exit|failed|trouble/i);
});

test('every verdict DISM can print is mapped to a status that matches its meaning', async () => {
  const cases = [
    ['No component store corruption detected.', Status.PASS],
    ['The component store is repairable.', Status.WARNING],
    ['The component store is not repairable.', Status.FAIL]
  ];
  for (const [stdout, expected] of cases) {
    const { fields } = await collectWith({ ok: true, code: 0, stdout, stderr: '' });
    assert.equal(fields.componentStore.status, expected, `"${stdout}"`);
  }
});

// ── Ambiguity ──────────────────────────────────────────────────────────────

test('output containing two different verdicts is ambiguous and becomes unknown', async () => {
  // This is the case that would silently pick the cheerful answer: the healthy sentence appears
  // first in the output, and a naive first-match parser stops there.
  const mixed =
    'No component store corruption detected.\r\n' +
    'The component store is not repairable.\r\n' +
    'The operation completed successfully.\r\n';
  assert.equal(parseDismHealth(mixed).verdict, 'unknown', 'a contradictory answer must not be resolved by order');

  const { fields } = await collectWith({ ok: true, code: 0, stdout: mixed, stderr: '' });
  assert.notEqual(fields.componentStore.status, Status.PASS);
  assert.equal(fields.componentStore.status, Status.UNSUPPORTED);
});

// ── Localization and noise ─────────────────────────────────────────────────

test('a localized DISM is unknown rather than guessed', async () => {
  // On a German or Japanese Windows the sentences are translated. The parser has no business
  // inferring "healthy" from the shape of an unfamiliar sentence.
  for (const localized of [
    'Es wurde keine Komponentenspeicherbeschädigung erkannt.',
    'コンポーネント ストアの破損は検出されませんでした。',
    'Aucune corruption du magasin de composants détectée.'
  ]) {
    assert.equal(parseDismHealth(localized).verdict, 'unknown', localized.slice(0, 20));
  }
});

test('DISM noise around a real sentence does not prevent it being read', async () => {
  const noisy = [
    'Deployment Image Servicing and Management tool',
    'Version: 10.0.26100.1150',
    '',
    'Image Version: 10.0.26100.2314',
    '',
    'No component store corruption detected.',
    'The operation completed successfully.',
    ''
  ].join('\r\n');
  const parsed = parseDismHealth(noisy);
  assert.equal(parsed.verdict, 'healthy');
  assert.match(parsed.sentence, /^No component store corruption detected/);
  assert.ok(!/Deployment Image Servicing/.test(parsed.sentence), 'the reported sentence must be the verdict, not the banner');
});

// ── Privilege handling ─────────────────────────────────────────────────────

test('a standard user gets a refusal and DISM is never invoked', async () => {
  const { fields, calls } = await collectWith({ ok: true, stdout: 'No component store corruption detected.' }, { isAdmin: false });
  assert.equal(fields.componentStore.status, Status.PERMISSION_REQUIRED);
  assert.deepEqual(calls, [], 'no privileged process may be spawned for a standard user');
  assert.match(fields.componentStore.error, /administrative rights/i);
});

// ── Describing the answer ──────────────────────────────────────────────────

test('an unknown verdict never yields a passing field, whatever the RAW text says', () => {
  const fields = describeStoreHealth({ verdict: 'unknown', sentence: null, raw: 'No component store corruption detected.' }, 'dism');
  assert.equal(fields.componentStore.status, Status.UNSUPPORTED);
  // The verdict field carries the refusal in `error`, because a refusal has no value to show.
  assert.match(fields.componentStoreVerdict.error, /Unrecognised DISM output/);
  // The raw text is quoted for the reader's benefit, capped so a wall of DISM output cannot
  // become the report.
  assert.ok(fields.componentStore.notes.join(' ').length < 400);
});

test('the repairable case names the exact repair command as the user\'s own action', () => {
  const fields = describeStoreHealth({ verdict: 'repairable', sentence: 'The component store is repairable.', raw: '' }, 'dism');
  const text = JSON.stringify(fields);
  assert.match(text, /RestoreHealth/);
  assert.match(fields.componentStoreRepair.value, /^Manual:/, 'the repair must be recorded as a manual step');
  assert.equal(fields.componentStoreRepair.status, Status.WARNING);
});
