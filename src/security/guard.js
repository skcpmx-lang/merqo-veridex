/**
 * VERIDEX — Outbound guard and read-only enforcement.
 *
 * Two guarantees are advertised on the privacy screen, and both are enforced here
 * in code rather than trusted to good intentions:
 *
 *   1. **Nothing leaves the machine.** The guard wraps `http`/`https` request
 *      creation. Unless the user has explicitly enabled network access, every
 *      outbound request is refused before a socket is opened, and the refusal is
 *      logged. Even when enabled, requests to a non-allowlisted host are refused,
 *      because the setting exists to allow a future opt-in *lookup*, not to permit
 *      arbitrary egress of diagnostics.
 *
 *   2. **Diagnostics are read-only.** Every command the app executes passes through
 *      `CommandRunner`. The guard classifies the command line and refuses
 *      destructive verbs outright; anything that legitimately needs consent is
 *      returned as `needsConsent` so the caller must ask first.
 *
 * The guard is deliberately paranoid and deliberately *loud*: a refusal is
 * recorded and surfaced, never swallowed.
 *
 * ## Scope and honesty about that scope
 *
 * `install()` patches four entry points: `http.request`, `https.request`,
 * `http.get`/`https.get` on the module objects, and `globalThis.fetch`. It stops
 * application code and dependencies that go through those paths.
 *
 * It is **not** a kernel-level sandbox, and this file will not pretend otherwise:
 * an ES module that captured a named binding (`import { request } from 'node:http'`)
 * *before* the guard was installed holds its own reference and is not redirected,
 * because ESM namespace objects are snapshots. Any code path that can run a raw
 * socket (`node:net`, `node:tls`) is likewise out of reach.
 *
 * The guarantee that actually holds is stronger and simpler: **VERIDEX's own source
 * contains no network client at all.** That is verified mechanically by
 * `scripts/verify-artifacts.mjs` and by `tests/integration/no-network.test.js`,
 * which scan the whole source tree for transport imports and calls. The runtime
 * guard exists to catch what a *dependency* might attempt, and to make any attempt
 * loud rather than silent. Both layers are documented in docs/SECURITY.md.
 */

import http from 'node:http';
import https from 'node:https';
import { Status } from '../core/status.js';
import { field } from '../core/field.js';

/**
 * Command patterns that must never run, whatever the user clicks. These are not
 * "ask first" operations; they are operations VERIDEX does not perform.
 * Each entry: id, regex over the normalised command line, and the reason.
 */
export const FORBIDDEN_COMMANDS = Object.freeze([
  { id: 'format-volume', pattern: /\bformat(\.com)?\b[\s\S]*\b[a-z]:/i, reason: 'Formatting a volume destroys data.' },
  { id: 'diskpart-clean', pattern: /\bdiskpart\b[\s\S]*\bclean\b|\bclean\s+all\b/i, reason: 'Diskpart clean wipes partition tables.' },
  { id: 'mkfs', pattern: /\bmkfs(\.|\s)|\bmke2fs\b/i, reason: 'Creating a filesystem destroys existing data.' },
  { id: 'chkdsk-repair', pattern: /\bchkdsk\b[\s\S]*\s\/f\b|\bchkdsk\b[\s\S]*\s\/r\b/i, reason: 'A repairing chkdsk pass modifies the filesystem. VERIDEX runs read-only checks (/scan) only.' },
  { id: 'sfc-repair', pattern: /\bsfc\b[\s\S]*\/(scannow|scanfile|verifyfile)\b/i, reason: 'A repairing SFC pass modifies system files. VERIDEX runs /VERIFYONLY only.' },
  { id: 'dism-repair', pattern: /\bdism\b[\s\S]*\/(restorehealth|cleanup-image\s*\/startcomponentcleanup)\b/i, reason: 'A repairing DISM pass modifies the component store. VERIDEX runs /CheckHealth and /ScanHealth only.' },
  { id: 'bcd-edit', pattern: /\bbcdedit\b[\s\S]*\/(set|delete|create|import|export)\b/i, reason: 'Boot configuration edits can leave the machine unbootable.' },
  { id: 'registry-write', pattern: /\breg(\.exe)?\b[\s\S]*\b(add|delete|copy|restore|import)\b/i, reason: 'VERIDEX reads the registry; it never writes, deletes or imports into it.' },
  { id: 'driver-remove', pattern: /\bpnputil\b[\s\S]*\/(delete-driver|remove-device)\b/i, reason: 'Removing drivers can disable hardware. VERIDEX may export drivers, never remove them.' },
  { id: 'defender-disable', pattern: /\bSet-MpPreference\b[\s\S]*-Disable|\bsc\b[\s\S]*\bdelete\b[\s\S]*\bWinDefend\b|\bnet\s+stop\b[\s\S]*\bwinDefend\b/i, reason: 'Disabling security protection is never part of a diagnostic.' },
  { id: 'firewall-disable', pattern: /\bnetsh\b[\s\S]*\badvfirewall\b[\s\S]*\bset\b[\s\S]*\bstate\s+off\b|\bSet-NetFirewallProfile\b[\s\S]*-Enabled\s+False/i, reason: 'Disabling the firewall is never part of a diagnostic.' },
  { id: 'uac-disable', pattern: /\bEnableLUA\b|\bConsentPromptBehaviorAdmin\b/i, reason: 'Changing UAC policy is never part of a diagnostic.' },
  { id: 'bitlocker-off', pattern: /\bmanage-bde\b[\s\S]*\boff\b|\bDisable-BitLocker\b/i, reason: 'Disabling encryption exposes user data.' },
  { id: 'firmware-flash', pattern: /\bflashrom\b|\bafuwin\b|\bwinsat\b.*\breset\b|\bWin32_BIOS.*\bflash\b/i, reason: 'Firmware writes are out of scope and can brick a machine.' },
  { id: 'shutdown', pattern: /\bshutdown\b[\s\S]*\/s\b/i, reason: 'VERIDEX never shuts down the machine it is inspecting.' },
  { id: 'restore-point', pattern: /\brstrui\b|\bcheckpoint-computer\b/i, reason: 'System restore is a modifying operation and is out of scope.' },
  { id: 'delete-recursive', pattern: /\b(rm|del|erase|rd|rmdir)\b[\s\S]*\s(\/s|-rf|-r|--recursive)\b/i, reason: 'Recursive deletion is out of scope.' },
  { id: 'power-plan-write', pattern: /\bpowercfg\b[\s\S]*(\/change|\/setactive|\/hibernate)\b/i, reason: 'VERIDEX reads power configuration (/query) and does not change it.' },
  { id: 'winsat-modify', pattern: /\bwinsat\b[\s\S]*\b(disk|mem|cpu)\b[\s\S]*\b-(read|write)\b.*\bflush\b/i, reason: 'Winsat assessment writes to the disk and is not part of a read-only diagnostic.' },
  { id: 'netsh-reset', pattern: /\bnetsh\b[\s\S]*\b(winsock|int\s+ip)\b[\s\S]*\breset\b/i, reason: 'Network stack resets disconnect the machine and are out of scope.' }
]);

/**
 * Operations that are legitimate but must be preceded by an explicit warning and
 * consent. `needsConsent` results are returned, never executed silently.
 */
export const CONSENT_REQUIRED = Object.freeze([
  { id: 'disk-write-benchmark', pattern: /\bdisk-bench\b|\bwrites?\b.*\bbench/i, reason: 'The write half of the disk benchmark creates and deletes a temporary file on the target volume.' },
  { id: 'driver-export', pattern: /\bpnputil\b[\s\S]*\/export-driver\b/i, reason: 'Exporting drivers writes copies of installed drivers to a folder you choose.' },
  { id: 'event-log-export', pattern: /\bwevtutil\b[\s\S]*\bepl\b/i, reason: 'Exporting an event log writes a file containing system history.' },
  { id: 'trace-capture', pattern: /\bwpr\b|\btracelog\b/i, reason: 'ETW trace capture writes a trace file and adds measurable system load.' }
]);

/** Hosts that a future opt-in lookup may contact. Nothing else is reachable. */
export const NETWORK_ALLOWLIST = Object.freeze(['merqo.local']);

/** @param {string} command @param {string[]} args */
export function commandLine(command, args = []) {
  const parts = [command, ...args].filter((part) => part !== undefined && part !== null && part !== '');
  return parts.map((part) => String(part)).join(' ');
}

/**
 * Classify a command before it runs.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @returns {{verdict:'allow'|'forbid'|'needs-consent', id:string|null, reason:string|null, matched:string|null}}
 */
export function classifyCommand(command, args = []) {
  const line = commandLine(command, args);
  for (const rule of FORBIDDEN_COMMANDS) {
    if (rule.pattern.test(line)) {
      return { verdict: 'forbid', id: rule.id, reason: rule.reason, matched: line };
    }
  }
  for (const rule of CONSENT_REQUIRED) {
    if (rule.pattern.test(line)) {
      return { verdict: 'needs-consent', id: rule.id, reason: rule.reason, matched: line };
    }
  }
  return { verdict: 'allow', id: null, reason: null, matched: null };
}

/**
 * Guard state. Holds the policy, a refusal log, and the recorded consent tokens so
 * a consent-gated operation cannot run without one.
 */
export class SecurityGuard {
  /**
   * @param {{policy?: {allowNetwork?: boolean, includeSensitive?: boolean}, logger?: import('../core/logger.js').Logger|null, networkAllowlist?: string[]}} [options]
   */
  constructor(options = {}) {
    this.policy = options.policy ?? {};
    this.logger = options.logger ?? null;
    this.networkAllowlist = options.networkAllowlist ?? [...NETWORK_ALLOWLIST];
    /** @type {Array<{id:string, kind:'command'|'network', command:string|null, host:string|null, reason:string, at:string, task:string|null}>} */
    this.refusals = [];
    /** @type {Set<string>} */
    this.consents = new Set();
    this.installed = false;
    /** @type {{httpRequest:Function, httpsRequest:Function, httpGet:Function, httpsGet:Function, fetch?:Function}|null} */
    this.#originals = null;
  }

  /** @type {{httpRequest:Function, httpsRequest:Function, httpGet:Function, httpsGet:Function, fetch?:Function}|null} */
  #originals = null;

  /** Update the live policy (called when settings change). */
  setPolicy(policy) {
    this.policy = { ...this.policy, ...policy };
    return this;
  }

  get networkAllowed() {
    return this.policy.allowNetwork === true;
  }

  /** @param {string} id */
  grantConsent(id) {
    this.consents.add(id);
    return this;
  }

  /** @param {string} id */
  hasConsent(id) {
    return this.consents.has(id);
  }

  /** @param {string} id */
  revokeConsent(id) {
    this.consents.delete(id);
    return this;
  }

  clearConsents() {
    this.consents.clear();
    return this;
  }

  /**
   * Gate a command before handing it to the runner.
   * @param {string} command
   * @param {string[]} [args]
   * @param {{task?:string}} [context]
   * @returns {{allowed:boolean, verdict:'allow'|'forbid'|'needs-consent', id:string|null, reason:string|null}}
   */
  checkCommand(command, args = [], context = {}) {
    const verdict = classifyCommand(command, args);
    if (verdict.verdict === 'forbid') {
      this.#refuse({ id: verdict.id ?? 'forbidden', kind: 'command', command: verdict.matched, host: null, reason: verdict.reason ?? 'Forbidden operation', task: context.task ?? null });
      return { allowed: false, verdict: 'forbid', id: verdict.id, reason: verdict.reason };
    }
    if (verdict.verdict === 'needs-consent') {
      const granted = this.hasConsent(verdict.id ?? '');
      if (!granted) {
        this.#refuse({ id: verdict.id ?? 'consent', kind: 'command', command: verdict.matched, host: null, reason: `${verdict.reason ?? 'Requires consent'} (no consent recorded)`, task: context.task ?? null });
      }
      return { allowed: granted, verdict: 'needs-consent', id: verdict.id, reason: verdict.reason };
    }
    return { allowed: true, verdict: 'allow', id: null, reason: null };
  }

  /**
   * Gate a URL. Refuses everything when network access is off, and anything
   * outside the allowlist when it is on.
   * @param {string} url
   * @param {{task?:string}} [context]
   */
  checkUrl(url, context = {}) {
    let host = '';
    try {
      host = new URL(String(url)).hostname.toLowerCase();
    } catch {
      this.#refuse({ id: 'invalid-url', kind: 'network', command: null, host: String(url), reason: 'Unparseable URL', task: context.task ?? null });
      return { allowed: false, id: 'invalid-url', reason: 'Unparseable URL', host: String(url) };
    }

    if (!this.networkAllowed) {
      const reason = 'Network access is disabled in Privacy settings. VERIDEX does not transmit diagnostic data.';
      this.#refuse({ id: 'network-disabled', kind: 'network', command: null, host, reason, task: context.task ?? null });
      return { allowed: false, id: 'network-disabled', reason, host };
    }

    const allowed = this.networkAllowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) {
      const reason = `Host "${host}" is not in the allowlist. Network access may only reach ${this.networkAllowlist.join(', ')}.`;
      this.#refuse({ id: 'host-not-allowlisted', kind: 'network', command: null, host, reason, task: context.task ?? null });
      return { allowed: false, id: 'host-not-allowlisted', reason, host };
    }

    return { allowed: true, id: null, reason: null, host };
  }

  /**
   * Install the outbound guard on the http/https modules.
   *
   * This is a process-wide patch, which is exactly why it is explicit rather than
   * automatic: a test or a future host integration chooses to install it, and
   * `uninstall()` restores the originals. The patch refuses by throwing an Error
   * whose message names the policy, so a caller that ignores refusals cannot
   * mistake it for a network failure.
   */
  install() {
    if (this.installed) return this;
    const originals = {
      httpRequest: http.request,
      httpsRequest: https.request,
      httpGet: http.get,
      httpsGet: https.get,
      fetch: globalThis.fetch
    };
    this.#originals = originals;

    /** @param {'http'|'https'} scheme */
    const wrap = (scheme, original, method) => {
      /** @this {unknown} */
      return function guarded(...params) {
        const url = extractUrl(params, scheme);
        return guardRefuseOrRun(guard, url, original, params, `network.${method}`);
      };
    };

    const guard = this;
    http.request = wrap('http', originals.httpRequest, 'request');
    https.request = wrap('https', originals.httpsRequest, 'request');
    http.get = wrap('http', originals.httpGet, 'get');
    https.get = wrap('https', originals.httpsGet, 'get');

    // fetch is the path modern code actually uses, so it gets the same treatment.
    if (typeof originals.fetch === 'function') {
      globalThis.fetch = function guardedFetch(input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url ?? input);
        const verdict = guard.checkUrl(url, { task: 'network.fetch' });
        if (!verdict.allowed) {
          const error = /** @type {Error & {code?:string, veridexBlocked?:boolean}} */ (
            new Error(`VERIDEX blocked outbound request to ${verdict.host}: ${verdict.reason}`)
          );
          error.code = 'EVERIDEX_NETWORK_BLOCKED';
          error.veridexBlocked = true;
          return Promise.reject(error);
        }
        return originals.fetch.call(globalThis, input, init);
      };
    }

    this.installed = true;
    void this.logger?.info('outbound guard installed', { scope: 'security', allowNetwork: this.networkAllowed });
    return this;
  }

  /** Restore the original http/https functions. */
  uninstall() {
    if (!this.installed || !this.#originals) return this;
    http.request = this.#originals.httpRequest;
    https.request = this.#originals.httpsRequest;
    http.get = this.#originals.httpGet;
    https.get = this.#originals.httpsGet;
    if (typeof this.#originals.fetch === 'function') globalThis.fetch = this.#originals.fetch;
    this.installed = false;
    return this;
  }

  /** Refusals, newest last. */
  log() {
    return [...this.refusals];
  }

  /** Human summary for the privacy screen and the report's issues block. */
  summary() {
    const network = this.refusals.filter((entry) => entry.kind === 'network');
    const commands = this.refusals.filter((entry) => entry.kind === 'command');
    return {
      networkAttemptsBlocked: network.length,
      unsafeCommandsBlocked: commands.length,
      networkAccessEnabled: this.networkAllowed,
      statement:
        network.length === 0 && commands.length === 0
          ? 'No blocked network attempts and no unsafe commands were requested during this session.'
          : `${network.length} network attempt(s) and ${commands.length} unsafe command(s) were blocked. Each refusal is recorded below.`,
      entries: this.log()
    };
  }

  /** @param {{id:string, kind:'command'|'network', command:string|null, host:string|null, reason:string, task:string|null}} entry */
  #refuse(entry) {
    const record = { ...entry, at: new Date().toISOString() };
    this.refusals.push(record);
    // Keep the in-memory log bounded; the structured log keeps the full history.
    if (this.refusals.length > 500) this.refusals.shift();
    void this.logger?.warn(entry.kind === 'network' ? 'outbound request blocked' : 'unsafe command blocked', {
      scope: 'security',
      id: entry.id,
      host: entry.host ?? undefined,
      command: entry.command ?? undefined,
      reason: entry.reason,
      task: entry.task ?? undefined
    });
    return record;
  }
}

/**
 * Extract a URL from the several call signatures Node accepts:
 * `request(url)`, `request(url, options)`, `request(options)`, `request(options, cb)`.
 * @param {unknown[]} params
 * @param {'http'|'https'} scheme
 */
function extractUrl(params, scheme) {
  const [first] = params;
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.toString();
  if (first && typeof first === 'object') {
    const options = /** @type {{hostname?:string, host?:string, port?:number|string, path?:string, protocol?:string}} */ (first);
    const host = options.hostname ?? options.host ?? '';
    const port = options.port ? `:${options.port}` : '';
    const path = options.path ?? '/';
    const protocol = options.protocol ?? `${scheme}:`;
    return `${protocol}//${host}${port}${path}`;
  }
  return `${scheme}://unknown`;
}

/**
 * @param {SecurityGuard} guard
 * @param {string} url
 * @param {Function} original
 * @param {unknown[]} params
 * @param {string} label
 */
function guardRefuseOrRun(guard, url, original, params, label) {
  const verdict = guard.checkUrl(url, { task: label });
  if (!verdict.allowed) {
    const error = /** @type {Error & {code?:string, veridexBlocked?:boolean}} */ (
      new Error(`VERIDEX blocked outbound request to ${verdict.host}: ${verdict.reason}`)
    );
    error.code = 'EVERIDEX_NETWORK_BLOCKED';
    error.veridexBlocked = true;
    throw error;
  }
  return original.apply(null, params);
}

/**
 * Build a guard from a settings store.
 *
 * `privacy.allowNetwork` is the only setting that can open the network path, and it
 * is off by default. Keeping the read here means the guard's behaviour is traceable
 * to a setting the user can see and change, rather than to a bit passed in from
 * somewhere invisible.
 *
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 * @param {{logger?: import('../core/logger.js').Logger|null}} [options]
 */
export function guardFromSettings(settings, options = {}) {
  const read = (key, fallback) => {
    try {
      if (settings && typeof (/** @type {any} */ (settings).get) === 'function') {
        const value = /** @type {any} */ (settings).get(key);
        return value === undefined ? fallback : value;
      }
      const value = /** @type {Record<string, unknown>} */ (settings ?? {})[key];
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  };

  return new SecurityGuard({
    policy: { allowNetwork: read('privacy.allowNetwork', false) === true },
    logger: options.logger ?? null
  });
}

/** Convenience: the guard used when a caller does not supply one. */
export const defaultGuard = new SecurityGuard();

/**
 * The read-only policy stated as data, so the About/Privacy screen and the report
 * can quote the same list the code enforces.
 */
export function readOnlyPolicy() {
  return {
    forbidden: FORBIDDEN_COMMANDS.map(({ id, reason }) => ({ id, reason })),
    consentRequired: CONSENT_REQUIRED.map(({ id, reason }) => ({ id, reason })),
    statement:
      'VERIDEX performs read-only diagnostics. Operations that modify a system are refused by the command guard; the few legitimate operations that write files require explicit consent.'
  };
}

/**
 * Turn guard refusals into report-ready fields so a refusal is visible in the
 * export rather than only in a log file.
 * @param {ReturnType<SecurityGuard['summary']>} summary
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function guardFields(summary) {
  const blocked = summary.networkAttemptsBlocked > 0 || summary.unsafeCommandsBlocked > 0;
  const status = blocked ? Status.WARNING : Status.PASS;
  return {
    networkAccessEnabled: field(summary.networkAccessEnabled ? 'Enabled' : 'Disabled', { status: Status.PASS, source: 'security-guard' }),
    networkAttemptsBlocked: field(summary.networkAttemptsBlocked, { status, source: 'security-guard' }),
    unsafeCommandsBlocked: field(summary.unsafeCommandsBlocked, { status, source: 'security-guard' }),
    statement: field(summary.statement, { status, source: 'security-guard' })
  };
}
