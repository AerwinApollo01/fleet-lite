import { formatTime } from '../core/time.js';
import { can, roleOf } from '../core/roles.js';
import { acknowledgeAlert, alertSummary, dismissAlert, setZone, ZONES } from '../scenarios/alerts.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { badge, h, panel, table } from './dom.js';
import { selectRoute } from './operator.js';

const SEVERITY = { critical: ['✕ Critical', 'bad'], warning: ['! Warning', 'warn'] };
const OUTCOME = { acted: ['Acted on', 'good'], cleared: ['Cleared on its own', 'neutral'], dismissed: ['Not useful', 'warn'] };

export function mountAlerts(root, { world, goTo }) {
  function card(alert, allowed) {
    const [label, tone] = SEVERITY[alert.severity];
    return h('li', { class: 'alert-card' },
      h('div', {},
        h('div', { class: 'alert-title' }, badge(label, tone), alert.title, alert.status === 'acknowledged' && badge('Acknowledged')),
        h('p', {}, alert.detail),
        h('p', { class: 'muted' }, `Since ${formatTime(alert.openedAt)}`),
      ),
      h('div', { class: 'row-actions' },
        h('button', { class: 'primary small', onClick: () => { selectRoute(alert.routeId); goTo('operator'); } }, 'Open route'),
        allowed && alert.status === 'open' && h('button', { class: 'small', onClick: () => { acknowledgeAlert(world, alert.id); render(); } }, 'Acknowledge'),
        allowed && h('button', { class: 'small', onClick: () => { dismissAlert(world, alert.id); render(); } }, 'Not useful'),
      ),
    );
  }

  function render() {
    const summary = alertSummary(world);
    const role = roleOf(world);
    const allowed = can(role, 'alert.respond');
    const rate = summary.actionRate === null ? '—' : `${Math.round(summary.actionRate * 100)}%`;

    root.replaceChildren(
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)}`),
          h('div', { class: 'hero' }, h('span', { class: 'hero-num' }, summary.open.length), h('span', { class: 'hero-of' }, `open alert${summary.open.length === 1 ? '' : 's'}`)),
          h('p', { class: 'muted' }, 'Warnings wait an hour to confirm. Critical alerts arrive right away.'),
        ),
        h('div', { class: 'toolbar end' }, h('button', { onClick: () => { advanceFleet(world, 1); render(); } }, 'Advance 1 hour')),
      ),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Alert-to-action rate'), h('strong', {}, rate)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Held back'), h('strong', {}, summary.heldBack)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Cleared on their own'), h('strong', {}, summary.cleared)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Marked not useful'), h('strong', {}, summary.dismissed)),
      ),
      h('div', { class: 'grid wide' },
        panel('Needs attention',
          summary.open.length
            ? h('ul', { class: 'alert-list' }, summary.open.map((alert) => card(alert, allowed)))
            : h('p', { class: 'muted' }, 'Nothing right now. Quiet is the goal.'),
        ),
        panel('Closures',
          ZONES.map((zone) => h('div', { class: 'zone-row' },
            h('span', {}, zone.name),
            h('input', {
              type: 'checkbox', checked: world.zonesOn.includes(zone.id), disabled: !can(role, 'zone.manage'), 'aria-label': `Watch ${zone.name}`,
              onChange: (event) => { setZone(world, zone.id, event.target.checked); render(); },
            }))),
          h('p', { class: 'muted small' }, 'You’re alerted once per route per day when a vehicle enters a closure.'),
        ),
      ),
      panel('History',
        summary.history.length
          ? table(['Alert', 'Opened', 'Outcome'], summary.history.slice(0, 15).map((alert) => [
              alert.title, formatTime(alert.openedAt), badge(...OUTCOME[alert.status]),
            ]))
          : h('p', { class: 'muted' }, 'Closed alerts appear here, with what came of them.'),
      ),
    );
  }
  render();
}
