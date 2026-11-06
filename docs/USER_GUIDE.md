# VERIDEX — User guide

VERIDEX reads hardware and operating-system state from **this** computer, scores the
evidence it was able to collect, and produces a report you can keep or share.

It works offline. It changes nothing. When it cannot read something, it says so instead
of guessing.

---

## 1. Before you start

On the first launch VERIDEX shows a four-step tour: what the application does, what it
deliberately cannot do, which readings need administrator rights, and what is kept on
your machine. Every step can be skipped, and skipping is recorded as skipping — Settings
offers the tour again whenever you want it. The tour never asks for elevation.

If you close the window halfway through, the tour resumes at the step you reached next
time. Being interrupted is not the same as having read it.

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

### 2.1 Getting around

The sidebar groups the eighteen pages by area. Above the page title a breadcrumb shows
`VERIDEX › <area> › <page>`; the area crumb goes to the first page of that area and the
VERIDEX crumb goes back to the dashboard. **Recent** in the toolbar lists the pages you have
visited this session, newest first, and is empty on a fresh launch because there is nothing
truthful to put in it yet. It is session-only: navigation is not written to disk.

### 2.2 Arranging the dashboard

**Arrange widgets** turns the dashboard into its own editor. Each card gets a name and three
controls: move up, move down, and remove. Removed widgets appear under **Hidden widgets**
with a button to add each one back, and **Reset to default** restores the shipped order.
Every change is written to the `dashboard.widgets` setting immediately, so the arrangement
survives a restart and is the same one the Settings page shows. The controls are buttons
rather than drag handles so the arrangement is usable from a keyboard.

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

Before you choose a format the page tells you what the file will contain: how many
modules produced evidence, how many fields were collected, how many carry a warning, the
coverage figure, the open issues and the manual-check progress. A report page that says
only "pick a format" asks you to trust that the document is complete; these figures are
the same ones the dashboard shows, so a disagreement is visible before the file exists.

Every report records **the privacy settings in force when it was generated**. So a report
you shared last month can always be traced back to exactly what it exposed.

### 4.1 Exporting the driver packages

The **Drivers** page carries an export card below the inventory. It copies the driver
packages currently installed into a **new folder** inside a folder you choose:

```
<your folder>\VERIDEX-drivers-YYYY-MM-DD-HHMMSS\*.inf
```

- Each export gets its own folder. Nothing is ever overwritten.
- The destination is checked before anything is written: drive roots and system folders
  are refused, and the free space is compared with the size of the installed packages
  plus a margin. If the free space cannot be read, the export is allowed and says so.
- Exporting needs administrator rights, so Windows shows **one** elevation prompt. The
  folder is created at standard privilege first, so declining the prompt leaves an empty
  folder and nothing else. Declining is recorded as *cancelled*, not as a failure.
- The export is **not a backup you can restore from**. VERIDEX cannot reinstall a driver
  from an export and does not claim to. It is a copy you can hand to a technician, who
  may use it with their own tools and their own judgement.
- Afterwards the folder is counted: the number of `.inf` files must match what `pnputil`
  reported. A mismatch is reported as *cannot be confirmed complete*, never as success.

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
- Redaction removes the **direct identifiers**. It does not make a report anonymous:
  the hardware configuration in it can still distinguish one machine from another. The
  Privacy page says this where the setting is, rather than promising anonymity it cannot
  deliver.

The **Privacy** page also states what is stored on this machine and where — the data
folder, the number of stored runs, and the log folder with its real size and limit — and
gives you the two actions that matter: open the activity log, or delete it.

### 5.1 The activity log

**Activity log** lists what VERIDEX did, newest first: timestamp, level, source and
message. You can filter by minimum level and by text, export a redacted copy to a file,
or delete the log files.

- A line that cannot be parsed is shown as it was written and counted at the top. A gap
  in a log looks exactly like a lie.
- Messages longer than 500 characters are truncated on export, with the truncation
  visible.
- Logs rotate by size: when a file reaches its limit a new one is started and the oldest
  is deleted, so the folder cannot grow without bound.

See `docs/SECURITY.md` for how this is enforced rather than merely intended.

---

## 6. The manual checklist

Some things cannot be detected by software: a fan that rattles, a hinge that is loose, a
key that sometimes misses. The **Manual** page is a checklist of those. Your answers are
recorded separately from measured evidence and **never folded into the score** — a
human's observation and a machine's measurement are two different kinds of claim.

---

## 7. Benchmarking and monitoring

The **Performance** page runs CPU, disk and GPU benchmarks, the responsiveness composite,
and a guarded CPU stress run. The **Monitor** page samples sensors over time. All of it is
read-only except where it says otherwise:

- The **write** half of the disk benchmark creates and deletes a temporary file, so it
  asks for consent first, and the log names the file if it could not be removed.
- Stress tests run under a guard that stops them if the machine leaves a safe thermal
  range. A stress run has **no pass or fail**: it reports how long it ran, how hot the
  machine got, and why it stopped.
- The **GPU** run is a WebGL fill-rate workload. If the session has no usable WebGL it
  reports **UNSUPPORTED** with the reason; it never substitutes a software rasteriser and
  present the result as a GPU figure. Frame time and fill rate are not the GPU's peak
  performance, and on a laptop with switchable graphics the figure may belong to the
  integrated adapter.
- The **memory stability** check needs consent, because it really does allocate the buffer you
  choose (64–1024 MB) and hold it for the passes you choose. It writes a pattern and reads it
  back; a word that does not match is real evidence of a fault, but zero mismatches is **not** a
  clean bill of health and the result is never shown as a pass. It cannot tell you which memory
  module is at fault.
- The **responsiveness** composite combines what was actually measured (CPU 35 %, memory
  20 %, disk 25 %, GPU 20 %, renormalised over what ran) and prints its formula and
  reference points beside the score. With fewer than two measured subsystems the score is
  withheld rather than invented. Event-loop lag is a capped penalty, not an ingredient.

Neither benchmarks nor stress run automatically, and none of them changes a system setting.

### 7.1 Exporting a monitoring session

Sampling only runs while you ask it to. When you stop, the readings stay available and
**Export samples** writes them to a CSV file — one row per reading, with a `#` header
naming the session, and an `available` column that is `no` where a sensor did not answer.
A missing reading is a blank cell, never a zero. JSON is also supported from the same
session record. The export refuses when nothing has been sampled, because a file of headers
looks like a session that measured nothing.

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
