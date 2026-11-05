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
| Tested (automated) | 75 |
| Implemented, untested | 11 |
| Not started | 44 |
| Automated tests | 449, all passing |
| Source | 54 modules, ~16,500 lines |
| Build | **produced** on Windows: installer 117.4 MiB + portable 106.5 MiB, unsigned |

The headline: **the application now builds on Windows and its full test suite passes on
Windows, but it has never been installed or launched on a real desktop.** A build that
exists is not a build that works, and no requirement is marked VERIFIED on the strength of
a successful CI build.

---

## 2. Finished and tested

These are genuinely done: implemented, wired, and covered by tests that execute the code.

### Diagnostics
- 11 modules, 15 tasks, 29 providers, all registering cleanly.
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
- Forbidden-command guard: 16 destructive command lines refused, 11 read-only ones
  permitted, both directions tested.
- Consent gating for the four operations that write files.
- Outbound guard, plus the stronger guarantee that no network client exists in `src/`.
- Field-level redaction with failure-closed defaults.

### Interface
- 15 pages, all rendering under jsdom with no `undefined`/`NaN`/`[object Object]`.
- Two complete themes with measured contrast; five accents with light-mode pairs.
- Strict CSP, no remote assets, reduced-motion support.
- Honest empty states: pages whose actions are not wired say so in plain words.
- History list wired to the store, with three distinct states (loading, empty, unreadable)
  and withheld scores preserved rather than rendered as zero.
- Live monitoring wired to a real `Monitor` in the main process, which previously
  answered `{ started: true }` without starting anything.

### Tooling
- `scripts/check.mjs` static gate: 0 errors.
- Requirement auditor that refuses a `VER` status without recorded evidence.
- Artifact verifier producing `SHA256SUMS.txt`.
- Documentation checks: paths named in docs must exist, and the CSP quoted in
  `SECURITY.md` must match the one the shell declares.

---

## 3. Wired but unproven

Implemented and connected, but resting on fixtures rather than a real machine.

- Every Windows read. The parsers match their fixtures; whether the fixtures match real
  Windows is unknown.
- The Electron shell. Window creation, IPC handlers and the preload bridge exist and are
  unit-tested; the window has never opened.
- The packaging configuration. `electron-builder.config.mjs` is written and validated by
  test; no installer has been built.

This is the largest category and the reason no requirement says VER.

---

## 4. Not started

44 requirements. Grouped by concentration:

| Area | Roughly | Note |
| --- | --- | --- |
| Windows inventory depth | 5 | servicing detail, update history, activation state |
| Benchmark variants | 3 | memory, GPU, broader workloads |
| Driver inventory depth | 3 | signing state, version comparison across machines |
| Report history | 2 | compare in the interface, delete |
| Compatibility | 2 | vendor matrix, build-specific constraints |
| Notifications, search, shortcuts, layout, animation | 8 | interface surface |
| Audit, architecture, CI/CD, icon, about | 7 | repository and release plumbing |
| Assorted | 13 | see `docs/REQUIREMENTS.md` |

Each is tracked with an id; none is promised for a date.

---

## 5. Known defects found and fixed recently

Recorded because they show what the tests were missing, and what changed to catch the
class of bug.

| Defect | How it surfaced | Fix |
| --- | --- | --- |
| All 11 modules registered provider `cim-win32`; 10 failed as duplicates | Registering the real modules into the scan | Task-scoped ids + suffix-aware `tierOf()` |
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
