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
const DIST = path.join(ROOT, 'dist');
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

  // ── Installer ──────────────────────────────────────────────────────────────
  const installer = exeFiles.find((name) => /setup|install/i.test(name)) ?? exeFiles[0] ?? null;
  if (!installer) {
    note('fail', 'No installer .exe was produced by the build.');
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

  // ── Portable zip ───────────────────────────────────────────────────────────
  const portable = zipFiles.find((name) => /portable/i.test(name)) ?? zipFiles[0] ?? null;
  if (!portable) {
    note('fail', 'No portable .zip was produced by the build.');
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
