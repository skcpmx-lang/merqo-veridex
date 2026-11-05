/**
 * VERIDEX — Process execution boundary.
 *
 * All interaction with the operating system that leaves this process (PowerShell,
 * CIM, ipconfig, powercfg, manage-bde, pnputil) funnels through a CommandRunner.
 * Two consequences matter:
 *
 *  1. Every provider is unit-testable without Windows, because a test can inject
 *     a runner that returns captured real-world output.
 *  2. Timeouts, encoding and stderr handling are solved once instead of in each
 *     of the dozens of providers.
 *
 * The runner never mutates system state by itself; it executes exactly what a
 * provider asks for, and the call sites are audited against the operation guard
 * in src/security/guard.js.
 */

import { spawn } from 'node:child_process';

/** @typedef {object} RunOptions
 * @property {number} [timeoutMs]
 * @property {Record<string,string>} [env]
 * @property {string} [cwd]
 */

/** @typedef {object} RunResult
 * @property {boolean} ok        exit code === 0 and not killed
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {number} durationMs
 * @property {string} command    Human-readable command line, for logs.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export class CommandRunner {
  /**
   * @param {{platform?: NodeJS.Platform, spawnFn?: typeof spawn, defaultTimeoutMs?: number}} [options]
   */
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawnFn ?? spawn;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Run an executable and capture output as a Buffer decoded as UTF-8.
   * Never rejects: a failure is a normal, reportable outcome.
   * @param {string} file
   * @param {string[]} args
   * @param {RunOptions} [options]
   * @returns {Promise<RunResult>}
   */
  async run(file, args = [], options = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const started = Date.now();
    const commandLine = [file, ...args].join(' ');

    return new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
      let child;
      let settled = false;
      let timedOut = false;
      let stdout = '';
      let stderr = '';

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
          command: commandLine
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* process may already be gone */
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        child = this.spawnFn(file, args, {
          windowsHide: true,
          env: { ...process.env, ...(options.env ?? {}) },
          cwd: options.cwd
        });
      } catch (error) {
        clearTimeout(timer);
        settled = true;
        resolve({
          ok: false,
          code: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
          durationMs: Date.now() - started,
          command: commandLine
        });
        return;
      }

      child.stdout?.on('data', (chunk) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      });
      child.on('error', (error) => {
        stderr += (stderr ? '\n' : '') + error.message;
        finish(-1);
      });
      child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
    });
  }

  /**
   * Run PowerShell and return already-parsed JSON.
   *
   * The script is wrapped so that:
   *  - output encoding is forced to UTF-8 (avoids mojibake in serial numbers and
   *    non-ASCII device names);
   *  - errors are non-terminating unless the provider asks otherwise, so one bad
   *    class does not lose the whole payload;
   *  - the result is always emitted as JSON, including an explicit wrapper so an
   *    empty result is distinguishable from a crash.
   *
   * @param {string} body PowerShell body; its last expression is the payload.
   * @param {{timeoutMs?: number, name?: string, single?: boolean}} [options]
   * @returns {Promise<{ok:boolean, data:unknown, error:string|null, durationMs:number, raw:string}>}
   */
  async powershellJson(body, options = {}) {
    const wrapped = [
      '$ErrorActionPreference = "Continue"',
      '$ProgressPreference = "SilentlyContinue"',
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
      '$ProgressPreference = "SilentlyContinue"',
      '$VERIDEX = $null',
      'try {',
      `  $VERIDEX = @(${body})`,
      '  $VERIDEX_OK = $true',
      '  $VERIDEX_ERR = $null',
      '} catch {',
      '  $VERIDEX_OK = $false',
      '  $VERIDEX_ERR = $_.Exception.Message',
      '}',
      '[pscustomobject]@{ ok = $VERIDEX_OK; error = $VERIDEX_ERR; data = $VERIDEX } | ConvertTo-Json -Depth 6 -Compress'
    ].join('\n');

    const result = await this.run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { timeoutMs: options.timeoutMs }
    );

    const label = options.name ?? 'powershell';
    if (!result.ok) {
      return {
        ok: false,
        data: null,
        error: result.timedOut
          ? `${label}: timed out after ${result.durationMs}ms`
          : `${label}: exit ${result.code}${result.stderr ? ` — ${result.stderr.trim().slice(0, 500)}` : ''}`,
        durationMs: result.durationMs,
        raw: result.stdout
      };
    }

    const text = result.stdout.trim();
    if (!text) {
      return { ok: true, data: [], error: null, durationMs: result.durationMs, raw: '' };
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'ok' in parsed && 'data' in parsed) {
        if (parsed.ok === false) {
          return { ok: false, data: null, error: `${label}: ${parsed.error ?? 'unknown error'}`, durationMs: result.durationMs, raw: text };
        }
        // PowerShell collapses a single-element array to an object in JSON.
        const data = Array.isArray(parsed.data) ? parsed.data : parsed.data === null ? [] : [parsed.data];
        return { ok: true, data, error: null, durationMs: result.durationMs, raw: text };
      }
      return { ok: true, data: Array.isArray(parsed) ? parsed : [parsed], error: null, durationMs: result.durationMs, raw: text };
    } catch (error) {
      return {
        ok: false,
        data: null,
        error: `${label}: unparseable output (${error instanceof Error ? error.message : String(error)})`,
        durationMs: result.durationMs,
        raw: text
      };
    }
  }

  /** True when the current platform can execute the PowerShell-backed providers. */
  get isWindows() {
    return this.platform === 'win32';
  }
}

/**
 * A runner used when a caller has no OS access, e.g. pure previews. It reports
 * every command as an explicit platform failure rather than inventing data.
 */
export class NoopRunner extends CommandRunner {
  async run(file, args = []) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `Command execution unavailable on platform "${this.platform}": ${file}`,
      timedOut: false,
      durationMs: 0,
      command: [file, ...args].join(' ')
    };
  }
}

export const defaultRunner = new CommandRunner();
