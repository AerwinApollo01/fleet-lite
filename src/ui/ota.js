import { halt, isOnShift, ineligible, outstanding, rollbackRemaining, stageStats, startRollback, versionInventory } from '../core/ota.js';
import { formatTime, HOUR } from '../core/time.js';
import { advanceFleet, canStart, entitleInstalled, featureCounts, OWNER, resetFleet, ROLLOUTS, startRollout } from '../scenarios/fleet.js';
import { badge, h, panel, table } from './dom.js';

const STATUS = {
  running: ['Rolling out', 'good'],
  halted: ['Halted', 'bad'],
  rolling_back: ['Rolling back', 'warn'],
  rolled_back: ['Rolled back', 'neutral'],
  complete: ['Complete', 'good'],
};
const EXCLUSIONS = {
  'hardware-missing': 'Hardware can’t host it',
  'over-budget': 'Over compute budget',
  'already-installed': 'Already installed',
};

function vehicleTone(world, vehicle) {
  const { campaign } = world;
  if (vehicle.faulted) return 'fault';
  if (!campaign) return 'base';
  if (ineligible(campaign, world.fleet).includes(vehicle)) return 'base excluded';
  return campaign.applier.needsRevert(campaign, vehicle) ? 'updated' : 'base';
}

const plural = (n) => `${n} vehicle${n === 1 ? '' : 's'}`;

export function mountOta(root, { world }) {
  function render() {
    const { campaign, fleet, now, rollout } = world;
    const stats = campaign ? stageStats(campaign) : { faults: 0, sample: 0 };
    const [statusText, statusTone] = campaign ? STATUS[campaign.status] : ['None running', 'neutral'];
    const faulted = fleet.filter((v) => v.faulted).length;
    const remaining = campaign?.status === 'rolling_back' ? rollbackRemaining(campaign, fleet) : [];
    const waiting = campaign?.status === 'running' ? outstanding(campaign, fleet).length : 0;
    const isFeature = rollout?.kind === 'feature';
    const counts = isFeature ? featureCounts(world, rollout.featureId) : null;
    const exclusions = Object.entries(Object.groupBy(world.excluded, (e) => e.reason));
    const installedHere = isFeature ? fleet.filter((v) => v.reported.installed.includes(rollout.featureId)) : [];
    const unreleased = installedHere.filter((v) => !v.desired.entitled.includes(rollout.featureId)).length;
    const queued = installedHere.filter((v) => v.desired.entitled.includes(rollout.featureId) && !v.reported.entitled.includes(rollout.featureId)).length;
    const canRelease = isFeature && campaign.status === 'complete' && unreleased > 0;

    const sections = [
      h('div', { class: 'intro' },
        h('h2', {}, 'Staged rollout'),
        h('p', {}, 'Firmware and features reach this mixed fleet the same way: staged, gated, off shift, and only where the vehicle can host them.'),
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'label inline' }, 'Start a rollout'),
        ROLLOUTS.map((option) => h('button', {
          disabled: !canStart(world, option),
          onClick: () => { startRollout(world, option.id); render(); },
        }, option.label)),
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', onClick: () => { advanceFleet(world, 6); render(); } }, 'Advance 6 hours'),
        h('button', { onClick: () => { advanceFleet(world, 24); render(); } }, 'Advance 1 day'),
        h('button', { onClick: () => { resetFleet(world); render(); } }, 'Reset fleet'),
        h('span', { class: 'status' }, formatTime(now), ' · ', isOnShift(now) ? badge('On shift: no installs', 'warn') : badge('Off shift', 'good')),
      ),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, rollout?.label ?? 'Campaign'), badge(statusText, statusTone)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Stage'), h('strong', {}, campaign ? campaign.stages[campaign.stageIndex].name : '—')),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Stage faults'), h('strong', {}, `${stats.faults} of ${stats.sample}`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Vehicles faulted'), h('strong', {}, faulted)),
      ),
      h('div', { class: 'grid two' },
        panel('Fleet',
          h('div', { class: 'fleet', role: 'img', 'aria-label': `${fleet.length} vehicles, ${faulted} faulted` },
            fleet.map((v) => h('span', {
              class: `cell ${vehicleTone(world, v)} ${v.online ? '' : 'offline'}`,
              title: `${v.vin} · ${v.hardwareRev} · ${v.version}${v.faulted ? ' · faulted' : ''}${v.online ? '' : ' · no signal'}`,
            }))),
          h('div', { class: 'legend' },
            h('span', {}, h('i', { class: 'cell base' }), 'Not updated'),
            h('span', {}, h('i', { class: 'cell updated' }), 'Updated'),
            h('span', {}, h('i', { class: 'cell fault' }), 'Faulted'),
            h('span', {}, h('i', { class: 'cell base excluded' }), 'Excluded'),
            h('span', {}, h('i', { class: 'cell base offline' }), 'No signal'),
          ),
          table(['Firmware', 'Vehicles'], Object.entries(versionInventory(fleet)).map(([v, n]) => [v, n])),
          isFeature && table(['Feature', 'Installed', 'Active for customers'], [[rollout.label, counts.installed, counts.active]]),
          exclusions.length > 0 && table(['Excluded', 'Vehicles'], exclusions.map(([reason, list]) => [EXCLUSIONS[reason], list.length])),
          canRelease && h('div', { class: 'toolbar tight' },
            h('button', { class: 'primary', onClick: () => { entitleInstalled(world, rollout.featureId); render(); } }, `Release to ${plural(unreleased)}`),
            h('span', { class: 'muted small' }, 'Deployed isn’t released. Customers get it when it’s entitled.')),
          queued > 0 && h('p', { class: 'muted small' }, `${plural(queued)} released but offline. The entitlement lands when they reconnect.`),
          waiting > 0 && h('p', { class: 'muted small' }, `${plural(waiting)} in this stage still waiting for an install window.`),
          remaining.length > 0 && h('p', { class: 'callout warn' }, `Still to revert: ${remaining.map((v) => v.vin).join(', ')}. Rollback finishes when they are off shift and reachable.`),
        ),
        panel('Control',
          campaign
            ? [
                table(['Gate', 'Setting'], [
                  ['Owner', campaign.owner],
                  ['Metric', campaign.gate.metric],
                  ['Threshold', `Over ${campaign.gate.maxRate * 100}% halts`],
                  ['Minimum sample', `${campaign.gate.minSample} installs per stage`],
                  ['Soak', `${campaign.gate.soakMinutes / HOUR} hours after minimum sample`],
                ]),
                h('div', { class: 'toolbar tight' },
                  h('button', { class: 'danger', disabled: campaign.status !== 'running', onClick: () => { halt(campaign, { by: OWNER, at: world.now }); render(); } }, 'Halt rollout'),
                  h('button', { disabled: campaign.status !== 'halted', onClick: () => { startRollback(campaign, { by: OWNER, at: world.now }); render(); } }, 'Start rollback'),
                ),
                h('p', { class: 'label' }, 'Log'),
                h('ol', { class: 'timeline compact' }, [...campaign.log].reverse().map((entry) =>
                  h('li', {}, h('span', { class: 'muted' }, formatTime(entry.at)), h('p', {}, entry.text)))),
              ]
            : h('p', { class: 'muted' }, 'Start a rollout above. Nothing reaches a vehicle any other way.'),
        ),
      ),
    ];
    root.replaceChildren(...sections);
  }
  render();
}
