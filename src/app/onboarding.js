/**
 * VERIDEX — first run (MODULE 20, R-20-01).
 *
 * Four screens, thirty seconds, no interruption: what this is, what it will not do, what it
 * needs permission for, and what it keeps. Then it gets out of the way.
 *
 * The rules:
 *
 *   - **No elevation to finish onboarding.** A user can read every screen, accept, and start
 *     using a standard-user application. Anything privileged is requested later, per task.
 *   - **Skipping is a first-class choice**, and it records that it happened, so the interface
 *     can offer the tour again from Settings rather than pretending it was seen.
 *   - **Interrupted is not complete.** If the application closes on screen two, the next launch
 *     starts at the beginning: a half-read privacy notice is not consent.
 *   - **Completion is a setting**, not a hidden file, so the user can find it, reset it, and see
 *     it in the settings file they can read.
 *
 * This module holds the state machine and the copy; the renderer holds the pixels. Both are
 * tested, and the copy is asserted because the promises in it are product promises.
 *
 * @module
 */

/** The steps, in order. `id` is stable and is what the settings record. */
export const STEPS = Object.freeze([
  {
    id: 'welcome',
    title: 'VERIDEX reads your machine and tells you the truth about it',
    body: [
      'VERIDEX is a local diagnostic tool for Windows PCs and laptops. It reads hardware identity, storage health, battery wear, drivers, Windows state and the event log, then writes a report you can keep.',
      'It is made by MERQO. It has no account, no telemetry and no cloud.'
    ],
    action: 'Start'
  },
  {
    id: 'limits',
    title: 'What VERIDEX cannot tell you',
    body: [
      'Software cannot hear a failing fan bearing, see a dead pixel, or feel a worn hinge. Those checks are a manual programme: the application asks you what you observe and records your answer as your observation, not as a measurement.',
      'A diagnostic is evidence, not a verdict. VERIDEX says what it read, names what it could not read, and never turns a gap into a pass.'
    ],
    action: 'Understood'
  },
  {
    id: 'permissions',
    title: 'Some readings need administrator rights',
    body: [
      'SMART data, the component-store flag, BitLocker state and driver export require elevation. VERIDEX runs as a standard user and asks for elevation one task at a time, only when you choose that task.',
      'Declining is fine: the rest of the scan still runs, and the fields that needed elevation say "Permission required" rather than pretending to have been read.'
    ],
    action: 'Understood'
  },
  {
    id: 'privacy',
    title: 'What is kept, and what never leaves this machine',
    body: [
      'Reports, run history and logs are written to this machine and nowhere else. Reports are stored without identifiers unless you include them; logs are redacted and capped by size.',
      'Nothing is uploaded. There is no analytics endpoint in the application, and the network guard blocks outbound connections made by anything it runs.'
    ],
    action: 'Finish'
  }
]);

/**
 * The state of first-run onboarding.
 *
 * @param {{values?: Record<string, unknown>}} [settings]
 * @returns {{needed: boolean, step: string|null, stepIndex: number, completedAt: string|null, skipped: boolean}}
 */
export function onboardingState(settings = {}) {
  const values = settings?.values ?? {};
  // The completion time is written to `firstRunCompletedAt`; an older build wrote the ISO
  // string into `firstRunComplete` itself, and that shape is still read so an existing profile
  // does not lose its history. Reading only the old key left a completed tour reporting
  // `completedAt: null` — the state machine knew the tour was done but not when.
  const explicitCompletedAt = typeof values['privacy.firstRunCompletedAt'] === 'string' ? values['privacy.firstRunCompletedAt'] : null;
  const legacyCompletedAt = typeof values['privacy.firstRunComplete'] === 'string' ? values['privacy.firstRunComplete'] : null;
  const completedAt = explicitCompletedAt ?? legacyCompletedAt;
  // An explicit `false` wins over a leftover timestamp. The two are contradictory only if the
  // file was edited or a reset half-wrote, and in that case the user's choice (reset) is the
  // one that should be honoured: showing the tour again is recoverable in one click, hiding
  // it when it was asked for is not.
  const explicitFalse = values['privacy.firstRunComplete'] === false;
  const finished = !explicitFalse && (values['privacy.firstRunComplete'] === true || completedAt !== null);
  // A recorded step only counts if the run was not finished; it is what lets an interrupted tour
  // resume *visibly* (the interface can say "you were part-way through") without resuming silently.
  const savedStep = typeof values['privacy.firstRunStep'] === 'string' ? values['privacy.firstRunStep'] : null;

  if (finished) {
    return { needed: false, step: null, stepIndex: STEPS.length, completedAt, skipped: values['privacy.firstRunSkipped'] === true };
  }
  const index = STEPS.findIndex((step) => step.id === savedStep);
  const stepIndex = index >= 0 ? index : 0;
  return { needed: true, step: STEPS[stepIndex].id, stepIndex, completedAt: null, skipped: values['privacy.firstRunSkipped'] === true };
}

/**
 * Advance one step. Returns the settings to write.
 *
 * Persisting on every step is what makes an interrupted run *resumable* rather than restarting —
 * and the state above deliberately does not treat a saved step as completion.
 *
 * @param {{currentStepId?: string|null, now?: Date}} input
 * @returns {{values: Record<string, unknown>, done: boolean, nextStep: string|null}}
 */
export function advanceOnboarding(input = {}) {
  const currentIndex = Math.max(0, STEPS.findIndex((step) => step.id === input.currentStepId));
  const next = STEPS[currentIndex + 1] ?? null;
  const now = (input.now ?? new Date()).toISOString();

  if (!next) {
    return {
      values: {
        'privacy.firstRunComplete': true,
        'privacy.firstRunCompletedAt': now,
        'privacy.firstRunStep': null,
        'privacy.firstRunSkipped': false
      },
      done: true,
      nextStep: null
    };
  }
  return {
    values: { 'privacy.firstRunStep': next.id, 'privacy.firstRunComplete': false },
    done: false,
    nextStep: next.id
  };
}

/**
 * Skip the tour.
 *
 * Recorded as skipped rather than completed: the distinction matters, because "finished" would
 * mean the user has read the permission and privacy statements, and they have not.
 *
 * @param {{now?: Date}} [input]
 */
export function skipOnboarding(input = {}) {
  const now = (input.now ?? new Date()).toISOString();
  return {
    values: {
      'privacy.firstRunComplete': true,
      'privacy.firstRunCompletedAt': now,
      'privacy.firstRunSkipped': true,
      'privacy.firstRunStep': null
    },
    done: true,
    nextStep: null
  };
}

/**
 * Reset the tour so it runs again. Offered from Settings, which is also where the record lives.
 */
export function resetOnboarding() {
  return {
    values: {
      'privacy.firstRunComplete': false,
      'privacy.firstRunCompletedAt': null,
      'privacy.firstRunStep': null,
      'privacy.firstRunSkipped': false
    }
  };
}

/**
 * Whether onboarding may request elevation. It never may — this function exists so the answer is
 * asserted by a test rather than remembered by a person.
 */
export function onboardingRequiresElevation() {
  return false;
}
