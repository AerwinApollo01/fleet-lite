import { isOnShift } from '../core/ota.js';
import { DAY, formatTime, HOUR } from '../core/time.js';
import { advanceFleet, resetFleet, rolloutActive } from '../scenarios/fleet.js';
import { cautiousKm, explain, operationsView, routeRow, STATUS } from '../scenarios/operations.js';
import { activeZones, swapRoute, undoRouteSwap } from '../scenarios/alerts.js';
import { can, roleOf } from '../core/roles.js';
import { CATALOG } from '../sdv/catalog.js';
import { badge, h, panel } from './dom.js';
import { getFleetMap } from './fleetmap.js';

const TONE = { ON_TRACK: 'good', UNCONFIRMED: 'neutral', NO_FORECAST: 'neutral', AT_RISK: 'warn', WONT_FINISH: 'bad', OUT_OF_SERVICE: 'bad' };
const MARK = { ON_TRACK: 'st-good', UNCONFIRMED: 'st-none', NO_FORECAST: 'st-none', AT_RISK: 'st-warn', WONT_FINISH: 'st-bad', OUT_OF_SERVICE: 'st-bad' };
const BAR_ORDER = ['ON_TRACK', 'UNCONFIRMED', 'NO_FORECAST', 'AT_RISK', 'WONT_FINISH', 'OUT_OF_SERVICE'];
const FILTERS = [
  ['all', 'All routes', () => true],
  ['decide', 'Needs a decision', (r) => ['AT_RISK', 'WONT_FINISH', 'OUT_OF_SERVICE'].includes(r.status)],
  ['signal', 'No signal', (r) => !r.vehicle.online],
  ['swapped', 'Swapped', (r) => r.swapped],
];

// Outlives the tab, so a selection survives a trip to the System map and back.
const ui = { selected: null, filter: 'all', search: '' };

export const selectRoute = (id) => { ui.selected = id; };

const statusBadge = (status) => badge(`${STATUS[status].icon} ${STATUS[status].label}`, TONE[status]);

function statusBar(view) {
  const total = view.rows.length;
  const present = BAR_ORDER.filter((key) => view.counts[key] > 0);
  return h('div', {},
    h('div', { class: 'statusbar', role: 'img', 'aria-label': present.map((k) => `${view.counts[k]} ${STATUS[k].label}`).join(', ') },
      present.map((key) => h('span', {
        class: MARK[key],
        style: `flex-grow:${view.counts[key]}`,
        title: `${STATUS[key].label}: ${view.counts[key]} of ${total}`,
      }))),
    h('div', { class: 'legend' }, present.map((key) => h('span', {},
      h('i', { class: `dot ${MARK[key]}` }), `${STATUS[key].label} `, h('strong', {}, view.counts[key])))),
  );
}

function decisionCard(decision, onSwap, onPick, allowed) {
  const { row, spare, why } = decision;
  return h('li', { class: 'decision' },
    h('div', { class: 'decision-head' }, statusBadge(row.status), h('button', { class: 'link', onClick: () => onPick(row.route.id) }, `${row.route.id} · ${row.route.area}`)),
    h('p', {}, `${row.route.driver}: ${why}`),
    spare
      ? allowed && h('button', { class: 'primary small', onClick: () => onSwap(row.route.id, spare.vin) }, `Swap to ${spare.vin}`)
      : h('p', { class: 'muted small' }, row.claim.action === 'No action needed' ? 'No spare is available. Call the driver.' : `No spare can cover it. ${row.claim.action}.`),
  );
}

function routeTable(view, onPick) {
  const [, , test] = FILTERS.find(([id]) => id === ui.filter);
  const query = ui.search.trim().toLowerCase();
  const rows = view.rows
    .filter(test)
    .filter((r) => !query || `${r.route.id} ${r.route.area} ${r.route.driver} ${r.vehicle.vin}`.toLowerCase().includes(query))
    .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.route.index - b.route.index);

  if (!rows.length) return h('p', { class: 'muted empty' }, 'No routes match.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'routes' },
    h('thead', {}, h('tr', {}, ['Route', 'Area', 'Driver', 'Vehicle', 'Status', 'Progress', 'Battery', 'Last update'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.route.id === ui.selected ? 'on' : '' },
      h('td', {}, h('button', { class: 'link', onClick: () => onPick(r.route.id) }, r.route.id)),
      h('td', {}, r.route.area),
      h('td', {}, r.route.driver),
      h('td', {}, r.vehicle.vin, r.swapped ? ' ' : '', r.swapped ? badge('Swapped') : ''),
      h('td', {}, statusBadge(r.status)),
      h('td', {}, h('div', { class: 'progress', role: 'img', 'aria-label': `${Math.round(r.routeDone * 100)}% done` }, h('span', { style: `width:${r.routeDone * 100}%` })), h('span', { class: 'muted small-inline' }, `${r.kmRemaining.toFixed(0)} km left`)),
      h('td', {}, `${Math.round(r.estimate.soc.value * 100)}%`),
      h('td', { class: r.vehicle.online ? 'muted' : '' }, r.vehicle.online ? 'Just now' : `${r.lastSeenMin} min ago`),
    ))),
  ));
}

function detailDrawer(world, row, { onClose, onSwap, onUndo, spare, goTo }) {
  const active = row.capabilities.active;
  const features = CATALOG.filter((f) => !f.roadmap && row.capabilities.features.find((x) => x.id === f.id).state !== 'hardware-missing');
  return h('aside', { class: 'drawer', 'aria-label': `Route ${row.route.id} details` },
    h('div', { class: 'drawer-head' },
      h('div', {}, h('h3', {}, `${row.route.id} · ${row.route.area}`), h('p', { class: 'muted' }, `${row.route.driver} · ${row.vehicle.vin}`)),
      h('button', { class: 'ghost', 'aria-label': 'Close details', onClick: onClose }, '✕'),
    ),
    h('div', { class: `claim ${TONE[row.status] === 'neutral' ? '' : TONE[row.status]}` },
      h('strong', {}, `${STATUS[row.status].icon} ${STATUS[row.status].label}`), h('p', {}, explain(row))),
    spare && can(roleOf(world), 'route.swap') && h('button', { class: 'primary full', onClick: () => onSwap(row.route.id, spare.vin) }, `Swap to ${spare.vin}`),
    row.swapped && can(roleOf(world), 'route.swap') && h('button', { class: 'full', onClick: () => onUndo(row.route.id) }, 'Undo swap'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Route left'), h('dd', {}, `${row.kmRemaining.toFixed(0)} of ${row.route.km} km`),
      h('dt', {}, 'Cautious range'), h('dd', {}, `${cautiousKm(row).toFixed(0)} km `, badge('Estimate', 'warn')),
      h('dt', {}, 'Battery'), h('dd', {}, `${Math.round(row.estimate.soc.value * 100)}% `, badge('Estimate', 'warn')),
      h('dt', {}, 'Load'), h('dd', {}, `${row.payload.value} kg `, row.payload.provenance === 'measured' ? badge('Measured', 'good') : badge('Assumed', 'warn')),
      h('dt', {}, 'Last update'), h('dd', {}, row.vehicle.online ? 'Just now' : `${row.lastSeenMin} min ago`),
    ),
    h('p', { class: 'label' }, 'On this vehicle'),
    h('ul', { class: 'plain' }, features.map((f) => h('li', { class: 'feature-row' }, f.label, active.includes(f.id) ? badge('✓ On', 'good') : badge('Not on')))),
    can(roleOf(world), 'trace.view') && h('button', { class: 'link top-gap', onClick: () => { world.traceRoute = row.route.id; goTo('architecture'); } }, 'See how this was calculated →'),
  );
}

export function mountOperator(root, { world, goTo }) {
  const pick = (id) => { ui.selected = id; render(); };
  const fleetMap = getFleetMap();
  fleetMap.onPick = pick;
  const swap = (routeId, vin) => { swapRoute(world, routeId, vin); ui.selected = routeId; render(); };
  const undo = (routeId) => { undoRouteSwap(world, routeId); render(); };

  function onKey(event) {
    if (!root.isConnected) document.removeEventListener('keydown', onKey);
    else if (event.key === 'Escape' && ui.selected) { ui.selected = null; render(); }
  }
  document.addEventListener('keydown', onKey);

  function nextShift() {
    const hours = (world.now % DAY) / HOUR;
    advanceFleet(world, hours < 6 ? 6 - hours : 30 - hours);
    render();
  }

  function render() {
    const view = operationsView(world);
    const onShift = view.phase === 'shift';
    const onTrack = view.counts.ON_TRACK;
    const total = view.rows.length;
    const unconfirmed = view.counts.UNCONFIRMED;
    const selected = ui.selected ? routeRow(world, ui.selected) : null;
    fleetMap.update(view, ui.selected, activeZones(world));
    const selectedSpare = selected && view.decisions.find((d) => d.row.route.id === ui.selected)?.spare;

    const summary = [
      view.needsDecision ? `${view.needsDecision} need${view.needsDecision === 1 ? 's' : ''} a decision` : 'Nothing needs a decision',
      unconfirmed ? `${unconfirmed} can’t be confirmed` : null,
    ].filter(Boolean).join('. ');

    const search = h('input', {
      type: 'search', class: 'search', placeholder: 'Search route, area, driver, or vehicle', 'aria-label': 'Search routes', value: ui.search,
      onInput: (event) => { ui.search = event.target.value; tableSlot.replaceChildren(routeTable(view, pick)); },
    });
    const tableSlot = h('div', {}, routeTable(view, pick));

    root.replaceChildren(...[
      h('div', { class: 'ops-stage' },
        fleetMap.element,
        h('section', { class: 'hud hud-summary', 'aria-label': 'Fleet summary' },
          h('p', { class: 'hud-kicker' }, `Harbor Routes · Central Los Angeles`),
          h('p', { class: 'hud-kicker' }, `${formatTime(world.now)} · ${isOnShift(world.now) ? 'Shift in progress' : 'Planning the next shift'}`),
          h('div', { class: 'hero' }, h('span', { class: 'hero-num' }, onTrack), h('span', { class: 'hero-of' }, `of ${total} routes ${onShift ? 'on track' : 'ready'}`)),
          h('p', { class: 'muted' }, `${summary}.`),
          statusBar(view),
          h('div', { class: 'toolbar tight' },
            h('button', { onClick: () => { advanceFleet(world, 1); render(); } }, '+1 hour'),
            h('button', { onClick: nextShift }, 'Next shift'),
            h('button', { onClick: () => { resetFleet(world); ui.selected = null; render(); } }, 'Reset'),
          ),
        ),
        h('section', { class: 'hud hud-decisions', 'aria-label': 'Your decisions' },
          h('h3', {}, `Your decisions (${view.needsDecision})`),
          view.faulted > 0 && h('p', { class: 'callout warn' }, `A software update faulted ${view.faulted} vehicle${view.faulted === 1 ? '' : 's'} on your routes. Swap ${view.faulted === 1 ? 'it' : 'them'} to a spare now. A rollback can restore ${view.faulted === 1 ? 'it' : 'them'} off shift.`),
          view.faulted === 0 && rolloutActive(world) && h('p', { class: 'callout neutral' }, 'A software update is in progress. It only installs off shift.'),
          view.decisions.length
            ? h('ol', { class: 'decisions' }, view.decisions.map((d) => decisionCard(d, swap, pick, can(roleOf(world), 'route.swap'))))
            : h('p', { class: 'muted' }, 'You’re clear. Every route is on track or being watched.'),
          h('p', { class: 'muted small' }, `${view.spares.length} spare vehicle${view.spares.length === 1 ? '' : 's'} available.`),
        ),
        h('div', { class: 'hud hud-legend' },
          h('div', { class: 'legend' },
            h('span', {}, h('i', { class: 'dot st-good' }), 'On track'),
            h('span', {}, h('i', { class: 'dot hollow-dot' }), 'No signal'),
            h('span', {}, h('i', { class: 'tri' }), 'At risk'),
            h('span', {}, h('i', { class: 'sq' }), 'Won’t finish'),
            h('span', {}, h('i', { class: 'depot-key' }), 'Depot'),
            h('span', {}, h('i', { class: 'zone-key' }), 'Closure'),
            h('span', {}, h('i', { class: 'line-key todo' }), 'To drive'),
            h('span', {}, h('i', { class: 'line-key done' }), 'Driven'),
          ),
          h('p', { class: 'muted small' }, onShift ? 'Hover a vehicle to see its route, or click to open it.' : 'Vehicles are at the depot until the shift starts.'),
        ),
      ),
      h('div', { class: 'page-pad' },
        panel('All routes',
          h('div', { class: 'toolbar tight' },
            h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter routes' },
              FILTERS.map(([id, label]) => h('button', {
                class: id === ui.filter ? 'active' : '', 'aria-pressed': id === ui.filter ? 'true' : 'false',
                onClick: () => { ui.filter = id; render(); },
              }, label))),
            search,
          ),
          tableSlot,
        ),
      ),
      selected && detailDrawer(world, selected, { onClose: () => { ui.selected = null; render(); }, onSwap: swap, onUndo: undo, spare: selectedSpare, goTo }),
    ].filter(Boolean));
  }
  render();
}
