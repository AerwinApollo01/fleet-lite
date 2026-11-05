import { can, roleOf } from '../core/roles.js';
import { at, formatTime } from '../core/time.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { reportsCsv, todaySoFar, whoHad } from '../scenarios/reports.js';
import { h, panel, table } from './dom.js';

const lookup = { vin: 'V-001', day: 1, time: '09:00' };

function download(text) {
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: 'fleet-daily-report.csv' });
  link.click();
  URL.revokeObjectURL(link.href);
}

function onTimeChart(reports) {
  const recent = reports.slice(-14);
  return h('div', {},
    h('div', { class: 'bars', role: 'img', 'aria-label': `On-time rate for the last ${recent.length} days. The table below has the same data.` },
      recent.map((r) => h('div', { class: 'bar', style: `height:${r.onTimePct}%`, title: `Day ${r.day}: ${r.onTimePct}% on time, ${r.finished} of ${r.routes} routes` }, h('span', {}, `${r.onTimePct}%`)))),
    h('div', { class: 'bar-labels' }, recent.map((r) => h('span', {}, `Day ${r.day}`))),
  );
}

export function mountReports(root, { world }) {
  function custodySlot() {
    const [hour, minute] = lookup.time.split(':').map(Number);
    const result = whoHad(world, lookup.vin, at(lookup.day, hour, minute));
    return result.driver
      ? h('p', {}, h('strong', {}, result.driver), ` on ${result.routeId} in ${result.area}. ${result.note}`)
      : h('p', { class: 'muted' }, result.note);
  }

  function render() {
    const today = todaySoFar(world);
    const { reports } = world;
    const answer = h('div', {}, custodySlot());
    const refresh = () => answer.replaceChildren(custodySlot());

    root.replaceChildren(...[
      h('div', { class: 'ops-head' },
        h('div', {},
          h('p', { class: 'label inline' }, `Harbor Routes · ${formatTime(world.now)}`),
          h('h2', {}, 'Daily results'),
          h('p', { class: 'muted' }, 'Each day closes at the end of the shift and doesn’t change after that.'),
        ),
        h('div', { class: 'toolbar end' },
          h('button', { onClick: () => { advanceFleet(world, 24); render(); } }, 'Advance 1 day'),
          can(roleOf(world), 'report.export') && h('button', { disabled: !reports.length, onClick: () => download(reportsCsv(world)) }, 'Export CSV'),
        ),
      ),
      today && h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Today, on track'), h('strong', {}, `${today.onTimePct}%`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Distance so far'), h('strong', {}, `${today.km} km`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Swaps today'), h('strong', {}, today.swaps)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Alerts today'), h('strong', {}, today.alerts)),
      ),
      panel('Routes finished on time',
        reports.length
          ? [onTimeChart(reports),
            table(['Day', 'Finished', 'On time', 'Distance', 'Energy (est.)', 'Uptime', 'Swaps', 'Alerts', 'Acted on'],
              [...reports].reverse().map((r) => [`Day ${r.day}`, `${r.finished} of ${r.routes}`, `${r.onTimePct}%`, `${r.km} km`, `${r.energyKwh} kWh`, `${r.uptimePct}%`, r.swaps, r.alerts, r.alertsActed]))]
          : h('p', { class: 'muted' }, 'No closed days yet. Advance past the end of a shift to see the first one.'),
      ),
      panel('Who had this vehicle?',
        h('div', { class: 'lookup' },
          h('label', { class: 'inline-field' }, 'Vehicle',
            h('select', { 'aria-label': 'Vehicle', onChange: (e) => { lookup.vin = e.target.value; refresh(); } },
              world.fleet.map((v) => h('option', { value: v.vin, selected: v.vin === lookup.vin }, v.vin)))),
          h('label', { class: 'inline-field' }, 'Day',
            h('input', { type: 'number', min: 1, value: lookup.day, 'aria-label': 'Day', onInput: (e) => { lookup.day = Math.max(1, Number(e.target.value) || 1); refresh(); } })),
          h('label', { class: 'inline-field' }, 'Time',
            h('input', { type: 'time', value: lookup.time, 'aria-label': 'Time', onInput: (e) => { if (e.target.value) { lookup.time = e.target.value; refresh(); } } })),
        ),
        answer,
      ),
    ].filter(Boolean));
  }
  render();
}
