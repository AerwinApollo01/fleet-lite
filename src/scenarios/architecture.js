// The system as one map. Each node reports live state, and each trace follows a real path.
import { versionInventory } from '../core/ota.js';
import { formatTime } from '../core/time.js';
import { drift } from '../sdv/twin.js';
import { HARDWARE } from '../sdv/hardware.js';
import { cautiousKm, operationsView, POLICY, routeRow, STATUS, supplierLabel } from './operations.js';
import { rolloutActive } from './fleet.js';

export const COLUMNS = [
  { id: 'vehicle', label: 'On the vehicle', note: 'Keeps working with no signal' },
  { id: 'link', label: 'Connection', note: 'Offline is the normal case' },
  { id: 'cloud', label: 'Cloud platform', note: 'Decides, and keeps the record' },
  { id: 'surface', label: 'What people see', note: 'One pipeline, two surfaces' },
];

export const NODES = [
  { id: 'hardware', column: 'vehicle', title: 'Hardware and sensors', text: 'Fixed at manufacture, with limits software can’t cross', ref: 'AD-3, AD-5' },
  { id: 'hal', column: 'vehicle', title: 'Abstraction layer', text: 'Turns each supplier’s format into one contract', ref: 'AD-1' },
  { id: 'apps', column: 'vehicle', title: 'Vehicle apps', text: 'Features that run if the vehicle can host them', ref: 'AD-2' },
  { id: 'local', column: 'vehicle', title: 'Local state', text: 'Last known good config and driver leases', ref: 'AD-4' },
  { id: 'sync', column: 'link', title: 'Sync and store-and-forward', text: 'Buffers while offline, then reconciles', ref: 'AD-4' },
  { id: 'identity', column: 'cloud', title: 'Identity and tenancy', text: 'Who owns each vehicle, and when', ref: 'R1–R2' },
  { id: 'entitlement', column: 'cloud', title: 'Entitlements', text: 'What each vehicle is allowed to run', ref: 'AD-2' },
  { id: 'twin', column: 'cloud', title: 'Vehicle twin', text: 'Desired state vs. reported state', ref: 'AD-4' },
  { id: 'rollout', column: 'cloud', title: 'Rollout campaigns', text: 'Stages, gates, halt, and rollback', ref: 'AD-6' },
  { id: 'ingest', column: 'cloud', title: 'Ingest and raw store', text: 'Immutable, except location', ref: 'R3, R12' },
  { id: 'model', column: 'cloud', title: 'Range model and claim policy', text: 'Turns an estimate into a decision', ref: 'R10–R11' },
  { id: 'operator', column: 'surface', title: 'Operator app', text: 'One decision per route', ref: 'R20' },
  { id: 'internal', column: 'surface', title: 'Internal console', text: 'Raw values, intervals, and versions', ref: 'R10' },
];

export const EDGES = [
  ['hardware', 'hal'], ['hal', 'apps'], ['apps', 'local'], ['apps', 'sync'], ['local', 'sync'],
  ['sync', 'ingest'], ['sync', 'twin'], ['sync', 'identity'],
  ['identity', 'entitlement'], ['entitlement', 'twin'], ['rollout', 'twin'], ['ingest', 'model'],
  ['model', 'operator'], ['model', 'internal'], ['twin', 'operator'], ['twin', 'internal'], ['rollout', 'internal'],
];

export const TRACES = [
  { id: 'claim', label: 'Route forecast', path: ['hardware', 'hal', 'apps', 'sync', 'ingest', 'model', 'operator'] },
  { id: 'rollout', label: 'Feature rollout', path: ['rollout', 'twin', 'sync', 'local', 'apps', 'operator'] },
  { id: 'release', label: 'Feature release', path: ['entitlement', 'twin', 'sync', 'local', 'apps', 'operator'] },
  { id: 'driver', label: 'Driver access', path: ['identity', 'sync', 'local', 'hardware'] },
];

export function nodeStats(world) {
  const view = operationsView(world);
  const { fleet } = world;
  const count = (test) => fleet.filter(test).length;
  const lean = count((v) => v.hardwareRev === 'lean');
  const versions = Object.keys(versionInventory(fleet)).length;
  return {
    hardware: `${lean} lean, ${fleet.length - lean} headroom`,
    hal: `${count((v) => v.supplier === 'alpha')} Alpha, ${count((v) => v.supplier === 'bravo')} Bravo`,
    apps: `${fleet.reduce((sum, v) => sum + v.reported.installed.length, 0)} installed across the fleet`,
    local: `${count((v) => !v.online)} running on local state`,
    sync: `${count((v) => v.online)} of ${fleet.length} connected`,
    identity: `${fleet.length} vehicles, 1 operator`,
    ingest: 'Event time, not arrival time',
    twin: `${count((v) => drift(v).length > 0)} with drift`,
    entitlement: `${fleet.reduce((sum, v) => sum + v.reported.entitled.length, 0)} active grants`,
    rollout: world.campaign ? `${world.rollout.label}: ${rolloutActive(world) ? 'in progress' : 'finished'}` : 'None running',
    model: `Policy owner: ${POLICY.owner}`,
    operator: `${view.needsDecision} decisions waiting`,
    internal: `${versions} firmware version${versions === 1 ? '' : 's'} in the field`,
  };
}

const km = (value) => `${value.toFixed(1)} km`;

export function traceSteps(world, traceId, routeId) {
  const row = routeRow(world, routeId);
  const { vehicle, route, estimate } = row;
  const { p10, p50, p90 } = estimate.rangeKm.interval;

  if (traceId === 'claim') {
    return [
      { node: 'hardware', kind: 'measured', text: `${supplierLabel(vehicle)} battery reports in its own format`, value: JSON.stringify(row.raw, (key, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)) },
      { node: 'hal', kind: 'measured', text: 'The abstraction layer converts it to the contract', value: `${row.reading.packVolts.toFixed(1)} V, ${row.reading.tempC.toFixed(1)} °C` },
      { node: 'apps', kind: row.payload.provenance, text: row.payload.provenance === 'measured' ? 'Load-aware range reads the cargo sensor' : 'No active load feature, so load is an assumption', value: `${row.payload.value} kg` },
      { node: 'sync', kind: 'fact', text: vehicle.online ? 'Connected, so the data is current' : 'No signal, so this is the last known data', value: vehicle.online ? 'Just now' : `${row.lastSeenMin} min old` },
      { node: 'ingest', kind: 'fact', text: 'Stored raw, and attributed by event time', value: `${vehicle.vin} at ${formatTime(world.now)}` },
      { node: 'model', kind: 'modeled', text: `Range estimate from ${estimate.rangeKm.modelVersion}`, value: `${km(p10)} to ${km(p90)}, median ${km(p50)}` },
      { node: 'model', kind: 'policy', text: `The policy takes the cautious end, minus a ${POLICY.reserveKm} km reserve`, value: `${km(cautiousKm(row))} against ${km(row.kmRemaining)} left` },
      { node: 'operator', kind: 'claim', text: 'The operator sees one decision, not the interval', value: STATUS[row.status].label },
    ];
  }
  if (traceId === 'rollout') {
    return [
      { node: 'rollout', kind: 'fact', text: 'A campaign picks the vehicles that can host the feature', value: 'Stages: 10%, 30%, 100%' },
      { node: 'twin', kind: 'fact', text: 'The campaign changes desired state for that vehicle', value: `${vehicle.vin}: generation ${vehicle.desired.generation}` },
      { node: 'sync', kind: 'fact', text: 'It lands off shift, when the vehicle is reachable', value: vehicle.online ? 'Reachable now' : 'No signal' },
      { node: 'local', kind: 'fact', text: 'The vehicle checks limits, then applies it whole or not at all', value: `Reported generation ${vehicle.reported.generation}` },
      { node: 'apps', kind: 'fact', text: 'Installed, but dark until it’s entitled', value: `${vehicle.reported.installed.length} installed` },
      { node: 'operator', kind: 'claim', text: 'The operator sees nothing change yet', value: 'No route affected' },
    ];
  }
  if (traceId === 'release') {
    return [
      { node: 'entitlement', kind: 'fact', text: 'A feature is released to this vehicle', value: `${vehicle.reported.entitled.length} entitled` },
      { node: 'twin', kind: 'fact', text: 'Desired state gains the entitlement', value: `${drift(vehicle).length} pending change${drift(vehicle).length === 1 ? '' : 's'}` },
      { node: 'sync', kind: 'fact', text: 'It can land at any time, even on shift', value: vehicle.online ? 'Reachable now' : 'Queued until it reconnects' },
      { node: 'local', kind: 'fact', text: 'The vehicle updates its local state', value: 'Last known good until then' },
      { node: 'apps', kind: 'fact', text: 'The resolver turns the feature on', value: `${row.capabilities.active.length} active` },
      { node: 'operator', kind: 'claim', text: 'The operator’s decisions improve', value: row.payload.provenance === 'measured' ? 'Using measured load' : 'Using assumed load' },
    ];
  }
  return [
    { node: 'identity', kind: 'fact', text: 'The cloud decides who may drive for this operator', value: route.driver },
    { node: 'sync', kind: 'fact', text: 'A short lease goes to the vehicle on each sync', value: vehicle.online ? 'Lease refreshed' : 'Lease not refreshed' },
    { node: 'local', kind: 'fact', text: 'The vehicle caches it, so a 5am start needs no signal', value: 'Decided on the vehicle' },
    { node: 'hardware', kind: 'claim', text: 'The vehicle starts, or it doesn’t', value: `Hardware: ${HARDWARE[vehicle.hardwareRev].label}` },
  ];
}
