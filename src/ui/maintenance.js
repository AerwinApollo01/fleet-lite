import { can, roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { workLabel } from '../scenarios/components.js';
import { completeService, maintenanceView, scheduleService } from '../scenarios/maintenance.js';
import { badge, h, panel, table } from './dom.js';

const STATE = { OVERDUE: ['✕ Overdue', 'bad'], DUE_SOON: ['! Due soon', 'warn'] };

function dueText(item) {
  if (item.remainingKm < 0) return `${Math.abs(item.remainingKm)} km over`;
  if (item.remainingKm < 15) return 'Due now';
  return `${item.remainingKm} km left, about ${item.days} day${item.days === 1 ? '' : 's'}`;
}

export function mountMaintenance(root, { world }) {
  function render() {
    const view = maintenanceView(world);
    const role = roleOf(world);
    const canSchedule = can(role, 'service.schedule');
    const canComplete = can(role, 'service.complete');
    const needsWork = view.overdue + view.broken.length;

    root.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)}`),
          h('div', { class: 'hero' }, h('span', { class: 'hero-num' }, needsWork), h('span', { class: 'hero-of' }, `item${needsWork === 1 ? ' needs' : 's need'} work now`)),
          h('p', { class: 'muted' }, `${view.dueSoon} more due soon. ${view.scheduled.length} work order${view.scheduled.length === 1 ? '' : 's'} open.`),
        ),
        h('div', { class: 'toolbar end' }, h('button', { onClick: () => { advanceFleet(world, 24); render(); } }, 'Advance 1 day')),
      ),
      view.broken.length > 0 && h('p', { class: 'callout warn' }, `Faulted now: ${view.broken.map((v) => v.vin).join(', ')}. These are software faults, so the fix is a rollback rather than a repair.`),
      h('div', { class: 'grid wide' },
        panel('Coming due',
          view.work.length
            ? table(['Vehicle', 'Work', 'Status', 'Remaining', ''], view.work.map((item) => [
                item.vin, item.label, badge(...STATE[item.status]), dueText(item),
                item.order
                  ? badge('Scheduled')
                  : canSchedule && h('button', { class: 'small', onClick: () => { scheduleService(world, item.vin, item.id); render(); } }, 'Schedule'),
              ]))
            : h('p', { class: 'muted' }, 'Nothing is due.'),
          h('p', { class: 'muted small' }, 'Remaining distance is an estimate from the measured odometer.'),
        ),
        panel('Work orders',
          view.scheduled.length
            ? table(['Order', 'Vehicle', 'Work', ''], view.scheduled.map((order) => [
                `#${order.id}`, order.vin, workLabel(order.itemId),
                canComplete
                  ? h('button', { class: 'primary small', onClick: () => { completeService(world, order.id); render(); } }, 'Mark done')
                  : badge('Waiting on service'),
              ]))
            : h('p', { class: 'muted' }, 'No open work orders.'),
          h('p', { class: 'muted small' }, 'Work happens off shift, so it doesn’t take a vehicle off a route.'),
        ),
      ),
      panel('Battery health',
        h('p', {}, `${view.lowBattery} vehicle${view.lowBattery === 1 ? '' : 's'} below 90% health. `, badge('Estimate', 'warn')),
        h('p', { class: 'muted small' }, 'Needs the Battery health reports feature, which is on from the factory.'),
      ),
    ].filter(Boolean));
  }
  render();
}
