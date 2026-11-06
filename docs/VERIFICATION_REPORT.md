# VERIDEX — verification report

This report answers one question per claim: **how do you know?** It separates four kinds of
knowledge that are easy to blur into "it works":

| Class | Means | How it appears below |
| --- | --- | --- |
| **Executed** | Something ran and its output was read. | run IDs, command output, log lines, figures |
| **Tested** | An automated test asserts the behaviour and fails if the code changes. | test file and count |
| **Inspected** | A human (this session) opened the artefact and looked at it. | the exact files opened |
| **Unverified** | Nothing above applies. | named, with the reason |

Nothing in the last column is ever reported as done. Nothing in the third column is reported as
"verified on hardware".

- **Branch:** `arena/9cba7759-merqo-veridex`
- **Requirements:** 130 across 39 specification sections — 110 tested, 18 implemented, 2 partial, 0 not started, **0 verified on real hardware**
- **Audit:** [`AUDIT_40_SECTIONS.md`](AUDIT_40_SECTIONS.md) — every section judged, with its gaps named
- **Static gate:** 0 errors, 0 warnings
- **Test suite:** 843 tests, 843 passing, on Linux and Windows

---

## 1. Executed

These ran, in this environment or in CI, and the output was read.

| What | Where | Result |
| --- | --- | --- |
| Full test suite | this container (Linux) | `# tests 843 · # pass 843 · # fail 0` |
| Full test suite | `windows-latest` (run [42182778326](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42182778326)) | green |
| Static gate | `node scripts/check.mjs` | "No findings." — 0 errors, 0 warnings |
| Licence audit | `npm run audit:licences` | 339 packages, 0 errors, 1 recorded exception (`png-js`, undeclared licence, upstream states MIT) |
| Requirement audit | `npm run audit:requirements -- --check` | "Every claimed status matches the repository contents." |
| Memory stability worker | `tests/unit/memory-stability.test.js` | a real 64 MB buffer written and read back through a worker; 0 mismatches |
| Real window (Electron 45.2.3, Chromium 156, Windows) | run [42184459268](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42184459268) | 23 steps, 34 screenshots, 0 problems, 0 renderer console messages |
| Real WMI / PowerShell / registry sweep | `windows-latest`, same run family | 1,094 fields across 19 modules, 32 provider attempts, score 84 at 75 % coverage, 10 info + 45 ok |
| Dependency graph + formatting policy | CI step on every push | both clean; both proven to refuse bad input by test |

What the Windows sweep proves and does not: the commands execute, their parsers accept the real
output, and every field is well formed. It is a hosted VM with synthetic devices — no battery, no
keyboard, no thermal sensor. **A correct parse of a virtual machine is not a correct reading of a
machine somebody owns.**

## 2. Tested

843 automated tests. The ones that matter most for the newest work, and what each would catch:

| Area | Test file | Tests | The failure it is designed to catch |
| --- | --- | --- | --- |
| GPU benchmark | `tests/unit/gpu-responsiveness-recovery.test.js` | 18 | a figure reported without WebGL, a compile failure reported as a number, a software rasteriser dressed as a GPU |
| Responsiveness composite | same | (above) | a score below two measured subsystems, a weight set that does not sum to 1, lag treated as a contribution |
| Crash marker | same | (above) | a marker read as "completed", a corrupt marker deleted instead of kept |
| Memory stability | `tests/unit/memory-stability.test.js` | 10 | a run without consent, an out-of-bounds buffer, a mismatch reported as a pass |
| History for non-scans | `tests/unit/history-entries.test.js` | 10 | a refused stress run filed as evidence, an unread temperature written as 0 |
| History rendering | `tests/integration/history-rows.test.js` | 5 | a benchmark rendered as an "Unrated" scan |
| Monitoring export | `tests/unit/monitor-export.test.js` | 9 | a missing reading written as 0, an empty session written as a header-only file |
| Licence audit | `tests/integration/licence-audit.test.js` | 11 | an undeclared licence defaulted to "probably MIT" |
| Gate refusals | `tests/integration/gate-refusals.test.js` | 10 | a cycle not detected, a formatting rule that never fires |
| Navigation | `tests/integration/navigation.test.js` | 6 | a breadcrumb that does not navigate, a recent list containing the current page |
| Widget arrangement | `tests/integration/dashboard-arrange.test.js` | 9 | an arrangement that lives only in the DOM |
| Performance consent gate | `tests/integration/performance-card.test.js` | 3 | a run button enabled before consent, or stuck disabled after it |
| IPC contract | `tests/unit/ipc-contract.test.js` | 20 | a channel with no handler, a preload list that has drifted from the contract |

## 3. Inspected

I opened these images and looked at them; nothing else in the evidence set is claimed as reviewed.

| Image | What I saw | What it settles |
| --- | --- | --- |
| `shots12/gui-shots/23-performance-cards.png` | GPU card, **Memory stability** card with an unticked consent box and a disabled *Run stability check*, **System responsiveness** card printing the 35/20/25/20 weights | the three cards render on Windows, and the consent gate is closed before consent |
| `shots12/gui-shots/24-dashboard-arranging.png` | dashed widget shells labelled SCAN PROGRESS / COMPONENTS, each with ↑ ↓ × controls | the arrangement editor renders and is operable in the real window |
| `shots12/gui-shots/15-page-performance.png` | breadcrumb `VERIDEX › Inspection › Performance`, a **Recent** button in the toolbar | the breadcrumb and quick-access entry are on screen |
| `shots10/gui-shots/15-page-performance.png` | the same page before the cards were photographed | the earlier evidence did not show the new cards, which is why the step was added |

Everything else in `gui-shots/` is *present* and was *not* opened. A run that captures nothing
warns explicitly, and this run captured 34.

## 4. Unverified

Named, with the reason. None of these is a code defect, and none is presented as done.

| Claim | Status | Why |
| --- | --- | --- |
| Any requirement verified on real Windows hardware | **none** | no physical machine was available; `VER` remains 0 for all 130 requirements |
| A diagnostic value is *correct* for the machine it describes | **unverified** | every parser is checked against fixtures and against a hosted VM's WMI; neither is the machine in front of a user |
| A physical component works | **unverified** | no key press, panel, speaker, camera, port or battery was touched. The manual tests record a human's verdict, and no human ran them |
| GPU benchmark on a real GPU | **unverified** | the unit tests use a fake WebGL context; the evidence run never presses the button |
| Stress run on real hardware | **unverified** | only the guard and the runner are tested, with injected loads. A stress run in CI would measure the runner |
| The crash path (`uncaughtException` → marker → exit) | **partly executed** | the marker, the descriptions and staleness are unit-tested; no process was actually killed to produce one |
| Installer for *this* tree | **not built** | `release.yml` cannot be dispatched from this environment (`403 Resource not accessible by integration`), and the packaging job needs a PR/main run with artifacts I cannot download |
| Published SHA-256 for *this* tree | **not computed** | same reason; `RELEASE_VERIFICATION.md` still carries the previous build's hashes and says so |
| Multi-monitor window placement (R-18-02) | **partial** | displays are enumerated, 125 % zoom is asserted; placement and scale-aware sizing are not implemented |
| Scheduled tasks, services, Windows components (R-12-02) | **partial** | only Run/RunOnce startup entries are collected |

## 5. What went wrong, and what it cost

Recorded because a report that only lists successes is not a verification report.

1. **Windows failed the previous commit while the annotation said "no failing tests".** The new
   formatting rule rejects CRLF; a Windows checkout had converted 145 files. The annotation
   script matched `not ok` only at column zero, and the real failure was indented. Fixed at four
   levels: `.gitattributes` pins LF everywhere, a uniformly-CRLF file is reported once instead of
   per line (39,641 findings became 145), the refusal test separates a checkout artefact from a
   rule breach, and the parser now reads indented failures and emits the tail of the output.
2. **The first new evidence step threw "Script failed to execute".** A backslash-n inside a
   template literal arrived at the renderer as a real newline inside a regex literal. The message
   says nothing about the cause; the fix keeps the newline out of the source entirely.
3. **The first screenshot of the new cards showed the wrong cards.** The step scrolled to the
   bottom of the page and photographed the stress card. It now scrolls the memory card to the
   centre and fails if it cannot — "something rendered" is not the claim being made.
4. **`formatNumber` was used in a new code path without importing it.** Caught by
   `history-rows.test.js` on its first run, which is the point of writing the test before the
   screenshot.

## 6. Reproducing this

```bash
npm ci
npm run check                       # 0 errors, 0 warnings
npm run audit:licences              # 339 packages, 0 errors, 1 recorded exception
npm run audit:requirements -- --check
npm test                            # 843 tests
node --test tests/integration/gate-refusals.test.js   # proves the gate refuses bad input
```

The real-window evidence requires Windows and Electron; it runs as the `Design evidence` workflow
on every push and publishes `gui-shots/**` and `gui-smoke.json` to an orphan `ci/ui-<run id>`
branch.
