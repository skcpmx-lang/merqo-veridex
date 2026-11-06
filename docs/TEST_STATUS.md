# Test status

This document exists to answer one question honestly: **what has actually been run, and
what has merely been written?**

VERIDEX has three distinct levels of confidence, and they are never conflated:

| Marker | Claim | Evidence required |
| --- | --- | --- |
| **VER** | A person ran it on real Windows 10/11 hardware and saw it work | An entry in `verifiedOn` naming the machine, date and result |
| **TS** | An automated test executes the code and passes | A test file that exists and runs |
| **IM** | The code exists and is wired up | A source file that exists |

**No requirement is marked VER.** That is not an oversight. It is the accurate state of
the project.

---

## 1. Current totals

Generated from `docs/requirements.json` by `npm run audit:requirements`:

| Status | Count |
| --- | --- |
| Verified on Windows | **0** |
| Tested | **75** |
| Implemented, not tested | **11** |
| Not started | **44** |
| **Total** | **130** |

---

## 2. Automated test suite

Run with `npm test`. As of the last full run:

```
tests 697 · pass 697 · fail 0
```

Every test passes. The two documentation checks that previously failed (missing documents
and unreferenced documents) now pass, and the paths they guard are valid.

| File | Tests | What it covers |
| --- | --- | --- |
| `tests/unit/battery.test.js` | 17 | powercfg and systeminformation battery mapping, wear maths |
| `tests/unit/bench-cpu.test.js` | 14 | CPU benchmark scoring, stress guard limits |
| `tests/unit/bench-disk.test.js` | 6 | disk benchmark, consent for the write half |
| `tests/unit/cpu-model.test.js` | 9 | model-number decoding, unknown-name handling |
| `tests/unit/cpu.test.js` | 13 | CIM processor parsing, fallbacks |
| `tests/unit/driver-export.test.js` | 11 | export planning, destination refusal, describe/verify outcomes |
| `tests/unit/drivers.test.js` | 10 | driver inventory, age assessment, problem codes |
| `tests/unit/elevate.test.js` | 9 | the elevation allowlist: named tasks only, argument refusal, UAC decline |
| `tests/unit/elevated-runner.test.js` | 8 | the elevated helper: stale result files, timeout, missing/broken results |
| `tests/unit/export-and-capabilities.test.js` | 6 | capability declarations match tasks and the elevated allowlist |
| `tests/unit/fallback.test.js` | 8 | provider chain fall-through |
| `tests/unit/field.test.js` | 13 | FieldValue construction, status vocabulary |
| `tests/unit/gpu.test.js` | 16 | GPU parsing, vendor heuristic, VRAM sanity |
| `tests/unit/health-cap.test.js` | 9 | coverage cap and withheld score |
| `tests/unit/health.test.js` | 24 | component scoring, coverage gating, rating |
| `tests/unit/history-store.test.js` | 7 | persistence, id generation, retention, quarantine, comparison |
| `tests/unit/ipc-arity.test.js` | 7 | every channel accepts exactly the arguments it declares |
| `tests/unit/ipc-contract.test.js` | 17 | the preload surface, forbidden exposure |
| `tests/unit/logs-surface.test.js` | 13 | log parsing, filtering, summary, export redaction and retention |
| `tests/unit/manual.test.js` | 48 | manual checklist, session, coverage separation |
| `tests/unit/monitor.test.js` | 9 | sampling, series |
| `tests/unit/network.test.js` | 8 | adapter parsing, socket derivation |
| `tests/unit/onboarding.test.js` | 12 | first-run steps, advance, skip, reset, no elevation |
| `tests/unit/pe-metadata.test.js` | 6 | PE header parsing used by the artifact checks |
| `tests/unit/permissions.test.js` | 16 | elevation detection, capability gating, blocked matrix |
| `tests/unit/platform.test.js` | 16 | CIM error classification, registry, shared plumbing |
| `tests/unit/report.test.js` | 34 | model → json/html/pdf/csv/certificate |
| `tests/unit/security.test.js` | 15 | forbidden commands, consent, network guard |
| `tests/unit/smart.test.js` | 18 | ATA SMART and NVMe health log parsing |
| `tests/unit/smoke-regressions.test.js` | 9 | the packaging smoke tests catch the failures they were written for |
| `tests/unit/stress.test.js` | 16 | stress guard, elapsed time, transitions |
| `tests/unit/windows-extended.test.js` | 22 | Windows inventory parsing beyond the core modules |
| `tests/unit/windows-modules-depth.test.js` | 31 | the four new modules against their per-module checklists |
| `tests/unit/windowshealth-depth.test.js` | 11 | DISM parsing, unknown never PASS, non-admin honesty |
| `tests/integration/artifacts.test.js` | 7 | release artifact verification: signatures, checksums, tampering |
| `tests/integration/audit-gate.test.js` | 6 | the requirement audit refuses a claim it cannot support |
| `tests/integration/build-boundary.test.js` | 3 | nothing test-only or fixture-only can be packaged |
| `tests/integration/confidence-tiers.test.js` | 6 | every provider mechanism has a declared tier |
| `tests/integration/diagnostic-run.test.js` | 16 | task execution end to end with a fake runner |
| `tests/integration/docs.test.js` | 6 | documentation paths and claims match the code |
| `tests/integration/gui-coverage.test.js` | 5 | the Windows GUI harness covers every page and uploads its screenshots |
| `tests/integration/install-smoke-harness.test.js` | 9 | the installed build smoke harness itself |
| `tests/integration/new-surfaces.test.js` | 23 | first-run tour, activity log, driver export card, Reports and Privacy |
| `tests/integration/no-network.test.js` | 4 | no transport code exists in `src/` |
| `tests/integration/privacy-verification.test.js` | 7 | redaction on disk and on export, retention, reset safety |
| `tests/integration/provider-invocation.test.js` | 13 | CI workflows reference scripts that exist; tests gate publishing |
| `tests/integration/providers.test.js` | 7 | every provider executes and explains itself, including when its runner fails |
| `tests/integration/renderer.test.js` | 17 | all 18 pages render under jsdom; live-mode pages with a fake bridge |
| `tests/integration/report-consistency.test.js` | 14 | one scan, four formats, compared field by field |
| `tests/integration/scan-path.test.js` | 12 | the twelve scan:last data-flow checks from engine to report |
| `tests/integration/scan.test.js` | 11 | registry construction, scan orchestration |
| `tests/integration/settings-wiring.test.js` | 15 | settings read/write, privacy defaults, engine-side coverage |
| `tests/integration/ui-features.test.js` | 16 | keyboard, focus, empty states and the shell controls |
| `tests/integration/workflow.test.js` | 12 | CI configuration, permissions and release gating |
| **Total** | **697** | |

Run on **both Linux and Windows** (`ubuntu-latest` and `windows-latest` in
`.github/workflows/build.yml`). The suite passes on both, which proves the logic is
platform-independent. It is still **not** evidence about real hardware: the tests exercise
parsers and integration seams against recorded or simulated command output, and the
providers run against a no-op runner.

**Evidence for the count above:** commit `cbc50b3`, GitHub Actions run
`42154671771` — *Static checks* success, *Tests (windows-latest)* success,
*Tests (ubuntu-latest)* success. The `Windows package` job was skipped for this event, so
this run proves the suite and not an installer.

---

## 3. What the tests genuinely prove

- The **parsers** handle the output shapes they are given, including the malformed,
  empty, and vendor-weird cases in the fixtures.
- The **provider chain** falls through correctly and never returns an unexplained
  silence.
- The **health score** is gated: below 50 % coverage no number is published, and between
  50 % and 80 % it cannot read "Good".
- The **guard** refuses sixteen destructive command lines and permits eleven read-only
  ones.
- **No network client** exists anywhere in `src/`.
- The **renderer** renders all 18 pages with no `undefined`, `NaN` or `[object Object]`.
- The **documentation** refers only to files that exist, and the CSP quoted in
  `SECURITY.md` matches the one the shell declares.

---

## 4. What the tests do not prove

Stated plainly, because this is the section that matters:

1. ~~That any of it works on Windows.~~ **Partly done.** The suite runs on
   `windows-latest` on every push and passes, and three harnesses execute the packaged
   application there: the GUI smoke test drives the unpacked build through its whole
   interface, `npm run smoke:portable` launches the portable executable, and
   `npm run smoke:install` installs, launches and uninstalls the real installer. What none of
   them can do is run on **physical** hardware with a battery, an SSD exposing SMART, and a
   discrete GPU.
2. **That the real interfaces return the shapes the fixtures assume.** A parser that is
   perfectly tested against a fixture proves the parser matches the fixture, nothing more.
3. ~~That the packaged application installs and launches.~~ **Done on a virtual machine.**
   CI installs `VERIDEX-Setup-1.0.0-x64.exe` silently and per-user, starts the installed
   application, checks its window, title, bridge and pages, and uninstalls it; the portable
   executable is launched from its extraction directory. What remains unproven is the same
   thing as everywhere else in this list: **physical hardware, and a person looking at it.** A
   BrowserWindow has opened, and its visibility is asserted by the operating system — nobody
   has seen it.
4. ~~That the installer installs.~~ **Done.** `npm run smoke:install` runs the real installer
   silently on the Windows runner, launches the installed application, checks its window,
   title, preload bridge, one IPC round trip and all 15 pages, then runs the uninstaller and
   confirms the files, directory and shortcuts are gone. 16 checks, no problems.
5. **That performance is acceptable on real hardware.** The ~800 ms cold / ~200 ms warm figure comes from
   this container running providers that mostly return `UNSUPPORTED` immediately. It says
   nothing about a Windows machine running 28 real queries.

---

## 5. Checks that found real defects

Six checks were added specifically because their absence had hidden bugs:

1. **`providers.test.js`** — executes every registered provider. It found five providers
   returning an empty object instead of an explained status, and two `ReferenceError`s
   that fired on every scan. It was then strengthened with a runner that throws, because
   the first version only exercised each provider's happy path: three more providers
   returned `{}` from their `catch` blocks, which the polite-failure runner never reached.
2. **`confidence-tiers.test.js`** — asserts every mechanism has a declared tier. It found
   three providers silently classified as heuristic guesses, one of which reads
   authoritative Windows servicing state.
3. **`security.test.js`** — the forbidden-command table had **no test at all** despite
   being the product's central guarantee. Writing it found that `diskpart /s script`
   was permitted while `diskpart` + `clean` was refused.
4. **`history-store.test.js`** — the store had no tests at all. Writing them found that
   every entry was saved **without an id** and then discarded on load, so the history
   file never accumulated a single run. Nothing errored and nothing warned; the only
   symptom was a list that stayed empty. The cause was a spread order in `add()`:
   `{ id: entry.id ?? makeId(), ...entry }` lets a caller's `id: undefined` overwrite
   the generated id.
5. **`ui-features.test.js`** (added during the interface audit) — drives the real controller
   against a DOM. Writing it found that the renderer had **no channel to ask for the results of
   a run**: `scan:finished` carried five summary numbers, `scan:state` carried three, and every
   diagnostic page read `state.scan.modules`, which nothing ever assigned. A completed sweep
   therefore left the whole application saying "Not collected yet". `scan:last` now returns the
   projection the pages render, and the test asserts the score, the coverage, the warnings and a
   module's fields all arrive.
6. **`docs.test.js`** — verifies that paths named in documentation exist. It found 47
   entries in `requirements.json` citing files nobody had written, while the requirement
   auditor reported a clean bill of health. The auditor now validates implementation,
   documentation and test references for every status, not only for TS claims.

---

## 6. How a requirement becomes VER

A requirement may only be moved to `VER` by editing `docs/requirements.json` and adding:

```json
"st": "VER",
"verifiedOn": {
  "machine": "identifying description of the hardware and Windows build",
  "date": "YYYY-MM-DD",
  "result": "what was observed, including anything that did not work"
}
```

`npm run audit:requirements -- --check` fails if `st` is `VER` and `verifiedOn` is
absent, so the status cannot be claimed without the evidence. That check works. The
evidence does not exist yet.

---

## 7. Honest summary

The code is written and the logic is well tested. **The product has never been run on the
platform it is built for.** Until it has, "tested" means "the logic behaves as designed",
and nothing here should be read as "this works on your machine".
