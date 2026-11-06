#!/usr/bin/env node
/**
 * VERIDEX — release artifact verification.
 *
 * Run after `npm run build:win`. It does not trust electron-builder's exit code:
 * it inspects the files that actually landed on disk and checks them against the
 * version in package.json.
 *
 * It verifies:
 *   - the installer exists, is a PE executable, and has a plausible size;
 *   - the portable build exists and is a readable zip containing the app;
 *   - every artifact has a SHA-256 recorded in `dist/SHA256SUMS.txt`;
 *   - the checksums in that file match a fresh digest of the files;
 *   - the code-signing state is *reported honestly*: unsigned is expected here and
 *     is recorded as such, never glossed over.
 *
 * Exit code is non-zero when a required artifact is missing or a digest mismatches.
 * It cannot verify that the EXE runs — that requires a Windows machine, and the
 * report says so instead of implying otherwise.
 */

import { readdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// `--dist <path>` lets the verification logic be tested against a fixture directory.
// Without it there is no way to exercise this script except by producing a real Windows
// build, which is exactly how a wrong assumption in it survived to CI.
const distArgIndex = process.argv.indexOf('--dist');
const DIST = distArgIndex > -1 && process.argv[distArgIndex + 1]
  ? path.resolve(process.argv[distArgIndex + 1])
  : path.join(ROOT, 'dist');
const sumsPath = path.join(DIST, 'SHA256SUMS.txt');

const findings = [];

/** @param {'ok'|'warn'|'fail'} level @param {string} message */
function note(level, message) {
  findings.push({ level, message });
}

async function sha256(file) {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = manifest.version;

  let entries;
  try {
    entries = await readdir(DIST);
  } catch {
    console.error(`No dist/ directory at ${DIST}. Run "npm run build:win" first.`);
    process.exitCode = 1;
    return;
  }

  const exeFiles = entries.filter((name) => name.toLowerCase().endsWith('.exe'));
  const zipFiles = entries.filter((name) => name.toLowerCase().endsWith('.zip'));

  // Record what is actually in dist/ before judging it. When a check fails, the log
  // should show what the build produced instead of only what it did not.
  note('ok', `dist/ contains ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: ${entries.join(', ') || '(empty)'}`);

  // ── Installer ──────────────────────────────────────────────────────────────
  // The installer must be identified by its name. An earlier version fell back to
  // "the first .exe in the directory", which meant that if the NSIS build failed but the
  // portable build succeeded, verification picked up the portable, called it the
  // installer, and passed — shipping a release with no installer in it.
  const installer = exeFiles.find((name) => /setup|install/i.test(name)) ?? null;
  if (!installer) {
    note('fail', `No installer .exe was produced by the build (looked for a name matching "setup" or "install"; found: ${exeFiles.join(', ') || 'no .exe files'}).`);
  } else {
    const info = await stat(path.join(DIST, installer));
    const handle = await open(path.join(DIST, installer), 'r');
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    await handle.close();

    if (header.toString('latin1') !== 'MZ') {
      note('fail', `${installer} is not a Windows executable (missing MZ header).`);
    } else {
      note('ok', `${installer} is a Windows executable, ${(info.size / 1_048_576).toFixed(1)} MiB.`);
    }
    if (info.size < 20 * 1_048_576) {
      note('warn', `${installer} is only ${(info.size / 1_048_576).toFixed(1)} MiB. A full Electron runtime plus the app is normally larger, so this build may be missing content.`);
    }
  }

  // ── Portable build ─────────────────────────────────────────────────────────
  //
  // electron-builder's `portable` target produces a **single .exe**, not a zip. This
  // script used to demand a .zip and therefore failed a build that had succeeded: the
  // Windows job built both artifacts, then rejected them. Accepting either form - and
  // saying which was found - is the correct check. A zip is still accepted because the
  // target can be configured that way and a future change should not silently regress.
  const portableCandidates = [...exeFiles, ...zipFiles].filter((name) => /portable/i.test(name));
  const portable = portableCandidates[0] ?? null;

  if (!portable) {
    note('fail', 'No portable build was produced by the build (expected a "portable" .exe or .zip).');
  } else if (portable.toLowerCase().endsWith('.exe')) {
    const info = await stat(path.join(DIST, portable));
    const handle = await open(path.join(DIST, portable), 'r');
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    await handle.close();
    if (header.toString('latin1') !== 'MZ') {
      note('fail', `${portable} is not a Windows executable (missing MZ header).`);
    } else {
      note('ok', `${portable} is a Windows executable (portable target), ${(info.size / 1_048_576).toFixed(1)} MiB.`);
    }
  } else {
    const info = await stat(path.join(DIST, portable));
    const handle = await open(path.join(DIST, portable), 'r');
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    await handle.close();
    // PK\x03\x04 (or PK\x05\x06 for an empty archive).
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      note('fail', `${portable} is not a zip archive (bad signature).`);
    } else {
      note('ok', `${portable} is a zip archive, ${(info.size / 1_048_576).toFixed(1)} MiB.`);
    }
  }

  // ── Version consistency ────────────────────────────────────────────────────
  for (const name of [...exeFiles, ...zipFiles]) {
    if (!name.includes(version)) {
      note('warn', `${name} does not contain the package version "${version}". Check that the build used the current manifest.`);
    }
  }

  // ── Checksums ──────────────────────────────────────────────────────────────
  const artifacts = [...exeFiles, ...zipFiles];
  if (artifacts.length === 0) {
    note('fail', 'No artifacts to checksum.');
  } else {
    for (const name of artifacts) {
      const digest = await sha256(path.join(DIST, name));
      note('ok', `sha256(${name}) = ${digest}`);

      let recorded = null;
      try {
        const sums = await readFile(sumsPath, 'utf8');
        const line = sums.split('\n').find((entry) => entry.trim().endsWith(name));
        recorded = line ? line.trim().split(/\s+/)[0] : null;
      } catch {
        recorded = null;
      }

      if (recorded === null) {
        note('warn', `${name} has no entry in SHA256SUMS.txt; adding it.`);
        const existing = await readFile(sumsPath, 'utf8').catch(() => '');
        const updated = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${digest}  ${name}\n`;
        await writeFile(sumsPath, updated, 'utf8');
      } else if (recorded !== digest) {
        note('fail', `${name}: SHA-256 mismatch. Recorded ${recorded}, actual ${digest}. The artifact changed after checksumming.`);
      }
    }
  }

  // ── Signing state, reported honestly ───────────────────────────────────────
  note(
    'warn',
    'Code signing: VERIDEX is built unsigned. No certificate is available for this project, so Windows SmartScreen will show "Windows protected your PC" / "Unknown Publisher" on first run of the installer. SHA-256 checksums above let a user confirm the download matches what was published; they do not replace signing.'
  );

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`VERIDEX artifact verification — version ${version}`);
  console.log(`  ${DIST}`);
  console.log('');
  for (const finding of findings) {
    console.log(`${finding.level === 'fail' ? 'FAIL' : finding.level === 'warn' ? 'WARN' : '  ok'}  ${finding.message}`);
  }

  const failures = findings.filter((finding) => finding.level === 'fail');
  console.log('');
  console.log(
    failures.length === 0
      ? 'Artifacts are present, internally consistent and checksummed.'
      : `${failures.length} blocking problem(s) with the release artifacts.`
  );
  console.log(
    'NOT VERIFIED HERE: that the installer runs, installs and launches on Windows. That requires a real Windows machine and is recorded separately in docs/RELEASE_VERIFICATION.md.'
  );

  if (failures.length > 0) process.exitCode = 1;
}

await main();
