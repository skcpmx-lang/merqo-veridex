# Release notes

---

## No release has been published

`package.json` says `1.0.0`, but **no build of VERIDEX has been produced, packaged, or run
on Windows.** This file exists so the first release has a place to be recorded, and so the
current state cannot be mistaken for one.

`docs/PROJECT_STATUS.md` describes what is finished and what is not. `docs/TEST_STATUS.md`
describes what has actually been executed.

---

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
