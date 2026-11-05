import { sampleOvernightParks, ttlTradeoff } from '../core/auth.js';
import { revocationNight } from '../scenarios/revocation.js';
import { badge, h, panel, table } from './dom.js';

const OPTIONS = [2, 4, 8, 10, 12, 24, 72];
const parks = sampleOvernightParks();

const result = (attempt) =>
  attempt.allowed ? badge('Starts', 'good') : badge('Blocked', 'bad');

// Both drivers hold the same lease on a garaged vehicle, so TTL only picks which mistake you make.
function verdict(night) {
  if (night.garaged.revoked.allowed) {
    return `The revoked driver can still start a garaged vehicle at 5am. Their access ends when the lease does, ${(night.exposureMinutes / 60).toFixed(0)} hours after revocation.`;
  }
  return 'The revoked driver is out, but so is the driver who showed up for their shift. Without a fresh lease, the vehicle cannot tell them apart.';
}

export function mountRevocation(root) {
  let ttl = 12;

  function render() {
    const night = revocationNight(ttl);
    const text = verdict(night);

    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'Revoking driver access'),
        h('p', {}, 'Vehicles last synced at 8pm and access is revoked at 9pm. One parks with signal, one in a structure with none. The next shift starts at 5am.'),
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'label inline' }, 'Lease TTL'),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Lease TTL in hours' },
          OPTIONS.map((hours) => h('button', {
            class: hours === ttl ? 'active' : '',
            'aria-pressed': hours === ttl ? 'true' : 'false',
            onClick: () => { ttl = hours; render(); },
          }, `${hours}h`))),
      ),
      h('p', { class: 'callout warn' }, text),
      h('div', { class: 'grid two' },
        panel('5am start attempts',
          table(['Vehicle', 'Revoked driver', 'Legitimate driver'], [
            ['Parked with signal', result(night.connected.revoked), result(night.connected.legit)],
            ['Garaged, no signal', result(night.garaged.revoked), result(night.garaged.legit)],
          ]),
        ),
        panel('The tradeoff across a fleet',
          table(['TTL', 'Worst-case exposure', 'Morning lockouts'], OPTIONS.map((hours) => {
            const row = ttlTradeoff(hours, parks);
            return [
              hours === ttl ? h('strong', {}, `${hours}h`) : `${hours}h`,
              `${row.worstCaseExposureHours}h`,
              `${(row.lockoutRate * 100).toFixed(1)}%`,
            ];
          })),
          h('p', { class: 'muted small' }, 'Illustrative: assumes 30% of vehicles park with no signal and sit 7–12 hours. These are not measured values.'),
        ),
      ),
    );
  }
  render();
}
