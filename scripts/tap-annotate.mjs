#!/usr/bin/env node
/**
 * Turn a TAP stream into GitHub annotations, with the failure detail attached.
 *
 * The first version of this lived in the workflow as an awk one-liner. It attached only the
 * `error:` line and dropped the indented block under it — which is where the actual message
 * is — and it silently produced nothing at all when the terminator was indented. A check
 * that reports a failure without its reason is the reason this project now runs a smoke test
 * against real interfaces; the same standard applies to the tooling.
 *
 *   node scripts/tap-annotate.mjs < tap.tap        # writes ::error commands to stdout
 *   node scripts/tap-annotate.mjs --summary < tap.tap
 *
 * @module
 */

const MAX_DETAIL = 900;

/**
 * Parse a `not ok` block's YAML-ish diagnostics.
 * @param {string[]} lines
 * @returns {{name:string, detail:string}}
 */
function parseFailure(lines) {
  const name = lines[0].replace(/^not ok\s+\d+\s*-\s*/, '').trim();
  const details = [];
  let readingError = false;

  for (const raw of lines.slice(1)) {
    const line = raw.trimEnd();
    if (/^\s*\.\.\.\s*$/.test(line)) break;
    if (/^\s*---\s*$/.test(line)) continue;

    // `error: |-` starts a block scalar whose body is the useful part.
    const errorStart = /^\s*error:\s*\|-?\s*$/.exec(line);
    if (errorStart) {
      readingError = true;
      continue;
    }
    if (readingError) {
      if (/^\s+(.*\S)\s*$/.test(line)) {
        details.push(line.trim());
        continue;
      }
      readingError = false;
    }
    const inlineError = /^\s*error:\s*(.+)$/.exec(line);
    if (inlineError) {
      details.push(inlineError[1].trim());
      continue;
    }
    const other = /^\s*(expected|actual|code|failureType):\s*(.+)$/.exec(line);
    if (other) details.push(`${other[1]}=${other[2].trim()}`);
  }

  const detail = details.join(' | ').replace(/[%\r\n]+/g, ' ').slice(0, MAX_DETAIL);
  return { name, detail };
}

/**
 * @param {string} text Full TAP output.
 * @returns {Array<{name:string, detail:string}>}
 */
export function parseTapFailures(text) {
  const lines = text.split(/\r?\n/);
  const failures = [];
  let current = null;

  for (const line of lines) {
    if (/^not ok\b/.test(line)) {
      if (current) failures.push(parseFailure(current));
      current = [line];
      continue;
    }
    if (current) {
      if (/^ok\b|^# /.test(line) && !/^\s/.test(line)) {
        failures.push(parseFailure(current));
        current = null;
        continue;
      }
      current.push(line);
    }
  }
  if (current) failures.push(parseFailure(current));
  return failures;
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const failures = parseTapFailures(Buffer.concat(chunks).toString('utf8'));

if (process.argv.includes('--summary')) {
  const counts = /^# (tests|pass|fail) (\d+)$/gm;
  const text = Buffer.concat(chunks).toString('utf8');
  const totals = {};
  let match;
  while ((match = counts.exec(text)) !== null) totals[match[1]] = Number(match[2]);
  console.log(`${failures.length} failing test(s); totals ${JSON.stringify(totals)}`);
} else {
  for (const failure of failures) {
    const message = `${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}`;
    console.log(`::error title=Test failed::${message}`);
  }
  if (failures.length === 0) console.log('::notice title=Tests::no failing tests in the TAP output');
}
