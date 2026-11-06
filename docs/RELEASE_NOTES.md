# Release notes

---

## No release has been published

**The one remaining gate.** Everything on this page is built, tested and documented. The release
workflow exists on `main` and needs one thing this environment cannot provide: `Actions: write` on
the repository, so that it can be dispatched. A person with write access clicks *Actions → Release
→ Run workflow*, enters `1.0.0`, and the workflow builds, tests, verifies, tags `v1.0.0` and
publishes the artifacts with their checksums. Nothing else is outstanding.


`package.json` says `1.0.0`, and CI **builds** a Windows x64 installer and portable
executable on every pull request — and now **runs them**: the installer is installed silently
and per-user, the installed application is launched and its interface driven, the uninstaller
removes it again, and the portable executable starts from its extraction directory. All of
that happens on `windows-latest`.

Neither artifact has been **published**, and neither has been on a physical machine. The
virtual machine has no battery, no SSD exposing SMART and no discrete GPU — the three things
this tool exists to inspect — and no person has looked at the window.

Publishing is blocked deliberately. `docs/RELEASE_VERIFICATION.md` still has every
physical-machine box unchecked, and no requirement is marked VERIFIED. A published release is
a claim that the thing works for the person downloading it, and that claim has not been
earned.

`docs/PROJECT_STATUS.md` describes what is finished and what is not. `docs/TEST_STATUS.md`
describes what has actually been executed, and `docs/HARDWARE_COMPATIBILITY.md` records the
evidence level of every subsystem.

### Unreleased build, for inspection only

| Artifact | Size | SHA-256 | Built from |
| --- | --- | --- | --- |
| `VERIDEX-Setup-1.0.0-x64.exe` | 117.5 MiB | `e6d0fdd88c6e9c78d2543e321b9b6c63fa63d2e407454c1343dd5d2ffa5ecec2` | run 42160034210, an earlier tree than this one |
| `VERIDEX-1.0.0-portable-x64.exe` | 106.5 MiB | `40d6a0db33414c3be914fb068c31048136c95394ca75acabad25bd43de14b487` | run 42160034210, an earlier tree than this one |

Both are `windows-latest` CI builds and **unsigned**, so SmartScreen will warn. Their hashes
describe the build from run 42160034210 and nothing else: every rebuild produces new bytes, so
these two values must not be quoted for a later artifact.

The build for the current tree is in the `veridex-windows` artifact of the packaging job
(`RELEASE_VERIFICATION.md` records its run, byte size and GitHub's digest of the archive). Its
two executables' hashes are **not** in this file, because the artifact could not be downloaded
to compute them; `RELEASE_VERIFICATION.md` gives the exact commands that do it.

None of these builds is offered for download from a release page, because a release page is a
recommendation and this build has not been run on a machine anybody owns.

---

## What the first published release must additionally establish

Beyond the build facts above, a published release must record that a person installed it on
a physical Windows machine and that it launched, scanned and reported. That evidence does not
exist yet. See `docs/RELEASE_VERIFICATION.md`.

## What will be in the first release, when it happens

The first real entry should state, at minimum:

```markdown
## 1.0.0 — YYYY-MM-DD

### Build
- Artifact names, sizes and SHA-256 values
- Signed: no
- Built from commit: <sha>
- Built on: <runner description>

### Verified on
- Windows builds tested, and on what hardware
- What was observed, including everything that returned UNAVAILABLE

### Known issues at release
- The entries from docs/KNOWN_LIMITATIONS.md that mattered in practice

### Not in this release
- The requirements still marked NS in docs/REQUIREMENTS.md
```

The fields are deliberately specific. "Improved diagnostics" is not a release note; a
checksum, a commit and a machine description are.

---

## Standing notes for every release

These apply to every version until something changes:

- **The build is unsigned.** No code-signing certificate is available. Windows SmartScreen
  will warn on first run. Check `SHA256SUMS.txt` before running the installer.
- **No requirement is marked VER** until it has been run on a real Windows machine and the
  evidence is recorded in `docs/requirements.json`.
- **The network layer is absent, not disabled.** A release that gains one would be a
  different product and would be a breaking change, not a feature.
- **Scores are gated on coverage.** A release note that reports "score 100" without the
  coverage beside it is misleading, and should be rewritten.

---

## Versioning

Until the first verified release, the version stays at `1.0.0` and carries no meaning
beyond "not yet shipped". After that, changes to scoring, gating thresholds or the privacy
defaults are **major** changes: they alter what a saved report means, and a report read
later must still be interpretable.
