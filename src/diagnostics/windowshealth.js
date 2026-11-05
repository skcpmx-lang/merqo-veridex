/**
 * VERIDEX — Windows component-store health (MODULE 10, R-10-04).
 *
 * `sfc /scannow` and `DISM /RestoreHealth` are repair commands. They write to the
 * component store, they take tens of minutes, and on a machine that is working fine
 * they change nothing except the user's patience. Nothing in this module runs them.
 *
 * What it does run is `DISM /Online /Cleanup-Image /CheckHealth`, which only reads the
 * corruption flag the servicing stack already holds. It is fast, it is read-only, and
 * its answer is one of exactly three sentences — so this module reports the sentence it
 * got and refuses to invent anything else.
 *
 * The distinction the rest of the application depends on:
 *
 *   "No component store corruption detected"  → the store is healthy *as far as the flag knows*
 *   "The component store is repairable"       → corruption has been *flagged*; a repair exists
 *   "The component store is not repairable"   → corruption has been flagged and needs media
 *
 * A flag that was never set does not mean every file is intact — `CheckHealth` is a
 * cached verdict, not a scan — and the field's notes say so, in those words. A repair is
 * never offered automatically; the manual test registry carries it as a consent-gated
 * task so the user performs it themselves, knowingly.
 *
 * @module
 */

import { available, unavailable, field, unsupported, permissionRequired, failed } from '../core/field.js';
import { Status } from '../core/status.js';
import { runReadOnly, summariseToolOutput } from '../platform/windows.js';

/** The three sentences DISM can return, matched case-insensitively. */
const VERDICTS = [
  { match: /no component store corruption detected/i, verdict: 'healthy' },
  { match: /the component store is repairable|component store corruption (was|is) (detected|repairable)/i, verdict: 'repairable' },
  { match: /the component store is not repairable|component store corruption.*not repairable/i, verdict: 'unrepairable' }
];

/**
 * Read the component-store verdict out of DISM output.
 *
 * Pure, and deliberately strict: an output this function does not recognise becomes
 * `unknown`, never `healthy`. Guessing here would tell a user their system files are
 * fine on the strength of a parsing failure.
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {{verdict: 'healthy'|'repairable'|'unrepairable'|'unknown', sentence: string|null, raw: string}}
 */
export function parseDismHealth(stdout, stderr = '') {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  for (const candidate of VERDICTS) {
    const found = text.match(candidate.match);
    if (found) {
      // Report the sentence as DISM wrote it, trimmed to the sentence itself.
      const line = text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => candidate.match.test(entry)) ?? found[0];
      return { verdict: candidate.verdict, sentence: line.replace(/^[^A-Za-z]*/, '').slice(0, 200), raw: text.slice(0, 600) };
    }
  }
  return { verdict: 'unknown', sentence: null, raw: text.slice(0, 600) };
}

/**
 * Turn the verdict into report fields.
 * @param {{verdict: 'healthy'|'repairable'|'unrepairable'|'unknown', sentence: string|null}} parsed
 * @param {string} source
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function describeStoreHealth(parsed, source) {
  const notes = [
    'This is the servicing stack\'s own corruption flag, not a file-by-file scan. A healthy flag means no corruption has been recorded; it is not proof that every system file is intact.'
  ];

  if (parsed.verdict === 'healthy') {
    return {
      componentStore: available(parsed.sentence ?? 'No component store corruption detected', source, { notes }),
      componentStoreVerdict: available('healthy', source, { notes })
    };
  }
  if (parsed.verdict === 'repairable') {
    return {
      componentStore: field(parsed.sentence ?? 'The component store is repairable', {
        status: Status.WARNING,
        source,
        notes: [
          ...notes.slice(0, 1),
          'Corruption has been flagged and a repair is possible. VERIDEX does not run the repair: `DISM /Online /Cleanup-Image /RestoreHealth` writes to the component store and must be run by you, deliberately, in an elevated prompt.'
        ]
      }),
      componentStoreVerdict: field('repairable', { status: Status.WARNING, source }),
      componentStoreRepair: field('Manual: DISM /Online /Cleanup-Image /RestoreHealth', {
        status: Status.WARNING,
        source,
        notes: ['Run this yourself in an elevated prompt. VERIDEX will not write to the component store on your behalf.']
      })
    };
  }
  if (parsed.verdict === 'unrepairable') {
    return {
      componentStore: field(parsed.sentence ?? 'The component store is not repairable', {
        status: Status.FAIL,
        source,
        notes: [
          ...notes.slice(0, 1),
          'The store cannot repair itself from what is on this machine. The usual remedy is an in-place repair install from installation media — a decision for you, not for a diagnostic tool.'
        ]
      }),
      componentStoreVerdict: field('unrepairable', { status: Status.FAIL, source })
    };
  }
  return {
    componentStore: unsupported('DISM returned an answer this build does not recognise, so nothing is claimed about the component store.', source, { notes: [parsed.raw ? `DISM printed: ${parsed.raw.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 200)}` : 'DISM printed nothing.'] }),
    componentStoreVerdict: unsupported('Unrecognised DISM output', source)
  };
}

/**
 * Register the component-store task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerWindowsHealth(registry) {
  registry.registerProvider({
    id: 'dism.checkhealth',
    title: 'DISM component-store check',
    capability: 'windowsHealth',
    priority: 1,
    // /CheckHealth reads a flag, so it returns in a second or two when it works at all.
    // If it has not answered in 90 s the servicing stack is busy, which is worth reporting
    // rather than waiting for.
    timeoutMs: 90_000,
    collect: async (ctx) => {
      if (!ctx.permissions.isAdmin) {
        return {
          componentStore: permissionRequired(
            'Reading the component-store flag requires administrative rights.',
            'dism'
          )
        };
      }

      const run = await runReadOnly(ctx.runner, 'dism.exe', ['/Online', '/Cleanup-Image', '/CheckHealth'], { timeoutMs: 80_000 });

      // DISM exits 0 for every one of its verdicts, including "not repairable", so the exit
      // code says nothing about the store. Only the sentence does.
      const parsed = parseDismHealth(run.stdout, run.stderr);
      const fields = describeStoreHealth(parsed, 'dism');

      if (!run.ok && parsed.verdict === 'unknown') {
        fields.componentStore = failed(`DISM did not answer${summariseToolOutput(run)}`, 'dism', {
          notes: ['Without an answer from DISM the component store is untested, not healthy.']
        });
        return fields;
      }
      if (run.timedOut) {
        return {
          componentStore: unavailable('DISM did not finish within its budget; the servicing stack may be busy.', 'dism')
        };
      }
      return fields;
    }
  });

  registry.registerTask({
    id: 'windows.componentHealth',
    module: 'windowsHealth',
    title: 'Windows component-store health',
    quick: false,
    requiresCapability: 'windowsHealth',
    providers: ['dism.checkhealth'],
    validate: (fields) => {
      const verdict = fields.componentStoreVerdict?.value;
      if (verdict && !['healthy', 'repairable', 'unrepairable'].includes(verdict)) {
        return [`component-store verdict "${verdict}" is not one DISM can return`];
      }
      return [];
    }
  });
}
