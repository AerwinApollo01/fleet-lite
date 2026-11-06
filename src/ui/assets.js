import { can, roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { assetHistory, assetRegister, swapPack } from '../scenarios/assets.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { readyPacks } from '../scenarios/packs.js';
import { badge, h, panel, table } from './dom.js';

const TONE = { 'On route': 'good', 'At depot': 'neutral', Spare: 'neutral', Faulted: 'bad', Installed: 'neutral', Ready: 'good', Charging: 'warn' };
const FILTERS = [['vehicles', 'Vehicles'], ['packs', 'Battery packs']];
const ui = { view: 'vehicles', search: '', selected: null };

export const selectAsset = (id) => {
  ui.selected = id;
  if (id) ui.view = id.startsWith('P-') ? 'packs' : 'vehicles';
};

export function mountAssets(root, { world }) {
  const open = (id) => { ui.selected = id; render(); };
  const link = (id) => h('button', { class: 'link', onClick: () => open(id) }, id);
  const matches = (asset) => JSON.stringify(asset).toLowerCase().includes(ui.search.trim().toLowerCase());

  function vehicleTable(vehicles) {
    return table(['Vehicle', 'Status', 'Route', 'Battery pack', 'Firmware', 'Odometer', 'Age'], vehicles.map((v) => [
      link(v.id), h('span', {}, badge(v.status, TONE[v.status]), v.online ? '' : ' ', v.online ? '' : badge('No signal')),
      v.routeId ? `${v.routeId} · ${v.area}` : '—', link(v.packId), v.firmware, `${v.odometerKm.toLocaleString('en-US')} km`, `${v.ageDays} days`,
    ]));
  }

  function packTable(packs) {
    return table(['Pack', 'Status', 'Installed in', 'Health (est.)', 'Cycles', 'Age'], packs.map((p) => [
      link(p.id), badge(p.status, TONE[p.status]), p.vin ? link(p.vin) : '—',
      h('span', {}, `${p.healthPct}%`, p.lowHealth ? ' ' : '', p.lowHealth ? badge('Replace soon', 'warn') : ''), p.cycles, `${p.ageDays} days`,
    ]));
  }

  function historyList(id) {
    const events = assetHistory(world, id);
    return events.length
      ? h('ol', { class: 'timeline compact' }, events.map((event) => h('li', {}, h('span', { class: 'muted' }, formatTime(event.at)), h('p', {}, event.text))))
      : h('p', { class: 'muted' }, 'Nothing recorded yet.');
  }

  function detail(register) {
    const vehicle = register.vehicles.find((v) => v.id === ui.selected);
    const pack = register.packs.find((p) => p.id === ui.selected);
    if (!vehicle && !pack) return null;
    const ready = readyPacks(world);
    const canSwap = vehicle && vehicle.online && ready.length > 0 && can(roleOf(world), 'pack.swap');
    const facts = vehicle
      ? [['Status', vehicle.status], ['Route', vehicle.routeId ?? '—'], ['Battery pack', link(vehicle.packId)], ['Hardware', vehicle.hardware], ['Firmware', vehicle.firmware], ['Odometer', `${vehicle.odometerKm.toLocaleString('en-US')} km`], ['In service', `${vehicle.ageDays} days`], ['Open work orders', vehicle.openOrders]]
      : [['Status', pack.status], ['Installed in', pack.vin ? link(pack.vin) : '—'], ['Health', `${pack.healthPct}% (estimate)`], ['Charge cycles', pack.cycles], ['In service', `${pack.ageDays} days`]];

    return h('aside', { class: 'drawer', 'aria-label': `${ui.selected} details` },
      h('div', { class: 'drawer-head' },
        h('div', {}, h('h3', {}, ui.selected), h('p', { class: 'muted' }, vehicle ? 'Vehicle' : 'Battery pack')),
        h('button', { class: 'ghost', 'aria-label': 'Close details', onClick: () => open(null) }, '✕'),
      ),
      canSwap && h('button', { class: 'primary full', onClick: () => { swapPack(world, vehicle.id, ready[0].id); render(); } }, `Swap battery to ${ready[0].id}`),
      vehicle && !vehicle.online && h('p', { class: 'callout warn' }, 'This vehicle has no signal, so a battery swap can’t be confirmed.'),
      h('dl', { class: 'facts' }, facts.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
      h('p', { class: 'label' }, 'History'),
      historyList(ui.selected),
    );
  }

  function onKey(event) {
    if (!root.isConnected) document.removeEventListener('keydown', onKey);
    else if (event.key === 'Escape' && ui.selected) open(null);
  }
  document.addEventListener('keydown', onKey);

  function render() {
    const register = assetRegister(world);
    const { summary } = register;
    const list = h('div', {});
    const fill = () => list.replaceChildren(ui.view === 'vehicles'
      ? vehicleTable(register.vehicles.filter(matches))
      : packTable(register.packs.filter(matches)));
    fill();

    root.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)}`),
          h('h2', {}, 'Asset register'),
          h('p', { class: 'muted' }, 'Everything you own, where it is, and what’s happened to it.'),
        ),
        h('div', { class: 'toolbar end' }, h('button', { onClick: () => { advanceFleet(world, 1); render(); } }, '+1 hour')),
      ),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Vehicles in use'), h('strong', {}, `${summary.inUse} of ${summary.vehicles}`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Spare vehicles'), h('strong', {}, summary.spare)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Packs ready to swap'), h('strong', {}, `${summary.packsReady}`), summary.packsCharging > 0 && h('span', { class: 'muted small-inline' }, `${summary.packsCharging} charging`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Packs to replace soon'), h('strong', {}, summary.packsLowHealth)),
      ),
      panel('Assets',
        h('div', { class: 'toolbar tight' },
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Asset type' },
            FILTERS.map(([id, label]) => h('button', {
              class: id === ui.view ? 'active' : '', 'aria-pressed': id === ui.view ? 'true' : 'false',
              onClick: () => { ui.view = id; render(); },
            }, `${label} (${id === 'vehicles' ? summary.vehicles : summary.packs})`))),
          h('input', {
            type: 'search', class: 'search', placeholder: 'Search assets', 'aria-label': 'Search assets', value: ui.search,
            onInput: (event) => { ui.search = event.target.value; fill(); },
          }),
        ),
        list,
      ),
      detail(register),
    ].filter(Boolean));
  }
  render();
}
