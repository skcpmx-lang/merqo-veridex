# Warnings that remain, and why

`node scripts/check.mjs` finishes with `0 error(s), 21 warning(s)`. This file records every
one of them. None was suppressed, downgraded or deleted to reach a smaller number, and no
rule was relaxed.

## What the warnings are

All 21 are the same class: a requirement in `docs/requirements.json` that is still marked
**NS — not started**. `scripts/check.mjs` warns about each so a not-started requirement
cannot disappear into a summary line.

| Field | Value |
| --- | --- |
| Source | `scripts/check.mjs`, rule `requirements`. Reads `docs/requirements.json`. |
| Origin | The requirement set was written from the specification (130 rows over 39 modules). 25 rows were genuinely unimplemented at the last milestone. Four of them — R-11-03, R-14-02, R-20-01, R-24-03 — were implemented in this milestone and are now `TS`, which is why the count fell from 25 to 21. |
| Root cause | Not a defect in code. These are features the product does not have yet. |
| Fixability | Each is fixable, at the cost of building the feature. None is blocked. |

## The 21, one line each

| ID | Requirement (short) | Why it is not started | Fixable? |
| --- | --- | --- | --- |
| R-01-25 | Firmware/BIOS release date and version cross-check | needs a second, independent source to be worth showing | yes |
| R-02-08 | GPU driver-known-issue list | requires a manufacturer catalogue VERIDEX deliberately does not bundle | **no — by design** |
| R-08-03 | Display colour-gamut measurement | needs a colorimeter; software cannot measure a panel | yes, with hardware |
| R-08-05 | Panel uniformity map | same | yes, with hardware |
| R-08-06 | PWM / flicker measurement | same | yes, with hardware |
| R-09-03 | Audio loopback test | requires playing a tone and capturing it; would change the machine's audio state | yes |
| R-11-01 | Driver version comparison against vendor catalogue | same reason as R-02-08; an offline copy would be stale within weeks | **no — by design** |
| R-11-02 | Driver rollback | a write operation; refused by the command guard | **no — by design** |
| R-16-01 | Performance trend over time | needs a sampling store the product does not keep | yes |
| R-16-02 | Thermal trend over time | same | yes |
| R-18-02 | Wake-timer inventory | needs a scheduled-task read that is not implemented yet | yes |
| R-19-02 | Battery charge-history chart | data is collected; the chart is not drawn | yes |
| R-25-02 | Certificate/branding page in reports | a reporting feature, not a diagnostic one | yes |
| R-26-01 | Multi-machine comparison | would require storing more than one machine's data | yes |
| R-27-01 | Fleet export | same, plus a format decision | yes |
| R-27-02 | Fleet import | would introduce a file parser for untrusted input | yes |
| R-29-01 | Scheduled recurring scans | a background writer; conflicts with the no-silent-activity rule unless designed carefully | yes |
| R-32-01 | Localisation of report text | the interface has a language setting; the report templates do not use it yet | yes |
| R-34-01 | Plugin/provider extension point | would widen the command surface beyond the allowlist | **no — by design** |
| R-35-01 | Auto-update | would be a network client; the central claim is that there is none | **no — by design** |
| R-35-02 | Crash reporting | same | **no — by design** |

Eight of the 21 are **refused by design** rather than deferred. The other thirteen are
deferred features, each with an honest reason.

## What would remove them

Either build the feature and move the row to `TS` with tests (as was done for the four in
this milestone), or change the requirement and record the change. Deleting the warning
rule, filtering its output, or editing the JSON status without the corresponding code is
not an acceptable route and none was taken.

## Not counted here

Warnings raised by other tools are reported in their own sections of
`docs/TEST_STATUS.md`:

- `npm audit` — no advisories at the pinned versions.
- Electron security warnings — none at runtime in the GUI smoke test.
- The Windows-only test gap — recorded in `docs/TEST_STATUS.md §4`, not suppressible on
  Linux.
