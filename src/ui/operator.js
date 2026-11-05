import { isOnShift } from '../core/ota.js';
import { DAY, formatTime, HOUR } from '../core/time.js';
import { advanceFleet, resetFleet, rolloutActive } from '../scenarios/fleet.js';
import { cautiousKm, explain, operationsView, routeRow, STATUS, swapVehicle, undoSwap } from '../scenarios/operations.js';
import { CATALOG } from '../sdv/catalog.js';
import { badge, h, panel } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const TONE = { ON_TRACK: 'good', UNCONFIRMED: 'neutral', NO_FORECAST: 'neutral', AT_RISK: 'warn', WONT_FINISH: 'bad', OUT_OF_SERVICE: 'bad' };
const MARK = { ON_TRACK: 'st-good', UNCONFIRMED: 'st-none', NO_FORECAST: 'st-none', AT_RISK: 'st-warn', WONT_FINISH: 'st-bad', OUT_OF_SERVICE: 'st-bad' };
const BAR_ORDER = ['ON_TRACK', 'UNCONFIRMED', 'NO_FORECAST', 'AT_RISK', 'WONT_FINISH', 'OUT_OF_SERVICE'];
const FILTERS = [
  ['all', 'All routes', () => true],
  ['decide', 'Needs a decision', (r) => ['AT_RISK', 'WONT_FINISH', 'OUT_OF_SERVICE'].includes(r.status)],
  ['signal', 'No signal', (r) => !r.vehicle.online],
  ['swapped', 'Swapped', (r) => r.swapped],
];

// Outlives the tab, so a selection survives a trip to the Architecture view and back.
const ui = { selected: null, filter: 'all', search: '' };

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

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

function marker(status, x, y) {
  const cls = `mark ${MARK[status]}`;
  if (status === 'AT_RISK') return s('path', { class: cls, d: `M${x} ${y - 7}L${x + 7} ${y + 5}H${x - 7}Z` });
  if (status === 'WONT_FINISH' || status === 'OUT_OF_SERVICE') return s('rect', { class: cls, x: x - 6, y: y - 6, width: 12, height: 12, rx: 2 });
  if (status === 'UNCONFIRMED' || status === 'NO_FORECAST') return s('circle', { class: `${cls} hollow`, cx: x, cy: y, r: 5.5 });
  return s('circle', { class: cls, cx: x, cy: y, r: 5.5 });
}

function routeMap(view, onPick) {
  const depot = { x: 320, y: 180 };
  const tooltip = h('div', { class: 'map-tip', hidden: true });
  const place = (row) => {
    const out = Math.max(0.14, Math.sin(Math.PI * row.routeDone));
    return { x: depot.x + (row.route.end.x - depot.x) * out, y: depot.y + (row.route.end.y - depot.y) * out };
  };
  const svg = s('svg', { viewBox: '0 0 640 360', class: 'routemap', role: 'img', 'aria-label': 'Schematic of routes around the depot. The route table below has the same data.' },
    ...view.rows.map((row) => s('line', { class: row.route.id === ui.selected ? 'spoke on' : 'spoke', x1: depot.x, y1: depot.y, x2: row.route.end.x, y2: row.route.end.y })),
    s('rect', { class: 'depot', x: depot.x - 9, y: depot.y - 9, width: 18, height: 18, rx: 3 }),
    ...[...view.rows].sort((a, b) => STATUS[b.status].rank - STATUS[a.status].rank).map((row) => {
      const { x, y } = place(row);
      const show = (event) => {
        tooltip.hidden = false;
        tooltip.textContent = `${row.route.id} · ${row.route.driver} · ${STATUS[row.status].label}`;
        const box = svg.getBoundingClientRect();
        tooltip.style.left = `${event.clientX - box.left + 12}px`;
        tooltip.style.top = `${event.clientY - box.top + 12}px`;
      };
      return s('g', { class: row.route.id === ui.selected ? 'stop on' : 'stop', onClick: () => onPick(row.route.id), onMousemove: show, onMouseleave: () => { tooltip.hidden = true; } },
        s('circle', { class: 'hit', cx: x, cy: y, r: 12 }), marker(row.status, x, y));
    }),
  );
  return h('div', { class: 'map-wrap' }, svg, tooltip);
}

function decisionCard(decision, onSwap, onPick) {
  const { row, spare, why } = decision;
  return h('li', { class: 'decision' },
    h('div', { class: 'decision-head' }, statusBadge(row.status), h('button', { class: 'link', onClick: () => onPick(row.route.id) }, `${row.route.id} · ${row.route.driver}`)),
    h('p', {}, why),
    spare
      ? h('button', { class: 'primary small', onClick: () => onSwap(row.route.id, spare.vin) }, `Swap to ${spare.vin}`)
      : h('p', { class: 'muted small' }, row.claim.action === 'No action needed' ? 'No spare is available. Call the driver.' : `No spare can cover it. ${row.claim.action}.`),
  );
}

function routeTable(view, onPick) {
  const [, , test] = FILTERS.find(([id]) => id === ui.filter);
  const query = ui.search.trim().toLowerCase();
  const rows = view.rows
    .filter(test)
    .filter((r) => !query || `${r.route.id} ${r.route.driver} ${r.vehicle.vin}`.toLowerCase().includes(query))
    .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.route.index - b.route.index);

  if (!rows.length) return h('p', { class: 'muted empty' }, 'No routes match.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'routes' },
    h('thead', {}, h('tr', {}, ['Route', 'Driver', 'Vehicle', 'Status', 'Progress', 'Battery', 'Last update'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.route.id === ui.selected ? 'on' : '' },
      h('td', {}, h('button', { class: 'link', onClick: () => onPick(r.route.id) }, r.route.id)),
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
      h('div', {}, h('h3', {}, `${row.route.id} · ${row.route.driver}`), h('p', { class: 'muted' }, `${row.vehicle.vin}`)),
      h('button', { class: 'ghost', 'aria-label': 'Close details', onClick: onClose }, '✕'),
    ),
    h('div', { class: `claim ${TONE[row.status] === 'neutral' ? '' : TONE[row.status]}` },
      h('strong', {}, `${STATUS[row.status].icon} ${STATUS[row.status].label}`), h('p', {}, explain(row))),
    spare && h('button', { class: 'primary full', onClick: () => onSwap(row.route.id, spare.vin) }, `Swap to ${spare.vin}`),
    row.swapped && h('button', { class: 'full', onClick: () => onUndo(row.route.id) }, 'Undo swap'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Route left'), h('dd', {}, `${row.kmRemaining.toFixed(0)} of ${row.route.km} km`),
      h('dt', {}, 'Cautious range'), h('dd', {}, `${cautiousKm(row).toFixed(0)} km `, badge('Estimate', 'warn')),
      h('dt', {}, 'Battery'), h('dd', {}, `${Math.round(row.estimate.soc.value * 100)}% `, badge('Estimate', 'warn')),
      h('dt', {}, 'Load'), h('dd', {}, `${row.payload.value} kg `, row.payload.provenance === 'measured' ? badge('Measured', 'good') : badge('Assumed', 'warn')),
      h('dt', {}, 'Last update'), h('dd', {}, row.vehicle.online ? 'Just now' : `${row.lastSeenMin} min ago`),
    ),
    h('p', { class: 'label' }, 'On this vehicle'),
    h('ul', { class: 'plain' }, features.map((f) => h('li', { class: 'feature-row' }, f.label, active.includes(f.id) ? badge('✓ On', 'good') : badge('Not on')))),
    h('button', { class: 'link top-gap', onClick: () => { world.traceRoute = row.route.id; goTo('architecture'); } }, 'See how this was calculated →'),
  );
}

export function mountOperator(root, { world, goTo }) {
  const pick = (id) => { ui.selected = id; render(); };
  const swap = (routeId, vin) => { swapVehicle(world, routeId, vin); ui.selected = routeId; render(); };
  const undo = (routeId) => { undoSwap(world, routeId); render(); };

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
    const selectedSpare = selected && view.decisions.find((d) => d.row.route.id === ui.selected)?.spare;

    const summary = [
      view.needsDecision ? `${view.needsDecision} need${view.needsDecision === 1 ? 's' : ''} a decision` : 'Nothing needs a decision',
      unconfirmed ? `${unconfirmed} can’t be confirmed` : null,
    ].filter(Boolean).join('. ');

    const search = h('input', {
      type: 'search', class: 'search', placeholder: 'Search route, driver, or vehicle', 'aria-label': 'Search routes', value: ui.search,
      onInput: (event) => { ui.search = event.target.value; tableSlot.replaceChildren(routeTable(view, pick)); },
    });
    const tableSlot = h('div', {}, routeTable(view, pick));

    root.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)} · ${isOnShift(world.now) ? 'Shift in progress' : 'Planning the next shift'}`),
          h('div', { class: 'hero' }, h('span', { class: 'hero-num' }, onTrack), h('span', { class: 'hero-of' }, `of ${total} routes ${onShift ? 'on track to finish today' : 'ready for the next shift'}`)),
          h('p', { class: 'muted' }, `${summary}.`),
        ),
        h('div', { class: 'toolbar end' },
          h('button', { onClick: () => { advanceFleet(world, 1); render(); } }, 'Advance 1 hour'),
          h('button', { onClick: nextShift }, 'Next shift'),
          h('button', { onClick: () => { resetFleet(world); ui.selected = null; render(); } }, 'Reset'),
        ),
      ),
      statusBar(view),
      view.faulted > 0 && h('p', { class: 'callout warn' }, `A software update faulted ${view.faulted} vehicle${view.faulted === 1 ? '' : 's'} on your routes. Swap ${view.faulted === 1 ? 'it' : 'them'} to a spare now. A rollback can restore ${view.faulted === 1 ? 'it' : 'them'} off shift.`),
      view.faulted === 0 && rolloutActive(world) && h('p', { class: 'callout neutral' }, 'A software update is in progress. It only installs off shift.'),
      h('div', { class: 'grid wide ops-grid' },
        panel('Routes right now', routeMap(view, pick),
          h('div', { class: 'legend' },
            h('span', {}, h('i', { class: 'dot st-good' }), 'On track'),
            h('span', {}, h('i', { class: 'dot hollow-dot' }), 'No signal'),
            h('span', {}, h('i', { class: 'tri' }), 'At risk'),
            h('span', {}, h('i', { class: 'sq' }), 'Won’t finish'),
            h('span', {}, h('i', { class: 'depot-key' }), 'Depot'),
          ),
          h('p', { class: 'muted small' }, 'A schematic of each route, not a street map.'),
        ),
        panel(`Your decisions (${view.needsDecision})`,
          view.decisions.length
            ? h('ol', { class: 'decisions' }, view.decisions.map((d) => decisionCard(d, swap, pick)))
            : h('p', { class: 'muted' }, 'You’re clear. Every route is on track or being watched.'),
          h('p', { class: 'muted small' }, `${view.spares.length} spare vehicle${view.spares.length === 1 ? '' : 's'} available.`),
        ),
      ),
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
      selected && detailDrawer(world, selected, { onClose: () => { ui.selected = null; render(); }, onSwap: swap, onUndo: undo, spare: selectedSpare, goTo }),
    ].filter(Boolean));
  }
  render();
}
