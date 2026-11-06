# Compatibility

What VERIDEX runs on, what it has been run on, and the difference between the two.

---

## 1. The short version

| | Supported | Actually verified |
| --- | --- | --- |
| Windows 11 x64 | Intended | **No** |
| Windows 10 x64 (1903+) | Intended | **No** |
| Windows on ARM | Not supported | — |
| 32-bit Windows | Not supported | — |
| Windows Server | Not supported | — |
| Linux / macOS | Does not apply | — |

**No build of VERIDEX has been executed on any Windows machine.** Everything marked
"intended" is a statement about the interfaces the code calls, not a test result. See
`docs/TEST_STATUS.md` §4.

---

## 2. Why Windows-only

VERIDEX is built on interfaces that exist only on Windows:

| Interface | Used for |
| --- | --- |
| CIM/WMI (`Win32_*` classes) | processor, memory, storage, battery, GPU, network, board, BIOS |
| `powercfg` | battery design capacity and charge history |
| `pnputil` | driver store enumeration and export |
| `dxdiag` | DirectX version and display memory |
| `Get-WindowsOptionalFeature`, `Get-Service` | Windows servicing inventory |
| ATA SMART / NVMe health log | storage health |
| Registry | installed software, OS edition |

There is no portable abstraction layer over these, because the underlying data has no
equivalent elsewhere. `Get-WindowsOptionalFeature` is not a Windows-shaped version of
something on Linux; it is a Windows concept.

On any non-Windows platform every provider returns `UNSUPPORTED` with that reason. This is
tested: a scan on Linux completes with 21 tasks, 34 provider attempts and **zero errors**,
because "not Windows" is an answer, not a failure.

---

## 3. Architecture support

- **x64** is the only target. `electron-builder.config.mjs` builds `nsis` and `portable`
  for `x64` only.
- **ARM64** is not supported. Several providers shell out to Windows tools whose ARM64
  behaviour is untested; shipping an ARM64 build would be a claim nobody has checked.
- **32-bit** is not supported. Modern Windows 10/11 is 64-bit, and a 32-bit build would
  misreport memory above 4 GB for reasons that have nothing to do with the hardware.

---

## 4. Windows build constraints

These are the constraints the code assumes. They are *documented intent*, not verified
behaviour:

| Constraint | Consequence if unmet |
| --- | --- |
| Windows 10 1903 or later | `powercfg /batteryreport` output format differs on older builds; the parser would report `ERROR` rather than guess |
| PowerShell 5.1 available | The servicing-inventory providers return `UNAVAILABLE` |
| WMI service running | CIM providers return `ERROR`; systeminformation fallbacks take over |
| .NET Framework 4.x | `Get-CimInstance` paths fail without it |

In every failure case the result is a stated status, not a crash and not an invented
value.

---

## 5. Firmware and hardware variance

The following depend on the machine, not on VERIDEX, and show up as `UNAVAILABLE`:

- **Temperature sensors.** Many laptops expose CPU temperature through ACPI; some expose
  nothing; some expose a constant value. Desktops frequently expose none at all.
- **Fan speed.** Most consumer boards do not publish fan RPM to the operating system.
- **Battery design capacity.** Some firmware does not report it, making wear percentage
  impossible to compute honestly.
- **TPM version.** Requires both elevation and a TPM that reports through the expected
  interface; some do not.
- **Secure Boot state.** Reported by most UEFI implementations; some legacy/CSM setups
  report nothing.
- **Per-module RAM detail** (manufacturer, part number, serial). Requires the SPD data to
  be exposed through `Win32_PhysicalMemory`; some boards expose only totals.

A machine that returns `UNAVAILABLE` for these is not broken and VERIDEX is not broken.
The interface can only see what the firmware is willing to say.

---

## 6. Virtual machines

VERIDEX runs in a VM and reports what the VM exposes:

- **CPU and memory** are usually accurate for the virtual hardware, not the host.
- **Storage health** is generally unavailable; virtual disks do not implement SMART.
- **Battery** is `NOT_APPLICABLE` (no battery present) — the correct answer.
- **GPU** is a virtual adapter; the vendor heuristic will typically report it as unknown
  rather than guess.
- **Thermal** is usually unavailable.

Scores from a VM describe the VM. They are not a statement about the host.

---

## 7. Vendor coverage

Vendor-specific detection (Dell, HP, Lenovo, ASUS, Acer, MSI, Surface, Samsung, Toshiba,
Gigabyte) is **not implemented**. Requirement R-16-01 is marked not started.

What exists instead is a vendor-agnostic path: CIM classes first, then
`systeminformation`, then a chipset heuristic that is labelled as a heuristic. This works
across vendors by not depending on any of them, at the cost of not surfacing
vendor-specific extras like a Dell service tag's meaning or a Lenovo battery's vendor
health block.

---

## 8. Dependencies

| Component | Requirement |
| --- | --- |
| Node.js (development and CI only) | `>=20.11.0` |
| Electron | `^45.2.3` (devDependency; bundled into the app) |
| `systeminformation` | `^5.33.19` |
| `pdfkit` | `^0.17.2` |

Node is not required on an end user's machine: it is bundled with the Electron build.

---

## 9. What would move a row from "intended" to "verified"

Running the packaged build on a real machine and recording, in
`docs/requirements.json`:

```json
"verifiedOn": {
  "machine": "e.g. ThinkPad T14 Gen 3, Windows 11 23H2",
  "date": "YYYY-MM-DD",
  "result": "what the scan reported, including every UNAVAILABLE"
}
```

That has not been done. Until it is, this document is a description of intent.
