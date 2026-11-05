// AD-1. Each supplier speaks its own format. Apps only ever see the contract.
export const CONTRACTS = {
  battery: ['packVolts', 'tempC'],
  'cargo-load': ['payloadKg'],
};

export const BATTERY_SUPPLIERS = {
  alpha: {
    label: 'Supplier Alpha',
    encode: ({ packVolts, tempC }) => ({ pack_mv: Math.round(packVolts * 1000), temp_dc: Math.round(tempC * 10) }),
    decode: (raw) => ({ packVolts: raw.pack_mv / 1000, tempC: raw.temp_dc / 10 }),
  },
  bravo: {
    label: 'Supplier Bravo',
    encode: ({ packVolts, tempC }) => ({ voltage: packVolts, temperature_f: tempC * 1.8 + 32 }),
    decode: (raw) => ({ packVolts: raw.voltage, tempC: (raw.temperature_f - 32) / 1.8 }),
  },
};

function assertContract(capability, reading) {
  for (const field of CONTRACTS[capability]) {
    if (typeof reading[field] !== 'number' || Number.isNaN(reading[field])) {
      throw new Error(`${capability} adapter broke the contract: ${field} is missing`);
    }
  }
  return reading;
}

// `plant` stands in for the physical vehicle.
export function createHal({ hardware, supplier, plant }) {
  const adapter = BATTERY_SUPPLIERS[supplier];
  if (!adapter) throw new Error(`No adapter for supplier ${supplier}`);

  const has = (capability) => hardware.capabilities.includes(capability);
  const rawBattery = () => adapter.encode(plant);

  function read(capability) {
    if (!has(capability)) throw new Error(`This hardware has no ${capability} capability`);
    if (capability === 'battery') return assertContract('battery', adapter.decode(rawBattery()));
    if (capability === 'cargo-load') return assertContract('cargo-load', { payloadKg: plant.payloadKg });
    throw new Error(`No contract for ${capability}`);
  }

  return { has, read, rawBattery };
}
