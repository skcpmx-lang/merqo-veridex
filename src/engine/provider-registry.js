/**
 * VERIDEX — Provider registry and diagnostic runner.
 *
 * A *provider* is one way of asking the machine a question. A *task* is a question
 * that must be answered. The runner walks a task's providers in priority order,
 * keeps every partial answer, resolves disagreements, and records an attempt log
 * so the report can state exactly which mechanisms worked.
 *
 * Contract for providers (all providers, no exceptions):
 *   - receive a context and return a plain object of FieldValues;
 *   - never throw for an expected failure — return a field with an explanatory
 *     status instead, because an expected failure is data;
 *   - may throw for a genuinely unexpected error, which the runner captures as an
 *     ERROR field and logs, and the chain continues to the next provider.
 */

import { Status } from '../core/status.js';
import { section, failed, permissionRequired } from '../core/field.js';
import { resolveField } from './merge.js';
import { capability, requiresAdmin } from '../platform/permissions.js';

/**
 * @typedef {object} ProviderContext
 * @property {import('../platform/runner.js').CommandRunner} runner
 * @property {import('../platform/permissions.js').PermissionState} permissions
 * @property {import('../core/logger.js').Logger} logger
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ProviderDefinition
 * @property {string} id             Stable provider id used for confidence tiers.
 * @property {string} title          Human label shown in the report's source column.
 * @property {string} [capability]   Permission capability id, if privileged.
 * @property {number} priority       Lower runs first.
 * @property {(ctx: ProviderContext) => Promise<Record<string, import('../core/field.js').FieldValue>>} collect
 */

/**
 * @typedef {object} TaskDefinition
 * @property {string} id             e.g. 'cpu.info'
 * @property {string} module         Report section id, e.g. 'cpu'.
 * @property {string} title
 * @property {string[]} providers    Provider ids in preference order.
 * @property {(fields: Record<string, import('../core/field.js').FieldValue>) => string[]} [validate] Returns list of validation problems.
 * @property {boolean} [quick]       Included in a quick scan.
 * @property {string} [requiresCapability]
 */

export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, ProviderDefinition>} */
    this.providers = new Map();
    /** @type {Map<string, TaskDefinition>} */
    this.tasks = new Map();
  }

  /** @param {ProviderDefinition} definition */
  registerProvider(definition) {
    if (!definition?.id) throw new Error('Provider requires an id');
    if (typeof definition.collect !== 'function') throw new Error(`Provider "${definition.id}" requires a collect function`);
    if (this.providers.has(definition.id)) throw new Error(`Duplicate provider id "${definition.id}"`);
    this.providers.set(definition.id, { priority: 100, ...definition });
    return this;
  }

  /** @param {TaskDefinition} definition */
  registerTask(definition) {
    if (!definition?.id) throw new Error('Task requires an id');
    if (!Array.isArray(definition.providers) || definition.providers.length === 0) {
      throw new Error(`Task "${definition.id}" requires at least one provider`);
    }
    for (const providerId of definition.providers) {
      if (!this.providers.has(providerId)) {
        throw new Error(`Task "${definition.id}" references unknown provider "${providerId}"`);
      }
    }
    this.tasks.set(definition.id, definition);
    return this;
  }

  /** @param {string} id */
  provider(id) {
    const found = this.providers.get(id);
    if (!found) throw new Error(`Unknown provider "${id}"`);
    return found;
  }

  /** Tasks ordered for execution; quick tasks first. */
  taskList() {
    return [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** @param {string} id */
  task(id) {
    const found = this.tasks.get(id);
    if (!found) throw new Error(`Unknown task "${id}"`);
    return found;
  }

  /** Task ids grouped by module, for the UI's category pickers. */
  tasksByModule() {
    /** @type {Record<string, TaskDefinition[]>} */
    const out = {};
    for (const task of this.taskList()) {
      (out[task.module] ??= []).push(task);
    }
    return out;
  }
}

/**
 * @typedef {object} AttemptRecord
 * @property {string} providerId
 * @property {string} title
 * @property {boolean} ok
 * @property {string} status
 * @property {number} durationMs
 * @property {number} fieldCount
 * @property {string|null} error
 * @property {boolean} skipped
 * @property {string|null} skipReason
 */

/**
 * @typedef {object} TaskResult
 * @property {string} taskId
 * @property {string} module
 * @property {import('../core/field.js').Section} section
 * @property {AttemptRecord[]} attempts
 * @property {string[]} conflicts
 * @property {string[]} validationProblems
 * @property {number} durationMs
 */

export class DiagnosticRunner {
  /**
   * @param {{registry: ProviderRegistry, permissions: import('../platform/permissions.js').PermissionState, logger: import('../core/logger.js').Logger, timeoutMs?: number}} options
   */
  constructor(options) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.logger = options.logger;
    this.runner = options.runner ?? null;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Run one task through its provider chain.
   * @param {string} taskId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<TaskResult>}
   */
  async runTask(taskId, options = {}) {
    const task = this.registry.task(taskId);
    const started = Date.now();
    /** @type {AttemptRecord[]} */
    const attempts = [];
    /** @type {Array<{providerId:string, fields:Record<string, import('../core/field.js').FieldValue>}>} */
    const successes = [];
    /** @type {Record<string, Array<{providerId:string, field:import('../core/field.js').FieldValue}>>} */
    const candidatesByKey = {};

    for (const providerId of task.providers) {
      if (options.signal?.aborted) {
        attempts.push({
          providerId,
          title: providerId,
          ok: false,
          status: Status.UNKNOWN,
          durationMs: 0,
          fieldCount: 0,
          error: 'Cancelled before execution',
          skipped: true,
          skipReason: 'cancelled'
        });
        continue;
      }

      const provider = this.registry.provider(providerId);
      const capabilityId = provider.capability ?? task.requiresCapability;

      // Privilege gate: refuse before touching the OS, and record why.
      if (capabilityId && requiresAdmin(capabilityId) && !this.permissions.isAdmin) {
        const info = capability(capabilityId);
        attempts.push({
          providerId,
          title: provider.title,
          ok: false,
          status: Status.PERMISSION_REQUIRED,
          durationMs: 0,
          fieldCount: 0,
          error: info?.reason ?? 'Requires elevation',
          skipped: true,
          skipReason: 'permission'
        });
        await this.logger?.providerAttempt({
          provider: providerId,
          task: taskId,
          ok: false,
          status: Status.PERMISSION_REQUIRED,
          error: info?.reason ?? 'Requires elevation'
        });
        continue;
      }

      const providerStart = Date.now();
      try {
        const fields = await this.#withTimeout(
          provider.collect({
            runner: this.#runnerFor(provider),
            permissions: this.permissions,
            logger: this.logger,
            timeoutMs: this.timeoutMs,
            signal: options.signal
          }),
          this.timeoutMs,
          providerId
        );

        const plain = fields && typeof fields === 'object' ? fields : {};
        const fieldCount = Object.keys(plain).length;
        successes.push({ providerId, fields: plain });

        for (const [key, value] of Object.entries(plain)) {
          (candidatesByKey[key] ??= []).push({ providerId, field: value });
        }

        const usable = Object.values(plain).filter((f) => f && f.value !== null && f.value !== undefined).length;
        attempts.push({
          providerId,
          title: provider.title,
          ok: usable > 0,
          status: usable > 0 ? Status.PASS : Status.UNAVAILABLE,
          durationMs: Date.now() - providerStart,
          fieldCount,
          error: null,
          skipped: false,
          skipReason: null
        });
        await this.logger?.providerAttempt({ provider: providerId, task: taskId, ok: true, durationMs: Date.now() - providerStart, fieldCount });

        // A provider that resolved everything ends the chain early — no point
        // burning a 20 second timeout on a redundant fallback.
        if (usable > 0 && usable === fieldCount && fieldCount > 0) break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({
          providerId,
          title: provider.title,
          ok: false,
          status: Status.ERROR,
          durationMs: Date.now() - providerStart,
          fieldCount: 0,
          error: message,
          skipped: false,
          skipReason: null
        });
        await this.logger?.providerAttempt({ provider: providerId, task: taskId, ok: false, error: message });
      }
    }

    // Resolve every key across all providers that answered.
    /** @type {Record<string, import('../core/field.js').FieldValue>} */
    const resolvedFields = {};
    /** @type {string[]} */
    const conflicts = [];
    for (const [key, candidates] of Object.entries(candidatesByKey)) {
      const resolution = resolveField(key, candidates);
      if (resolution.field) resolvedFields[key] = resolution.field;
      if (resolution.conflict) {
        conflicts.push(
          `${key}: ${resolution.considered
            .filter((c) => c.value !== null && c.value !== undefined)
            .map((c) => `${c.providerId}=${JSON.stringify(c.value)}`)
            .join(' vs ')}`
        );
      }
    }

    // If nothing at all answered, synthesise an explanatory field so the section
    // is never silently empty.
    if (Object.keys(resolvedFields).length === 0) {
      const permissionBlocked = attempts.some((attempt) => attempt.status === Status.PERMISSION_REQUIRED);
      const errored = attempts.find((attempt) => attempt.status === Status.ERROR);
      resolvedFields[task.module] = permissionBlocked
        ? permissionRequired(attempts.find((attempt) => attempt.status === Status.PERMISSION_REQUIRED)?.error ?? 'Requires elevation', attempts[0]?.providerId ?? null)
        : failed(errored?.error ?? 'No provider produced data', attempts[0]?.providerId ?? null);
    }

    /** @type {string[]} */
    let validationProblems = [];
    if (typeof task.validate === 'function') {
      try {
        validationProblems = task.validate(resolvedFields) ?? [];
      } catch (error) {
        validationProblems = [`validation function failed: ${error instanceof Error ? error.message : String(error)}`];
        await this.logger?.error('task validation threw', { scope: 'engine', task: taskId, error: validationProblems[0] });
      }
    }

    const resultSection = section(task.module, task.title, resolvedFields);
    const durationMs = Date.now() - started;
    await this.logger?.debug('task complete', {
      scope: 'engine',
      task: taskId,
      status: resultSection.status,
      durationMs,
      attempts: attempts.length,
      conflicts: conflicts.length
    });

    return {
      taskId,
      module: task.module,
      section: resultSection,
      attempts,
      conflicts,
      validationProblems,
      durationMs
    };
  }

  /**
   * Run many tasks. Tasks are isolated: one failure cannot abort the rest.
   * @param {string[]} taskIds
   * @param {{signal?: AbortSignal, onProgress?: (progress:{done:number,total:number,taskId:string,section:import('../core/field.js').Section}) => void}} [options]
   * @returns {Promise<{results:TaskResult[], byModule:Record<string,import('../core/field.js').Section>, durationMs:number, cancelled:boolean}>}
   */
  async runTasks(taskIds, options = {}) {
    const started = Date.now();
    /** @type {TaskResult[]} */
    const results = [];
    /** @type {Record<string, Section>} */
    const byModule = {};
    let cancelled = false;

    for (const [index, taskId] of taskIds.entries()) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        const result = await this.runTask(taskId, options);
        results.push(result);
        byModule[result.module] = result.section;
        options.onProgress?.({ done: index + 1, total: taskIds.length, taskId, section: result.section });
      } catch (error) {
        // Defensive: the runner itself should not throw, but if a task definition
        // is broken we must still finish the sweep.
        const message = error instanceof Error ? error.message : String(error);
        await this.logger?.error('task crashed', { scope: 'engine', task: taskId, error: message });
        results.push({
          taskId,
          module: taskId.split('.')[0],
          section: section(taskId, taskId, { failure: failed(message, null) }),
          attempts: [],
          conflicts: [],
          validationProblems: [message],
          durationMs: 0
        });
      }
    }

    return { results, byModule, durationMs: Date.now() - started, cancelled };
  }

  #runnerFor(provider) {
    return provider.runner ?? this.runner;
  }

  /**
   * Bound a provider's execution time without leaking an unresolved promise.
   * @template T
   * @param {Promise<T>} promise
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<T>}
   */
  #withTimeout(promise, timeoutMs, label) {
    /** @type {NodeJS.Timeout} */
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Provider "${label}" exceeded its ${timeoutMs}ms budget`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
