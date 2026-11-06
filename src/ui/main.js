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
import { mountAssets, selectAsset } from './assets.js';
import { mountDesign } from './design.js';
import { createFleetWorld } from '../scenarios/fleet.js';
import { alertSummary } from '../scenarios/alerts.js';
import { ROLES, SCREENS } from '../core/roles.js';
import { icon } from './icons.js';

const MOUNTS = {
  operator: mountOperator, alerts: mountAlerts, maintenance: mountMaintenance, reports: mountReports, assets: mountAssets, learn: mountLearn,
  architecture: mountArchitecture, design: mountDesign, vehicle: mountVehicle, ota: mountOta, transfer: mountTransfer, revocation: mountRevocation, range: mountRange,
};
const DEFAULT_PERSONA = 'owner';

const world = createFleetWorld();
const content = h('main', { id: 'content' });
const screens = h('nav', { class: 'rail-nav', 'aria-label': 'Screens' });
const personaMenu = h('div', { class: 'persona-menu', role: 'group', 'aria-label': 'Choose a persona' });
const personaButton = h('button', { class: 'rail-persona', onClick: () => { menuOpen = !menuOpen; renderChrome(); } });
let menuOpen = false;
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

  screens.replaceChildren(...persona.groups.flatMap((group) => [
    persona.groups.length > 2 && group.label !== 'Help' && h('span', { class: 'rail-group' }, group.label),
    ...group.tabs.map((tab) => h('button', {
      class: 'rail-item',
      'aria-current': tab === current.tab ? 'page' : null,
      onClick: () => open(current.role, tab),
    }, icon(tab), h('span', {}, SCREENS[tab]), tab === 'alerts' && unread > 0 && h('span', { class: 'nav-count', 'aria-label': `${unread} unread` }, unread))),
  ].filter(Boolean)));

  personaButton.replaceChildren(h('span', { class: 'persona-ring' }, icon('person')), h('span', {}, persona.short));
  personaButton.setAttribute('aria-expanded', String(menuOpen));
  personaButton.setAttribute('aria-label', `Persona: ${persona.label}. Change persona`);

  personaMenu.hidden = !menuOpen;
  personaMenu.replaceChildren(
    h('p', { class: 'hud-kicker' }, 'I am a'),
    ...Object.entries(ROLES).map(([id, role]) => h('button', {
      class: id === current.role ? 'persona-option active' : 'persona-option',
      'aria-pressed': id === current.role ? 'true' : 'false',
      onClick: () => { menuOpen = false; open(id, role.tabs[0]); },
    }, h('strong', {}, role.label), h('span', {}, role.summary))),
  );
}

function show() {
  const previous = current.role;
  current = fromAddress();
  if (current.role !== previous) {
    selectRoute(null);
    selectAsset(null);
  }
  world.role = current.role;
  renderChrome();
  const view = h('div', {});
  content.replaceChildren(view);
  content.className = current.tab === 'operator' ? 'bleed' : '';
  MOUNTS[current.tab](view, { world, goTo });
  window.scrollTo(0, 0);
}

world.onChange = renderChrome;
window.addEventListener('hashchange', show);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuOpen) { menuOpen = false; renderChrome(); }
});

document.querySelector('#app').append(
  h('div', { class: 'shell' },
    h('aside', { class: 'rail' },
      h('div', { class: 'rail-brand', title: 'Simulated data, assumed numbers' }, h('strong', {}, 'fleet'), h('span', {}, 'lite')),
      screens,
      personaButton,
      personaMenu,
    ),
    content,
  ),
);
show();
