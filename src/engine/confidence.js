/**
 * VERIDEX — Confidence rubric.
 *
 * The brief is explicit (MODULE 13): confidence may only reflect source quality
 * and validation outcome, and must never be presented as statistical certainty or
 * measurement accuracy. So this module is a deterministic table, not a model, and
 * every value it emits is accompanied in the UI by the words "source confidence".
 *
 * Ranks are declared per provider id, because a provider's reliability depends on
 * the mechanism it uses: an NVMe health log is authoritative for an NVMe device,
 * whereas a heuristic registry read is a best guess.
 */

import { Confidence } from '../core/field.js';

/**
 * Source quality tiers. `authoritative` means the OS exposes the value directly
 * as a first-class property; `derived` means we computed it from other values;
 * `heuristic` means we inferred it from correlations that could be wrong.
 */
export const SourceTier = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  FIRMWARE: 'firmware',
  DERIVED: 'derived',
  HEURISTIC: 'heuristic'
});

/** Provider id → source tier. Unknown providers default to heuristic. */
export const PROVIDER_TIERS = Object.freeze({
  'cim-win32': SourceTier.AUTHORITATIVE,
  'systeminformation': SourceTier.AUTHORITATIVE,
  'registry': SourceTier.AUTHORITATIVE,
  'nvme-health-log': SourceTier.FIRMWARE,
  'ata-smart': SourceTier.FIRMWARE,
  'battery-firmware': SourceTier.FIRMWARE,
  'acpi-thermal': SourceTier.FIRMWARE,
  'powercfg-report': SourceTier.DERIVED,
  'computed': SourceTier.DERIVED,
  'model-table': SourceTier.DERIVED,
  // dxdiag is a report the OS generates which VERIDEX then parses, so it is derived in
  // the same way a powercfg report is: one step removed from the live API.
  'directx-dxdiag': SourceTier.DERIVED,
  // Windows servicing inventory read through Get-WindowsOptionalFeature / Get-Service /
  // Get-CimInstance — the same authoritative interfaces as the CIM providers, reached
  // through PowerShell rather than a WMI query.
  'system-features': SourceTier.AUTHORITATIVE,
  // Action provider, not a measurement: it exists to describe and run driver export on
  // request and contributes no health evidence. Listed explicitly so it does not fall
  // through to the heuristic default by accident.
  'driver-export': SourceTier.DERIVED,
  // DISM asks the servicing stack about its own component store. That is the OS reporting on
  // itself, not a guess, and it is the only source for this question.
  'dism': SourceTier.AUTHORITATIVE,
  // Event log, uninstall registry, startup Run keys and the process table, read through
  // PowerShell. The same rule as 'system-features': PowerShell is the transport, and the
  // thing on the other end is a Windows subsystem reporting its own state.
  'powershell': SourceTier.AUTHORITATIVE,
  'vendor-heuristic': SourceTier.HEURISTIC,
  'chipset-heuristic': SourceTier.HEURISTIC
});

/**
 * Provider ids are task-scoped (`cim-win32.cpu`, `nvme-health-log.storage`) so two
 * modules can use the same mechanism without colliding in the registry. The tier is
 * still a property of the *mechanism*, so the suffix is stripped before lookup —
 * otherwise every real provider would fall through to "heuristic", which would
 * understate confidence everywhere and is exactly the kind of quiet wrongness this
 * rubric exists to prevent.
 *
 * @param {string} providerId
 * @returns {string}
 */
export function tierOf(providerId) {
  const id = String(providerId ?? '');
  return PROVIDER_TIERS[id] ?? PROVIDER_TIERS[id.split('.')[0]] ?? SourceTier.HEURISTIC;
}

/** The mechanism behind a task-scoped provider id, for display. */
export function mechanismOf(providerId) {
  return String(providerId ?? '').split('.')[0];
}

/**
 * Resolve confidence for a value.
 *
 * @param {object} input
 * @param {string} input.providerId
 * @param {boolean} [input.validated]   Passed structural/range validation.
 * @param {boolean} [input.singleProvider] True when no second provider corroborated the value.
 * @param {boolean} [input.corroborated] Two independent providers agreed.
 * @returns {string} one of Confidence.*
 */
export function resolveConfidence({ providerId, validated = true, corroborated = false }) {
  if (!validated) return Confidence.LOW;
  const tier = tierOf(providerId);

  if (tier === SourceTier.AUTHORITATIVE || tier === SourceTier.FIRMWARE) {
    return corroborated ? Confidence.HIGH : Confidence.HIGH;
  }
  if (tier === SourceTier.DERIVED) {
    return corroborated ? Confidence.MEDIUM : Confidence.MEDIUM;
  }
  // Heuristic sources never exceed LOW, even when corroborated, because two
  // guesses agreeing is still a guess.
  return Confidence.LOW;
}

/**
 * Human-readable explanation shown in tooltips. Keeps the UI from implying that
 * HIGH means "measured precisely".
 * @param {string} confidence
 * @param {string} providerId
 */
export function explainConfidence(confidence, providerId) {
  const tier = tierOf(providerId);
  const tierText = {
    authoritative: 'the operating system reports this value directly',
    firmware: 'the hardware firmware reports this value directly',
    derived: 'veridex computes this from other reported values',
    heuristic: 'veridex infers this from device identifiers, so it may be wrong on uncommon hardware'
  }[tier];
  const confidenceText = {
    [Confidence.HIGH]: 'Source confidence: high',
    [Confidence.MEDIUM]: 'Source confidence: medium',
    [Confidence.LOW]: 'Source confidence: low',
    [Confidence.NONE]: 'Source confidence: none'
  }[confidence] ?? 'Source confidence: unknown';
  return `${confidenceText} — ${tierText}. This describes where the number came from, not how precisely it was measured.`;
}
