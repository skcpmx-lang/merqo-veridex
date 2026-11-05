# CI and release workflows

Two workflows, both in `.github/workflows/`. This document explains what they do and —
importantly — what has and has not been observed to work.

**Digests are per-build, not per-version.** Every rebuild produces new bytes, because an
unsigned Electron bundle embeds no reproducible timestamp. The digests recorded here are
those of the run named beside them. Comparing them against a different run will always
differ, and that is expected rather than a failed verification.

---

## 1. Status

`build.yml` runs on every push and pull request and **passes on both Linux and Windows**.
`release.yml` has **never run** — it is manual by design, and it must not be dispatched
until the runtime verification in `docs/RELEASE_VERIFICATION.md` §2 onward is complete.

Recorded runs:

| Run | Trigger | Result |
| --- | --- | --- |
| [`42013425380`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42013425380) | push | ✅ first green run on Windows and Linux |
| [`42014598911`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42014598911) | pull request | ✅ including a real Windows installer build |
| [`42030263971`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42030263971) | pull request | ✅ build + artifact verification + build manifest |

Before run 42013425380 the workflow had been **failing on every push since it was added**,
and this document incorrectly said it had not run at all. That was wrong in a way worth
recording: the workflow existed, executed, and failed, while the documentation asserted
silence. The failures were real and only visible on Windows — see the commit history for
`ci: replace fixed sleeps with condition polling` and `fix(test): remove two host-dependent
assumptions`.

---

## 2. `build.yml` — build and test

Triggers: every push to any branch, every pull request, and manual dispatch.

| Job | Runner | Purpose |
| --- | --- | --- |
| `verify` | `ubuntu-latest` | static checks and requirement consistency |
| `test` | `ubuntu-latest`, `windows-latest` | the full suite on both platforms |
| `package` | `windows-latest` | a real Electron build, uploaded as an artifact |

### `verify`

```bash
npm ci
npm run check                       # scripts/check.mjs — parses every module
npm run audit:requirements -- --check   # refuses inconsistent claim statuses
```

`--check` matters: it verifies without rewriting `docs/REQUIREMENTS.md`, so a pull request
that changes a status without updating the generated file fails rather than silently
regenerating it.

### `test`

The matrix runs the same `npm test` on Linux and Windows. The Windows leg is the point:
it is the first place any Windows-specific behaviour would be exercised.

The job generates the icon first (`npm run icon`), because the tests reference the built
asset. On failure it uploads logs with a 7-day retention.

### `package`

Runs on `main`, on a manual dispatch, and on **every pull request**. The pull-request case
is deliberate: a reviewer should be able to inspect the artifact a change actually produces,
because "the packaging configuration is valid" and "an installer came out of it" are
different claims. Pull-request builds never publish anything.

```bash
npm ci
npm run icon
npm run build:win                   # electron-builder, NSIS + portable, x64
npm run verify:artifacts            # writes dist/SHA256SUMS.txt
node scripts/verify-package.mjs     # the unpacked build: PE metadata, app.asar contents
npm run smoke:gui -- --dist dist/win-unpacked   # drive the whole interface
npm run smoke:portable              # launch the portable executable itself
npm run smoke:install               # install silently, launch, uninstall
```

The last four are the difference between "an installer came out of it" and "the installer
installs". Each writes a JSON verdict, uploads it as the `veridex-gui-evidence` artifact, and
emits one annotation per problem, because the job log is not always reachable and a failure
that cannot be read is a failure that cannot be fixed.

Measured on `windows-latest`: **117.4 MiB installer, 106.5 MiB portable**. The GUI sweep takes
about thirty seconds with a three-task scan, the portable check fifteen, the install lifecycle
twenty-three; packaging itself is around two and a half minutes. The build also writes `dist/BUILD-MANIFEST.txt` (version,
commit, runner, per-artifact sizes and digests) and emits the same facts as `::notice`
annotations, so the artifacts can be audited through the checks API without downloading
234 MB.

`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` is set so electron-builder does not go looking for
a signing certificate. The build is unsigned and the release notes say so; there is no
attempt to make the build appear signed.

The job prints the artifact list and the checksum file, then uploads `dist/*.exe`,
`dist/*.zip` and `dist/SHA256SUMS.txt` with 30-day retention.

---

## 3. `release.yml` — release

**Manual only, by design.** A diagnostic tool released straight from a green pipeline
encourages releases nobody has read. This one requires a person to type a version:

```bash
gh workflow run release.yml -f version=1.0.0
```

Steps:

1. Refuse if the tag already exists.
2. Write the version into `package.json`.
3. `npm ci`, then **`npm test` must pass** — publishing is blocked by a failing test.
4. `npm run check`.
5. `npm run build:win`.
6. `npm run verify:artifacts`.
7. Tag, push the tag, and create the GitHub release with the installer, the portable
   build and `SHA256SUMS.txt`.

The release notes are generated in the workflow and lead with the unsigned status:

> **This build is unsigned.** No code-signing certificate is available for this project,
> so the installer and executables are unsigned. Windows SmartScreen will show a warning
> on first run.

They also tell the user how to verify the download (`Get-FileHash … -Algorithm SHA256`,
compared against `SHA256SUMS.txt`), and what a scan does and does not do.

---

## 4. Concurrency and permissions

- `concurrency: build-${{ github.ref }}` with `cancel-in-progress: true` — pushing twice
  to the same branch cancels the older run instead of queueing it.
- `permissions: contents: read` for the build workflow; `contents: write` only for the
  release workflow, which must create a tag and a release.

No workflow stores a credential. The release uses the automatically provided
`GITHUB_TOKEN`.

---

## 5. What the workflows deliberately do not do

| Not done | Why |
| --- | --- |
| Sign the build | No certificate exists. A self-signed certificate would be theatre. |
| Publish to a package registry | The product is a desktop installer, not a library. |
| Upload telemetry from CI | There is no telemetry anywhere in this project. |
| Auto-release on tag | Releases require a version to be typed and verification to be read. |
| Build for ARM64 | Untested behaviour is not published as a supported artifact. |

---

## 6. Reproducing a CI run locally

Everything the workflows do can be run here, except the Windows packaging step:

```bash
npm ci
npm run check
npm run audit:requirements -- --check
npm test
npm run icon
```

`npm run build:win` requires a Windows host (or Wine plus the NSIS toolchain), neither of
which is available in the development container this project was written in. That is
precisely why the packaging step is a CI job and not a local one.

---

## 7. Adding a workflow

If you add one, add it here too. `tests/integration/docs.test.js` verifies that every
document in `docs/` is referenced from the README or `REQUIREMENTS.md`, so an undocumented
workflow is not a failure — but an undocumented **claim** about a workflow is exactly the
kind of drift this project's documentation tests exist to prevent.
