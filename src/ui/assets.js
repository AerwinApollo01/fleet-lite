import { roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { assetHistory, assetRegister } from '../scenarios/assets.js';
import { queryAssets, VIEWS } from '../scenarios/assetquery.js';
import { componentReliability, STATE } from '../scenarios/components.js';
import { advanceFleet, resetFleet } from '../scenarios/fleet.js';
import { badge, h, panel } from './dom.js';
import { fleetGrid } from './fleetgrid.js';
import { saveFleetSize, SIZES } from './fleetsize.js';
import { schematic } from './schematic.js';

const TONE = { 'On route': 'good', 'At depot': 'neutral', Spare: 'neutral', Faulted: 'bad', Installed: 'neutral', Ready: 'good', Charging: 'warn' };
export const CONDITION = { fault: ['✕ Fault', 'bad'], watch: ['! Watch', 'warn'], ok: ['✓ Healthy', 'neutral'] };
const LENSES = [['vehicles', 'Vehicles'], ['packs', 'Battery packs'], ['components', 'Parts reliability']];
const PAGE_SIZE = 50;
const DEFAULT_SORT = { key: 'condition', dir: 'asc' };
const km = (value) => `${value.toLocaleString('en-US')} km`;

const ui = {
  lens: 'vehicles', search: '', page: 1, selected: null, part: null, ids: [],
  filters: { vehicles: {}, packs: {} }, sort: { vehicles: DEFAULT_SORT, packs: DEFAULT_SORT },
};

export const selectAsset = (id) => {
  ui.selected = id;
  if (id) ui.lens = 'packs';
};

// The list the person was working through, so a vehicle page can step to the next one.
export const listNeighbors = (id) => {
  const index = ui.ids.indexOf(id);
  return index < 0 ? null : { index, total: ui.ids.length, previous: ui.ids[index - 1] ?? null, next: ui.ids[index + 1] ?? null };
};

const sameFilters = (a, b) => {
  const clean = (filters) => JSON.stringify(Object.entries(filters).filter(([, list]) => list.length).sort());
  return clean(a) === clean(b);
};

export function mountAssets(root, { world, openAsset, missing = null }) {
  let register;
  const openVehicle = (id) => openAsset(id);
  const setPage = (page) => { ui.page = page; drawList(); };
  const results = h('div', { class: 'asset-results' });
  const side = h('div', { class: 'facets' });
  const grid = h('div', {});

  const vehicleColumns = () => [
    ['id', 'Vehicle', (v) => h('button', { class: 'link', onClick: () => openVehicle(v.id) }, v.id)],
    ['condition', 'Condition', (v) => h('span', {}, badge(...CONDITION[v.condition]), v.worst ? h('span', { class: 'muted cell-note' }, v.worst) : '')],
    ['status', 'Status', (v) => h('span', {}, badge(v.status, TONE[v.status]), v.online ? '' : ' ', v.online ? '' : badge('No signal'))],
    ['depot', 'Depot', (v) => v.depot],
    ...(roleOf(world) === 'technician' ? [] : [['routeId', 'Route', (v) => (v.routeId ? `${v.routeId} · ${v.area}` : '—')]]),
    ['hardware', 'Hardware', (v) => v.hardware],
    ['firmware', 'Firmware', (v) => v.firmware],
    ['odometerKm', 'Odometer', (v) => km(v.odometerKm)],
  ];

  const packColumns = () => [
    ['id', 'Pack', (p) => h('button', { class: 'link', onClick: () => { ui.selected = p.id; drawDrawer(); } }, p.id)],
    ['condition', 'Condition', (p) => badge(...(p.lowHealth ? ['! Replace soon', 'warn'] : CONDITION.ok))],
    ['status', 'Status', (p) => badge(p.status, TONE[p.status])],
    ['vin', 'Installed in', (p) => (p.vin ? h('button', { class: 'link', onClick: () => openVehicle(p.vin) }, p.vin) : '—')],
    ['healthPct', 'Health (est.)', (p) => `${p.healthPct}%`],
    ['cycles', 'Cycles', (p) => p.cycles],
    ['ageDays', 'Age', (p) => `${p.ageDays} days`],
  ];

  function sortHead(key, label) {
    const sort = ui.sort[ui.lens];
    const active = sort.key === key;
    return h('th', { 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', {
        class: active ? 'th-sort active' : 'th-sort',
        onClick: () => {
          ui.sort[ui.lens] = { key, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' };
          ui.page = 1;
          drawList();
        },
      }, label, active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''));
  }

  const query = () => queryAssets(register[ui.lens], ui.lens, {
    search: ui.search, filters: ui.filters[ui.lens], sort: ui.sort[ui.lens], page: ui.page, pageSize: PAGE_SIZE,
    searchRoutes: roleOf(world) !== 'technician',
  });

  function pager(result) {
    const first = result.total ? result.start + 1 : 0;
    const last = result.start + result.rows.length;
    return h('div', { class: 'pager' },
      h('span', { class: 'muted', 'aria-live': 'polite' }, `${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${result.total.toLocaleString('en-US')}`),
      h('div', { class: 'pager-buttons' },
        h('button', { disabled: result.page === 1, 'aria-label': 'First page', onClick: () => setPage(1) }, '«'),
        h('button', { disabled: result.page === 1, 'aria-label': 'Previous page', onClick: () => setPage(result.page - 1) }, '‹'),
        h('span', { class: 'muted' }, `Page ${result.page} of ${result.pages}`),
        h('button', { disabled: result.page === result.pages, 'aria-label': 'Next page', onClick: () => setPage(result.page + 1) }, '›'),
        h('button', { disabled: result.page === result.pages, 'aria-label': 'Last page', onClick: () => setPage(result.pages) }, '»'),
      ),
    );
  }

  function facetPanel(result) {
    const chosen = ui.filters[ui.lens];
    const active = Object.values(chosen).some((list) => list.length);
    const toggle = (facet, value) => {
      const list = chosen[facet] ?? [];
      chosen[facet] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      ui.page = 1;
      drawList();
    };
    side.replaceChildren(...[
      h('div', { class: 'facets-head' }, h('h3', {}, 'Filter'), active && h('button', { class: 'link', onClick: () => { ui.filters[ui.lens] = {}; ui.page = 1; drawList(); } }, 'Clear')),
      ...result.facets.filter((facet) => facet.options.length > 1 || chosen[facet.id]?.length).map((facet) =>
        h('fieldset', { class: 'facet' },
          h('legend', {}, facet.label),
          facet.options.slice(0, 8).map((option) => h('label', {},
            h('input', { type: 'checkbox', checked: option.checked, onChange: () => toggle(facet.id, option.value) }),
            h('span', {}, option.value),
            h('span', { class: 'muted' }, option.count.toLocaleString('en-US')),
          )),
          facet.options.length > 8 && h('p', { class: 'muted small' }, `${facet.options.length - 8} more. Search to narrow.`),
        )),
    ].filter(Boolean));
  }

  function drawGrid(result) {
    // Worst first, so the first cells are the ones worth opening.
    const rows = [...register[ui.lens]].sort((x, y) => STATE[x.condition].rank - STATE[y.condition].rank);
    const matched = new Set(result.ids);
    const count = (tone) => rows.filter((row) => row.condition === tone).length;
    const describe = (row) => {
      const state = row.condition === 'ok' ? 'Healthy' : `${STATE[row.condition].label}${row.worst ? `: ${row.worst}` : ''}`;
      return row.online === false ? `${state} · No signal` : state;
    };
    const legend = (tone, label) => h('span', {}, h('i', { class: `key ${tone}` }), label);
    grid.replaceChildren(panel('Fleet at a glance',
      fleetGrid(rows, matched, {
        describe,
        onOpen: (row) => { if (ui.lens === 'vehicles') openVehicle(row.id); else { ui.selected = row.id; drawDrawer(); } },
      }),
      h('div', { class: 'grid-legend' },
        legend('fault', `✕ Fault ${count('fault').toLocaleString('en-US')}`),
        legend('watch', `! Watch ${count('watch').toLocaleString('en-US')}`),
        legend('ok', `✓ Healthy ${count('ok').toLocaleString('en-US')}`),
        ui.lens === 'vehicles' && legend('none', 'Healthy, no signal'),
        h('span', { class: 'muted' }, 'One cell per asset. Click one to open it.'),
      ),
    ));
  }

  function drawList() {
    const result = query();
    ui.page = result.page;
    ui.ids = ui.lens === 'vehicles' ? result.ids : [];
    const columns = ui.lens === 'vehicles' ? vehicleColumns() : packColumns();
    const views = VIEWS[ui.lens];
    results.replaceChildren(
      h('div', { class: 'view-chips', role: 'group', 'aria-label': 'Saved views' },
        views.map((view) => {
          const active = sameFilters(view.filters, ui.filters[ui.lens]);
          const count = queryAssets(register[ui.lens], ui.lens, { filters: view.filters, pageSize: 1 }).total;
          return h('button', {
            class: active ? 'chip active' : 'chip', 'aria-pressed': active ? 'true' : 'false',
            onClick: () => { ui.filters[ui.lens] = structuredClone(view.filters); ui.page = 1; drawList(); },
          }, `${view.label} ${count.toLocaleString('en-US')}`);
        })),
      result.total
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, columns.map(([key, label]) => sortHead(key, label)))),
            h('tbody', {}, result.rows.map((row) => h('tr', {}, columns.map(([, , cell]) => h('td', {}, cell(row)))))),
          ))
        : h('p', { class: 'muted empty' }, 'Nothing matches. Clear a filter or change the search.'),
      pager(result),
    );
    facetPanel(result);
    drawGrid(result);
  }

  function partDetail(part) {
    const groups = part.breakdown.filter((group) => group.km > 0);
    const top = Math.max(...groups.map((group) => group.per100k), 0.1);
    const flaggedCount = register.vehicles.filter((v) => v.flagged.includes(part.id)).length;
    const kinds = [...new Set(groups.map((group) => group.kind))];
    return h('div', { class: 'part-detail' },
      h('h3', {}, `${part.label}: failures per 100,000 km`),
      h('div', { class: 'part-kinds' }, kinds.map((kind) => h('div', {},
        h('p', { class: 'label' }, kind),
        groups.filter((group) => group.kind === kind).map((group) => h('div', { class: 'bar-row', title: `${group.failures} failures over ${km(group.km)}` },
          h('span', {}, group.label),
          h('span', { class: 'bar' }, h('i', { style: `width:${(group.per100k / top) * 100}%` })),
          h('strong', {}, group.per100k.toFixed(1)),
        )),
      ))),
      h('p', { class: 'muted small' }, part.finding
        ? `${part.finding.label} fails ${part.finding.timesRest}× as often as the rest of the fleet, and the sample is big enough to take seriously.`
        : 'No group stands out. Differences this small can be chance at this sample size.'),
      flaggedCount > 0 && h('button', {
        class: 'primary',
        onClick: () => { ui.lens = 'vehicles'; ui.filters.vehicles = { component: [part.label] }; ui.page = 1; render(); },
      }, `See ${flaggedCount.toLocaleString('en-US')} vehicle${flaggedCount === 1 ? '' : 's'} needing attention`),
    );
  }

  function fleetDiagram(parts, selected) {
    const twin = {
      vin: 'the fleet', stale: false,
      components: parts.map((part) => ({
        id: part.id, label: part.label, system: part.system, state: part.finding ? 'watch' : 'ok',
        stateLabel: `${part.per100k.toFixed(1)} failures per 100,000 km${part.finding ? `, ${part.finding.label} stands out` : ''}`,
      })),
    };
    const svg = schematic(twin, (id) => { ui.part = id; render(); });
    svg.querySelector(`[data-c="${selected.id}"]`).classList.add('picked');
    return h('div', { class: 'fleet-diagram' }, svg,
      h('p', { class: 'muted small' }, '! A supplier or hardware group fails more often than the rest. Choose a part to see its numbers. Open a vehicle from Vehicles to see that one vehicle’s parts.'));
  }

  function partsView() {
    const parts = componentReliability(world);
    const top = Math.max(...parts.map((part) => part.per100k), 0.1);
    const findings = parts.filter((part) => part.finding);
    const selected = parts.find((part) => part.id === ui.part) ?? findings[0] ?? parts[0];
    return h('div', {},
      findings.length > 0
        ? h('p', { class: 'callout warn' }, findings.map((part) => `${part.label}: ${part.finding.label} fails ${part.finding.timesRest}× as often as the rest.`).join(' '))
        : h('p', { class: 'callout neutral' }, 'No supplier or hardware group stands out yet. With a small fleet, most differences are chance. Try a larger demo fleet.'),
      panel('Fleet system view', fleetDiagram(parts, selected)),
      panel('Reliability by part',
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Part', 'System', 'Open now', 'Failures', 'Per 100,000 km', 'Distance between failures'].map((text) => h('th', {}, text)))),
          h('tbody', {}, parts.map((part) => h('tr', { class: part === selected ? 'selected' : '' },
            h('td', {}, h('button', { class: 'link', 'aria-pressed': part === selected ? 'true' : 'false', onClick: () => { ui.part = part.id; render(); } }, part.label)),
            h('td', {}, part.system),
            h('td', {}, part.open),
            h('td', {}, part.failures.toLocaleString('en-US')),
            h('td', {}, h('div', { class: 'bar-cell' }, h('span', { class: 'bar' }, h('i', { style: `width:${(part.per100k / top) * 100}%` })), h('span', {}, part.per100k.toFixed(1)))),
            h('td', {}, part.mtbfKm ? km(part.mtbfKm) : '—'),
          ))),
        )),
        h('p', { class: 'muted small' }, 'Failures are simulated. Distance between failures is total distance divided by failures, so it describes the fleet, not when one part will fail.'),
      ),
      panel(selected.label, partDetail(selected)),
    );
  }

  const historyList = (id) => {
    const events = assetHistory(world, id);
    return events.length
      ? h('ol', { class: 'timeline compact' }, events.map((event) => h('li', {}, h('span', { class: 'muted' }, formatTime(event.at)), h('p', {}, event.text))))
      : h('p', { class: 'muted' }, 'Nothing recorded yet.');
  };

  const drawer = h('div', {});
  function drawDrawer() {
    const pack = register.packs.find((p) => p.id === ui.selected);
    if (!pack) { drawer.replaceChildren(); return; }
    const facts = [['Status', pack.status], ['Installed in', pack.vin ?? '—'], ['Health', `${pack.healthPct}% (estimate)`], ['Charge cycles', pack.cycles], ['In service', `${pack.ageDays} days`]];
    drawer.replaceChildren(h('aside', { class: 'drawer', 'aria-label': `${pack.id} details` },
      h('div', { class: 'drawer-head' },
        h('div', {}, h('h3', {}, pack.id), h('p', { class: 'muted' }, 'Battery pack')),
        h('button', { class: 'ghost', 'aria-label': 'Close details', onClick: () => { ui.selected = null; drawDrawer(); } }, '✕'),
      ),
      pack.vin && h('button', { class: 'primary full', onClick: () => openAsset(pack.vin, 'pack') }, `Open ${pack.vin} at this pack`),
      h('dl', { class: 'facts' }, facts.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
      h('p', { class: 'label' }, 'History'),
      historyList(pack.id),
    ));
  }

  function onKey(event) {
    if (!root.isConnected) document.removeEventListener('keydown', onKey);
    else if (event.key === 'Escape' && ui.selected) { ui.selected = null; drawDrawer(); }
  }
  document.addEventListener('keydown', onKey);

  function onSearchKey(event) {
    if (event.key !== 'Enter') return;
    const term = ui.search.trim().toUpperCase();
    const exact = register.vehicles.find((v) => v.id === term);
    if (exact) openVehicle(exact.id);
    else if (ui.ids.length === 1) openVehicle(ui.ids[0]);
  }

  function render() {
    register = assetRegister(world);
    const { summary } = register;
    const isParts = ui.lens === 'components';
    root.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)}`),
          h('h2', {}, 'Assets'),
          h('p', { class: 'muted' }, 'Start from what needs attention, then open any vehicle to see its system view and firmware.'),
        ),
        h('div', { class: 'toolbar end' },
          h('label', { class: 'size-pick', title: 'A larger fleet adds other depots. Changing this restarts the simulation.' },
            h('span', { class: 'muted' }, 'Demo fleet'),
            h('select', {
              'aria-label': 'Demo fleet size. Changing this restarts the simulation.',
              onChange: (event) => { const size = Number(event.target.value); resetFleet(world, size); saveFleetSize(size); ui.page = 1; ui.selected = null; render(); },
            }, SIZES.map((size) => h('option', { value: size, selected: size === world.fleet.length }, size.toLocaleString('en-US')))),
          ),
          h('button', { onClick: () => { advanceFleet(world, 1); render(); } }, '+1 hour'),
          h('button', { onClick: () => { advanceFleet(world, 24); render(); } }, '+1 day'),
        ),
      ),
      missing && h('p', { class: 'callout warn' }, `${missing} isn’t in this demo fleet of ${summary.vehicles.toLocaleString('en-US')} vehicles. Choose a vehicle below, or change the demo fleet size.`),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Vehicles in use'), h('strong', {}, `${summary.inUse.toLocaleString('en-US')} of ${summary.vehicles.toLocaleString('en-US')}`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Vehicles needing attention'), h('strong', {}, summary.needAttention.toLocaleString('en-US'))),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Packs ready to swap'), h('strong', {}, summary.packsReady.toLocaleString('en-US')), summary.packsCharging > 0 && h('span', { class: 'muted small-inline' }, `${summary.packsCharging.toLocaleString('en-US')} charging`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Packs to replace soon'), h('strong', {}, summary.packsLowHealth.toLocaleString('en-US'))),
      ),
      h('div', { class: 'toolbar tight' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'What to look at' },
          LENSES.map(([id, label]) => h('button', {
            class: id === ui.lens ? 'active' : '', 'aria-pressed': id === ui.lens ? 'true' : 'false',
            onClick: () => { ui.lens = id; ui.page = 1; render(); },
          }, id === 'components' ? label : `${label} (${(id === 'vehicles' ? summary.vehicles : summary.packs).toLocaleString('en-US')})`))),
        !isParts && h('input', {
          type: 'search', class: 'search', 'aria-label': 'Search assets', value: ui.search,
          placeholder: ui.lens === 'vehicles' ? 'Type a vehicle ID and press Enter, or search by depot, part, or supplier' : 'Search packs',
          onInput: (event) => { ui.search = event.target.value; ui.page = 1; drawList(); },
          onKeydown: onSearchKey,
        }),
      ),
      isParts ? partsView() : h('div', { class: 'asset-layout' }, side, h('div', { class: 'asset-main' }, grid, h('section', { class: 'panel' }, results))),
      drawer,
    ].filter(Boolean));
    if (!isParts) drawList();
    drawDrawer();
  }
  render();
}

