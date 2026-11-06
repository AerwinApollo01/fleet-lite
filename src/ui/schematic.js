// The vehicle diagram, shared by one vehicle's view and the fleet's Parts view. Each part's state
// is passed in, so the same drawing can show health, firmware, or fleet reliability.
import { STATE } from '../scenarios/components.js';
import { h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const GLYPH = { fault: '✕', watch: '!', ok: '✓', absent: '–' };

// x, y, width, height, then where the name goes. Front of the vehicle is on the right.
const PARTS = {
  pack: { box: [336, 262, 184, 40], label: 'Battery pack' },
  bms: { box: [270, 262, 56, 40], label: 'BMS' },
  charger: { box: [84, 214, 92, 34], label: 'Charger' },
  inverter: { box: [392, 318, 92, 34], label: 'Controller' },
  motor: { box: [296, 318, 84, 34], label: 'Motor' },
  cargo: { box: [300, 222, 220, 24], label: 'Cargo load sensor' },
  vcu: { box: [566, 206, 96, 36], label: 'Computer' },
  gateway: { box: [576, 64, 104, 28], label: 'Gateway' },
  position: { box: [478, 64, 88, 28], label: 'Position' },
  motion: { box: [566, 262, 96, 30], label: 'Motion' },
  proximity: { box: [792, 252, 58, 62], label: 'Prox.' },
};
const WHEELS = { tires: { cx: 198, cy: 352, r: 60, label: 'Tires' }, brakes: { cx: 710, cy: 352, r: 60, label: 'Brakes' } };

const WIRES = {
  can: 'M130 214 V186 H614 M298 262 V186 M430 318 V310 H540 V186 M614 206 V186 M614 262 V242 M628 92 V186 M522 92 V186 M410 222 V186 M824 252 V186 H614',
  power: 'M326 282 H336 M176 236 H284 V262 M438 302 V318 M380 335 H392 M296 335 H258',
};

export function schematic(twin, onPick) {
  const stateOf = (id) => twin.components.find((c) => c.id === id);
  const node = (id, inner) => {
    const part = stateOf(id);
    return `<g class="tw-node ${part.state}" data-c="${id}" data-system="${part.system}" tabindex="0" role="button" aria-label="${part.label}: ${part.stateLabel ?? STATE[part.state].label}">${inner}</g>`;
  };
  const boxes = Object.entries(PARTS).map(([id, { box: [x, y, w, height], label }]) => {
    const state = stateOf(id).state;
    return node(id, `<rect class="tw-hit" x="${x}" y="${y}" width="${w}" height="${height}" rx="6"/>
      <text class="tw-label" x="${x + w / 2}" y="${y + height / 2 + 4}" text-anchor="middle">${state === 'ok' ? '' : `${GLYPH[state]} `}${label}</text>`);
  }).join('');
  const wheels = Object.entries(WHEELS).map(([id, { cx, cy, r, label }]) => {
    const state = stateOf(id).state;
    const inner = id === 'tires'
      ? `<circle class="tw-hit tw-ring" cx="${cx}" cy="${cy}" r="${r - 7}"/><circle class="tw-hub" cx="${cx}" cy="${cy}" r="${r - 30}"/>`
      : `<circle class="tw-tyre" cx="${cx}" cy="${cy}" r="${r - 7}"/><circle class="tw-hit" cx="${cx}" cy="${cy}" r="${r - 22}"/>`;
    return node(id, `${inner}<text class="tw-label" x="${cx}" y="${cy + 4}" text-anchor="middle">${state === 'ok' ? '' : `${GLYPH[state]} `}${label}</text>`);
  }).join('');
  const wrap = h('div', { class: twin.stale ? 'tw-stage stale' : 'tw-stage' });
  wrap.innerHTML = `<svg xmlns="${SVG}" viewBox="40 30 840 390" role="group" aria-label="Diagram of ${twin.vin}. Choose a part to inspect it.">
    <path class="tw-body" d="M70 170 Q70 54 106 54 H560 Q640 54 690 92 L770 178 Q842 190 852 226 V318 H776 A68 68 0 0 0 644 318 H264 A68 68 0 0 0 132 318 H70 Z"/>
    <path class="tw-glass" d="M640 112 Q652 112 664 122 L730 186 H640 Z"/>
    <path class="tw-floor" d="M70 254 H560"/>
    <line class="tw-ground" x1="60" y1="414" x2="860" y2="414"/>
    <path class="tw-wire can" d="${WIRES.can}"/>
    <path class="tw-wire power" d="${WIRES.power}"/>
    ${wheels}${boxes}
  </svg>`;
  const pick = (target) => { const g = target.closest('[data-c]'); if (g) onPick(g.dataset.c); };
  wrap.addEventListener('click', (event) => pick(event.target));
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(event.target); }
  });
  return wrap;
}
