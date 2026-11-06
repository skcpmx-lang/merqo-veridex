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
| Build produced | **Yes, twice.** Run 42160034210 built, installed, launched and removed the build whose hashes are quoted below. Run **42198220081** built the same two targets from the current tree (`1b7ab4e`) and passed artifact verification, package validation, the unpacked GUI smoke test, the portable launch check and the installer's install/launch/uninstall |
| Hashes quoted below belong to | **the 42160034210 build, not the current tree.** The current tree's bytes could not be fetched into the environment that wrote this document: `gh run download` reaches `*.blob.core.windows.net`, which is outside its network egress (`EOF`), so no hash is claimed for them. A hash nobody computed is not a hash |
| Verified on | **Windows Server 2025, `windows-latest` virtual machine** (GitHub Actions) |
| Verified by | automated harnesses (`npm run smoke:gui`, `smoke:portable`, `smoke:install`) |
| Published | **No.** The first blocker is gone: `release.yml` is on `main` and registered, after this branch was merged (`2b71668`). The second is a permission this session does not have — `Actions: write` — so the dispatch answers `403`. See below |
| Release workflow | **Registered, dispatch refused.** The workflow now exists on `main` (`409192902`), so the endpoint resolves; the call is answered `403 Resource not accessible by integration`, which is the `Actions: write` permission this session's GitHub App installation does not hold. Read the row above for the history: it used to be `404` as well |
| Result | **Installed, launched, uninstalled on a VM. Still never run on physical hardware.** |

Every item below is unchecked except the build checks in §1 and the machine checks that
automation now performs, which are marked **VM** and quote their evidence. This table is
deliberately not pre-filled: a verification document with tick marks nobody earned is worse
than no document, and a tick earned on a virtual machine is not a tick for a PC with a battery,
an SSD and a discrete GPU in it.

## The artifacts of the current tree, and what can and cannot be said about them

The packaging job of run **42198220081** (source commit `1b7ab4e`, `windows-latest`) built the
installer, the portable executable, the build manifest and `dist/SHA256SUMS.txt`, and passed
artifact verification, package validation and the unpacked GUI smoke test. GitHub's REST API reports
these artifacts for that run, and this section was written from its answer, not from memory:

| Artifact | Size (bytes) | GitHub's archive digest | What it is |
| --- | --- | --- | --- |
| `veridex-windows` | 235,014,547 | `sha256:19020f6286012426288cac10d5c9f6dc62792a9fa7e0043d02c06b309f81fe62` | the zip containing the NSIS installer, the portable executable, the build manifest and `SHA256SUMS.txt` |
| `veridex-gui-evidence` | 3,821,895 | `sha256:bd2e0c188f58296263371d74da2b607bcab928189bca201cc9702f798ec286af` | the GUI harness report and screenshots |
| `test-results-windows-latest` | 35,702 | `sha256:32a8d1924eb68942274c8c2fb7990550c90a68b1b40338802699527e24501793` | the Windows test run |
| `test-results-ubuntu-latest` | 34,892 | `sha256:986545f914e2f059361952bcb924c52724b3e00668fbff9907e42bd074c73529` | the Linux test run |

### The two executables, hashed by the job that built them

GitHub's artifact digest covers the archive. The executables inside it have their own hashes, and
the packaging job computes them with `Get-FileHash` and prints them into the checks API, which is
reachable from here. Two builds, both read back through the API, both from the same source tree:

| Build | `VERIDEX-Setup-1.0.0-x64.exe` | `VERIDEX-1.0.0-portable-x64.exe` |
| --- | --- | --- |
| commit `4e1ffc3`, package job 127835905991 | 117.5 MiB · `41b4b524f727e59b162563abc5082e08c80416e824cf56b15f47a8307720953c` | 106.6 MiB · `283650eed786b53e66c184e88f4813e796571133352380f37cb5a1c832cae4d8` |
| commit `2b71668` (the merge to `main`), package job 127841241342 | 117.5 MiB · `870e5b8b222576c1c74772f799bbcfcd132d682e1d104b7f3919cf975280b2c6` | 106.6 MiB · `ae0980e76e9fc377d6b6bc9463d4fb4fcfd159900df3e7618ccfbf18134e78b5` |

Two hashes for two builds of the same source is the point, not an error: an unsigned
electron-builder output is not reproducible, so **every build has its own SHA-256**. Read the
sizes as the job reported them (one decimal place, in MiB); the exact byte counts are in the
`SHA256SUMS.txt` and `BUILD-MANIFEST.txt` inside the artifact, which is what a person downloads.

**What this does and does not establish.** The values above were computed by the packaging job
from the exact files it built, and were read back through the authenticated API rather than
transcribed from memory or invented — that is the same provenance as any CI-produced checksum.
They are **not** hashes of the artifact that the release workflow will attach, because that
workflow builds again from whatever commit it is dispatched on and attaches its own
`SHA256SUMS.txt` beside the binaries. At release time the authoritative file is the one in the
release itself; a person downloads the installer, hashes it, and compares with the attached file.
An owner who wants the release hashes in *this* document copies them from that run.

The same API response carries the smoke results for the merged tree: `install-smoke: 18 check(s)
passed · 0 problem(s)` and `portable-smoke: 10 check(s) passed · 0 problem(s)`, with the installed
build rendering all 18 pages, exposing 44 invoke channels, and the startup log quoting the window
placement decision (`window opened at 1024x720 at 0,0 under the pointer, inside "HyperVMonitor" at
100 % (1024x720 work area)`).

**Those digests are GitHub's SHA-256 of the artifact _archives_, not of the executables inside
them.** They prove the archive that holds the build, and they would let you confirm a download is
the one CI produced — they are *not* `VERIDEX-Setup-1.0.0-x64.exe`'s hash, and quoting them as if
they were would be exactly the kind of quiet substitution this document exists to prevent. The
installer and portable hashes are **not recorded here**, because the bytes could not be fetched
into the environment that wrote this file:

```
$ gh run download 42198220081 -R skcpmx-lang/merqo-veridex -D dist-ci
error downloading test-results-windows-latest: Get "https://productionresultssa18.blob.core.windows.net/...": EOF
```

GitHub serves artifact payloads from `*.blob.core.windows.net`; this environment reaches
`api.github.com` (which is why the table above exists) but not that host, so every download ends
in `EOF` after the redirect. No authentication was bypassed, no URL was invented, and nothing was
written into the hash table that nobody computed.

### How to fetch them and fill in the hashes (owner)

Either path works; the first needs a browser and no token.

**Through the web UI**

1. Open <https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42198220081>.
2. Scroll to **Artifacts** and download `veridex-windows` (235,014,547 bytes).
3. Confirm the downloaded zip's own SHA-256 is `19020f62…fe62` before opening it:
   - Windows: `Get-FileHash .\veridex-windows.zip -Algorithm SHA256`
   - macOS/Linux: `shasum -a 256 veridex-windows.zip`

**Through the CLI (needs `gh auth login` on a machine with unrestricted network access)**

```bash
gh run download 42198220081 -R skcpmx-lang/merqo-veridex -n veridex-windows -D dist-ci
cd dist-ci
sha256sum VERIDEX-Setup-1.0.0-x64.exe VERIDEX-1.0.0-portable-x64.exe   # or Get-FileHash on Windows
cat SHA256SUMS.txt                                                    # CI's own record, compare it
cat build-manifest.json                                               # commit, version, sizes, runner
```

Then replace the two historical rows in the table above with the values from
`SHA256SUMS.txt`, keeping the commit id and run id beside them, and cross-check them against the
hashes you computed yourself — if the two disagree, the artifact is not the one CI published and
must not be released. `scripts/verify-artifacts.mjs` enforces the same rule in CI: each entry in
`SHA256SUMS.txt` must match the file it names.

**What to do with the result.** When the two hashes and the two file sizes are in this document,
with the commit they were built from, §1 is complete for this tree. Nothing else in this document
can be completed without a physical machine — see §2 and §7.

---

## What has been established, and what has not

**Established** (Windows Server 2025 runner, `windows-latest`, CI run 42160034210):

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `VERIDEX-Setup-1.0.0-x64.exe` | 117.5 MiB | `e6d0fdd88c6e9c78d2543e321b9b6c63fa63d2e407454c1343dd5d2ffa5ecec2` |
| `VERIDEX-1.0.0-portable-x64.exe` | 106.5 MiB | `40d6a0db33414c3be914fb068c31048136c95394ca75acabad25bd43de14b487` |

- the GUI harness drove the real window through 19 steps with 0 warnings and 0 problems;
- these hashes belong to the build from that run. Any later commit produces a different binary:
  when publishing, take the SHA-256 from the run that produced the artifact you are publishing,
  not from this table;
- the full test suite passes on Windows as well as Linux (881 tests at the time of writing);
- electron-builder produced both targets without error;
- the artifacts carry valid PE headers and plausible sizes;
- the digests were recomputed and match, so the files are the files that were built;
- both executables are unsigned, as expected and as stated in the release notes;
- a build manifest with these facts is published beside the artifacts;
- **the unpacked build launched and was driven through its whole interface**: 13 steps, no
  problems — boot, a visible window, the shipped `webPreferences`, a scan through the
  interface, the rendered result, all 18 pages **of that build**, history, live monitoring, a settings round
  trip, JSON/HTML/PDF reports at real sizes (41 kB / 46 kB / 24 kB), cancellation, clean exit;
- **the portable executable launched** from its extraction directory and reported a working
  interface: 10 checks, no problems, 15 seconds end to end;
**Established for the current tree** (same runner, CI run
[42198220081](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42198220081), source
commit `1b7ab4e`): the installer and portable were built; artifact verification and package
validation passed; the unpacked build was driven through the GUI smoke test; the portable
executable launched from its extraction directory; and the installer installed silently,
launched the installed application and uninstalled it. The *hashes* above are still the ones
from the earlier run, because these bytes could not be fetched — see the section below for what
that means and how to close it.

- **the installer installed**: silently, per-user, into `%LOCALAPPDATA%\Programs\VERIDEX`,
  with an uninstaller and both shortcuts; **the installed application then launched and
  worked** — title, preload bridge with 44 invoke channels, a real `app:info` call, and all
  18 pages rendered from inside the installed build — and **the uninstaller removed it**; 17 checks
  (this count moves between 17 and 18 with what the runner allows),
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
  PC. Packaged builds *have* executed since: the unpacked build, the portable executable and
  the installed build each launch and render all 18 pages on the Windows runner (§7). What
  has not happened is a packaged build running on hardware somebody owns.
- **DPI scaling and multi-monitor behaviour on hardware that has both.** The window now opens
  inside the work area of the display under the pointer (`src/app/window-placement.js`), and the
  evidence runner asserts it — but that runner has one 1024x700 display at 100 %. A 125 % or
  150 % panel, a second monitor with a negative origin, and a monitor unplugged mid-session are
  covered by unit tests and have never been observed by a person.
- the artifact could not be downloaded in the environment where this document was written
  (GitHub serves artifacts from blob storage, outside the allowlist), so the binary has not
  been inspected locally either — only its recorded metadata.

§1 and the **VM** boxes in §2 and §7 are done. Everything else needs a person at a physical
machine, and nothing in this document becomes **L4** evidence until that happens.

---

## 1. Build — performed by CI on windows-latest

- [x] `npm ci` completes from a clean checkout
- [x] `npm test` passes with zero failures (881 tests, both platforms)
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
- [x] **VM** The preload bridge loads: 44 invoke channels, event subscription present
- [x] **VM** All 18 pages render from inside the asar (recorded before Activity log, export
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
