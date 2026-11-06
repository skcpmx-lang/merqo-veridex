# Project status

An accurate account of what is finished, what is wired but unproven, and what has not
been started.

Last updated with the commit that added this file. `docs/REQUIREMENTS.md` is generated
from `docs/requirements.json` and is the authoritative per-requirement list; this document
is the narrative summary of it.

---

## 1. Where the project stands

| | |
| --- | --- |
| Requirements | 130 across 39 modules |
| Verified on Windows | **0** |
| Tested (automated) | 110 |
| Implemented, untested | 18 |
| In progress | 2 |
| Not started | 0 |
| Automated tests | 880, all passing |
| Source | 67 JavaScript modules under `src/`, ~21,800 lines |
| Build | **produced** on Windows: installer 117.5 MiB + portable 106.5 MiB, unsigned |

The headline: **the application now builds on Windows, its full test suite passes there, and
the packaged build has been installed, launched and uninstalled on a Windows virtual
machine.** What it has never done is run on physical hardware, where the battery, the SSD and
the GPU that this tool exists to inspect actually live. A build that installs is not a build
that has been verified on a machine somebody owns, and no requirement is marked VERIFIED on
the strength of a virtual machine.

---

## 2. Finished and tested

These are genuinely done: implemented, wired, and covered by tests that execute the code.

### Diagnostics
- 15 modules, 21 tasks, 35 providers, all registering cleanly (`buildDefaultRegistry()`,
  counted from the registry itself).
- Provider chains fall through correctly; a provider that cannot answer explains why
  rather than returning an empty object.
- Parsers for CIM/WMI output, `powercfg` battery reports, ATA SMART, NVMe health logs,
  driver inventory and GPU data, each against fixtures including malformed and
  vendor-weird cases.

### Engine
- Provider registry with priority ordering and duplicate-id protection.
- Merge and conflict handling.
- Confidence tiers with an enforced, complete mechanism table.
- Health scoring with coverage gating (see `docs/HEALTH_SCORE.md`).

### Reporting
- One report model feeding five renderers: JSON, HTML, PDF, CSV, certificate.
- Every report records the redaction policy that produced it.
- The coverage gate and its reason appear in all five.

### Security and privacy
- Forbidden-command guard: 22 destructive command lines refused, 11 read-only ones
  permitted, both directions tested.
- Consent gating for the four operations that write files.
- Outbound guard, plus the stronger guarantee that no network client exists in `src/`.
- Field-level redaction with failure-closed defaults.
- Privileged work runs in a separate elevated helper against a closed allowlist of named
  tasks; the renderer can request a name, never a command. A declined prompt is recorded
  as cancelled, and a zero exit with no result file is a failure.

### Interface
- 18 pages, all rendering under jsdom with no `undefined`/`NaN`/`[object Object]`.
- Two complete themes with measured contrast; five accents with light-mode pairs.
- Strict CSP, no remote assets, reduced-motion support.
- Honest empty states: pages whose actions are not wired say so in plain words.
- History list wired to the store, with three distinct states (loading, empty, unreadable)
  and withheld scores preserved rather than rendered as zero.
- Live monitoring wired to a real `Monitor` in the main process, which previously
  answered `{ started: true }` without starting anything.
- Performance page wired to the real CPU and disk benchmark engines through `bench:cpu`,
  `bench:disk` and `bench:state`, with progress on the event channel. It previously told
  the user the engines existed but the page was not connected.
- First-run tour: four steps, persisted progress, skip recorded as skip, reset offered
  from Privacy. It never asks for elevation.
- Activity log page: level and text filters, unparseable lines shown rather than dropped,
  redacted export, deletion, and the real retention figures.
- Driver export card on the Drivers page: destination check, fresh folder per export,
  elevation named per task, `.inf` count verified afterwards.
- Reports page states what the file will contain before a format is chosen.
- Privacy page states what is stored, where, and how large it is.
- GPU fill-rate benchmark that reports `UNSUPPORTED` with a reason instead of inventing a
  figure, and a responsiveness composite that prints its weights and withholds itself below
  two measured subsystems.
- Dashboard arrangement editor: move, hide, restore and reset, written to `dashboard.widgets`
  on every change; a breadcrumb trail that navigates; a session-only recent-pages menu.
- Monitoring sessions export to CSV or JSON, one row per reading, with missing readings kept
  missing and an `available` column that says so.
- History lists benchmarks and stress runs as what they measured, not as unrated scans.

### Tooling
- `scripts/check.mjs` static gate: 0 errors, 0 warnings — every requirement has an
  implementation and a test; the record of how each of the 21 outstanding ones was closed is
  in `docs/WARNINGS.md`.
- Packaging boundary test: no test, fixture, documentation or harness file can be packaged.
- Requirement audit gate: `tests/integration/audit-gate.test.js` proves the audit refuses a
  missing test, missing code, an unearned VERIFIED status and an unexplained BLOCKED one.
- Requirement auditor that refuses a `VER` status without recorded evidence.
- Artifact verifier producing `SHA256SUMS.txt`.
- Documentation checks: paths named in docs must exist, and the CSP quoted in
  `SECURITY.md` must match the one the shell declares.

---

## 3. Wired but unproven

Implemented and connected, but resting on fixtures rather than a real machine.

- Every Windows read. The parsers match their fixtures; whether the fixtures match real
  Windows is unknown.
- The Electron shell's behaviour on a desktop somebody owns. The window opens on the Windows
  runner (`42192434597`, 23 steps, 35 screenshots), but that is a hosted VM with no battery, no
  keyboard, one 1024x700 display and no thermal sensors.
- The packaged build on hardware. An installer was produced for an earlier tree and installed
  on a Windows VM; nothing has been installed on a physical machine, and the current tree has no
  artifact of its own yet.
- Every benchmark figure and every stress run: the harness renders those pages but never presses
  their buttons, and a stress run in CI would measure the runner.

This is the largest category and the reason no requirement says VER.

---

## 4. Not started

None, and none partial. Every one of the 130 requirements has an implementation and an owner in
the repository: **112 tested, 18 implemented, 0 in progress, 0 not started, 0 verified on
hardware**. The two that were partial until this milestone — R-12-02 (scheduled tasks and the
Startup folders) and R-18-02 (multi-monitor placement and scale-aware sizing) — were closed by
building the missing half, and each carries a named residual limitation in
`docs/KNOWN_LIMITATIONS.md` §15 rather than a quiet promotion:

| ID | Was missing | Now | Still unproven |
| --- | --- | --- | --- |
| R-12-02 | scheduled tasks; Startup folders | read through `Get-ScheduledTask`, with a `schtasks` fallback that states what it cannot report | the fallback path and every one of these reads have never run on physical hardware |
| R-18-02 | per-monitor placement, scale-aware sizing | placement computed from the work area in `src/app/window-placement.js`; the harness asserts the real window sits inside a real work area | only one 1024x700 display exists in CI; no remembered position between runs |

`docs/AUDIT_40_SECTIONS.md` is the section-by-section record: for each of the 40 specification
sections it lists the requirements, what a user sees, where the gaps are, and what evidence
exists. Nothing is closed there by the mere presence of a page.

---

## 5. Known defects found and fixed recently

Recorded because they show what the tests were missing, and what changed to catch the
class of bug.

| Defect | How it surfaced | Fix |
| --- | --- | --- |
| All 11 initial modules registered provider `cim-win32`; 10 failed as duplicates | Registering the real modules into the scan | Task-scoped ids + suffix-aware `tierOf()` |
| 3 modules registered a task before its provider, so the module never registered | Same | Tasks moved after providers |
| 5 providers returned `{}` when they had no data | New provider-execution test | Explicit `unavailable`/`unsupported` field with a reason |
| `security.js` threw `ReferenceError: lua is not defined` on every scan | Real end-to-end scan | Correct destructured names |
| `motherboard.js` referenced an undefined `firmwareProbe` | Provider-execution test | Correct variable |
| Score printed `100 · Good` from 1 of 8 components | Real end-to-end scan | Coverage gating |
| 3 mechanisms silently classified as `heuristic` | New tier-completeness test | Added to `PROVIDER_TIERS` |
| A dead duplicate dxdiag provider existed alongside the live one | Tier test after rename | Removed |
| `diskpart /s script` was permitted while `diskpart` + `clean` was refused | Writing the guard's first tests | New forbidden rule |
| The manual page called its own loader from its render function, freezing the window | Booting the renderer under jsdom | Loading guard |
| History entries were saved with no id and silently discarded on every load, so stored runs never accumulated | Writing the first history-store tests | Spread order fixed; skipping now warns |

The pattern: **unit tests covered pure functions, and nothing executed the wiring.** The
provider, tier and documentation tests now do.

---

## 6. Next

In the order that reduces the largest honesty gap first:

1. **Produce the Windows build.** Everything in §3 depends on it, and no amount of
   Linux-side testing substitutes for it.
2. **Run it on a real machine** and record `verifiedOn` evidence per requirement. This is
   the only path to any requirement being VER.
3. **Wire the remaining interface action**: embedding performance results.
   Report saving, the history list and live monitoring are now connected.
4. **Run the configured Windows CI** and record the result in `docs/TEST_STATUS.md`.
5. **Complete `docs/RELEASE_VERIFICATION.md`** — the checklist is written and every box is
   unticked, which is the accurate state.

Nothing above is a commitment to a date.

---

## 7. What will not change

These are product decisions, not open questions:

- No network client. Not "disabled by default" — absent.
- No operation that modifies the system, other than the four consent-gated file writes.
- No score without coverage, and no "Good" from a minority of the machine.
- No requirement marked VER without recorded evidence from a real machine.
- No sample or placeholder data in the interface.
