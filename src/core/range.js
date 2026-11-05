// Layer 5. Pack voltage is measured. State of charge is modeled. Range is modeled on top of a
// model. All constants are illustrative assumptions, and the voltage curve is linear on purpose.
export const measured = (value, unit, source) => ({ value, unit, provenance: 'measured', source });

export const modeled = (value, unit, modelVersion, inputs, interval = null) => ({
  value, unit, provenance: 'modeled', modelVersion, inputs, interval,
});

export const MODELS = {
  'range-1.0': { whPerKm: 30, perKg: 0.05, perGradePct: 4, perStopPerKm: 3, coldLossPerDegree: 0.006, sigma: 0.11 },
  'range-1.1': { whPerKm: 30, perKg: 0.05, perGradePct: 4, perStopPerKm: 4.5, coldLossPerDegree: 0.006, sigma: 0.08 },
};

const PACK = { emptyVolts: 42, fullVolts: 54.6, capacityWh: 2000 };
const Z90 = 1.2816;

export function estimateRange(inputs, modelVersion = 'range-1.0') {
  const model = MODELS[modelVersion];
  if (!model) throw new Error(`Unknown model ${modelVersion}`);
  const { packVolts, tempC, payloadKg, gradePct, stopsPerKm } = inputs;

  const soc = Math.min(1, Math.max(0, (packVolts - PACK.emptyVolts) / (PACK.fullVolts - PACK.emptyVolts)));
  const coldLoss = Math.max(0, 20 - tempC) * model.coldLossPerDegree;
  const usableWh = soc * PACK.capacityWh * (1 - coldLoss);
  const whPerKm =
    model.whPerKm + payloadKg * model.perKg + gradePct * model.perGradePct + stopsPerKm * model.perStopPerKm;

  const p50 = usableWh / whPerKm;
  const spread = Z90 * model.sigma;
  const interval = { p10: p50 * (1 - spread), p50, p90: p50 * (1 + spread) };

  return {
    packVolts: measured(packVolts, 'V', 'BMS'),
    tempC: measured(tempC, '°C', 'pack sensor'),
    soc: modeled(soc, 'ratio', modelVersion, { packVolts }),
    rangeKm: modeled(p50, 'km', modelVersion, { ...inputs }, interval),
  };
}

export function createClaimPolicy({ owner, reserveKm = 2 }) {
  if (!owner) throw new Error('Somebody has to own the threshold where data becomes a claim');
  return { owner, reserveKm };
}

// The internal surface shows the interval. The customer surface has to resolve it.
export function routeClaim(estimate, routeKm, policy) {
  const { p10, p90 } = estimate.rangeKm.interval;
  if (p10 - policy.reserveKm >= routeKm) return { status: 'WILL_FINISH', action: 'No action needed' };
  if (p90 < routeKm) return { status: 'WONT_FINISH', action: 'Swap the vehicle before dispatch' };
  return { status: 'AT_RISK', action: 'Charge or shorten the route before dispatch' };
}

// Same inputs, different model: the vehicle did not change, our belief about it did.
export function explainChange(before, after) {
  const sameInputs = JSON.stringify(before.rangeKm.inputs) === JSON.stringify(after.rangeKm.inputs);
  const sameModel = before.rangeKm.modelVersion === after.rangeKm.modelVersion;
  if (sameInputs && !sameModel) return { cause: 'model-change', from: before.rangeKm.modelVersion, to: after.rangeKm.modelVersion };
  if (!sameInputs && sameModel) return { cause: 'vehicle-change' };
  if (sameInputs && sameModel) return { cause: 'no-change' };
  return { cause: 'both-changed' };
}
