// A small, real CAN decoder for teaching. Each signal says where it sits and how to convert it,
// which is what a DBC file does for a whole vehicle.
export const SAMPLE_SIGNALS = [
  { name: 'Pack voltage', bytes: [0, 1], scale: 0.01, offset: 0, unit: 'V', decimals: 2 },
  { name: 'Pack temperature', bytes: [2], scale: 1, offset: -40, unit: '°C', decimals: 0 },
  { name: 'State of charge', bytes: [3], scale: 0.5, offset: 0, unit: '%', decimals: 1 },
];

export function parseFrame(text) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { error: 'Enter the frame’s bytes, such as 13 38 3C B4.' };
  if (parts.length > 8) return { error: 'A classic CAN frame carries at most 8 bytes.' };
  if (parts.some((part) => !/^[0-9a-fA-F]{2}$/.test(part))) {
    return { error: 'Each byte needs two hex characters, 0–9 or A–F, separated by spaces.' };
  }
  return { bytes: parts.map((part) => Number.parseInt(part, 16)) };
}

const hex = (byte) => byte.toString(16).toUpperCase().padStart(2, '0');

export function decodeFrame(bytes, signals = SAMPLE_SIGNALS) {
  return signals.map((signal) => {
    if (signal.bytes.some((index) => index >= bytes.length)) {
      return { ...signal, missing: true };
    }
    // Most significant byte first.
    const raw = signal.bytes.reduce((total, index) => total * 256 + bytes[index], 0);
    const value = raw * signal.scale + signal.offset;
    return { ...signal, hex: signal.bytes.map((index) => hex(bytes[index])).join(' '), raw, value: Number(value.toFixed(signal.decimals)) };
  });
}

export function formula(signal) {
  const steps = [];
  if (signal.scale !== 1) steps.push(`× ${signal.scale}`);
  if (signal.offset !== 0) steps.push(signal.offset < 0 ? `− ${Math.abs(signal.offset)}` : `+ ${signal.offset}`);
  return steps.join(' ');
}
