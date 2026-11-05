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
import { el, statusBadge, formatValue, formatDuration, formatTimestamp, fieldRow, emptyState, coverageStrip, progressBar, callout, button, tabStrip, sortBySeverity } from './ui.js';

const client = createClient();

/** Pages in navigation order, grouped as the brief's structure demands. */
const PAGES = [
  { id: 'dashboard', label: 'Dashboard', glyph: '◈', group: 'Overview' },
  { id: 'hardware', label: 'Hardware', glyph: '⌘', group: 'Diagnostics' },
  { id: 'battery', label: 'Battery', glyph: '▮', group: 'Diagnostics' },
  { id: 'storage', label: 'Storage', glyph: '⛁', group: 'Diagnostics' },
  { id: 'network', label: 'Network', glyph: '≋', group: 'Diagnostics' },
  { id: 'windows', label: 'Windows & security', glyph: '⛨', group: 'Diagnostics' },
  { id: 'drivers', label: 'Drivers & software', glyph: '⚙', group: 'Diagnostics' },
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
  scan: { running: false, done: 0, total: 0, taskId: null, finished: null, error: null },
  suites: null,
  manual: null,
  manualLoading: false,
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

  const bar = el('header', {
    class: 'vx-topbar',
    children: [
      el('div', { children: [title, subtitle] }),
      el('div', { class: 'vx-topbar__spacer' }),
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
        class: 'vx-score vx-score--unrated',
        children: [el('span', { class: 'vx-score__value', text: assessment?.gated ? 'Score withheld' : 'Unrated' })]
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
    healthCard.append(
      el('div', {
        class: 'vx-score',
        children: [
          el('span', { class: 'vx-score__value', text: String(assessment.score) }),
          el('span', { class: 'vx-score__max', text: '/ 100' }),
          el('span', { class: 'vx-score__rating', text: assessment.rating })
        ]
      })
    );
    const meter = el('div', { class: 'vx-meter', attrs: { role: 'img', 'aria-label': `Health score ${assessment.score} of 100` } });
    const fill = el('div', { class: 'vx-meter__fill' });
    fill.style.width = `${assessment.score}%`;
    meter.append(fill);
    healthCard.append(meter);
    healthCard.append(
      el('p', {
        class: 'vx-dim',
        text: `${assessment.ratedComponents} of ${assessment.totalComponents} components could be assessed (${assessment.coveragePercent}% coverage). Components without evidence are unrated, never counted as healthy.`
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
pages.windows = modulePage('windows', 'Windows and security', 'OS build, activation, Secure Boot, Defender and firewall state. Read-only: VERIDEX never changes a security setting.', 'Run a scan to collect operating-system state.');
pages.drivers = modulePage('drivers', 'Drivers and software', 'Driver inventory with dates and problem codes, plus installed-software summary. Driver export is consent-gated.', 'Run a scan to enumerate drivers.');

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
    for (const test of suite.tests) {
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
  card.append(
    emptyState(
      'Live sampling is not wired to this page yet',
      'The monitoring engine, ring buffers and statistics are implemented and tested. The graph view is not connected, so this page does not claim to be showing temperatures it is not reading.'
    )
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
  card.append(emptyState('History is not wired to this page yet', 'The history store and the run-to-run comparison engine are implemented and tested. This list view is not connected yet, so it does not pretend to show stored runs.'));
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
  drivers: pages.drivers,
  manual: pages.manual,
  performance: pages.performance,
  monitor: pages.monitor,
  reports: pages.reports,
  history: pages.history,
  settings: pages.settings,
  privacy: pages.privacy,
  about: pages.about
};

// ── Actions ──────────────────────────────────────────────────────────────────

async function startScan() {
  if (!client.live || state.scan.running) return;
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
  if (!client.live) return;
  await client.invoke('scan:cancel');
  updateScanButtons();
}

async function saveReport(format) {
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
    void (async () => {
      const full = await client.invoke('scan:state');
      await loadManual();
      render();
      void full;
    })();
  });

  client.on('settings:changed', async () => {
    await loadSettings();
    applyTheme(state.settings?.ui);
    render();
  });

  client.on('app:error', (payload) => {
    state.scan.error = payload?.message ?? 'An error occurred in the main process.';
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
  }

  applyTheme(state.settings?.ui);

  topbar = buildTopbar();
  contentHost = el('main', { class: 'vx-content', attrs: { id: 'vx-content' } });

  const main = el('div', { class: 'vx-main', children: [topbar, contentHost] });
  app.append(buildSidebar(), main);

  subscribe();
  navigate('dashboard');
  await loadManual();
  navigate(state.page);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
