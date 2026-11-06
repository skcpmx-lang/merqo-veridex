# Hardware and platform compatibility — evidence record

This document records **what has actually been executed**, per platform and per subsystem.
It exists so that no compatibility claim in this project rests on intention.

The honest summary: **both the diagnostic layer and the packaged application have now been
executed on Windows — and still never on real consumer hardware.** `npm run smoke:live`
exercises real WMI, PowerShell, registry and systeminformation calls on the runner, which
moves most subsystems from "never executed" to "runner-executed". Since the GUI, portable and
installer harnesses were added, the application itself is launched, driven and removed on that
runner too: installed silently, started from its installation directory, and uninstalled.
That is a real and useful step, and it is not the same thing as field-verified.

---

## 1. Evidence levels

Every subsystem is at one of four levels. They are not interchangeable.

| Level | Meaning |
| --- | --- |
| **L4 — Field-verified** | Executed on physical Windows 10/11 hardware; the result is recorded here with the machine and date |
| **L3 — Runner-executed** | The code path ran on a Windows CI runner (`windows-latest`), but not against real consumer hardware and not through the packaged application |
| **L2 — Logic-verified** | Parsers, scoring and wiring tested on Linux against recorded or simulated command output |
| **L1 — Implemented only** | Written, wired, not executed |

**No subsystem in VERIDEX is at L4.** The highest achieved is L3: the diagnostic layer runs
on a Windows runner against real Windows interfaces, and the packaging path now produces an
installer that installs, an installed application that launches and works, and an uninstaller
that removes it. A CI runner is still a virtual machine with synthetic hardware — no battery,
no SMART, no discrete GPU — and no person has ever looked at the window.

---

## 2. Platform

| Platform | Built | Test suite run | Application launched |
| --- | --- | --- | --- |
| Windows Server 2022 x64 (`windows-latest`) | **Yes** — installer + portable | **Yes** — 453 tests pass, plus a live smoke test against real WMI/PowerShell/registry | **No** |
| Ubuntu 24.04 x64 (`ubuntu-latest`) | n/a | **Yes** — 453 tests pass | **No** |
| Windows 10/11 consumer x64 | No | No | No |
| Windows on ARM64 | No | No | No |
| Wine on Linux | No (not installed; repositories unreachable) | No | No |

The Windows runner is a **Server** SKU with virtual hardware. Many diagnostic interfaces
behave differently there than on a consumer laptop: no battery, no consumer GPU driver, no
thermal sensors, no TPM in the expected form. Its value here is that the Electron toolchain,
the NSIS packager and the test suite all execute on real Windows — not that it says anything
about a real PC.

---

## 3. Subsystem status

| Subsystem | Interface | Level | What has and has not been shown |
| --- | --- | --- | --- |
| Processor | CIM `Win32_Processor` | **L3** | Queried a real Windows VM: the CIM call returns rows and the parse produces a model name. Synthetic vCPU, unknown silicon. |
| CPU model decode | `cpu-model.js` tables | **L2** | Generations, sockets and unknown-name handling tested. Table not validated against current silicon. |
| Memory | CIM `Win32_PhysicalMemory`, systeminformation | **L3** | Real module enumeration ran, and real totals were returned. A VM's SPD is synthetic; per-module fields on consumer DIMMs are still unproven. |
| Motherboard / BIOS | CIM `Win32_BaseBoard`, `Win32_BIOS` | **L3** | Real queries returned data on the runner (a virtual board). |
| TPM / Secure Boot | CIM, `Get-Tpm` | **L3** | The privileged read executed on the runner and reported honestly that the provider is unavailable there. |
| GPU | CIM `Win32_VideoController`, dxdiag, vendor heuristic | **L3** | Real adapter enumeration ran. `dxdiag` is present on the runner's image but cannot be executed there; that now reports `UNSUPPORTED` with the reason, not an error. |
| Display | CIM, EDID | **L1** | Implemented; no display has been enumerated. |
| Storage inventory | CIM `Win32_DiskDrive`, systeminformation | **L3** | Real disk enumeration ran on the runner. |
| Storage health (SATA) | ATA SMART, storage reliability counters | **L3** | The reliability-counter path executes on the runner; the ATA/NVMe `DeviceIoControl` paths need elevation and real disks, and a VM provides neither. |
| Storage health (NVMe) | NVMe health log | **L2** | Log-page decoding tested. |
| Battery | `powercfg /batteryreport`, systeminformation | **L3** | The no-battery path is now proven against a machine that genuinely has no battery: it reports `NOT_APPLICABLE`, not an error. Wear arithmetic on a real battery is still unproven. |
| Thermal sensors | ACPI, systeminformation | **L1** | Implemented; no sensor has ever been read. |
| Fan speed | CIM `Win32_Fan` | **L1** | Implemented; almost never exposed on consumer boards. |
| Network adapters | CIM, systeminformation | **L3** | Real adapter enumeration ran. |
| Drivers | CIM, `pnputil` | **L3** | Real driver inventory returned on the runner. |
| Windows servicing | `Get-WindowsOptionalFeature`, `Get-Service` | **L3** | Ran elevated on the runner. This provider was being killed by a 20 s budget it could not meet, and reported ERROR; the budget bug was found this way. |
| Security posture | Defender, firewall, BitLocker, UAC | **L3** | Ran elevated on the runner. BitLocker is unavailable on that image and now says so instead of reporting an error. |
| Live monitoring | systeminformation sensors | **L2** | Sampler lifecycle tested with a fake runner; two real samples were taken on **Linux**, not Windows (CPU load 54.5 %, 12 sensors, the rest explained as unavailable). |
| Benchmarks | CPU, disk | **L2** | Scoring and the write-consent gate tested. Never benchmarked real hardware. |
| Stress guard | thermal/load limits | **L2** | Guard behaviour tested; never applied to real silicon. |
| UAC elevation | `detectPermissionState` | **L3** | The elevation probe ran for real on the runner and correctly detected an elevated session. **The UAC prompt itself has still never appeared.** |
| Read-only guard | `FORBIDDEN_COMMANDS` | **L2** | 16 destructive lines refused, 11 read-only permitted, tested. |
| Keyboard, mouse, touchpad, audio, microphone, camera, ports | — | **L1** | Requirement R-16-01 (vendor-agnostic detection) and the input-device modules are **not started**. The manual checklist covers some of this by asking the user to look. |
| Packaged application | Electron + NSIS | **L3** | Built, installed, launched and uninstalled on the Windows runner (CI run 42160034210): 19 GUI steps, 17 install-lifecycle checks, 10 portable checks, no problems. **Never installed on physical hardware and never seen by a person.** |

---

## 4. Vendor coverage

No vendor has been tested. Requirement R-16-01 — vendor-agnostic detection across Dell, HP,
Lenovo, ASUS, Acer, MSI, Surface, Samsung, Toshiba and Gigabyte — is marked **not started**
in `docs/requirements.json` and this document does not claim otherwise.

The design avoids vendor dependence rather than validating it: CIM first, systeminformation
second, and a chipset heuristic that is labelled as a heuristic. That is a strategy for
working across vendors, not evidence that it works on any of them.

---

## 4a. The live smoke run

`npm run smoke:live` is the mechanism behind every L3 in the table above. On run
`42027223853` (Windows, elevated) it reported:

| Measure | Value |
| --- | --- |
| Fields produced | 1024 across 15 modules |
| PASS / WARNING | 718 / 63 |
| UNAVAILABLE / NOT_APPLICABLE / UNSUPPORTED | 235 / 4 / 4 |
| ERROR | 0 |
| Structural problems | 0 |
| Assessment | rated, 84, coverage 75 % — **this is the cap, not a measurement** (see §4b) |

Two things about that table matter more than the numbers. First, six earlier runs of the
same script found six defects that the test suite could not: a zero measurement that crashed
the memory task, a provider killed by a budget it had already set, `dxdiag` spawned under a
provider id, a PowerShell script that could not parse, a missing import in a branch CI never
executed, and a slow query that took a whole task down with it. Second, a *rated* score
on a virtual machine says nothing about a real PC — the hardware is synthetic, and the
devices a consumer machine exposes (a real battery, a real SSD with SMART attributes, a
discrete GPU) are exactly the ones this run did not see.

---

## 4b. Why the score was 84 at 75 % coverage

Asked directly, because a number that looks arbitrary is a number nobody can defend. The
answer is the coverage gate in `src/engine/health.js`, and it is working as designed:

| Coverage | What is published |
| --- | --- |
| below 50 % | **No number at all.** The assessment is `Unrated` with the reason. |
| 50 – 80 % | The raw average is computed, then **held at 84 ("Fair")**. |
| 80 % and above | The measured score is published as-is. |

On the runner, three of four weighted components could be assessed — CPU, memory and
storage — and the GPU could not, because the image has no discrete adapter and `dxdiag`
cannot run. That is 75 % coverage, so the raw average (100 on those three) was capped to 84.
The report and the interface both print the explanation beside the number: *"Coverage is
75%, so the score is capped at 84 (Fair) rather than reported as Good."*

Three properties make the number hard to misread, and all three are pinned by tests
(`tests/unit/health-cap.test.js`, 9 tests):

1. **The cap is a ceiling, not a floor.** A machine scoring 40 at 75 % coverage reports 40,
   unchanged. Only scores that would otherwise read as "Good" are held down.
2. **The cap stays below "Good".** `ratingFor(84)` is `Fair`. A capped score can never
   present as a healthy machine.
3. **The rating travels with its reason.** HTML, PDF, JSON and the dashboard each carry
   `gatingNote`; a score shown without its coverage would be a hard failure in the GUI smoke
   test, and is asserted here.

What this number is **not**: a statement about the machine. It is a statement about the
evidence collected, from a virtual machine with synthetic hardware, where the three devices
most likely to fail on a real PC — a battery, an SSD exposing SMART, a discrete GPU — were
all absent. On a physical machine with all four components readable, coverage would pass
80 % and the cap would not apply at all.

---

## 5. What would move a subsystem to L4

For each subsystem, in this order:

1. Install `VERIDEX-Setup-1.0.0-x64.exe` on a physical Windows 10 or 11 machine.
2. Launch it and confirm the dashboard renders with everything **Unrated**.
3. Run a scan as a standard user; record every field's status, including every
   `UNAVAILABLE`, `UNSUPPORTED` and `PERMISSION_REQUIRED`.
4. Run the same scan elevated; record what appeared.
5. Compare the two runs. The difference is the elevation surface, which is the thing this
   product claims to disclose honestly.
6. Record the machine, the Windows build and the date in `docs/requirements.json` as
   `verifiedOn` for each requirement actually observed.
7. Update this document with the real values.

Until steps 1–7 have happened for a subsystem, it stays at L2 or L3, and no requirement
touching it may be marked VER.

---

## 6. The artifact itself

| Fact | Value |
| --- | --- |
| Installer | `VERIDEX-Setup-1.0.0-x64.exe`, 117.5 MiB |
| Installer SHA-256 | `8650933234b3f4e22b3a8e2aabd2e48b2d2311d08cb8fd9573bfc528a848a0e9` |
| Portable | `VERIDEX-1.0.0-portable-x64.exe`, 106.5 MiB |
| Portable SHA-256 | `6da0e220dfec25651e5c9e143ef7fbddb8c744fade85965683a0a7e641a9ffa7` |
| Built by | `.github/workflows/build.yml`, job "Windows package" |
| Signature | **None.** Unsigned; SmartScreen will warn. |

The digests let anyone confirm that a file they have is the file that was built. They say
nothing about whether it runs.
