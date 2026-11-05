import './styles.css';
import { h } from './dom.js';
import { mountTransfer } from './transfer.js';
import { mountRevocation } from './revocation.js';
import { mountOta } from './ota.js';
import { mountRange } from './range.js';
import { mountVehicle } from './vehicle.js';
import { mountOperator } from './operator.js';
import { mountArchitecture } from './architecture.js';
import { mountAlerts } from './alerts.js';
import { mountMaintenance } from './maintenance.js';
import { mountReports } from './reports.js';
import { createFleetWorld } from '../scenarios/fleet.js';
import { alertSummary } from '../scenarios/alerts.js';
import { roleOf, ROLES } from '../core/roles.js';

const TABS = [
  { id: 'operator', label: 'Operator', mount: mountOperator },
  { id: 'alerts', label: 'Alerts', mount: mountAlerts },
  { id: 'maintenance', label: 'Maintenance', mount: mountMaintenance },
  { id: 'reports', label: 'Reports', mount: mountReports },
  { id: 'architecture', label: 'Architecture', mount: mountArchitecture },
  { id: 'vehicle', label: 'Vehicle', mount: mountVehicle },
  { id: 'ota', label: 'OTA rollout', mount: mountOta },
  { id: 'transfer', label: 'Transfer', mount: mountTransfer },
  { id: 'revocation', label: 'Revocation', mount: mountRevocation },
  { id: 'range', label: 'Range', mount: mountRange },
];

const world = createFleetWorld();
const content = h('main', { id: 'content' });
const nav = h('nav', { role: 'tablist', 'aria-label': 'Screens' });
let current = TABS[0];

const visibleTabs = () => TABS.filter((tab) => ROLES[roleOf(world)].tabs.includes(tab.id));

function renderNav() {
  const unread = alertSummary(world).unread;
  nav.replaceChildren(...visibleTabs().map((tab) => h('button', {
    role: 'tab',
    class: tab === current ? 'active' : '',
    'aria-selected': tab === current ? 'true' : 'false',
    onClick: () => select(tab),
  }, tab.label, tab.id === 'alerts' && unread > 0 && h('span', { class: 'nav-count', 'aria-label': `${unread} unread` }, unread))));
}

function select(tab) {
  current = tab;
  renderNav();
  const view = h('div', {});
  content.replaceChildren(view);
  tab.mount(view, { world, goTo });
}

function goTo(id) {
  const tab = visibleTabs().find((t) => t.id === id);
  if (tab) select(tab);
}

world.onChange = renderNav;

const rolePicker = h('label', { class: 'role-picker' }, 'Viewing as',
  h('select', {
    'aria-label': 'Viewing as',
    onChange: (event) => {
      world.role = event.target.value;
      select(visibleTabs().includes(current) ? current : visibleTabs()[0]);
    },
  }, Object.entries(ROLES).map(([id, role]) => h('option', { value: id, selected: id === roleOf(world) }, role.label))));

document.querySelector('#app').append(
  h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'fleet-lite'), h('span', { class: 'muted' }, 'Simulated data, assumed numbers'), rolePicker),
    nav,
  ),
  content,
);
select(current);
