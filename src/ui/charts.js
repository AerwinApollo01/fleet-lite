// Small charts shared by the vehicle and fleet views.
import { bandStatus } from '../scenarios/components.js';
import { badge, h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

const unitText = (unit) => (unit === '%' || unit === '°C' ? unit : unit ? ` ${unit}` : '');
const defined = (...values) => values.filter((value) => value !== undefined);
const STATUS_TEXT = { normal: '✓ In its normal range', caution: '! Outside its normal range', limit: '✕ At its limit' };

export function toleranceText({ bands: { min, low, high, max }, unit }) {
  const u = unitText(unit);
  const normal = low !== undefined && high !== undefined ? `${low}–${high}${u}` : high !== undefined ? `up to ${high}${u}` : `${low}${u} and above`;
  const limits = defined(min, max).map((value) => `${value}${u}`).join(' and ');
  return `Normal ${normal}. ${defined(min, max).length > 1 ? 'Limits' : 'Limit'} ${limits}.`;
}

// The visible range, wide enough for every band and every reading, with a little room around them.
function domain(signal, values, { gauge = false } = {}) {
  const { min, low, high, max } = signal.bands;
  // A one-sided gauge still needs its normal zone, so it runs to the far end of the scale.
  const lo = Math.min(...values, ...defined(min, low), ...(gauge && min === undefined && low === undefined ? [0] : []));
  const hi = Math.max(...values, ...defined(high, max), ...(gauge && high === undefined && max === undefined ? [100] : []));
  const pad = (hi - lo || 1) * 0.08;
  return [lo - pad, hi + pad];
}

// A simple gauge: where the reading sits against the part's operating range.
export function rangeBar(signal, { numbers = false } = {}) {
  const [lo, hi] = domain(signal, [signal.value], { gauge: true });
  const { min, low, high, max } = signal.bands;
  const edges = [lo, ...defined(min, low, high, max), hi];
  const share = (value) => ((value - lo) / (hi - lo)) * 100;
  const zones = edges.slice(1).map((edge, i) => {
    const middle = (edges[i] + edge) / 2;
    return h('i', { class: `zone ${bandStatus(middle, signal.bands)}`, style: `width:${share(edge) - share(edges[i])}%` });
  });
  return h('div', { class: 'range' },
    h('div', { class: 'range-head' }, h('span', {}, signal.label), numbers && h('strong', {}, `${signal.value}${unitText(signal.unit)}`)),
    h('div', { class: 'range-bar', role: 'img', 'aria-label': `${signal.label}: ${STATUS_TEXT[signal.status]}` }, zones, h('b', { style: `left:${share(signal.value)}%` })),
    h('p', { class: `range-note ${signal.status}` }, STATUS_TEXT[signal.status]),
  );
}

export function sparkline(signal) {
  const [W, H, PAD] = [320, 96, 6];
  const values = signal.points.map((p) => p.value);
  const [lo, hi] = domain(signal, values);
  const x = (i) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const unit = unitText(signal.unit);
  const { min, low, high, max } = signal.bands;
  const zone = (from, to, tone) => (from === undefined || to === undefined ? '' : `<rect class="spark-zone ${tone}" x="${PAD}" width="${W - PAD * 2}" y="${Math.min(y(from), y(to))}" height="${Math.abs(y(from) - y(to))}"/>`);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const chart = h('div', { class: 'spark' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  chart.innerHTML = `<svg xmlns="${SVG}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${signal.label} over 30 days, now ${values.at(-1)}${unit}. ${toleranceText(signal)}">
    ${zone(high, max ?? hi, 'caution')}${zone(max, max === undefined ? undefined : hi, 'limit')}${zone(low, min ?? lo, 'caution')}${zone(min, min === undefined ? undefined : lo, 'limit')}
    <path class="spark-line" d="${line}"/>
    <circle class="spark-end" cx="${x(values.length - 1)}" cy="${y(values.at(-1))}" r="4"/>
    <circle class="spark-hover" r="4" hidden/>
  </svg>`;
  chart.append(tip);
  const dot = chart.querySelector('.spark-hover');
  chart.addEventListener('mousemove', (event) => {
    const box = chart.getBoundingClientRect();
    const i = Math.max(0, Math.min(values.length - 1, Math.round(((event.clientX - box.left) / box.width) * (values.length - 1))));
    const point = signal.points[i];
    dot.removeAttribute('hidden');
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(point.value));
    tip.hidden = false;
    tip.replaceChildren(h('strong', {}, `${point.value}${unit}`), h('span', {}, point.ago === 0 ? 'Latest' : `${point.ago} day${point.ago === 1 ? '' : 's'} ago`));
    tip.style.left = `${Math.min(event.clientX - box.left + 10, box.width - tip.offsetWidth - 2)}px`;
    tip.style.top = '4px';
  });
  chart.addEventListener('mouseleave', () => { tip.hidden = true; dot.setAttribute('hidden', ''); });
  return h('div', {},
    h('div', { class: 'spark-head' },
      h('span', {}, signal.label, ' ', badge(signal.provenance === 'measured' ? 'Measured' : 'Estimate', signal.provenance === 'measured' ? 'neutral' : 'warn')),
      h('strong', {}, `${values.at(-1)}${unit}`)),
    chart,
    h('div', { class: 'spark-axis muted' }, h('span', {}, '30 days ago'), h('span', {}, 'Latest')),
    h('p', { class: 'muted small spark-tol' }, toleranceText(signal)),
  );
}

// One column per week, oldest first, with the count on hover.
export function weeklyColumns(weeks, label) {
  const top = Math.max(...weeks, 1);
  const total = weeks.reduce((sum, count) => sum + count, 0);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const chart = h('div', { class: 'columns', role: 'img', 'aria-label': `${label}: ${total} over ${weeks.length} weeks, ${weeks.at(-1)} in the latest week` },
    weeks.map((count, i) => {
      const ago = weeks.length - 1 - i;
      return h('span', {
        class: 'column',
        onMouseenter: (event) => {
          tip.hidden = false;
          tip.replaceChildren(h('strong', {}, `${count.toLocaleString('en-US')} failure${count === 1 ? '' : 's'}`), h('span', {}, ago === 0 ? 'Latest week' : `${ago} week${ago === 1 ? '' : 's'} ago`));
          const box = chart.getBoundingClientRect();
          tip.style.left = `${Math.min(event.currentTarget.getBoundingClientRect().left - box.left, box.width - tip.offsetWidth - 2)}px`;
          tip.style.top = '0';
        },
        onMouseleave: () => { tip.hidden = true; },
      }, h('i', { style: `height:${count ? Math.max(4, (count / top) * 100) : 0}%` }));
    }), tip);
  return h('div', {},
    h('div', { class: 'spark-head' }, h('span', {}, label, ' ', badge('Simulated')), h('strong', {}, total.toLocaleString('en-US'))),
    chart,
    h('div', { class: 'spark-axis muted' }, h('span', {}, `${weeks.length} weeks ago`), h('span', {}, 'Latest week')),
  );
}
