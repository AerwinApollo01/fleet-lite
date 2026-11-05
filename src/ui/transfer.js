import { advanceTransfer, createTransferWorld, TRANSFER_STEPS, VIN } from '../scenarios/transfer.js';
import { transferViews } from '../scenarios/transfer.js';
import { ownerAt } from '../core/identity.js';
import { formatTime } from '../core/time.js';
import { badge, h, panel, table } from './dom.js';

const REASONS = { 'valid-lease': 'valid lease', 'no-lease': 'no lease', 'lease-expired': 'lease expired' };

function tenantPanel(view, done) {
  const leaked = view.naiveTrips.filter((t) => !view.trips.some((own) => own.eventId === t.eventId));
  return panel(view.fleetId,
    view.trips.length
      ? table(['Trip', 'Happened', 'Arrived', 'km'], view.trips.map((t) => [
          t.eventId, formatTime(t.at), formatTime(t.receivedAt), t.data.km,
        ]))
      : h('p', { class: 'muted' }, 'No trips visible to this operator.'),
    h('p', { class: 'label' }, 'Entitlements visible now'),
    view.entitlements.length
      ? h('ul', { class: 'plain' }, view.entitlements.map((e) => h('li', {}, e.feature, ' ', badge(e.scope))))
      : h('p', { class: 'muted' }, 'None. This operator does not own the vehicle right now.'),
    done && leaked.length > 0 &&
      h('p', { class: 'callout warn' },
        `Attributing by arrival time would have shown ${leaked.map((t) => t.eventId).join(', ')} to this operator. That is the other operator's driver and route.`),
  );
}

export function mountTransfer(root) {
  let world = createTransferWorld();

  function render() {
    const next = TRANSFER_STEPS[world.stepIndex];
    const done = !next;
    const owner = world.stepIndex === 0 ? null : ownerAt(world.reg, VIN, world.now);

    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'Vehicle transfer'),
        h('p', {}, 'The hard case: the vehicle is offline, with an unsent trip, at the moment it changes hands.'),
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', disabled: done, onClick: () => { advanceTransfer(world); render(); } },
          done ? 'Scenario complete' : `Step ${world.stepIndex + 1} of ${TRANSFER_STEPS.length}: ${next.title}`),
        h('button', { onClick: () => { world = createTransferWorld(); render(); } }, 'Reset'),
        h('span', { class: 'status' },
          world.stepIndex > 0 ? formatTime(world.now) : 'Not started', ' · ',
          'Owner: ', owner ?? 'nobody', ' · ',
          world.vehicle.online ? badge('Online', 'good') : badge('Offline', 'warn'),
          world.vehicle.buffer.length > 0 && badge(`${world.vehicle.buffer.length} buffered`, 'warn'),
        ),
      ),
      h('div', { class: 'grid two' }, transferViews(world).map((view) => tenantPanel(view, done))),
      h('div', { class: 'grid two' },
        panel('What happened',
          world.log.length
            ? h('ol', { class: 'timeline' }, world.log.map((entry) =>
                h('li', {}, h('strong', {}, entry.title), h('span', { class: 'muted' }, formatTime(entry.at)), h('p', {}, entry.note))))
            : h('p', { class: 'muted' }, 'Run the first step to begin.'),
        ),
        panel('Start attempts on the vehicle',
          world.starts.length
            ? table(['When', 'Driver', 'Result', 'Decided by'], world.starts.map((s) => [
                formatTime(s.at), s.driverId,
                badge(s.allowed ? 'Started' : `Denied: ${REASONS[s.reason]}`, s.allowed ? 'good' : 'bad'),
                s.decidedFrom === 'fresh-sync' ? 'Cloud sync' : 'Vehicle cache',
              ]))
            : h('p', { class: 'muted' }, 'No start attempts yet.'),
        ),
      ),
    );
  }
  render();
}
