import './styles.css';
import { h } from './dom.js';
import { mountTransfer } from './transfer.js';
import { mountRevocation } from './revocation.js';
import { mountOta } from './ota.js';
import { mountRange } from './range.js';
import { mountVehicle } from './vehicle.js';
import { createFleetWorld } from '../scenarios/fleet.js';

const TABS = [
  { id: 'vehicle', label: 'Vehicle', mount: mountVehicle },
  { id: 'transfer', label: 'Transfer', mount: mountTransfer },
  { id: 'revocation', label: 'Revocation', mount: mountRevocation },
  { id: 'ota', label: 'OTA rollout', mount: mountOta },
  { id: 'range', label: 'Range', mount: mountRange },
];

const world = createFleetWorld();
const goTo = (id) => select(TABS.find((tab) => tab.id === id));

const content = h('main', { id: 'content' });
const buttons = TABS.map((tab) => h('button', {
  role: 'tab',
  onClick: () => select(tab),
}, tab.label));

function select(tab) {
  buttons.forEach((button, i) => {
    const active = TABS[i] === tab;
    button.className = active ? 'active' : '';
    button.setAttribute('aria-selected', String(active));
  });
  const view = h('div', {});
  content.replaceChildren(view);
  tab.mount(view, { world, goTo });
}

document.querySelector('#app').append(
  h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'fleet-lite'), h('span', { class: 'muted' }, 'Simulated data, assumed numbers')),
    h('nav', { role: 'tablist', 'aria-label': 'Scenarios' }, buttons),
  ),
  content,
);
select(TABS[0]);
