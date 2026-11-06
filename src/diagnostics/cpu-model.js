/**
 * VERIDEX — CPU model decoding.
 *
 * Processor names are free text ("Intel(R) Core(TM) i7-1165G7 CPU @ 2.80GHz").
 * Turning that into "11th generation, Core i7" is useful for a technician, but it
 * is an *inference*, so this module:
 *   - only decodes naming schemes it can state a rule for;
 *   - returns null rather than guessing when the pattern does not match;
 *   - reports the rule it applied, so the report can attribute the claim.
 *
 * Deliberately not decoded: microarchitecture. Intel's "10th generation" spans
 * both Comet Lake and Ice Lake, and AMD's 3000 series spans Zen+ mobile APUs and
 * Zen 2 desktop parts. A confident-sounding but wrong microarchitecture is worse
 * than none, so that field stays out of the derived data entirely.
 */

/** SMBIOS/WMI `Win32_Processor.Architecture` codes. */
export const ARCHITECTURE_CODES = Object.freeze({
  0: 'x86',
  1: 'MIPS',
  2: 'Alpha',
  3: 'PowerPC',
  5: 'ARM',
  6: 'Itanium',
  9: 'x64',
  12: 'ARM64'
});

/**
 * @param {unknown} code
 * @returns {string|null}
 */
export function decodeArchitecture(code) {
  // Guard the null/blank case explicitly: Number(null) is 0, which would silently
  // report "x86" for missing data.
  if (code === null || code === undefined || code === '') return null;
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return null;
  return ARCHITECTURE_CODES[numeric] ?? null;
}

/**
 * @typedef {object} CpuIdentity
 * @property {string|null} manufacturer   Normalised vendor name.
 * @property {string|null} productLine    'Core i7', 'Ryzen 5', 'Xeon', ...
 * @property {string|null} modelNumber    '1165G7', '5800H', ...
 * @property {number|null} generation     Marketing generation/series number.
 * @property {string|null} generationLabel e.g. '11th generation', 'Ryzen 5000 series'
 * @property {string|null} rule           Which decoding rule produced the result.
 */

/**
 * True for "Core Ultra", tolerating the (TM)/™ token Intel inserts between the
 * brand words in WMI strings.
 * @param {string} text
 */
function isCoreUltra(text) {
  return /Core\s*(?:\((?:TM|R)\)|™)?\s*Ultra/i.test(text);
}

/**
 * Decode an Intel processor name.
 * Rule: the digit block after the dash is the model number. If that block begins
 * with 10, 11, 12, 13 or 14 it is the generation (five-digit and G-series forms
 * such as 10700K and 1165G7); otherwise its first digit is the generation, which
 * covers 2nd through 9th generation four-digit names.
 * @param {string} name
 * @returns {CpuIdentity}
 */
export function decodeIntel(name) {
  const text = name.replace(/\s+/g, ' ').trim();
  const lineMatch = text.match(/(?:Core|Core\s*(?:\(TM\)|™))\s*(Ultra\s*[579]|i[3579]|m[357])\b/i) ||
    text.match(/Core\s*(?:^|[^A-Za-z])(Ultra\s*\d|i[3579]|m[357])\b/i) ||
    text.match(/Core\s+(Ultra\s*[579]|[im][357]\d)/i);
  const productLine = lineMatch ? `Core ${lineMatch[1].replace(/\s+/g, ' ').trim()}`.replace(/^Core i/i, 'Core i') : null;

  // Model number: the token after the product line, e.g. i7-1165G7, Ultra 7 155H.
  const dashMatch = text.match(/(?:i[3579]|Ultra\s*[579]|m[357])[\s-]+([0-9]{3,5}[A-Z]{0,3}[0-9]?[A-Z]{0,2})/i);
  let modelNumber = dashMatch ? dashMatch[1].toUpperCase() : null;

  // Core Ultra uses a three-digit model where the leading digit is the series.
  // The vendor string may interpose "(TM)" between "Core" and "Ultra", so this
  // must not be a naive substring test.
  if (isCoreUltra(text) && modelNumber) {
    const digits = modelNumber.match(/^\d+/)?.[0] ?? '';
    if (digits.length === 3) {
      const generation = Number(digits.slice(0, 1));
      return {
        manufacturer: 'Intel',
        productLine,
        modelNumber,
        generation: Number.isFinite(generation) ? generation : null,
        generationLabel: Number.isFinite(generation) ? `Core Ultra series ${digits.slice(0, 1)}` : null,
        rule: 'intel-core-ultra'
      };
    }
  }

  if (!modelNumber) {
    const xeon = text.match(/Xeon\s*(?:\(R\))?\s*([A-Z]?\d{4,5}[A-Z]{0,3})/i);
    if (xeon) {
      return { manufacturer: 'Intel', productLine: 'Xeon', modelNumber: xeon[1].toUpperCase(), generation: null, generationLabel: null, rule: 'intel-xeon' };
    }
    return { manufacturer: 'Intel', productLine, modelNumber: null, generation: null, generationLabel: null, rule: null };
  }

  const digits = modelNumber.match(/^\d+/)?.[0] ?? '';
  let generation = null;
  if (/^(10|11|12|13|14)/.test(digits) && digits.length >= 4) {
    generation = Number(digits.slice(0, 2));
  } else if (digits.length >= 3) {
    generation = Number(digits[0]);
  }

  const valid = generation !== null && generation >= 2 && generation <= 99;
  return {
    manufacturer: 'Intel',
    productLine,
    modelNumber,
    generation: valid ? generation : null,
    generationLabel: valid ? `${ordinal(generation)} generation` : null,
    rule: valid ? (/^(10|11|12|13|14)/.test(digits) ? 'intel-two-digit-generation' : 'intel-first-digit-generation') : null
  };
}

/**
 * Decode an AMD processor name.
 * Rule: "Ryzen N XXXX" where XXXX is a four-digit SKU; its first digit is the
 * series (1000 = first gen, 2000, 3000, 4000, 5000, 7000, 8000, 9000). The
 * 7000 series skips 6000 for desktop but the mobile 6000 series exists, so the
 * series number is reported verbatim rather than forced onto a ladder.
 * @param {string} name
 * @returns {CpuIdentity}
 */
export function decodeAmd(name) {
  const text = name.replace(/\s+/g, ' ').trim();
  const ryzen = text.match(/Ryzen\s*(?:AI\s*)?(?:Threadripper\s*)?([3579])\s*(?:PRO\s*)?([0-9]{3,4}[A-Z]{0,2}[0-9]?[A-Z]{0,2})/i);
  if (ryzen) {
    const tier = ryzen[1];
    const sku = ryzen[2].toUpperCase();
    const isRyzenAi = /Ryzen\s*AI/i.test(text);
    const digits = sku.match(/^\d+/)?.[0] ?? '';
    let series = null;
    if (isRyzenAi) {
      // Ryzen AI 300 series: the leading digit is 3 and the SKU is three digits.
      series = digits.length === 3 ? Number(`${digits[0]}00`) : null;
    } else if (digits.length === 4) {
      series = Number(`${digits[0]}000`);
    } else if (digits.length === 3) {
      series = Number(`${digits[0]}00`);
    }
    return {
      manufacturer: 'AMD',
      productLine: isRyzenAi ? `Ryzen AI ${tier}` : `Ryzen ${tier}`,
      modelNumber: sku,
      generation: series,
      generationLabel: series === null ? null : isRyzenAi ? `Ryzen AI ${series} series` : `Ryzen ${series} series`,
      rule: series === null ? null : isRyzenAi ? 'amd-ryzen-ai-sku' : 'amd-ryzen-sku-series'
    };
  }

  const threadripper = text.match(/Ryzen\s*Threadripper\s*(?:PRO\s*)?([0-9]{4,5}[A-Z]{0,3})/i);
  if (threadripper) {
    return { manufacturer: 'AMD', productLine: 'Ryzen Threadripper', modelNumber: threadripper[1].toUpperCase(), generation: null, generationLabel: null, rule: null };
  }

  const epyc = text.match(/EPYC\s*([0-9]{4}[A-Z]{0,2})/i);
  if (epyc) {
    return { manufacturer: 'AMD', productLine: 'EPYC', modelNumber: epyc[1].toUpperCase(), generation: null, generationLabel: null, rule: null };
  }

  if (/Athlon/i.test(text)) {
    const athlon = text.match(/Athlon\s*(?:Silver|Gold|PRO)?\s*([0-9]{3,4}[A-Z]?)/i);
    return { manufacturer: 'AMD', productLine: 'Athlon', modelNumber: athlon ? athlon[1].toUpperCase() : null, generation: null, generationLabel: null, rule: null };
  }

  return { manufacturer: 'AMD', productLine: null, modelNumber: null, generation: null, generationLabel: null, rule: null };
}

/**
 * Decode any supported processor name.
 * @param {string|null|undefined} name
 * @param {string|null} [manufacturerHint]
 * @returns {CpuIdentity}
 */
export function decodeCpuName(name, manufacturerHint = null) {
  const text = typeof name === 'string' ? name.trim() : '';
  const hint = (manufacturerHint ?? '').toLowerCase();
  if (!text) {
    return { manufacturer: manufacturerHint ?? null, productLine: null, modelNumber: null, generation: null, generationLabel: null, rule: null };
  }
  if (/intel/i.test(text) || hint.includes('intel')) return decodeIntel(text);
  if (/amd|ryzen|athlon|epyc/i.test(text) || hint.includes('amd') || hint.includes('advanced micro')) return decodeAmd(text);
  if (/qualcomm|snapdragon/i.test(text)) {
    const sku = text.match(/(X\s*Elite|[0-9]{1,2}cx|[0-9]{1,2}c)\b/i);
    return { manufacturer: 'Qualcomm', productLine: /Snapdragon/i.test(text) ? 'Snapdragon' : null, modelNumber: sku ? sku[1].toUpperCase() : null, generation: null, generationLabel: null, rule: null };
  }
  if (/apple/i.test(text)) {
    return { manufacturer: 'Apple', productLine: null, modelNumber: text.match(/M\d\s*(Pro|Max|Ultra)?/i)?.[0] ?? null, generation: null, generationLabel: null, rule: null };
  }
  return { manufacturer: manufacturerHint ?? null, productLine: null, modelNumber: null, generation: null, generationLabel: null, rule: null };
}

/**
 * @param {number} value
 * @returns {string}
 */
function ordinal(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** Instruction-set extensions worth surfacing to a technician, in display order. */
export const NOTABLE_INSTRUCTION_SETS = Object.freeze([
  'MMX',
  'SSE',
  'SSE2',
  'SSE3',
  'SSSE3',
  'SSE4.1',
  'SSE4.2',
  'AVX',
  'AVX2',
  'AVX512F',
  'AVX512VL',
  'AES',
  'SHA',
  'FMA3',
  'BMI1',
  'BMI2',
  'VT-x',
  'AMD-V'
]);

/**
 * Normalise a CPUID flag list (as returned by `systeminformation` or by
 * `Get-CimInstance`) into a stable, de-duplicated display list.
 * @param {unknown} flags
 * @returns {string[]}
 */
export function normaliseInstructionSets(flags) {
  const raw = Array.isArray(flags) ? flags : typeof flags === 'string' ? flags.split(/\s+/) : [];
  const upper = raw.map((flag) => String(flag).trim().toUpperCase()).filter(Boolean);
  const canonical = new Map([
    ['SSE4_1', 'SSE4.1'],
    ['SSE4_2', 'SSE4.2'],
    ['AVX512F', 'AVX512F'],
    ['FMA', 'FMA3'],
    ['VMX', 'VT-x'],
    ['SVM', 'AMD-V']
  ]);
  const seen = new Set();
  const out = [];
  for (const flag of upper) {
    const name = canonical.get(flag) ?? flag;
    if (!NOTABLE_INSTRUCTION_SETS.includes(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  // Preserve the documented display order regardless of provider ordering.
  return NOTABLE_INSTRUCTION_SETS.filter((name) => seen.has(name));
}

/**
 * Standard VERIDEX core/thread sanity check. Used as task validation so a
 * nonsensical combination (threads < cores) is reported rather than displayed.
 * @param {{physicalCores?:number|null, logicalCores?:number|null, threads?:number|null}} counts
 * @returns {string[]}
 */
export function validateCoreCounts(counts) {
  const problems = [];
  const { physicalCores, logicalCores, threads } = counts;
  const logical = logicalCores ?? threads;
  if (physicalCores !== null && physicalCores !== undefined && physicalCores <= 0) problems.push('physical core count was not positive');
  if (logical !== null && logical !== undefined && logical <= 0) problems.push('logical core count was not positive');
  if (physicalCores != null && logical != null && logical < physicalCores) problems.push(`logical cores (${logical}) is lower than physical cores (${physicalCores})`);
  if (physicalCores != null && logical != null && logical > physicalCores * 4) problems.push(`logical/physical core ratio (${logical}/${physicalCores}) is implausible`);
  return problems;
}
