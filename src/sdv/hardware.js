// What is bound at manufacture. All figures are illustrative assumptions.
export const PLATFORM_RESERVED = { cpu: 60, memoryMb: 128 };

export const HARDWARE = {
  lean: {
    id: 'lean',
    label: 'Lean BOM',
    capacity: { cpu: 100, memoryMb: 256 },
    capabilities: ['battery', 'position', 'motion'],
    bomDeltaUsd: 0,
  },
  headroom: {
    id: 'headroom',
    label: 'Headroom BOM',
    capacity: { cpu: 300, memoryMb: 1024 },
    capabilities: ['battery', 'position', 'motion', 'cargo-load', 'proximity'],
    bomDeltaUsd: 38,
  },
};

// Bound in hardware config. Software can move inside these limits and never past them.
export const ENVELOPE = {
  'motor.assistLimitKph': { label: 'Motor assist limit', unit: 'km/h', min: 10, max: 25 },
  'charge.maxSocPct': { label: 'Charge limit', unit: '%', min: 60, max: 100 },
  'brakes.response': { label: 'Brake response', locked: true },
};

export const DEFAULT_CONFIG = { 'motor.assistLimitKph': 25, 'charge.maxSocPct': 90 };

export function validateConfig(config) {
  const errors = [];
  for (const [key, value] of Object.entries(config)) {
    const limit = ENVELOPE[key];
    if (!limit) errors.push(`${key} is not a known setting`);
    else if (limit.locked) errors.push(`${limit.label} is bound at manufacture`);
    else if (typeof value !== 'number' || value < limit.min || value > limit.max) {
      errors.push(`${limit.label} must stay within ${limit.min}–${limit.max} ${limit.unit}`);
    }
  }
  return errors;
}
