import './styles.css';
import { h } from './dom.js';
import { mountTransfer } from './transfer.js';
import { mountRevocation } from './revocation.js';
import { mountOta } from './ota.js';
import { mountRange } from './range.js';
import { mountVehicle } from './vehicle.js';
import { mountOperator, selectRoute } from './operator.js';
import { mountArchitecture } from './architecture.js';
import { mountAlerts } from './alerts.js';
import { mountMaintenance } from './maintenance.js';
import { mountReports } from './reports.js';
import { mountLearn } from './learn.js';
import { createFleetWorld } from '../scenarios/fleet.js';
import { alertSummary } from '../scenarios/alerts.js';
import { ROLES, SCREENS } from '../core/roles.js';

const MOUNTS = {
  operator: mountOperator, alerts: mountAlerts, maintenance: mountMaintenance, reports: mountReports, learn: mountLearn,
  architecture: mountArchitecture, vehicle: mountVehicle, ota: mountOta, transfer: mountTransfer, revocation: mountRevocation, range: mountRange,
};
const DEFAULT_PERSONA = 'owner';

const world = createFleetWorld();
const content = h('main', { id: 'content' });
const personaBar = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Persona' });
const sidebar = h('aside', { class: 'sidebar' });
let current = { role: DEFAULT_PERSONA, tab: ROLES[DEFAULT_PERSONA].tabs[0] };

// The address is the source of truth, so back, refresh, and bookmarks all work.
function fromAddress() {
  const [role, tab] = window.location.hash.slice(1).split('/');
  const persona = ROLES[role] ? role : DEFAULT_PERSONA;
  return { role: persona, tab: ROLES[persona].tabs.includes(tab) ? tab : ROLES[persona].tabs[0] };
}

function open(role, tab) {
  const address = `#${role}/${tab}`;
  if (window.location.hash === address) show();
  else window.location.hash = address;
}

function goTo(tab) {
  if (ROLES[current.role].tabs.includes(tab)) open(current.role, tab);
}

function renderChrome() {
  const persona = ROLES[current.role];
  const unread = alertSummary(world).unread;

  personaBar.replaceChildren(...Object.entries(ROLES).map(([id, role]) => h('button', {
    class: id === current.role ? 'active' : '',
    'aria-pressed': id === current.role ? 'true' : 'false',
    title: role.label,
    onClick: () => open(id, role.tabs[0]),
  }, role.short)));

  sidebar.replaceChildren(
    h('div', { class: 'persona-summary' }, h('strong', {}, persona.label), persona.summary),
    h('nav', { 'aria-label': `${persona.label} screens` }, persona.groups.map((group) => h('div', { class: 'nav-group' },
      h('span', {}, group.label),
      group.tabs.map((tab) => h('button', {
        'aria-current': tab === current.tab ? 'page' : null,
        onClick: () => open(current.role, tab),
      }, SCREENS[tab], tab === 'alerts' && unread > 0 && h('span', { class: 'nav-count', 'aria-label': `${unread} unread` }, unread))),
    ))),
  );
}

function show() {
  const previous = current.role;
  current = fromAddress();
  if (current.role !== previous) selectRoute(null);
  world.role = current.role;
  renderChrome();
  const view = h('div', {});
  content.replaceChildren(view);
  MOUNTS[current.tab](view, { world, goTo });
  window.scrollTo(0, 0);
}

world.onChange = renderChrome;
window.addEventListener('hashchange', show);

document.querySelector('#app').append(
  h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'fleet-lite'), h('span', { class: 'muted' }, 'Simulated data, assumed numbers')),
    h('div', { class: 'persona-picker' }, h('span', { class: 'label inline' }, 'I am a'), personaBar),
  ),
  h('div', { class: 'shell' }, sidebar, content),
);
show();
