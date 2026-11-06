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
| [`42154677493`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42154677493) | push | ✅ GUI 13 steps, install 17 checks, portable 10 checks, 0 problems |
| [`42157700654`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42157700654) | pull request | ❌ package job: two gui-smoke problems (tour missing, report label) — both real, both fixed |
| [`42158921882`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42158921882) | pull request | ✅ both fixes confirmed on Windows: GUI 19 steps, install 18 checks, portable 10 checks, 0 problems |
| [`42160034210`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42160034210) | pull request | ✅ final tree: GUI 19 steps, install 17 checks, portable 10 checks, 0 problems, and the "setting rejected" warning is gone |
| [`42167493342`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42167493342) | push (design evidence) | ❌ the window never booted: 2 screenshots, no navigation, no tour. Cause: the renderer imported the logger two levels down and a sandboxed renderer cannot resolve `node:*` |
| [`42169801753`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42169801753) | push (design evidence) | ✅ 21 steps, 32 screenshots, 0 problems — first run with the boot fix and the imported-graph test |
| [`42172738818`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42172738818) | push | ✅ Linux and Windows: 725 tests, static checks clean |
| [`42172738822`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42172738822) | push (design evidence) | ✅ 21 steps, 32 screenshots, 0 problems, including the populated pages |
| [`42179901603`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42179901603) | push | ❌ Linux and Windows: Windows failed, and the annotation said "no failing tests" — the annotation script only matched `not ok` at column zero, and the real failure was the new formatting rule meeting a checkout that had converted 145 files to CRLF |
| [`42182778326`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42182778326) | push | ✅ Linux and Windows: 881 tests, static checks 0/0, licence audit clean, live platform smoke on real WMI (1,094 fields, 19 modules, score 84, 75 % coverage) |
| [`42184099160`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42184099160) | push (design evidence) | ❌ new step threw "Script failed to execute": a backslash-n inside a template literal arrived at the renderer as a real newline in a regex |
| [`42184459268`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42184459268) | push (design evidence) | ✅ 23 steps, 34 screenshots, 0 problems — includes the memory, GPU and responsiveness cards and the arrangement editor |
| [`42185390234`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42185390234) | push (design evidence) | ✅ 23 steps, 34 screenshots, 0 problems, and the memory card's consent row now reads correctly |
| [`42186269187`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42186269187) | pull request | ✅ Linux and Windows tests, static checks, and **the Windows package job**: installer and portable built, artifact verification, package validation and the unpacked GUI smoke test all passed. The artifacts themselves could not be downloaded here — `gh run download` needs `*.blob.core.windows.net`, outside this environment's egress (`EOF`) — so this tree has a build but no hash |
| [`42187908032`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42187908032) | pull request | ✅ Linux and Windows tests (878), static checks, and the package job: installer **installed, launched and uninstalled**, portable launched, unpacked build driven through the GUI smoke test. Artifact metadata read through the REST API: `veridex-windows`, 234,992,960 bytes, digest `sha256:74e1d5ec…a801` (an archive digest, not an executable hash). Superseded by `42194144517`, whose bytes differ — as they must |
| [`42192434597`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42192434597) | push (design evidence) | ✅ 23 steps, 35 screenshots, 0 problems — adds the window-placement step: `window 1024x720 at 0,0; display 1024x768 at 100 %, work area 1024x720; overflow {0,0,0,0}` |
| [`42194144517`](https://github.com/skcpmx-lang/merqo-veridex/actions/runs/42194144517) | pull request | ✅ all five checks: Linux and Windows tests, static checks, and the package job for commit `29c7a32` — installer installed/launched/uninstalled, portable launched. `veridex-windows` is 234,987,522 bytes, digest `sha256:3598b478…91ec` (archive digest, not an executable hash) |


---

## State after the merge

Pull request #1 was merged into `main` on 2026-11-06 (`2b71668`, the merge commit of `4e1ffc3`).
That closed the first of the two release blockers: the **Release** workflow is now registered
(`409192902`), because a `workflow_dispatch` workflow only becomes dispatchable once it exists on
the default branch. Its package job then ran on `main` and reported
`install-smoke: 18 check(s) passed · 0 problem(s)` and
`portable-smoke: 10 check(s) passed · 0 problem(s)`, with the installed build rendering all 18
pages and logging its window placement.

The second blocker remains and it is a permission, not a bug: this session's GitHub App
installation can read Actions and cannot write to them, so
`POST /repos/…/actions/workflows/409192902/dispatches` answers
`403 Resource not accessible by integration`. Everything the workflow does after that point —
build, test, verify, tag, publish — uses the repository's own `GITHUB_TOKEN`, so a single
human click on *Run workflow* is the whole remaining gate.

---
## Why `release.yml` cannot be dispatched from an agent session

Two independent causes, both verified on 2026-11-06 rather than assumed:

| Probe | Answer | Cause |
| --- | --- | --- |
| `gh workflow run release.yml --ref <branch>` | `HTTP 404: Not Found (/actions/workflows/release.yml)` | `release.yml` has never existed on `main`. GitHub only registers a `workflow_dispatch` workflow that is present on the default branch, and `GET /actions/workflows` returns two workflows: `build.yml` and `ui-evidence.yml`. Nothing is wrong with the file |
| `POST /actions/workflows/build.yml/dispatches` | `403 {"message":"Resource not accessible by integration"}` | the session's credential is a GitHub App installation token (empty `X-OAuth-Scopes`, `X-Accepted-OAuth-Scopes` empty, `github-authentication` headers present). Dispatching needs the installation to hold **Actions: write**; it holds Actions read, which is enough to list runs and artifacts and not enough to start one |

**Minimum change for an owner who wants an agent (or a bot) to dispatch:** give the App
installation `Actions: write` on this repository only — no `Contents: write`, no
`Administration`, no org-wide grant. A person does not need that at all: the *Run workflow*
button needs ordinary repository write access, and `release.yml` becomes dispatchable the moment
it exists on `main`.

Nothing here was bypassed: no token was inspected beyond its public response headers, no
permission was escalated, and no dispatch was faked.

Before run 42013425380 the workflow had been **failing on every push since it was added**,
and this document incorrectly said it had not run at all. That was wrong in a way worth
recording: the workflow existed, executed, and failed, while the documentation asserted
silence. The failures were real and only visible on Windows — see the commit history for
`ci: replace fixed sleeps with condition polling` and `fix(test): remove two host-dependent
assumptions`.

### 1.1 Reading a run's evidence when the log cannot be downloaded

A CI log and an artifact are not the only things a run publishes. Every `::notice`,
`::warning` and `::error` the harnesses print becomes an annotation on the commit's check
run, and the annotations API answers when `gh run view --log-failed`, `gh run download` and
blob storage do not:

```bash
# every check run for a commit, with its id
gh api repos/skcpmx-lang/merqo-veridex/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.id) \(.name) \(.conclusion)"'

# what that run said, in its own words
gh api repos/skcpmx-lang/merqo-veridex/check-runs/<id>/annotations \
  --jq '.[] | "[\(.annotation_level)] \(.title): \(.message)"'
```

This is not a workaround for a broken workflow; it is the intended reading path for a build
nobody can attach to. `scripts/tap-annotate.mjs` turns test failures into annotations, and
the GUI, portable and install harnesses emit one per finding, precisely so that the answer
is available without the log. Two failures in this repository were found this way and
nowhere else — neither reproduces under jsdom:

- the first-run tour never appearing, because `createWindow()` ran before
  `registerHandlers()` and a fast renderer invoked a channel with no handler;
- the report preview "missing" its `Evidence fields` label, because `innerText` returns text
  as rendered and `text-transform: uppercase` changed it.

Artifacts (`veridex-gui-evidence`, the installers) may still be unreachable from a machine
whose network policy stops at the storage host. That is a limitation of where the reader is
sitting, not of the run; say so, rather than claiming the screenshots were reviewed.

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
npm run check                            # scripts/check.mjs — parse, imports, entry points,
                                         # offline, settings, requirements, cycles, formatting
node scripts/check.mjs --only formatting  # the formatting policy, named as its own step
node scripts/check.mjs --only cycles      # the dependency graph, named as its own step
npm run audit:requirements -- --check    # refuses inconsistent claim statuses
```

The two `--only` steps run the whole gate and print one area, so a red build names the rule
that failed instead of asking a reader to scan nine sections for the one `FAIL` line.

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

Measured on `windows-latest`: **117.5 MiB installer, 106.5 MiB portable**. The GUI sweep takes
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
node scripts/check.mjs --only formatting
node scripts/check.mjs --only cycles
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
