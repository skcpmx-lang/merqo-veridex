# Hardware and platform compatibility — evidence record

This document records **what has actually been executed**, per platform and per subsystem.
It exists so that no compatibility claim in this project rests on intention.

The honest summary: **nothing has been executed on real Windows hardware.** Everything
below is either build-time evidence from a Windows CI runner or logic verified on Linux.

---

## 1. Evidence levels

Every subsystem is at one of four levels. They are not interchangeable.

| Level | Meaning |
| --- | --- |
| **L4 — Field-verified** | Executed on physical Windows 10/11 hardware; the result is recorded here with the machine and date |
| **L3 — Runner-executed** | The code path ran on a Windows CI runner (`windows-latest`), but not against real consumer hardware and not through the packaged application |
| **L2 — Logic-verified** | Parsers, scoring and wiring tested on Linux against recorded or simulated command output |
| **L1 — Implemented only** | Written, wired, not executed |

**No subsystem in VERIDEX is at L4.** The highest achieved is L3, and only for the build
and packaging path — a CI runner is a virtual machine with synthetic hardware, and the
packaged application was never launched on it.

---

## 2. Platform

| Platform | Built | Test suite run | Application launched |
| --- | --- | --- | --- |
| Windows Server 2022 x64 (`windows-latest`) | **Yes** — installer + portable | **Yes** — 423 tests pass | **No** |
| Ubuntu 24.04 x64 (`ubuntu-latest`) | n/a | **Yes** — 423 tests pass | **No** |
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
| Processor | CIM `Win32_Processor` | **L2** | Parser tested against recorded output. Never queried a real CPU. |
| CPU model decode | `cpu-model.js` tables | **L2** | Generations, sockets and unknown-name handling tested. Table not validated against current silicon. |
| Memory | CIM `Win32_PhysicalMemory`, systeminformation | **L2** | Mapping and slot logic tested. Per-module SPD fields never read from hardware. |
| Motherboard / BIOS | CIM `Win32_BaseBoard`, `Win32_BIOS` | **L2** | Parsing and privacy gating tested. |
| TPM / Secure Boot | CIM, `Get-Tpm` | **L1/L2** | Gating tested; the privileged read has never executed. |
| GPU | CIM `Win32_VideoController`, dxdiag, vendor heuristic | **L2** | VRAM sanity handling and heuristic labelling tested. |
| Display | CIM, EDID | **L1** | Implemented; no display has been enumerated. |
| Storage inventory | CIM `Win32_DiskDrive`, systeminformation | **L2** | Enumeration and media-type classification tested. |
| Storage health (SATA) | ATA SMART | **L2** | Attribute decoding tested against fixtures, including the vendor-specific 190/194 handling. Never read a real drive. |
| Storage health (NVMe) | NVMe health log | **L2** | Log-page decoding tested. |
| Battery | `powercfg /batteryreport`, systeminformation | **L2** | Wear arithmetic and the no-battery `NOT_APPLICABLE` path tested. |
| Thermal sensors | ACPI, systeminformation | **L1** | Implemented; no sensor has ever been read. |
| Fan speed | CIM `Win32_Fan` | **L1** | Implemented; almost never exposed on consumer boards. |
| Network adapters | CIM, systeminformation | **L2** | Adapter parsing and socket derivation tested. |
| Drivers | CIM, `pnputil` | **L2** | Inventory, problem codes and age assessment tested. |
| Windows servicing | `Get-WindowsOptionalFeature`, `Get-Service` | **L2** | Parsing tested; requires elevation and has never run. |
| Security posture | Defender, firewall, BitLocker, UAC | **L2** | Field mapping and honest unavailable paths tested. |
| Live monitoring | systeminformation sensors | **L2** | Sampler lifecycle tested with a fake runner; two real samples were taken on **Linux**, not Windows (CPU load 54.5 %, 12 sensors, the rest explained as unavailable). |
| Benchmarks | CPU, disk | **L2** | Scoring and the write-consent gate tested. Never benchmarked real hardware. |
| Stress guard | thermal/load limits | **L2** | Guard behaviour tested; never applied to real silicon. |
| UAC elevation | `detectPermissionState` | **L2** | Both probes and the fallback tested with stubs. **Never prompted for real.** |
| Read-only guard | `FORBIDDEN_COMMANDS` | **L2** | 16 destructive lines refused, 11 read-only permitted, tested. |
| Keyboard, mouse, touchpad, audio, microphone, camera, ports | — | **L1** | Requirement R-16-01 (vendor-agnostic detection) and the input-device modules are **not started**. The manual checklist covers some of this by asking the user to look. |
| Packaged application | Electron + NSIS | **L3** | Built on Windows; verified as a PE executable with a matching digest. **Never installed or launched.** |

---

## 4. Vendor coverage

No vendor has been tested. Requirement R-16-01 — vendor-agnostic detection across Dell, HP,
Lenovo, ASUS, Acer, MSI, Surface, Samsung, Toshiba and Gigabyte — is marked **not started**
in `docs/requirements.json` and this document does not claim otherwise.

The design avoids vendor dependence rather than validating it: CIM first, systeminformation
second, and a chipset heuristic that is labelled as a heuristic. That is a strategy for
working across vendors, not evidence that it works on any of them.

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
| Installer | `VERIDEX-Setup-1.0.0-x64.exe`, 117.4 MiB |
| Installer SHA-256 | `a8377850b828f769f0492071f59758d20d6763ac00e05d72e68ca67baf09c613` |
| Portable | `VERIDEX-1.0.0-portable-x64.exe`, 106.5 MiB |
| Portable SHA-256 | `fe7338dca1de85c164195606c0825f6b098341043cf546a58069c9b19d6b9335` |
| Built by | `.github/workflows/build.yml`, job "Windows package" |
| Signature | **None.** Unsigned; SmartScreen will warn. |

The digests let anyone confirm that a file they have is the file that was built. They say
nothing about whether it runs.
