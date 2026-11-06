/**
 * VERIDEX — interface controller.
 *
 * Builds the shell (sidebar, topbar, content region) and swaps pages. Each page is a
 * function returning a DOM node, so pages hold no state of their own and can be
 * re-rendered from a fresh read of the main process at any time.
 *
 * Truthfulness rules in the UI layer:
 *   - when no main process is attached, a permanent banner says so and the pages
 *     show refusals rather than invented values;
 *   - a score of null renders as "Unrated", never as 0 and never as a green tick;
 *   - every coverage number is printed with the total it is out of;
 *   - buttons that cannot do anything are disabled with a reason in their title,
 *     rather than present and inert.
 */

import { createClient, PREVIEW_NOTE } from './bridge.js';
import { themeTokens, statusPresentation } from './theme.js';
import { SHORTCUTS, shortcutOf } from './shortcuts.js';
// The first-run copy lives with the main-process state machine so the words on screen and the
// promises asserted by the tests are literally the same strings.
import { STEPS as ONBOARDING_STEPS } from '../app/onboarding.js';
import { el, statusBadge, formatValue, formatDuration, formatTimestamp, fieldRow, emptyState, coverageStrip, progressBar, callout, button, tabStrip, sortBySeverity, toast, dialog, scoreDial } from './ui.js';

const client = createClient();

/** Pages in navigation order, grouped as the brief's structure demands. */
const PAGES = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◈', group: 'Overview' },
  { id: 'hardware', label: 'Hardware', glyph: '⌘', group: 'Diagnostics' },
  { id: 'battery', label: 'Battery', glyph: '▮', group: 'Diagnostics' },
  { id: 'storage', label: 'Storage', glyph: '⛁', group: 'Diagnostics' },
  { id: 'network', label: 'Network', glyph: '≋', group: 'Diagnostics' },
  { id: 'windows', label: 'Windows & security', glyph: '⛨', group: 'Diagnostics' },
  { id: 'reliability', label: 'Reliability', glyph: '⌛', group: 'Diagnostics' },
  { id: 'drivers', label: 'Drivers & software', glyph: '⚙', group: 'Diagnostics' },
  { id: 'processes', label: 'Processes', glyph: '⌗', group: 'Diagnostics' },
  { id: 'manual', label: 'Manual tests', glyph: '◎', group: 'Inspection' },
  { id: 'performance', label: 'Performance', glyph: '⚡', group: 'Inspection' },
  { id: 'monitor', label: 'Live monitoring', glyph: '⌁', group: 'Inspection' },
  { id: 'reports', label: 'Reports', glyph: '⌸', group: 'Output' },
  { id: 'history', label: 'History', glyph: '⟲', group: 'Output' },
  { id: 'settings', label: 'Settings', glyph: '⚒', group: 'Application' },
  { id: 'privacy', label: 'Privacy', glyph: '⛨', group: 'Application' },
  { id: 'logs', label: 'Activity log', glyph: '⌸', group: 'Application' },
  { id: 'about', label: 'About', glyph: 'ⓘ', group: 'Application' }
];

/** Application state. Deliberately small: the main process owns the truth. */
const state = {
  page: 'dashboard',
  info: null,
  settings: null,
  // `finished` is the run summary; `assessment`, `coverage`, `issues` and `modules` are the
  // projection from `scan:last`. They are declared here so a page reading them before the
  // first scan gets null rather than undefined.
  scan: {
    running: false,
    done: 0,
    total: 0,
    taskId: null,
    finished: null,
    error: null,
    /**
     * True when the panels below describe an EARLIER run, because the attempt that just
     * finished failed. Without this flag a failed scan either blanked good evidence or — worse —
     * left it on screen looking like the result of the run the user just started.
     */
    stale: false,
    /** When the displayed evidence was collected. Null before the first successful run. */
    adoptedAt: null,
    assessment: null,
    coverage: null,
    issues: null,
    modules: null
  },
  suites: null,
  manual: null,
  manualLoading: false,
  history: null,
  historyLoading: false,
  comparison: { selected: [], result: null, loading: false, error: null },
  onboarding: null,
  logs: { entries: null, summary: null, retention: null, stats: null, statsLoading: false, unparseable: 0, level: 'info', query: '', loading: false, error: null },
  export: { destination: null, plan: null, result: null, running: false, error: null },
  monitor: { running: false, starting: false, sample: null, sensors: null, error: null, note: null },
  guard: null
};

/** @type {HTMLElement|null} */
let contentHost = null;
/** @type {Map<string, HTMLElement>} */
const navItems = new Map();

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * Apply the user's appearance settings to the document root.
 * @param {Record<string, unknown>} [ui]
 */
function applyTheme(ui = {}) {
  const systemPrefersLight = globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches ?? false;
  const { tokens, mode } = themeTokens({
    theme: /** @type {any} */ (ui.theme) ?? 'dark',
    accent: /** @type {any} */ (ui.accent) ?? 'cyan',
    density: /** @type {any} */ (ui.density) ?? 'comfortable',
    reduceMotion: Boolean(ui.reduceMotion),
    showGlyphs: ui.showGlyphs !== false,
    systemPrefersLight
  });

  for (const [key, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(key, String(value));
  }
  document.documentElement.dataset.theme = mode;
  document.documentElement.classList.toggle('reduce-motion', Boolean(ui.reduceMotion));
}

// ── Shell ────────────────────────────────────────────────────────────────────

function buildSidebar() {
  const sidebar = el('aside', { class: 'vx-sidebar' });

  const brand = el('div', {
    class: 'vx-brand',
    children: [
      el('div', { class: 'vx-brand__mark', attrs: { 'aria-hidden': 'true' } }),
      el('div', {
        class: 'vx-brand__text',
        children: [
          el('span', { class: 'vx-brand__name', text: 'VERIDEX' }),
          el('span', { class: 'vx-brand__sub', text: 'by MERQO' })
        ]
      })
    ]
  });
  sidebar.append(brand);

  const nav = el('nav', { class: 'vx-nav', attrs: { 'aria-label': 'Main navigation' } });
  let currentGroup = null;
  for (const page of PAGES) {
    if (page.group !== currentGroup) {
      currentGroup = page.group;
      nav.append(el('div', { class: 'vx-nav__group', text: page.group }));
    }
    const item = el('button', {
      class: 'vx-nav__item',
      attrs: { type: 'button', 'data-page': page.id }
    });
    item.append(el('span', { class: 'vx-nav__glyph', text: page.glyph, attrs: { 'aria-hidden': 'true' } }));
    item.append(el('span', { text: page.label }));
    item.addEventListener('click', () => navigate(page.id));
    navItems.set(page.id, item);
    nav.append(item);
  }
  sidebar.append(nav);

  sidebar.append(
    el('div', {
      class: 'vx-sidebar__foot',
      children: [
        el('p', { text: 'Offline by design. No diagnostic data leaves this device.' }),
        el('p', { class: 'vx-mono', text: `v${state.info?.version ?? '1.0.0'} · ${client.mode === 'live' ? 'live' : 'preview'}` })
      ]
    })
  );

  return sidebar;
}

function buildTopbar() {
  const title = el('h1', { class: 'vx-topbar__title', text: 'Dashboard' });
  const subtitle = el('span', { class: 'vx-topbar__sub', text: 'Advanced All-in-One Windows PC & Laptop Diagnostics' });

  const startButton = button({
    label: 'Run full scan',
    variant: 'primary',
    onClick: () => startScan(),
    disabled: !client.live
  });
  if (!client.live) startButton.title = 'A scan requires the VERIDEX main process.';
  startButton.id = 'vx-start-scan';

  const cancelButton = button({
    label: 'Cancel',
    variant: 'danger',
    onClick: () => cancelScan(),
    disabled: true
  });
  cancelButton.id = 'vx-cancel-scan';

  const searchButton = button({
    label: 'Search',
    variant: 'ghost',
    onClick: () => openSearch(),
    title: 'Search pages, settings, runs and fields (Ctrl+K)'
  });
  searchButton.classList.add('vx-topbar__search');
  searchButton.append(el('kbd', { class: 'vx-topbar__kbd', text: 'Ctrl K', attrs: { 'aria-hidden': 'true' } }));

  const helpButton = button({ label: 'Shortcuts', variant: 'ghost', onClick: () => showShortcutReference(), title: 'Keyboard shortcut reference (F1)' });

  const bar = el('header', {
    class: 'vx-topbar',
    children: [
      el('div', { children: [title, subtitle] }),
      el('div', { class: 'vx-topbar__spacer' }),
      searchButton,
      helpButton,
      startButton,
      cancelButton
    ]
  });

  bar._title = title;
  return bar;
}

let topbar = null;

/** @param {string} pageId */
function navigate(pageId) {
  const page = PAGES.find((entry) => entry.id === pageId);
  if (!page) return;
  state.page = pageId;
  for (const [id, node] of navItems) node.classList.toggle('is-active', id === pageId);
  if (topbar) topbar._title.textContent = page.label;
  render();
}

/**
 * Adopt a completed scan into the interface state.
 *
 * Everything the pages read about a run is set here and nowhere else, so a page can never
 * render a score from one scan beside fields from another. Called after a run finishes and
 * again at boot, because a scan started before the window opened is still the last run.
 *
 * @param {any} payload the `scan:last` projection, or null when nothing has been collected
 */
/**
 * Normalise the issues summary.
 *
 * `scan:last` sends `{warnings, errors, conflicts}`, but this function exists because the
 * renderer must not depend on a payload shape it did not validate: a stored projection written
 * by an older build, or a truncated one, would otherwise throw inside `pages.dashboard` and
 * blank the whole window. An unexpected array is read as a list of messages; anything else is
 * read as three empty lists, which renders as "nothing needs attention" only after the
 * projection itself has already said there is a plan to report.
 *
 * @param {unknown} issues
 */
function normalizeIssues(issues) {
  if (!issues || typeof issues !== 'object') return null;
  const list = (value) => (Array.isArray(value) ? value : []);
  if (Array.isArray(issues)) return { warnings: [], errors: [], conflicts: [], messages: issues };
  return {
    warnings: list(issues.warnings),
    errors: list(issues.errors),
    conflicts: list(issues.conflicts),
    messages: list(issues.messages)
  };
}

function adoptScan(payload) {
  if (!payload) return;
  state.scan.finished = {
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    durationMs: payload.durationMs,
    cancelled: Boolean(payload.cancelled),
    taskCount: payload.taskCount ?? null,
    providersAttempted: payload.providersAttempted ?? null
  };
  state.scan.stale = false;
  state.scan.adoptedAt = payload.finishedAt ?? null;
  state.scan.assessment = payload.assessment ?? null;
  state.scan.coverage = payload.coverage ?? null;
  state.scan.issues = normalizeIssues(payload.issues);
  state.scan.modules = payload.modules ?? null;
}

/** Fetch the last completed scan, if there is one, and adopt it. */
async function loadLastScan() {
  const result = await client.invoke('scan:last');
  if (result.ok && result.data?.scan) adoptScan(result.data.scan);
}

/** Re-render the current page. */
function render() {
  if (!contentHost) return;
  contentHost.replaceChildren();
  const builder = PAGE_BUILDERS[state.page] ?? pages.notFound;
  contentHost.append(builder());
  updateScanButtons();
}

function updateScanButtons() {
  const start = document.getElementById('vx-start-scan');
  const cancel = document.getElementById('vx-cancel-scan');
  if (start) start.disabled = !client.live || state.scan.running;
  if (cancel) cancel.disabled = !client.live || !state.scan.running;
}

/** Banner shown permanently when running outside the product. */
function previewBanner() {
  return callout({
    tone: 'warn',
    title: 'Design preview — not connected to a machine',
    body: `${PREVIEW_NOTE} Start VERIDEX from the packaged application to inspect a real computer.`
  });
}

/** The scan progress card, shared by the dashboard and every diagnostic page. */
function scanProgressCard() {
  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Scan progress' }));

  const total = state.scan.total || 0;
  if (!client.live) {
    card.append(emptyState('No scan running', 'A scan requires the VERIDEX main process. This window is a preview.'));
    return card;
  }
  if (state.scan.error) {
    card.append(
      callout({
        tone: 'bad',
        title: 'The scan could not run',
        body: state.scan.stale
          ? `${state.scan.error} The panels below are from the run completed at ${formatTimestamp(state.scan.adoptedAt ?? '')}; nothing on this screen came from the attempt that just failed.`
          : state.scan.error
      })
    );
    return card;
  }
  if (total === 0) {
    card.append(emptyState('No scan has run yet', 'Run a full scan to collect evidence from this machine. Anything not collected is reported as unavailable, never assumed good.'));
    return card;
  }

  card.append(
    progressBar({
      done: state.scan.done,
      total,
      label: state.scan.done >= total ? `All ${total} tasks finished` : `${state.scan.done} of ${total} tasks${state.scan.taskId ? ` · ${state.scan.taskId}` : ''}`
    })
  );
  if (state.scan.finished) {
    card.append(
      el('p', {
        class: 'vx-dim',
        text: `Finished in ${formatDuration(state.scan.finished.durationMs)}${state.scan.finished.cancelled ? ' (cancelled early)' : ''}.`
      })
    );
  }
  return card;
}

// ── Pages ────────────────────────────────────────────────────────────────────

const pages = {};

pages.dashboard = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  // Evidence on screen that predates a failed attempt must say so at the top, not only in a
  // toast that has already faded and a progress card further down the page.
  if (state.scan.stale) {
    wrapper.append(
      callout({
        tone: 'warn',
        title: 'These results are from an earlier run',
        body: `The most recent scan attempt failed${state.scan.error ? `: ${state.scan.error}` : '.'} Everything below was collected at ${formatTimestamp(state.scan.adoptedAt ?? '')} and has not been refreshed since.`
      })
    );
  }

  const data = state.scan.finished;
  const assessment = state.scan.assessment;

  // Health
  const healthCard = el('div', { class: 'vx-card' });
  healthCard.append(
    el('div', {
      class: 'vx-card__head',
      children: [el('h2', { class: 'vx-card__title', text: 'Device health' }), assessment ? statusBadge(assessment.status) : null].filter(Boolean)
    })
  );

  if (!assessment || assessment.score === null) {
    healthCard.append(
      el('div', {
        class: 'vx-hero',
        children: [
          scoreDial(null, { label: 'Device health' }),
          el('div', {
            children: [
              el('div', {
                class: 'vx-hero__headline',
                children: [
                  el('span', { class: 'vx-hero__rating', text: assessment?.gated ? 'Score withheld' : 'Unrated' }),
                  statusBadge('UNRATED', { size: 'sm' })
                ]
              }),
              el('p', {
                class: 'vx-hero__meta',
                text: assessment?.disclaimer ?? 'No assessment exists until a scan has collected evidence.'
              })
            ]
          })
        ].filter(Boolean)
      })
    );
    if (assessment?.gated) {
      // Say why the number is missing. "Unrated" alone leaves the reader wondering
      // whether the machine is fine; the reason is the whole point.
      healthCard.append(callout({ tone: 'warn', title: 'Not enough of the machine could be measured', body: assessment.gatingNote }));
    }
    healthCard.append(
      el('p', {
        class: 'vx-dim',
        text: assessment?.disclaimer ?? 'No assessment exists until a scan has collected evidence. An unrated machine is not a healthy one; it is a machine VERIDEX has not measured.'
      })
    );
  } else {
    // One hero, three readings of the same fact: the ring for the glance, the rating word for
    // the judgement, and the coverage sentence for the caveat. The meter that used to sit
    // under this repeated the ring and is gone rather than doubled up.
    const heroCopy = el('div', { class: 'vx-hero__copy', style: { display: 'flex', 'flex-direction': 'column', gap: 'var(--vx-space-sm)' } });
    heroCopy.append(
      el('div', {
        class: 'vx-hero__headline',
        children: [
          el('span', { class: 'vx-hero__rating', text: assessment.rating }),
          statusBadge(assessment.status, { size: 'sm' })
        ].filter(Boolean)
      })
    );
    heroCopy.append(
      el('p', {
        class: 'vx-hero__meta',
        text: `${assessment.ratedComponents} of ${assessment.totalComponents} components could be assessed (${assessment.coveragePercent}% coverage). Components without evidence are unrated, never counted as healthy.`
      })
    );
    healthCard.append(
      el('div', {
        class: 'vx-hero',
        children: [scoreDial(assessment.score, { status: assessment.status, rating: 'of 100' }), heroCopy]
      })
    );
    if (assessment.gatingNote) {
      healthCard.append(callout({ tone: 'warn', title: 'Score limited by coverage', body: assessment.gatingNote }));
    }
    healthCard.append(el('p', { class: 'vx-dim vx-mono', text: assessment.disclaimer }));
  }

  // Coverage
  const coverageCard = el('div', { class: 'vx-card' });
  coverageCard.append(el('h2', { class: 'vx-card__title', text: 'Coverage' }));
  if (state.scan.coverage) {
    const coverage = state.scan.coverage;
    coverageCard.append(
      coverageStrip([
        { label: 'Assessed', value: coverage.assessed },
        { label: 'Passed', value: coverage.passed },
        { label: 'Warnings', value: coverage.warned },
        { label: 'Failed', value: coverage.failed },
        { label: 'Not run', value: coverage.untested },
        { label: 'Blocked', value: coverage.blocked },
        { label: 'Unavailable', value: coverage.unsupported },
        { label: 'Of fields', value: `${coverage.coveragePercent}%` }
      ])
    );
    coverageCard.append(el('p', { class: 'vx-dim', text: coverage.note }));
  } else {
    coverageCard.append(emptyState('No coverage to report', 'Coverage appears after a scan. Untested and unavailable items are excluded from the percentage rather than counted as passes.'));
  }

  // Components
  const componentCard = el('div', { class: 'vx-card' });
  componentCard.append(el('h2', { class: 'vx-card__title', text: 'Components' }));
  if (assessment?.components?.length) {
    const rows = el('div', { class: 'vx-rows' });
    for (const component of assessment.components) {
      rows.append(
        fieldRow(component.label, component.score === null ? 'Unrated' : component.score, {
          status: component.status,
          note: component.missing ? component.explanation : null
        })
      );
    }
    componentCard.append(rows);
  } else {
    componentCard.append(emptyState('No components assessed', 'Each component is scored only from evidence that was actually collected.'));
  }

  // Issues
  const issues = state.scan.issues;
  const issueCount = issues ? issues.warnings.length + issues.errors.length + (issues.messages?.length ?? 0) : 0;
  let issuesCard = null;
  if (issues && issueCount > 0) {
    issuesCard = el('div', { class: 'vx-card' });
    issuesCard.append(el('h2', { class: 'vx-card__title', text: 'Needs attention' }));
    for (const error of issues.errors) {
      issuesCard.append(callout({ tone: 'bad', title: 'Error', body: error }));
    }
    for (const warning of issues.warnings) {
      issuesCard.append(callout({ tone: 'warn', title: 'Warning', body: warning }));
    }
    for (const message of issues.messages ?? []) {
      issuesCard.append(callout({ tone: 'warn', title: 'Issue', body: String(message) }));
    }
  }

  const actions = el('div', { class: 'vx-card' });
  actions.append(el('h2', { class: 'vx-card__title', text: 'Quick actions' }));
  const row = el('div', { style: { display: 'flex', gap: 'var(--vx-space-sm)', flexWrap: 'wrap' } });
  row.append(
    button({ label: 'Run full scan', variant: 'primary', onClick: () => startScan(), disabled: !client.live || state.scan.running }),
    button({ label: 'Open manual tests', onClick: () => navigate('manual') }),
    button({ label: 'Build report', onClick: () => navigate('reports'), disabled: !state.scan.finished })
  );
  actions.append(row);

  // ── Widget arrangement ────────────────────────────────────────────────────
  // `dashboard.widgets` is an ordered list of widget ids. It was declared, forwarded to the
  // renderer and never read, so editing it changed nothing — a setting that lies. It is read
  // here: the cards appear in the order the list names them, and a card the list omits is not
  // rendered. An empty or missing list means "everything", because that is what a person who
  // has never opened Settings expects to see.
  const nodes = {
    health: healthCard,
    coverage: coverageCard,
    progress: scanProgressCard(),
    components: componentCard,
    issues: issuesCard,
    actions
  };
  const configured = state.settings?.ui?.widgets;
  const chosen = Array.isArray(configured) && configured.length > 0 ? configured.filter((id) => nodes[id]) : Object.keys(nodes);

  let healthAndCoverageDrawn = false;
  for (const id of chosen) {
    if (id === 'health' || id === 'coverage') {
      if (healthAndCoverageDrawn) continue;
      const both = chosen.includes('health') && chosen.includes('coverage');
      wrapper.append(both ? el('div', { class: 'vx-grid vx-grid--2', children: [healthCard, coverageCard] }) : nodes[id]);
      healthAndCoverageDrawn = true;
      continue;
    }
    if (nodes[id]) wrapper.append(nodes[id]);
  }

  if (chosen.length === 0) {
    wrapper.append(
      emptyState(
        'No dashboard widgets are selected',
        'Every widget has been removed from the arrangement. Settings → Dashboard lists them; add the ones you want back.'
      )
    );
  }

  return wrapper;
};

/** A generic module page: shows the section's fields for a given module id. */
/**
 * Compose several page builders into one page.
 *
 * A page is a stack of modules rather than one module, because "Windows" is not one question:
 * the OS build, the servicing inventory and the component-store flag are three answers that a
 * reader wants to see together, and three separate sidebar entries would bury them.
 * @param {Array<() => HTMLElement>} builders
 */
function stackPages(builders, extras = null) {
  return () => {
    const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
    for (const builder of builders) {
      const section = builder();
      // Each child page renders its own progress card; one copy is enough.
      for (const child of Array.from(section.children)) {
        if (child.classList?.contains('vx-card') && child.textContent?.startsWith('Scan progress')) continue;
        wrapper.append(child);
      }
    }
    wrapper.append(scanProgressCard());
    // Extras are page-specific panels that are not scan modules (the export card, for instance).
    // They come after the evidence, because a reader looking for driver state wants the drivers.
    if (typeof extras === 'function') for (const child of extras() ?? []) if (child) wrapper.append(child);
    return wrapper;
  };
}

function modulePage(moduleId, title, description, emptyHint) {
  return () => {
    const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
    if (!client.live) wrapper.append(previewBanner());

    const card = el('div', { class: 'vx-card' });
    const module = state.scan.modules?.[moduleId];
    card.append(
      el('div', {
        class: 'vx-card__head',
        children: [
          el('h2', { class: 'vx-card__title', text: title }),
          module ? statusBadge(module.status) : null
        ].filter(Boolean)
      })
    );
    card.append(el('p', { class: 'vx-dim', text: description }));

    if (!module) {
      card.append(emptyState('Not collected yet', emptyHint));
    } else {
      const rows = el('div', { class: 'vx-rows' });
      const entries = Object.entries(module.fields ?? {}).map(([key, value]) => ({
        key,
        label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
        value,
        status: value?.status ?? 'UNKNOWN'
      }));
      for (const entry of sortBySeverity(entries)) {
        rows.append(
          fieldRow(entry.label, entry.value?.value, {
            unit: entry.value?.unit ?? null,
            status: entry.status,
            source: entry.value?.source ?? null,
            note: entry.value?.notes?.join(' ') || null
          })
        );
      }
      card.append(rows);
    }
    wrapper.append(card);
    wrapper.append(scanProgressCard());
    return wrapper;
  };
}

pages.hardware = modulePage('cpu', 'Processor and system', 'Identity and capability facts read from the operating system. Every value names the source that produced it.', 'Run a scan to collect processor details. On most systems this needs no elevation.');
pages.battery = modulePage('battery', 'Battery', 'Design capacity, full-charge capacity and cycle count, as reported by the battery controller. VERIDEX never estimates a missing value.', 'Run a scan. Battery data requires a battery that reports its own health registers.');
pages.storage = modulePage('storage', 'Storage', 'Drives, capacity and SMART/NVMe health. SMART log pages usually require administrator rights and are reported as blocked, not as missing hardware.', 'Run a scan. SMART data may need an elevated session.');
pages.network = modulePage('network', 'Network', 'Adapters, addressing and link state. Addresses are redacted in exports unless you enable them in Privacy.', 'Run a scan to enumerate adapters.');
pages.windows = stackPages([
  modulePage('windows', 'Windows and security', 'OS build, activation, Secure Boot, Defender and firewall state. Read-only: VERIDEX never changes a security setting.', 'Run a scan to collect operating-system state.'),
  modulePage('windowsInventory', 'Windows features & services', 'Optional features, service state and installed updates.', 'Run a scan to enumerate Windows servicing state.'),
  modulePage('windowsHealth', 'Component-store health', 'The servicing stack\'s own record of component-store corruption, read with a read-only DISM check. A healthy flag means no corruption has been recorded; it is not a file-by-file scan, and VERIDEX never runs a repair.', 'Run a scan as an administrator to read the component-store flag.')
]);
pages.drivers = stackPages([
  modulePage('drivers', 'Drivers and devices', 'Driver inventory with dates, signing state and problem codes. Driver export is consent-gated and never installs anything.', 'Run a scan to enumerate drivers.'),
  modulePage('software', 'Installed software & startup', 'Applications registered for uninstall, and the programs Windows starts at sign-in. Read-only: nothing is launched or removed.', 'Run a scan to read the installed-software registry.')
], () => [driverExportCard()]);

// Windows component health belongs beside the rest of the Windows state: it answers the
// question a reader has after seeing a driver problem - "are the system files themselves
// intact?" - and answers it with the servicing stack's own flag.
pages.reliability = stackPages([
  modulePage('events', 'Reliability & crash history', 'Critical and error events from the System and Application logs, bugchecks and application crashes. Message text is never collected: only the provider, the id, the level and the time.', 'Run a scan to read the event log.')
]);

pages.processes = stackPages([
  modulePage('processes', 'Running processes', 'A single snapshot of what is running on this machine, grouped by name, with memory and processor time. Command lines are deliberately not collected.', 'Run a scan to take a process snapshot.')
]);

pages.manual = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Manual inspection programme' }));

  const coverage = state.manual?.coverage;
  if (!coverage) {
    card.append(emptyState('Loading the inspection programme', 'The suite list is read from the main process.'));
    // Load at most once per page visit. Calling loadManual() from inside a page
    // builder was an infinite re-render loop whenever the bridge returned nothing:
    // the builder triggered a load, the load re-rendered, the builder ran again.
    if (!state.manualLoading) {
      state.manualLoading = true;
      void loadManual().finally(() => {
        state.manualLoading = false;
      });
    }
  } else {
    card.append(
      coverageStrip([
        { label: 'Answered', value: coverage.answered },
        { label: 'Passed', value: coverage.passed },
        { label: 'Failed', value: coverage.failed },
        { label: 'Warnings', value: coverage.warned },
        { label: 'Not applicable', value: coverage.notApplicable },
        { label: 'Not run', value: coverage.untested },
        { label: 'Complete', value: `${coverage.percentComplete}%` }
      ])
    );
    card.append(el('p', { class: 'vx-dim', text: coverage.statement }));
    card.append(
      callout({
        tone: 'info',
        title: 'Two kinds of result',
        body: 'Rows marked "Captured from device events" are computed from real events VERIDEX received. Rows marked "Manual observation" record what a human saw or heard; software cannot detect a dead pixel or a rattling speaker, so those verdicts are the inspector\'s judgement and the report says so.'
      })
    );
  }
  wrapper.append(card);

  for (const suite of state.suites ?? []) {
    const suiteCard = el('div', { class: 'vx-card' });
    const progress = state.manual?.progress?.find((entry) => entry.suiteId === suite.id);
    suiteCard.append(
      el('div', {
        class: 'vx-card__head',
        children: [
          el('h2', { class: 'vx-card__title', text: suite.title }),
          progress ? el('span', { class: 'vx-nav__badge', text: `${progress.answered}/${progress.total}` }) : null
        ].filter(Boolean)
      })
    );
    suiteCard.append(el('p', { class: 'vx-dim', text: suite.summary }));

    const list = el('div', { class: 'vx-rows' });
    // A suite whose payload arrives without its tests must render an empty list rather than
    // throw: an exception here blanks the whole page, which looks like the application is
    // broken rather than like one malformed answer from the main process.
    for (const test of suite.tests ?? []) {
      const result = state.manual?.results?.find((entry) => entry.id === test.id);
      const row = el('div', { class: 'vx-row' });
      row.append(el('div', { class: 'vx-row__label', text: test.title }));

      const valueCell = el('div', { class: 'vx-row__value' });
      valueCell.append(statusBadge(result?.status ?? 'UNTESTED', { size: 'sm' }));
      valueCell.append(
        el('span', {
          class: 'vx-row__source',
          text: test.kind === 'capture' ? 'captured from device events' : 'manual observation'
        })
      );
      row.append(valueCell);
      row.append(el('div', { class: 'vx-row__note', text: test.instructions }));
      list.append(row);
    }
    suiteCard.append(list);
    wrapper.append(suiteCard);
  }

  return wrapper;
};

pages.performance = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());
  wrapper.append(
    callout({
      tone: 'warn',
      title: 'Benchmark scores are VERIDEX-specific',
      body: 'Figures from these tests are comparable between two runs on the same machine, or between machines measured with VERIDEX. They are not comparable to other benchmark tools, and a low figure is a measurement, not a fault.'
    }),
    callout({
      tone: 'bad',
      title: 'Stress testing is a physical risk',
      body: 'Stress tests run the CPU, memory or disk at full load. VERIDEX stops at the thermal ceiling you set and at a hard duration limit, but it cannot read your processor\'s rated limit, and it cannot stop a machine from overheating if no temperature sensor is readable. Every run requires explicit consent.'
    })
  );
  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Benchmarks' }));
  card.append(emptyState('Benchmarks are not wired to this page yet', 'The CPU and disk benchmark engines exist and are tested; the interactive runner screen is not connected. Rather than show a button that does nothing, this page says so.'));
  wrapper.append(card);
  return wrapper;
};

pages.monitor = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Live sensors' }));

  if (!client.live) {
    card.append(
      emptyState(
        'Live sampling needs the main process',
        'Sensors are read by the main process, which owns the runner and the read-only guard. This window is a design preview, so there is nothing to sample and nothing is shown.'
      )
    );
    wrapper.append(card);
    return wrapper;
  }

  const controls = el('div', { style: { display: 'flex', gap: 'var(--vx-space-sm)', flexWrap: 'wrap' } });
  const start = button({
    label: state.monitor.starting ? 'Starting…' : 'Start sampling',
    variant: 'primary',
    onClick: () => startMonitor(),
    disabled: state.monitor.running || state.monitor.starting
  });
  const stop = button({
    label: 'Stop sampling',
    variant: 'ghost',
    onClick: () => stopMonitor(),
    disabled: !state.monitor.running
  });
  controls.append(start, stop);
  card.append(controls);

  if (state.monitor.note) card.append(el('p', { class: 'vx-dim', text: state.monitor.note }));

  if (state.monitor.error) {
    card.append(callout({ tone: 'bad', title: 'Sampling stopped', body: state.monitor.error }));
  }

  const sample = state.monitor.sample;
  if (!sample) {
    // Two different situations: never started, and started but no sample yet. Saying
    // "waiting for the first sample" when nothing is running would look like a hang.
    card.append(
      emptyState(
        state.monitor.running ? 'Waiting for the first sample' : 'Sampling is not running',
        state.monitor.running
          ? 'Readings appear as soon as the first poll returns, roughly 1.5 seconds after starting.'
          : 'Start sampling to read live sensors. Nothing is sampled until you ask for it, so an idle window is not measuring anything.'
      )
    );
    wrapper.append(card);
    return wrapper;
  }

  const sensors = state.monitor.sensors ?? [];
  const readings = sample.readings ?? {};
  const rows = el('div', { class: 'vx-rows' });
  for (const sensor of sensors) {
    const reading = readings[sensor.id];
    if (!reading) continue;
    const row = el('div', { class: 'vx-row' });
    row.append(el('div', { class: 'vx-row__label', text: sensor.label }));

    const value = el('div', { class: 'vx-row__value' });
    if (reading.value === null || reading.value === undefined) {
      // A sensor the machine does not expose says so. Rendering a dash alone would be
      // ambiguous; rendering 0 would be wrong.
      value.append(el('span', { class: 'vx-dim', text: 'Unavailable' }));
      if (reading.reason) value.append(el('span', { class: 'vx-row__note', text: reading.reason }));
    } else {
      value.append(el('span', { class: 'vx-row__text', text: `${reading.value}${sensor.unit ? ` ${sensor.unit}` : ''}` }));
      if (reading.source) value.append(el('span', { class: 'vx-row__source', text: reading.source }));
    }
    row.append(value);
    rows.append(row);
  }
  card.append(rows);

  card.append(
    el('p', {
      class: 'vx-dim',
      text: `${sample.samples} sample${sample.samples === 1 ? '' : 's'} taken. Latest at ${formatTimestamp(sample.at)}. Sampling stops when you leave it running and close the window.`
    })
  );

  wrapper.append(card);
  return wrapper;
};

/**
 * Count what the report will actually contain, from the scan the report is built from.
 *
 * A report page that says only "choose a format" makes the user take on faith that the document
 * is complete. These figures are the same ones the dashboard shows, so a mismatch is visible
 * before the file is written rather than after it is sent to someone.
 */
function reportFacts() {
  const modules = state.scan.modules ?? {};
  let fields = 0;
  let warnings = 0;
  let errors = 0;
  const byStatus = { PASS: 0, WARNING: 0, ERROR: 0 };
  for (const module of Object.values(modules)) {
    for (const field of Object.values(module?.fields ?? {})) {
      fields += 1;
      if (field?.status === 'WARNING') { warnings += 1; byStatus.WARNING += 1; }
      else if (field?.status === 'ERROR') { errors += 1; byStatus.ERROR += 1; }
      else if (field?.status === 'PASS') byStatus.PASS += 1;
    }
  }
  return { modules: Object.keys(modules).length, fields, warnings, errors, byStatus };
}

pages.reports = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const card = el('div', { class: 'vx-card' });
  if (!state.scan.finished) {
    card.append(el('h2', { class: 'vx-card__title', text: 'Export' }));
    card.append(emptyState('No scan to export', 'Run a scan first. A report is built from collected evidence, and VERIDEX will not generate a document from nothing.'));
    wrapper.append(card);
    return wrapper;
  }

  const facts = reportFacts();
  const assessment = state.scan.assessment;
  const coverage = state.scan.coverage;
  const issues = state.scan.issues;
  const finishedAt = state.scan.finished.finishedAt ?? state.scan.finished.startedAt ?? null;

  // What is in the file, before the file exists.
  const summaryCard = el('div', { class: 'vx-card' });
  summaryCard.append(el('h2', { class: 'vx-card__title', text: 'What this report contains' }));
  summaryCard.append(
    el('p', {
      class: 'vx-dim',
      text: finishedAt
        ? `Built from the scan that finished at ${formatTimestamp(finishedAt)}${state.scan.finished.cancelled ? ', which was cancelled before it completed' : ''}.`
        : 'Built from the last completed scan in this session.'
    })
  );
  summaryCard.append(
    coverageStrip([
      { label: 'Modules', value: facts.modules },
      { label: 'Evidence fields', value: facts.fields },
      { label: 'Warnings', value: facts.warnings },
      { label: 'Errors', value: facts.errors },
      { label: 'Coverage', value: coverage?.percent !== undefined ? `${coverage.percent}%` : '—' }
    ])
  );

  if (state.scan.stale) {
    summaryCard.append(
      callout({
        tone: 'warn',
        title: 'These readings are older than this session',
        body: 'The report will carry the collection time of each field, so a reader can see when it was measured. Re-run a scan if you need the current state.'
      })
    );
  }

  const contents = el('div', { class: 'vx-rows' });
  contents.append(
    fieldRow('Device health', assessment ? `${assessment.rating ?? assessment.status}${assessment.score !== undefined ? ` · ${assessment.score}/100` : ''}` : 'not assessed'),
    fieldRow('Modules with evidence', `${facts.modules}${assessment?.modules ? ` of ${assessment.modules}` : ''}`),
    fieldRow('Open issues', issues ? String(issues.warnings.length + issues.errors.length + (issues.messages?.length ?? 0)) : 'none recorded'),
    fieldRow('Manual checks', state.manual?.coverage ? `${state.manual.coverage.answered ?? 0} answered, ${state.manual.coverage.untested ?? 0} untested` : 'not started'),
    fieldRow('Machine identity', state.settings?.values?.['diagnostics.includeSensitiveInReport'] ? 'included (identifiers present)' : 'redacted')
  );
  summaryCard.append(contents);
  wrapper.append(summaryCard);

  const card2 = el('div', { class: 'vx-card' });
  card2.append(el('h2', { class: 'vx-card__title', text: 'Choose a format' }));

  const privacy = state.settings?.values?.['diagnostics.includeSensitiveInReport'];
  card2.append(
    callout({
      tone: privacy ? 'warn' : 'ok',
      title: privacy ? 'This export will include identifiers' : 'Identifiers are redacted',
      body: privacy
        ? 'Serial numbers, network addresses and account names will appear in the file. Treat it as personal data.'
        : 'Serial numbers, MAC and IP addresses, hostnames and account names are replaced with [redacted] before the document is written. Turn this on in Privacy if you need them.'
    })
  );

  // Each format says what it is for. Four buttons labelled PDF/HTML/CSV/JSON tell a technician
  // nothing about which one to hand to a customer.
  const formats = [
    { id: 'pdf', label: 'Save PDF', purpose: 'A document to read or send. Fixed layout, one file, evidence and limitations included.' },
    { id: 'html', label: 'Save HTML', purpose: 'The same report as a single web page you can open in any browser and print.' },
    { id: 'csv', label: 'Save CSV', purpose: 'One row per field, for a spreadsheet. Loses the narrative and the layout.' },
    { id: 'json', label: 'Save JSON', purpose: 'The raw structure, for your own tooling. Includes timestamps and sources for every field.' }
  ];
  const buttons = el('div', { style: { display: 'flex', gap: 'var(--vx-space-sm)', flexWrap: 'wrap' } });
  for (const format of formats) {
    buttons.append(
      button({
        label: format.label,
        variant: format.id === 'pdf' ? 'primary' : 'ghost',
        onClick: () => saveReport(format.id),
        title: format.purpose
      })
    );
  }
  card2.append(buttons);

  const purposes = el('div', { class: 'vx-rows' });
  for (const format of formats) purposes.append(fieldRow(format.id.toUpperCase(), format.purpose));
  card2.append(purposes);

  const status = el('p', { class: 'vx-dim', id: 'vx-report-status' });
  card2.append(status);
  card2.append(
    el('p', {
      class: 'vx-dim',
      text: 'Every format carries the same headings: what was measured, how, what could not be measured, and what the result does not prove.'
    })
  );
  wrapper.append(card2);
  return wrapper;
};

pages.history = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Run history' }));

  const entries = state.history?.entries;

  if (entries === null || entries === undefined) {
    // Three states that must not look alike: still loading, loaded and empty, and
    // could not load. Showing "no runs stored" for a failed read would be a lie about
    // the user's own data.
    if (state.history?.error) {
      card.append(
        callout({
          tone: 'bad',
          title: 'History could not be read',
          body: state.history.error
        })
      );
    } else if (client.live) {
      card.append(el('p', { class: 'vx-dim', text: 'Reading stored runs…' }));
      if (!state.historyLoading) {
        state.historyLoading = true;
        void loadHistory();
      }
    } else {
      card.append(
        emptyState(
          'History needs the main process',
          'Stored runs live on this machine and are read by the main process. This window is a design preview, so there is no history to show.'
        )
      );
    }
    wrapper.append(card);
    return wrapper;
  }

  if (entries.length === 0) {
    card.append(
      emptyState(
        'No runs stored yet',
        'A run is recorded only after a scan finishes, and only if history is enabled in Settings. Nothing has been stored on this machine.'
      )
    );
    wrapper.append(card);
    return wrapper;
  }

  // The application renders dense key/value data as .vx-rows rows rather than an HTML
  // table; the stylesheet has no table rules, so using <table> here would have rendered
  // as unstyled text. One run per row, newest first (the store returns newest first).
  const rows = el('div', { class: 'vx-rows' });

  for (const entry of entries) {
    const assessment = entry.assessment ?? {};
    const score = typeof assessment.score === 'number' ? assessment.score : null;
    const coverage = typeof assessment.coveragePercent === 'number' ? assessment.coveragePercent : null;
    const fieldCount = entry.coverage?.fields ?? entry.fieldCount ?? null;
    const errors = entry.issues?.errors?.length ?? 0;
    const warnings = entry.issues?.warnings?.length ?? 0;

    const row = el('div', { class: 'vx-row' });

    // A withheld score stays withheld in the list. Rendering it as 0 would look like a
    // catastrophic result; rendering it as a dash would look like missing data. The
    // title carries the reason the run withheld it.
    const scoreText =
      score !== null
        ? String(score)
        : assessment.gated
          ? 'Score withheld'
          : 'Unrated';

    const label = el('div', {
      class: 'vx-row__label',
      children: [
        el('span', { text: entry.finishedAt ? formatTimestamp(entry.finishedAt) : 'Unknown time' }),
        el('span', { class: 'vx-row__source', text: ` ${entry.id ?? ''}` })
      ]
    });

    const value = el('div', { class: 'vx-row__value' });
    value.append(
      el('span', {
        class: 'vx-row__text',
        text: `${scoreText}${score !== null ? ` · ${assessment.rating ?? 'Unrated'}` : ''}`,
        attrs: { title: assessment.gatingNote ?? '' }
      })
    );
    value.append(
      el('span', {
        class: 'vx-dim',
        text: `${coverage === null ? 'coverage unknown' : `${coverage}% coverage`}, ${fieldCount === null ? 'field count unknown' : `${fieldCount} field${fieldCount === 1 ? '' : 's'}`}`
      })
    );
    if (errors > 0 || warnings > 0) {
      value.append(
        el('span', {
          class: 'vx-row__note',
          text: `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
        })
      );
    }

    const marked = state.comparison.selected.includes(entry.id);
    const mark = button({
      label: marked ? 'Marked' : 'Mark',
      variant: marked ? 'primary' : 'ghost',
      onClick: () => {
        const selected = state.comparison.selected;
        state.comparison.selected = selected.includes(entry.id)
          ? selected.filter((id) => id !== entry.id)
          : [...selected, entry.id].slice(-2);
        // A new pair invalidates the old answer; showing a stale diff beside fresh marks is
        // how a reader ends up attributing one run's changes to another.
        state.comparison.result = null;
        state.comparison.error = null;
        render();
      }
    });
    mark.classList.add('vx-row__mark');
    mark.setAttribute('aria-pressed', String(marked));

    row.append(label, value, mark);
    rows.append(row);
  }

  // ── Comparison (R-24-02) ──
  // Two runs are marked, then compared field by field. Marking rather than "click a row"
  // keeps the rows usable for reading, and makes it visible which two runs are about to be
  // compared before anything is fetched.
  const comparison = state.comparison;
  const markBar = el('div', { class: 'vx-compare-bar' });
  markBar.append(
    el('p', {
      class: 'vx-dim',
      text:
        comparison.selected.length === 0
          ? 'Mark two runs to compare them field by field.'
          : comparison.selected.length === 1
            ? 'One run marked. Mark one more.'
            : 'Two runs marked.'
    })
  );
  const compareButton = button({
    label: 'Compare marked runs',
    variant: 'primary',
    disabled: comparison.selected.length !== 2 || comparison.loading,
    onClick: () => void runComparison()
  });
  markBar.append(compareButton);
  card.append(markBar);

  card.append(rows);

  if (comparison.result) card.append(renderComparison(comparison.result));
  else if (comparison.error) card.append(callout({ tone: 'bad', title: 'Comparison failed', body: comparison.error }));
  else if (comparison.loading) card.append(el('p', { class: 'vx-dim', text: 'Comparing the two runs…' }));

  card.append(
    el('p', {
      class: 'vx-dim',
      text: `${entries.length} stored run${entries.length === 1 ? '' : 's'}. History is kept on this machine only, pruned by the retention setting, and never uploaded.`
    })
  );

  wrapper.append(card);
  return wrapper;
};

pages.settings = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const specs = state.settings?.specs ?? [];
  if (specs.length === 0) {
    const card = el('div', { class: 'vx-card' });
    card.append(el('h2', { class: 'vx-card__title', text: 'Settings' }));
    card.append(emptyState('Settings are loaded from the main process', 'This preview window has no settings to show.'));
    wrapper.append(card);
    return wrapper;
  }

  /** @type {Map<string, Array<any>>} */
  const groups = new Map();
  for (const spec of specs) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(spec);
  }

  for (const [group, entries] of groups) {
    const card = el('div', { class: 'vx-card' });
    card.append(el('h2', { class: 'vx-card__title', text: group }));
    for (const spec of entries) {
      const row = el('div', { class: 'vx-row' });
      row.append(
        el('div', {
          class: 'vx-row__label',
          children: [el('span', { text: spec.label }), el('span', { class: 'vx-row__source', text: ` ${spec.key}` })]
        })
      );

      const valueCell = el('div', { class: 'vx-row__value' });
      const current = state.settings.values[spec.key];

      if (spec.type === 'boolean') {
        const toggle = el('input', { attrs: { type: 'checkbox', 'aria-label': spec.label } });
        toggle.checked = Boolean(current);
        toggle.addEventListener('change', () => changeSetting(spec.key, toggle.checked));
        valueCell.append(toggle);
      } else if (spec.type === 'enum') {
        const select = el('select', { attrs: { 'aria-label': spec.label } });
        for (const option of spec.values ?? []) {
          const node = el('option', { text: String(option), attrs: { value: String(option) } });
          if (option === current) node.selected = true;
          select.append(node);
        }
        select.addEventListener('change', () => changeSetting(spec.key, select.value));
        valueCell.append(select);
      } else if (spec.type === 'number') {
        const input = el('input', { attrs: { type: 'number', 'aria-label': spec.label, min: String(spec.min ?? ''), max: String(spec.max ?? '') } });
        input.value = String(current);
        input.addEventListener('change', () => changeSetting(spec.key, Number(input.value)));
        valueCell.append(input);
      } else {
        const input = el('input', { attrs: { type: 'text', 'aria-label': spec.label } });
        input.value = Array.isArray(current) ? current.join(', ') : String(current ?? '');
        input.addEventListener('change', () => changeSetting(spec.key, spec.type === 'string[]' ? input.value.split(',').map((part) => part.trim()).filter(Boolean) : input.value));
        valueCell.append(input);
      }

      row.append(valueCell);
      row.append(el('div', { class: 'vx-row__note', text: spec.description }));
      card.append(row);
    }
    wrapper.append(card);
  }

  return wrapper;
};

pages.privacy = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const guarantees = el('div', { class: 'vx-card' });
  guarantees.append(el('h2', { class: 'vx-card__title', text: 'Guarantees' }));
  for (const line of [
    ['No diagnostic data leaves this device', 'VERIDEX makes no outbound request. The source tree contains no network client, and the runtime guard refuses any attempt a dependency might make.'],
    ['Identifiers are redacted before export', 'Serial numbers, MAC and IP addresses, hostnames and account names are replaced with [redacted] in every format before a renderer runs, unless you opt in.'],
    ['Diagnostics are read-only', 'Formatting, partitioning, driver removal, registry cleaning and security disabling are refused by the command guard, not merely discouraged in a dialog.'],
    ['Secrets are never collected', 'Product keys, passwords and recovery keys are refused at collection time rather than redacted afterwards.']
  ]) {
    guarantees.append(callout({ tone: 'ok', title: line[0], body: line[1] }));
  }
  wrapper.append(guarantees);

  const stored = el('div', { class: 'vx-card' });
  stored.append(el('h2', { class: 'vx-card__title', text: 'Stored on this machine' }));
  const stats = state.logs.stats;
  const history = state.history?.entries;
  const rows = el('div', { class: 'vx-rows' });
  rows.append(
    fieldRow('Data folder', state.info?.dataDir ?? 'not reported'),
    fieldRow('Reports', state.info?.dataDir ? `${state.info.dataDir}\\reports` : 'inside the data folder'),
    fieldRow('Run history', `${Array.isArray(history) ? history.length : '—'} stored run${history?.length === 1 ? '' : 's'}${state.settings?.values?.['diagnostics.persistHistory'] === false ? ' (hidden: history is turned off in Settings)' : ''}`),
    fieldRow('Activity log', stats ? `${stats.files ?? 0} file(s), ${formatBytesText(stats.bytes ?? 0)} of ${formatBytesText(stats.maxBytes ?? 0)}${stats.level ? `, level ${stats.level}` : ''}` : 'reading…')
  );
  stored.append(rows);

  const actions = el('div', { class: 'vx-export' });
  const reveal = button({
    label: 'Open the activity log',
    onClick: () => navigate('logs')
  });
  const replay = button({
    label: 'Show the tour again',
    onClick: async () => {
      const result = await client.invoke('app:onboardingReset');
      if (!result.ok) {
        toast({ tone: 'bad', title: 'The tour could not be reset', body: result.error?.message ?? 'Unknown error.' });
        return;
      }
      toast({ tone: 'good', title: 'The tour will run next time', body: 'It is shown once more when VERIDEX starts.' });
    },
    disabled: !client.live
  });
  const remove = button({
    label: 'Delete the log',
    variant: 'danger',
    onClick: () => void clearLogs(),
    disabled: !client.live
  });
  actions.append(reveal, replay, remove);
  stored.append(actions);
  stored.append(
    el('p', {
      class: 'vx-dim',
      text: 'Deleting the log removes the files on this machine and nothing else. Reports you have already saved are yours to keep or delete; VERIDEX does not track them.'
    })
  );
  wrapper.append(stored);

  // The one privacy setting that changes what a file contains, next to the explanation of it.
  const settingCard = el('div', { class: 'vx-card' });
  settingCard.append(el('h2', { class: 'vx-card__title', text: 'What reports may contain' }));
  const include = state.settings?.values?.['diagnostics.includeSensitiveInReport'] === true;
  const toggleRow = el('div', { class: 'vx-rows' });
  const toggle = el('input', { attrs: { type: 'checkbox', id: 'vx-privacy-identifiers' } });
  toggle.checked = include;
  toggle.disabled = !client.live;
  toggle.addEventListener('change', () => void changeSetting('diagnostics.includeSensitiveInReport', toggle.checked));
  toggleRow.append(
    el('div', {
      class: 'vx-row',
      children: [
        el('label', { class: 'vx-row__label', text: 'Include serial numbers and addresses in reports', attrs: { for: 'vx-privacy-identifiers' } }),
        el('div', { class: 'vx-row__value', children: [toggle] })
      ]
    })
  );
  settingCard.append(toggleRow);
  settingCard.append(
    callout({
      tone: include ? 'warn' : 'ok',
      title: include ? 'Identifiers will be written into reports' : 'Reports will not identify this machine',
      body: include
        ? 'A report is personal data once it carries a serial number or an address. Share it only with someone who needs to identify the machine.'
        : 'The machine is still identifiable from its hardware configuration in most cases; redaction removes the direct identifiers, not the fingerprint. VERIDEX says so rather than claiming anonymity it cannot provide.'
    })
  );
  wrapper.append(settingCard);

  const guardCard = el('div', { class: 'vx-card' });
  guardCard.append(el('h2', { class: 'vx-card__title', text: 'Blocked this session' }));
  const guard = state.guard;
  if (!guard) {
    guardCard.append(emptyState('No guard report', 'The guard summary is read from the main process.'));
  } else {
    guardCard.append(
      coverageStrip([
        { label: 'Network blocked', value: guard.networkAttemptsBlocked },
        { label: 'Commands blocked', value: guard.unsafeCommandsBlocked },
        { label: 'Network access', value: guard.networkAccessEnabled ? 'On' : 'Off' }
      ])
    );
    guardCard.append(el('p', { class: 'vx-dim', text: guard.statement }));
  }
  wrapper.append(guardCard);

  // Load the log statistics the "stored" rows need, once.
  if (client.live && !state.logs.stats && !state.logs.statsLoading) {
    state.logs.statsLoading = true;
    void client.invoke('logs:stats').then((result) => {
      state.logs.statsLoading = false;
      if (result.ok) {
        state.logs.stats = result.data;
        if (state.page === 'privacy') render();
      }
    });
  }

  return wrapper;
};

pages.about = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  const info = state.info ?? {};
  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'VERIDEX' }));
  card.append(el('p', { class: 'vx-strong', text: 'Advanced All-in-One Windows PC & Laptop Diagnostics' }));
  card.append(el('p', { class: 'vx-dim', text: 'A premium product by MERQO.' }));
  const rows = el('div', { class: 'vx-rows' });
  rows.append(
    fieldRow('Version', info.version ?? '1.0.0'),
    fieldRow('Electron', info.electron ?? 'unknown'),
    fieldRow('Chromium', info.chrome ?? 'unknown'),
    fieldRow('Node', info.node ?? 'unknown'),
    fieldRow('Platform', info.platform ?? 'unknown'),
    fieldRow('Data folder', info.dataDir ?? 'unknown'),
    fieldRow('Founder', 'Shohan Khan'),
    fieldRow('Contact', 'merqoonline@gmail.com')
  );
  card.append(rows);
  card.append(
    callout({
      tone: 'warn',
      title: 'Signing status',
      body: 'VERIDEX is distributed unsigned. Windows SmartScreen will show "Windows protected your PC" and "Unknown Publisher" on first run. The published SHA-256 checksums let you confirm the download matches what was released; they do not replace a signing certificate, and VERIDEX does not ship a fake one.'
    })
  );
  wrapper.append(card);
  return wrapper;
};

/** Bytes as a person reads them. Binary units, because that is what the file system reports. */
function formatBytesText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

// ── First run (R-20-01) ─────────────────────────────────────────────────────

/**
 * The first-run tour.
 *
 * Shown once, over the application, the first time the window opens on a machine that has not
 * finished it. Four screens: what this is, what it cannot do, what it needs permission for, and
 * what it keeps. Skipping is offered on every screen and never asks for elevation.
 *
 * The copy lives in `src/app/onboarding.js` and arrives through `app:onboarding`; this function
 * only draws it, so the promises in the tour cannot drift from the ones the tests assert.
 */
async function runOnboarding() {
  const response = await client.invoke('app:onboarding');
  if (!response.ok) return; // No bridge, no tour: the preview banner already says what this window is.
  const status = response.data;
  state.onboarding = status ?? null;
  if (!status?.needed) return;

  const steps = ONBOARDING_STEPS;

  let index = typeof status.stepIndex === 'number' ? status.stepIndex : 0;
  let handle = null;

  const draw = () => {
    const step = steps[Math.min(index, steps.length - 1)];
    const body = el('div', { class: 'vx-onboarding' });

    body.append(
      el('div', {
        class: 'vx-onboarding__progress',
        attrs: { role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(index + 1) },
        children: steps.map((entry, position) =>
          el('span', { class: `vx-onboarding__pip${position <= index ? ' is-done' : ''}`, attrs: { 'aria-hidden': 'true' } })
        )
      })
    );
    body.append(el('p', { class: 'vx-onboarding__step', text: `Step ${index + 1} of ${steps.length}` }));
    body.append(el('h2', { class: 'vx-onboarding__title', text: step.title }));
    for (const paragraph of step.body) body.append(el('p', { class: 'vx-onboarding__body', text: paragraph }));

    const actions = el('div', { class: 'vx-onboarding__actions' });
    actions.append(
      button({
        label: step.action,
        variant: 'primary',
        onClick: async () => {
          const advance = await client.invoke('app:onboardingAdvance', { step: step.id });
          if (!advance.ok) {
            toast({ tone: 'bad', title: 'The tour could not be recorded', body: advance.error?.message ?? 'Unknown error.' });
            return;
          }
          if (advance.data?.done) {
            handle?.close();
            toast({ tone: 'good', title: 'Ready', body: 'Run a full scan whenever you like. Nothing is collected until you do.' });
            render();
            return;
          }
          index += 1;
          handle?.close();
          draw();
        }
      }),
      button({
        label: 'Skip the tour',
        onClick: async () => {
          await client.invoke('app:onboardingSkip');
          handle?.close();
          render();
        }
      })
    );
    body.append(actions);
    body.append(
      el('p', {
        class: 'vx-dim',
        text: 'Skipping is recorded as skipping, not as read. Settings offers the tour again whenever you want it.'
      })
    );

    handle = dialog({ title: 'Welcome to VERIDEX', body });
  };

  draw();
}

// ── Driver export (R-11-03) ─────────────────────────────────────────────────

/** The export promise, echoed on the page so it cannot drift from the engine's copy. */
const EXPORT_PROMISE_TEXT =
  'Export copies the driver packages installed on this machine into a folder you choose. It changes nothing on the machine. VERIDEX cannot restore a driver from an export, and does not install, update or remove drivers.';

async function chooseExportDestination() {
  const result = await client.invoke('drivers:chooseDestination');
  if (!result.ok) {
    state.export.error = result.error?.message ?? 'The folder chooser could not be opened.';
    render();
    return;
  }
  if (!result.data?.chosen) return; // The user cancelled the dialog; nothing to say.
  state.export.destination = result.data.path;
  state.export.result = null;
  state.export.error = null;
  const plan = await client.invoke('drivers:plan', { destination: result.data.path });
  state.export.plan = plan.ok ? plan.data : null;
  if (!plan.ok) state.export.error = plan.error?.message ?? 'The destination could not be checked.';
  render();
}

async function startExport() {
  if (!state.export.destination || state.export.running) return;
  state.export.running = true;
  state.export.error = null;
  state.export.result = null;
  render();
  toast({ tone: 'info', title: 'Export starting', body: 'Windows will ask for administrator permission. Declining is safe: nothing is changed on this machine either way.' });

  const result = await client.invoke('drivers:export', { destination: state.export.destination });
  state.export.running = false;
  if (result.ok) {
    state.export.result = result.data;
    toast({
      tone: result.data.ok ? 'good' : result.data.code === 'cancelled' ? 'warn' : 'bad',
      title: result.data.ok ? 'Export finished' : 'Export did not finish',
      body: result.data.reason
    });
  } else {
    state.export.error = result.error?.message ?? 'The export could not be started.';
  }
  render();
}

async function cancelExport() {
  const result = await client.invoke('drivers:cancelExport');
  if (result.ok && result.data?.cancelled) toast({ tone: 'warn', title: 'Stopping the export', body: 'The helper is being stopped; whatever was copied stays in the folder.' });
  else toast({ tone: 'info', title: 'Nothing to cancel', body: result.ok ? (result.data?.reason ?? 'No export is running.') : 'The main process could not be reached.' });
}

/** The export card. Rendered on the Drivers page, below the inventory. */
function driverExportCard() {
  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Export driver packages' }));

  card.append(
    callout({
      tone: 'info',
      title: 'Copy, not backup',
      body: EXPORT_PROMISE_TEXT
    })
  );

  const row = el('div', { class: 'vx-export' });
  const chosen = state.export.destination;
  const pathLabel = el('span', {
    class: 'vx-export__path',
    text: chosen ?? 'No folder chosen yet',
    attrs: chosen ? { title: chosen } : {}
  });

  const chooseButton = button({
    label: chosen ? 'Change folder…' : 'Choose folder…',
    variant: chosen ? 'ghost' : 'primary',
    onClick: () => void chooseExportDestination(),
    disabled: !client.live || state.export.running
  });
  chooseButton.id = 'vx-export-choose';

  const exportButton = button({
    label: state.export.running ? 'Exporting…' : 'Export drivers',
    variant: 'primary',
    onClick: () => void startExport(),
    // Exporting needs a destination and an idle state; both are stated in the title of a
    // disabled button rather than left for the user to discover by clicking.
    disabled: !client.live || !chosen || state.export.running
  });
  exportButton.id = 'vx-export-start';
  if (!chosen) exportButton.title = 'Choose a folder first.';
  if (!client.live) exportButton.title = 'Export needs the VERIDEX main process.';

  const cancelButton = button({ label: 'Stop', variant: 'danger', onClick: () => void cancelExport(), disabled: !state.export.running });
  cancelButton.id = 'vx-export-cancel';

  row.append(pathLabel, chooseButton, exportButton, cancelButton);
  card.append(row);

  if (state.export.plan) {
    const plan = state.export.plan;
    if (plan.ok) {
      card.append(
        el('p', {
          class: 'vx-dim',
          text: `This export will create "${plan.folder}" inside the chosen folder${plan.freeLabel ? ` — ${plan.freeLabel} free` : ''}. Existing files are never overwritten: each export gets its own folder.`
        })
      );
    } else {
      card.append(callout({ tone: 'warn', title: 'That folder cannot be used', body: plan.reason }));
    }
  }

  if (state.export.error) card.append(callout({ tone: 'bad', title: 'Export failed', body: state.export.error }));

  if (state.export.result) {
    const result = state.export.result;
    card.append(
      callout({
        tone: result.ok ? 'good' : result.code === 'cancelled' ? 'warn' : 'bad',
        title: result.ok ? 'Export complete' : 'Export incomplete',
        body: result.reason
      })
    );
    if (result.verification) {
      card.append(
        el('p', {
          class: 'vx-dim',
          text: result.verification.ok
            ? result.verification.reason
            : `Verification failed: ${result.verification.reason}`
        })
      );
    }
    if (result.path) card.append(el('p', { class: 'vx-dim vx-mono', text: result.path }));
  }

  card.append(
    el('p', {
      class: 'vx-dim',
      text: 'Exporting requires administrator rights and raises a Windows prompt. If you decline it, nothing is copied and the rest of the application carries on unchanged.'
    })
  );
  return card;
}

// ── Activity log (R-24-03) ──────────────────────────────────────────────────

async function loadLogs() {
  if (!client.live) return;
  state.logs.loading = true;
  const result = await client.invoke('logs:recent', { minLevel: state.logs.level, query: state.logs.query, limit: 200 });
  state.logs.loading = false;
  if (result.ok) {
    state.logs.entries = result.data.entries;
    state.logs.summary = result.data.summary;
    state.logs.retention = result.data.retention;
    state.logs.unparseable = result.data.unparseable ?? 0;
    state.logs.error = null;
  } else {
    state.logs.error = result.error?.message ?? 'The log could not be read.';
  }
  if (state.page === 'logs') render();
}

async function exportLogs() {
  const result = await client.invoke('logs:export');
  if (!result.ok) {
    toast({ tone: 'bad', title: 'The log could not be exported', body: result.error?.message ?? 'Unknown error.' });
    return;
  }
  toast(
    result.data.saved
      ? { tone: 'good', title: 'Log exported', body: `${result.data.entries} entries written to ${result.data.path}. Identifiers are redacted.` }
      : { tone: 'info', title: 'Export cancelled', body: 'No file was written.' }
  );
}

async function clearLogs() {
  const result = await client.invoke('logs:clear');
  if (!result.ok) {
    toast({ tone: 'bad', title: 'The log could not be cleared', body: result.error?.message ?? 'Unknown error.' });
    return;
  }
  toast({ tone: 'good', title: 'Log cleared', body: `${result.data.removed} file${result.data.removed === 1 ? '' : 's'} removed.` });
  await loadLogs();
  render();
}

pages.logs = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  if (client.live && state.logs.entries === null && !state.logs.loading) {
    state.logs.loading = true;
    void loadLogs();
  }

  const card = el('div', { class: 'vx-card' });
  const head = el('div', { class: 'vx-card__head' });
  head.append(el('h2', { class: 'vx-card__title', text: 'Activity log' }));
  head.append(
    button({ label: 'Export…', onClick: () => void exportLogs(), disabled: !client.live }),
    button({ label: 'Delete logs', variant: 'danger', onClick: () => void clearLogs(), disabled: !client.live })
  );
  card.append(head);

  if (state.logs.error) {
    card.append(callout({ tone: 'bad', title: 'The log could not be read', body: state.logs.error }));
    wrapper.append(card);
    return wrapper;
  }

  const summary = state.logs.summary;
  if (summary) {
    card.append(
      coverageStrip([
        { label: 'Entries', value: summary.entries },
        { label: 'Warnings', value: summary.counts?.warn ?? 0 },
        { label: 'Errors', value: summary.counts?.error ?? 0 },
        { label: 'Fatals', value: summary.counts?.fatal ?? 0 },
        { label: 'Files', value: summary.fileCount ?? '—' }
      ])
    );
  }

  // Filters. A select rather than a free-text level, because "wran" is not a level.
  const controls = el('div', { class: 'vx-log-controls' });
  const levelSelect = el('select', { attrs: { 'aria-label': 'Minimum level' } });
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const option = el('option', { text: level, attrs: { value: level } });
    if (level === state.logs.level) option.selected = true;
    levelSelect.append(option);
  }
  levelSelect.addEventListener('change', () => {
    state.logs.level = levelSelect.value;
    void loadLogs();
  });

  const search = el('input', {
    attrs: { type: 'search', placeholder: 'Filter by message, source or context…', 'aria-label': 'Filter log entries', value: state.logs.query }
  });
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.logs.query = search.value;
      void loadLogs();
    }, 200);
  });

  controls.append(el('label', { class: 'vx-dim', text: 'Minimum level' }), levelSelect, search);
  card.append(controls);

  if (state.logs.entries === null) {
    card.append(el('p', { class: 'vx-dim', text: 'Reading the log…' }));
  } else if (state.logs.entries.length === 0) {
    card.append(
      emptyState(
        state.logs.query || state.logs.level !== 'info' ? 'No entries match that filter' : 'The log is empty',
        state.logs.query || state.logs.level !== 'info'
          ? 'The log itself is not empty — this filter simply matches nothing. Clear the filter to see everything.'
          : 'Nothing has been written yet. Entries appear as VERIDEX runs, and a scan writes one per provider attempt.'
      )
    );
  } else {
    const rows = el('div', { class: 'vx-rows vx-rows--log' });
    for (const entry of state.logs.entries) {
      const row = el('div', { class: 'vx-row vx-row--log' });
      row.append(
        el('div', {
          class: 'vx-row__label',
          children: [
            el('span', { class: 'vx-log__time', text: entry.ts ? formatTimestamp(entry.ts) : 'no timestamp' }),
            el('span', { class: `vx-log__level vx-log__level--${entry.level ?? 'unknown'}`, text: entry.level ?? 'unknown' })
          ]
        })
      );
      const value = el('div', { class: 'vx-row__value' });
      value.append(el('span', { class: 'vx-row__text', text: entry.msg ?? '' }));
      value.append(el('span', { class: 'vx-row__source', text: ` ${entry.scope ?? 'app'}` }));
      if (entry.ctx && Object.keys(entry.ctx).length > 0) {
        value.append(el('span', { class: 'vx-log__ctx', text: JSON.stringify(entry.ctx).slice(0, 240) }));
      }
      row.append(value);
      rows.append(row);
    }
    card.append(rows);
    if (state.logs.unparseable > 0) {
      card.append(
        callout({
          tone: 'warn',
          title: `${state.logs.unparseable} line(s) could not be parsed`,
          body: 'Those lines are shown as they were written rather than dropped: a gap in a log looks exactly like a lie.'
        })
      );
    }
  }

  if (state.logs.retention) card.append(el('p', { class: 'vx-dim', text: state.logs.retention.statement }));
  card.append(
    el('p', {
      class: 'vx-dim',
      text: 'Logs contain timestamps, levels, sources and messages. Serial numbers, machine names, user names, addresses, tokens and keys are redacted before anything is written, and again on export.'
    })
  );

  wrapper.append(card);
  return wrapper;
};

pages.notFound = () => emptyState('Page not found', 'That page does not exist in this build.');

const PAGE_BUILDERS = {
  dashboard: pages.dashboard,
  hardware: pages.hardware,
  battery: pages.battery,
  storage: pages.storage,
  network: pages.network,
  windows: pages.windows,
  reliability: pages.reliability,
  drivers: pages.drivers,
  processes: pages.processes,
  manual: pages.manual,
  performance: pages.performance,
  monitor: pages.monitor,
  reports: pages.reports,
  history: pages.history,
  settings: pages.settings,
  privacy: pages.privacy,
  logs: pages.logs,
  about: pages.about
};

// ── History comparison (R-24-02) ────────────────────────────────────────────

/**
 * Ask the main process to compare the two marked runs.
 *
 * The comparison maths lives in `src/history/compare.js` and is unit-tested there; the
 * interface only renders its answer. Recomputing a diff in the renderer would give two
 * implementations of the same rule and eventually two different answers.
 */
async function runComparison() {
  const [aId, bId] = state.comparison.selected;
  if (!aId || !bId) return;

  state.comparison.loading = true;
  state.comparison.error = null;
  state.comparison.result = null;
  render();

  const result = await client.invoke('history:compare', { aId, bId });
  state.comparison.loading = false;
  if (result.ok) {
    state.comparison.result = result.data;
  } else {
    state.comparison.error = result.error?.message ?? 'The main process refused the comparison.';
  }
  render();
}

/**
 * Render a comparison. Deliberately shows what did *not* change as a count rather than a
 * list: a machine with 400 unchanged fields would otherwise bury the four that moved.
 * @param {any} comparison
 */
function renderComparison(comparison) {
  const card = el('div', { class: 'vx-card vx-compare' });
  const before = comparison.before ?? {};
  const after = comparison.after ?? {};
  const summary = comparison.summary ?? {};

  card.append(el('h3', { class: 'vx-card__title', text: 'Comparison' }));
  card.append(
    el('p', {
      class: 'vx-dim',
      text: `${formatTimestamp(before.finishedAt)} (${before.score === null ? 'unrated' : `score ${before.score}`}) compared with ${formatTimestamp(after.finishedAt)} (${after.score === null ? 'unrated' : `score ${after.score}`}).`
    })
  );

  card.append(
    coverageStrip([
      { label: 'Changed', value: summary.changed ?? 0 },
      { label: 'Added', value: summary.added ?? 0 },
      { label: 'Removed', value: summary.removed ?? 0 },
      { label: 'Degraded', value: summary.degraded ?? 0 },
      { label: 'Improved', value: summary.improved ?? 0 },
      { label: 'Unchanged', value: summary.neutral ?? 0 }
    ])
  );

  const top = Array.isArray(comparison.top) ? comparison.top : [];
  if (top.length === 0) {
    card.append(
      emptyState(
        'Nothing measurable changed',
        'Both runs recorded the same values for every field they share. Differences below the 0.5% noise floor are ignored on purpose: a fan reading that moved by one RPM is noise, not a finding.'
      )
    );
    return card;
  }

  const rows = el('div', { class: 'vx-rows' });
  for (const difference of top) {
    const verdict = difference.verdict ?? 'neutral';
    const row = el('div', { class: 'vx-row vx-row--diff' });
    row.append(
      el('div', {
        class: 'vx-row__label',
        children: [
          el('span', { text: difference.path }),
          el('span', { class: `vx-diff__verdict vx-diff__verdict--${verdict}`, text: verdict })
        ]
      })
    );

    const value = el('div', { class: 'vx-row__value' });
    const beforeText = difference.before === null ? 'absent' : formatValue(difference.before);
    const afterText = difference.after === null ? 'absent' : formatValue(difference.after);
    value.append(el('span', { class: 'vx-row__text', text: `${beforeText} → ${afterText}` }));
    if (difference.delta !== null && difference.delta !== undefined) {
      const sign = difference.delta > 0 ? '+' : '';
      value.append(
        el('span', {
          class: 'vx-dim',
          text: `${sign}${difference.delta}${difference.percent === null ? '' : ` (${difference.percent > 0 ? '+' : ''}${difference.percent}%)`}`
        })
      );
    }
    row.append(value);
    rows.append(row);
  }
  card.append(rows);
  card.append(
    el('p', {
      class: 'vx-dim',
      text: 'Verdicts come from each field\'s declared direction: for a fan speed, higher is better; for a CPU temperature, lower is. A field whose direction VERIDEX does not know is marked neutral rather than guessed.'
    })
  );
  return card;
}

// ── Global search (R-22-01) ──────────────────────────────────────────────────

/**
 * The searchable inventory.
 *
 * Search covers what the application knows before a scan (pages, settings, stored runs) and
 * what it learned during the last one (field labels, and the module they came from). It is
 * built from live state each time it opens rather than cached, because the whole point is to
 * find something added by the scan that just finished.
 *
 * @returns {Array<{id: string, label: string, detail: string, kind: 'page'|'setting'|'run'|'field', page: string, keywords: string}>}
 */
function buildSearchIndex() {
  const index = [];
  for (const page of PAGES) {
    index.push({ id: `page:${page.id}`, label: page.label, detail: page.group, kind: 'page', page: page.id, keywords: `${page.id} ${page.group}` });
  }

  const specs = state.settings?.specs ?? {};
  const values = state.settings?.values ?? {};
  const entries = Array.isArray(specs) ? specs.map((spec) => [spec.key, spec]) : Object.entries(specs);
  for (const [key, spec] of entries) {
    index.push({
      id: `setting:${key}`,
      label: spec?.label ?? key,
      detail: `${key} — ${String(values[key] ?? spec?.default ?? '')}`,
      kind: 'setting',
      page: 'settings',
      keywords: `${key} ${spec?.description ?? ''}`
    });
  }

  for (const entry of state.history?.entries ?? []) {
    index.push({
      id: `run:${entry.id}`,
      label: `Run ${entry.id}`,
      detail: `${formatTimestamp(entry.finishedAt)} · ${entry.assessment?.score ?? 'unrated'}`,
      kind: 'run',
      page: 'history',
      keywords: `${entry.id} ${entry.finishedAt ?? ''}`
    });
  }

  const modules = state.scan.modules ?? {};
  for (const [moduleId, module] of Object.entries(modules)) {
    for (const [key, value] of Object.entries(module?.fields ?? {})) {
      const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
      index.push({
        id: `field:${moduleId}:${key}`,
        label,
        detail: `${moduleId} — ${formatValue(value?.value, value?.unit)}`,
        kind: 'field',
        page: PAGES.find((page) => moduleId.startsWith(page.id.slice(0, 4)))?.id ?? 'dashboard',
        keywords: `${moduleId} ${key}`
      });
    }
  }
  return index;
}

/**
 * Filter an index by a query. Empty query returns the pages, which is a useful landing state.
 * @param {ReturnType<typeof buildSearchIndex>} index
 * @param {string} query
 */
function searchIndex(index, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return index.filter((entry) => entry.kind === 'page');
  const words = needle.split(/\s+/).filter(Boolean);
  return index
    .map((entry) => {
      const haystack = `${entry.label} ${entry.detail} ${entry.keywords}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return null;
      // Prefix matches on the label rank above matches buried in the keywords.
      const score = entry.label.toLowerCase().startsWith(needle) ? 3 : entry.label.toLowerCase().includes(needle) ? 2 : 1;
      return { entry, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
    .slice(0, 30)
    .map((scored) => scored.entry);
}

/** Keyboard-driven search palette. One at a time, Escape closes. */
let searchOpen = false;

function openSearch() {
  if (searchOpen || !document.body) return;
  searchOpen = true;

  const input = el('input', {
    class: 'vx-search__input',
    attrs: { type: 'search', placeholder: 'Search pages, settings, runs and collected fields…', 'aria-label': 'Search', autocomplete: 'off' }
  });
  const results = el('div', { class: 'vx-search__results', attrs: { role: 'listbox', 'aria-label': 'Search results' } });
  const index = buildSearchIndex();
  /** @type {HTMLElement[]} */
  let current = [];
  let selected = 0;

  const paint = () => {
    results.replaceChildren();
    current = searchIndex(index, input.value).map((entry) => {
      const node = el('button', {
        class: 'vx-search__result',
        attrs: { type: 'button', role: 'option' },
        children: [
          el('span', { class: 'vx-search__label', text: entry.label }),
          el('span', { class: 'vx-search__detail', text: entry.detail }),
          el('span', { class: 'vx-search__kind', text: entry.kind })
        ]
      });
      node.addEventListener('click', () => {
        navigate(entry.page);
        handle.close();
      });
      return node;
    });
    if (current.length === 0) {
      results.append(el('p', { class: 'vx-search__empty', text: 'Nothing matched. Search covers pages, settings, stored runs and the fields collected by the last scan.' }));
    }
    for (const node of current) results.append(node);
    selected = 0;
    current[0]?.classList.add('is-selected');
  };

  const move = (delta) => {
    if (current.length === 0) return;
    current[selected]?.classList.remove('is-selected');
    selected = (selected + delta + current.length) % current.length;
    current[selected].classList.add('is-selected');
    current[selected].scrollIntoView?.({ block: 'nearest' });
  };

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      current[selected]?.click();
    }
  });

  paint();
  const body = el('div', { class: 'vx-search', children: [input, results] });
  const handle = dialog({
    title: 'Search VERIDEX',
    body,
    onClose: () => { searchOpen = false; }
  });
  input.focus?.();
}

// ── Keyboard shortcuts (R-21-01) ─────────────────────────────────────────────

/** The shortcut reference. Rendered from the same table the handler reads. */
function showShortcutReference() {
  const table = el('div', { class: 'vx-keys' });
  for (const shortcut of SHORTCUTS) {
    table.append(
      el('div', {
        class: 'vx-keys__row',
        children: [
          el('kbd', { class: 'vx-keys__combo', text: shortcut.keys }),
          el('span', { class: 'vx-keys__label', text: shortcut.label })
        ]
      })
    );
  }
  dialog({
    title: 'Keyboard shortcuts',
    body: [
      table,
      el('p', {
        class: 'vx-dim',
        text: 'Shortcuts are fixed rather than rebindable: this list is generated from the same table the handler uses, so the two cannot disagree.'
      })
    ]
  });
}

/**
 * Install the global keyboard handler. Called once at boot.
 */
function installShortcuts() {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const combo = shortcutOf(event);

    if (combo === 'Escape') {
      // Dialogs handle their own Escape first; this is the unhandled case, which is a scan.
      if (state.scan.running) void cancelScan();
      return;
    }
    if (combo === 'F1') { event.preventDefault(); showShortcutReference(); return; }
    if (typing) return;

    if (combo === 'Ctrl+K' || combo === 'Ctrl+F') { event.preventDefault(); openSearch(); return; }
    if (combo === 'Ctrl+,') { event.preventDefault(); navigate('settings'); return; }
    if (combo === 'Ctrl+H') { event.preventDefault(); navigate('history'); return; }
    if (combo === 'Ctrl+Shift+R') { event.preventDefault(); void startScan(); return; }

    const numbered = combo.match(/^Ctrl\+([1-9])$/);
    if (numbered) {
      const page = PAGES[Number(numbered[1]) - 1];
      if (page) { event.preventDefault(); navigate(page.id); }
    }
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function startScan() {
  if (!client.live || state.scan.running) return;
  toast({ tone: 'info', title: 'Scan started', body: 'Collecting evidence from this machine. Anything that cannot be read is reported as unavailable, never assumed good.' });
  state.scan.running = true;
  state.scan.done = 0;
  state.scan.total = 0;
  state.scan.taskId = null;
  state.scan.error = null;
  updateScanButtons();
  render();

  const result = await client.invoke('scan:start', { tasks: [] });
  if (!result.ok) {
    state.scan.running = false;
    state.scan.error = result.error.message;
    // The evidence already on screen is from an earlier run. Keep it — throwing away a good
    // report because a new attempt failed is its own kind of dishonesty — but mark it.
    state.scan.stale = Boolean(state.scan.adoptedAt);
    render();
    return;
  }
  // The result arrives after the sweep; progress arrives on the event channel.
  await refreshScanState();
}

async function cancelScan() {
  toast({ tone: 'warn', title: 'Cancelling', body: 'Telling the scan to stop. Whatever was collected up to this point is kept.' });
  if (!client.live) return;
  await client.invoke('scan:cancel');
  updateScanButtons();
}

async function saveReport(format) {
  toast({ tone: 'info', title: `Preparing ${String(format).toUpperCase()}`, body: 'Rendering from the last completed scan.' });
  const status = document.getElementById('vx-report-status');
  if (status) status.textContent = `Preparing ${format.toUpperCase()}…`;
  const result = await client.invoke('report:save', format);
  if (!status) return;
  if (!result.ok) {
    status.textContent = `Could not save: ${result.error.message}`;
    return;
  }
  status.textContent = result.data.saved ? `Saved to ${result.data.path}` : 'Save cancelled.';
}

async function changeSetting(key, value) {
  const result = await client.invoke('app:setSetting', key, value);
  if (!result.ok) {
    // Re-read so the control snaps back to the stored value rather than showing a
    // change that did not happen.
    await loadSettings();
    render();
    return;
  }
  await loadSettings();
  applyTheme(state.settings?.ui);
  render();
}

async function loadSettings() {
  const result = await client.invoke('app:settings');
  if (result.ok) state.settings = result.data;
}

async function refreshScanState() {
  const result = await client.invoke('scan:state');
  if (!result.ok) {
    state.scan.running = false;
    state.scan.error = result.error?.message ?? 'The scan state could not be read.';
    render();
    return;
  }
  state.scan.running = Boolean(result.data.running);
  if (!state.scan.running && !state.scan.finished) {
    await loadLastScan();
    // The scan finished while we were waiting; pull the summary.
    state.scan.finished = state.scan.finished ?? { durationMs: 0, cancelled: false };
  }
  updateScanButtons();
  render();
}

async function loadManual() {
  const [suites, coverage] = await Promise.all([client.invoke('manual:suites'), client.invoke('manual:coverage')]);
  if (suites.ok) state.suites = suites.data.suites;
  if (coverage.ok) state.manual = coverage.data;
  // Only re-render when there is something new to show. Re-rendering on a failed
  // load is what produced the loop described above.
  if ((suites.ok || coverage.ok) && state.page === 'manual') render();
}

async function startMonitor() {
  if (!client.live || state.monitor.running) return;
  state.monitor.starting = true;
  state.monitor.error = null;
  render();

  const result = await client.invoke('monitor:start');
  state.monitor.starting = false;

  if (!result.ok) {
    // "Started" is only reported when it genuinely started; a refusal is shown as one.
    state.monitor.running = false;
    state.monitor.error = result.error?.message ?? 'Sampling could not be started.';
  } else {
    state.monitor.running = true;
    state.monitor.sensors = result.data?.sensors ?? [];
    state.monitor.note = result.data?.note ?? null;
    state.monitor.sample = null;
  }
  if (state.page === 'monitor') render();
}

async function stopMonitor() {
  if (!client.live) return;
  await client.invoke('monitor:stop');
  state.monitor.running = false;
  state.monitor.note = 'Sampling stopped. The readings above are no longer live.';
  if (state.page === 'monitor') render();
}

async function loadHistory() {
  // Same rule as loadManual: never re-render from inside a failed load, or the page
  // renders, requests, renders again. The flag is cleared on both paths.
  try {
    const result = await client.invoke('history:list');
    if (result.ok) {
      state.history = { entries: result.data?.entries ?? [] };
    } else {
      state.history = { entries: null, error: result.error?.message ?? 'The history store could not be read.' };
    }
  } catch (error) {
    state.history = { entries: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    state.historyLoading = false;
  }
  if (state.page === 'history') render();
}

async function loadGuard() {
  const result = await client.invoke('app:guardSummary');
  if (result.ok) state.guard = result.data;
}

/** Wire the event channels the preload exposes. */
function subscribe() {
  client.on('scan:progress', (payload) => {
    state.scan.done = payload.done;
    state.scan.total = payload.total;
    state.scan.taskId = payload.taskId;
    state.scan.running = true;
    if (state.page === 'dashboard') render();
  });

  client.on('scan:finished', (payload) => {
    state.scan.running = false;
    state.scan.finished = payload;
    const failed = (payload?.issues?.errors?.length ?? 0) > 0;
    toast({
      tone: failed ? 'warn' : 'good',
      title: payload?.cancelled ? 'Scan cancelled' : 'Scan finished',
      body: payload?.cancelled
        ? 'The run was stopped early. The report says which tasks never ran.'
        : `Finished in ${formatDuration(payload?.durationMs ?? 0)}. Open Reports to export the evidence.`
    });
    void (async () => {
      // Fill the pages with what the run actually collected. Without this the sweep finished
      // and left every diagnostic page saying "Not collected yet".
      await loadLastScan();
      await loadManual();
      render();
    })();
  });

  client.on('settings:changed', async () => {
    await loadSettings();
    applyTheme(state.settings?.ui);
    render();
  });

  client.on('monitor:sample', (payload) => {
    state.monitor.sample = payload;
    state.monitor.running = true;
    if (state.page === 'monitor') render();
  });

  client.on('monitor:stopped', (payload) => {
    state.monitor.running = false;
    state.monitor.error = payload?.reason ?? null;
    if (state.page === 'monitor') render();
  });

  client.on('app:error', (payload) => {
    state.scan.error = payload?.message ?? 'An error occurred in the main process.';
    toast({ tone: 'bad', title: 'The main process reported an error', body: state.scan.error });
    render();
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const app = document.getElementById('app');
  if (!app) return;

  app.replaceChildren();

  if (client.live) {
    const infoResult = await client.invoke('app:info');
    if (infoResult.ok) state.info = infoResult.data;
    await loadSettings();
    await loadGuard();
    await loadLastScan();
  }

  applyTheme(state.settings?.ui);

  topbar = buildTopbar();
  contentHost = el('main', { class: 'vx-content', attrs: { id: 'vx-content' } });

  const main = el('div', { class: 'vx-main', children: [topbar, contentHost] });
  app.append(buildSidebar(), main);

  subscribe();
  installShortcuts();
  navigate('dashboard');
  // The tour comes after the shell so a user who skips lands on a ready application, not a blank
  // one. It never blocks a scan: the dialog can be dismissed with Escape and the tour re-offered.
  void runOnboarding();
  await loadManual();
  navigate(state.page);
}

// Booting needs a document. The module is also imported by tests that only want the
// shortcut table, and by static analysis, in both of which there is no DOM at all.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void boot());
  } else {
    void boot();
  }
}
