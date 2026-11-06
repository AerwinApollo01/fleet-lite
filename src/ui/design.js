import { ASSUMPTIONS, CRITERIA, DECISIONS, DEFAULT_INPUTS, evaluateDesign, formatAge, PRESETS } from '../scenarios/tradeoffs.js';
import { h, panel, table } from './dom.js';

const ui = { design: { ...PRESETS[0].design }, inputs: { ...DEFAULT_INPUTS }, compare: 'vendor' };

const SLIDERS = [
  { key: 'vehicles', label: 'Vehicles', min: 50, max: 5000, step: 50, show: (v) => v.toLocaleString('en-US') },
  { key: 'intervalSeconds', label: 'Report every', min: 5, max: 300, step: 5, show: (v) => `${v} sec` },
  { key: 'teamSize', label: 'Engineering team', min: 2, max: 30, step: 1, show: (v) => `${v} people` },
  { key: 'costPerMb', label: 'Data cost per MB', min: 0.005, max: 0.1, step: 0.005, show: (v) => `$${v.toFixed(3)}` },
];

const money = (value) => `$${Math.round(value).toLocaleString('en-US')}`;
const option = (decision, id) => decision.options.find((o) => o.id === id);
const matchingPreset = () => PRESETS.find((p) => DECISIONS.every((d) => p.design[d.id] === ui.design[d.id]));

function dots(score) {
  return h('span', { class: 'dots', role: 'img', 'aria-label': `${score} out of 5` },
    [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= score ? 'on' : '' })), h('span', { class: 'muted' }, ` ${score}/5`));
}

function flowStrip() {
  const layer = (id, title) => {
    const decision = DECISIONS.find((d) => d.id === id);
    return h('div', { class: 'flow-step' }, h('span', { class: 'muted' }, title), h('strong', {}, option(decision, ui.design[id]).layer));
  };
  return h('div', { class: 'flow-strip', 'aria-label': 'The design, from vehicle to cloud' },
    layer('logic', 'On the vehicle'), layer('telemetry', 'Connection'), layer('processing', 'Processing'), layer('cloud', 'Cloud'), layer('records', 'Records'), layer('sourcing', 'Telematics'));
}

export function mountDesign(root) {
  const results = h('div', {});

  function renderResults() {
    const mine = evaluateDesign(ui.design, ui.inputs);
    const other = PRESETS.find((p) => p.id === ui.compare);
    const theirs = evaluateDesign(other.design, ui.inputs);

    results.replaceChildren(...[
      flowStrip(),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Data cost per month'), h('strong', {}, money(mine.data.fleetCost)), h('span', { class: 'muted small-inline' }, `${other.label}: ${money(theirs.data.fleetCost)}`)),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Data per vehicle'), h('strong', {}, `${mine.data.mbPerVehicle.toFixed(1)} MB`), h('span', { class: 'muted small-inline' }, 'per month')),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Reports per day'), h('strong', {}, mine.data.reportsPerDay.toLocaleString('en-US'))),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Data is'), h('strong', {}, formatAge(mine.dataAge)), h('span', { class: 'muted small-inline' }, 'old when you see it')),
      ),
      h('div', { class: 'grid two' },
        panel('Tradeoffs',
          h('label', { class: 'inline-field compare' }, 'Compare with',
            h('select', { onChange: (event) => { ui.compare = event.target.value; renderResults(); } },
              PRESETS.map((p) => h('option', { value: p.id, selected: p.id === ui.compare }, p.label)))),
          table(['', 'Your design', other.label], CRITERIA.map((c) => [h('span', { title: c.hint }, c.label), dots(mine.scores[c.id]), dots(theirs.scores[c.id])])),
          h('p', { class: 'muted small' }, 'Scores are judgment calls, not measurements. Treat them as a starting point for debate.'),
        ),
        panel(`Risks in this design (${mine.risks.length})`,
          mine.risks.length
            ? h('ul', { class: 'guide-list' }, mine.risks.map((risk) => h('li', {}, risk)))
            : h('p', { class: 'muted' }, 'No obvious risks at this size. That doesn’t mean there are none.'),
        ),
      ),
      panel('What to ask each partner',
        h('p', { class: 'muted small' }, 'These change with your design. Try switching between build and buy.'),
        h('div', { class: 'partner-grid' }, mine.partners.map(({ partner, questions }) => h('section', {},
          h('h4', {}, partner), h('ul', { class: 'guide-list' }, questions.map((q) => h('li', {}, q)))))),
      ),
      h('p', { class: 'muted small' }, `Cost assumes ${ASSUMPTIONS.activeHours} active hours a day, ${ASSUMPTIONS.daysPerMonth} days a month, and ${ASSUMPTIONS.payloadBytes}-byte reports. It covers data only, not cloud, hardware, or people.`),
    ]);
  }

  function renderAll() {
    const active = matchingPreset();
    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'Design options'),
        h('p', {}, 'No architecture wins on everything. Pick a design, and see what it costs, what it risks, and what you’d need to ask your partners.'),
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'label inline' }, 'Start from'),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Preset designs' },
          PRESETS.map((p) => h('button', {
            class: p === active ? 'active' : '', 'aria-pressed': p === active ? 'true' : 'false',
            onClick: () => { ui.design = { ...p.design }; renderAll(); },
          }, p.label))),
        !active && h('span', { class: 'muted small-inline' }, 'Custom design'),
      ),
      panel('Your design',
        h('div', { class: 'decision-grid' }, DECISIONS.map((decision) => h('div', {},
          h('p', { class: 'label' }, decision.label),
          h('div', { class: 'segmented', role: 'group', 'aria-label': decision.label },
            decision.options.map((o) => h('button', {
              class: o.id === ui.design[decision.id] ? 'active' : '',
              'aria-pressed': o.id === ui.design[decision.id] ? 'true' : 'false',
              onClick: () => { ui.design = { ...ui.design, [decision.id]: o.id }; renderAll(); },
            }, o.label)))))),
        h('div', { class: 'sliders design-sliders' }, SLIDERS.map((slider) => {
          const value = h('output', {}, slider.show(ui.inputs[slider.key]));
          return h('label', { class: 'slider' }, h('span', {}, slider.label),
            h('input', {
              type: 'range', min: slider.min, max: slider.max, step: slider.step, value: ui.inputs[slider.key], 'aria-label': slider.label,
              onInput: (event) => {
                ui.inputs = { ...ui.inputs, [slider.key]: Number(event.target.value) };
                value.textContent = slider.show(ui.inputs[slider.key]);
                renderResults();
              },
            }), value);
        })),
      ),
      results,
    );
    renderResults();
  }
  renderAll();
}
