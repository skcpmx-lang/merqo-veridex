/**
 * VERIDEX — electron binary locator.
 *
 * `npm install` skips Electron's binary download in this project, because the development
 * environment cannot reach the release host. That means `require('electron')` exports a
 * path string that does not exist, and every attempt to launch the app fails with a
 * confusing ENOENT much later.
 *
 * This module resolves the binary once, with a message that says what is actually wrong.
 * Run as a script it prints the path, which is what the CI steps consume:
 *
 *   node scripts/electron-path.mjs          → prints the executable path
 *   node scripts/electron-path.mjs --check  → exits 1 with an explanation if absent
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @returns {{ok: true, path: string, version: string} | {ok: false, reason: string}}
 */
export function findElectron() {
  let entry;
  try {
    entry = require('electron');
  } catch (error) {
    // `require('electron')` throws a download error when the binary is missing, and the
    // message it throws suggests running the very command that just failed. Say what is
    // true instead: something needs a network this machine does not have.
    const raw = error instanceof Error ? error.message : String(error);
    if (/download|fetch|ENOTFOUND|ECONN|install correctly/i.test(raw)) {
      return {
        ok: false,
        reason: 'electron is installed but its binary is not present, and fetching it failed (the release host is unreachable from here). Run "node node_modules/electron/install.js" on a machine with access to github.com.'
      };
    }
    return { ok: false, reason: `the electron package is not installed: ${raw}` };
  }

  let version = 'unknown';
  try {
    version = require('electron/package.json').version;
  } catch {
    /* version is informational */
  }

  if (typeof entry !== 'string') {
    // Newer Electron versions export the module API when required from the main process.
    // That only happens inside Electron itself, which is not where this runs.
    return { ok: false, reason: 'require("electron") did not return a path — the binary is not installed' };
  }
  if (!existsSync(entry)) {
    return {
      ok: false,
      reason: `electron ${version} is installed but its binary was never downloaded (expected at ${entry}). Run "node node_modules/electron/install.js" on a machine that can reach the release host.`
    };
  }
  return { ok: true, path: entry, version };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const found = findElectron();
  if (found.ok) {
    if (!process.argv.includes('--check')) console.log(found.path);
    else console.log(`electron ${found.version} at ${found.path}`);
  } else {
    console.error(`No Electron binary: ${found.reason}`);
    process.exitCode = 1;
  }
}
