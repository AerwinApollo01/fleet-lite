// One vehicle as a system: the parts, how they connect, and what each one is telling us.
import { can, roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { assetHistory, swapPack } from '../scenarios/assets.js';
import { componentReliability, scheduleRepair, STATE, SYSTEMS, vehicleTwin } from '../scenarios/components.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { completeService } from '../scenarios/maintenance.js';
import { readyPacks } from '../scenarios/packs.js';
import { badge, h } from './dom.js';
import { firmwarePanels } from './firmware.js';
import { schematic } from './schematic.js';
import { CONDITION, listNeighbors } from './assets.js';

const SVG = 'http://www.w3.org/2000/svg';
const STATE_BADGE = { fault: ['✕ Fault', 'bad'], watch: ['! Watch', 'warn'], ok: ['✓ Healthy', 'good'], absent: ['Not fitted', 'neutral'] };
const km = (value) => `${value.toLocaleString('en-US')} km`;

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
  let tab = component === 'firmware' ? 'firmware' : 'parts';
  let selected = tab === 'parts' ? component : null;
  let layer = 'All';
  let tierLayer = 'All';
  const fw = { target: null, problem: '', pick: (id) => pick(id) };
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
    if (tab === 'parts') setComponent(id);
    draw();
  }

  function showTab(next) {
    tab = next;
    setComponent(next === 'firmware' ? 'firmware' : selected);
    draw();
  }

  function draw() {
    const twin = vehicleTwin(world, vin);
    fleetParts = componentReliability(world);
    const ranked = twin.components.filter((c) => c.state !== 'absent').sort((a, b) => STATE[a.state].rank - STATE[b.state].rank);
    if (tab === 'parts' && (!selected || !twin.components.some((c) => c.id === selected))) selected = ranked[0].id;
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
      h('div', { class: 'tw-tabs', role: 'tablist', 'aria-label': 'Vehicle views' },
        [['parts', 'Parts'], ['firmware', 'Firmware']].map(([id, label]) => h('button', {
          role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', class: id === tab ? 'active' : '', onClick: () => showTab(id),
        }, label))),
      tab === 'parts' ? partsLayout(twin, flagged) : firmwareLayout(twin),
      strip,
    ].filter(Boolean));
    if (tab === 'parts') {
      drawStrip(twin);
      drawInspector(twin);
    }
  }

  function diagram(twin, dimmed) {
    const svg = schematic(twin, pick);
    svg.querySelectorAll('[data-c]').forEach((g) => {
      g.classList.toggle('picked', g.dataset.c === selected);
      g.classList.toggle('dim', dimmed(g));
    });
    return svg;
  }

  function partsLayout(twin, flagged) {
    return h('div', { class: 'tw-layout' },
      h('section', { class: 'panel tw-main' },
        h('div', { class: 'toolbar tight' },
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Highlight a system' },
            ['All', ...SYSTEMS].map((name) => h('button', {
              class: name === layer ? 'active' : '', 'aria-pressed': name === layer ? 'true' : 'false',
              onClick: () => { layer = name; draw(); },
            }, name))),
          h('span', { class: 'tw-key' }, h('span', {}, h('i', { class: 'wire can' }), 'Data (CAN)'), h('span', {}, h('i', { class: 'wire power' }), 'High voltage')),
        ),
        diagram(twin, (g) => layer !== 'All' && g.dataset.system !== layer),
        h('p', { class: 'muted small' }, flagged.length
          ? `${flagged.length} part${flagged.length === 1 ? '' : 's'} need${flagged.length === 1 ? 's' : ''} attention. Choose any part to inspect it.`
          : 'Every fitted part is healthy. Choose any part to inspect it.'),
      ),
      inspector,
    );
  }

  function firmwareLayout(twin) {
    const panels = firmwarePanels({ world, vin, ui: fw, selected, refresh: draw });
    const mapped = {
      ...twin,
      components: twin.components.map((part) => ({ ...part, ...(panels.states[part.id] ?? { state: 'absent', stateLabel: part.state === 'absent' ? 'Not fitted' : 'No over-the-air firmware' }) })),
    };
    const tiers = [['All', 'All'], ['system', 'System'], ['domain', 'Subsystem'], ['component', 'Component']];
    strip.replaceChildren(...panels.below);
    return h('div', { class: 'tw-layout' },
      h('section', { class: 'panel tw-main' },
        h('div', { class: 'toolbar tight' },
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Highlight a firmware level' },
            tiers.map(([id, name]) => h('button', {
              class: id === tierLayer ? 'active' : '', 'aria-pressed': id === tierLayer ? 'true' : 'false',
              onClick: () => { tierLayer = id; draw(); },
            }, name))),
          h('span', { class: 'tw-key' }, h('span', {}, '! Will change'), h('span', {}, '– No OTA firmware')),
        ),
        diagram(mapped, (g) => tierLayer !== 'All' && panels.tierOf[g.dataset.c] !== tierLayer),
        h('p', { class: 'muted small' }, 'Updates enter through the gateway. The vehicle computer passes them along to each part.'),
      ),
      panels.side,
    );
  }

  function drawStrip(twin) {
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
  }

  root.replaceChildren(stage);
  draw();
}
