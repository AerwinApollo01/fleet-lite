// The Issues view in Assets: a finding, the options and what they cost, the fix, and the measured result.
import { can, roleOf, ROLES } from '../core/roles.js';
import { formatTime } from '../core/time.js';
import { advanceFleet } from '../scenarios/fleet.js';
import { chooseFix, closeIssue, findings, fixedCount, fixOptions, groupSize, issueWeekly, measureIssue, openIssue } from '../scenarios/issues.js';
import { weeklyColumns } from './charts.js';
import { badge, h, panel } from './dom.js';

const STEPS = [['open', 'Decide'], ['fixing', 'Fix'], ['measuring', 'Measure'], ['closed', 'Closed']];
const STATUS = { open: ['Needs a decision', 'warn'], fixing: ['Fixing', 'neutral'], measuring: ['Measuring', 'neutral'], monitoring: ['Monitoring', 'neutral'], closed: ['Closed', 'good'] };
const VERDICT = {
  early: ['Too early to tell', 'neutral', 'Not enough distance yet. A few quiet days prove nothing.'],
  working: ['✓ Working', 'good', 'Failures are clearly below what the old rate predicted.'],
  'not-proven': ['! Not proven', 'warn', 'Failures aren’t clearly below the old rate. It may need more time, or the fix may not be enough.'],
};
const usd = (value) => `$${Math.round(value).toLocaleString('en-US')}`;
const num = (value) => value.toLocaleString('en-US');

export function issuesLens({ world, ui, refresh, setFleetSize, goTo }) {
  const role = roleOf(world);
  const allowed = can(role, 'issue.manage');
  const list = findings(world);
  const act = (fn) => {
    try { ui.error = null; fn(); } catch (error) { ui.error = error.message; }
    refresh();
  };
  const selected = world.issues.find((issue) => issue.id === ui.issue) ?? world.issues.at(-1) ?? null;

  function findingRow(item) {
    return h('div', { class: 'finding' },
      h('div', {}, h('strong', {}, `${item.partLabel}: ${item.groupLabel}`), h('p', { class: 'muted' }, `Fails ${item.timesRest}× as often as the rest of the fleet.`)),
      item.issue
        ? h('button', { class: 'link', onClick: () => { ui.issue = item.issue.id; refresh(); } }, `Issue #${item.issue.id}`)
        : item.closed
          ? badge(`Closed in issue #${item.closed.id}`, 'good')
          : allowed
            ? h('button', { class: 'primary', onClick: () => act(() => { ui.issue = openIssue(world, item.partId, item.groupKey).id; }) }, 'Open an issue')
            : badge('No issue yet'),
    );
  }

  function stepper(issue) {
    const index = STEPS.findIndex(([id]) => id === (issue.status === 'monitoring' ? 'measuring' : issue.status));
    return h('ol', { class: 'issue-steps' }, h('li', { class: 'done' }, 'Found'),
      STEPS.map(([id, label], i) => h('li', { class: i < index ? 'done' : i === index ? 'now' : '', 'aria-current': i === index ? 'step' : null }, id === 'measuring' && issue.status === 'monitoring' ? 'Monitor' : label)));
  }

  function optionsTable(issue) {
    const estimate = fixOptions(world, issue);
    return h('div', {},
      h('p', { class: 'muted small' }, `About ${num(estimate.failuresPerYear)} failures a year at ${usd(estimate.failureUsd)} each, counting a truck roll, repair, part, and a lost day. Every figure here is an assumption.`),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Option', 'Up front', 'Failures avoided a year', 'Saving a year', 'Payback', '3-year net', ''].map((text) => h('th', {}, text)))),
        h('tbody', {}, estimate.options.map((option) => h('tr', {},
          h('td', {}, h('strong', {}, option.label), h('p', { class: 'muted small tight' }, option.detail)),
          h('td', {}, option.upfrontUsd ? usd(option.upfrontUsd) : '—'),
          h('td', {}, option.avoidedPerYear ? num(option.avoidedPerYear) : '—'),
          h('td', {}, option.recoverUsd !== undefined ? `Recovers ${usd(option.recoverUsd)} once` : option.savingPerYearUsd ? usd(option.savingPerYearUsd) : '—'),
          h('td', {}, option.paybackMonths === null ? '—' : `${option.paybackMonths} months`),
          h('td', {}, option.id === 'claim' || option.id === 'monitor' ? '—' : usd(option.threeYearNetUsd)),
          h('td', {}, allowed && h('button', { class: 'small', onClick: () => act(() => chooseFix(world, issue.id, option.id)) }, 'Choose')),
        ))))),
      !allowed && h('p', { class: 'muted small' }, 'An owner or engineer makes this decision.'),
    );
  }

  function progress(issue) {
    const done = fixedCount(world, issue);
    const total = groupSize(world, issue);
    const canSeeRollout = ROLES[role].tabs.includes('ota');
    return h('div', {},
      h('div', { class: 'bar-row wide' }, h('span', {}, 'Vehicles fixed'), h('span', { class: 'bar' }, h('i', { style: `width:${(done / total) * 100}%` })), h('strong', {}, `${num(done)} of ${num(total)}`)),
      h('p', { class: 'muted small' }, issue.fix.id === 'ota'
        ? 'Goes through the normal staged rollout, so it installs off shift and has to pass each gate. Vehicles with no signal catch up later.'
        : 'The shop works through about 40 vehicles a day.'),
      issue.fix.id === 'ota' && canSeeRollout && h('button', { class: 'link', onClick: () => goTo('ota') }, 'See the rollout'),
    );
  }

  function result(issue) {
    const measured = measureIssue(world, issue);
    const [label, tone, note] = VERDICT[measured.verdict];
    const net = measured.avoidedUsd + issue.recoveredUsd - issue.spentUsd;
    const fact = (name, value) => h('div', { class: 'stat' }, h('span', { class: 'label' }, name), h('strong', {}, value));
    return h('div', {},
      h('div', { class: 'issue-result' }, badge(label, tone), h('p', {}, note)),
      h('div', { class: 'grid stats' },
        fact('Failures since the fix', num(measured.actual)),
        fact('The old rate predicted', num(measured.expected)),
        fact('Measured change', measured.changePct === null ? '—' : `${measured.changePct}%`),
        fact('Forecast change', `${measured.forecastPct}%`),
      ),
      h('p', { class: 'muted small' }, `Across ${num(measured.km)} km on ${num(measured.vehicles)} fixed vehicles. So far: ${usd(issue.spentUsd)} spent, ${usd(measured.avoidedUsd)} avoided, ${usd(issue.recoveredUsd)} recovered, ${net >= 0 ? `${usd(net)} ahead` : `${usd(-net)} behind`}.`),
    );
  }

  function detail(issue) {
    const measured = ['fixing', 'measuring', 'closed'].includes(issue.status) && issue.fix?.id !== 'monitor';
    return panel(`Issue #${issue.id}: ${issue.partLabel}, ${issue.groupLabel}`,
      h('div', { class: 'issue-head' }, badge(...STATUS[issue.status]), h('span', { class: 'muted' }, `Opened ${formatTime(issue.openedAt)}. ${issue.fix ? issue.fix.label : 'No fix chosen yet'}.`)),
      stepper(issue),
      issue.status === 'open' && optionsTable(issue),
      issue.status === 'fixing' && progress(issue),
      measured && result(issue),
      measured && h('div', { class: 'issue-chart' }, weeklyColumns(issueWeekly(world, issue), `${issue.partLabel} failures per week, ${issue.groupLabel}`)),
      h('div', { class: 'tw-actions' },
        issue.status !== 'closed' && h('button', { onClick: () => { advanceFleet(world, 24 * 7); refresh(); } }, '+7 days'),
        allowed && ['measuring', 'monitoring'].includes(issue.status) && h('button', {
          class: 'primary', disabled: issue.status === 'measuring' && measureIssue(world, issue).verdict === 'early',
          onClick: () => act(() => closeIssue(world, issue.id)),
        }, 'Close the issue'),
      ),
      h('p', { class: 'label' }, 'Decision log'),
      h('ol', { class: 'timeline compact' }, [...issue.log].reverse().map((entry) => h('li', {}, h('span', { class: 'muted' }, formatTime(entry.at)), h('p', {}, entry.text)))),
    );
  }

  return h('div', {},
    ui.error && h('p', { class: 'callout warn' }, ui.error),
    panel('Findings',
      list.length
        ? list.map(findingRow)
        : h('div', { class: 'fw-cta' },
            h('p', { class: 'muted' }, 'No supplier or hardware group stands out yet. A small fleet rarely has enough failures to prove a pattern.'),
            world.fleet.length < 5000 && h('button', { class: 'primary', onClick: () => setFleetSize(5000) }, 'Switch to 5,000 vehicles')),
    ),
    world.issues.length > 1 && h('div', { class: 'view-chips', role: 'group', 'aria-label': 'Issues' },
      world.issues.map((issue) => h('button', {
        class: issue === selected ? 'chip active' : 'chip', 'aria-pressed': issue === selected ? 'true' : 'false',
        onClick: () => { ui.issue = issue.id; refresh(); },
      }, `#${issue.id} ${issue.partLabel}`))),
    selected && detail(selected),
  );
}
