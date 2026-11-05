import { createClaimPolicy, estimateRange, explainChange, MODELS, routeClaim } from '../core/range.js';
import { badge, h, panel, table } from './dom.js';

const policy = createClaimPolicy({ owner: 'Product lead', reserveKm: 2 });
const CLAIMS = {
  WILL_FINISH: ['Will finish this route', 'good'],
  AT_RISK: ['At risk on this route', 'warn'],
  WONT_FINISH: ['Will not finish this route', 'bad'],
};
const CONTROLS = [
  { key: 'packVolts', label: 'Pack voltage', unit: 'V', min: 42, max: 54.6, step: 0.1 },
  { key: 'tempC', label: 'Temperature', unit: '°C', min: -5, max: 35, step: 1 },
  { key: 'payloadKg', label: 'Payload', unit: 'kg', min: 0, max: 200, step: 5 },
  { key: 'gradePct', label: 'Average grade', unit: '%', min: 0, max: 5, step: 0.5 },
  { key: 'stopsPerKm', label: 'Stops per km', unit: '', min: 0, max: 8, step: 0.5 },
  { key: 'routeKm', label: 'Route remaining', unit: 'km', min: 5, max: 60, step: 1 },
];

const km = (value) => `${value.toFixed(1)} km`;

function rangeBar(interval, routeKm) {
  const max = Math.max(interval.p90, routeKm) * 1.1;
  const pct = (value) => `${(value / max) * 100}%`;
  return h('div', { class: 'rangebar', role: 'img', 'aria-label': `Range ${km(interval.p10)} to ${km(interval.p90)}, route ${routeKm} km` },
    h('span', { class: 'band', style: `left:${pct(interval.p10)};width:calc(${pct(interval.p90)} - ${pct(interval.p10)})` }),
    h('span', { class: 'median', style: `left:${pct(interval.p50)}` }),
    h('span', { class: 'route', style: `left:${pct(routeKm)}` }),
  );
}

export function mountRange(root) {
  const state = { packVolts: 49, tempC: 8, payloadKg: 120, gradePct: 1, stopsPerKm: 3, routeKm: 20 };
  let modelVersion = 'range-1.0';
  const output = h('div', {});

  function renderOutput() {
    const { routeKm, ...inputs } = state;
    const estimate = estimateRange(inputs, modelVersion);
    const previous = estimateRange(inputs, modelVersion === 'range-1.0' ? 'range-1.1' : 'range-1.0');
    const { interval } = estimate.rangeKm;
    const claim = routeClaim(estimate, routeKm, policy);
    const [claimText, tone] = CLAIMS[claim.status];
    const medianSaysFine = interval.p50 >= routeKm;
    const change = explainChange(previous, estimate);

    output.replaceChildren(
      h('div', { class: 'grid two' },
        panel('Internal surface',
          table(['Field', 'Value', 'Provenance'], [
            ['Pack voltage', `${estimate.packVolts.value.toFixed(1)} V`, badge('Measured', 'good')],
            ['Pack temperature', `${estimate.tempC.value} °C`, badge('Measured', 'good')],
            ['State of charge', `${(estimate.soc.value * 100).toFixed(0)}%`, badge(`Modeled · ${modelVersion}`, 'warn')],
            ['Range P10', km(interval.p10), badge('Modeled', 'warn')],
            ['Range P50', km(interval.p50), badge('Modeled', 'warn')],
            ['Range P90', km(interval.p90), badge('Modeled', 'warn')],
          ]),
          rangeBar(interval, routeKm),
          h('div', { class: 'legend' },
            h('span', {}, h('i', { class: 'key band' }), 'P10 to P90'),
            h('span', {}, h('i', { class: 'key median' }), 'Median'),
            h('span', {}, h('i', { class: 'key route' }), 'Route'),
          ),
          h('p', { class: 'muted small' },
            `Versus ${change.from}: ${km(previous.rangeKm.value)} became ${km(estimate.rangeKm.value)} with identical inputs. The vehicle did not change; the model did.`),
        ),
        panel('Operator surface',
          h('div', { class: `claim ${tone}` }, h('strong', {}, claimText), h('p', {}, claim.action)),
          claim.status === 'AT_RISK' && medianSaysFine &&
            h('p', { class: 'callout warn' }, `The median says ${km(interval.p50)} covers this ${routeKm} km route. A UI showing that as fact would dispatch this vehicle.`),
          h('p', { class: 'muted small' }, `The claim uses P10 minus a ${policy.reserveKm} km reserve. Threshold owner: ${policy.owner}.`),
        ),
      ),
    );
  }

  const controls = CONTROLS.map((control) => {
    const value = h('output', {}, `${state[control.key]} ${control.unit}`);
    const input = h('input', {
      type: 'range', min: control.min, max: control.max, step: control.step, value: state[control.key],
      'aria-label': control.label,
      onInput: (event) => {
        state[control.key] = Number(event.target.value);
        value.textContent = `${state[control.key]} ${control.unit}`;
        renderOutput();
      },
    });
    return h('label', { class: 'slider' }, h('span', {}, control.label), input, value);
  });

  const modelButtons = Object.keys(MODELS).map((version) => h('button', {
    class: version === modelVersion ? 'active' : '',
    'aria-pressed': version === modelVersion ? 'true' : 'false',
    onClick: (event) => {
      modelVersion = version;
      for (const button of modelButtons) {
        const active = button === event.currentTarget;
        button.className = active ? 'active' : '';
        button.setAttribute('aria-pressed', String(active));
      }
      renderOutput();
    },
  }, version));

  root.replaceChildren(
    h('div', { class: 'intro' },
      h('h2', {}, 'Measured vs. modeled range'),
      h('p', {}, 'One telemetry stream, two surfaces. Internal users debug the system. Customers depend on it.'),
    ),
    h('div', { class: 'toolbar' },
      h('span', { class: 'label inline' }, 'Model'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Model version' }, modelButtons),
    ),
    panel('Inputs', h('div', { class: 'sliders' }, controls)),
    output,
  );
  renderOutput();
}
