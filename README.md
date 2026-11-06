# VERIDEX

**Advanced all-in-one Windows PC & laptop diagnostics.**
Local. Read-only. Offline by construction. Honest about what it could not measure.

> **Status: installs, launches and uninstalls on a Windows virtual machine — never on
> physical hardware.**
> The test suite passes on Linux **and** Windows. CI builds the installer and the portable
> executable, then *uses* them: it installs silently and per-user, launches the installed
> application, drives its whole interface, and uninstalls it — plus the portable build,
> launched from its extraction directory (digests in
> [release verification](docs/RELEASE_VERIFICATION.md)). What no automated test can do is run
> on a real PC with a battery, an SSD and a discrete GPU, or show its window to a person. That
> is why **no requirement is marked verified** and no release is published. See
> [hardware compatibility](docs/HARDWARE_COMPATIBILITY.md) for exactly what has executed.

---

## What it is

VERIDEX reads hardware and operating-system state from the machine it runs on, scores the
evidence it was able to collect, and writes a report you can keep.

- **15 diagnostic modules, 20 tasks, 34 providers** — processor, memory, motherboard,
  GPU, storage, battery, network, drivers, Windows servicing, system identity, security
  posture
- **8 health components** with evidence-based scoring
- **5 report formats** — PDF, HTML, JSON, CSV, and a one-page certificate
- **15 interface pages**, two complete themes, five accents
- **Read-only**. Sixteen destructive command patterns are refused outright; four
  file-writing operations require per-operation consent

## What makes it different

Most diagnostics lie in one specific way: they report "OK" for things they could not
read. VERIDEX does not.

**Absence is a first-class result.** Every value carries a status — `PASS`, `WARNING`,
`FAIL`, `UNAVAILABLE`, `UNSUPPORTED`, `PERMISSION_REQUIRED`, `ERROR`, `NOT_APPLICABLE`,
`UNRATED` — and anything that is not `PASS` explains itself. There is no way in the data
model to represent "no data" as a bare `undefined`, because `undefined` cannot explain
itself.

**The score is gated on coverage.** Below 50 % coverage no score is shown at all; between
50 % and 80 % it is capped at *Fair*. This exists because a real run printed:

```
100 / 100 · Good        coverage 13.2%        rated 1 of 8
```

A perfect green score from one measured component out of eight. That output is now
impossible; the tool says instead:

> **Score withheld** — Only 13.2% of the weighted assessment surface could be measured
> (1 of 8 components). An average over such a small part of the machine would look like a
> verdict on the whole machine.

**There is no network client.** Not "telemetry disabled" — the source contains no HTTP
client, socket, DNS lookup or updater, and a test fails the build if one appears.

**Privileged work is named, not commanded.** The interface cannot ask for a command; it can
ask for one of three named tasks (`windows.componentHealth`, `drivers.export`,
`battery.report`). A separate elevated helper runs it, writes a JSON result, and returns.
Declining the Windows prompt is recorded as *cancelled — continues at standard privilege*,
and a helper that exits zero without a result file is treated as a failure.

## What the four newest surfaces do

| Surface | What it does | What it refuses to claim |
| --- | --- | --- |
| First-run tour | Explains the product, its limits, which readings need administrator rights and what is stored; four steps, skip on every one, resumes after an interruption | That reading the tour is consent — a skip is recorded as a skip |
| Activity log | Level and text filters over a rotating, redacted log; export and delete | That redaction is anonymity — the machine is still describable by its configuration |
| Driver export | Copies installed driver packages into a new folder per export, after a space and destination check | That it is a backup — there is no restore path and none is described |
| Reports & Privacy | States what a report will contain before you pick a format; states what is stored and where | A coverage number it did not measure, or a file whose contents the page did not preview |

## Screenshot

The interface is a dark-first, dense diagnostic layout: a left rail of 18 pages, a status
strip, and per-page tables of values with glyph + word + colour status markers. When run
outside the packaged application it says **"Design preview — no machine was inspected"**
and disables the scan button, rather than showing invented data.

## Quick start

```bash
npm ci
npm test            # 769 tests
npm run check       # static gate
npm run start       # requires Electron + a desktop session
```

Packaging targets Windows only:

```bash
npm run build:win   # NSIS installer + portable, x64, unsigned
```

Requires Node ≥ 20.11.0 for development. End users need nothing but the installer.

## Documentation

| Document | What it answers |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | How to run a scan and read the result |
| [Architecture](docs/ARCHITECTURE.md) | How a scan becomes a report, file by file |
| [Health score](docs/HEALTH_SCORE.md) | How the number is built, and when it is withheld |
| [Security](docs/SECURITY.md) | What it can do to a machine, and what it refuses to do |
| [Known limitations](docs/KNOWN_LIMITATIONS.md) | What it cannot see, and why |
| [Warnings](docs/WARNINGS.md) | Every remaining static-check warning, with its reason |
| [Compatibility](docs/COMPATIBILITY.md) | Supported platforms vs. verified platforms |
| [Design system](docs/DESIGN_SYSTEM.md) | Colour, spacing, status presentation, accessibility |
| [Project status](docs/PROJECT_STATUS.md) | Finished, wired-but-unproven, not started |
| [Test status](docs/TEST_STATUS.md) | What has actually been executed, and what has not |
| [Requirements](docs/REQUIREMENTS.md) | All 130 requirements with per-item status |
| [Release notes](docs/RELEASE_NOTES.md) | Why there is no release yet |
| [CI/CD](docs/GITHUB_ACTIONS.md) | The two workflows and their current state |
| [Release verification](docs/RELEASE_VERIFICATION.md) | The pre-release checklist; build, launch and installer are done on a VM, physical hardware is not |
| [Hardware compatibility](docs/HARDWARE_COMPATIBILITY.md) | What has actually executed, per subsystem |
| [Physical verification](docs/PHYSICAL_VERIFICATION.md) | The run sheet for the first physical-machine test — the only route to L4 |

## Testing

```bash
npm test                      # everything
npm run test:unit             # pure logic
npm run test:integration      # wiring, providers, renderer, documentation
npm run audit:requirements    # regenerate docs/REQUIREMENTS.md
npm run audit:requirements -- --check   # verify claims without rewriting
```

| Layer | How it is tested |
| --- | --- |
| Parsers and scoring | Real fixtures, including malformed and vendor-weird output |
| Providers | Every one executed against a no-op runner; field shape and explanation validated |
| Renderer | All 18 pages booted under jsdom; no `undefined`, `NaN` or `[object Object]` |
| Security | 16 destructive command lines refused, 11 read-only ones permitted |
| Documentation | Every path a document names must exist; quoted CSP must match the shell |

The suite is honest about its own limit: it runs on Linux CI and proves the logic, not the
Windows behaviour. [Test status](docs/TEST_STATUS.md) enumerates what it does not prove.

## Project principles

1. **No network client.** Absent from the source, not disabled.
2. **Read-only.** It does not fix, clean, tune or optimise anything.
3. **No score without coverage.** A gap in evidence is never rendered as a pass.
4. **No invented data.** Not in reports, not in the interface, not in the tests.
5. **No unverified claim.** `VER` requires recorded evidence from a real machine.

## Licence and authorship

MERQO · Shohan Khan. See `LICENSE`.

The installer is unsigned: no code-signing certificate is available for this project.
Windows SmartScreen will warn on first run. Verify `SHA256SUMS.txt` before running it.
