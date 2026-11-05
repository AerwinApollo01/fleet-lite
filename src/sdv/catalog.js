// Features declare capabilities, never suppliers. Resource figures are illustrative.
export const CATALOG = [
  { id: 'range-forecast', label: 'Route range forecast', requires: ['battery'], cpu: 20, memoryMb: 64 },
  { id: 'battery-health', label: 'Battery health reports', requires: ['battery'], cpu: 10, memoryMb: 32 },
  { id: 'driver-coaching', label: 'Driver efficiency coaching', requires: ['motion'], cpu: 30, memoryMb: 128 },
  { id: 'load-aware-range', label: 'Load-aware range', requires: ['battery', 'cargo-load'], cpu: 40, memoryMb: 128 },
  { id: 'proximity-alert', label: 'Proximity alerts', requires: ['proximity'], cpu: 120, memoryMb: 384, roadmap: true },
];

export const ROADMAP_FEATURE = CATALOG.find((feature) => feature.roadmap);
