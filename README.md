# VERIDEX

**Advanced all-in-one Windows PC & laptop diagnostics.**
Local. Read-only. Offline by construction. Honest about what it could not measure.

> **Status: builds on Windows, never launched on it.**
> The test suite passes on Linux **and** Windows, and CI produces a real x64 installer and
> portable build (`VERIDEX-Setup-1.0.0-x64.exe`, 117.4 MiB, digests in
> [release verification](docs/RELEASE_VERIFICATION.md)). But the installer has **never been
> installed** and the application has **never been launched on a real desktop**, so no
> requirement is marked verified. See [hardware compatibility](docs/HARDWARE_COMPATIBILITY.md)
> for exactly what has executed and what has not.

---

## What it is

VERIDEX reads hardware and operating-system state from the machine it runs on, scores the
evidence it was able to collect, and writes a report you can keep.

- **11 diagnostic modules, 15 tasks, 29 providers** — processor, memory, motherboard,
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

## Screenshot

The interface is a dark-first, dense diagnostic layout: a left rail of 15 pages, a status
strip, and per-page tables of values with glyph + word + colour status markers. When run
outside the packaged application it says **"Design preview — no machine was inspected"**
and disables the scan button, rather than showing invented data.

## Quick start

```bash
npm ci
npm test            # 470 tests
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
| [Compatibility](docs/COMPATIBILITY.md) | Supported platforms vs. verified platforms |
| [Design system](docs/DESIGN_SYSTEM.md) | Colour, spacing, status presentation, accessibility |
| [Project status](docs/PROJECT_STATUS.md) | Finished, wired-but-unproven, not started |
| [Test status](docs/TEST_STATUS.md) | What has actually been executed, and what has not |
| [Requirements](docs/REQUIREMENTS.md) | All 130 requirements with per-item status |
| [Release notes](docs/RELEASE_NOTES.md) | Why there is no release yet |
| [CI/CD](docs/GITHUB_ACTIONS.md) | The two workflows and their current state |
| [Release verification](docs/RELEASE_VERIFICATION.md) | The pre-release checklist; the build half is done, the runtime half is not |
| [Hardware compatibility](docs/HARDWARE_COMPATIBILITY.md) | What has actually executed, per subsystem |

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
| Renderer | All 15 pages booted under jsdom; no `undefined`, `NaN` or `[object Object]` |
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
