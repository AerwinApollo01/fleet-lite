// The Event log tab: every entry for one vehicle, filterable, with the snapshot behind each one.
import { roleOf } from '../core/roles.js';
import { DAY, formatTime } from '../core/time.js';
import { COMPONENTS } from '../scenarios/components.js';
import { eventLogFor, filterLog, KINDS, SEVERITIES } from '../scenarios/eventlog.js';
import { badge, h, panel } from './dom.js';

const PAGE = 50;
const TONE = { fault: ['✕ Fault', 'bad'], watch: ['! Watch', 'warn'], info: ['Info', 'neutral'] };
const STATUS = { normal: '', caution: ' !', limit: ' ✕' };

export const logTime = (t) => (t >= 0 ? formatTime(t) : `${Math.ceil(-t / DAY)} days before Day 1`);
const readingText = ({ value, unit }) => `${value}${unit === '%' || unit === '°C' ? '' : ' '}${unit}`;

function details(entry) {
  const facts = [
    ['Firmware at the time', entry.firmware],
    ...(entry.km ? [['Odometer', `${entry.km.toLocaleString('en-US')} km`]] : []),
    ['Happened', logTime(entry.at)],
    ['Arrived', `${logTime(entry.receivedAt)}${entry.late ? ', from the vehicle’s buffer' : ''}`],
    ['Log entry', `#${entry.seq}`],
  ];
  return h('div', { class: 'log-detail' },
    h('div', {}, h('p', { class: 'label' }, 'Context'), h('dl', { class: 'facts' }, facts.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]))),
    entry.freeze?.length > 0 && h('div', {},
      h('p', { class: 'label' }, 'Freeze frame: related readings at that moment'),
      h('dl', { class: 'facts' }, entry.freeze.flatMap((item) => [h('dt', {}, item.label), h('dd', {}, `${readingText(item)}${STATUS[item.status]}`)]))),
    entry.frame && h('div', {},
      h('p', { class: 'label' }, 'CAN frame (simulated)'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'ID'), h('dd', {}, h('code', {}, entry.frame.id)),
        h('dt', {}, 'Data'), h('dd', {}, h('code', {}, entry.frame.data)),
        h('dt', {}, 'Raw'), h('dd', {}, entry.frame.raw),
        h('dt', {}, 'Decode'), h('dd', {}, entry.frame.formula),
        h('dt', {}, 'Value'), h('dd', {}, readingText(entry.frame)))),
  );
}

export function eventLogPanel({ world, vin, ui }) {
  const entries = eventLogFor(world, vin, roleOf(world));
  const list = h('div', {});

  function drawList() {
    const found = filterLog(entries, ui);
    const pages = Math.max(1, Math.ceil(found.length / PAGE));
    ui.page = Math.min(ui.page, pages);
    const rows = found.slice((ui.page - 1) * PAGE, ui.page * PAGE);
    const body = rows.flatMap((entry) => [
      h('tr', { class: ui.open === entry.seq ? 'selected' : '' },
        h('td', {}, logTime(entry.at), entry.late ? ' ' : '', entry.late ? badge('Arrived late') : ''),
        h('td', {}, entry.partLabel ?? '—'),
        h('td', {}, badge(...TONE[entry.severity])),
        h('td', {}, h('button', {
          class: 'link', 'aria-expanded': ui.open === entry.seq ? 'true' : 'false',
          onClick: () => { ui.open = ui.open === entry.seq ? null : entry.seq; drawList(); },
        }, entry.text)),
        h('td', {}, entry.code ?? '—'),
        h('td', {}, entry.reading ? `${readingText(entry.reading)} (limit ${entry.reading.limit})` : '—'),
      ),
      ui.open === entry.seq && h('tr', {}, h('td', { colspan: 6 }, details(entry))),
    ].filter(Boolean));
    list.replaceChildren(
      found.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['When', 'Part', 'Severity', 'Event', 'Code', 'Reading'].map((text) => h('th', {}, text)))),
            h('tbody', {}, body)))
        : h('p', { class: 'muted empty' }, entries.length ? 'No entries match these filters.' : 'No events recorded for this vehicle yet.'),
      h('div', { class: 'pager' },
        h('span', { class: 'muted' }, `${found.length} of ${entries.length} entries`),
        pages > 1 && h('div', { class: 'pager-buttons' },
          h('button', { disabled: ui.page === 1, 'aria-label': 'Previous page', onClick: () => { ui.page -= 1; drawList(); } }, '‹'),
          h('span', { class: 'muted' }, `Page ${ui.page} of ${pages}`),
          h('button', { disabled: ui.page === pages, 'aria-label': 'Next page', onClick: () => { ui.page += 1; drawList(); } }, '›'))),
    );
  }

  const select = (key, label, options) => h('label', { class: 'log-filter' },
    h('span', { class: 'muted' }, label),
    h('select', { onChange: (event) => { ui[key] = event.target.value; ui.page = 1; ui.open = null; drawList(); } },
      h('option', { value: '' }, 'All'),
      options.map(([value, text]) => h('option', { value, selected: value === ui[key] }, text))));

  const kinds = Object.entries(KINDS).filter(([kind]) => entries.some((entry) => entry.kind === kind));
  const panelNode = panel('Event log',
    h('p', { class: 'muted small log-note' }, 'Newest first, by when it happened. Entries are never edited, so a correction appears as a new entry. Select an event to see its details.'),
    h('div', { class: 'toolbar tight' },
      select('part', 'Part', COMPONENTS.map((component) => [component.id, component.label])),
      select('kind', 'Type', kinds),
      select('severity', 'Severity', Object.entries(SEVERITIES)),
      h('input', { type: 'search', class: 'search', placeholder: 'Search codes and events', 'aria-label': 'Search the event log', value: ui.search, onInput: (event) => { ui.search = event.target.value; ui.page = 1; ui.open = null; drawList(); } }),
    ),
    list,
  );
  drawList();
  return panelNode;
}
