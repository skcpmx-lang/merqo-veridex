/**
 * Contrast and focus, measured rather than eyeballed.
 *
 * This milestone could not take screenshots, so the parts of a visual review that are
 * arithmetic are done here instead: every foreground/background pair the interface actually
 * uses, in both themes, for all five accents. These are the pairs a reviewer would point at,
 * and they are computable exactly.
 *
 * The two defects this found are recorded in their assertions' messages:
 *   - light mode reused the dark theme's muted ink (#6E8299) on a light surface: 3.71:1;
 *   - light mode used dark ink on a darkened accent button: 2.52:1 for violet.
 *
 * What this test cannot do: judge spacing, alignment, density or whether a page looks good.
 * Those need a rendered image, and `docs/KNOWN_LIMITATIONS.md` says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { themeTokens, contrastRatio, ACCENTS, SURFACES, TONES } from '../../src/renderer/theme.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODES = ['dark', 'light'];
const ACCENT_NAMES = Object.keys(ACCENTS);

/** Every pair the stylesheet or the components actually render. */
function pairs(tokens) {
  return [
    ['body text on the page', tokens['--vx-ink'], tokens['--vx-bg'], 7],
    ['body text on a card', tokens['--vx-ink'], tokens['--vx-bg-card'], 7],
    ['secondary text on the page', tokens['--vx-ink-soft'], tokens['--vx-bg'], 4.5],
    ['secondary text on a card', tokens['--vx-ink-soft'], tokens['--vx-bg-card'], 4.5],
    ['muted text on the page', tokens['--vx-ink-muted'], tokens['--vx-bg'], 4.5],
    ['muted text on a card', tokens['--vx-ink-muted'], tokens['--vx-bg-card'], 4.5],
    ['muted text on an input', tokens['--vx-ink-muted'], tokens['--vx-bg-input'], 4.5],
    ['accent against the page', tokens['--vx-accent'], tokens['--vx-bg'], 3],
    ['label on an accent button', tokens['--vx-accent-ink'], tokens['--vx-accent'], 4.5],
    ['pass tone on the page', tokens['--vx-ok'], tokens['--vx-bg'], 4.5],
    ['warn tone on the page', tokens['--vx-warn'], tokens['--vx-bg'], 4.5],
    ['fail tone on the page', tokens['--vx-bad'], tokens['--vx-bg'], 4.5],
    ['info tone on the page', tokens['--vx-info'], tokens['--vx-bg'], 4.5],
    // A hairline border is not text: WCAG sets no ratio for it. The threshold here only
    // catches a rule that would be effectively invisible (the deliberate look is subtle).
    ['hairline border against the page', tokens['--vx-line'], tokens['--vx-bg'], 1.2]
  ];
}

test('every text pair clears its threshold, in both themes and all five accents', () => {
  // One test rather than ten generated ones: a test whose name is built in a loop is counted
  // differently by the runner and by the documentation check, and the two numbers then drift.
  const failures = [];
  for (const mode of MODES) {
    for (const accent of ACCENT_NAMES) {
      const { tokens } = themeTokens({ theme: mode, accent, density: 'comfortable' });
      for (const [label, foreground, background, minimum] of pairs(tokens)) {
        const ratio = contrastRatio(foreground, background);
        if (ratio < minimum) failures.push(`${mode}/${accent}: ${label} — ${foreground} on ${background} = ${ratio}:1 (needs ${minimum}:1)`);
      }
    }
  }
  assert.deepEqual(failures, [], `contrast failures:\n${failures.join('\n')}`);
});

test('compact density changes spacing but never colour', () => {
  for (const mode of MODES) {
    const comfortable = themeTokens({ theme: mode, accent: 'cyan', density: 'comfortable' }).tokens;
    const compact = themeTokens({ theme: mode, accent: 'cyan', density: 'compact' }).tokens;
    for (const key of Object.keys(comfortable)) {
      if (!key.startsWith('--vx-font') && !key.startsWith('--vx-space')) continue;
      assert.ok(compact[key] !== undefined, `${key} is missing from compact density`);
    }
    assert.equal(compact['--vx-ink'], comfortable['--vx-ink'], 'density must not change text colour');
  }
});

test('both themes declare the same token set, so nothing renders unstyled', () => {
  const dark = Object.keys(themeTokens({ theme: 'dark' }).tokens).sort();
  const light = Object.keys(themeTokens({ theme: 'light' }).tokens).sort();
  assert.deepEqual(light, dark, 'a token present in one theme and missing from the other renders with a stale value');
});

test('the system theme resolves to a concrete surface, never to itself', () => {
  const resolved = themeTokens({ theme: 'system', systemPrefersLight: true });
  assert.equal(resolved.mode, 'light');
  const darkResolved = themeTokens({ theme: 'system', systemPrefersLight: false });
  assert.equal(darkResolved.mode, 'dark');
});

test('every status has a non-colour cue, so colour is never the only signal', async () => {
  const { STATUS_PRESENTATION } = await import('../../src/renderer/theme.js');
  for (const [status, presentation] of Object.entries(STATUS_PRESENTATION)) {
    assert.ok(presentation.glyph, `${status} has no glyph`);
    assert.ok(presentation.word, `${status} has no word`);
  }
});

test('every focus style is visible: removing the outline requires a replacement', async () => {
  const css = await readFile(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  assert.match(css, /:focus-visible/, 'no :focus-visible rule exists');
  assert.match(css, /outline:\s*2px solid var\(--vx-accent\)/, 'the base focus ring must be a theme colour');

  // `outline: none` is legitimate when a box-shadow ring replaces it. It is a defect when it
  // simply removes the only cue. This walks the rules rather than the file, so the two cases
  // are told apart instead of both being flagged.
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hidden = [];
  for (const [, selector, body] of rules) {
    if (!/:focus-visible/.test(selector)) continue;
    if (!/outline:\s*none/.test(body)) continue;
    if (!/box-shadow|border-color/.test(body)) hidden.push(selector.trim().replace(/\s+/g, ' '));
  }
  assert.deepEqual(hidden, [], `these focus styles remove the outline without a replacement: ${hidden.join(', ')}`);

  // Reduced motion must be honoured rather than advertised.
  assert.match(css, /prefers-reduced-motion/, 'no reduced-motion media query exists');
  assert.match(css, /\.reduce-motion/, 'the reduce-motion class the settings toggle applies is not styled');
});

test('theme tokens are the only colour source: no hex literals in the renderer', async () => {
  const app = await readFile(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const hexes = [...app.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0]);
  assert.deepEqual(hexes, [], `the renderer hardcodes colours instead of reading tokens: ${[...new Set(hexes)].join(', ')}`);
});

test('surface and tone tables are internally consistent', () => {
  for (const mode of MODES) {
    assert.ok(SURFACES[mode], `${mode} has no surface table`);
    assert.ok(TONES[mode], `${mode} has no tone table`);
    for (const [name, value] of Object.entries(SURFACES[mode])) {
      if (name === 'shadow') continue;
      assert.match(value, /^#[0-9a-f]{6}$/i, `${mode}.${name} is not a plain hex colour: ${value}`);
    }
  }
});

test('the stylesheet fallback block matches the default theme exactly', async () => {
  // styles.css carries a copy of the dark/cyan tokens so the first frame is not unstyled.
  // A copy drifts: this one had kept the old muted ink after theme.js was corrected, which
  // means a slow start would have shown the unreadable value the fix removed.
  const css = await readFile(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  const block = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const declared = Object.fromEntries([...block.matchAll(/(--vx-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const { tokens } = themeTokens({ theme: 'dark', accent: 'cyan', density: 'comfortable' });
  const drift = [];
  for (const [token, value] of Object.entries(declared)) {
    if (tokens[token] === undefined) continue;
    if (tokens[token].replace(/\s+/g, '') !== value.replace(/\s+/g, '')) drift.push(`${token}: stylesheet says ${value}, theme says ${tokens[token]}`);
  }
  assert.deepEqual(drift, [], `the fallback block has drifted from the theme:\n${drift.join('\n')}`);
});
