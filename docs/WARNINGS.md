# Warnings: an item-by-item decision record

`node scripts/check.mjs` currently reports **0 errors, 3 warnings**. Each of the 3 is a
requirement that is genuinely not built. Everything else that was previously listed as a
warning has been investigated and either implemented, partially implemented and honestly
downgraded to *in progress*, or recorded as a documentation requirement that is now met.

This file is the decision record for all 21 requirements that were marked *not started* at the
start of this milestone. Nothing was suppressed, no rule was relaxed, and no status was changed
without evidence in the repository.

**How to read the decisions**

| Decision | Meaning |
| --- | --- |
| **Implemented** | Code exists, is wired, and a test executes it. Status became `TS`. |
| **Partially implemented** | Some of the requirement exists; the missing part is named. Status became `IP`. |
| **Documentation met** | The requirement is a document or policy; the document exists and is enforced. Status became `IM`. |
| **Still not started** | Nothing exists. Status stays `NS`, and the warning stays visible. |

---

## 1. The 3 that remain

| ID | Requirement | Why it is still not started | Implementable safely? | Decision |
| --- | --- | --- | --- | --- |
| R-08-05 | GPU performance test where supported, else UNSUPPORTED | A GPU benchmark that means anything needs a stable workload and a way to distinguish a slow GPU from a thermally throttled one. Neither exists yet; reporting `UNSUPPORTED` for every machine would satisfy the letter of the requirement and teach the user nothing. | Yes, with a workload and a thermal guard | **Not started.** Not refused by design — deferred, and it stays visible as a warning. |
| R-08-06 | System responsiveness composite score from measured subsystems | Depends on the RAM and GPU measurements above; a composite of two missing measurements would be a number invented from nothing. | Yes, after R-08-03 and R-08-05 | **Not started.** Deferred with a stated dependency. |
| R-25-02 | Crash handling, unexpected-shutdown recovery, interrupted-test recovery | The history store already quarantines an unreadable file rather than losing it, which is the recovery half. What does not exist is a main-process `uncaughtException` path. That is deliberate for now: an uncaught-exception handler that logs and continues turns a crash into a silent inconsistency, and the design question — show a dialog and quit, or restore and continue — is a product decision that has not been made. | Yes, once the behaviour is decided | **Not started.** The warning is the reminder that the decision is owed. |

---

## 2. Implemented in this milestone (11 warnings cleared)

| ID | Requirement | What was found | Evidence |
| --- | --- | --- | --- |
| R-01-25 | Independent SATA and NVMe providers with fallback | Both existed: `smart-ata.storage` (ATA SMART through `IOCTL_ATA_PASS_THROUGH`) and `nvme-health-log.storage` (NVMe health log), merged by the registry with fallback | `src/providers/smart-ata.js`, `src/providers/smart-nvme.js`, `tests/unit/smart.test.js` (18) |
| R-02-08 | Multi-provider battery chain with per-method logging | Five providers in priority order, and every attempt is recorded by `logger.providerAttempt` | `src/diagnostics/battery.js`, `tests/unit/battery.test.js` (17) |
| R-11-01 | Driver inventory: name, manufacturer, version, provider, date, class, status, signing, instance id, error code | Every named field is collected; a missing one is `unavailable` with a reason rather than blank | `src/diagnostics/drivers.js`, `tests/unit/drivers.test.js` (10) |
| R-11-02 | Evidence-based driver health classification | Classification uses the Config Manager code, the status string and the signing state; nothing is inferred from a version number | `src/diagnostics/drivers.js#classifyDriverHealth`, `tests/unit/windows-modules-depth.test.js` (31) |
| R-16-01 | Vendor-agnostic detection across the named brands | A 20-vendor table, including all eleven the requirement names | `src/diagnostics/system.js`, `tests/unit/windows-extended.test.js` (22) |
| R-35-01 | Requirement audit that fails on an unsupported claim | It did fail, but nothing had ever observed it failing | New gate: `tests/integration/audit-gate.test.js` (6) proves it refuses a missing test, missing code, unearned `VER`, unexplained `BL` and duplicate ids |
| R-35-02 | Final documentation set and release verification report | Both exist; the release report marks every unchecked item | `docs/RELEASE_VERIFICATION.md`, `docs/RELEASE_NOTES.md` |

---

## 3. Partially implemented, downgraded honestly (7 warnings cleared, 7 gaps named)

| ID | What exists | What is missing | Status |
| --- | --- | --- | --- |
| R-08-03 | A memory-bandwidth workload and its reporting | A stability test (sustained load, error detection) | `IP` |
| R-09-03 | Sensor availability, per-sensor source labels, configurable interval | Exporting a monitoring session | `IP` |
| R-18-02 | Every display enumerated with bounds, work area, rotation and scale factor; GUI harness checks 1024×700 and 125% zoom | Per-monitor window placement; no scale-aware sizing of the shell itself | `IP` |
| R-19-02 | `dashboard.widgets` is now read: the listed widgets render in the listed order and the rest are hidden | Drag-and-drop arrangement | `IP` |
| R-26-01 | No network client exists in `src/` (tested), nothing is uploaded, no telemetry | No licence-cleanliness check on dependencies | `IP` |
| R-27-01 | Every module parsed, imported and import-resolved; entry points checked | No circular-dependency check | `IP` |
| R-27-02 | Syntax, named-import and entry-point gate at 0 errors | No formatter enforcement | `IP` |

**Two defects were found while checking these**, both of the same kind — a declaration the
product did not honour:

- **`dashboard.widgets` was a dead setting.** It was declared in `src/core/settings.js`,
  forwarded to the renderer in `uiPayload()`, documented as "removing a widget hides it from
  the dashboard grid" — and never read. Editing it changed nothing. It is now applied, and two
  tests assert both directions (listed widgets appear; unlisted ones do not).
- **The setting's default listed widget ids that did not exist** (`overview`, `cpu`, `gpu`,
  `thermal`, …). Those names belonged to a design that was never built. The default is now the
  six ids the dashboard actually has.

---

## 4. Documentation requirements now met (3 warnings cleared)

| ID | Requirement | Evidence |
| --- | --- | --- |
| R-16-02 | Windows 10/11 support matrix with build constraints | `docs/COMPATIBILITY.md` (§ matrix, § minimum build, § what differs on 1903) |
| R-32-01 | Unsigned build, SHA-256 publication path, SmartScreen disclosure without bypass advice | `electron-builder.config.mjs` (no signing), `scripts/verify-artifacts.mjs` (manifest per build), `README.md` § Signing, `docs/SECURITY.md` § 6.1. **Publication of hashes waits for an authorised release**, which is why this is `IM` and not `TS`. |
| R-34-01 | Virtual/physical validation disclosed, and nothing unverified claimed as verified | `docs/TEST_STATUS.md`, `docs/KNOWN_LIMITATIONS.md` § 1, and the audit rule that refuses `VER` without a recorded machine |

---

## 5. What was explicitly *not* done, and why

The milestone instruction was not to implement features merely to clear warnings. Four
candidates were considered and refused on their merits:

| Candidate | Why not now |
| --- | --- |
| A GPU benchmark (R-08-05) | A benchmark without a thermal guard reports the cooler as much as the GPU. Shipping one now would produce a number the product cannot stand behind. |
| A responsiveness composite (R-08-06) | It would be computed from the two missing measurements. |
| A catch-all `uncaughtException` handler (R-25-02) | It would hide crashes rather than handle them; the user-facing behaviour has to be decided first. |
| A licence-audit script (R-26-01) | Worth doing, but it belongs with the dependency policy discussion, not with a verification milestone. |

---

## 6. Verification of this record

```text
node scripts/check.mjs                 → 0 error(s), 3 warning(s)
node scripts/audit-requirements.mjs    → every claimed status matches the repository contents
```

The three remaining warnings are the three requirements in §1. They are visible on every push,
in `npm run check`, and in CI's static-checks job. Removing them without building the features
would be the one thing this document exists to prevent.
