// A feature written against the HAL. It can't tell which supplier built the battery.
import { estimateRange, measured, modeled } from '../core/range.js';

export const ASSUMED_PAYLOAD_KG = 100;

// Owning the sensor isn't enough: load-aware range is a feature, so the caller says if it's on.
export function runRangeApp(hal, { gradePct, stopsPerKm, useCargoSensor = true, healthPct = 100 }) {
  const { packVolts, tempC } = hal.read('battery');
  const sensed = useCargoSensor && hal.has('cargo-load');
  const payloadKg = sensed ? hal.read('cargo-load').payloadKg : ASSUMED_PAYLOAD_KG;

  return {
    estimate: estimateRange({ packVolts, tempC, payloadKg, gradePct, stopsPerKm, healthPct }),
    payload: sensed
      ? measured(payloadKg, 'kg', 'cargo-load sensor')
      : modeled(payloadKg, 'kg', 'fleet-average-assumption', {}),
  };
}
