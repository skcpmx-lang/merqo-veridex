# Release notes

---

## No release has been published

`package.json` says `1.0.0`, and CI now **builds** a Windows x64 installer and portable
executable on every pull request. Neither has been **published**, and neither has been
**run**: nobody has installed the application, and it has never launched on a real desktop.

Publishing is blocked deliberately. `docs/RELEASE_VERIFICATION.md` §2 onward is untouched,
and no requirement is marked VERIFIED. A published release is a claim that the thing works
for the person downloading it, and that claim has not been earned.

`docs/PROJECT_STATUS.md` describes what is finished and what is not. `docs/TEST_STATUS.md`
describes what has actually been executed, and `docs/HARDWARE_COMPATIBILITY.md` records the
evidence level of every subsystem.

### Unreleased build, for inspection only

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `VERIDEX-Setup-1.0.0-x64.exe` | 117.4 MiB | `a8377850b828f769f0492071f59758d20d6763ac00e05d72e68ca67baf09c613` |
| `VERIDEX-1.0.0-portable-x64.exe` | 106.5 MiB | `fe7338dca1de85c164195606c0825f6b098341043cf546a58069c9b19d6b9335` |

These come from a `windows-latest` CI runner. **Unsigned**, so SmartScreen will warn. They
are not offered for download from a release page, because a release page is a
recommendation and this build has not been run.

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
