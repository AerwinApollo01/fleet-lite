// Small charts shared by the vehicle and fleet views.
import { badge, h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

export function sparkline(signal) {
  const [W, H, PAD] = [320, 96, 6];
  const values = signal.points.map((p) => p.value);
  const lo = Math.min(...values, signal.limit);
  const hi = Math.max(...values, signal.limit);
  const span = hi - lo || 1;
  const x = (i) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const unit = signal.unit === '%' || signal.unit === '°C' ? signal.unit : signal.unit ? ` ${signal.unit}` : '';
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const chart = h('div', { class: 'spark' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  chart.innerHTML = `<svg xmlns="${SVG}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${signal.label} over 30 days, now ${values.at(-1)}${unit}, limit ${signal.limit}${unit}">
    <line class="spark-limit" x1="${PAD}" x2="${W - PAD}" y1="${y(signal.limit)}" y2="${y(signal.limit)}"/>
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
    h('div', { class: 'spark-axis muted' }, h('span', {}, '30 days ago'), h('span', {}, `Dashed line: ${signal.lowerIsWorse ? 'replace at' : 'limit'} ${signal.limit}${unit}`), h('span', {}, 'Latest')),
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
