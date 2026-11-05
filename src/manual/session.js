/**
 * VERIDEX — Manual inspection session.
 *
 * A session records what an inspector actually did. Its central rule: **a test
 * that was not answered stays UNTESTED.** There is no default, no "assume good
 * unless stated", and no way to mark a suite complete by opening it.
 *
 * Results carry provenance so the report can distinguish:
 *   - a captured verdict (device events were observed),
 *   - a human observation (a person looked and said so),
 *   - an observation that was recorded but whose evidence is thin (e.g. PASS with
 *     no defect count where a count was requested) — surfaced as a warning rather
 *     than silently accepted.
 */

import { Status } from '../core/status.js';
import { MANUAL_TESTS, MANUAL_SUITES, manualTest, testProvenance } from './registry.js';

/**
 * @typedef {object} ManualResult
 * @property {string} id
 * @property {string} title
 * @property {string} suiteId
 * @property {string} component
 * @property {'capture'|'observe'} kind
 * @property {string} status
 * @property {string|null} observedAt
 * @property {string[]} notes
 * @property {number|null} defects      A recorded defect count, when one applies.
 * @property {string|null} severity     'none' | 'minor' | 'significant' | null
 * @property {string|null} inspector    Free-text who recorded it, for multi-person workshops.
 */

/** Verdicts a human or a capture can record. UNTESTED is not one of them. */
export const RECORDABLE_VERDICTS = Object.freeze([Status.PASS, Status.FAIL, Status.WARNING, Status.NOT_APPLICABLE]);

export class InspectionSession {
  /**
   * @param {{suites?: typeof MANUAL_SUITES, now?: () => Date, inspector?: string|null}} [options]
   */
  constructor(options = {}) {
    this.suites = options.suites ?? MANUAL_SUITES;
    this.now = options.now ?? (() => new Date());
    this.inspector = options.inspector ?? null;
    this.startedAt = this.now().toISOString();
    /** @type {Map<string, ManualResult>} */
    this.results = new Map();
    this.notes = [];
  }

  /** Every test in the session, with its current state. */
  tests() {
    return this.suites.flatMap((suite) =>
      suite.tests.map((test) => ({
        ...test,
        suiteId: suite.id,
        component: test.component ?? suite.component,
        provenance: testProvenance(test.id)
      }))
    );
  }

  /** @param {string} testId */
  result(testId) {
    return this.results.get(testId) ?? null;
  }

  /**
   * Record a verdict.
   *
   * @param {string} testId
   * @param {string} verdict
   * @param {{notes?: string[], defects?: number|null, severity?: string|null, inspector?: string, evidence?: Record<string, unknown>}} [detail]
   * @returns {{ok:boolean, result:ManualResult|null, problems:string[]}}
   */
  record(testId, verdict, detail = {}) {
    /** @type {string[]} */
    const problems = [];
    const test = manualTest(testId);
    if (!test) return { ok: false, result: null, problems: [`Unknown manual test "${testId}"`] };

    if (!RECORDABLE_VERDICTS.includes(verdict)) {
      return {
        ok: false,
        result: null,
        problems: [
          `"${verdict}" cannot be recorded as a verdict. Use PASS, FAIL, WARNING or NOT_APPLICABLE. An unrun test stays UNTESTED and must not be recorded as anything else.`
        ]
      };
    }

    // NOT_APPLICABLE requires a declared reason, or it becomes a silent way to
    // skip tests and still show a clean report.
    if (verdict === Status.NOT_APPLICABLE) {
      if (!test.notApplicableWhen?.length) {
        problems.push(`Test "${testId}" has no declared reason for being not applicable, so it cannot be skipped.`);
      }
      if (!detail.notes?.length) {
        problems.push('Recording a test as not applicable requires a note explaining why.');
      }
    }

    // Order matters: report the most specific problem first, so the inspector is
    // not told "add a note" when what is actually missing is a fault description.
    if (verdict === Status.FAIL && !detail.notes?.length) {
      problems.push('A FAIL verdict requires a note describing the fault; a failure with no description cannot be actioned.');
    } else if (test.kind === 'observe' && verdict !== Status.NOT_APPLICABLE && !detail.notes?.length && detail.defects === undefined) {
      // A human observation must at least carry a note or a defect count; otherwise
      // the report contains a verdict with no evidence behind it.
      problems.push('A manual observation needs at least one note or a recorded count describing what you saw.');
    }

    if (problems.length > 0) return { ok: false, result: null, problems };

    /** @type {ManualResult} */
    const result = {
      id: test.id,
      title: test.title,
      suiteId: test.suiteId ?? this.#suiteIdFor(testId),
      component: test.component ?? this.#suiteFor(testId)?.component ?? 'misc',
      kind: test.kind,
      status: verdict,
      observedAt: this.now().toISOString(),
      notes: [...(detail.notes ?? [])],
      defects: detail.defects === undefined ? null : detail.defects,
      severity: detail.severity ?? null,
      inspector: detail.inspector ?? this.inspector
    };
    this.results.set(testId, result);
    return { ok: true, result, problems: [] };
  }

  /** Remove a verdict, returning the test to UNTESTED. */
  clear(testId) {
    return this.results.delete(testId);
  }

  /** @param {string} testId */
  #suiteIdFor(testId) {
    return this.#suiteFor(testId)?.id ?? 'misc';
  }

  /** @param {string} testId */
  #suiteFor(testId) {
    return this.suites.find((suite) => suite.tests.some((test) => test.id === testId)) ?? null;
  }

  /**
   * Progress per suite. `untested` is the count of tests the inspector has not
   * answered, which is the number that keeps a report honest.
   */
  progress() {
    return this.suites.map((suite) => {
      const ids = suite.tests.map((test) => test.id);
      const answered = ids.filter((id) => this.results.has(id));
      const counts = { pass: 0, fail: 0, warning: 0, notApplicable: 0 };
      for (const id of answered) {
        const status = this.results.get(id)?.status;
        if (status === Status.PASS) counts.pass += 1;
        else if (status === Status.FAIL) counts.fail += 1;
        else if (status === Status.WARNING) counts.warning += 1;
        else if (status === Status.NOT_APPLICABLE) counts.notApplicable += 1;
      }
      return {
        suiteId: suite.id,
        title: suite.title,
        total: ids.length,
        answered: answered.length,
        untested: ids.length - answered.length,
        ...counts,
        complete: answered.length === ids.length
      };
    });
  }

  /**
   * The results array for the report, in a stable order.
   *
   * Untested tests are *excluded* here: the report's coverage maths counts them
   * from the registry, so including them as rows would double-count. The coverage
   * summary carries the untested total.
   */
  resultsForReport() {
    return this.tests()
      .filter((test) => this.results.has(test.id))
      .map((test) => this.results.get(test.id));
  }

  /**
   * Coverage of the manual programme. Deliberately separate from the health
   * score: a machine can score well on the evidence collected while most of the
   * manual programme was never run, and the report must be able to say both.
   */
  coverage() {
    const total = this.tests().length;
    const results = [...this.results.values()];
    const applicable = results.filter((result) => result.status !== Status.NOT_APPLICABLE);
    const passed = applicable.filter((result) => result.status === Status.PASS).length;
    const failed = applicable.filter((result) => result.status === Status.FAIL).length;
    const warned = applicable.filter((result) => result.status === Status.WARNING).length;
    const notApplicable = results.length - applicable.length;
    const untested = total - results.length;

    return {
      totalTests: total,
      answered: results.length,
      passed,
      failed,
      warned,
      notApplicable,
      untested,
      percentComplete: total === 0 ? 0 : Math.round((results.length / total) * 1000) / 10,
      // Of the tests actually performed, how many were clean.
      percentPassedOfRun: applicable.length === 0 ? 0 : Math.round((passed / applicable.length) * 1000) / 10,
      statement:
        untested === 0
          ? `All ${total} manual inspection tests were answered (${notApplicable} recorded as not applicable).`
          : `${results.length} of ${total} manual inspection tests were answered; ${untested} were not run and are reported as UNTESTED, not as passing.`
    };
  }

  /**
   * Observations that are recorded but under-evidenced, so the report can flag
   * them instead of presenting them as clean passes.
   */
  weakResults() {
    /** @type {string[]} */
    const warnings = [];
    for (const result of this.results.values()) {
      const test = manualTest(result.id);
      if (!test) continue;
      if (result.status === Status.PASS) {
        const wantsCount = test.evidence.some((line) => /count/i.test(line));
        if (wantsCount && (result.defects === null || result.defects === undefined)) {
          warnings.push(`${result.id}: recorded as PASS without the defect count this test asks for.`);
        }
      }
      if (result.status === Status.FAIL && result.defects !== null && result.defects !== undefined && result.defects === 0) {
        warnings.push(`${result.id}: recorded as FAIL but the defect count is 0. Re-check the entry.`);
      }
    }
    return warnings;
  }

  /**
   * Turn the session into report issues so the exported document shows what the
   * inspector should still do.
   */
  toIssues() {
    const coverage = this.coverage();
    const progress = this.progress();
    const incomplete = progress.filter((entry) => !entry.complete);
    /** @type {string[]} */
    const warnings = [...this.weakResults()];
    if (incomplete.length > 0) {
      warnings.push(
        `Manual inspection incomplete: ${incomplete.map((entry) => `${entry.title} (${entry.answered}/${entry.total})`).join(', ')}.`
      );
    }
    for (const result of this.results.values()) {
      if (result.status === Status.FAIL) warnings.push(`Manual test failed — ${result.title}: ${result.notes.join('; ') || 'no note recorded'}`);
    }
    return {
      warnings,
      errors: [],
      conflicts: [],
      coverage,
      statement: coverage.statement
    };
  }

  /** Record a free-text session note (e.g. "hinge creaks when opened past 100°"). */
  addNote(note) {
    if (!note || String(note).trim().length === 0) return false;
    this.notes.push({ at: this.now().toISOString(), text: String(note).trim() });
    return true;
  }

  /**
   * Serialise for persistence. Timestamps are kept so a report can state when each
   * observation was made.
   */
  toJSON() {
    return {
      startedAt: this.startedAt,
      inspector: this.inspector,
      results: [...this.results.values()],
      notes: [...this.notes]
    };
  }

  /**
   * Restore a session. Unknown test ids in the saved data are dropped with a
   * warning rather than resurrected, so a removed test cannot reappear in a report.
   * @param {ReturnType<InspectionSession['toJSON']>} data
   */
  static fromJSON(data, options = {}) {
    const session = new InspectionSession(options);
    /** @type {string[]} */
    const dropped = [];
    for (const result of data?.results ?? []) {
      if (!manualTest(result.id)) {
        dropped.push(result.id);
        continue;
      }
      session.results.set(result.id, { ...result });
    }
    if (data?.startedAt) session.startedAt = data.startedAt;
    if (data?.inspector) session.inspector = data.inspector;
    for (const note of data?.notes ?? []) session.notes.push(note);
    session.droppedOnLoad = dropped;
    return session;
  }
}

/**
 * Which suites apply to a machine, given what the automatic diagnostics found.
 * This exists so a desktop is not nagged about its missing touchpad, without ever
 * *marking* anything as passing. Anything uncertain stays in the list.
 *
 * @param {{hasBattery?: boolean, hasCamera?: boolean, hasTouchpad?: boolean, hasCardReader?: boolean, hasOpticalDrive?: boolean}} facts
 */
export function applicableSuites(facts = {}) {
  /** @type {Array<{suiteId:string, applicable:boolean, reason:string|null}>} */
  const decisions = [];
  const decide = (suiteId, applicable, reason) => decisions.push({ suiteId, applicable, reason });

  decide('display', true, null);
  decide('keyboard', true, null);
  decide('mouse', true, null);
  decide('audio', true, null);
  decide('ports', true, null);

  if (facts.hasTouchpad === undefined) {
    decide('touchpad', true, 'The OS did not report a touchpad; the tests stay listed so you can confirm by hand.');
  } else {
    decide('touchpad', facts.hasTouchpad, facts.hasTouchpad ? null : 'No touchpad detected by the operating system.');
  }

  if (facts.hasCamera === undefined) {
    decide('camera', true, 'The OS did not report a camera; the tests stay listed so you can confirm by hand.');
  } else {
    decide('camera', facts.hasCamera, facts.hasCamera ? null : 'No camera detected by the operating system.');
  }

  return decisions;
}

/**
 * A printable checklist for inspectors working without the app open. Generated
 * from the registry so it can never omit a test.
 */
export function printableChecklist() {
  const lines = [];
  for (const suite of MANUAL_SUITES) {
    lines.push(`## ${suite.title}`);
    if (suite.requiresHardware) lines.push(`Requires: ${suite.requiresHardware}`);
    for (const test of suite.tests) {
      const provenance = testProvenance(test.id);
      lines.push(`- [ ] ${test.title}  —  ${provenance.label}`);
      lines.push(`      ${test.instructions}`);
      if (test.passCriteria) lines.push(`      Pass when: ${test.passCriteria}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export { MANUAL_TESTS, MANUAL_SUITES };
