/**
 * VERIDEX — theme tokens.
 *
 * The visual identity is data, not scattered hex codes: one accent is chosen in
 * settings and every component derives from it. Two accessibility rules are encoded
 * here rather than left to each component:
 *
 *   1. **Status is never colour alone.** Each status carries a glyph and a word, so
 *      the report reads correctly in greyscale, for colour-blind users, and when
 *      printed on a mono laser printer.
 *   2. **Contrast is checked, not assumed.** `contrastRatio` implements the WCAG
 *      formula and `themeAudit()` reports any pair below 4.5:1, which the test suite
 *      asserts is empty.
 *
 * The accent palettes were chosen against the navy surface and verified by that
 * audit; changing one without re-running the test fails the build.
 */

/** Five accent presets, each a hue family rather than a single colour. */
export const ACCENTS = Object.freeze({
  // `base` is tuned for the dark navy surface; `baseLight` is the same hue darkened
  // until it clears 3:1 against the light surface. The first draft used one colour
  // for both modes and cyan measured 1.7:1 on white — visible, but not readable.
  cyan: { label: 'Cyan', base: '#22D3EE', baseLight: '#0E7490', strong: '#0EA5C6', soft: '#7DE8F5', ink: '#04222B' },
  azure: { label: 'Azure', base: '#3B9BF5', baseLight: '#1D4ED8', strong: '#1F7AD6', soft: '#8FC6FA', ink: '#041A2E' },
  violet: { label: 'Violet', base: '#A78BFA', baseLight: '#6D28D9', strong: '#8B5CF6', soft: '#C9B8FD', ink: '#1B1035' },
  amber: { label: 'Amber', base: '#F5B942', baseLight: '#A16207', strong: '#D99A1F', soft: '#FAD68C', ink: '#2B1C02' },
  emerald: { label: 'Emerald', base: '#34D399', baseLight: '#047857', strong: '#10B981', soft: '#8CE8C2', ink: '#04261A' }
});

/** Status vocabulary to presentation. `glyph` is the non-colour cue. */
export const STATUS_PRESENTATION = Object.freeze({
  PASS: { label: 'Pass', glyph: '✓', tone: 'ok', word: 'Pass' },
  FAIL: { label: 'Fail', glyph: '✕', tone: 'bad', word: 'Fail' },
  WARNING: { label: 'Warning', glyph: '!', tone: 'warn', word: 'Warning' },
  PARTIALLY_AVAILABLE: { label: 'Partial', glyph: '◐', tone: 'warn', word: 'Partial' },
  UNKNOWN: { label: 'Unknown', glyph: '?', tone: 'muted', word: 'Unknown' },
  UNAVAILABLE: { label: 'Unavailable', glyph: '–', tone: 'muted', word: 'Unavailable' },
  UNSUPPORTED: { label: 'Unsupported', glyph: '∅', tone: 'muted', word: 'Unsupported' },
  UNTESTED: { label: 'Not run', glyph: '○', tone: 'muted', word: 'Not run' },
  UNRATED: { label: 'Unrated', glyph: '·', tone: 'muted', word: 'Unrated' },
  PERMISSION_REQUIRED: { label: 'Needs admin', glyph: '⚿', tone: 'info', word: 'Needs admin' },
  ERROR: { label: 'Error', glyph: '!', tone: 'bad', word: 'Error' },
  NOT_APPLICABLE: { label: 'Not applicable', glyph: '–', tone: 'muted', word: 'Not applicable' }
});

/** Dark and light surfaces. Both audited for contrast against the same ink. */
export const SURFACES = Object.freeze({
  dark: {
    bg: '#0A1220',
    bgRaised: '#0F1B2E',
    bgCard: '#122032',
    bgInput: '#0C1728',
    line: '#1E2E45',
    lineSoft: '#182739',
    ink: '#E8F1FA',
    inkSoft: '#9FB2C8',
    inkMuted: '#6E8299',
    shadow: 'rgba(3, 8, 16, 0.55)'
  },
  light: {
    bg: '#F5F8FC',
    bgRaised: '#FFFFFF',
    bgCard: '#FFFFFF',
    bgInput: '#EEF3F9',
    line: '#D3DEEC',
    lineSoft: '#E4ECF5',
    ink: '#0A1220',
    inkSoft: '#4A5B70',
    inkMuted: '#6E8299',
    shadow: 'rgba(10, 18, 32, 0.12)'
  }
});

/** Semantic tones for status and severity. */
export const TONES = Object.freeze({
  dark: { ok: '#4ADE80', warn: '#FBBF24', bad: '#F87171', info: '#7DD3FC', muted: '#8CA0B8' },
  light: { ok: '#15803D', warn: '#B45309', bad: '#B91C1C', info: '#0369A1', muted: '#5B6B80' }
});

/** Spacing and radii, in px, so density switching is a single multiplier. */
export const METRICS = Object.freeze({
  radius: { sm: 6, md: 10, lg: 14, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 18, xl: 26 },
  density: { comfortable: 1, compact: 0.72 },
  font: {
    ui: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    mono: '"Cascadia Mono", "Consolas", ui-monospace, monospace',
    size: { xs: 11, sm: 12, md: 13, lg: 16, xl: 22, display: 34 }
  }
});

/** WCAG relative luminance of a hex colour. */
export function luminance(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map((character) => character + character).join('') : value;
  const channels = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * WCAG contrast ratio between two colours, 1..21.
 * @param {string} a @param {string} b
 */
export function contrastRatio(a, b) {
  const one = luminance(a);
  const two = luminance(b);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/**
 * Build the CSS custom properties for a theme. The renderer writes these onto
 * `:root`, so every component reads tokens and none hardcodes a colour.
 * @param {{theme?: 'dark'|'light'|'system', accent?: keyof typeof ACCENTS, density?: 'comfortable'|'compact', reduceMotion?: boolean, showGlyphs?: boolean, systemPrefersLight?: boolean}} options
 */
export function themeTokens(options = {}) {
  const requested = options.theme ?? 'dark';
  const mode = requested === 'system' ? (options.systemPrefersLight ? 'light' : 'dark') : requested;
  const surface = SURFACES[mode] ?? SURFACES.dark;
  const tone = TONES[mode] ?? TONES.dark;
  const accent = ACCENTS[options.accent] ?? ACCENTS.cyan;
  const accentBase = mode === 'light' ? accent.baseLight : accent.base;
  const density = METRICS.density[options.density ?? 'comfortable'] ?? 1;

  return {
    mode,
    tokens: {
      '--vx-bg': surface.bg,
      '--vx-bg-raised': surface.bgRaised,
      '--vx-bg-card': surface.bgCard,
      '--vx-bg-input': surface.bgInput,
      '--vx-line': surface.line,
      '--vx-line-soft': surface.lineSoft,
      '--vx-ink': surface.ink,
      '--vx-ink-soft': surface.inkSoft,
      '--vx-ink-muted': surface.inkMuted,
      '--vx-shadow': surface.shadow,
      '--vx-accent': accentBase,
      '--vx-accent-strong': accent.strong,
      '--vx-accent-soft': accent.soft,
      '--vx-accent-ink': accent.ink,
      '--vx-ok': tone.ok,
      '--vx-warn': tone.warn,
      '--vx-bad': tone.bad,
      '--vx-info': tone.info,
      '--vx-muted': tone.muted,
      '--vx-radius-sm': `${METRICS.radius.sm}px`,
      '--vx-radius-md': `${METRICS.radius.md}px`,
      '--vx-radius-lg': `${METRICS.radius.lg}px`,
      '--vx-space-xs': `${Math.round(METRICS.space.xs * density)}px`,
      '--vx-space-sm': `${Math.round(METRICS.space.sm * density)}px`,
      '--vx-space-md': `${Math.round(METRICS.space.md * density)}px`,
      '--vx-space-lg': `${Math.round(METRICS.space.lg * density)}px`,
      '--vx-space-xl': `${Math.round(METRICS.space.xl * density)}px`,
      '--vx-font-ui': METRICS.font.ui,
      '--vx-font-mono': METRICS.font.mono,
      '--vx-font-sm': `${METRICS.font.size.sm}px`,
      '--vx-font-md': `${METRICS.font.size.md}px`,
      '--vx-font-lg': `${METRICS.font.size.lg}px`,
      '--vx-font-display': `${METRICS.font.size.display}px`,
      '--vx-motion': options.reduceMotion ? '0ms' : '160ms'
    }
  };
}

/** Render the tokens as a CSS declaration block for `:root`. */
export function themeCss(options = {}) {
  const { tokens } = themeTokens(options);
  const declarations = Object.entries(tokens).map(([key, value]) => `  ${key}: ${value};`).join('\n');
  return `:root {\n${declarations}\n}`;
}

/**
 * Presentation for a status. Falls back to a neutral entry rather than throwing, so
 * an unhandled status shows as "Unknown" instead of blanking a row.
 * @param {string} status
 */
export function statusPresentation(status) {
  return STATUS_PRESENTATION[status] ?? { label: String(status ?? 'Unknown'), glyph: '?', tone: 'muted', word: 'Unknown' };
}

/**
 * Contrast audit. Returns every pair that fails WCAG AA for body text (4.5:1) or
 * the 3:1 threshold for large text and UI borders.
 */
export function themeAudit() {
  const failures = [];
  const pairs = [
    ['body', 'ink', 'bg', 4.5],
    ['secondary', 'inkSoft', 'bg', 4.5],
    ['muted', 'inkMuted', 'bg', 3.0],
    ['card body', 'ink', 'bgCard', 4.5],
    ['accent on surface', 'accent', 'bg', 3.0]
  ];

  for (const mode of ['dark', 'light']) {
    const surface = SURFACES[mode];
    const tone = TONES[mode];
    const resolved = {
      ink: surface.ink,
      inkSoft: surface.inkSoft,
      inkMuted: surface.inkMuted,
      bg: surface.bg,
      bgCard: surface.bgCard,
      accent: mode === 'light' ? ACCENTS.cyan.baseLight : ACCENTS.cyan.base
    };

    for (const [name, foreground, background, minimum] of pairs) {
      const ratio = contrastRatio(resolved[foreground], resolved[background]);
      if (ratio < minimum) failures.push(`${mode}/${name}: ${ratio}:1 (needs ${minimum}:1)`);
    }

    // Every accent must clear 3:1 on its own surface, not just the default.
    for (const [accentId, accent] of Object.entries(ACCENTS)) {
      const colour = mode === 'light' ? accent.baseLight : accent.base;
      const ratio = contrastRatio(colour, surface.bg);
      if (ratio < 3.0) failures.push(`${mode}/accent ${accentId}: ${ratio}:1 (needs 3:1)`);
    }

    // Status tones must be readable as text on the surface, because the report and
    // the UI both render them as words rather than colour swatches.
    for (const [toneName, colour] of Object.entries(tone)) {
      const ratio = contrastRatio(colour, surface.bg);
      if (ratio < 3.0) failures.push(`${mode}/tone ${toneName}: ${ratio}:1 (needs 3:1)`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Glyph shown beside a status. Kept as a function so `showGlyphs: false` is a real
 * behaviour change rather than a CSS class nobody checks.
 * @param {string} status @param {boolean} showGlyphs
 */
export function statusGlyph(status, showGlyphs = true) {
  return showGlyphs ? statusPresentation(status).glyph : '';
}

/**
 * The accessible name for a status. Always includes the word, never only the glyph,
 * so a screen reader announces "Warning" rather than "exclamation mark".
 * @param {string} status
 */
export function statusAriaLabel(status) {
  const presentation = statusPresentation(status);
  return `${presentation.word} (${presentation.label})`;
}
