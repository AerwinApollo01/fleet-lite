// One vehicle as a system: the parts, how they connect, and what each one is telling us.
import { can, roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { assetHistory, swapPack } from '../scenarios/assets.js';
import { componentReliability, scheduleRepair, STATE, SYSTEMS, vehicleTwin } from '../scenarios/components.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { completeService } from '../scenarios/maintenance.js';
import { readyPacks } from '../scenarios/packs.js';
import { badge, h } from './dom.js';
import { CONDITION, listNeighbors } from './assets.js';

const SVG = 'http://www.w3.org/2000/svg';
const STATE_BADGE = { fault: ['✕ Fault', 'bad'], watch: ['! Watch', 'warn'], ok: ['✓ Healthy', 'good'], absent: ['Not fitted', 'neutral'] };
const GLYPH = { fault: '✕', watch: '!', ok: '✓', absent: '–' };
const km = (value) => `${value.toLocaleString('en-US')} km`;

// x, y, width, height, then where the name goes. Front of the vehicle is on the right.
const PARTS = {
  pack: { box: [336, 262, 184, 40], label: 'Battery pack' },
  bms: { box: [270, 262, 56, 40], label: 'BMS' },
  charger: { box: [84, 214, 92, 34], label: 'Charger' },
  inverter: { box: [392, 318, 92, 34], label: 'Controller' },
  motor: { box: [296, 318, 84, 34], label: 'Motor' },
  cargo: { box: [300, 222, 220, 24], label: 'Cargo load sensor' },
  vcu: { box: [566, 206, 96, 36], label: 'Computer' },
  gateway: { box: [576, 64, 104, 28], label: 'Gateway' },
  position: { box: [478, 64, 88, 28], label: 'Position' },
  motion: { box: [566, 262, 96, 30], label: 'Motion' },
  proximity: { box: [802, 252, 44, 62], label: 'Prox.' },
};
const WHEELS = { tires: { cx: 198, cy: 352, r: 60, label: 'Tires' }, brakes: { cx: 710, cy: 352, r: 60, label: 'Brakes' } };

const WIRES = {
  can: 'M130 214 V186 H614 M298 262 V186 M430 318 V310 H540 V186 M614 206 V186 M614 262 V242 M628 92 V186 M522 92 V186 M410 222 V186 M824 252 V186 H614',
  power: 'M326 282 H336 M176 236 H284 V262 M438 302 V318 M380 335 H392 M296 335 H258',
};

function schematic(twin, onPick) {
  const stateOf = (id) => twin.components.find((c) => c.id === id);
  const node = (id, inner) => {
    const part = stateOf(id);
    return `<g class="tw-node ${part.state}" data-c="${id}" data-system="${part.system}" tabindex="0" role="button" aria-label="${part.label}: ${STATE[part.state].label}">${inner}</g>`;
  };
  const boxes = Object.entries(PARTS).map(([id, { box: [x, y, w, height], label }]) => {
    const state = stateOf(id).state;
    return node(id, `<rect class="tw-hit" x="${x}" y="${y}" width="${w}" height="${height}" rx="6"/>
      <text class="tw-label" x="${x + w / 2}" y="${y + height / 2 + 4}" text-anchor="middle">${state === 'ok' ? '' : `${GLYPH[state]} `}${label}</text>`);
  }).join('');
  const wheels = Object.entries(WHEELS).map(([id, { cx, cy, r, label }]) => {
    const state = stateOf(id).state;
    const inner = id === 'tires'
      ? `<circle class="tw-hit tw-ring" cx="${cx}" cy="${cy}" r="${r - 7}"/><circle class="tw-hub" cx="${cx}" cy="${cy}" r="${r - 30}"/>`
      : `<circle class="tw-tyre" cx="${cx}" cy="${cy}" r="${r - 7}"/><circle class="tw-hit" cx="${cx}" cy="${cy}" r="${r - 22}"/>`;
    return node(id, `${inner}<text class="tw-label" x="${cx}" y="${cy + 4}" text-anchor="middle">${state === 'ok' ? '' : `${GLYPH[state]} `}${label}</text>`);
  }).join('');
  const wrap = h('div', { class: twin.stale ? 'tw-stage stale' : 'tw-stage' });
  wrap.innerHTML = `<svg xmlns="${SVG}" viewBox="40 30 840 390" role="group" aria-label="Diagram of ${twin.vin}. Choose a part to inspect it.">
    <path class="tw-body" d="M70 170 Q70 54 106 54 H560 Q640 54 690 92 L770 178 Q842 190 852 226 V318 H776 A68 68 0 0 0 644 318 H264 A68 68 0 0 0 132 318 H70 Z"/>
    <path class="tw-glass" d="M640 112 Q652 112 664 122 L730 186 H640 Z"/>
    <path class="tw-floor" d="M70 254 H560"/>
    <line class="tw-ground" x1="60" y1="414" x2="860" y2="414"/>
    <path class="tw-wire can" d="${WIRES.can}"/>
    <path class="tw-wire power" d="${WIRES.power}"/>
    ${wheels}${boxes}
  </svg>`;
  const pick = (target) => { const g = target.closest('[data-c]'); if (g) onPick(g.dataset.c); };
  wrap.addEventListener('click', (event) => pick(event.target));
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(event.target); }
  });
  return wrap;
}

function sparkline(signal) {
  const [W, H, PAD] = [320, 96, 6];
  const values = signal.points.map((p) => p.value);
  const lo = Math.min(...values, signal.limit);
  const hi = Math.max(...values, signal.limit);
  const span = hi - lo || 1;
  const x = (i) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const unit = signal.unit === '%' || signal.unit === '°C' ? signal.unit : signal.unit ? ` ${signal.unit}` : '';
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const chart = h('div', { class: 'spark' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  chart.innerHTML = `<svg xmlns="${SVG}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${signal.label} over 30 days, now ${values.at(-1)}${unit}, limit ${signal.limit}${unit}">
    <line class="spark-limit" x1="${PAD}" x2="${W - PAD}" y1="${y(signal.limit)}" y2="${y(signal.limit)}"/>
    <path class="spark-line" d="${line}"/>
    <circle class="spark-end" cx="${x(values.length - 1)}" cy="${y(values.at(-1))}" r="4"/>
    <circle class="spark-hover" r="4" hidden/>
  </svg>`;
  chart.append(tip);
  const dot = chart.querySelector('.spark-hover');
  chart.addEventListener('mousemove', (event) => {
    const box = chart.getBoundingClientRect();
    const i = Math.max(0, Math.min(values.length - 1, Math.round(((event.clientX - box.left) / box.width) * (values.length - 1))));
    const point = signal.points[i];
    dot.removeAttribute('hidden');
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(point.value));
    tip.hidden = false;
    tip.replaceChildren(h('strong', {}, `${point.value}${unit}`), h('span', {}, point.ago === 0 ? 'Latest' : `${point.ago} day${point.ago === 1 ? '' : 's'} ago`));
    tip.style.left = `${Math.min(event.clientX - box.left + 10, box.width - tip.offsetWidth - 2)}px`;
    tip.style.top = '4px';
  });
  chart.addEventListener('mouseleave', () => { tip.hidden = true; dot.setAttribute('hidden', ''); });
  return h('div', {},
    h('div', { class: 'spark-head' },
      h('span', {}, signal.label, ' ', badge(signal.provenance === 'measured' ? 'Measured' : 'Estimate', signal.provenance === 'measured' ? 'neutral' : 'warn')),
      h('strong', {}, `${values.at(-1)}${unit}`)),
    chart,
    h('div', { class: 'spark-axis muted' }, h('span', {}, '30 days ago'), h('span', {}, `Dashed line: ${signal.lowerIsWorse ? 'replace at' : 'limit'} ${signal.limit}${unit}`), h('span', {}, 'Latest')),
  );
}

export function mountTwin(root, { world, vin, component, openAsset, closeAsset, setComponent }) {
  let selected = component;
  let layer = 'All';
  const stage = h('div', {});
  const inspector = h('aside', { class: 'tw-inspector', 'aria-label': 'Part details' });
  const strip = h('div', { class: 'tw-strip' });
  let fleetParts = [];

  function act(fn) { fn(); draw(); }

  function actions(part, twin) {
    const role = roleOf(world);
    if (part.state === 'absent') return null;
    const ready = readyPacks(world);
    const list = [];
    if (part.id === 'vcu' && twin.faulted) list.push(h('p', { class: 'callout warn' }, 'This is a software fault, so the fix is a rollback from Software rollouts, not a repair.'));
    if (part.id === 'pack' && can(role, 'pack.swap')) {
      if (!twin.online) list.push(h('p', { class: 'callout warn' }, 'This vehicle has no signal, so a battery swap can’t be confirmed.'));
      else if (ready.length) list.push(h('button', { class: part.state === 'ok' ? '' : 'primary', onClick: () => act(() => swapPack(world, vin, ready[0].id)) }, `Swap battery to ${ready[0].id}`));
    }
    if (part.order) {
      list.push(h('p', {}, badge(`Work order #${part.order.id} open`)));
      if (can(role, 'service.complete')) list.push(h('button', { class: 'primary', onClick: () => act(() => completeService(world, part.order.id)) }, 'Mark repair done'));
    } else if (part.state !== 'ok' && can(role, 'service.schedule') && (part.openFaults > 0 || !['vcu', 'pack'].includes(part.id))) {
      list.push(h('button', { class: 'primary', onClick: () => act(() => scheduleRepair(world, vin, part.id)) }, part.state === 'fault' ? 'Schedule repair' : 'Schedule inspection'));
    }
    return list.length ? h('div', { class: 'tw-actions' }, list) : null;
  }

  function reliability(part, twin) {
    const fleet = fleetParts.find((item) => item.id === part.id);
    const rows = [['This vehicle', `${part.failures} failure${part.failures === 1 ? '' : 's'} in ${km(twin.odometer)}`]];
    rows.push(['Fleet average', fleet.mtbfKm ? `1 per ${km(fleet.mtbfKm)}` : 'No failures yet']);
    return h('div', {},
      h('p', { class: 'label' }, 'Reliability'),
      h('dl', { class: 'facts' }, rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
      fleet.finding && h('p', { class: 'muted small' }, `Across the fleet, ${fleet.finding.label} fails ${fleet.finding.timesRest}× as often as the rest.`),
    );
  }

  function faultList(part) {
    if (!part.faults.length) return h('p', { class: 'muted' }, 'No faults recorded.');
    return h('ol', { class: 'timeline compact' }, part.faults.slice(0, 8).map((fault) => h('li', {},
      h('span', { class: 'muted' }, `${fault.code} · ${fault.daysAgo === 0 ? 'today' : `${fault.daysAgo} days ago`} · ${km(fault.km)}`),
      h('p', {}, fault.title, ' ', fault.open ? badge(...(fault.severity === 'fault' ? ['Open', 'bad'] : ['Open', 'warn'])) : badge(fault.repaired ? 'Repaired' : 'Closed')),
    )));
  }

  function drawInspector(twin) {
    const part = twin.components.find((c) => c.id === selected);
    inspector.replaceChildren(...[
      h('div', { class: 'tw-inspector-head' }, h('h3', {}, part.label), badge(...STATE_BADGE[part.state])),
      h('p', { class: 'muted' }, part.does),
      part.state !== 'ok' && h('p', { class: 'tw-reason' }, part.reason),
      part.state !== 'absent' && actions(part, twin),
      part.packId && h('p', { class: 'muted small' }, `Installed pack: ${part.packId}`),
      part.signal && sparkline(part.signal),
      part.state !== 'absent' && h('p', { class: 'label' }, 'Fault history'),
      part.state !== 'absent' && faultList(part),
      part.state !== 'absent' && reliability(part, twin),
      part.dependents.length > 0 && h('div', {},
        h('p', { class: 'label' }, 'If this part fails, these stop'),
        h('ul', { class: 'guide-list' }, part.dependents.map((name) => h('li', {}, name)))),
    ].filter(Boolean));
  }

  function pick(id) {
    selected = id;
    setComponent(id);
    draw();
  }

  function draw() {
    const twin = vehicleTwin(world, vin);
    fleetParts = componentReliability(world);
    const ranked = twin.components.filter((c) => c.state !== 'absent').sort((a, b) => STATE[a.state].rank - STATE[b.state].rank);
    if (!selected || !twin.components.some((c) => c.id === selected)) selected = ranked[0].id;
    const around = listNeighbors(vin);
    const flagged = ranked.filter((c) => c.state === 'fault' || c.state === 'watch');

    stage.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('button', { class: 'link back', onClick: closeAsset }, '← Assets'),
          h('div', { class: 'tw-title' }, h('h2', {}, vin), badge(...(CONDITION[twin.state])), twin.online ? '' : badge('No signal')),
          h('p', { class: 'muted' }, `${twin.depot} depot · ${twin.hardware} · ${twin.supplier} · Firmware ${twin.firmware} · ${km(twin.odometer)}`),
        ),
        h('div', { class: 'toolbar end' },
          around && h('span', { class: 'muted' }, `${(around.index + 1).toLocaleString('en-US')} of ${around.total.toLocaleString('en-US')} in your list`),
          around && h('button', { disabled: !around.previous, 'aria-label': 'Previous vehicle', onClick: () => openAsset(around.previous) }, '‹'),
          around && h('button', { disabled: !around.next, 'aria-label': 'Next vehicle', onClick: () => openAsset(around.next) }, '›'),
          h('button', { onClick: () => { advanceFleet(world, 24); draw(); } }, '+1 day'),
        ),
      ),
      twin.stale && h('p', { class: 'callout warn' }, `No signal. This is what ${vin} last reported, ${twin.reportedAgoMin} minutes ago. Anything since then isn’t shown.`),
      twin.drift.length > 0 && h('p', { class: 'callout neutral' }, `Waiting to sync: the cloud and this vehicle disagree on ${twin.drift.length} setting${twin.drift.length === 1 ? '' : 's'}.`),
      h('div', { class: 'tw-layout' },
        h('section', { class: 'panel tw-main' },
          h('div', { class: 'toolbar tight' },
            h('div', { class: 'segmented', role: 'group', 'aria-label': 'Highlight a system' },
              ['All', ...SYSTEMS].map((name) => h('button', {
                class: name === layer ? 'active' : '', 'aria-pressed': name === layer ? 'true' : 'false',
                onClick: () => { layer = name; draw(); },
              }, name))),
            h('span', { class: 'tw-key' }, h('span', {}, h('i', { class: 'wire can' }), 'Data (CAN)'), h('span', {}, h('i', { class: 'wire power' }), 'High voltage')),
          ),
          (() => {
            const svg = schematic(twin, pick);
            svg.querySelectorAll('[data-c]').forEach((g) => {
              g.classList.toggle('picked', g.dataset.c === selected);
              g.classList.toggle('dim', layer !== 'All' && g.dataset.system !== layer);
            });
            return svg;
          })(),
          h('p', { class: 'muted small' }, flagged.length
            ? `${flagged.length} part${flagged.length === 1 ? '' : 's'} need${flagged.length === 1 ? 's' : ''} attention. Choose any part to inspect it.`
            : 'Every fitted part is healthy. Choose any part to inspect it.'),
        ),
        inspector,
      ),
      strip,
    ].filter(Boolean));

    strip.replaceChildren(
      h('section', { class: 'panel' },
        h('h3', {}, 'All parts'),
        h('div', { class: 'tw-systems' }, SYSTEMS.map((system) => h('div', {},
          h('p', { class: 'label' }, system),
          twin.components.filter((c) => c.system === system).map((c) => h('button', {
            class: c.id === selected ? 'tw-part active' : 'tw-part', 'aria-pressed': c.id === selected ? 'true' : 'false', onClick: () => pick(c.id),
          }, h('span', {}, c.label), badge(...STATE_BADGE[c.state]))),
        ))),
      ),
      h('section', { class: 'panel' },
        h('h3', {}, 'Vehicle history'),
        (() => {
          const events = assetHistory(world, vin);
          return events.length
            ? h('ol', { class: 'timeline compact' }, events.map((event) => h('li', {}, h('span', { class: 'muted' }, formatTime(event.at)), h('p', {}, event.text))))
            : h('p', { class: 'muted' }, 'Nothing recorded since the simulation started.');
        })(),
      ),
    );
    drawInspector(twin);
  }

  root.replaceChildren(stage);
  draw();
}
