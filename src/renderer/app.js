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
  state.scan.assessment = payload.assessment ?? null;
  state.scan.coverage = payload.coverage ?? null;
  state.scan.issues = payload.issues ?? null;
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
    card.append(callout({ tone: 'bad', title: 'The scan could not run', body: state.scan.error }));
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

  wrapper.append(
    el('div', { class: 'vx-grid vx-grid--2', children: [healthCard, coverageCard] }),
    scanProgressCard(),
    componentCard
  );

  // Issues
  if (state.scan.issues && (state.scan.issues.warnings.length || state.scan.issues.errors.length)) {
    const issuesCard = el('div', { class: 'vx-card' });
    issuesCard.append(el('h2', { class: 'vx-card__title', text: 'Needs attention' }));
    for (const error of state.scan.issues.errors) {
      issuesCard.append(callout({ tone: 'bad', title: 'Error', body: error }));
    }
    for (const warning of state.scan.issues.warnings) {
      issuesCard.append(callout({ tone: 'warn', title: 'Warning', body: warning }));
    }
    wrapper.append(issuesCard);
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
  wrapper.append(actions);

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
function stackPages(builders) {
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
]);

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

pages.reports = () => {
  const wrapper = el('div', { class: 'vx-grid', style: { gap: 'var(--vx-space-lg)' } });
  if (!client.live) wrapper.append(previewBanner());

  const card = el('div', { class: 'vx-card' });
  card.append(el('h2', { class: 'vx-card__title', text: 'Export' }));

  if (!state.scan.finished) {
    card.append(emptyState('No scan to export', 'Run a scan first. A report is built from collected evidence, and VERIDEX will not generate a document from nothing.'));
    wrapper.append(card);
    return wrapper;
  }

  const privacy = state.settings?.values?.['diagnostics.includeSensitiveInReport'];
  card.append(
    callout({
      tone: privacy ? 'warn' : 'ok',
      title: privacy ? 'This export will include identifiers' : 'Identifiers are redacted',
      body: privacy
        ? 'Serial numbers, network addresses and account names will appear in the file. Treat it as personal data.'
        : 'Serial numbers, MAC and IP addresses, hostnames and account names are replaced with [redacted] before the document is written. Turn this on in Privacy if you need them.'
    })
  );

  const buttons = el('div', { style: { display: 'flex', gap: 'var(--vx-space-sm)', flexWrap: 'wrap' } });
  for (const format of ['pdf', 'html', 'csv', 'json']) {
    buttons.append(
      button({
        label: `Save ${format.toUpperCase()}`,
        variant: format === 'pdf' ? 'primary' : 'ghost',
        onClick: () => saveReport(format)
      })
    );
  }
  card.append(buttons);

  const status = el('p', { class: 'vx-dim', id: 'vx-report-status' });
  card.append(status);
  wrapper.append(card);
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
  state.scan = { running: true, done: 0, total: 0, taskId: null, finished: null, error: null };
  updateScanButtons();
  render();

  const result = await client.invoke('scan:start', { tasks: [] });
  if (!result.ok) {
    state.scan = { running: false, done: 0, total: 0, taskId: null, finished: null, error: result.error.message };
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
