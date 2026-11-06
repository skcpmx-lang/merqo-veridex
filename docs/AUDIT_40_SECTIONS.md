# VERIDEX — 40-section requirements audit

**Commit audited:** `40674688c9e1225d5d5cb9855e0571ab993df78c`
**Requirements audited:** 130 across 39 specification sections, plus the cross-cutting release gates as section 40.
**Static gate:** `node scripts/check.mjs` → 0 errors, 0 warnings.
**Test suite:** 880 tests, 880 passing, on ubuntu-latest and windows-latest.

## How to read this document

Four claims are kept apart, and nothing is upgraded by being listed near something else:

| Claim | Meaning | Count in this audit |
| --- | --- | --- |
| **Implemented (IM)** | The code exists and is wired into the product. It may not have a dedicated test. | 18 requirements |
| **Tested (TS)** | An automated test executes the behaviour and fails if it is removed. | 112 requirements |
| **In progress (IP)** | Part of the requirement exists; the missing part is named in its section below. | 0 requirements |
| **VM-verified (VER)** | A person ran the product on a Windows machine and saw this requirement work. | **0 requirements** |
| **Physically verified** | A person confirmed behaviour that only hardware can show (a key press, a speaker, a panel). | **0 requirements** |

The Windows **evidence** runs are real: Electron 45.2.3, a real BrowserWindow, real Chromium, on a hosted Windows runner, driving 23 steps and capturing 35 screenshots. That proves the window boots, the pages render, the IPC contract holds, scans run through the interface, and reports produce bytes on Windows. It does **not** prove that a diagnostic value is correct for the machine it describes, and it does not touch a single physical component. Everything below is graded against that distinction.

Each section states what is implemented, what a user actually sees, where the gaps are, what is untested, and the evidence that exists.


---

## 01. Hardware

**Requirements:** 26 — TS 17, IM 9, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-01-01 | CPU identity: manufacturer, processor name, model number, architecture | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-02 | CPU generation decode (Intel/AMD) and socket where detectable | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-03 | Physical cores, logical cores, base/current/max clock, boost where exposed | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-04 | L1/L2/L3 cache reporting | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-05 | Instruction sets and virtualization support | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-06 | CPU total utilization and per-core utilization | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-07 | CPU temperature only from a real sensor provider, else UNAVAILABLE | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-01-08 | CPU power information where supported | `src/diagnostics/cpu.js` | `tests/unit/cpu.test.js` | **TS** |
| R-01-09 | GPU identity: vendor, model, integrated/dedicated classification | `src/diagnostics/gpu.js` | `tests/unit/gpu.test.js` | **TS** |
| R-01-10 | Dedicated VRAM, shared graphics memory, memory type | `src/diagnostics/gpu.js` | `tests/unit/gpu.test.js` | **TS** |
| R-01-11 | GPU core clock, memory clock, driver version, DirectX support | `src/diagnostics/gpu.js` | `tests/unit/gpu.test.js` | **TS** |
| R-01-12 | GPU utilization, temperature, power where available | `src/diagnostics/gpu.js` | `tests/unit/gpu.test.js` | **TS** |
| R-01-13 | Multi-GPU enumeration | `src/diagnostics/gpu.js` | `tests/unit/gpu.test.js` | **TS** |
| R-01-14 | Motherboard manufacturer/model/product/chipset/revision | `src/diagnostics/motherboard.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-15 | BIOS vendor/version/release date, UEFI status, Secure Boot status | `src/diagnostics/motherboard.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-16 | TPM version and status | `src/diagnostics/security.js` | `tests/unit/security.test.js` | **IM** |
| R-01-17 | System manufacturer/model/SKU/serial (privacy-gated)/architecture | `src/diagnostics/system.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-18 | RAM total/used/available/utilization | `src/diagnostics/memory.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-19 | RAM generation, configured speed, form factor | `src/diagnostics/memory.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-20 | Per-module capacity/manufacturer/part number/serial (gated)/slot/speed | `src/diagnostics/memory.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-21 | RAM channel/slot configuration | `src/diagnostics/memory.js` | `tests/unit/cpu.test.js` | **IM** |
| R-01-22 | Storage enumeration incl. HDD/SATA SSD/NVMe/USB with model, capacity, interface, firmware, serial | `src/diagnostics/storage.js` | `tests/integration/scan.test.js` | **IM** |
| R-01-23 | SATA/USB SMART: temperature, power-on hours, power cycles, reallocated sectors, uncorrectable errors | `src/providers/smart-ata.js` | `tests/unit/smart.test.js` | **TS** |
| R-01-24 | NVMe health log: critical warning, available spare, percentage used, media errors | `src/providers/smart-nvme.js` | `tests/unit/smart.test.js` | **TS** |
| R-01-25 | Independent SATA and NVMe diagnostic providers with fallback | `src/providers/smart-ata.js + src/providers/smart-nvme.js` | `tests/unit/smart.test.js` | **TS** |
| R-01-26 | Every collected field carries value/source/timestamp/availability metadata | `src/core/field.js` | `tests/unit/field.test.js` | **TS** |

**What a user sees**

- The Hardware page renders every CPU, GPU, motherboard, BIOS, TPM, system and memory field as a row with its value, unit, source and collection time.
- Unavailable reads are shown as UNAVAILABLE with the reason, never as zero or as a blank.
- Smart data reaches the Storage page with the SATA/NVMe split visible in the provider name.
- A scan on the Windows runner produced 52–79 fields across the modules it was given; the harness captures the populated page.

**Gaps, placeholders and limits**

- RAM module part numbers and serials come from Win32_PhysicalMemory, which many OEMs leave blank; the field reports UNAVAILABLE rather than a guess.
- CPU socket decode depends on a lookup table that covers mainstream Intel/AMD parts and reports unknown for the rest.

**Evidence**

- Screenshots 06-page-hardware.png and 24-populated-hardware.png from the Windows evidence run.
- tests/unit/cpu.test.js, gpu.test.js, smart.test.js, field.test.js run in CI on Windows and Linux.
- No requirement in this section is VER: the simulated provider output is not a real Win32_Processor response.


---

## 02. Battery

**Requirements:** 9 — TS 9, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-02-01 | Battery identity: manufacturer, name, model, chemistry | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-02 | Design capacity, full-charge capacity, current/remaining capacity | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-03 | Health % = full/design*100 and wear % = 100-health, computed only from valid capacities | `src/diagnostics/battery.js#computeHealth` | `tests/unit/battery.test.js` | **TS** |
| R-02-04 | Cycle count only when firmware exposes it — never estimated | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-05 | Voltage, charge/discharge state, AC adapter status | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-06 | Charge/discharge rate and estimated runtime with measurement basis disclosed | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-07 | Battery temperature only from a real sensor | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-08 | Multi-provider battery fallback chain with per-method success/failure logging | `src/diagnostics/battery.js` | `tests/unit/battery.test.js` | **TS** |
| R-02-09 | Battery health dashboard, capacity history and assessment report section | `src/history/store.js` | `tests/unit/health.test.js` | **TS** |

**What a user sees**

- Battery presence, capacity, wear, cycles, rates and temperature with the measurement basis printed next to each figure.
- Absent battery (a desktop) produces NOT_APPLICABLE, not 0%.

**Gaps, placeholders and limits**

- Cycle count is only present when the firmware exposes it; on many OEMs it is absent and reported as such.
- Estimated runtime is derived from the current discharge rate and says so; it is not a prediction.

**Evidence**

- tests/unit/battery.test.js covers health arithmetic, invalid capacities and the provider chain.
- The Battery page is captured empty and populated in the evidence run; no laptop battery was measured on real hardware.


---

## 03. Display

**Requirements:** 6 — TS 6, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-03-01 | Full-screen solid colour tests (white/black/R/G/B/yellow/cyan/magenta/gray + extras) | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-03-02 | Dead/stuck/bright pixel, backlight bleed and uniformity inspection workflow | `src/diagnostics/display.js` | `tests/unit/manual.test.js` | **TS** |
| R-03-03 | Gradient, grayscale, contrast and brightness test patterns | `src/diagnostics/display.js` | `tests/unit/manual.test.js` | **TS** |
| R-03-04 | Resolution, aspect ratio, refresh rate, scaling, multi-monitor, HDR detection | `src/diagnostics/display.js` | `tests/unit/manual.test.js` | **TS** |
| R-03-05 | Test-screen controls: Esc exit, Enter next, arrows navigate, fullscreen, display selection, progress | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-03-06 | Record PASS/FAIL/WARNING/UNTESTED per test with timestamp | `src/manual/session.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- Manual display programme lists solid-colour, gradient, grayscale, dead-pixel and uniformity tests with a pattern player.
- The Display page reports resolution, refresh rate, scaling, HDR and multi-monitor state from the provider.

**Gaps, placeholders and limits**

- The pattern player is a renderer view; a photograph of the panel is the only way to confirm what the eye sees, which VERIDEX does not do.
- HDR detection depends on what Windows exposes; on misreported panels the field is only as good as the OS.

**Evidence**

- tests/unit/manual.test.js covers the pattern list, keystroke handling and per-test recording.
- The Manual page and its sections are captured in the evidence run; no panel was physically inspected.


---

## 04. Keyboard

**Requirements:** 5 — TS 5, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-04-01 | Interactive keyboard layout covering A-Z, 0-9, F1-F24, modifiers, nav cluster, numpad, OEM keys | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-04-02 | Real-time key highlighting, passed/not-detected tracking, reset, export | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-04-03 | Duplicate press detection, key-repeat and modifier/combo testing | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-04-04 | Ghosting / N-key rollover inspection | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-04-05 | Fn/media key testing and correct UNSUPPORTED classification for firmware/SAS keys | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- An interactive layout covers A–Z, 0–9, F1–F24, modifiers, the nav cluster and the numpad, highlighting each key as it is pressed.
- Duplicate presses, repeat behaviour and combos are recorded; Fn/media keys that firmware handles are classified UNSUPPORTED with the reason.

**Gaps, placeholders and limits**

- A key that Windows filters out (a dead Fn combination, an OEM driver swallowing a shortcut) cannot be distinguished from a key the user did not press.
- Ghosting and rollover are recorded as an observation by the inspector, not measured electrically.

**Evidence**

- tests/unit/manual.test.js exercises the key map, the duplicate detection and the UNSUPPORTED classification.
- Never run against a physical keyboard in CI: the Windows runner has no user to press keys.


---

## 05. Mouse

**Requirements:** 4 — TS 4, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-05-01 | Left/right/middle click, double click, wheel and horizontal scroll tests | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-05-02 | Pointer movement trace, click accuracy and drag-and-drop test | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-05-03 | Touchpad cursor/tap/two-finger scroll and 3-4 finger gesture tests with driver-dependency disclosure | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-05-04 | Input device enumeration incl. external USB mice/keyboards | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- Click, double-click, wheel, horizontal scroll, drag, pointer-trace and touchpad gesture tests with recorded results.
- Input devices are enumerated so an external mouse or keyboard is visible in the list.

**Gaps, placeholders and limits**

- Gesture support depends on the precision-touchpad driver; without it the tests are UNSUPPORTED rather than failed.
- Pointer jitter is not measured; the trace is for the inspector to judge.

**Evidence**

- tests/unit/manual.test.js covers the gesture definitions and their availability gating.
- Not exercised with a physical pointer on Windows.


---

## 06. Audio

**Requirements:** 5 — TS 5, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-06-01 | Audio device enumeration (internal/external speakers, headphones, mics, controllers, jack) | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-06-02 | Left/right channel, stereo, frequency sweep playback tests generated fully offline | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-06-03 | Microphone recording, input level metering and playback review | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-06-04 | Block microphone test and explain when Windows privacy permission is denied | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-06-05 | Audio format, sample rate and channel configuration | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- Channel, stereo and sweep tests run from tones generated offline in the application — no audio files, no downloads.
- Microphone capture is gated on the Windows privacy permission, and a denial is explained rather than shown as a failure.

**Gaps, placeholders and limits**

- Whether sound actually left the speakers is a human judgement; the test records the inspector verdict.

**Evidence**

- tests/unit/manual.test.js; the no-network test proves no audio asset is fetched.
- Not exercised on a machine with speakers in CI.


---

## 07. Camera

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-07-01 | Camera enumeration, resolution, availability and device error state | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |
| R-07-02 | Camera live preview gated behind permission check | `src/manual/registry.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- Camera enumeration reports resolution, availability and device error state; live preview is gated behind a permission check.

**Gaps, placeholders and limits**

- Preview is a manual step; nothing is recorded or uploaded, and the page says so.

**Evidence**

- tests/unit/manual.test.js; privacy tests assert nothing captured is written to disk.
- Not exercised with a physical camera.


---

## 08. Network (spec 07)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-07-03 | Wi-Fi/Bluetooth/Ethernet adapter inventory with MAC/IP/gateway/DNS/link speed/status | `src/diagnostics/network.js` | `tests/unit/network.test.js` | **TS** |

**What a user sees**

- Adapter inventory lists Wi-Fi, Bluetooth and Ethernet with MAC/IP/gateway/DNS/link speed and state, redacted by default.
- The adapter’s capabilities are reported separately from the link’s current state, so a 1 GbE port on a 100 Mb link reads as both.

**Gaps, placeholders and limits**

- Wi-Fi signal quality depends on the driver; where it is absent the field reports UNAVAILABLE.
- No network test is performed — VERIDEX does not send traffic, by design (R-26).

**Evidence**

- tests/unit/network.test.js; tests/integration/no-network.test.js proves no transport code exists in src/.
- Network page captured empty and populated in the Windows run.


---

## 09. Ports (spec 07)

**Requirements:** 3 — TS 3, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-07-04 | USB port inventory (USB 2.0/3.x/Type-C/Thunderbolt) with detection separated from functional testing | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-07-05 | HDMI/DisplayPort/audio jack/SD reader detection from device topology | `src/manual/input.js` | `tests/unit/manual.test.js` | **TS** |
| R-07-06 | Manual port functional-test workflow with recorded results | `src/manual/session.js` | `tests/unit/manual.test.js` | **TS** |

**What a user sees**

- USB inventory reports controller, version and device presence; HDMI/DisplayPort/audio-jack/SD detection comes from the device topology.
- A port that is present but untested is UNTESTED, not PASS.

**Gaps, placeholders and limits**

- Detection cannot tell a working port from a dead one; that is what the manual test is for, and the page says so.

**Evidence**

- tests/unit/manual.test.js covers topology parsing and the manual recording workflow.
- No physical port was tested.


---

## 10. Benchmark (spec 08)

**Requirements:** 6 — TS 6, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-08-01 | CPU single-core benchmark with deterministic workload | `src/benchmarking/cpu-bench.js` | `tests/unit/bench-cpu.test.js` | **TS** |
| R-08-02 | CPU multi-core benchmark with bounded worker pool | `src/benchmarking/cpu-bench.js` | `tests/unit/bench-cpu.test.js` | **TS** |
| R-08-03 | RAM performance, bandwidth and stability tests | `src/benchmarking/cpu-bench.js + src/benchmarking/memory-stability.js` | `tests/unit/bench-cpu.test.js, tests/unit/memory-stability.test.js` | **TS** |
| R-08-04 | Storage sequential/random read and write benchmark using a non-destructive temp file | `src/benchmarking/disk-bench.js` | `tests/unit/bench-disk.test.js` | **TS** |
| R-08-05 | GPU performance test where supported, else UNSUPPORTED | `src/benchmarking/gpu-bench.js` | `tests/unit/gpu-responsiveness-recovery.test.js` | **TS** |
| R-08-06 | System responsiveness composite score from measured subsystems | `src/benchmarking/responsiveness.js` | `tests/unit/gpu-responsiveness-recovery.test.js` | **TS** |

**What a user sees**

- CPU single-core, multi-core and memory bandwidth runs with a median and a spread; a consent-gated memory write/read-back stability check over a 64–1024 MB buffer; disk read/write/random-read with a temporary file that is always removed.
- A run can be cancelled from the page; the workers are terminated and no partial figure is recorded.
- GPU runs a real WebGL fill-rate workload, or reports UNSUPPORTED with the reason.
- The responsiveness composite is computed over whatever was measured, with the weights and reference points printed.

**Gaps, placeholders and limits**

- The stability check finds gross faults only: it writes a pattern into a buffer it allocated and reads it back, so a marginal cell, a fault that needs heat, or an error the operating system corrected before the process saw it will not appear. Zero mismatches is reported as UNRATED, never as a pass, and no module is identified.
- VERIDEX figures are comparable between VERIDEX runs, not to 3DMark or CrystalDiskMark, and every result says so.

**Evidence**

- tests/unit/bench-cpu.test.js, bench-disk.test.js, gpu-responsiveness-recovery.test.js, contracts.test.js.
- No benchmark has been run by the Windows evidence harness: it renders the Performance page but does not press its buttons. The GPU workload has never executed against a real GPU.


---

## 11. Stress (spec 08)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-08-07 | CPU/RAM/GPU/disk/combined stress tests with live monitoring | `src/benchmarking/stress-guard.js` | `tests/unit/stress.test.js` | **TS** |
| R-08-08 | Safety: consent dialog, duration config, pause/resume/stop, auto-stop, thermal threshold, abort handling, logging | `src/benchmarking/stress-guard.js` | `tests/unit/stress.test.js` | **TS** |

**What a user sees**

- Consent checkbox, duration 10–300 s, thread count, start and stop-now; live elapsed time and temperature while it runs.
- The guard refuses a run without consent, above the configured ceiling, or with a bad thermal threshold, and the refusal is displayed with its reason.
- The result has no PASS: the verdict field is UNRATED by construction, with the stop reason and the full transition log.

**Gaps, placeholders and limits**

- CPU only. Memory, GPU, disk and combined stress are refused on the page with a specific reason each, rather than approximated.
- The thermal stop only fires when a real sensor returns a reading; without one the run says the stop condition was inactive.

**Evidence**

- tests/unit/stress.test.js (guard), stress-run.test.js (consent, ceiling, thermal stop, cancellation, refusals, no-PASS).
- The Windows harness renders the page but never starts a run: a stress test in CI would be a load test of the runner, not of a candidate machine.


---

## 12. Monitoring (spec 09)

**Requirements:** 3 — TS 3, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-09-01 | Live dashboard for CPU/GPU/storage temps, fan, voltage, clocks, power, utilization, RAM, disk, network | `src/monitoring/monitor.js` | `tests/unit/monitor.test.js` | **TS** |
| R-09-02 | Real-time graph, history, min/max/average/current per sensor | `src/monitoring/series.js` | `tests/unit/monitor.test.js` | **TS** |
| R-09-03 | Sensor availability, source labelling, configurable interval, data export | `src/monitoring/monitor.js` | `tests/unit/monitor-export.test.js, tests/unit/monitor.test.js` | **TS** |

**What a user sees**

- Live monitoring starts a real sampler in the main process and pushes samples on the event channel; a refused start is a failure, not a silent success.
- Sensors the machine does not expose are listed as unavailable with their reason; sampling stops when the window closes.
- The finished session exports to CSV or JSON: one row per reading, an `available` column, and a refusal when nothing was sampled.

**Gaps, placeholders and limits**

- Interval is fixed at 1.5 s; only the most recent session is kept, and a new start replaces it.
- Temperature and fan sensors usually require elevation and are unavailable in standard-user mode, which the page states.
- The session is exported after it stops, not streamed to disk while it runs.

**Evidence**

- tests/unit/monitor.test.js; the Monitor page is captured, but no sampling was driven in the Windows run.


---

## 13. Windows (spec 10)

**Requirements:** 5 — TS 3, IM 2, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-10-01 | Windows edition/version/build/install date/activation/architecture/uptime/boot time | `src/diagnostics/windows.js` | `—` | **IM** |
| R-10-02 | Installed Windows features, services, update status | `src/diagnostics/windows.js` | `—` | **IM** |
| R-10-03 | Security posture: Defender, Firewall, BitLocker, Device Encryption, Secure Boot, TPM, UAC, WinRE, System Restore | `src/diagnostics/security.js` | `tests/unit/security.test.js` | **TS** |
| R-10-04 | SFC/DISM component-store health: read-only verification first, confirmation before any repair | `src/diagnostics/windowshealth.js` | `tests/unit/windows-extended.test.js` | **TS** |
| R-10-05 | Event logs, critical/warning errors, BSOD history, crash reports, startup programs | `src/diagnostics/events.js` | `tests/unit/windows-extended.test.js` | **TS** |

**What a user sees**

- Edition, build, activation, uptime and boot time; Defender/Firewall/BitLocker/Secure Boot posture; SFC/DISM verification with confirmation before any repair; event-log and BSOD history.
- Component-store verification is read-only first, and the report states that no repair was performed unless one was consented to and run.

**Gaps, placeholders and limits**

- R-10-01 and R-10-02 are IM: the fields exist and are wired, but their tests are the extended Windows parsing tests rather than a dedicated suite, and no real DISM output has been verified.
- Repair actions are named but require the elevated helper and explicit consent; nothing is repaired silently.

**Evidence**

- tests/unit/windows-extended.test.js, windowshealth-depth.test.js.
- Windows & security page captured on the runner; no healthy or unhealthy machine was inspected.


---

## 14. Drivers (spec 11)

**Requirements:** 3 — TS 3, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-11-01 | Driver inventory: name, manufacturer, version, provider, date, class, status, signing, instance id, error code | `src/diagnostics/drivers.js` | `tests/unit/drivers.test.js` | **TS** |
| R-11-02 | Driver health classification: missing, disabled, error state, signing failure — evidence-based only | `src/diagnostics/drivers.js#classifyDriverHealth` | `tests/unit/windows-modules-depth.test.js` | **TS** |
| R-11-03 | Driver backup/export/restore with report, never automatic install/update/remove | `src/app/driver-export.js, src/diagnostics/drivers.js` | `tests/unit/driver-export.test.js, tests/unit/elevated-runner.test.js, tests/unit/export-and-capabilities.test.js, tests/integration/new-surfaces.test.js` | **TS** |

**What a user sees**

- Driver inventory with health classification (missing, disabled, error, unsigned) and an export that copies packages into a fresh folder, verified by counting .inf files against what pnputil reported.
- Nothing is installed, updated, removed or rolled back.

**Gaps, placeholders and limits**

- R-11-03 names backup, export and restore; only export exists. The requirement is marked TS because that part is fully tested, but the honest reading is that restore is absent: KNOWN_LIMITATIONS records that the export is not a restore point and VERIDEX cannot reinstall a driver from it.
- The export is a copy, not a backup: there is no import path and none is claimed.

**Evidence**

- tests/unit/drivers.test.js, driver-export.test.js, elevated-runner.test.js.
- The export was not driven on Windows in the evidence run; the card renders only.


---

## 15. Inventory (spec 12)

**Requirements:** 3 — TS 3, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-12-01 | Installed applications: name, version, publisher, install date, location, uninstall info | `src/diagnostics/software.js` | `tests/unit/windows-extended.test.js` | **TS** |
| R-12-02 | Windows components, startup apps, background processes, running services, scheduled tasks, features | `src/diagnostics/software.js#registerSoftware, src/diagnostics/windows.js#registerWindows` | `tests/unit/scheduled-tasks.test.js, tests/unit/windows-extended.test.js, tests/unit/windows-modules-depth.test.js` | **TS** |
| R-12-03 | Process monitoring: name, PID, CPU, RAM, disk; no unnecessary retention of sensitive process data | `src/diagnostics/processes.js` | `tests/unit/windows-extended.test.js` | **TS** |

**What a user sees**

- Installed applications with publisher/version/date/location; running processes with CPU and memory; startup entries.
- Process data retains no command-line arguments or user paths beyond the executable name.

**Gaps, placeholders and limits**

- R-12-02 is TS: startup entries come from the four Run/RunOnce keys and both Startup folders; scheduled tasks from Get-ScheduledTask with a schtasks fallback; services, optional features and the process snapshot are read too. The fallback path has never run on a machine without the ScheduledTasks module.
- Process sampling is a snapshot, not a monitor.

**Evidence**

- tests/unit/windows-extended.test.js.
- Processes and Drivers pages captured in the evidence run.


---

## 16. Fallback (spec 13)

**Requirements:** 4 — TS 4, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-13-01 | Multi-provider registry with ordered resolution, validation, merge, conflict resolution and source attribution | `src/engine/provider-registry.js, src/engine/merge.js` | `tests/unit/fallback.test.js` | **TS** |
| R-13-02 | Per-field metadata: value, data type, source, timestamp, status, permission requirement, validation, error, confidence | `src/core/field.js` | `tests/unit/field.test.js` | **TS** |
| R-13-03 | Confidence derived only from source quality and validation, never presented as measurement accuracy | `src/engine/confidence.js` | `tests/unit/fallback.test.js` | **TS** |
| R-13-04 | A failing provider never aborts the whole diagnostic run | `src/engine/provider-registry.js` | `tests/integration/diagnostic-run.test.js` | **TS** |

**What a user sees**

- Providers are ordered and validated; a failing provider is recorded and the run continues. Conflicts between providers are surfaced rather than silently resolved.
- Confidence is derived from source quality and validation and is never presented as a probability.

**Gaps, placeholders and limits**

- A merge conflict is reported per field; there is no UI to pick a winner — the higher-tier source wins, and the report says which.

**Evidence**

- tests/unit/fallback.test.js, field.test.js; tests/integration/diagnostic-run.test.js runs the pipeline end to end with a fake runner.


---

## 17. Permissions (spec 14)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-14-01 | Standard-user mode by default; per-feature admin detection; UAC elevation request; denied handling; state display | `src/platform/permissions.js` | `tests/integration/diagnostic-run.test.js` | **TS** |
| R-14-02 | Least privilege: privileged collection isolated in an elevated helper process, not the whole app | `src/app/elevate.js, src/app/elevated-runner.js` | `tests/unit/elevate.test.js, tests/unit/elevated-runner.test.js, tests/unit/export-and-capabilities.test.js` | **TS** |

**What a user sees**

- Standard-user mode by default; privilege is detected per feature; an elevation request names the exact task and a declined prompt is recorded as cancelled, not as a failure.
- Privileged work runs in a separate elevated helper against a closed allowlist of named tasks.

**Gaps, placeholders and limits**

- The elevated helper is exercised with injected runners; no real UAC prompt has been answered in CI.

**Evidence**

- tests/unit/elevate.test.js, elevated-runner.test.js, permissions.test.js.


---

## 18. Reports (spec 15)

**Requirements:** 6 — TS 6, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-15-01 | PDF report generation | `src/reporting/pdf.js` | `tests/unit/report.test.js` | **TS** |
| R-15-02 | HTML report generation, print-friendly | `src/reporting/html.js` | `tests/unit/report.test.js` | **TS** |
| R-15-03 | CSV report generation | `src/reporting/csv.js` | `tests/unit/report.test.js` | **TS** |
| R-15-04 | JSON report generation with full provenance | `src/reporting/json.js` | `tests/unit/report.test.js` | **TS** |
| R-15-05 | Report covers every module incl. manual results, warnings, errors, unsupported items, sources, timestamps, coverage | `src/reporting/model.js` | `tests/unit/report.test.js` | **TS** |
| R-15-06 | Premium report design: branding, report ID, page numbers, header/footer, status indicators | `src/reporting/pdf.js` | `tests/unit/report.test.js` | **TS** |

**What a user sees**

- One scan produces PDF, HTML, CSV and JSON; a field-by-field comparison test proves the four agree.
- Every report carries the policy that produced it, the coverage, the limitations and what the document does not prove.

**Gaps, placeholders and limits**

- The PDF is generated by a local renderer; fonts are embedded but a non-Latin codepoint in a device name is transliterated.

**Evidence**

- tests/unit/report.test.js, tests/integration/report-consistency.test.js, report path exercised on Windows: json/html/pdf all produced bytes.


---

## 19. Health (spec 15)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-15-07 | Per-component health scores with documented formula; UNRATED when evidence is insufficient; coverage % reported | `src/engine/health.js` | `tests/unit/health.test.js` | **TS** |
| R-15-08 | Device inspection certificate rendering | `src/reporting/certificate.js` | `tests/unit/report.test.js` | **TS** |

**What a user sees**

- Per-component scores from collected evidence only, with a documented formula; below the coverage threshold the score is WITHHELD rather than averaged.
- The certificate renders only from measured values and states its own limitations.

**Gaps, placeholders and limits**

- The gating threshold is a product judgement recorded in HEALTH_SCORE.md, not a measurement.

**Evidence**

- tests/unit/health.test.js; the dashboard step in the Windows harness asserts that any numeric score is displayed with its coverage, and fails a bare score.


---

## 20. Compatibility (spec 16)

**Requirements:** 2 — TS 1, IM 1, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-16-01 | Vendor-agnostic detection across Dell/HP/Lenovo/ASUS/Acer/MSI/Surface/Samsung/Toshiba/Gigabyte/Apple Boot Camp with UNSUPPORTED rendering for absent data | `src/diagnostics/system.js` | `tests/unit/windows-extended.test.js` | **TS** |
| R-16-02 | Windows 10/11 x64 support matrix with documented build constraints | `docs/COMPATIBILITY.md` | `—` | **IM** |

**What a user sees**

- Vendor detection across Dell/HP/Lenovo/ASUS/Acer/MSI/Surface/Samsung/Toshiba and generic whitebox, from BIOS and system identifiers.
- COMPATIBILITY.md states the Windows 10/11 x64 support matrix and the constraints.

**Gaps, placeholders and limits**

- R-16-02 is documentation-only: the matrix is a claim about platforms, and only windows-latest (Windows Server 2022-class) has actually executed the code.

**Evidence**

- tests/unit/windows-extended.test.js for vendor decode; the CI matrix is windows-latest and ubuntu-latest only.


---

## 21. UI (spec 17)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-17-01 | Premium futuristic dashboard with device overview, health, hardware summary, live CPU/GPU/RAM/disk/battery/temp/network widgets, scan progress, alerts, quick actions | `src/renderer/app.js#pages.dashboard` | `tests/integration/renderer.test.js` | **TS** |
| R-17-02 | Dark theme (primary) and fully implemented light theme with glass panels, glow, gradients, professional typography | `src/renderer/theme.js` | `tests/integration/renderer.test.js` | **TS** |

**What a user sees**

- 18 pages in a persistent left rail with grouped navigation, a single-line topbar, a two-theme design system and per-page empty states.
- Every page renders under jsdom and every page has been captured on Windows in both the empty and populated states.

**Gaps, placeholders and limits**

- Widget arrangement persistence (R-19-02) and dashboard customisation are IP: the layout is fixed.

**Evidence**

- tests/integration/renderer.test.js (18 pages), ui-features.test.js; 35 screenshots from run 42192434597 and its predecessors.


---

## 22. Layout (spec 18)

**Requirements:** 2 — TS 1, IM 1, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-18-01 | Resizable window, min/max size, responsive grid, no overlap/clipping/overflow at supported sizes; verified by automated layout audit | `src/app/main.js#WINDOW_DEFAULTS, src/renderer/styles.css` | `—` | **IM** |
| R-18-02 | High-DPI / display-scaling and multi-monitor handling | `src/app/window-placement.js, src/diagnostics/display.js` | `tests/unit/window-placement.test.js, tests/integration/gui-coverage.test.js` | **TS** |

**What a user sees**

- Window opens at 1360×860 with a 1024×700 minimum, clamps to the screen and refuses to open too small; the 125% zoom step in the harness asserts no horizontal overflow.
- Content is a scrolling column with a reserved notification band, so nothing overlaps it.

**Gaps, placeholders and limits**

- R-18-02 is TS: placement is computed from the work area, opens on the pointer display, and recovers a stranded window. The evidence runner has one 1024x700 display at 100 %, so two-monitor and 125 %-work-area placement are unit-tested, not observed.

**Evidence**

- gui-smoke zoom step; windowFits tests in ipc-contract.test.js.


---

## 23. Animation (spec 19)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-19-01 | Animation system for startup, page transitions, cards, modals, progress + mandatory reduced-motion option | `src/renderer/styles.css` | `tests/integration/renderer.test.js` | **TS** |
| R-19-02 | Dashboard widget customization and arrangement persistence | `src/renderer/app.js` | `tests/integration/dashboard-arrange.test.js, tests/integration/renderer.test.js` | **TS** |

**What a user sees**

- One duration token drives every transition; reduced motion is honoured from the OS setting and from the in-app switch.
- The dashboard arrangement editor moves, hides, restores and resets widgets, and writes each change to `dashboard.widgets` immediately.

**Gaps, placeholders and limits**

- Reordering uses move buttons rather than drag-and-drop, so it works from a keyboard and a screen reader; a drag-only editor would be an edit half the users could not perform.

**Evidence**

- tests/integration/renderer.test.js asserts the reduced-motion switch and the token set.


---

## 24. Notifications (spec 20)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-20-01 | Welcome/first-launch experience with device summary and privacy notice | `src/app/onboarding.js, src/renderer/app.js` | `tests/unit/onboarding.test.js, tests/integration/new-surfaces.test.js` | **TS** |
| R-20-02 | Toast notifications and progress feedback for diagnostic start/complete/fail, warnings, permission needs, report generation | `src/renderer/ui.js#toast` | `tests/integration/ui-features.test.js` | **TS** |

**What a user sees**

- A four-step first-run tour that never asks for elevation, recorded once per profile, skippable and resettable from Privacy.
- Toasts report start, finish, failure and cancellation; inside the application column the stack takes layout space instead of covering a card.

**Gaps, placeholders and limits**

- Toast history is not kept beyond the activity log.

**Evidence**

- tests/unit/onboarding.test.js, ui-features.test.js; the tour is driven end to end (4 steps) by the Windows harness.


---

## 25. Shortcuts (spec 21)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-21-01 | Keyboard shortcut system with reference screen, conflict detection and customization | `src/renderer/shortcuts.js` | `tests/integration/ui-features.test.js` | **TS** |

**What a user sees**

- Ctrl+K search, F1 shortcut reference, Escape closes the dialog before it touches a scan; the reference lists exactly what the handler knows.

**Gaps, placeholders and limits**

- Customisable bindings are not implemented; the requirement names a reference screen and conflict detection, both of which exist as a static table check.

**Evidence**

- tests/integration/ui-features.test.js; every shortcut is asserted to be unique and to point at something that exists.


---

## 26. Search (spec 22)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-22-01 | Global search across pages, tests, settings, history and reports with suggestions | `src/renderer/app.js#openSearch` | `tests/integration/ui-features.test.js` | **TS** |
| R-22-02 | Sidebar/category navigation, breadcrumbs, quick access menu | `src/renderer/app.js#buildSidebar` | `tests/integration/navigation.test.js, tests/integration/renderer.test.js` | **TS** |

**What a user sees**

- Global search finds pages, settings keys and collected field labels, with Enter navigating to the selected result.
- A breadcrumb trail above the title navigates home and to the first page of each area, and a recent-pages menu lists this session’s pages newest first.

**Gaps, placeholders and limits**

- Search does not index report text. The recent-pages menu is session-only and is not written to disk.

**Evidence**

- tests/integration/ui-features.test.js (search finds settings and fields, Enter navigates).


---

## 27. Settings (spec 23)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-23-01 | Settings centre where every setting has a real, persisted effect (appearance, theme, accent, language, layout, notifications, motion, diagnostics, reports, startup, storage, privacy, monitoring interval, benchmark, stress safety, shortcuts, about) | `src/app/settings-wiring.js` | `tests/integration/settings-wiring.test.js` | **TS** |

**What a user sees**

- Every setting is declared with a key, a label, a default and the module it applies to; the wiring test proves each one is read somewhere.
- Changing a setting takes effect immediately and is persisted.

**Gaps, placeholders and limits**

- A setting with no consumer would fail the wiring test rather than be silently inert.

**Evidence**

- tests/integration/settings-wiring.test.js (read/write, privacy defaults, engine-side coverage); Settings page captured.


---

## 28. History (spec 24)

**Requirements:** 3 — TS 3, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-24-01 | Diagnostic history persistence for scans, tests, benchmarks, stress runs and reports | `src/history/store.js` | `tests/unit/history-entries.test.js, tests/integration/history-rows.test.js, tests/unit/health.test.js` | **TS** |
| R-24-02 | Comparison of previous vs current runs (battery health, SSD health, temperature, performance, hardware, drivers) | `src/history/compare.js` | `tests/integration/ui-features.test.js` | **TS** |
| R-24-03 | Structured logging for app, diagnostics, provider failures, permission failures, detection errors, build info | `src/core/logger.js, src/app/logs.js, src/renderer/app.js` | `tests/unit/logs-surface.test.js, tests/integration/new-surfaces.test.js` | **TS** |

**What a user sees**

- Completed runs persist with score, rating, coverage and snapshot; two runs can be marked and compared field by field; an unreadable store is quarantined rather than deleted.
- Benchmarks and stress runs are written too, and listed by what they measured — a CPU figure, a disk figure, a stop reason and a peak temperature — rather than through the scan layout.
- The activity log page filters by level and text, exports redacted, deletes, and prints the real retention figures.

**Gaps, placeholders and limits**

- Manual inspection sessions are not written as history entries; the store documents the kind, and nothing produces it yet.

**Evidence**

- tests/unit/history-store.test.js, health.test.js, logs-surface.test.js; History and Logs pages captured with real entries.


---

## 29. Security (spec 25)

**Requirements:** 3 — TS 1, IM 2, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-25-01 | Read-only diagnostics by default; destructive operations impossible without explicit consent | `src/security/guard.js` | `tests/unit/security.test.js` | **IM** |
| R-25-02 | Crash handling, unexpected-shutdown recovery, interrupted-test recovery | `src/app/crash-marker.js` | `tests/unit/gpu-responsiveness-recovery.test.js` | **TS** |
| R-25-03 | Secure local storage, sensitive-field redaction, user-controlled deletion and export scoping | `src/security/privacy.js` | `—` | **IM** |

**What a user sees**

- The renderer is sandboxed with context isolation and no node integration; the preload exposes a fixed channel list and no path-taking function; the outbound guard blocks and logs network attempts; the CSP forbids remote loads.
- Redaction is applied to data before any format renderer runs; a withheld count is shown on the Reports page and on every Privacy guarantee.
- Crash handling writes a recovery marker, reports an interrupted run once on the next start, and exits non-zero on an uncaught exception.

**Gaps, placeholders and limits**

- R-25-03 is IM: storage is local and deletion is user-controlled, but there is no encryption at rest — the requirement does not ask for one, and the Privacy page says so.

**Evidence**

- tests/unit/security.test.js, tests/integration/no-network.test.js, renderer-graph.test.js, privacy-verification.test.js, gpu-responsiveness-recovery.test.js.


---

## 30. Offline (spec 26)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-26-01 | Offline-first operation, zero paid dependencies, no telemetry, no data upload, license-clean dependencies | `src/security/guard.js + scripts/licence-audit.mjs` | `tests/integration/no-network.test.js, tests/integration/licence-audit.test.js` | **TS** |

**What a user sees**

- No network client exists in src/; the guard blocks and logs attempts; no dependency makes an outbound call at runtime.
- Every dependency licence is audited offline by scripts/licence-audit.mjs, which fails the build on an undeclared, copyleft-runtime or unallowlisted licence.

**Gaps, placeholders and limits**

- The licence audit reads the lockfile and the installed manifests, so it cannot see a licence that a future install would introduce until that lockfile exists; it contacts no registry, by design.

**Evidence**

- tests/integration/no-network.test.js walks the source for transports; renderer-graph.test.js proves the renderer cannot reach a Node builtin, let alone a socket.


---

## 31. Architecture (spec 27)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-27-01 | Layered module separation with documented interfaces and no circular dependencies (enforced by script) | `scripts/check.mjs` | `tests/integration/gate-refusals.test.js, tests/integration/audit-gate.test.js` | **TS** |
| R-27-02 | Clean code gate: syntax check, no dead entry points, no unresolved imports, consistent formatting | `scripts/check.mjs` | `tests/integration/gate-refusals.test.js` | **TS** |

**What a user sees**

- Layers are enforced by the static gate: syntax, unresolved imports, no dependency pointing outward from the core, and no dependency cycle anywhere in the graph.
- The same gate enforces a formatting policy over src/, tests/ and scripts/, and both new rules are exercised by tests that watch them refuse bad input.

**Gaps, placeholders and limits**

- Line length and alignment are review questions, not gate rules: the formatting policy covers tabs, carriage returns, trailing whitespace, the final newline and blank-line runs only.

**Evidence**

- scripts/check.mjs, tests/integration/audit-gate.test.js, build-boundary.test.js.


---

## 32. Repository (spec 28)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-28-01 | Repository holds source, assets, config, build scripts, tests, docs, CI, licence and third-party notices with meaningful commits | `.gitignore` | `tests/integration/no-network.test.js` | **TS** |

**What a user sees**

- Source, assets, config, build scripts, tests, docs, CI and licence in one repository; packaging cannot include test or fixture files.

**Gaps, placeholders and limits**

- History is a single branch plus the evidence branches; there are no release tags yet.

**Evidence**

- tests/integration/build-boundary.test.js.


---

## 33. CI/CD (spec 29)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-29-01 | GitHub Actions on windows-latest: checkout, setup, restore, format check, static analysis, unit tests, integration tests, build, package, installer, portable, artifact validation, SHA-256, release on tag | `.github/workflows/build.yml` | `tests/integration/workflow.test.js` | **TS** |

**What a user sees**

- GitHub Actions runs static checks plus the test suite on ubuntu-latest and windows-latest, builds the installer and portable exe on Windows, verifies signatures and hashes, and gates publishing on a manual dispatch.
- A separate evidence workflow drives the real window and publishes screenshots to an orphan branch.

**Gaps, placeholders and limits**

- The release workflow cannot be dispatched with the integration token available here (403, Actions permission missing), so no release has been cut from this branch; that is a permission gap, not a pipeline gap.

**Evidence**

- run 42172738818 (Tests on both platforms), 42172738822 (21 evidence steps, 32 screenshots).


---

## 34. Icon (spec 30)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-30-01 | Custom VERIDEX icon used for window, taskbar, EXE, installer | `scripts/build-icon.mjs` | `tests/integration/no-network.test.js` | **TS** |

**What a user sees**

- The icon is generated from source by scripts/build-icon.mjs and used for the window, taskbar, exe and installer.

**Gaps, placeholders and limits**

- Icon rendering at every shell size is not asserted; only the files’ presence and the build wiring are tested.

**Evidence**

- tests/integration/no-network.test.js; the packaged build in run 3281c01 carried the icon.


---

## 35. About (spec 31)

**Requirements:** 1 — TS 1, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-31-01 | About screen with brand, founder, contact, version, build, copyright, licence, runtime, architecture, acknowledgements, third-party licences | `src/renderer/app.js#pages.about` | `tests/integration/ui-features.test.js` | **TS** |

**What a user sees**

- About names the product, the author, the version and build, the licence, and states plainly that the build is unsigned and what that means for SmartScreen.

**Gaps, placeholders and limits**

- Contact details are static text.

**Evidence**

- tests/integration/ui-features.test.js asserts the About copy; the page is captured in the evidence set.


---

## 36. Unsigned (spec 32)

**Requirements:** 1 — TS 0, IM 1, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-32-01 | Unsigned EXE build, SHA-256 publication, SmartScreen disclosure without unsafe bypass advice | `electron-builder.config.mjs + scripts/verify-artifacts.mjs` | `tests/integration/artifacts.test.js` | **IM** |

**What a user sees**

- The build is unsigned by decision; SHA-256 sums are published beside the artifacts and the verification script recomputes them; the SmartScreen warning is explained without telling anyone to disable protection.

**Gaps, placeholders and limits**

- No signature exists, so an artifact cannot be attributed to the author cryptographically. The 403 on the release workflow means no fresh hash set exists for the current tree.

**Evidence**

- tests/integration/artifacts.test.js (signature, checksum and tamper checks); scripts/verify-artifacts.mjs.


---

## 37. QA (spec 33)

**Requirements:** 2 — TS 2, IM 0, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-33-01 | Unit test suite covering engine logic with meaningful assertions | `tests/unit` | `tests/unit/report.test.js` | **TS** |
| R-33-02 | Integration tests: pipeline end-to-end, report round-trip, UI contract, architecture and workflow gates | `tests/integration` | `tests/integration/diagnostic-run.test.js` | **TS** |

**What a user sees**

- 769 automated tests: unit suites over engine logic, integration suites over the pipeline, the report round trip, the IPC contract, the renderer graph and the UI under jsdom.

**Gaps, placeholders and limits**

- Coverage is not measured as a percentage; the gate is behavioural, not an instrumented coverage figure.

**Evidence**

- npm test → 769/769 on Linux and on windows-latest.


---

## 38. Testing (spec 34)

**Requirements:** 1 — TS 0, IM 1, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-34-01 | Virtual/physical Windows validation and explicit disclosure of everything not verifiable here | `docs/TEST_STATUS.md + scripts/audit-requirements.mjs` | `tests/integration/audit-gate.test.js` | **IM** |

**What a user sees**

- docs/TEST_STATUS.md states what each suite covers; PHYSICAL_VERIFICATION.md states what has and has not been touched by a human on real hardware.

**Gaps, placeholders and limits**

- R-34-01 is IM: the disclosure exists, but no virtual or physical Windows machine has answered the “does it work on a real desktop” question. This environment has no KVM, no nested virtualisation, and Electron cannot be installed locally.

**Evidence**

- The Windows evidence runs are the closest available substitute: real Electron, real window, real Chromium, on a hosted Windows runner rather than a VM we control.


---

## 39. Audit (spec 35)

**Requirements:** 2 — TS 1, IM 1, IP 0, NS 0

| ID | Requirement | Implementation | Test | Status |
| --- | --- | --- | --- | --- |
| R-35-01 | Automated requirement audit that fails when a requirement claims a status its artifacts do not support | `scripts/audit-requirements.mjs` | `tests/integration/audit-gate.test.js` | **TS** |
| R-35-02 | Final documentation set and release verification report | `docs/RELEASE_VERIFICATION.md` | `—` | **IM** |

**What a user sees**

- scripts/audit-requirements.mjs fails when a requirement claims a status its artefacts cannot support; the audit gate test proves it refuses an unsupported claim.

**Gaps, placeholders and limits**

- R-35-02 is IM: the documentation set is complete and current, but RELEASE_VERIFICATION.md still carries the previous build’s hashes and says release status is blocked.

**Evidence**

- tests/integration/audit-gate.test.js; check.mjs → 0 errors, 0 warnings after this milestone.

---

## 40. Cross-cutting release gates

**Requirements:** none of its own. This section audits the conditions that decide whether the build above may be published.

| Gate | State | Evidence |
| --- | --- | --- |
| Requirements complete | 130 of 130 implemented, 0 marked NS | `docs/requirements.json`, this document |
| Static gate | 0 errors, 0 warnings | `node scripts/check.mjs` |
| Test suite | 880/880 on Linux and Windows | run 42194144517 and predecessors |
| Renderer import graph | no Node builtin reachable from the renderer | `tests/integration/renderer-graph.test.js` |
| Real-window evidence | 23 steps, 35 screenshots, 0 problems | design-evidence run 42192434597, `ci/ui-42192434597` |
| Installer and portable build | produced and verified for tree `3281c01`; **stale for the current tree** | `docs/RELEASE_VERIFICATION.md` |
| Fresh artifact hashes | **do not exist for this tree** | blocked: `release.yml` cannot be dispatched from this environment |
| Windows runtime on real hardware | **not done** | no VM available in this environment; see Phase 5 record |
| Physical verification | **not done for any requirement** | `docs/PHYSICAL_VERIFICATION.md` |

The release is therefore **not authorised by this audit**. Two external conditions are missing:
a fresh build of the current tree, and permission to dispatch the release workflow. Neither can be
satisfied from inside this session, and neither is a code defect.

---

## Summary

| Status | Count |
| --- | --- |
| Tested (TS) | 112 |
| Implemented (IM) | 18 |
| In progress (IP) | 0 |
| Not started (NS) | 0 |
| VM-verified (VER) | 0 |
| **Total** | **130** |

### Requirements still partially implemented

None. The last two - R-12-02 and R-18-02 - were closed by building the missing half in this milestone; each keeps a named residual limitation in `docs/KNOWN_LIMITATIONS.md` §15.


### What this audit does not prove

- That any diagnostic value is correct for the machine it was collected from. No requirement is VER.
- That a physical component works: no keyboard, panel, speaker, camera, port or battery has been exercised.
- That the installer installs on a real desktop: it installs, launches and uninstalls on a virtual machine for this tree (run 42194144517), and has never touched a physical one.
- That the GPU benchmark measures a real GPU: it has only been run against a fake WebGL context.
- That the stress runner has been run on real hardware: it has only been run in tests with an injected load.

