/**
 * VERIDEX — running an elevated task (MODULE 14, R-14-02).
 *
 * `elevate.js` decides *whether* a privileged task may run and builds the PowerShell that raises
 * the UAC prompt. This module runs it, and is where the awkward parts live:
 *
 *   - the child may be cancelled, in which case it is killed and the kill is reported;
 *   - the child may hang, in which case the timeout kills it;
 *   - the child may write a result file, no file, a truncated file, or a file full of noise;
 *   - the helper's own exit code is distinct from the elevated tool's exit code.
 *
 * The parent never trusts the child's silence: a zero exit with no readable result is a failure,
 * because the point of the helper is to produce evidence.
 *
 * Everything here takes its spawn function and its file readers by injection, so the whole
 * lifecycle can be tested on a machine with no Windows and no UAC.
 *
 * @module
 */

import { interpretElevationOutcome, buildElevationScript, isElevatedTask } from './elevate.js';

/** A result file larger than this is not a result, it is a symptom. */
export const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * Run one allowlisted privileged task.
 *
 * @param {{
 *   taskId: string,
 *   params?: Record<string, unknown>,
 *   appPath: string,
 *   resultPath: string,
 *   spawn: (file: string, args: string[], options?: object) => any,
 *   readFile?: (path: string) => Promise<string>,
 *   unlink?: (path: string) => Promise<void>,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   powershellPath?: string
 * }} options
 * @returns {Promise<{ok: boolean, cancelled: boolean, reason: string, result?: any, exitCode: number|null}>}
 */
export async function runElevatedTask(options) {
  const {
    taskId,
    params = {},
    appPath,
    resultPath,
    spawn,
    readFile,
    unlink,
    signal,
    powershellPath = 'powershell.exe'
  } = options ?? {};

  if (!isElevatedTask(taskId)) {
    return { ok: false, cancelled: false, reason: `"${taskId}" is not a privileged task.`, exitCode: null };
  }
  if (typeof spawn !== 'function') {
    return { ok: false, cancelled: false, reason: 'No process runner is available for the privileged task.', exitCode: null };
  }

  const built = buildElevationScript({ taskId, appPath, params, resultPath });
  if (!built.ok) {
    return { ok: false, cancelled: false, reason: built.reason, exitCode: null };
  }

  const timeoutMs = options.timeoutMs ?? 120_000;

  // The result file is removed first. A stale file from an earlier attempt being read as this
  // attempt's result is exactly the kind of bug that only shows up in a user's second try.
  if (typeof unlink === 'function') {
    await unlink(resultPath).catch(() => {});
  }

  const outcome = await runChild({
    spawn,
    file: powershellPath,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', built.script],
    timeoutMs,
    signal
  });

  let result = null;
  let resultProblem = null;
  if (typeof readFile === 'function') {
    try {
      const text = await readFile(resultPath);
      if (text.length > MAX_RESULT_BYTES) {
        resultProblem = 'The privileged helper wrote an implausibly large result, so it was discarded.';
      } else if (text.trim().length === 0) {
        resultProblem = 'The privileged helper wrote an empty result file.';
      } else {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        result = parsed && typeof parsed === 'object' ? parsed : null;
        if (!result) resultProblem = 'The privileged helper wrote a result that is not an object.';
      }
    } catch (error) {
      // A missing file is expected when the prompt was declined; anything else is reported.
      if (outcome.cancelled !== true) {
        resultProblem = `The privileged helper's result could not be read (${error instanceof Error ? error.message : String(error)}).`;
      }
    }
  }

  if (outcome.cancelled) {
    return {
      ok: false,
      cancelled: true,
      exitCode: outcome.code,
      reason: 'Administrator permission was declined, so nothing was done. VERIDEX continues at standard privilege.'
    };
  }

  if (outcome.timedOut) {
    return {
      ok: false,
      cancelled: false,
      exitCode: outcome.code,
      reason: 'The privileged task did not finish within its time limit and was stopped. Nothing was left running.'
    };
  }

  const interpreted = interpretElevationOutcome({
    code: outcome.code,
    result,
    stderr: outcome.stderr
  });

  // A declined prompt leaves no result file, by design. That is the expected absence, so it must
  // be classified as a decline before the missing-file explanation is considered.
  if (interpreted.cancelled) return { ...interpreted, exitCode: outcome.code };

  if (!interpreted.ok && resultProblem) {
    return { ok: false, cancelled: false, exitCode: outcome.code, reason: resultProblem };
  }
  return { ...interpreted, exitCode: outcome.code };
}

/**
 * Spawn a child, wait for it, and make cancellation and timeouts actually stop it.
 *
 * @param {{spawn: Function, file: string, args: string[], timeoutMs: number, signal?: AbortSignal}} options
 * @returns {Promise<{code: number|null, cancelled: boolean, timedOut: boolean, stdout: string, stderr: string}>}
 */
function runChild({ spawn, file, args, timeoutMs, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, cancelled: true, timedOut: false, stdout: '', stderr: '' });
      return;
    }

    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let killedFor = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: typeof code === 'number' ? code : null,
        cancelled: killedFor === 'abort',
        timedOut: killedFor === 'timeout',
        stdout,
        stderr
      });
    };

    const timer = setTimeout(() => {
      killedFor = 'timeout';
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A killed child does not always emit close; do not wait for it forever.
      finish(null);
    }, timeoutMs);
    // Deliberately NOT unref'd. An unref'd timer does not keep the event loop alive, so a helper
    // that hangs with nothing else pending would let the process exit before the timeout fires —
    // a limit that can be skipped is not a limit.

    function onAbort() {
      killedFor = 'abort';
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }

    try {
      child = spawn(file, args, { windowsHide: true });
    } catch (error) {
      clearTimeout(timer);
      settled = true;
      resolve({ code: null, cancelled: false, timedOut: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      finish(-1);
    });
    // A process that is not ours may have gone away between spawn and the listener attaching.
    if (typeof child.once === 'function') child.once('close', (code) => finish(code));
    else child.on('close', (code) => finish(code));

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
