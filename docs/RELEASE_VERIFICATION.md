# Release verification

A checklist a person completes **before** publishing a build, and a record of what has
been verified for each release.

This document exists because `src/app/main.js` cannot be executed in the environment the
project was written in: there is no Electron binary, no Windows, and no display. Its logic
is extracted into testable modules (`ipc-contract.js`, `scan.js`, `settings-wiring.js`)
and covered there, but anything that can only be proven by launching the application is
listed here as **NOT VERIFIED**.

---

## Current status

| | |
| --- | --- |
| Release candidate | `1.0.0`, built by CI only — never installed |
| Build produced | **Yes** — Windows x64 installer and portable, CI run 42015386547 |
| Verified on | **nothing** |
| Verified by | — |
| Result | **Built, not run. No physical Windows machine has executed this build.** |

Every item below is unchecked except the build checks in §1, which CI performs and whose
results are quoted. This table is deliberately not pre-filled: a verification document with
tick marks nobody earned is worse than no document.

## What has been established, and what has not

**Established** (Windows 10/11 runner, `windows-latest`, commit `25e9f22`+):

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `VERIDEX-Setup-1.0.0-x64.exe` | 117.4 MiB | `a8377850b828f769f0492071f59758d20d6763ac00e05d72e68ca67baf09c613` |
| `VERIDEX-1.0.0-portable-x64.exe` | 106.5 MiB | `fe7338dca1de85c164195606c0825f6b098341043cf546a58069c9b19d6b9335` |

- the full test suite passes on Windows as well as Linux (453 tests at the time of writing);
- electron-builder produced both targets without error;
- the artifacts carry valid PE headers and plausible sizes;
- the digests were recomputed and match, so the files are the files that were built;
- both executables are unsigned, as expected and as stated in the release notes;
- a build manifest with these facts is published beside the artifacts.

**Not established — and these are the reasons no release is published:**

- the installer has **never been run**. Nobody has installed it.
- the application has **never been launched**. The renderer has been exercised under jsdom
  against a simulated bridge; a real BrowserWindow has never opened on a real desktop.
- **partly addressed, and it took a live smoke test to do it.** As first written, this line
  said no WMI/CIM, PowerShell or registry call had ever executed. That was true, and it was
  hiding four defects: a zero measurement that crashed the memory task, a provider killed by
  a budget it had already accounted for, `dxdiag` spawned under a provider id, and a
  PowerShell script that could not parse. `npm run smoke:live` now exercises the real
  interfaces on the Windows runner. On run 42027223853 it produced 1095 fields across 15
  modules, a rated score of 84 at 75% coverage, one remaining ERROR (a genuinely absent
  `dxdiag`), and zero structural problems. That is evidence about the **diagnostic layer**,
  on a virtual machine, with synthetic devices — not about a packaged application on a real
  PC. **No packaged build has ever executed.**
- UAC elevation has never been exercised.
- DPI scaling, window resizing and multi-monitor behaviour are untested in a real window.
- the artifact could not be downloaded in the environment where this document was written
  (GitHub serves artifacts from blob storage, outside the allowlist), so the binary has not
  been inspected locally either — only its recorded metadata.

Everything in §2 onward is therefore unchecked, and remains so until a person runs the
installer on a Windows machine and records what happened.

---

## 1. Build — performed by CI on windows-latest

- [x] `npm ci` completes from a clean checkout
- [x] `npm test` passes with zero failures (423 tests, both platforms)
- [x] `npm run check` reports 0 errors
- [x] `npm run audit:requirements -- --check` reports no inconsistency
- [x] `npm run build:win` produces an NSIS installer and a portable executable
- [x] `npm run verify:artifacts` writes `dist/SHA256SUMS.txt` with an entry per artifact
- [x] The recorded SHA-256 values match the files actually built
- [ ] `dist/` contains no source maps, test files or development tooling **(not inspected: the artifact could not be downloaded here)**

## 2. Launch — the first thing never yet done

- [ ] The application launches **as a standard user**
- [ ] The window opens at a usable size and does not open maximised over the taskbar
- [ ] No blank white frame, no flash of unstyled content
- [ ] The dashboard shows **Unrated** everywhere and no invented numbers
- [ ] The header states the application is local and read-only
- [ ] The window title is `VERIDEX`
- [ ] Closing and reopening works, with no orphaned process left behind
- [ ] A second launch focuses or refuses the existing instance rather than starting a
      second copy

## 3. A standard-user scan

- [ ] The scan completes without an unhandled exception
- [ ] Every task reports a terminal state; none is left spinning
- [ ] Fields that need elevation read **Permission required**, not **Unavailable**
- [ ] Components with no evidence read **Unrated**
- [ ] The score is **withheld or capped** if coverage is below the threshold — record the
      coverage figure and the score shown beside it
- [ ] The reason for a withheld score is visible on the dashboard, not only in a log
- [ ] A desktop with no battery reports the battery as **Not applicable**, not as broken

## 4. An elevated scan

- [ ] The application starts elevated when launched by an administrator
- [ ] Additional fields are collected (record which: driver store, TPM, servicing, storage)
- [ ] Coverage rises, and the score changes only because coverage rose
- [ ] No operation modifies the machine — confirm no file outside the report directory and
      no system setting changed

## 5. Reports

- [ ] PDF opens in a reader and is legible; no overlapping text, no truncated tables
- [ ] PDF page footers number correctly and do not continue onto a page that does not exist
- [ ] HTML opens offline with **all** styling present (no missing CSS, no remote fetch)
- [ ] JSON parses and contains the redaction policy in force
- [ ] CSV opens in a spreadsheet with correct column separation
- [ ] The certificate states the correct verdict, including `Not assessed` when withheld
- [ ] A report generated with redaction **on** contains no serial number, MAC address,
      hostname or account name — verified by searching the saved file
- [ ] A report generated with redaction **off** says so in its own contents

## 6. Security

- [ ] With all interfaces down, the application makes no connection attempt
      (verify with a network monitor, not by assuming)
- [ ] The renderer cannot open a connection: `connect-src 'none'` holds in the packaged build
- [ ] DevTools is not reachable in the packaged build
- [ ] No file outside the report directory is written, including during a full scan
- [ ] The four consent-gated operations do not run without an explicit confirmation
- [ ] Refusing a consent prompt leaves the report honest rather than empty

## 7. Installer

- [ ] Installs per-user without an administrator prompt
- [ ] Installs to the expected location and creates a start-menu shortcut
- [ ] The uninstaller removes the application and leaves saved reports intact
- [ ] Windows SmartScreen warns, as expected for an unsigned build — **record the exact
      wording**, because a build that does *not* warn would be a different build
- [ ] The portable executable runs from a removable drive with no installation
- [ ] The licence text is shown by the installer and matches `LICENSE`

## 8. Real-hardware behaviour

Record what each interface actually returned, including everything that came back
unavailable. This is the section that turns a tested project into a verified one.

| Area | Observed on the test machine |
| --- | --- |
| Processor | |
| Memory (per module) | |
| Storage health (SMART / NVMe) | |
| Battery (if a laptop) | |
| GPU and DirectX | |
| Thermal sensors | |
| Driver inventory | |
| Windows servicing | |
| Security posture | |
| Network adapters | |

- [ ] Every `verifiedOn` entry added to `docs/requirements.json` reflects what was
      **observed**, including the parts that did not work
- [ ] `npm run audit:requirements` regenerates `docs/REQUIREMENTS.md` with the new totals
- [ ] `docs/TEST_STATUS.md` is updated with the platform and date

## 9. Sign-off

- [ ] `docs/RELEASE_NOTES.md` has an entry for this version, with the artifact checksums
- [ ] `docs/KNOWN_LIMITATIONS.md` still describes reality; correct anything the test
      machine contradicted
- [ ] The release notes state that the build is unsigned
- [ ] The version in `package.json` matches the tag being released

**Verified by:** ______________________  **Date:** ____________

**Machine:** ______________________  **Windows build:** ____________

---

## Notes for the person doing this

Two things are easy to get wrong:

1. **Do not tick a box you inferred.** "The code checks `isAdmin` before calling SMART, so
   elevation must work" is not verification. Verification is: you ran it elevated, and you
   saw the SMART values appear.
2. **Do record the failures.** A checklist that only records success produces a release
   note that reads like marketing. The value of this document is in the rows that say
   "unavailable" and the paragraph that explains why.
