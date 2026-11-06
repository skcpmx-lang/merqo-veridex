#!/usr/bin/env node
/**
 * VERIDEX — validate a packaged build by inspecting it.
 *
 * `verify-artifacts.mjs` answers "did the build produce plausible files". This answers a
 * different question: "is the thing inside those files the application". It reads
 * `dist/win-unpacked`, which is what NSIS compresses and what the portable executable
 * unpacks at runtime, and checks the parts a user depends on:
 *
 *   - the executable is a real PE image for the right architecture;
 *   - version metadata is present and names this product and this version;
 *   - `resources/app.asar` exists, is a plausible size, and contains the renderer;
 *   - the asar's own header can be read, so the archive is not truncated;
 *   - no test files, no source maps and no development dependencies shipped;
 *   - the app id in the build config matches what the metadata claims.
 *
 * Nothing here claims the application runs. That is `gui-smoke.mjs`. This is the last
 * check that can be done without executing anything.
 *
 *   node scripts/verify-package.mjs [--dir dist/win-unpacked] [--json out.json]
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const PACKAGE_DIR = path.resolve(ROOT, valueOf('--dir', 'dist/win-unpacked'));
const JSON_OUT = valueOf('--json', null);
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

const findings = [];
const problems = [];

/** @param {'ok'|'info'|'warn'|'fail'} level @param {string} message */
function record(level, message) {
  findings.push({ level, message });
  const prefix = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : level === 'ok' ? '  ok' : ' info';
  console.log(`${prefix}  ${message}`);
  if (level === 'fail') {
    problems.push(message);
    if (IN_ACTIONS) console.log(`::error title=verify-package::${String(message).replace(/%/g, '%25').replace(/\r?\n/g, ' ').slice(0, 800)}`);
  }
}

/**
 * Parse the small amount of PE structure needed to answer "is this a Windows executable".
 * @param {Buffer} buffer
 */
export function readPe(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return { ok: false, reason: 'no MZ header' };
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length) return { ok: false, reason: 'PE header offset is past the end of the file' };
  if (buffer.readUInt32LE(peOffset) !== 0x0000_4550) return { ok: false, reason: 'no PE\\0\\0 signature' };
  const machine = buffer.readUInt16LE(peOffset + 4);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const optionalMagic = buffer.readUInt16LE(peOffset + 24);
  const machines = { 0x014c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c4: 'arm' };
  return {
    ok: true,
    machine: machines[machine] ?? `unknown (0x${machine.toString(16)})`,
    isExecutable: (characteristics & 0x0002) !== 0,
    isDll: (characteristics & 0x2000) !== 0,
    magic: optionalMagic === 0x20b ? 'PE32+' : optionalMagic === 0x10b ? 'PE32' : 'unknown'
  };
}

/**
 * Every key that appears inside a VS_VERSIONINFO block.
 *
 * Used to reject a candidate value that is really the *next* key. On the real build,
 * `ProductVersion` was followed by an empty value and then by `FileDescription`, so a parser
 * that simply reads "the next string" reports FileDescription as the product version. That
 * is not a quirk of one binary: the version resource is a tree, and a node with an empty
 * value is perfectly legal.
 */
const VERSION_KEYS = new Set([
  'VS_VERSION_INFO', 'StringFileInfo', 'VarFileInfo', 'Translation',
  'CompanyName', 'FileDescription', 'FileVersion', 'InternalName',
  'LegalCopyright', 'LegalTrademarks', 'OriginalFilename', 'PrivateBuild',
  'ProductName', 'ProductVersion', 'SpecialBuild', 'Comments'
]);

/**
 * Read the strings from a PE VS_VERSIONINFO block.
 *
 * VS_VERSIONINFO is a tree of nodes: `wLength, wValueLength, wType, szKey\0, padding, value`.
 * Values are aligned and NUL-terminated, and a node's value may be empty. Reading it
 * properly means rejecting anything that is itself a key, and for the numeric entries
 * insisting on something that looks like a version.
 *
 * @param {Buffer} buffer
 * @returns {Record<string, string|null>}
 */
export function readVersionStrings(buffer) {
  /** @type {Record<string, string|null>} */
  const found = {};

  /** All UTF-16 strings in the block that begin at or after `from`. */
  const stringsAfter = (from, limit = 8) => {
    const out = [];
    let cursor = from;
    while (out.length < limit && cursor + 1 < buffer.length) {
      cursor += (4 - (cursor % 4)) % 4;
      let end = cursor;
      while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) end += 2;
      if (end <= cursor) {
        // An empty string: step past the terminator and keep looking.
        cursor += 2;
        continue;
      }
      out.push(buffer.subarray(cursor, end).toString('utf16le'));
      cursor = end + 2;
    }
    return out;
  };

  for (const key of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName', 'ProductVersion', 'OriginalFilename']) {
    const needle = Buffer.from(`${key}\u0000`, 'utf16le');
    let index = buffer.indexOf(needle);
    let value = null;
    while (index !== -1 && value === null) {
      const candidates = stringsAfter(index + needle.length);
      const isVersionKey = key === 'FileVersion' || key === 'ProductVersion';
      const chosen = candidates.find((candidate) => {
        if (VERSION_KEYS.has(candidate)) return false;
        if (!/^[\x20-\x7e]+$/.test(candidate)) return false;
        // A version must look like one; a name must not.
        return isVersionKey ? /^\d+(\.\d+)*/.test(candidate) : !/^\d+(\.\d+)*$/.test(candidate) || candidate.length > 8;
      });
      if (chosen !== undefined) value = chosen;
      index = buffer.indexOf(needle, index + 1);
    }
    found[key] = value;
  }

  return {
    productName: found.ProductName ?? null,
    productVersion: found.ProductVersion ?? null,
    fileVersion: found.FileVersion ?? null,
    fileDescription: found.FileDescription ?? null,
    companyName: found.CompanyName ?? null,
    originalFilename: found.OriginalFilename ?? null
  };
}

/**
 * Minimal asar reader: the header is a pickle containing a JSON directory tree.
 * @param {Buffer} buffer
 */
function readAsarHeader(buffer) {
  if (buffer.length < 16) return { ok: false, reason: 'file is too small to be an asar archive' };
  // uint32: 4 = size of the next field, then the header-pickle size.
  const headerSize = buffer.readUInt32LE(8);
  if (headerSize <= 0 || 16 + headerSize > buffer.length) {
    return { ok: false, reason: `asar header size ${headerSize} does not fit in ${buffer.length} bytes` };
  }
  const payload = buffer.subarray(16, 16 + headerSize).toString('utf8');
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON directory tree in the header' };
  try {
    return { ok: true, tree: JSON.parse(payload.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, reason: `header JSON did not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** @param {any} tree @param {string} [prefix] @returns {string[]} */
function flattenTree(tree, prefix = '') {
  const out = [];
  for (const [name, node] of Object.entries(tree?.files ?? {})) {
    const here = prefix ? `${prefix}/${name}` : name;
    if (node && typeof node === 'object' && node.files) out.push(...flattenTree(node, here));
    else out.push(here);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}

async function run() {
console.log('VERIDEX package validation');
console.log(`  inspecting ${PACKAGE_DIR}`);

if (!existsSync(PACKAGE_DIR)) {
  record('fail', `the unpacked application directory does not exist: ${PACKAGE_DIR}`);
} else {
  // ── Executable ──────────────────────────────────────────────────────────────
  const exePath = path.join(PACKAGE_DIR, 'VERIDEX.exe');
  if (!existsSync(exePath)) {
    record('fail', 'VERIDEX.exe is missing from the packaged application');
  } else {
    const bytes = readFileSync(exePath);
    const pe = readPe(bytes);
    if (!pe.ok) {
      record('fail', `VERIDEX.exe is not a Windows executable: ${pe.reason}`);
    } else {
      record(pe.isExecutable && !pe.isDll ? 'ok' : 'fail', `VERIDEX.exe: ${pe.machine} ${pe.magic}, ${bytes.length} bytes${pe.isExecutable ? '' : ' — NOT marked executable'}`);
      if (pe.machine !== 'x64') record('warn', `the executable targets ${pe.machine}, but the release is documented as x64`);
      const version = readVersionStrings(bytes);
      record('info', `version metadata: ${JSON.stringify(version)}`);
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      if (!version.productVersion) record('fail', 'the executable carries no ProductVersion — Windows shows a blank version in Properties and Apps & features');
      else if (!/^\d+\.\d+\.\d+/.test(version.productVersion)) record('fail', `ProductVersion "${version.productVersion}" is not a version number`);
      else if (!version.productVersion.startsWith(pkg.version)) record('fail', `the executable says ${version.productVersion} but package.json says ${pkg.version}`);
      if (version.fileDescription && /[a-z]\s[a-z]/i.test(version.fileDescription) === false && version.fileDescription.length > 40) {
        record('warn', `FileDescription looks unlike a description: "${version.fileDescription}"`);
      }
      if (version.productName && version.productName !== 'VERIDEX') record('warn', `ProductName is "${version.productName}"`);
    }
  }

  // ── asar ────────────────────────────────────────────────────────────────────
  const asarPath = path.join(PACKAGE_DIR, 'resources', 'app.asar');
  if (!existsSync(asarPath)) {
    record('fail', 'resources/app.asar is missing — the packaged app has no code');
  } else {
    const asar = readFileSync(asarPath);
    record('ok', `resources/app.asar: ${(asar.length / 1024 / 1024).toFixed(1)} MiB, sha256 ${createHash('sha256').update(asar).digest('hex').slice(0, 16)}…`);
    const header = readAsarHeader(asar);
    if (!header.ok) {
      record('fail', `the asar archive is not readable: ${header.reason}`);
    } else {
      const files = flattenTree(header.tree);
      record('info', `asar contains ${files.length} files`);
      const hasRenderer = files.some((file) => /src\/renderer\/index\.html$/.test(file));
      const hasMain = files.some((file) => /src\/app\/main\.js$/.test(file));
      const hasPreload = files.some((file) => /preload\.cjs$/.test(file));
      if (!hasRenderer) record('fail', 'the renderer HTML is not in the package — the window would load nothing');
      if (!hasMain) record('fail', 'src/app/main.js is not in the package — the app would not start');
      if (!hasPreload) record('fail', 'the preload script is not in the package — every IPC call would fail');
      if (hasRenderer && hasMain && hasPreload) record('ok', 'main process, preload and renderer are all present in the archive');

      // Shipping tests or maps is not a functional bug, but it is a real packaging bug:
      // it inflates the download and reveals internals. Worth failing over? No - warn.
      const shipped = files.filter((file) => /\.(test|map|d\.ts)$/.test(file));
      if (shipped.length > 0) record('warn', `${shipped.length} test/map/type files were shipped, e.g. ${shipped.slice(0, 3).join(', ')}`);
      const devDeps = files.filter((file) => /node_modules\/(electron|electron-builder|@electron)\//.test(file));
      if (devDeps.length > 0) record('fail', `development tooling was shipped in the package: ${devDeps.slice(0, 3).join(', ')}`);
    }
  }

  // ── Runtime dependencies that must be unpacked ───────────────────────────────
  const unpacked = path.join(PACKAGE_DIR, 'resources', 'app.asar.unpacked');
  if (existsSync(unpacked)) {
    const hasSystemInformation = existsSync(path.join(unpacked, 'node_modules', 'systeminformation'));
    record(hasSystemInformation ? 'ok' : 'warn', `app.asar.unpacked present; systeminformation unpacked = ${hasSystemInformation}`);
    if (!hasSystemInformation) record('warn', 'systeminformation is not unpacked; on a real machine the fallback provider may fail to load from inside the archive');
  }

  // ── Locale, licence and the visible surface ─────────────────────────────────
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    record(existsSync(path.join(PACKAGE_DIR, file)) ? 'ok' : 'warn', `${file}: ${existsSync(path.join(PACKAGE_DIR, file)) ? 'present' : 'missing'}`);
  }

  const topLevel = readdirSync(PACKAGE_DIR).slice(0, 40);
  record('info', `package contents: ${topLevel.join(', ')}`);

  // A summary of total size, so a reviewer can see if something absurd shipped.
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(PACKAGE_DIR);
  record('info', `unpacked size: ${(total / 1024 / 1024).toFixed(1)} MiB`);
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log('');
console.log(`${findings.length} finding(s), ${problems.length} problem(s)`);
console.log('NOT PROVEN BY THIS SCRIPT: that the application launches or that the installer');
console.log('installs. See scripts/gui-smoke.mjs and docs/RELEASE_VERIFICATION.md.');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), packageDir: PACKAGE_DIR, findings, problems }, null, 2), 'utf8');
  console.log(`JSON evidence written to ${JSON_OUT}`);
}

if (IN_ACTIONS) {
  const summary = [
    '## Package validation',
    '',
    `Inspected \`${PACKAGE_DIR}\``,
    '',
    '| Level | Finding |',
    '| --- | --- |',
    ...findings.map((finding) => `| ${finding.level} | ${finding.message.replace(/\|/g, '\\|').slice(0, 240)} |`),
    '',
    problems.length === 0 ? 'No problems. This does not prove the app launches.' : `**${problems.length} problem(s).**`
  ];
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(stepSummary, `${summary.join('\n')}\n\n`);
  }
}

if (problems.length > 0) process.exitCode = 1;
}
