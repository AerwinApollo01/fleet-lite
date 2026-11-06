// The Firmware tab of a vehicle: what each part runs, and an update you can run step by step.
import { can, roleOf } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { firmwareView, hoursToOffShift, NOT_UPDATABLE, runUpdate, startUpdate, stepUpdate, TIERS } from '../scenarios/firmware.js';
import { badge, h, table } from './dom.js';

const RESULT = { done: ['Installed', 'good'], reverted: ['Rolled back', 'warn'], stopped: ['Stopped', 'warn'], 'needs-service': ['Needs a technician', 'bad'] };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const slotText = (row) => (row.slots === 2
  ? `Two slots: ${row.slot} running, other holds ${row.spare}`
  : `One slot, ${row.recovery ? 'recoverable' : 'no recovery path'}`);

function versionCell(row) {
  if (row.state === 'bricked') return badge('✕ Won’t start', 'bad');
  if (row.state === 'recovery') return badge('! Waiting to reflash', 'warn');
  return row.version === row.inRelease ? row.version : h('span', {}, row.version, ' ', badge(`Set: ${row.inRelease}`, 'warn'));
}

export function firmwarePanels({ world, vin, ui, selected, refresh }) {
  const view = firmwareView(world, vin);
  const role = roleOf(world);
  const allowed = can(role, 'firmware.update');
  const job = view.job?.status === 'running' ? view.job : null;
  const option = view.options.find((item) => item.id === ui.target) ?? view.options.find((item) => item.plan.changes.length) ?? view.options[0];
  const changing = new Set((job ? job.changes.slice(0) : option.plan.changes).map((change) => change.part));
  const act = (fn) => { fn(); refresh(); };

  const states = Object.fromEntries([
    ...view.rows.map((row) => {
      if (row.state === 'bricked') return [row.id, { state: 'fault', stateLabel: 'Won’t start' }];
      return [row.id, changing.has(row.id) && row.version !== (job?.changes.find((c) => c.part === row.id)?.to) ? { state: 'watch', stateLabel: `${row.version}, will change` } : { state: 'ok', stateLabel: `Firmware ${row.version}` }];
    }),
  ]);

  function progress() {
    return h('div', {},
      h('p', { class: 'label' }, job.label),
      h('ol', { class: 'fw-steps' }, job.steps.map((step, i) => {
        const tone = i < job.index ? 'done' : i === job.index ? 'now' : '';
        return h('li', { class: tone, 'aria-current': i === job.index ? 'step' : null }, h('span', {}, i < job.index ? '✓' : i === job.index ? '▸' : '·'), step.label);
      })),
      allowed
        ? h('div', { class: 'tw-actions' },
            h('button', { class: 'primary', onClick: () => act(() => stepUpdate(world, vin)) }, 'Next step'),
            h('button', { onClick: () => act(() => runUpdate(world, vin)) }, 'Run to the end'))
        : h('p', { class: 'muted small' }, 'A technician or engineer is running this update.'),
    );
  }

  function chooser() {
    const { plan } = option;
    return h('div', {},
      h('fieldset', { class: 'fw-options' },
        h('legend', {}, 'Update to'),
        view.options.map((item) => h('label', { class: item === option ? 'active' : '' },
          h('input', { type: 'radio', name: 'fw-target', checked: item === option, onChange: () => { ui.target = item.id; ui.problem = ''; refresh(); } }),
          h('span', {}, h('strong', {}, item.label), h('span', { class: 'muted' }, `${item.kind} · ${item.note}`)),
        ))),
      plan.changes.length > 0 && table(['Part', 'From', 'To'], plan.changes.map((change) => [change.label, change.from, change.to])),
      plan.changes.length > 0 && h('p', { class: 'muted small' }, `${plan.downloadMb} MB, about ${plural(plan.minutes, 'minute')} parked.`),
      plan.noReturn.length > 0 && h('p', { class: 'muted small' }, `No old copy to fall back on: ${plan.noReturn.join(', ')}.${plan.changes.length > plan.noReturn.length ? ' These flash before the switch.' : ''}`),
      plan.blocked.length > 0 && h('div', { class: 'callout warn fw-blocked' }, plan.blocked.map((reason) => h('p', {}, reason))),
      hoursToOffShift(world.now) > 0 && h('button', { onClick: () => act(() => advanceFleet(world, hoursToOffShift(world.now))) }, 'Skip to end of shift'),
      allowed && plan.changes.length > 0 && h('label', { class: 'fw-problem' },
        h('span', { class: 'muted' }, 'Simulate a problem'),
        h('select', { onChange: (event) => { ui.problem = event.target.value; } },
          h('option', { value: '' }, 'None'),
          plan.problems.map((problem) => h('option', { value: problem.id, selected: problem.id === ui.problem }, problem.label)))),
      allowed
        ? h('div', { class: 'tw-actions' }, h('button', {
            class: 'primary', disabled: plan.blocked.length > 0,
            onClick: () => act(() => { startUpdate(world, vin, option.id, ui.problem || null); ui.problem = ''; }),
          }, 'Start update'))
        : h('p', { class: 'muted small' }, 'A technician or engineer runs updates. You can see what each part is running.'),
    );
  }

  const finished = view.job && !job ? view.job : null;
  const side = h('aside', { class: 'tw-inspector', 'aria-label': 'Update this vehicle' },
    h('div', { class: 'tw-inspector-head' }, h('h3', {}, 'Update this vehicle'), badge(view.label, view.matches ? 'neutral' : 'warn')),
    finished && h('div', { class: 'fw-result' }, badge(...RESULT[finished.status]), h('p', {}, finished.result)),
    view.issues.length > 0 && h('p', { class: 'callout warn' }, view.issues.join('. ')),
    job ? progress() : chooser(),
  );

  const picked = view.rows.find((row) => row.id === selected);
  const none = NOT_UPDATABLE.find((item) => item.id === selected);
  const tierSection = (tier) => {
    const rows = view.rows.filter((row) => row.tier === tier);
    return h('div', { class: 'fw-tier' },
      h('h4', {}, TIERS[tier].label),
      h('p', { class: 'muted small' }, TIERS[tier].summary),
      table(['Part', 'Version', 'Storage', 'Lives on', 'Reaches it through'], rows.map((row) => [
        h('button', { class: row.id === selected ? 'link picked' : 'link', onClick: () => ui.pick(row.id) }, row.label),
        versionCell(row), slotText(row), row.lives, row.path,
      ])),
    );
  };

  const below = [
    h('section', { class: 'panel' },
      h('h3', {}, 'Firmware by part'),
      none && h('p', { class: 'callout neutral' }, `${none.label}: ${none.note}`),
      picked && h('p', { class: 'callout neutral' }, `${picked.label} runs ${picked.version}. ${slotText(picked)}.`),
      ['system', 'domain', 'component'].map(tierSection),
      h('div', { class: 'fw-tier' },
        h('h4', {}, 'No over-the-air firmware'),
        h('ul', { class: 'guide-list' }, NOT_UPDATABLE.map((item) => h('li', {}, h('strong', {}, item.label), `: ${item.note}`)))),
    ),
    h('section', { class: 'panel' },
      h('h3', {}, 'Update log'),
      view.log.length
        ? h('ol', { class: 'timeline compact' }, view.log.map((entry) => h('li', {}, h('span', { class: 'muted' }, formatTime(entry.at)), h('p', {}, entry.text))))
        : h('p', { class: 'muted' }, 'No updates yet.'),
    ),
  ];

  const tierOf = Object.fromEntries(view.rows.map((row) => [row.id, row.tier]));
  return { states, side, below, tierOf };
}
