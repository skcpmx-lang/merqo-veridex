# Design system

The interface has one job: **make the difference between "measured and fine" and "not
measured" impossible to miss.** Everything below follows from that.

Design tokens live in `src/renderer/theme.js` as JavaScript, and are emitted as CSS custom
properties by `themeCss(mode)`. There is no build step and no CSS preprocessor: the
renderer asks for a mode and gets 34 custom properties.

---

## 1. Principles

1. **Absence is information.** A value nobody measured is not drawn like a healthy one.
2. **One accent, chosen once.** All five accents derive from a single base colour, so no
   combination produces a contrast failure.
3. **The number never flatters.** When the score is withheld or capped, the interface says
   so where the score would be, not in a footnote.
4. **Nothing moves that is still loading.** A skeleton that pulses forever teaches the
   user to ignore it.
5. **Density is a setting, not a guess.** Comfortable and compact exist because screen
   sizes and eyesight differ.

---

## 2. Colour

### 2.1 Surfaces

Two complete palettes, `dark` and `light`, in `SURFACES`:

| Token | Dark | Light |
| --- | --- | --- |
| `bg` | `#0A1220` | `#F5F8FC` |
| `bgRaised` | `#0F1B2E` | `#FFFFFF` |
| `bgCard` | `#122032` | `#FFFFFF` |
| `bgInput` | `#0C1728` | `#EEF3F9` |
| `ink` | `#E8F1FA` | dark text |
| `inkSoft` | `#9FB2C8` | secondary |
| `inkMuted` | `#7A8EA6` | tertiary (4.89:1 on a card, 5.58:1 on the page) |

Dark is the default. Both modes are complete: neither is a filter over the other, because
a light-mode "invert" produces muddy mid-tones.

### 2.2 Accents

Five accents — `cyan` (default), `azure`, `violet`, `amber`, `emerald`. Each carries five
shades:

```
base   — the accent on dark surfaces
baseLight — the same accent darkened for light surfaces
strong — for hover and active
soft   — for fills and rails
ink    — text placed ON the accent
```

The `baseLight` shade exists because `#22D3EE` on `#F5F8FC` fails contrast. Shipping one
accent for both modes was an actual bug, caught by measuring rather than by eye: every
accent now has a light-mode pair.

### 2.3 Tones

Five semantic tones, per mode:

| Tone | Dark | Light | Used for |
| --- | --- | --- | --- |
| `ok` | `#4ADE80` | `#15803D` | pass |
| `warn` | `#FBBF24` | `#B45309` | warning, capped score, withheld score |
| `bad` | `#F87171` | `#B91C1C` | fail, error |
| `info` | `#7DD3FC` | `#0369A1` | neutral notes |
| `muted` | `#8CA0B8` | `#5B6B80` | unavailable, unrated, not applicable |

**Muted is a deliberate choice for "no data".** Unavailable and unrated are drawn in a
desaturated grey — visibly different from both green and red — so a gap in the evidence
never reads as either a pass or a failure.

### 2.4 Contrast

`contrastRatio()`, `luminance()` and `themeAudit()` in `theme.js` compute WCAG contrast, and
`tests/integration/contrast.test.js` measures every pair the interface actually draws: body,
secondary, muted and tone text on both the page and a card, the accent on the page and as a
button label, in both themes, for all five accents — ten theme/accent combinations.

Text is held to 4.5:1, shapes and borders to 3:1. Measured values at the time of writing:

| Pair | Dark | Light |
| --- | --- | --- |
| body on the page | 16.42 | 17.60 |
| secondary on the page | 8.64 | 6.52 |
| muted on the page / on a card | 5.58 / 4.89 | 5.66 / 6.03 |
| accent on the page (lowest of five) | 6.42 | 4.62 |
| label on an accent button (lowest) | 6.03 | 4.92 |
| pass / warn / fail / info tones | 6.78–11.24 | 4.71–6.07 |

Two values failed that measurement and were corrected rather than accepted: the light theme's
muted ink (3.71:1 — it was the dark theme's colour) and the light theme's accent button label
(2.52:1 — dark ink on a darkened accent). `docs/KNOWN_LIMITATIONS.md` §19 has the details,
including what this measurement cannot tell you.

Colour is never the only carrier of meaning: every status also has a glyph and a word
(§4).

---

## 3. Spacing, radius, type

```
radius:  sm 6 · md 10 · lg 14 · pill 999
space:   xs 4 · sm 8 · md 12 · lg 18 · xl 26   (px)
```

Type is the system stack — `"Segoe UI Variable Text", "Segoe UI", system-ui, …` — with no
webfont, because a downloaded font is a network request and the application has none. This
is a CSP constraint that happens to also be the right call for load time.

Tabular figures are used for every number so columns of values line up, and so a value
changing from 9 to 10 does not shift the layout.

---

## 4. Status presentation

Every status carries a **glyph, a word and a tone** — three channels, so the meaning
survives colour blindness, greyscale printing, and a screenshot compressed to mush.

| Status | Glyph | Word | Tone |
| --- | --- | --- | --- |
| `PASS` | ✓ | Pass | ok |
| `WARNING` | ! | Warning | warn |
| `FAIL` | ✕ | Fail | bad |
| `ERROR` | ✕ | Error | bad |
| `UNAVAILABLE` | – | Unavailable | muted |
| `UNSUPPORTED` | – | Unsupported | muted |
| `PERMISSION_REQUIRED` | ⚿ | Permission required | warn |
| `NOT_APPLICABLE` | – | Not applicable | muted |
| `UNRATED` | ? | Unrated | muted |
| `UNTESTED` | ? | Not tested | muted |
| `PARTIALLY_AVAILABLE` | ~ | Partial | warn |
| `UNKNOWN` | ? | Unknown | muted |

`statusAriaLabel()` produces the screen-reader string, so the glyph is never the only
label. The distinction the table is built to protect: **`–` and `?` are not `✓`.**

---

## 5. Score presentation

The score area has four states and each looks different on purpose:

| State | Display |
| --- | --- |
| No scan yet | `Unrated`, with an explanation that nothing has been measured |
| Measured, coverage < 50 % | `Score withheld`, a warning callout stating the coverage and why |
| 50–80 % coverage | The number, plus `Score limited by coverage` and the cap reason |
| ≥ 80 % coverage | The number and its rating |

There is no state in which a number appears without the coverage beside it.

---

## 6. Layout and density

- **18 pages**, grouped in a persistent left rail, because a diagnostic tool is used to
  answer a specific question ("what is my battery doing?") and a single scrolling page
  hides the answer.
- Two densities: `comfortable` (1.0) and `compact` (0.72). The ratio scales row height
  and padding together, so a compact table is still a table.
- Content is laid out in a max-width column; at narrow widths the rail collapses.
- **The window fits the screen it opens on.** Size is chosen against a display's *work area*,
  not its resolution (`src/app/window-placement.js`): a 1366x768 laptop at 125 % reports a
  1093x574 work area, which is smaller than the 1024x700 minimum in both directions, so the
  window becomes the work area and its own minimum is lowered to match. Opening on the display
  under the pointer is what makes a two-monitor desk predictable, and a window left on a monitor
  that has been unplugged is moved back rather than left at coordinates nothing covers.
- **Notifications take layout space.** The stack sits below the content region inside the
  application column rather than floating over it, so a toast can never hide the figure it is
  reporting on. One notification is shown at a time there (the newest replaces the previous),
  with the body clamped to two lines; a window with no shell falls back to a floating stack of
  up to four, because it covers nothing but itself.

---

## 7. Motion

Motion is short and functional. One duration token, `--vx-motion`, drives every
transition — background and border on hover, and the width of a progress bar. There are
six `transition` declarations in the entire stylesheet and none of them is decorative.

`@media (prefers-reduced-motion: reduce)` collapses animation and transition durations to
0.001 ms and caps iteration count at 1, which is what a "reduced motion" preference
actually asks for. The same rules are applied under a `.reduce-motion` class so the
in-app setting and the OS setting behave identically. The renderer test asserts the media
query is present.

No animation ever carries meaning on its own. A spinner means "working", and if work
stops the spinner is replaced by a result or an explanation — never left turning.

---

## 8. Accessibility

- Every interactive element is a real `<button>`, `<a>` or `<input>`; click handlers are
  not attached to `<div>`s.
- Focus is always visible, and focus order follows reading order.
- Status is glyph + word + tone, never tone alone.
- `aria-label` is supplied wherever a glyph or an abbreviation carries the meaning.
- Both modes meet contrast requirements; `themeAudit()` verifies it rather than assuming.
- The CSP forbids inline scripts, so the interface has no `onclick` attributes; all
  handlers are attached in `app.js`.

---

## 9. Implementation map

| Concern | File |
| --- | --- |
| Colour, spacing, type, status presentation, contrast maths | `src/renderer/theme.js` |
| Reusable elements (`el`, `callout`, cards, tables) | `src/renderer/ui.js` |
| Page controllers and layout | `src/renderer/app.js` |
| Rules, layout, media queries | `src/renderer/styles.css` |
| Verification (tokens, contrast, reduced motion, no remote assets) | `tests/integration/renderer.test.js` |
| Window placement across displays, work-area fit, DPI scaling | `src/app/window-placement.js`, `tests/unit/window-placement.test.js` |
