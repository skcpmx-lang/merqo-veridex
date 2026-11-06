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
| Release candidate | `1.0.0`, built by CI — installed, launched and removed on a Windows runner |
| Build produced | **Yes** — Windows x64 installer and portable, CI run 42103239365 |
| Verified on | **Windows Server 2025, `windows-latest` virtual machine** (GitHub Actions) |
| Verified by | automated harnesses (`npm run smoke:gui`, `smoke:portable`, `smoke:install`) |
| Result | **Installed, launched, uninstalled on a VM. Still never run on physical hardware.** |

Every item below is unchecked except the build checks in §1 and the machine checks that
automation now performs, which are marked **VM** and quote their evidence. This table is
deliberately not pre-filled: a verification document with tick marks nobody earned is worse
than no document, and a tick earned on a virtual machine is not a tick for a PC with a battery,
an SSD and a discrete GPU in it.

## What has been established, and what has not

**Established** (Windows Server 2025 runner, `windows-latest`, CI run 42103239365):

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `VERIDEX-Setup-1.0.0-x64.exe` | 117.4 MiB | `90a5602b6f4a5c72b68ed7838ea9308cd85d0303cbd3439c03ca9da76fd511c0` |
| `VERIDEX-1.0.0-portable-x64.exe` | 106.5 MiB | `3627a41d3e3ce6e7c73c5ac6afad19099fa61766699da23c8aafb378e9d7ff0a` |

- the full test suite passes on Windows as well as Linux (705 tests at the time of writing);
- electron-builder produced both targets without error;
- the artifacts carry valid PE headers and plausible sizes;
- the digests were recomputed and match, so the files are the files that were built;
- both executables are unsigned, as expected and as stated in the release notes;
- a build manifest with these facts is published beside the artifacts;
- **the unpacked build launched and was driven through its whole interface**: 13 steps, no
  problems — boot, a visible window, the shipped `webPreferences`, a scan through the
  interface, the rendered result, all 15 pages **of that build**, history, live monitoring, a settings round
  trip, JSON/HTML/PDF reports at real sizes (41 kB / 46 kB / 24 kB), cancellation, clean exit;
- **the portable executable launched** from its extraction directory and reported a working
  interface: 10 checks, no problems, 15 seconds end to end;
- **the installer installed**: silently, per-user, into `%LOCALAPPDATA%\Programs\VERIDEX`,
  with an uninstaller and both shortcuts; **the installed application then launched and
  worked** — title, preload bridge with 18 invoke channels, a real `app:info` call, and all
  15 pages rendered (the interface now has 18; the three added since are covered by the jsdom
  suite and need a GUI re-run before release) — and **the uninstaller removed it**; 16 checks,
  no problems.

**Not established — and these are the reasons no release is published:**

- **No physical hardware.** Every run above is on a virtual machine with synthetic devices:
  no battery, no SMART, no discrete GPU. The application's behaviour on a real PC — which is
  the only place a laptop battery or an SSD's SMART data exists — has never been observed.
- **A human has never used it.** The window is confirmed visible to the operating system; no
  person has looked at it.
- **UAC elevation has never been exercised**, so nothing in §4 has been done.
- **SmartScreen has never been seen.** An unsigned download on a real machine warns; the
  exact wording is unrecorded because nobody has downloaded it.
- **partly addressed, and it took a live smoke test to do it.** As first written, this line
  said no WMI/CIM, PowerShell or registry call had ever executed. That was true, and it was
  hiding four defects: a zero measurement that crashed the memory task, a provider killed by
  a budget it had already accounted for, `dxdiag` spawned under a provider id, and a
  PowerShell script that could not parse. `npm run smoke:live` now exercises the real
  interfaces on the Windows runner. On run 42027223853 it produced 1024 fields across 15
  modules, a rated score of 84 at 75% coverage, one remaining ERROR (a genuinely absent
  `dxdiag`), and zero structural problems. That is evidence about the **diagnostic layer**,
  on a virtual machine, with synthetic devices — not about a packaged application on a real
  PC. **No packaged build has ever executed.**
- UAC elevation has never been exercised.
- DPI scaling, window resizing and multi-monitor behaviour are untested in a real window.
- the artifact could not be downloaded in the environment where this document was written
  (GitHub serves artifacts from blob storage, outside the allowlist), so the binary has not
  been inspected locally either — only its recorded metadata.

§1 and the **VM** boxes in §2 and §7 are done. Everything else needs a person at a physical
machine, and nothing in this document becomes **L4** evidence until that happens.

---

## 1. Build — performed by CI on windows-latest

- [x] `npm ci` completes from a clean checkout
- [x] `npm test` passes with zero failures (705 tests, both platforms)
- [x] `npm run check` reports 0 errors
- [x] `npm run audit:requirements -- --check` reports no inconsistency
- [x] `npm run build:win` produces an NSIS installer and a portable executable
- [x] `npm run verify:artifacts` writes `dist/SHA256SUMS.txt` with an entry per artifact
- [x] The packaged application passes validation: real x64 PE with version metadata matching
      `package.json`, and an `app.asar` whose header parses and which contains the main
      process, the preload and the renderer
- [x] The recorded SHA-256 values match the files actually built
- [ ] `dist/` contains no source maps, test files or development tooling **(not inspected: the artifact could not be downloaded here)**

## 2. Launch

`[x]` **VM** means an automated harness checked it on the Windows runner and the run is
quoted in *What has been established*. Those ticks are honest and they are not the whole
list: every unchecked box needs a person in front of a physical machine.

- [x] **VM** The application launches as a standard user (no elevation prompt)
- [x] **VM** The window becomes visible, at 1024×720, and reports itself visible
- [x] **VM** The installed build launches from `%LOCALAPPDATA%\Programs\VERIDEX`
- [x] **VM** The portable build launches from its temporary extraction directory
- [x] **VM** The window title is `VERIDEX — Advanced All-in-One Windows PC & Laptop Diagnostics`
- [x] **VM** The preload bridge loads: 18 invoke channels, event subscription present
- [x] **VM** All 15 pages render from inside the asar (recorded before Activity log, export
      card and first-run tour existed; re-run required)
- [ ] No blank white frame, no flash of unstyled content — **a flash is not observable from
      inside the process; it needs an eye on the screen**
- [ ] The window opens at a size that looks right on a real display, and does not open over
      the taskbar
- [ ] No invented numbers on first view (the harness asserts *no score is presented as full
      health*; a person must read the page)
- [ ] Closing and reopening works, with no orphaned process left behind
- [ ] A second launch focuses or refuses the existing instance
- [ ] The dashboard is legible at 125% and 150% DPI scaling

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

- [x] **VM** Installs per-user, silently (`/S`), with no administrator prompt
- [x] **VM** Installs to `%LOCALAPPDATA%\Programs\VERIDEX` and creates the start-menu and
      desktop shortcuts
- [x] **VM** The uninstaller removes the application, its directory and its shortcuts, and
      leaves saved user data in place (`deleteAppDataOnUninstall: false`)
- [x] **VM** The portable executable runs from a directory that is not an installation
- [ ] The interactive installer: the licence page, the directory chooser, the progress
      bar, and the finish page — **`/S` proves none of those; somebody must click through it**
- [ ] Windows SmartScreen warns, as expected for an unsigned build — **record the exact
      wording**, because a build that does *not* warn would be a different build
- [ ] The portable executable runs from a removable drive on a machine without the
      prerequisites installed
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
