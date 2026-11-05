// A feature written against the HAL. It can't tell which supplier built the battery.
import { estimateRange, measured, modeled } from '../core/range.js';

export const ASSUMED_PAYLOAD_KG = 100;

export function runRangeApp(hal, { gradePct, stopsPerKm }) {
  const { packVolts, tempC } = hal.read('battery');
  const sensed = hal.has('cargo-load');
  const payloadKg = sensed ? hal.read('cargo-load').payloadKg : ASSUMED_PAYLOAD_KG;

  return {
    estimate: estimateRange({ packVolts, tempC, payloadKg, gradePct, stopsPerKm }),
    payload: sensed
      ? measured(payloadKg, 'kg', 'cargo-load sensor')
      : modeled(payloadKg, 'kg', 'fleet-average-assumption', {}),
  };
}
