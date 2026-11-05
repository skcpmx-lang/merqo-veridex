/**
 * VERIDEX — Health assessment engine (MODULE 15).
 *
 * The single most important rule in this file: **missing evidence is never
 * passing evidence**. A component with no readable sensor, no SMART log or no test
 * result is UNRATED, not 100. The overall score is a weighted mean over *rated*
 * components only, and the coverage percentage is reported next to it so a score
 * built from 30% of the machine can never be mistaken for a verdict on the whole
 * machine.
 *
 * Scores are a communication device, not a measurement. Every score object carries
 * the evidence that produced it, so a technician can always answer "why 72?".
 */

import { Status } from '../core/status.js';

/**
 * Component definitions, with the weight each carries in the overall score and the
 * evidence each needs to be rated.
 */
export const COMPONENTS = Object.freeze({
  cpu: { label: 'Processor', weight: 1.0, needs: ['identity', 'thermal-or-load'] },
  gpu: { label: 'Graphics', weight: 0.8, needs: ['identity'] },
  memory: { label: 'Memory', weight: 1.0, needs: ['configuration'] },
  storage: { label: 'Storage', weight: 1.4, needs: ['health-data'] },
  battery: { label: 'Battery', weight: 0.9, needs: ['capacity'] },
  thermal: { label: 'Thermals', weight: 1.0, needs: ['sensor'] },
  drivers: { label: 'Drivers', weight: 0.7, needs: ['inventory'] },
  security: { label: 'Security posture', weight: 0.8, needs: ['posture'] }
});

/**
 * @typedef {object} Evidence
 * @property {string} id        Short identifier, e.g. 'smart.reallocated'.
 * @property {string} label     Human sentence for the report.
 * @property {number} delta     Contribution to the score, negative or positive.
 * @property {string} status    Status that produced the delta.
 * @property {string|null} source
 */

/**
 * @typedef {object} ComponentScore
 * @property {string} id
 * @property {string} label
 * @property {number|null} score    0–100, or null when UNRATED.
 * @property {string} status        Status equivalent of the score.
 * @property {string} rating        'Good' | 'Fair' | 'Poor' | 'Critical' | 'Unrated'
 * @property {number} weight
 * @property {Evidence[]} evidence
 * @property {string[]} missing     Evidence the component needed but did not have.
 * @property {string} explanation
 */

/**
 * Translate a numeric score to its rating band.
 * @param {number|null} score
 */
export function ratingFor(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'Unrated';
  if (score >= 90) return 'Good';
  if (score >= 70) return 'Fair';
  if (score >= 40) return 'Poor';
  return 'Critical';
}

/**
 * @param {number|null} score
 */
export function statusForScore(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return Status.UNRATED;
  if (score >= 90) return Status.PASS;
  if (score >= 70) return Status.WARNING;
  return Status.FAIL;
}

/**
 * Build a component score from evidence.
 *
 * @param {string} id
 * @param {Evidence[]} evidence
 * @param {{missing?:string[], floor?:number}} [options]
 * @returns {ComponentScore}
 */
export function buildComponentScore(id, evidence, options = {}) {
  const definition = COMPONENTS[id];
  if (!definition) throw new Error(`Unknown health component "${id}"`);

  const usable = (evidence ?? []).filter((entry) => entry && Number.isFinite(entry.delta));
  const missing = options.missing ?? [];

  if (usable.length === 0) {
    return {
      id,
      label: definition.label,
      score: null,
      status: Status.UNRATED,
      rating: 'Unrated',
      weight: definition.weight,
      evidence: [],
      missing: missing.length > 0 ? missing : ['no usable evidence was collected'],
      explanation: `No evidence was available for ${definition.label.toLowerCase()}, so no score is given. This is not a pass and not a failure.`
    };
  }

  const total = usable.reduce((sum, entry) => sum + entry.delta, 0);
  const raw = 100 + total;
  // A score can never be negative; the floor option lets a catastrophic finding
  // (e.g. a drive reporting media failure) pin the component at the bottom without
  // arithmetic games.
  const score = Math.max(options.floor ?? 0, Math.min(100, Math.round(raw)));

  return {
    id,
    label: definition.label,
    score,
    status: statusForScore(score),
    rating: ratingFor(score),
    weight: definition.weight,
    evidence: usable,
    missing,
    explanation: explain(definition.label, score, usable)
  };
}

/**
 * @param {string} label
 * @param {number} score
 * @param {Evidence[]} evidence
 */
function explain(label, score, evidence) {
  const negatives = evidence.filter((entry) => entry.delta < 0);
  if (negatives.length === 0) return `${label} scored ${score} with no findings; every piece of evidence collected was within its expected range.`;
  const worst = [...negatives].sort((a, b) => a.delta - b.delta).slice(0, 3);
  return `${label} scored ${score}. Main contributors: ${worst.map((entry) => `${entry.label} (${entry.delta})`).join('; ')}.`;
}

/**
 * Evidence builders for the common cases. Centralising the deltas keeps the scale
 * consistent across modules and makes the weighting auditable.
 */
export const PENALTIES = Object.freeze({
  batteryWear20: -8,
  batteryWear40: -22,
  batteryWear60: -40,
  batteryFail: -60,
  reallocatedSectors: -18,
  pendingSectors: -30,
  uncorrectableErrors: -18,
  crcErrors: -8,
  nvmeEndurance80: -18,
  nvmeEndurance100: -45,
  nvmeCriticalWarning: -70,
  nvmeSpareExhausted: -60,
  highTemperature: -12,
  criticalTemperature: -28,
  driveWarningStatus: -14,
  driveUnhealthyStatus: -50,
  driverFailedCore: -12,
  driverFailedPeripheral: -4,
  driverWarning: -3,
  defenderRealtimeOff: -12,
  firewallDisabled: -10,
  firewallPartial: -4,
  bitlockerProtectionOff: -6,
  uacDisabled: -12,
  winreDisabled: -4,
  secureBootDisabled: -6,
  tpmAbsent: -4,
  outdatedSignatures: -6,
  memoryBelowRated: -4,
  singleChannel: -4,
  memoryUncorrectable: -25
});

/**
 * @typedef {object} OverallAssessment
 * @property {number|null} score
 * @property {string} rating
 * @property {string} status
 * @property {number} coveragePercent
 * @property {number} ratedComponents
 * @property {number} totalComponents
 * @property {ComponentScore[]} components
 * @property {string} disclaimer
 */

/**
 * Aggregate component scores into the overall assessment.
 *
 * @param {ComponentScore[]} components
 * @returns {OverallAssessment}
 */
export function assessOverall(components) {
  const list = Array.isArray(components) ? components : [];
  const rated = list.filter((component) => typeof component.score === 'number' && Number.isFinite(component.score));
  const totalWeight = list.reduce((sum, component) => sum + (component.weight ?? 1), 0);
  const ratedWeight = rated.reduce((sum, component) => sum + (component.weight ?? 1), 0);

  const score = ratedWeight > 0 ? Math.round(rated.reduce((sum, component) => sum + component.score * (component.weight ?? 1), 0) / ratedWeight) : null;
  const coveragePercent = totalWeight > 0 ? Math.round((ratedWeight / totalWeight) * 1000) / 10 : 0;

  return {
    score,
    rating: ratingFor(score),
    status: statusForScore(score),
    coveragePercent,
    ratedComponents: rated.length,
    totalComponents: list.length,
    components: list,
    disclaimer:
      'This score summarises the evidence VERIDEX was able to collect. It is not a certification, a guarantee against future failure, or a substitute for physical inspection. Components without evidence are unrated and are excluded from the score rather than counted as healthy.'
  };
}

/**
 * Build all component scores from a completed diagnostic result set.
 *
 * Input is the plain per-module field map produced by the runner, so this function
 * is pure and fully testable.
 *
 * @param {Record<string, Record<string, import('../core/field.js').FieldValue>>} modules
 * @param {{manualResults?: Record<string, string>}} [options]
 * @returns {OverallAssessment}
 */
export function assessFromDiagnostics(modules = {}, options = {}) {
  /** @type {ComponentScore[]} */
  const components = [];

  components.push(scoreCpu(modules.cpu ?? {}));
  components.push(scoreGpu(modules.gpu ?? {}));
  components.push(scoreMemory(modules.memory ?? {}));
  components.push(scoreStorage(modules.storage ?? {}, modules.storageHealth ?? {}));
  components.push(scoreBattery(modules.battery ?? {}));
  components.push(scoreThermal(modules.sensors ?? {}, modules.cpu ?? {}, modules.gpu ?? {}));
  components.push(scoreDrivers(modules.drivers ?? {}));
  components.push(scoreSecurity(modules.security ?? {}, modules.motherboard ?? {}));

  return assessOverall(components);
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} cpu
 * @returns {ComponentScore}
 */
export function scoreCpu(cpu) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const hasIdentity = cpu.name?.status === Status.PASS || cpu.name?.status === Status.PARTIALLY_AVAILABLE;
  if (!hasIdentity) missing.push('processor identity could not be read');

  // CPU load is not a health signal on its own: a busy CPU is a working CPU. The
  // only health-relevant CPU facts are its thermal state (handled by the thermal
  // component) and whether it identifies itself at all. So a readable CPU with
  // sane core counts scores 100 and the report says exactly that.
  const cores = cpu.physicalCores?.value;
  const threads = cpu.logicalCores?.value;
  if (typeof cores === 'number' && typeof threads === 'number') {
    if (threads < cores) {
      evidence.push({ id: 'cpu.core-count', label: `Logical cores (${threads}) below physical cores (${cores})`, delta: -10, status: Status.WARNING, source: 'computed' });
    } else {
      evidence.push({ id: 'cpu.core-count', label: `${cores} cores / ${threads} threads reported consistently`, delta: 0, status: Status.PASS, source: cpu.physicalCores.source ?? null });
    }
  } else {
    missing.push('core counts were not readable');
  }

  if (hasIdentity) {
    evidence.push({ id: 'cpu.identity', label: 'Processor identified from the operating system', delta: 0, status: Status.PASS, source: cpu.name.source ?? null });
  }

  return buildComponentScore('cpu', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} gpu
 */
export function scoreGpu(gpu) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const adapterCount = gpu.adapterCount?.value;
  if (typeof adapterCount === 'number' && adapterCount > 0) {
    evidence.push({ id: 'gpu.present', label: `${adapterCount} display adapter(s) detected`, delta: 0, status: Status.PASS, source: gpu.adapterCount.source ?? null });
  } else {
    missing.push('no display adapter could be enumerated');
  }

  // A device-manager error on a display adapter is a real, observable fault.
  for (const [key, value] of Object.entries(gpu)) {
    if (key.endsWith('.adapterCompatibilityNote') && value.status === Status.WARNING) {
      evidence.push({ id: `gpu.${key}`, label: value.value ?? 'display adapter reports a device error', delta: PENALTIES.driverWarning, status: Status.WARNING, source: value.source ?? null });
    }
  }

  return buildComponentScore('gpu', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} memory
 */
export function scoreMemory(memory) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const moduleCount = memory.moduleCount?.value;
  if (typeof moduleCount === 'number' && moduleCount > 0) {
    const total = memory.totalCapacity?.value;
    evidence.push({ id: 'memory.populated', label: `${moduleCount} module(s)${typeof total === 'number' ? ` totalling ${total} GB` : ''}`, delta: 0, status: Status.PASS, source: memory.moduleCount.source ?? null });
  } else {
    missing.push('memory module configuration could not be read');
  }

  if (typeof moduleCount === 'number' && moduleCount === 1) {
    evidence.push({
      id: 'memory.single-channel',
      label: 'Only one module is populated, so the memory controller runs in single-channel mode',
      delta: PENALTIES.singleChannel,
      status: Status.WARNING,
      source: 'vendor-heuristic'
    });
  }

  // Modules running below their rated speed is a configuration finding, not a
  // defect, so the penalty is small and the wording says so.
  for (const [key, value] of Object.entries(memory)) {
    if (key.endsWith('.speedNote') && value.status === Status.WARNING) {
      evidence.push({ id: `memory.${key}`, label: value.value ?? 'module running below rated speed', delta: PENALTIES.memoryBelowRated, status: Status.WARNING, source: value.source ?? null });
    }
  }

  return buildComponentScore('memory', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} storage
 * @param {Record<string, import('../core/field.js').FieldValue>} health
 */
export function scoreStorage(storage, health = {}) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const diskCount = storage.diskCount?.value;
  if (typeof diskCount === 'number' && diskCount > 0) {
    evidence.push({ id: 'storage.present', label: `${diskCount} physical disk(s) detected`, delta: 0, status: Status.PASS, source: storage.diskCount.source ?? null });
  } else {
    missing.push('no physical disk could be enumerated');
  }

  // Windows' own storage health verdict is authoritative for "unhealthy".
  for (const [key, value] of Object.entries(storage)) {
    if (key.endsWith('.healthStatus')) {
      if (value.value === 'Unhealthy') {
        evidence.push({ id: `storage.${key}`, label: `Windows reports ${key.split('.')[0]} as unhealthy`, delta: PENALTIES.driveUnhealthyStatus, status: Status.FAIL, source: value.source ?? null });
      } else if (value.value === 'Warning') {
        evidence.push({ id: `storage.${key}`, label: `Windows reports a warning for ${key.split('.')[0]}`, delta: PENALTIES.driveWarningStatus, status: Status.WARNING, source: value.source ?? null });
      }
    }
  }

  let smartRead = false;
  // Presence is not health. A detected disk with no readable health source must
  // stay UNRATED, otherwise "the disk exists" silently becomes a perfect score.
  let healthEvidenceCount = 0;

  for (const [key, value] of Object.entries(health)) {
    if (value.status === Status.PASS || value.status === Status.WARNING || value.status === Status.FAIL) smartRead = true;

    const before = evidence.length;
    // Any readable SMART/NVMe counter is health evidence; a clean counter (zero
    // reallocated sectors) is just as much evidence as a bad one.
    if (typeof value.value === 'number' && /(reallocatedSectors|pendingSectors|uncorrectableErrors|crcErrors|mediaErrors|percentageUsed|availableSpare|powerOnHours)$/.test(key)) {
      healthEvidenceCount += 1;
    }
    if (key.endsWith('.reallocatedSectors') && typeof value.value === 'number' && value.value > 0) {
      evidence.push({ id: `smart.${key}`, label: `${value.value} reallocated sector(s)`, delta: PENALTIES.reallocatedSectors, status: Status.WARNING, source: value.source ?? null });
    }
    if (key.endsWith('.pendingSectors') && typeof value.value === 'number' && value.value > 0) {
      evidence.push({ id: `smart.${key}`, label: `${value.value} pending sector(s)`, delta: PENALTIES.pendingSectors, status: Status.WARNING, source: value.source ?? null });
    }
    if ((key.endsWith('.uncorrectableErrors') || key.endsWith('.mediaErrors')) && typeof value.value === 'number' && value.value > 0) {
      evidence.push({ id: `smart.${key}`, label: `${value.value} uncorrectable/media error(s)`, delta: PENALTIES.uncorrectableErrors, status: Status.WARNING, source: value.source ?? null });
    }
    if (key.endsWith('.crcErrors') && typeof value.value === 'number' && value.value > 0) {
      evidence.push({ id: `smart.${key}`, label: `${value.value} UDMA CRC error(s) (link-level)`, delta: PENALTIES.crcErrors, status: Status.WARNING, source: value.source ?? null });
    }
    // A low wear figure is real evidence of health, not an absence of evidence.
    if (key.endsWith('.percentageUsed') && typeof value.value === 'number' && value.value < 80) {
      evidence.push({ id: `smart.${key}`, label: `${value.value}% of rated endurance consumed`, delta: 0, status: Status.PASS, source: value.source ?? null });
    }
    if (key.endsWith('.percentageUsed') && typeof value.value === 'number') {
      if (value.value >= 100) {
        evidence.push({ id: `smart.${key}`, label: `${value.value}% of rated endurance consumed`, delta: PENALTIES.nvmeEndurance100, status: Status.FAIL, source: value.source ?? null });
      } else if (value.value >= 80) {
        evidence.push({ id: `smart.${key}`, label: `${value.value}% of rated endurance consumed`, delta: PENALTIES.nvmeEndurance80, status: Status.WARNING, source: value.source ?? null });
      }
    }
    if (key.endsWith('.criticalWarning') && value.status === Status.FAIL) {
      evidence.push({ id: `smart.${key}`, label: value.value ?? 'drive reports a critical warning', delta: PENALTIES.nvmeCriticalWarning, status: Status.FAIL, source: value.source ?? null });
    }
    if (key.endsWith('.availableSpare') && typeof value.value === 'number' && value.value > 0) {
      evidence.push({ id: `smart.${key}`, label: `available spare capacity is ${value.value}%`, delta: 0, status: Status.PASS, source: value.source ?? null });
    }
    if (key.endsWith('.availableSpare') && typeof value.value === 'number' && value.value === 0) {
      evidence.push({ id: `smart.${key}`, label: 'available spare capacity is exhausted', delta: PENALTIES.nvmeSpareExhausted, status: Status.FAIL, source: value.source ?? null });
    }
    if (evidence.length > before) healthEvidenceCount += 1;
  }

  // Windows' own unhealthy/warning verdict also counts as health evidence.
  for (const [key, value] of Object.entries(storage)) {
    if (key.endsWith('.healthStatus') && value.status === Status.PASS) healthEvidenceCount += 1;
  }

  if (!smartRead) {
    const blocked = Object.values(health).some((value) => value.status === Status.PERMISSION_REQUIRED);
    missing.push(blocked ? 'SMART/NVMe health data needs administrator rights' : 'no SMART or NVMe health data was readable');
  }

  // With no health evidence at all, drop the presence-only rows so the component is
  // reported UNRATED instead of being scored on the fact that a disk exists.
  const scoredEvidence = healthEvidenceCount > 0 ? evidence : [];

  return buildComponentScore('storage', scoredEvidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} battery
 */
export function scoreBattery(battery) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const health = battery.health?.value;
  if (typeof health === 'number') {
    if (health < 50) {
      evidence.push({ id: 'battery.health', label: `battery health is ${health}%`, delta: PENALTIES.batteryFail, status: Status.FAIL, source: battery.health.source ?? null });
    } else if (health < 70) {
      evidence.push({ id: 'battery.health', label: `battery health is ${health}%`, delta: PENALTIES.batteryWear60, status: Status.WARNING, source: battery.health.source ?? null });
    } else if (health < 80) {
      evidence.push({ id: 'battery.health', label: `battery health is ${health}%`, delta: PENALTIES.batteryWear40, status: Status.WARNING, source: battery.health.source ?? null });
    } else if (health < 90) {
      evidence.push({ id: 'battery.health', label: `battery health is ${health}%`, delta: PENALTIES.batteryWear20, status: Status.WARNING, source: battery.health.source ?? null });
    } else {
      evidence.push({ id: 'battery.health', label: `battery health is ${health}%`, delta: 0, status: Status.PASS, source: battery.health.source ?? null });
    }
  } else {
    const notApplicable = battery.present?.status === Status.NOT_APPLICABLE || Object.values(battery).some((value) => value.status === Status.NOT_APPLICABLE);
    missing.push(notApplicable ? 'no battery is present, so there is nothing to score' : 'battery health could not be computed');
  }

  const cycles = battery.cycleCount?.value;
  if (typeof cycles === 'number' && cycles > 800) {
    evidence.push({ id: 'battery.cycles', label: `${cycles} charge cycles`, delta: PENALTIES.batteryWear20, status: Status.WARNING, source: battery.cycleCount.source ?? null });
  }

  return buildComponentScore('battery', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} sensors
 * @param {Record<string, import('../core/field.js').FieldValue>} cpu
 * @param {Record<string, import('../core/field.js').FieldValue>} gpu
 */
export function scoreThermal(sensors, cpu = {}, gpu = {}) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];
  let sawSensor = false;

  const consider = (value, label) => {
    if (typeof value !== 'number') return;
    sawSensor = true;
    if (value >= 95) {
      evidence.push({ id: `thermal.${label}`, label: `${label} at ${value} °C`, delta: PENALTIES.criticalTemperature, status: Status.FAIL, source: 'sensor' });
    } else if (value >= 85) {
      evidence.push({ id: `thermal.${label}`, label: `${label} at ${value} °C`, delta: PENALTIES.highTemperature, status: Status.WARNING, source: 'sensor' });
    } else {
      evidence.push({ id: `thermal.${label}`, label: `${label} at ${value} °C`, delta: 0, status: Status.PASS, source: 'sensor' });
    }
  };

  consider(sensors.cpuTemperature?.value, 'CPU temperature');
  consider(cpu.temperature?.value, 'CPU temperature');
  consider(gpu.temperature?.value, 'GPU temperature');
  consider(sensors.storageTemperature?.value, 'Drive temperature');

  if (!sawSensor) {
    missing.push('no temperature sensor was readable, which is common on laptops without a licensed sensor driver');
  }

  return buildComponentScore('thermal', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} drivers
 */
export function scoreDrivers(drivers) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const count = drivers.driverCount?.value;
  if (typeof count === 'number' && count > 0) {
    evidence.push({ id: 'drivers.enumerated', label: `${count} devices with driver information`, delta: 0, status: Status.PASS, source: drivers.driverCount.source ?? null });
  } else {
    missing.push('the driver inventory could not be read');
  }

  const failed = drivers.driversFailed?.value;
  if (typeof failed === 'number' && failed > 0) {
    evidence.push({ id: 'drivers.failed', label: `${failed} device(s) in a failed state`, delta: failed > 2 ? PENALTIES.driverFailedCore * 2 : PENALTIES.driverFailedCore, status: Status.FAIL, source: drivers.driversFailed.source ?? null });
  }

  const warning = drivers.driversWarning?.value;
  if (typeof warning === 'number' && warning > 0) {
    evidence.push({ id: 'drivers.warning', label: `${warning} device(s) with a warning`, delta: PENALTIES.driverWarning, status: Status.WARNING, source: drivers.driversWarning.source ?? null });
  }

  const critical = drivers.criticalIssues?.value;
  if (Array.isArray(critical) && critical.length > 0) {
    evidence.push({ id: 'drivers.critical', label: `core-class device problem: ${critical.slice(0, 3).join(', ')}`, delta: PENALTIES.driverFailedPeripheral, status: Status.WARNING, source: drivers.criticalIssues.source ?? null });
  }

  return buildComponentScore('drivers', evidence, { missing });
}

/**
 * @param {Record<string, import('../core/field.js').FieldValue>} security
 * @param {Record<string, import('../core/field.js').FieldValue>} motherboard
 */
export function scoreSecurity(security, motherboard = {}) {
  /** @type {Evidence[]} */
  const evidence = [];
  const missing = [];

  const read = (field, label, penalty) => {
    if (!field) return;
    if (field.status === Status.WARNING) {
      evidence.push({ id: `security.${label}`, label: field.value ?? label, delta: penalty, status: Status.WARNING, source: field.source ?? null });
    } else if (field.status === Status.PASS) {
      evidence.push({ id: `security.${label}`, label: `${label}: ${field.value ?? 'ok'}`, delta: 0, status: Status.PASS, source: field.source ?? null });
    }
  };

  read(security.defenderRealtimeProtection, 'real-time protection', PENALTIES.defenderRealtimeOff);
  read(security.firewallSummary, 'firewall', PENALTIES.firewallPartial);
  read(security.firewall?.domain, 'firewall (domain profile)', PENALTIES.firewallDisabled);
  read(security.uacEnabled, 'UAC', PENALTIES.uacDisabled);
  read(security.winreEnabled, 'Windows Recovery Environment', PENALTIES.winreDisabled);
  read(security.bitlockerProtectionOff, 'BitLocker', PENALTIES.bitlockerProtectionOff);
  read(security.defenderSignatureAge, 'definition age', PENALTIES.outdatedSignatures);
  read(motherboard.secureBoot, 'Secure Boot', PENALTIES.secureBootDisabled);
  read(motherboard.tpmPresent, 'TPM', PENALTIES.tpmAbsent);

  if (evidence.length === 0) {
    missing.push('no security posture could be read');
  }

  return buildComponentScore('security', evidence, { missing });
}

/**
 * Explain why a component is unrated. Used by the UI tooltip and the report note.
 * @param {ComponentScore} component
 */
export function unratedExplanation(component) {
  if (component.score !== null) return null;
  return `Not scored: ${component.missing.join('; ')}.`;
}

/**
 * Machine-readable coverage statement for the report: which components were rated,
 * and which were not, with the reason.
 * @param {OverallAssessment} assessment
 */
export function coverageStatement(assessment) {
  const rated = assessment.components.filter((component) => component.score !== null);
  const unrated = assessment.components.filter((component) => component.score === null);
  return {
    headline: `${rated.length} of ${assessment.components.length} components could be assessed (${assessment.coveragePercent}% of the weighted assessment surface).`,
    rated: rated.map((component) => `${component.label}: ${component.score} (${component.rating})`),
    unrated: unrated.map((component) => `${component.label}: not rated — ${component.missing.join('; ')}`)
  };
}
