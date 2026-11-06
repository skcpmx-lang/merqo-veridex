/**
 * VERIDEX — Process snapshot (MODULE 12, R-12-03).
 *
 * One snapshot, taken when the user runs a scan, and nothing else. There is deliberately no
 * background polling here: a diagnostic tool that quietly samples every process on a machine
 * forever is exactly the thing this product exists to tell you about.
 *
 * Privacy: the requirement says no unnecessary retention of sensitive process data. Process
 * command lines routinely contain file paths, server names, account names and access tokens
 * passed as arguments. So this module keeps **name, id, memory and CPU time** and never the
 * command line, the owner, or open handles. That is enough to answer "what is using this
 * machine" and not enough to leak what somebody is working on.
 *
 * @module
 */

import { available, unavailable, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, asArray } from '../platform/parse.js';
import { summariseToolOutput } from '../platform/windows.js';

/** How many processes the snapshot keeps. Beyond this the list stops being readable. */
export const PROCESS_LIMIT = 25;

/**
 * Normalise the rows produced by `Get-Process | Select-Object ...`.
 *
 * `CPU` is seconds of processor time (a total, not a rate), `WorkingSet64` is bytes. Both are
 * kept in their own units and labelled, because "CPU: 41" without a unit is the kind of
 * number this project exists to avoid.
 *
 * @param {object[]} rows
 * @returns {{name: string, pid: number|null, cpuSeconds: number|null, memoryMb: number|null}[]}
 */
export function normaliseProcesses(rows) {
  return asArray(rows)
    .map((row) => {
      const name = cleanString(row?.ProcessName ?? row?.Name);
      if (!name) return null;
      const pid = num(row?.Id ?? row?.PID);
      const cpu = num(row?.CPU);
      const workingSet = num(row?.WorkingSet64 ?? row?.WorkingSet);
      return {
        name: name.slice(0, 80),
        pid: pid === null ? null : Math.max(0, Math.trunc(pid)),
        cpuSeconds: cpu === null ? null : Math.max(0, Math.round(cpu * 10) / 10),
        memoryMb: workingSet === null ? null : Math.round((workingSet / (1024 * 1024)) * 10) / 10
      };
    })
    .filter(Boolean);
}

/**
 * Sort a snapshot by the two things a user actually asks about, and summarise it.
 * @param {ReturnType<typeof normaliseProcesses>} processes
 * @param {number} [limit]
 */
export function summariseProcesses(processes, limit = PROCESS_LIMIT) {
  const byMemory = [...processes]
    .filter((process) => process.memoryMb !== null)
    .sort((a, b) => b.memoryMb - a.memoryMb)
    .slice(0, limit);
  const byCpu = [...processes]
    .filter((process) => process.cpuSeconds !== null)
    .sort((a, b) => b.cpuSeconds - a.cpuSeconds)
    .slice(0, limit);

  const totalMemoryMb = processes.reduce((sum, process) => sum + (process.memoryMb ?? 0), 0);
  // Grouping by name is what turns 180 chrome.exe rows into one useful line.
  const groups = new Map();
  for (const process of processes) {
    const group = groups.get(process.name) ?? { name: process.name, count: 0, memoryMb: 0 };
    group.count += 1;
    group.memoryMb += process.memoryMb ?? 0;
    groups.set(process.name, group);
  }

  return {
    total: processes.length,
    totalMemoryMb: Math.round(totalMemoryMb),
    byMemory,
    byCpu,
    heaviestGroup: [...groups.values()].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 6)
      .map((group) => ({ ...group, memoryMb: Math.round(group.memoryMb) })),
    duplicates: [...groups.values()].filter((group) => group.count > 8).map((group) => ({ name: group.name, count: group.count }))
  };
}

/**
 * Build report fields from a process summary.
 * @param {ReturnType<typeof summariseProcesses>} summary
 * @param {string} source
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function describeProcesses(summary, source) {
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    processCount: available(summary.total, source, {
      notes: ['A single snapshot taken during this scan. Nothing is sampled in the background.']
    })
  };

  if (summary.heaviestGroup.length > 0) {
    fields.processMemoryLeaders = field(
      summary.heaviestGroup.map((group) => `${group.name} ${group.memoryMb} MB${group.count > 1 ? ` in ${group.count} processes` : ''}`).join(', '),
      { source, notes: ['Working set by process name, with instances grouped.'] }
    );
  }

  if (summary.byCpu.length > 0 && (summary.byCpu[0]?.cpuSeconds ?? 0) > 0) {
    fields.processCpuLeaders = field(
      summary.byCpu.slice(0, 6).map((process) => `${process.name} ${process.cpuSeconds}s`).join(', '),
      { source, notes: ['Total processor time since each process started, not a current percentage.'] }
    );
  }

  const runaway = summary.duplicates.filter((group) => !/svchost|chrome|msedge|firefox|code|node/i.test(group.name));
  if (runaway.length > 0) {
    fields.processDuplicates = field(
      runaway.map((group) => `${group.name} ×${group.count}`).join(', '),
      {
        status: Status.WARNING,
        source,
        notes: ['An application running many identical processes is normal for browsers and editors, and suspicious for anything else.']
      }
    );
  }

  return fields;
}

/**
 * Register the process snapshot task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerProcesses(registry) {
  registry.registerProvider({
    id: 'powershell.processes',
    title: 'Process list (names, memory, CPU time)',
    priority: 1,
    timeoutMs: 30_000,
    collect: async (ctx) => {
      // No CommandLine. See the module header: the field that would help most in a lab is the
      // one that leaks the most on a real desk.
      const body = [
        'Get-Process -ErrorAction SilentlyContinue |',
        '  Select-Object ProcessName, Id, CPU, WorkingSet64 |',
        '  ConvertTo-Json -Compress -Depth 2'
      ].join('\n');

      const result = await ctx.runner.powershellJson(body, { name: 'processes:snapshot', timeoutMs: 25_000 });
      if (!result.ok) {
        return {
          processCount: unavailable(`The process list could not be read${summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr })}`, 'powershell.processes')
        };
      }

      const summary = summariseProcesses(normaliseProcesses(result.data));
      const fields = describeProcesses(summary, 'powershell.processes');
      fields.processes = available(summary.byMemory.map((process) => ({
        name: process.name,
        pid: process.pid,
        memoryMb: process.memoryMb,
        cpuSeconds: process.cpuSeconds
      })), 'powershell.processes');
      return fields;
    }
  });

  registry.registerTask({
    id: 'processes.snapshot',
    module: 'processes',
    title: 'Running processes',
    quick: false,
    providers: ['powershell.processes'],
    validate: (fields) => {
      const count = fields.processCount?.value;
      if (typeof count === 'number' && count < 5) {
        return [`only ${count} processes were listed, which is too few for a running Windows system`];
      }
      return [];
    }
  });
}
