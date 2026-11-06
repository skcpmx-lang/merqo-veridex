/**
 * Running an elevated task.
 *
 * The interesting cases are all failures: the user declines, the helper hangs, the helper writes
 * nothing, the helper writes garbage, the user cancels mid-run. Each has to end up as a distinct,
 * explainable outcome — and none of them may be reported as success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runElevatedTask, MAX_RESULT_BYTES } from '../../src/app/elevated-runner.js';

const APP = 'C:\\Program Files\\VERIDEX\\VERIDEX.exe';
const RESULT = 'C:\\Temp\\veridex-elevated.json';

/** A fake child process the test drives. */
function fakeSpawn(behaviour = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      // Killing a real child produces a close event.
      setTimeout(() => child.emit('close', null), 0);
    };
    if (behaviour.hang) {
      // Never closes on its own.
    } else {
      setTimeout(() => {
        if (behaviour.stderr) child.stderr.emit('data', behaviour.stderr);
        child.emit('close', behaviour.code ?? 0);
      }, behaviour.delayMs ?? 0);
    }
    return child;
  };
  return { spawn, calls };
}

const readFrom = (text) => async () => text;

test('a successful task returns the helper\'s own result', async () => {
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const outcome = await runElevatedTask({
    taskId: 'windows.componentHealth',
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: readFrom(JSON.stringify({ storeHealth: 'HEALTHY' })),
    timeoutMs: 1000
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { storeHealth: 'HEALTHY' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /powershell/i);
  assert.ok(calls[0].args.includes('-NonInteractive'), 'the helper must not prompt for input');
  assert.ok(calls[0].args.join(' ').includes('-Verb RunAs'));
});

test('a declined UAC prompt is cancelled, not failed', async () => {
  const { spawn } = fakeSpawn({ code: 1223 });
  const outcome = await runElevatedTask({
    taskId: 'drivers.export',
    params: { destination: 'D:\\Backup' },
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    timeoutMs: 1000
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, true);
  assert.match(outcome.reason, /declined/i);
});

test('a child that never finishes is killed at the timeout', async () => {
  const { spawn } = fakeSpawn({ hang: true });
  const started = Date.now();
  const outcome = await runElevatedTask({
    taskId: 'windows.componentHealth',
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: async () => '{}',
    timeoutMs: 40
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /time limit/i);
  assert.ok(Date.now() - started < 2000, 'the timeout must actually fire');
});

test('cancellation kills the child and says so', async () => {
  const { spawn } = fakeSpawn({ hang: true });
  const controller = new AbortController();
  const promise = runElevatedTask({
    taskId: 'drivers.export',
    params: { destination: 'D:\\Backup' },
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: async () => '{}',
    timeoutMs: 5000,
    signal: controller.signal
  });
  controller.abort();
  const outcome = await promise;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, true);
  assert.match(outcome.reason, /declined|stopped|cancel/i);
});

test('a zero exit with no result is a failure, not an empty success', async () => {
  for (const [label, reader] of [
    ['missing file', async () => { throw new Error('ENOENT'); }],
    ['empty file', async () => '   '],
    ['broken json', async () => '{"unterminated": '],
    ['not an object', async () => '42'],
    ['oversized', async () => 'x'.repeat(MAX_RESULT_BYTES + 10)]
  ]) {
    const { spawn } = fakeSpawn({ code: 0 });
    const outcome = await runElevatedTask({
      taskId: 'drivers.export',
      params: { destination: 'D:\\Backup' },
      appPath: APP,
      resultPath: RESULT,
      spawn,
      readFile: reader,
      timeoutMs: 1000
    });
    assert.equal(outcome.ok, false, `${label} must not be a success`);
    assert.ok(outcome.reason.length > 10, `${label} must explain itself`);
  }
});

test('an unknown task never reaches a process', async () => {
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const outcome = await runElevatedTask({
    taskId: 'shell.exec',
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: readFrom('{}'),
    timeoutMs: 1000
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0, 'no process may be spawned for an unknown task');
});

test('a stale result file from an earlier attempt is removed before the run', async () => {
  const removed = [];
  const { spawn } = fakeSpawn({ code: 1223 });
  await runElevatedTask({
    taskId: 'drivers.export',
    params: { destination: 'D:\\Backup' },
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    unlink: async (path) => {
      removed.push(path);
    },
    timeoutMs: 1000
  });
  assert.deepEqual(removed, [RESULT]);
});

test('a non-zero exit carries the helper\'s message', async () => {
  const { spawn } = fakeSpawn({ code: 1 });
  const outcome = await runElevatedTask({
    taskId: 'drivers.export',
    params: { destination: 'D:\\Backup' },
    appPath: APP,
    resultPath: RESULT,
    spawn,
    readFile: readFrom(JSON.stringify({ code: 1, message: 'The parameter is incorrect.' })),
    timeoutMs: 1000
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /incorrect|code 1/i);
});
