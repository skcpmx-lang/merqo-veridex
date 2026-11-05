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
  'vendor-heuristic': SourceTier.HEURISTIC,
  'chipset-heuristic': SourceTier.HEURISTIC
});

/**
 * @param {string} providerId
 * @returns {string}
 */
export function tierOf(providerId) {
  return PROVIDER_TIERS[providerId] ?? SourceTier.HEURISTIC;
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
