# Physical verification — the L4 run sheet

This is the paperwork for the one thing no automated test in this repository can do: run
VERIDEX on a **physical Windows PC** and record what it actually reported. Everything else is
already covered — the suite, the Windows runner, the GUI smoke test, and the installer
lifecycle. This sheet is what stands between the project and its first L4 evidence.

Two rules, both learned the hard way:

1. **Record what happened, including what did not.** A field marked *Unavailable* with a
   reason is a pass. A field quietly filled in is a failure of the test.
2. **Do not tick a box because the code looks right.** Every box here is a claim about a
   machine, and the machine is the only authority.

Machine under test:

| | |
| --- | --- |
| Manufacturer / model | |
| CPU | |
| RAM | |
| Storage (model, bus) | |
| GPU(s) | |
| Battery (or none) | |
| Windows edition, build | |
| Session (standard user / administrator) | |
| Display, scaling | |
| Date, tester | |

Artifacts — record the digest of the exact files used, not the version string:

| | |
| --- | --- |
| Installer sha256 | |
| Portable sha256 | |
| Where they came from | |

---

## 1. Install, as a person

- [ ] Double-click the installer. SmartScreen warns — **write down the exact wording**, and
      the exact button you pressed
- [ ] The licence page is shown and matches `LICENSE`
- [ ] As a standard user, **no administrator prompt appears**
- [ ] The directory page allows a different location; install to the default
- [ ] The progress bar completes without an error dialog
- [ ] The start-menu shortcut appears and launches the application
- [ ] The desktop shortcut appears (if chosen)
- [ ] **Screenshot**: Settings ▸ Apps ▸ Installed apps showing the entry

## 2. First launch, as a person

- [ ] The window appears **quickly** — record the time from click to painted window
- [ ] No white flash, no unstyled flash, no blank frame
- [ ] The window is a sensible size and does not open over the taskbar
- [ ] The dashboard shows **Unrated** and no invented numbers
- [ ] The header says the application is local and read-only
- [ ] Text is legible at the machine's own DPI scaling — record the scaling
- [ ] Resize the window; nothing overlaps or clips
- [ ] **Screenshot**: dashboard before any scan

## 3. A standard-user scan — all 20 tasks

Run the full diagnostic and record each task's terminal state. This is the sweep the GUI
smoke test deliberately bounds to three tasks; a person with time must run all twenty.

| # | Task | State | Notable fields, and anything unavailable with its reason |
| --- | --- | --- | --- |
| 1 | `system.identity` | | |
| 2 | `cpu.info` | | |
| 3 | `memory.info` | | |
| 4 | `motherboard.info` | | |
| 5 | `gpu.info` | | |
| 6 | `gpu.directx` | | |
| 7 | `storage.inventory` | | |
| 8 | `storage.health` | | |
| 9 | `battery.info` | | |
| 10 | `network.info` | | |
| 11 | `drivers.inventory` | | |
| 12 | `drivers.export` | | |
| 13 | `windows.info` | | |
| 14 | `windows.inventory` | | |
| 15 | `windows.componentHealth` | | |
| 16 | `windows.events` | | |
| 17 | `software.installed` | | |
| 18 | `software.startup` | | |
| 19 | `processes.snapshot` | | |
| 20 | `security.posture` | | |

- [ ] Every task reached a terminal state; none was left spinning
- [ ] The whole sweep finished — record the wall-clock time
- [ ] Fields that required elevation read **Permission required**, not **Unavailable**
- [ ] **Record the coverage percentage and the score shown beside it.** If the score is 84,
      the coverage gate is doing its job; if coverage is above 80 % and the score is 84, the
      machine genuinely scored 84 and that is a different finding
- [ ] The reason for a capped or withheld score is visible on the dashboard, not only in a log

## 4. Battery, storage and GPU — the things a VM cannot have

- [ ] If the machine has a battery: design capacity, full charge capacity, health percentage
      and cycle count are present and match what Windows reports in `powercfg /batteryreport`
- [ ] If it has no battery: the battery is reported **Not applicable**, not broken
- [ ] If the SSD exposes SMART: temperature, wear and spare capacity are present and plausible
- [ ] If SMART is unavailable through the controller: the field says so, with the reason, and
      the storage component is **Unrated** rather than assumed healthy
- [ ] The GPU is identified by its real model, with its driver version
- [ ] **Screenshot**: the storage and battery pages

## 5. Elevated scan

- [ ] Run the application as administrator
- [ ] Record which additional fields became available (driver store, TPM, servicing, storage)
- [ ] Coverage rises, and the score changes **only because coverage rose** — compare the two
      coverage figures and the two scores
- [ ] No file outside the report directory was written; no system setting changed
      (compare `Get-ChildItem` of the data directory before and after)

## 6. Reports on real data

- [ ] Generate JSON, HTML, PDF and CSV from the real scan
- [ ] The PDF opens, is legible, and pages number correctly
- [ ] The HTML opens **offline** with all styling — disconnect the network first
- [ ] The JSON parses, and its redaction policy is what was chosen
- [ ] With redaction **on**, search the saved files for the serial number, the MAC address,
      the hostname and the account name. None may appear
- [ ] **Attach the four files to the verification record**

## 7. Security, on a real machine

- [ ] With the network monitor running, a full scan makes **no outbound connection** and no
      DNS query
- [ ] DevTools is not reachable in the packaged build
- [ ] A second launch focuses the existing window instead of starting a second copy
- [ ] Closing the window leaves **no** VERIDEX process behind (check Task Manager)
- [ ] Each consent-gated operation prompts, and refusing it leaves the report honest

## 8. Uninstall, as a person

- [ ] Settings ▸ Apps ▸ Uninstall runs the uninstaller without an administrator prompt
- [ ] The uninstaller completes without an error dialog
- [ ] The program directory is gone, and the shortcuts are gone
- [ ] **Saved reports and settings are still there** (`deleteAppDataOnUninstall` is false)
- [ ] A portable copy still runs from a USB stick on this machine

## 9. Portable build, on this machine

- [ ] Copy the portable executable to a USB stick and run it from there
- [ ] It starts, shows the same interface, and completes a scan
- [ ] Nothing was installed; nothing was left in `Program Files`

---

## Recording the result

When every box is either ticked or explicitly recorded as failed, update:

- `docs/HARDWARE_COMPATIBILITY.md` — the evidence level for each subsystem touched
- `docs/RELEASE_VERIFICATION.md` — the checklist, with this machine named
- `docs/REQUIREMENTS.md` — only the requirements this machine proved, with the date

**A requirement becomes VERIFIED only when this sheet has been completed on a machine that
is not a virtual machine, and the evidence — screenshots, report files, digests — is attached
to the record.** Until then, everything above is a plan, and the project's honest position is
the one already written in `docs/PROJECT_STATUS.md`: built, installed and driven on a virtual
machine, never seen by a person on hardware they own.
