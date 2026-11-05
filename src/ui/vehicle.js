import { formatTime } from '../core/time.js';
import { canStart, resetFleet, ROLLOUTS, rolloutActive, startRollout } from '../scenarios/fleet.js';
import { runRangeApp } from '../sdv/apps.js';
import { CATALOG } from '../sdv/catalog.js';
import { BATTERY_SUPPLIERS, createHal } from '../sdv/hal.js';
import { DEFAULT_CONFIG, ENVELOPE, HARDWARE } from '../sdv/hardware.js';
import { canHost, REASONS, resolveCapabilities } from '../sdv/resolver.js';
import { assess } from '../sdv/scorecard.js';
import { drift, reconcile, setDesired } from '../sdv/twin.js';
import { badge, h, panel, table } from './dom.js';

const PLANT = { packVolts: 49, tempC: 8, payloadKg: 140 };
const ROUTE = { gradePct: 1, stopsPerKm: 3 };
const STATE_TONE = { active: 'good', 'hardware-missing': 'bad', 'over-budget': 'bad' };
const LABELS = { installed: 'Feature install', entitled: 'Entitlements' };

const toggled = (list, id, on) => (on ? [...list, id] : list.filter((item) => item !== id));

function meter(label, used, total, unit) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-label' }, h('span', {}, label), h('span', { class: 'muted' }, `${used} of ${total} ${unit}`)),
    h('div', { class: 'meter-track', role: 'img', 'aria-label': `${label}: ${percent}% used` },
      h('span', { style: `width:${percent}%` })),
  );
}

function segmented(label, options, current, onPick) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      class: value === current ? 'active' : '',
      'aria-pressed': value === current ? 'true' : 'false',
      onClick: () => onPick(value),
    }, text)));
}

// Outlives the tab, so moving to Software rollouts and back keeps the same vehicle in view.
const selection = { hardwareRev: 'lean', supplier: 'alpha' };

export function mountVehicle(root, { world, goTo }) {
  let message = null;

  // The hardware and supplier controls pick a real vehicle out of the shared fleet.
  const current = () => world.fleet.find((v) => v.hardwareRev === selection.hardwareRev && v.supplier === selection.supplier);

  // Entitlement and config are per-vehicle cloud changes. Installs only come from a rollout.
  function change(patch) {
    const twin = current();
    message = null;
    try {
      setDesired(twin, patch);
      const result = reconcile(twin, world.now);
      if (result.reason === 'offline') message = { tone: 'warn', text: 'Queued. The vehicle keeps running its last known good state until it reconnects.' };
    } catch (error) {
      message = { tone: 'warn', text: `Rejected by the cloud: ${error.message}.` };
    }
    render();
  }

  function setOnline(online) {
    const twin = current();
    twin.pinnedOffline = !online;
    twin.online = online;
    message = null;
    if (online) reconcile(twin, world.now);
    render();
  }

  function deployCell(feature, twin) {
    if (twin.reported.installed.includes(feature.id)) return badge('Installed', 'good');
    if (twin.desired.installed.includes(feature.id)) return badge('On its way', 'warn');
    const fit = canHost(twin, feature);
    if (fit.reason === 'hardware-missing') return h('span', { class: 'muted' }, '—');
    if (!fit.ok) return h('span', { class: 'muted' }, 'Won’t fit');
    const rollout = ROLLOUTS.find((r) => r.featureId === feature.id);
    if (!rollout) return h('span', { class: 'muted' }, '—');
    if (rolloutActive(world)) return h('button', { onClick: () => goTo('ota') }, 'View rollout');
    return h('button', {
      disabled: !canStart(world, rollout),
      onClick: () => { startRollout(world, rollout.id); goTo('ota'); },
    }, 'Start rollout');
  }

  function featureRow(feature, twin) {
    return [
      h('span', {}, feature.label, feature.roadmap && ' ', feature.roadmap && badge('Roadmap')),
      `${feature.cpu} / ${feature.memoryMb}`,
      deployCell(feature, twin),
      h('input', {
        type: 'checkbox',
        checked: twin.desired.entitled.includes(feature.id),
        'aria-label': `Entitle ${feature.label}`,
        onChange: (event) => change({ entitled: toggled(twin.desired.entitled, feature.id, event.target.checked) }),
      }),
      badge(REASONS[feature.state], STATE_TONE[feature.state] ?? 'neutral'),
    ];
  }

  function render() {
    const twin = current();
    const now = world.now;
    const hardware = HARDWARE[twin.hardwareRev];
    const resolved = resolveCapabilities(twin);
    const pending = drift(twin);
    const scorecard = assess(twin, now);
    const score = scorecard.filter((c) => c.passed).length;
    const hal = createHal({ hardware, supplier: twin.supplier, plant: PLANT });
    const reading = hal.read('battery');
    const range = runRangeApp(hal, ROUTE);
    const assist = twin.desired.config['motor.assistLimitKph'];
    const charge = twin.desired.config['charge.maxSocPct'];

    const sections = [
      h('div', { class: 'intro' },
        h('h2', {}, 'The parts decide what it could do'),
        h('p', {}, 'Software decides what it does, again and again, after delivery. Pick a vehicle from the fleet, then see what it can do and what it actually runs.'),
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'label inline' }, 'Hardware'),
        segmented('Hardware revision', Object.values(HARDWARE).map((hw) => [hw.id, hw.label]), selection.hardwareRev, (rev) => { selection.hardwareRev = rev; message = null; render(); }),
        h('span', { class: 'label inline' }, 'Battery'),
        segmented('Battery supplier', Object.entries(BATTERY_SUPPLIERS).map(([id, s]) => [id, s.label]), selection.supplier, (id) => { selection.supplier = id; message = null; render(); }),
        h('span', { class: 'label inline' }, 'Vehicle'),
        segmented('Connection', [[true, 'Connected'], [false, 'No signal']], !twin.pinnedOffline, setOnline),
        h('button', { onClick: () => { resetFleet(world); message = null; render(); } }, 'Reset fleet'),
        h('span', { class: 'status' }, `${twin.vin} · ${formatTime(now)}`),
      ),
      message && h('p', { class: `callout ${message.tone}` }, message.text),
      twin.reported.rejected && h('p', { class: 'callout warn' }, twin.reported.rejected.errors.join('; ')),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Generation on vehicle'), h('strong', {}, twin.reported.generation)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Active features'), h('strong', {}, `${resolved.active.length} of ${CATALOG.length}`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Drift'),
          pending.length ? badge(`${pending.length} pending`, 'warn') : badge('In sync', 'good')),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Software-defined tests'), h('strong', {}, `${score} of ${scorecard.length}`)),
      ),
      h('div', { class: 'grid wide' },
        panel('Capability, resolved at runtime',
          table(['Feature', 'CPU / MB', 'Deploy', 'Entitle', 'On the vehicle'], resolved.features.map((f) => featureRow(f, twin))),
          pending.length > 0 && h('p', { class: 'muted small' },
            `Waiting to reach the vehicle: ${pending.map((key) => LABELS[key] ?? ENVELOPE[key]?.label ?? key).join(', ')}.`),
        ),
        panel('Hardware capacity',
          meter('App compute', resolved.used.cpu, resolved.budget.cpu, 'units'),
          meter('App memory', resolved.used.memoryMb, resolved.budget.memoryMb, 'MB'),
          h('p', { class: 'muted small' }, `BOM delta: +$${hardware.bomDeltaUsd} per vehicle (assumed). Sensors: ${hardware.capabilities.join(', ')}.`),
        ),
      ),
      h('div', { class: 'grid two' },
        panel('Software-defined scorecard',
          h('ul', { class: 'checks' }, scorecard.map((c) => h('li', {},
            badge(c.passed ? 'Pass' : 'Not yet', c.passed ? 'good' : 'warn'),
            h('div', {}, h('strong', {}, c.label), h('p', { class: 'muted' }, c.evidence))))),
        ),
        panel('Abstraction layer',
          table(['Layer', 'Output'], [
            [BATTERY_SUPPLIERS[twin.supplier].label, h('code', {}, JSON.stringify(hal.rawBattery()))],
            ['HAL contract', h('code', {}, `${reading.packVolts.toFixed(1)} V, ${reading.tempC.toFixed(1)} °C`)],
            ['Range app (P50)', `${range.estimate.rangeKm.value.toFixed(1)} km`],
            ['Payload input', h('span', {}, `${range.payload.value} kg `, badge(range.payload.provenance === 'measured' ? 'Measured' : 'Assumed', range.payload.provenance === 'measured' ? 'good' : 'warn'))],
          ]),
          h('p', { class: 'muted small' }, 'Switch the battery supplier: the raw format changes and the range stays the same.'),
        ),
      ),
      panel('Bound at manufacture',
        table(['Setting', 'Envelope', 'Desired', 'Try it'], [
          [ENVELOPE['motor.assistLimitKph'].label, '10–25 km/h', `${assist} km/h`,
            h('div', { class: 'row-actions' },
              h('button', { onClick: () => change({ config: { 'motor.assistLimitKph': 20 } }) }, 'Set 20'),
              h('button', { onClick: () => change({ config: { 'motor.assistLimitKph': DEFAULT_CONFIG['motor.assistLimitKph'] } }) }, 'Set 25'),
              h('button', { onClick: () => change({ config: { 'motor.assistLimitKph': 40 } }) }, 'Set 40'))],
          [ENVELOPE['charge.maxSocPct'].label, '60–100%', `${charge}%`,
            h('div', { class: 'row-actions' },
              h('button', { onClick: () => change({ config: { 'charge.maxSocPct': 80 } }) }, 'Set 80'),
              h('button', { onClick: () => change({ config: { 'charge.maxSocPct': DEFAULT_CONFIG['charge.maxSocPct'] } }) }, 'Set 90'))],
          [ENVELOPE['brakes.response'].label, 'Locked', 'Hardware',
            h('button', { onClick: () => change({ config: { 'brakes.response': 1 } }) }, 'Try to change')],
        ]),
      ),
      h('p', { class: 'muted small' }, 'This is the same fleet as Software rollouts. All hardware figures are assumptions.'),
    ];
    root.replaceChildren(...sections.filter(Boolean));
  }

  render();
}
