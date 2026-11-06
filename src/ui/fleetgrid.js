// Every asset as one cell, drawn on a canvas so thousands stay fast. The table below it shows the
// same rows as text, so nothing here depends on seeing color.
import { h } from './dom.js';

const MAX_CELL = 20;
const HEIGHT = 132;
const toneOf = (row) => (row.online === false && row.condition === 'ok' ? 'none' : row.condition);

export function fleetGrid(rows, matched, { onOpen, describe }) {
  const canvas = h('canvas', { class: 'fleet-grid-canvas', role: 'img', 'aria-label': `${rows.length} assets, one cell each, ${matched.size} match the current filters. The table below lists them.` });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'fleet-grid' }, canvas, tip);
  let layout = null;

  function draw() {
    const width = wrap.clientWidth;
    if (!width) return;
    const area = (width * HEIGHT) / Math.max(rows.length, 1);
    const pitch = Math.max(3, Math.min(MAX_CELL + 2, Math.floor(Math.sqrt(area))));
    const gap = pitch >= 8 ? 2 : 1;
    const cols = Math.max(1, Math.floor(width / pitch));
    const height = Math.ceil(rows.length / cols) * pitch;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const css = getComputedStyle(document.documentElement);
    const color = { fault: css.getPropertyValue('--st-bad'), watch: css.getPropertyValue('--st-warn'), ok: css.getPropertyValue('--cell-ok'), none: css.getPropertyValue('--st-none') };
    rows.forEach((row, i) => {
      ctx.globalAlpha = matched.has(row.id) ? 1 : 0.14;
      ctx.fillStyle = color[toneOf(row)];
      ctx.fillRect((i % cols) * pitch, Math.floor(i / cols) * pitch, pitch - gap, pitch - gap);
    });
    layout = { pitch, cols };
  }

  const rowAt = (event) => {
    if (!layout) return null;
    const box = canvas.getBoundingClientRect();
    const col = Math.floor((event.clientX - box.left) / layout.pitch);
    const line = Math.floor((event.clientY - box.top) / layout.pitch);
    return col < layout.cols ? rows[line * layout.cols + col] ?? null : null;
  };

  canvas.addEventListener('mousemove', (event) => {
    const row = rowAt(event);
    tip.hidden = !row;
    canvas.style.cursor = row ? 'pointer' : 'default';
    if (!row) return;
    tip.replaceChildren(h('strong', {}, row.id), h('span', {}, describe(row)));
    const box = wrap.getBoundingClientRect();
    const x = event.clientX - box.left;
    tip.style.left = `${Math.min(x + 12, box.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${event.clientY - box.top + 14}px`;
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  canvas.addEventListener('click', (event) => { const row = rowAt(event); if (row) onOpen(row); });

  new ResizeObserver(draw).observe(wrap);
  return wrap;
}
