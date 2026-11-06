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
- **Test suite:** 881 tests, 881 passing, on Linux and Windows

---

## 1. Executed

These ran, in this environment or in CI, and the output was read.

| What | Where | Result |
| --- | --- | --- |
| Full test suite | this container (Linux) | `# tests 881 · # pass 881 · # fail 0` |
| Full test suite | `windows-latest` (runs `42187908032`, `42194144517`) | green, 881 tests |
| Static gate | `node scripts/check.mjs` | "No findings." — 0 errors, 0 warnings |
| Licence audit | `npm run audit:licences` | 339 packages, 0 errors, 1 recorded exception (`png-js`, undeclared licence, upstream states MIT) |
| Requirement audit | `npm run audit:requirements -- --check` | "Every claimed status matches the repository contents." |
| Memory stability worker | `tests/unit/memory-stability.test.js` | a real 64 MB buffer written and read back through a worker; 0 mismatches |
| Real window (Electron 45.2.3, Windows) | run [42192434597](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42192434597) | 23 steps, 35 screenshots, 0 problems, 0 renderer console messages |
| Window placement in that window | same run | `window 1024x720 at 0,0; display 1024x768 at 100 %, work area 1024x720; overflow {left:0,top:0,right:0,bottom:0}` — the window is the work area, not the resolution, and 48 px of taskbar are excluded |
| Artifact inventory for the packaged build | `gh api …/actions/runs/42194144517/artifacts` | four artifacts, with sizes and GitHub's archive digests — recorded in `RELEASE_VERIFICATION.md` |
| Release workflow dispatch | `gh workflow run release.yml`; `POST /actions/workflows/build.yml/dispatches` | `404` for `release.yml` (never on `main`, so never registered); `403 Resource not accessible by integration` for a registered workflow (the installation has no `Actions: write`) |
| Artifact download | `gh run download 42194144517` | `EOF` on `*.blob.core.windows.net` — reachable API, unreachable payload host |
| Real WMI / PowerShell / registry sweep | `windows-latest`, same run family | 1,094 fields across 19 modules, 32 provider attempts, score 84 at 75 % coverage, 10 info + 45 ok |
| Dependency graph + formatting policy | CI step on every push | both clean; both proven to refuse bad input by test |

What the Windows sweep proves and does not: the commands execute, their parsers accept the real
output, and every field is well formed. It is a hosted VM with synthetic devices — no battery, no
keyboard, no thermal sensor. **A correct parse of a virtual machine is not a correct reading of a
machine somebody owns.**

## 2. Tested

881 automated tests. The ones that matter most for the newest work, and what each would catch:

| Area | Test file | Tests | The failure it is designed to catch |
| --- | --- | --- | --- |
| Scheduled tasks (R-12-02) | `tests/unit/scheduled-tasks.test.js` | 15 | a task list that could not be read becoming "0 tasks", the `schtasks` fallback inventing an author it cannot see, and the Startup folders staying unread while the provider title claims them |
| Window placement (R-18-02) | `tests/unit/window-placement.test.js` | 20 | a window larger than a 125 % work area, a second monitor whose negative origin puts the centre on the wrong screen, and a monitor unplugged mid-session stranding the window |
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

I opened these images from run [42192434597](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42192434597) and earlier runs, and looked at them; nothing else in the evidence set is claimed as reviewed.

| Image | What I saw | What it settles |
| --- | --- | --- |
| `shots14/gui-shots/01-window-placement.png` | the whole application inside a 1024x720 area with the first-run tour on top, no part of the shell cut off and no horizontal scrollbar | R-18-02 in a real window: on a screen smaller than the design size the window is the work area, and the tour still fits |
| `shots14/gui-shots/24-performance-cards.png` | GPU card, **Memory stability** card with the consent sentence on its own line, an unticked box, a disabled *Run stability check* and Buffer (MB) / Passes beneath it, then **System responsiveness** printing the 35/20/25/20 weights | the three cards render on Windows, the consent gate is closed before consent, and the controls read in the order they are meant |
| `shots14/gui-shots/25-dashboard-arranging.png` | dashed widget shells labelled SCAN PROGRESS / COMPONENTS, each with ↑ ↓ × controls | the arrangement editor renders and is operable in the real window |
| `shots14/gui-shots/16-page-performance.png` | breadcrumb `VERIDEX › Inspection › Performance`, a **Recent** button in the toolbar | the breadcrumb and quick-access entry are on screen |
| `shots10/gui-shots/15-page-performance.png` (superseded) | the same page before the cards were photographed | the earlier evidence did not show the new cards, which is why the step was added |

Everything else in `gui-shots/` is *present* and was *not* opened. A run that captures nothing
warns explicitly, and this run captured 35.

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
| The installer's own SHA-256 for *this* tree | **not computed** | the binary was **built** (run `42194144517` from `29c7a32`) and its artifact archive has GitHub's digest, but the payload is served from `*.blob.core.windows.net`, which this environment cannot reach (`EOF`). A hash nobody computed is not a hash; `RELEASE_VERIFICATION.md` says which hashes are whose and gives the owner the exact commands |
| A published release, or a tag | **not created** | deliberately: `release.yml` is not registered (it has never been on `main`, so `workflow_dispatch` answers `404`) and dispatching any workflow from here is refused with `403` because the GitHub App installation has no `Actions: write` |
| Second monitor, negative origin, 125 % work area in a real window (R-18-02) | **unit-tested, not observed** | the evidence runner has one 1024x700 display at 100 %. The placement arithmetic for two monitors is 20 unit tests; no window was dragged between two real screens |
| The `schtasks` fallback (R-12-02) | **unit-tested, not observed** | no machine without the ScheduledTasks module was available. The fallback's parsing is tested against fixtures that reproduce its CSV shape |
| Live UPDATE: startup-folder reading on a real profile | **executed on a VM, unread by a person** | the Windows runner has both Startup folders; whether the entries it returned are the right ones was not checked against the runner's own Startup folder |

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
3. **The first screenshot of the new cards showed the wrong cards**, and the second showed the
   right cards with the wrong wording: the step scrolled to the bottom of the page and
   photographed the stress card, then, once aimed correctly, the memory card read "… held for
   several seconds Buffer (MB) 256" as one sentence. The step now scrolls the memory card to the
   centre and fails if it cannot; the consent sentence now takes its own row. Both were seen by
   opening the image, which is why §3 exists.
4. **`formatNumber` was used in a new code path without importing it.** Caught by
   `history-rows.test.js` on its first run, which is the point of writing the test before the
   screenshot.
5. **A provider's title described a source it never read.** The startup provider has been called
   "Startup entries (Run keys and startup folders)" since it was written, and its script read only
   the four registry keys. A shortcut in `shell:startup` — the method Windows itself recommends —
   was invisible while the documentation said it was covered. Found by reading the script against
   its own title while closing R-12-02; fixed by reading both Startup folders, with a test that
   asserts the script contains them.
6. **The 403 on the release workflow was two different failures wearing one number.** `release.yml`
   answers `404` because a `workflow_dispatch` workflow that has never existed on `main` is not
   registered; *any* dispatch from here answers `403 Resource not accessible by integration`
   because the installation has no `Actions: write`. Both are the owner's to fix, and neither is
   something to work around by inventing a release.

## 5a. What could not be done here, and exactly why

Each of these is a limit of the environment, stated so nobody later assumes it was overlooked.

| Attempt | Result | Cause, precisely |
| --- | --- | --- |
| Download the installer and portable from run `42194144517` | `EOF` | `gh run download` follows a redirect to `productionresultssa18.blob.core.windows.net`; that host is outside this sandbox's network egress. `api.github.com` is reachable, which is why the artifact *names*, *sizes* and *archive digests* are recorded |
| `gh workflow run release.yml` | `HTTP 404` | the workflow has never existed on `main`; GitHub only registers `workflow_dispatch` workflows present on the default branch |
| `POST /actions/workflows/build.yml/dispatches` | `403` | `{"message":"Resource not accessible by integration"}` — the GitHub App installation token has Actions read, not `Actions: write` |
| Compute SHA-256 of the two executables | not attempted further | they are inside the artifact archive above. Hashing a different file and calling it the installer's hash would be a lie, so `RELEASE_VERIFICATION.md` records GitHub's archive digest under exactly that name and gives the owner the commands |
| Create a tag or a release | deliberately not done | a release is cut by a person who has read `RELEASE_VERIFICATION.md`; that document is not complete for this tree |

## 6. Reproducing this

```bash
npm ci
npm run check                       # 0 errors, 0 warnings
npm run audit:licences              # 339 packages, 0 errors, 1 recorded exception
npm run audit:requirements -- --check
npm test                            # 881 tests
node --test tests/integration/gate-refusals.test.js   # proves the gate refuses bad input
```

The real-window evidence requires Windows and Electron; it runs as the `Design evidence` workflow
on every push and publishes `gui-shots/**` and `gui-smoke.json` to an orphan `ci/ui-<run id>`
branch.
