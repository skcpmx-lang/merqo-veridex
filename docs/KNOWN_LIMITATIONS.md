# Known limitations

This document lists what VERIDEX cannot do, in the order a user is most likely to be
surprised by it. Each entry says what the limitation is, why it exists, and what VERIDEX
does instead.

An honest limitation list is part of the product. A diagnostic tool that hides what it
cannot see teaches its user to trust the gaps.

---

## 1. Not verified on real hardware

**This is the largest limitation and it colours everything else.**

Every requirement in `docs/requirements.json` is marked **TS** (tested) or **IM**
(implemented), and **none** is marked **VER**. VER means a person ran the feature on a
real Windows 10/11 machine and recorded what they saw. That has not happened.

The consequence: the parsing, scoring, merging and reporting logic is exercised by 454
automated tests, but the Windows-specific reads have only ever run against simulated
output. A real `Win32_Processor` query returning a value shaped differently than the
fixtures expect would not have been caught.

`docs/TEST_STATUS.md` records exactly which claims rest on a real machine and which do
not. The interface states this too: the header says "Design preview" and the scan button
is disabled when VERIDEX runs without its main process.

---

## 2. Windows only

VERIDEX reads Windows interfaces: CIM/WMI, `powercfg`, `pnputil`, `dxdiag`, the registry,
and NTFS-era tooling. There is no portable abstraction layer, because "read this same
thing on macOS" is not a translation — the underlying data does not exist in the same
form.

On any other platform every provider returns `UNSUPPORTED` with that reason. Nothing
crashes and nothing pretends. A scan on Linux reports 15 tasks, 28 provider attempts and
no errors, precisely because "not Windows" is an answer and not a failure.

---

## 3. Administrator rights change what you see

A meaningful set of diagnostics needs elevation to return data:

| Needs administrator rights | What you get without it |
| --- | --- |
| Driver store enumeration and export | `PERMISSION_REQUIRED` |
| Windows optional features / servicing state | `PERMISSION_REQUIRED` |
| TPM version and state | `PERMISSION_REQUIRED` |
| Some storage health counters | `PERMISSION_REQUIRED` |
| Secure Boot state on some firmware | `UNAVAILABLE` |

VERIDEX does **not** start elevated and does not silently re-launch itself with a UAC
prompt. It runs `asInvoker` and asks for elevation only for the specific operation that
needs it.

Because several of these feed scored components, **a scan run as a standard user will
often show a lower coverage** — and therefore, under the coverage gate, may show no score
at all. That is the intended behaviour: the machine was not fully measured.

---

## 4. The score is gated, and will frequently be withheld

Below 50 % coverage no score is shown; between 50 % and 80 % it is capped at 84 (*Fair*).

On an ordinary desktop this is common: no battery means the battery component is
`NOT_APPLICABLE`, and any permission-gated component that was declined is `Unrated`. A
user who wants a number should run with elevation. A user who does not should expect the
tool to explain why it has no number to give, which it does.

---

## 5. Benchmarking is indicative, not calibrated

The CPU and disk benchmarks measure relative performance on this machine over time. They
are **not** calibrated against a reference dataset, so the numbers cannot be compared
meaningfully with a review site's figures or another person's machine.

What they are good for: the same machine, before and after a change, and trend history.

The **write** benchmark writes a temporary file, so it requires consent and is never part
of a scan.

---

## 6. Monitoring cannot see every sensor

Sensor coverage depends on what the firmware exposes. Many laptops and most desktops
expose CPU temperature through ACPI or a vendor interface; some expose nothing at all,
and some expose values that are plainly wrong (a constant 27 °C, or a sensor that reports
`0`).

VERIDEX reports what the interface returns. It does **not** smooth, interpolate or
"fix" implausible sensor data, and it does not invent a temperature when none is
available. A missing thermal reading makes the thermal component `Unrated` and lowers
coverage rather than producing a friendly-looking number.

Fan speed is frequently unavailable for the same reason: many boards simply do not
expose it to the operating system.

---

## 7. Storage health has sharp edges

- **SMART attribute 190/194** (temperature) is vendor-specific and sometimes reports
  nonsense. It is surfaced as-is, with the vendor caveat, rather than corrected.
- **USB drives** generally report no SMART data at all. They appear in inventory and are
  `UNAVAILABLE` for health.
- **NVMe** health comes from the controller's own log page. On some drives and some
  Windows builds this requires administrator rights.
- **RAID members** may be invisible to the OS entirely; VERIDEX can only report what
  Windows can see.
- A **healthy-looking SMART** result is weak evidence. Drives fail without warning
  attributes all the time. The absence of a warning is not a guarantee.

---

## 8. Battery data is approximate

`powercfg /batteryreport` gives design capacity and last-known full charge. Dividing one
by the other gives a wear estimate that is:

- a **snapshot**, not a trend — it depends on the charge at the moment of the report;
- frequently reported as a clean percentage that implies more precision than exists;
- unavailable on many desktops, and on some laptops behind firmware that does not publish
  the design capacity.

On a machine with no battery at all, the correct answer is `NOT_APPLICABLE`, and that is
what VERIDEX reports. It does not treat a desktop as a laptop with a dead battery.

---

## 9. Driver ages and problem codes need interpretation

The driver page lists devices with problem codes and driver dates. Two caveats:

- An **old driver** is not necessarily a bad one. VERIDEX flags age as information, not
  as a fault.
- A **problem code** of 0 means Windows started the device. It does not mean the device
  works well.

---

## 10. GPU detection has a real heuristic in it

Where CIM returns nothing useful, VERIDEX falls back to a **vendor heuristic** and a
**model table** that infers generation and tier from a model name. Both are labelled
`heuristic` and `derived` respectively, and both are shown with that label.

Consequences you should expect:

- A model name the table has never seen is reported as unknown, not guessed at.
- Some GPUs deduplicate in CIM such that the second card in an SLI/CrossFire pair is
  listed twice or not at all.
- **VRAM reported by the OS is frequently wrong** for cards with more than 4 GB, because
  of the signed 32-bit field in some interfaces. VERIDEX flags implausible values rather
  than printing them as fact.

---

## 11. Elevated/overclocked systems may score oddly

The score is a summary. It does not know that a machine is deliberately overclocked, that
a fan curve was set for silence, or that a laptop is on battery power saving mode. It
reports the state it observed.

---

## 12. The interface is a preview until packaged

Running the renderer directly in a browser shows every page with real layout and honest
empty states, but the scan button is disabled and no data can be collected, because there
is no main process to collect it. This is enforced rather than incidental: the button's
tooltip says the main process is required.

---

## 13. The build is unsigned

No code-signing certificate is available. Windows SmartScreen will warn on first run. No
publisher name is invented and no attempt is made to suppress the warning. Check the
SHA-256 in `SHA256SUMS.txt` against the published value before running the installer.

---

## 14. Some UI features are not wired yet

The renderer is complete and tested, but a few actions have no main-process handler
behind them:

- embedding performance results from the Performance page

The **history list is now wired**: it reads stored runs through `history:list` and shows
each run's real score, rating and coverage. It distinguishes three states that used to be
one — still reading, genuinely empty, and unreadable — because a failed read that renders
as "no runs stored" is a lie about the user's own data.

**Live monitoring is now wired**: the main process owns a real `Monitor` and pushes
samples on the event channel. Starting it genuinely starts sampling, a refused start is
reported as a failure rather than as success, sensors the machine does not expose are
listed as unavailable with their reason, and sampling stops when the window closes.

Each of these pages says so in plain language rather than showing an empty shell or
sample data. `docs/PROJECT_STATUS.md` tracks them.

---

## 15. Requirements not started

44 of 130 requirements are not started. They are grouped by module in
`docs/REQUIREMENTS.md`, which is generated from `docs/requirements.json` and is the
authoritative list. The largest concentrations are Windows inventory depth, benchmarking
variants, driver inventory, compatibility notes, notifications, search and report
history.

Nothing in this document is a promise about when those will arrive.
