# Security model

This document describes what VERIDEX can do to a machine, what it refuses to do, and
where those promises are enforced in code rather than merely intended. Every claim below
names the file that implements it, so a reader can check the document against the
source instead of trusting it.

If a statement here and the code disagree, the code is wrong and this document must be
corrected with it. `scripts/check.mjs` verifies that the files named here exist.

---

## 1. What VERIDEX is

VERIDEX is a **local hardware diagnostic tool for Windows**. It reads hardware and
operating-system state, scores the evidence it collected, and produces a report.

Three properties define the product, and all three are structural rather than
configurable:

| Property | What it means | Where it is enforced |
| --- | --- | --- |
| **Offline** | The application contains no network client. Nothing is uploaded. | `src/security/guard.js`, `scripts/verify-artifacts.mjs`, `tests/integration/no-network.test.js` |
| **Read-only** | No diagnostic operation modifies the machine. | `src/security/guard.js` (`FORBIDDEN_COMMANDS`), `src/platform/runner.js` |
| **Honest** | Missing evidence is reported as missing, never as healthy. | `src/core/field.js`, `src/engine/health.js` |

---

## 2. Offline by construction

### 2.1 There is no network client in the source

The strongest guarantee is not a setting: **VERIDEX's own source tree contains no
transport code.** There is no HTTP client, no socket, no DNS lookup, no telemetry
endpoint, no crash reporter and no auto-updater. Two mechanisms check this:

- `tests/integration/no-network.test.js` scans every file under `src/` for transport
  imports and calls (`node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`,
  `fetch(`, `XMLHttpRequest`, `WebSocket`) and fails if any appears.
- `scripts/verify-artifacts.mjs` re-checks the packaged output before a release.

A build of VERIDEX cannot "phone home" because there is nothing in it that could.

### 2.2 The runtime guard catches dependencies

`src/security/guard.js` installs a guard over four entry points:
`http.request`, `https.request`, the `get` functions on those modules, and
`globalThis.fetch`. Unless the user has explicitly turned network access on, every
outbound request is refused **before a socket is opened**, and the refusal is logged and
surfaced in the interface. Even when the setting is on, only allowlisted hosts are
permitted.

### 2.3 The guard's limits, stated plainly

The guard is not a kernel sandbox, and this document will not imply that it is:

- An ES module that captured a named binding (`import { request } from 'node:http'`)
  **before** the guard was installed keeps its own reference. ESM namespace objects are
  snapshots, so that module is not redirected.
- Code that reaches a raw socket through `node:net` or `node:tls` is out of reach.

This is why §2.1 exists. The guard is a second layer for dependencies, not the
foundation of the promise.

### 2.4 The renderer cannot reach the network either

`src/renderer/index.html` carries a strict Content-Security-Policy:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none';
base-uri 'none'
```

`connect-src 'none'` means the interface cannot make a single network request even if
it were compromised. There are no remote fonts, stylesheets, images or scripts; every
asset is local. `tests/integration/renderer.test.js` asserts the policy and fails if
`unsafe-inline`, `unsafe-eval` or any remote URL is introduced.

The renderer additionally has no Node integration: `contextIsolation` is on,
`nodeIntegration` is off, and `sandbox` is on. The only path from the interface to the
system is the narrow, explicitly enumerated surface in `src/app/preload.cjs`.

---

## 3. Read-only enforcement

### 3.1 Every command passes through one runner

No diagnostic module spawns a process directly. All execution goes through
`CommandRunner` in `src/platform/runner.js`, which consults the guard before a process
is created. A module that tried to call `child_process` itself would be caught by the
static checks.

### 3.2 Destructive operations are refused, not confirmed

`FORBIDDEN_COMMANDS` in `src/security/guard.js` lists operations VERIDEX **never**
performs, whatever the user clicks. These are not "ask first" prompts; there is no path
that runs them. The list includes, among others:

- volume formatting, `diskpart clean`, `mkfs`
- repairing `chkdsk` (`/f`, `/r`) — VERIDEX runs read-only `/scan` only
- repairing `sfc` (`/scannow`) — VERIDEX runs `/VERIFYONLY` only
- repairing `dism` (`/RestoreHealth`) — VERIDEX runs `/CheckHealth` and `/ScanHealth` only
- `bcdedit` edits, registry writes, driver removal via `pnputil /delete-driver`
- disabling Defender, the firewall, BitLocker or UAC
- firmware flashing, shutdown/restart, system-restore points
- recursive delete, power-plan modification, `netsh` resets
- a scripted `diskpart` run (`/s`): the script's contents cannot be inspected before
  it executes, so it is refused rather than run blind
- a shell command that formats or clears a disk, however it is spelled

Command lines are normalised before matching, so a path or a flag order does not slip
past a pattern. The set is table-driven and unit-tested (`tests/unit/security.test.js`). The tests assert
both directions: sixteen damaging command lines must be refused, and the eleven read-only
diagnostics VERIDEX actually runs must pass. A guard that is too broad makes the product
useless, which is why the permissive direction is tested too.

### 3.3 Write operations and elevated operations require explicit consent

Two classes of operation are gated behind consent rather than forbidden outright.

**Operations that write files.** Four: the write half of the disk benchmark (creates and
deletes a temporary file on the target volume), driver export via
`pnputil /export-driver`, event-log export via `wevtutil epl`, and ETW trace capture
(`wpr`, `tracelog`). None of them damages the system, but all of them write to disk, so
none runs without consent recorded for that specific operation.

**Operations that need administrator rights.** A few *read-only* reads still require
elevation to return data — reading the driver store, TPM state, or some storage health
counters, for example. Without consent the field is reported as `PERMISSION_REQUIRED`
with the reason, never as a pass.

`CONSENT_REQUIRED` in `src/security/guard.js` is the table; consent is recorded per
operation id, can be revoked, and is checked on every execution rather than remembered
for the session.

The application runs `asInvoker`: it does not start elevated. Elevation is requested for
an individual operation, at the moment it is needed, after the user has agreed to it.

---

## 4. Personal data

### 4.1 What is considered private

`PRIVACY_SENSITIVE` in `src/security/privacy.js` lists field-name fragments that identify
a person or a specific device: serial numbers, board and BIOS serials, MAC and IP
addresses, hostnames, the registered user and account names, `MachineGuid`, the Windows
product ID and product key, and Wi-Fi SSIDs. Keys are normalised (lowercase,
alphanumeric only) before matching, so `serial_number`, `serialNumber` and `SerialNumber`
all match.

A second list in `src/core/logger.js` is consulted as well. A key removed from one list
must never silently become exportable — both must agree before a field is treated as
public.

### 4.2 Redaction is on by default, and failure means redaction

`includeSensitive` defaults to `false`. The direction of failure is deliberate and
tested: `undefined`, `null`, `{}`, and any invalid settings value all yield
`includeSensitive: false` and `allowNetwork: false`. A settings file that cannot be read
never opens the export up; it closes it.

When a field is withheld, the report records that it was withheld and which category it
belonged to, so a reader can tell the difference between *"this machine has no serial
number"* and *"you chose not to show it"*.

### 4.3 Every report records its own redaction state

A report is not just data; it records the privacy policy that produced it. Opening an old
report therefore tells you exactly what it exposed. A redacted report cannot be mistaken
later for a complete one.

### 4.4 What is never collected

Some identifiers are refused regardless of settings — turning "include sensitive" on
does not mean "collect anything". `enforceNeverCollect()` and `mayCollectField()` in
`src/security/privacy.js` enforce the floor.

---

## 5. Logging

`src/core/logger.js` redacts sensitive keys on the way out rather than at the display
layer, so a log file written to disk never contains a raw serial number. Logs stay
local; there is no log upload path.

### 5.1 What a log record contains

A record is `{ts, level, scope, msg, ctx}`. `scope` names the subsystem that wrote it
(`app`, `scan`, `provider`, `settings`, …). `ctx` carries structured context such as the
provider id and the failure code.

Not logged, by construction:

- **command lines and process arguments** — a provider records that a command failed
  and its exit code, never the argument vector, because arguments can contain paths with
  account names in them;
- **field values** — a serial number, address or account name is never written to the log
  even when it is collected for a report;
- **full event messages** from the Windows event log — only the provider, the event id
  and the count.

Redaction runs on write and **again on export** (`src/app/logs.js`), so a file that
somehow contains an unredacted value cannot be exported unredacted. Export writes a
header naming the log level and the redaction state, and truncates a message at 500
characters with the truncation visible.

### 5.2 Rotation and deletion

Logs rotate by size (default 2 MB per file, 5 files). The oldest file is deleted when a
new one is created, so the folder has a hard ceiling. The Activity log page states the
real totals, offers deletion of the files, and says that nothing is uploaded. Deletion
removes the files on this machine; it does not touch reports the user has saved.

### 5.3 The elevated helper

Privileged work does not run inside the application. `src/app/elevate.js` holds a closed
allowlist of **named** tasks (`windows.componentHealth`, `drivers.export`,
`battery.report`), each with a fixed executable and an argument builder; the renderer can
only ask for a name, never for a command. `src/app/elevated-runner.js` starts the helper
in a separate elevated process through a single PowerShell shim, waits for a JSON result
file written to a temporary path, and:

- deletes any stale result file **before** the run, so a previous result cannot be
  mistaken for this one;
- kills the helper on timeout or on cancellation;
- treats a zero exit code with no result file as a **failure**, because a silent helper
  has told us nothing;
- classifies UAC decline (error 1223) before blaming a missing file, and reports it as
  *cancelled — continues at standard privilege*;
- refuses a missing, empty, malformed, non-object or oversized (> 64 KB) result.

Arguments that contain quotes, `$`, `;` or `|` are **refused, not escaped**. There is no
in-process fallback: if the elevated helper cannot be started, the task reports that it
did not run.

---

## 6. Integrity of the build

### 6.1 The build is unsigned, and says so

No code-signing certificate is available for this project. The installer and executables
are **unsigned**, Windows SmartScreen will warn on first run, and no publisher identity is
invented. `electron-builder.config.mjs` carries no signing configuration, and the release
notes state the limitation in the first section.

`scripts/verify-artifacts.mjs` produces `dist/SHA256SUMS.txt`, and the release publishes
it next to the binaries so a download can be checked before it is run.

### 6.2 Dependency surface

Runtime dependencies are two: `systeminformation` (hardware data) and `pdfkit` (PDF
output). Both are declared in `package.json` and pinned in `package-lock.json`.
`systeminformation` is unpacked from the asar archive because it reads native system
interfaces; everything else ships inside it.

Adding a dependency that opens a socket would fail `no-network.test.js` only if the
dependency were imported into `src/`; for that reason new dependencies are reviewed by
hand for network behaviour before they are added.

---

## 7. Reporting a problem

If you believe any guarantee in this document is wrong, that is a security issue and
should be reported as one: open an issue titled `security:` describing the claim you
think is false and, if you can, the file that contradicts it. Please do not include
serial numbers, hostnames or other machine identifiers from a real report in a public
issue.

---

## 8. A note on what is *not* claimed

Honesty about limits is part of the security posture, so these are stated explicitly:

- **The guard is not a sandbox.** §2.3 lists what it cannot intercept. The real
  guarantee is that no network client exists in the source.
- **The build is unsigned.** §6.1. SmartScreen will warn. That warning is legitimate and
  is not worked around.
- **No security audit has been performed.** Nothing in this document is a claim of
  third-party review. The mechanisms are described so they can be checked, not so they
  can be taken on trust.
- **The diagnostic output is not a security assessment.** VERIDEX reports whether
  BitLocker, Defender and the firewall are on because a buyer wants to know; it does not
  evaluate whether a machine is free of malware, and it cannot.
