/**
 * The read-only guarantee is the product's central promise (docs/SECURITY.md §3), and
 * until now it had no test: the forbidden-command table was enforced in code but never
 * exercised. A pattern that silently stops matching, or a destructive verb added without
 * a rule, would have shipped unnoticed.
 *
 * These tests assert the guarantee from the outside: given a damaging command line,
 * the classifier must refuse it and say why. They also assert the inverse, because a
 * guard that forbids harmless reads would make the product useless — the diagnostics
 * VERIDEX actually runs must pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORBIDDEN_COMMANDS,
  CONSENT_REQUIRED,
  NETWORK_ALLOWLIST,
  SecurityGuard,
  classifyCommand,
  commandLine,
  guardFields,
  readOnlyPolicy
} from '../../src/security/guard.js';

// ── Cases that must be refused ───────────────────────────────────────────────
// Each entry is a command line an attacker, a confused user, or a well-meaning
// feature request might produce. None of them may ever run.

const DESTRUCTIVE = [
  ['format C:', ['/q'], 'format-volume'],
  ['diskpart', ['/s', 'wipe.txt'], 'diskpart-script'],
  ['chkdsk', ['C:', '/f'], 'chkdsk-repair'],
  ['chkdsk', ['C:', '/r'], 'chkdsk-repair'],
  ['sfc', ['/scannow'], 'sfc-repair'],
  ['DISM', ['/Online', '/Cleanup-Image', '/RestoreHealth'], 'dism-repair'],
  ['bcdedit', ['/set', '{default}', 'safeboot'], 'bcd-edit'],
  ['reg', ['add', 'HKLM\\Software\\X', '/v', 'y'], 'registry-write'],
  ['pnputil', ['/delete-driver', 'oem1.inf'], 'driver-remove'],
  ['manage-bde', ['-off', 'C:'], 'bitlocker-off'],
  ['netsh', ['advfirewall', 'set', 'allprofiles', 'state', 'off'], 'firewall-disable'],
  ['powercfg', ['/change', 'monitor-timeout-ac', '0'], 'power-plan-write'],
  ['shutdown', ['/s', '/t', '0'], 'shutdown'],
  ['rstrui', [], 'restore-point']
];

test('every destructive command line is refused, with a reason', () => {
  for (const [command, args, expectedId] of DESTRUCTIVE) {
    const verdict = classifyCommand(command, args);
    assert.equal(
      verdict.verdict,
      'forbid',
      `${commandLine(command, args)} must be refused, got "${verdict.verdict}"`
    );
    assert.equal(verdict.id, expectedId, `${commandLine(command, args)} matched the wrong rule`);
    assert.ok(verdict.reason && verdict.reason.length > 10, `rule ${expectedId} must explain itself`);
  }
});

test('operations that write files are held for consent rather than forbidden', () => {
  // These four are not destructive to the system, but they write to disk, so they are
  // gated rather than banned. docs/SECURITY.md previously listed them as forbidden,
  // which the classifier contradicted.
  const gated = [
    ['disk-bench', ['--write', 'C:'], 'disk-write-benchmark'],
    ['pnputil', ['/export-driver', 'oem1.inf', 'D:\\drivers'], 'driver-export'],
    ['wevtutil', ['epl', 'System', 'sys.evtx'], 'event-log-export'],
    ['wpr', ['-start', 'GeneralProfile'], 'trace-capture']
  ];
  for (const [command, args, expectedId] of gated) {
    const verdict = classifyCommand(command, args);
    assert.equal(verdict.verdict, 'needs-consent', `${commandLine(command, args)} must be gated`);
    assert.equal(verdict.id, expectedId);
  }

  // And the guard enforces the gate: no consent recorded, no execution.
  const guard = new SecurityGuard();
  assert.equal(guard.checkCommand('wpr', ['-start', 'GeneralProfile']).allowed, false);
  guard.grantConsent('trace-capture');
  assert.equal(guard.checkCommand('wpr', ['-start', 'GeneralProfile']).allowed, true);
});

test('the forbidden table itself stays complete', () => {
  // Every rule must carry an id, a pattern and a human reason: a rule without a reason
  // cannot be shown to the user, and a rule without an id cannot be logged.
  for (const rule of FORBIDDEN_COMMANDS) {
    assert.ok(rule.id, 'every forbidden rule needs an id');
    assert.ok(rule.pattern instanceof RegExp, `rule ${rule.id} needs a RegExp pattern`);
    assert.ok(rule.reason && rule.reason.length > 10, `rule ${rule.id} needs a real reason`);
  }
  assert.equal(new Set(FORBIDDEN_COMMANDS.map((rule) => rule.id)).size, FORBIDDEN_COMMANDS.length, 'rule ids must be unique');
});

test('a scripted diskpart run is refused, because the script cannot be inspected', () => {
  // Found while writing this test: `diskpart /s wipe.txt` was allowed while
  // `diskpart` + `clean` was refused, so the guard could be bypassed with a file.
  assert.equal(classifyCommand('diskpart', ['/s', 'wipe.txt']).verdict, 'forbid');
  assert.equal(classifyCommand('diskpart', ['/S', 'C:\\temp\\script.txt']).id, 'diskpart-script');
});

test('a shell asked to destroy a disk is refused however it is spelled', () => {
  const variants = [
    ['powershell', ['-Command', 'Clear-Disk', '-Number', '0']],
    ['powershell.exe', ['-c', 'Format-Volume -DriveLetter D']],
    ['cmd', ['/c', 'format D:']],
    ['pwsh', ['-Command', 'Initialize-Disk -Number 1']]
  ];
  for (const [command, args] of variants) {
    assert.equal(classifyCommand(command, args).verdict, 'forbid', `${commandLine(command, args)} slipped through`);
  }
  // The read-only PowerShell VERIDEX actually uses must still work.
  assert.equal(classifyCommand('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_DiskDrive']).verdict, 'allow');
});

test('caps and spacing do not slip a destructive command past the guard', () => {
  // Windows command lines are case-insensitive, and callers paste extra spaces.
  const variants = [
    ['FORMAT', ['D:']],
    ['SFC', ['/SCANNOW']],
    ['Reg', ['ADD', 'HKCU\\X']],
    ['chkdsk', ['c:', '/F']],
    ['  diskpart  ', ['  clean  ']]
  ];
  for (const [command, args] of variants) {
    assert.equal(classifyCommand(command, args).verdict, 'forbid', `${commandLine(command, args)} slipped through`);
  }
});

// ── Cases that must be allowed ───────────────────────────────────────────────
// These are the read-only diagnostics the product exists to run. If the guard is too
// broad, the product stops working, so the permissive direction is tested too.

const READ_ONLY = [
  ['chkdsk', ['C:', '/scan']],
  ['sfc', ['/VERIFYONLY']],
  ['DISM', ['/Online', '/Cleanup-Image', '/CheckHealth']],
  ['wmic', ['cpu', 'get', 'name']],
  ['powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Processor']],
  ['systeminfo'],
  ['powercfg', ['/batteryreport']],
  ['reg', ['query', 'HKLM\\Software']],
  ['wevtutil', ['qe', 'System']],
  ['pnputil', ['/enum-drivers']],
  ['manage-bde', ['-status', 'C:']]
];

test('read-only diagnostics are allowed to run', () => {
  for (const [command, args] of READ_ONLY) {
    const verdict = classifyCommand(command, args);
    assert.notEqual(verdict.verdict, 'forbid', `${commandLine(command, args)} must not be forbidden`);
  }
});

test('operations that need administrator rights are held for consent, not run silently', () => {
  assert.ok(CONSENT_REQUIRED.length > 0, 'the consent table must not be empty');
  for (const rule of CONSENT_REQUIRED) {
    assert.ok(rule.id && rule.reason, `consent rule ${rule.id} needs an id and a reason`);
  }
});

// ── The guard object, not just the classifier ────────────────────────────────

test('the guard records a refusal instead of throwing it away', () => {
  const guard = new SecurityGuard();
  const result = guard.checkCommand('format', ['C:'], { task: 'test' });
  assert.equal(result.allowed, false, 'the guard refuses the command');
  assert.equal(result.verdict, 'forbid');

  const summary = guard.summary();
  assert.ok(summary.unsafeCommandsBlocked >= 1, 'a forbidden command must be counted');
  assert.ok(
    guard.refusals.some((refusal) => refusal.kind === 'command' && refusal.reason.length > 10),
    'the refusal must be kept with its reason'
  );
});

test('a blocked command is visible in the exported report, not only in a log', () => {
  const guard = new SecurityGuard();
  // Refuse something so the summary is non-empty.
  guard.checkCommand('diskpart', ['clean'], { task: 'test' });
  const fields = guardFields(guard.summary());
  assert.ok(fields.unsafeCommandsBlocked, 'the report must carry the blocked count');
  assert.equal(fields.unsafeCommandsBlocked.status, 'WARNING', 'a refusal is a warning the user sees');
  assert.equal(typeof fields.statement.value, 'string');
});

// ── Network ──────────────────────────────────────────────────────────────────

test('network access is off unless explicitly enabled', () => {
  const guard = new SecurityGuard();
  assert.equal(guard.networkAllowed, false, 'the default must be offline');
  assert.equal(guard.checkUrl('https://example.com/x', { task: 'test' }).allowed, false);
  assert.ok(guard.summary().networkAttemptsBlocked >= 1);
});

test('an allowlisted host still needs the setting turned on', () => {
  const host = NETWORK_ALLOWLIST[0];
  const off = new SecurityGuard();
  assert.equal(off.checkUrl(`https://${host}/x`, { task: 'test' }).allowed, false, 'the setting gates everything');

  const on = new SecurityGuard({ policy: { allowNetwork: true } });
  assert.equal(on.checkUrl(`https://${host}/x`, { task: 'test' }).allowed, true);
});

test('even with networking on, an unlisted host is refused', () => {
  const guard = new SecurityGuard({ policy: { allowNetwork: true } });
  const verdict = guard.checkUrl('https://evil.example/collect', { task: 'test' });
  assert.equal(verdict.allowed, false, 'the setting is not a general-purpose egress permit');
  assert.equal(verdict.id, 'host-not-allowlisted');
});

test('a malformed URL is refused rather than guessed at', () => {
  const guard = new SecurityGuard({ policy: { allowNetwork: true } });
  const verdict = guard.checkUrl('not a url', { task: 'test' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.id, 'invalid-url');
});

// ── The policy is published as data ──────────────────────────────────────────

test('the policy quoted to the user matches the policy enforced', () => {
  const policy = readOnlyPolicy();
  assert.equal(policy.forbidden.length, FORBIDDEN_COMMANDS.length, 'every enforced rule must be disclosed');
  assert.equal(policy.consentRequired.length, CONSENT_REQUIRED.length);
  assert.match(policy.statement, /read-only/i);
  for (const entry of policy.forbidden) {
    assert.ok(entry.reason.length > 10, `the user must be told why ${entry.id} is forbidden`);
  }
});
