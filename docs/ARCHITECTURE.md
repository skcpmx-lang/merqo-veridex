# Architecture

67 modules, ~21,800 lines of source, one process boundary. This document explains how a
scan becomes a report. It is written from the code, and every file it names exists.

---

## 1. The shape of the application

```
┌─────────────────────────────────────────────────────────────────────┐
│  Renderer  (src/renderer/)                                          │
│  Plain ES modules in a sandboxed BrowserWindow. No Node, no network.│
│  index.html + app.js + ui.js + theme.js + styles.css                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  contextBridge surface only
┌───────────────────────────────┴─────────────────────────────────────┐
│  Preload  (src/app/preload.cjs)                                     │
│  An explicit, enumerated list of channels. Nothing else crosses.    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  ipcMain.handle / ipcRenderer.invoke
┌───────────────────────────────┴─────────────────────────────────────┐
│  Main  (src/app/main.js)                                            │
│  Window lifecycle, IPC handlers, settings, scan orchestration.      │
└───┬──────────────────────┬──────────────────────┬───────────────────┘
    │                      │                      │
┌───┴─────────┐   ┌────────┴────────┐   ┌─────────┴─────────────────┐
│ Diagnostics │   │    Engine       │   │  Reporting                │
│ 15 modules  │──▶│ registry, merge │──▶│  model → json/html/pdf/   │
│             │   │ confidence,     │   │  csv/certificate          │
│             │   │ health          │   │                           │
└───┬─────────┘   └─────────────────┘   └───────────────────────────┘
    │
┌───┴─────────────────────────────────────────────────────────────────┐
│  Platform  (src/platform/)                                          │
│  CommandRunner → SecurityGuard → child_process                      │
│  Everything that touches the machine passes through here.           │
└─────────────────────────────────────────────────────────────────────┘
```

The dependency direction is strict and one-way: renderer → preload → main →
diagnostics → platform. Nothing in `src/platform/` imports from `src/diagnostics/`, and
nothing in `src/diagnostics/` imports from `src/app/`. `scripts/check.mjs` parses every
module and the integration tests exercise the direction.

---

## 2. A scan, end to end

### 2.1 Registry construction — `src/app/scan.js`

`buildDefaultRegistry()` imports all fifteen diagnostic modules and calls each one's
`registerX(registry)` function inside its own `try/catch`. A module that throws while
registering is recorded as a failure and the scan continues with the rest. This is
deliberate: one broken module must not blank the whole report.

Result on a healthy build: **15 modules, 20 tasks, 34 providers**.

| Task | Providers, in priority order |
| --- | --- |
| `system.identity` | `cim-win32.system` → `systeminformation.system` |
| `cpu.info` | `cim-win32.cpu` → `systeminformation.cpu` → `model-table.cpu` |
| `memory.info` | `cim-win32.memory` → `systeminformation.memory` |
| `motherboard.info` | `cim-win32.motherboard` → `chipset-heuristic.motherboard` |
| `gpu.info` | `cim-win32.gpu` → `systeminformation.gpu` |
| `gpu.directx` | `directx-dxdiag.gpu` |
| `storage.inventory` | `cim-win32.storage` → `systeminformation.storage` |
| `storage.health` | `nvme-health-log.storage` → `ata-smart.storage` |
| `battery.info` | `cim-win32.battery` → `battery-firmware.battery` → `powercfg-report.battery` → `systeminformation.battery` |
| `network.info` | `cim-win32.network` → `systeminformation.network` |
| `drivers.inventory` | `cim-win32.drivers` → `systeminformation.drivers` |
| `drivers.export` | `driver-export.drivers` |
| `windows.info` | `cim-win32.windows` → `systeminformation.windows` |
| `windows.inventory` | `system-features.windows` |
| `windows.componentHealth` | `dism.checkhealth` |
| `windows.events` | `powershell.eventlog` |
| `software.installed` | `registry.uninstall` |
| `software.startup` | `powershell.startup` |
| `processes.snapshot` | `powershell.processes` |
| `security.posture` | `cim-win32.security` |

Two of these providers are deliberately not measurements. `model-table.cpu` decodes a
model number from a name and states that it adds no independent reading, so it cannot be
counted as corroboration. `systeminformation.drivers` adds no driver-level detail on
Windows and says so rather than returning an empty object.

### 2.2 Provider resolution — `src/engine/provider-registry.js`

A task runs its providers in priority order and **stops at the first answer that covers
the field**. A provider that cannot answer returns a field explaining why
(`UNAVAILABLE`, `UNSUPPORTED`, `PERMISSION_REQUIRED`), and the run falls through to the
next provider. A provider that returns `{}` is a bug: it looks like an answer that
produced nothing, which is indistinguishable from "this machine has no such component".
`tests/integration/providers.test.js` fails the build if any provider does that.

Measured on a host without Windows: **20 tasks, 33 of 34 provider attempts, ~800 ms on the
first run and ~200 ms once the modules are loaded** (the host has no Windows, so every
command returns "not available here" immediately — this is the floor, not a forecast for a
real machine, where CIM and PowerShell calls dominate).

### 2.3 Field values — `src/core/field.js`

Every collected datum is a `FieldValue`: a value, a `Status`, a `source`, and — whenever
the status is not `PASS` — an explanation. There is no way to represent "no data" as a
bare `undefined`, because `undefined` cannot explain itself. This one decision is what
makes the honesty guarantee enforceable rather than aspirational.

`src/core/status.js` is the closed vocabulary: `PASS`, `WARNING`, `FAIL`, `UNAVAILABLE`,
`UNSUPPORTED`, `PERMISSION_REQUIRED`, `ERROR`, `NOT_APPLICABLE`, `UNRATED`.

### 2.4 Merging and confidence — `src/engine/merge.js`, `src/engine/confidence.js`

When two providers report the same field, `merge.js` reconciles them: identical values
agree, differing values are kept with a note rather than silently resolved. Each
mechanism carries a confidence tier, declared in `PROVIDER_TIERS`:

| Tier | Mechanisms |
| --- | --- |
| `authoritative` | `cim-win32`, `systeminformation`, `registry`, `system-features` |
| `firmware` | `nvme-health-log`, `ata-smart`, `battery-firmware`, `acpi-thermal` |
| `derived` | `powercfg-report`, `model-table`, `directx-dxdiag`, `driver-export`, `computed` |
| `heuristic` | `vendor-heuristic`, `chipset-heuristic` |

Anything not in the table falls back to `heuristic`. That fallback is the safe direction
but a silent one, so `tests/integration/confidence-tiers.test.js` fails the build if a
registered provider has no entry. It caught three: `system-features`, which reads
servicing state through the same authoritative interfaces as the CIM providers and was
being labelled a guess; `directx-dxdiag`, which parses an OS-generated report; and
`driver-export`, an action provider that contributes no evidence at all.

Provider ids are task-scoped (`cim-win32.cpu`), and `tierOf()` strips the suffix before
looking the mechanism up. Without that strip every `cim-win32.cpu`-style id fell through
to `heuristic`, which would have quietly devalued every authoritative reading in the
product.

### 2.5 Health scoring — `src/engine/health.js`

Eight components: processor, graphics, memory, storage, battery, thermal, drivers,
security. Each is scored from evidence deltas; a component with no evidence is `Unrated`
and excluded rather than counted as healthy.

The overall score is **gated on coverage**, because a weighted average over a small part
of a machine is not a verdict on the machine:

| Coverage | Behaviour |
| --- | --- |
| < 50 % | score withheld, `Unrated`, reason stated |
| 50–80 % | score published but capped at 84 (`Fair`), never `Good` |
| ≥ 80 % | real score |

This was added after a real run on a Linux CI host printed `100 · Good` while rating one
of eight components. The reason for withholding appears in the interface, the PDF, the
HTML, the JSON and the certificate.

### 2.6 Report generation — `src/reporting/`

`model.js` builds one immutable report object. Every renderer reads that object and
nothing else:

- `json.js` — the machine-readable form, including the redaction policy in force
- `html.js` — a single self-contained page, no external assets
- `pdf.js` — pdfkit, no network fonts
- `csv.js` — flat field export
- `certificate.js` — the one-page summary and its verdict text

Because all five read one model, they cannot disagree with each other.

---

## 3. Security boundary

`src/security/guard.js` is the only path to the machine:

```
diagnostic module → CommandRunner → SecurityGuard.checkCommand() → child_process.spawn
                                   SecurityGuard.checkUrl()     → (refused)
```

- **Forbidden** operations have no code path at all — see `docs/SECURITY.md` §3.
- **Consent-required** operations are recorded per id and checked on every execution.
- **Network** is refused before a socket opens; the stronger guarantee is that no network
  client exists in the source.

---

## 4. Privacy

`src/security/privacy.js` classifies fields by name and redacts at collection and export
time. The direction of failure is tested: invalid or missing settings always produce
`includeSensitive: false` and `allowNetwork: false`. Every report records the policy that
produced it, so an old report can never be mistaken for a less redacted one.

The identifier list itself lives in `src/core/sensitive.js`, which imports nothing. The
renderer prints the Privacy page's guarantees and the Reports page's withheld count from the
same module the main process uses, and a sandboxed renderer cannot load anything that reaches
`node:*`: one such import two levels deep kept the whole window on its "Starting VERIDEX…"
text while every jsdom test passed. `tests/integration/renderer-graph.test.js` walks the
renderer's real import graph and fails on a Node builtin anywhere in it.

---

## 5. The renderer

`src/renderer/app.js` is a single page controller with **18 pages**. It renders only what
the main process hands it; it never infers a value. The history page reads stored runs
through `history:list` and keeps three states distinct — loading, empty and unreadable —
because collapsing them would report a failed read as "no data". Where a feature is not wired yet
(performance, monitor, history, report saving), the page says so in plain words rather
than showing an empty shell or invented sample data.

### 5.1 Application-side modules

Four modules sit between the renderer and the engine. They are plain ES modules with no
Electron dependency, which is why each can be unit-tested directly.

| Module | Responsibility | Notable rule |
| --- | --- | --- |
| `src/app/onboarding.js` | first-run state machine: four steps, advance, skip, reset | interruption is not completion; skip is recorded as skip |
| `src/app/elevate.js` | the closed allowlist of privileged tasks and their arguments | renderer asks for a **name**, never a command; quoting characters are refused |
| `src/app/elevated-runner.js` | starts one elevated helper, waits for its JSON result | zero exit with no result is a failure; UAC decline is classified first |
| `src/app/driver-export.js` | plans, describes and verifies a driver export | fresh folder per export; `.inf` count must match or the result is "cannot be confirmed complete" |
| `src/app/logs.js` | parse, filter, summarise, export and describe the log | unparseable lines are kept; redaction is re-applied on export |

### 5.2 New IPC channels

Thirteen channels were added, each with an argument validator in
`src/app/ipc-contract.js`:

- `app:onboarding`, `app:onboardingAdvance`, `app:onboardingSkip`, `app:onboardingReset`
- `drivers:chooseDestination`, `drivers:plan`, `drivers:export`, `drivers:cancelExport`,
  `drivers:lastExport`
- `logs:recent`, `logs:stats`, `logs:export`, `logs:clear`

`src/app/preload.cjs` exposes **35 invoke channels and 7 event channels**. That list is
generated from `INVOKE_CHANNELS` and `EVENT_CHANNELS`, not typed by hand: a test compares
the exposed surface with the contract, and a hand-edited list drifted from it once
already.

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true` and a strict CSP (`default-src 'none'`, `connect-src 'none'`).

---

## 6. Testing strategy

| Layer | Approach |
| --- | --- |
| Pure functions (parsers, scoring, privacy) | direct unit tests with real fixture data |
| Providers | executed against a `NoopRunner`; every returned field validated |
| Modules | registration, task wiring, provider resolution |
| Renderer | jsdom boot of the real `app.js`; all 18 pages rendered and asserted |
| Interaction | jsdom clicks and keystrokes against a fake bridge: tour, log filters, export card, dialog focus |
| Packaging boundary | the builder's `files:` patterns resolved against the real tree |
| Documentation | paths named in docs must exist; CSP quoted in docs must match the shell |
| Static | `scripts/check.mjs` parses every module, checks imports and entry points |

The gap this strategy had, and closed: unit tests covered pure mapping functions but
never invoked a provider closure, so five providers returning `{}` and three modules
registering their task before their provider went unnoticed. `providers.test.js` is the
test that would have caught them, and does now.

---

## 7. What is deliberately absent

No auto-updater, no telemetry, no crash reporter, no cloud account, no licence server.
Each would be a network client, and the product's central claim is that there is none.
