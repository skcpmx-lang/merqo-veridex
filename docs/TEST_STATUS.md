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
tests 366 · pass 364 · fail 2
```

The two failures are documentation checks that fail while a document is still being
written — they pass once the file exists. They are listed in §5.

| File | Tests | What it covers |
| --- | --- | --- |
| `tests/unit/battery.test.js` | 17 | powercfg and systeminformation battery mapping, wear maths |
| `tests/unit/bench-cpu.test.js` | 14 | CPU benchmark scoring, stress guard limits |
| `tests/unit/bench-disk.test.js` | 6 | disk benchmark, consent for the write half |
| `tests/unit/cpu-model.test.js` | 9 | model-number decoding, unknown-name handling |
| `tests/unit/cpu.test.js` | 13 | CIM processor parsing, fallbacks |
| `tests/unit/drivers.test.js` | 10 | driver inventory, age assessment, problem codes |
| `tests/unit/fallback.test.js` | 8 | provider chain fall-through |
| `tests/unit/field.test.js` | 13 | FieldValue construction, status vocabulary |
| `tests/unit/gpu.test.js` | 16 | GPU parsing, vendor heuristic, VRAM sanity |
| `tests/unit/health.test.js` | 24 | component scoring, coverage gating, rating |
| `tests/unit/ipc-contract.test.js` | 17 | the preload surface, forbidden exposure |
| `tests/unit/manual.test.js` | 48 | manual checklist, session, coverage separation |
| `tests/unit/monitor.test.js` | 9 | sampling, series |
| `tests/unit/network.test.js` | 8 | adapter parsing, socket derivation |
| `tests/unit/report.test.js` | 34 | model → json/html/pdf/csv/certificate |
| `tests/unit/security.test.js` | 15 | forbidden commands, consent, network guard |
| `tests/unit/smart.test.js` | 18 | ATA SMART and NVMe health log parsing |
| `tests/unit/stress.test.js` | 16 | stress guard, elapsed time, transitions |
| `tests/integration/confidence-tiers.test.js` | 6 | every provider mechanism has a tier |
| `tests/integration/diagnostic-run.test.js` | 16 | task execution end to end with a fake runner |
| `tests/integration/docs.test.js` | 5 | documentation paths and claims match the code |
| `tests/integration/no-network.test.js` | 4 | no transport code exists in `src/` |
| `tests/integration/providers.test.js` | 6 | every registered provider executes and explains itself |
| `tests/integration/renderer.test.js` | 8 | all 15 pages render under jsdom |
| `tests/integration/scan.test.js` | 11 | registry construction, scan orchestration |
| `tests/integration/settings-wiring.test.js` | 15 | settings read/write, privacy defaults |

Run in **Linux CI only**. Nothing in this table is evidence about Windows behaviour: the
tests exercise logic, parsers and integration seams against recorded or simulated
command output.

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
- The **renderer** renders all 15 pages with no `undefined`, `NaN` or `[object Object]`.
- The **documentation** refers only to files that exist, and the CSP quoted in
  `SECURITY.md` matches the one the shell declares.

---

## 4. What the tests do not prove

Stated plainly, because this is the section that matters:

1. **That any of it works on Windows.** No test runs on Windows hardware in this
   repository's history. CI is configured to run the suite on `windows-latest`
   (`.github/workflows/build.yml`), and that configuration has not yet produced a result
   here.
2. **That the real interfaces return the shapes the fixtures assume.** A parser that is
   perfectly tested against a fixture proves the parser matches the fixture, nothing more.
3. **That the packaged application launches.** No build has been produced in this
   environment: there is no Electron binary, no Wine, and no NSIS toolchain available.
4. **That the installer installs.** Same reason.
5. **That performance is acceptable on real hardware.** The ~770 ms figure comes from
   this container running providers that mostly return `UNSUPPORTED` immediately. It says
   nothing about a Windows machine running 28 real queries.

---

## 5. The two failing checks

`tests/integration/docs.test.js` contains two checks that fail while documentation is
incomplete. They are:

1. **every repository path named in the documentation exists** — `requirements.json`
   cites `docs/PROJECT_STATUS.md`, `docs/GITHUB_ACTIONS.md` and others that are being
   written in the same change as this file.
2. **every document in `docs/` is referenced somewhere** — a document nothing links to is
   a document nobody reads.

Both are real checks, not placeholders. They fail now because the work is not finished;
they are the mechanism that guarantees it gets finished rather than forgotten.

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
