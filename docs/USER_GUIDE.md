# VERIDEX — User guide

VERIDEX reads hardware and operating-system state from **this** computer, scores the
evidence it was able to collect, and produces a report you can keep or share.

It works offline. It changes nothing. When it cannot read something, it says so instead
of guessing.

---

## 1. Before you start

- **Windows 10 or 11, 64-bit.** VERIDEX is a Windows diagnostic tool; the build is a
  Windows executable. (See `docs/COMPATIBILITY.md` for what is and is not tested.)
- **No installation rights needed.** The installer installs per-user, not per-machine.
- **No administrator rights needed to start.** Some diagnostics need elevation to return
  data. VERIDEX asks for those individually, when they come up, and reports
  `PERMISSION_REQUIRED` if you decline.
- **The installer is unsigned.** Windows SmartScreen will warn you on first run. Choose
  *More info → Run anyway* only if you downloaded the file from the project's release
  page, and check its SHA-256 against `SHA256SUMS.txt` first.

---

## 2. Running a scan

1. Open VERIDEX. The dashboard appears with everything marked **Unrated** — nothing has
   been measured yet, and VERIDEX will not show a score it has not earned.
2. Press **Start scan**.
3. A scan takes roughly **one second** for the fast path. Some tasks are slower: `dxdiag`
   can take 5–25 seconds, and storage health probes may wait on a drive. The task list
   shows each one as it completes.
4. When it finishes you get a score, a per-component breakdown, and a report you can save.

A scan is read-only. Nothing is written to the machine, nothing is uploaded, and no
service is restarted.

---

## 3. Reading the result

### 3.1 The score

The score is built from eight components: processor, graphics, memory, storage, battery,
thermal, drivers and security.

**A component with no evidence is Unrated, not healthy.** If VERIDEX could not read your
battery, the battery is excluded from the score; it is not counted as fine.

Because of that, the score is **gated on coverage**:

| How much of the machine could be measured | What you see |
| --- | --- |
| less than half | **No score.** "Score withheld", with the reason |
| half to four-fifths | A score, but capped at **84 · Fair** — never "Good" |
| four-fifths or more | The real score |

This is deliberate. A number averaged over one component of eight is not a verdict about
your computer. If you see "Score withheld", the reason is stated underneath, and the
evidence that *was* collected is shown in full.

### 3.2 Field statuses

Every value carries a status. The distinctions matter:

| Status | Meaning |
| --- | --- |
| **Pass** | Read successfully, nothing to flag |
| **Warning** | Read successfully, worth your attention |
| **Fail** | Read successfully, a real problem |
| **Unavailable** | The interface exists but returned nothing usable |
| **Unsupported** | This machine or OS does not offer this |
| **Permission required** | Needs administrator rights; not collected |
| **Error** | The read was attempted and failed |
| **Not applicable** | This hardware is not present (e.g. no battery) |
| **Unrated** | No evidence was gathered at all |

"Unavailable" and "Not applicable" are different answers. A desktop with no battery is
*not applicable*; a laptop whose battery could not be read is *unavailable*. VERIDEX
tells you which, because only one of those is normal.

### 3.3 Where each value came from

Hover over or expand a field to see its source and how much weight it carries:

- **Authoritative** — read directly from Windows (CIM/WMI, system APIs)
- **Firmware** — from the device's own health records (SMART, NVMe)
- **Derived** — computed or parsed from a report the OS generated
- **Heuristic** — inferred from names or chipset patterns

A heuristic reading is labelled as one. It is useful, and it is not the same as a
measurement.

---

## 4. Saving a report

From the **Reports** page you can produce:

- **PDF** — the document to keep or attach to a warranty claim
- **HTML** — one self-contained page, no external assets
- **JSON** — the full data, including the redaction policy that produced it
- **CSV** — flat fields for a spreadsheet

Every report records **the privacy settings in force when it was generated**. So a report
you shared last month can always be traced back to exactly what it exposed.

---

## 5. Privacy

VERIDEX redacts identifying information by default: serial numbers, MAC and IP addresses,
hostnames, account names, product keys, and Wi-Fi names.

- Redaction is **on** unless you turn it off.
- If the settings file cannot be read, redaction stays **on**. Failure closes the
  export; it never opens it.
- A redacted report says a field was withheld and which category it belonged to, so you
  can tell "not present" from "hidden on purpose".
- Nothing leaves your computer. There is no upload, no account, no telemetry, no
  crash reporting.

See `docs/SECURITY.md` for how this is enforced rather than merely intended.

---

## 6. The manual checklist

Some things cannot be detected by software: a fan that rattles, a hinge that is loose, a
key that sometimes misses. The **Manual** page is a checklist of those. Your answers are
recorded separately from measured evidence and **never folded into the score** — a
human's observation and a machine's measurement are two different kinds of claim.

---

## 7. Benchmarking and monitoring

The **Performance** page runs CPU and disk benchmarks, and the **Monitor** page samples
sensors over time. Both are read-only except where they say otherwise:

- The **write** half of the disk benchmark creates and deletes a temporary file, so it
  asks for consent first.
- Stress tests run under a guard that stops them if the machine leaves a safe thermal
  range.

Neither runs automatically. Neither changes a system setting.

---

## 8. When something is wrong

| Symptom | What it means |
| --- | --- |
| "Score withheld" | Too little of the machine could be measured. Work down the unrated list; running as administrator usually resolves several at once. |
| Many fields show **Permission required** | Start VERIDEX as administrator, or accept the elevation prompt for that task. |
| A whole area is **Unsupported** | That interface is absent on this machine or this Windows build. |
| **Error** on one task | That read failed. The other tasks are unaffected; a scan never aborts because one module failed. |
| The DirectX section is empty for a long time | `dxdiag` is slow. Give it up to 30 seconds. |

---

## 9. Uninstalling

The installer uninstalls per-user and does not require elevation. Reports and history you
saved are yours and are **not** deleted by the uninstaller — remove them yourself if you
want them gone.

---

## 10. What VERIDEX is not

- It is **not** an antivirus, and it cannot tell you whether a machine is malware-free.
- It is **not** a repair tool. It does not fix, clean, tune or "optimise" anything.
- It is **not** a certification. A good score means the evidence it could collect looked
  healthy. It is not a guarantee against future failure.
- It is **not** a substitute for opening the machine and looking at it.
