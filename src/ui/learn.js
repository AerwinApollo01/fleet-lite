import { decodeFrame, formula, parseFrame } from '../core/can.js';
import { powerCutOutcome, STAGES } from '../core/flash.js';
import { roleOf, ROLES, SCREENS } from '../core/roles.js';
import { GUIDES } from '../data/guides.js';
import { CATEGORIES, GLOSSARY, LESSONS, searchGlossary } from '../data/learn.js';
import { h, table } from './dom.js';

const WORKED = '13 38 3C B4 00 00 00 00';
const PRACTICE = '12 C0 46 64 00 00 00 00';

const ui = { view: 'guides', guide: null, query: '', category: 'All' };
const flash = { slots: 2, stage: 'writing', recovery: false };

function vehicleFigure() {
  const node = (title, text, wide) => h('div', { class: `fig-node ${wide ? 'wide' : ''}` }, h('strong', {}, title), h('span', {}, text));
  return h('figure', { class: 'fig-vehicle', 'aria-label': 'Fleet cloud connected by MQTT to a telematics unit, which joins a CAN bus shared by the vehicle ECU, motor controller, battery and BMS, and display. Sensors feed the controllers.' },
    node('Fleet cloud', 'Data, decisions, updates', true),
    h('div', { class: 'fig-link' }, h('span', {}, 'MQTT over cellular')),
    node('Telematics unit (TCU)', 'Cellular, GPS, buffer, gateway', true),
    h('div', { class: 'fig-bus' }, h('span', {}, 'CAN bus')),
    h('div', { class: 'fig-row' },
      node('Vehicle ECU', 'Main decisions'),
      node('Motor controller', 'Drives the motor'),
      node('Battery and BMS', 'Monitors the pack'),
      node('Display', 'Rider interface'),
    ),
    h('div', { class: 'fig-link' }, h('span', {}, 'Wires to each controller')),
    node('Sensors and controls', 'Pedal, speed, brake, temperature', true),
  );
}

function pipelineFigure() {
  const steps = [
    ['Receive', 'Filter CAN frames'],
    ['Decode', 'Bytes into values'],
    ['Reduce', 'Sample, detect events'],
    ['Package', 'Timestamp, ID, schema'],
    ['Buffer', 'Store while offline'],
    ['Send', 'Encrypt, publish over MQTT'],
  ];
  return h('ol', { class: 'fig-pipeline' }, steps.map(([title, text], i) => h('li', {},
    h('span', { class: 'lesson-num' }, i + 1), h('div', {}, h('strong', {}, title), h('p', { class: 'muted' }, text)))));
}

function decoderWidget() {
  const output = h('div', {});
  const input = h('input', { type: 'text', class: 'search mono', value: WORKED, 'aria-label': 'CAN frame bytes in hex', spellcheck: 'false' });

  function update() {
    const { bytes, error } = parseFrame(input.value);
    if (error) {
      output.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, error));
      return;
    }
    output.replaceChildren(table(['Signal', 'Bytes', 'As a number', 'Formula', 'Result'], decodeFrame(bytes).map((s) => (s.missing
      ? [s.name, '—', '—', '—', 'Not in this frame']
      : [s.name, h('code', {}, s.hex), s.raw.toLocaleString('en-US'), formula(s) || 'none', h('strong', {}, `${s.value.toFixed(s.decimals)} ${s.unit}`)]))));
  }
  input.addEventListener('input', update);
  const load = (text) => () => { input.value = text; update(); };
  update();

  return h('section', { class: 'tool', 'aria-label': 'CAN frame decoder' },
    h('h3', {}, 'Try the decoder'),
    h('p', { class: 'muted small' }, 'Type bytes in hex, separated by spaces. It uses the signal layout in the table above.'),
    h('div', { class: 'toolbar tight' }, input,
      h('button', { onClick: load(WORKED) }, 'Worked example'),
      h('button', { onClick: load(PRACTICE) }, 'Practice frame')),
    output,
  );
}

function flashWidget() {
  const slot = (label, text, tone) => h('div', { class: `slot ${tone}` }, h('strong', {}, label), h('span', {}, text));
  const root = h('section', { class: 'tool', 'aria-label': 'Power cut simulator' });

  function render() {
    const outcome = powerCutOutcome({ slots: flash.slots, stage: flash.stage, recoveryPath: flash.recovery });
    const writing = flash.stage === 'writing';
    const slots = flash.slots === 2
      ? [slot('Slot A', 'Running firmware', 'good'), slot('Slot B', writing ? 'Half written' : 'Spare', writing ? 'warn' : '')]
      : [slot('Only slot', writing ? 'Half old, half new' : 'Firmware', writing ? 'bad' : 'good')];

    root.replaceChildren(
      h('h3', {}, 'Cut the power'),
      h('div', { class: 'toolbar tight' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Storage' },
          [[2, 'Two slots'], [1, 'One slot']].map(([count, label]) => h('button', {
            class: count === flash.slots ? 'active' : '', 'aria-pressed': count === flash.slots ? 'true' : 'false',
            onClick: () => { flash.slots = count; render(); },
          }, label))),
        h('label', { class: 'inline-field' }, 'Cut power',
          h('select', { onChange: (event) => { flash.stage = event.target.value; render(); } },
            STAGES.map((stage) => h('option', { value: stage.id, selected: stage.id === flash.stage }, stage.label)))),
        flash.slots === 1 && h('label', { class: 'inline-field' },
          h('input', { type: 'checkbox', checked: flash.recovery, onChange: (event) => { flash.recovery = event.target.checked; render(); } }), 'Protected bootloader'),
      ),
      h('div', { class: 'slots' }, slots),
      h('div', { class: `claim ${outcome.state === 'safe' ? 'good' : outcome.state}` }, h('strong', {}, outcome.title), h('p', {}, outcome.detail)),
    );
  }
  render();
  return root;
}

const FIGURES = { vehicle: vehicleFigure, pipeline: pipelineFigure };
const WIDGETS = { decoder: decoderWidget, flash: flashWidget };

function block(item) {
  if (item.t === 'p') return h('p', { class: 'guide-p' }, item.text);
  if (item.t === 'h') return h('h3', { class: 'guide-h' }, item.text);
  if (item.t === 'note') return h('p', { class: 'callout neutral' }, item.text);
  if (item.t === 'table') return table(item.head, item.rows);
  if (item.t === 'list') return h('ul', { class: 'guide-list' }, item.items.map((text) => h('li', {}, text)));
  if (item.t === 'ordered') return h('ol', { class: 'guide-list' }, item.items.map((text) => h('li', {}, text)));
  if (item.t === 'code') return h('pre', { class: 'code' }, h('code', {}, item.text));
  if (item.t === 'figure') return FIGURES[item.name]();
  return WIDGETS[item.name]();
}

export function mountLearn(root, { world, goTo }) {
  const seeLink = (tab) => (tab && ROLES[roleOf(world)].tabs.includes(tab)
    ? h('button', { class: 'link', onClick: () => goTo(tab) }, `Open ${SCREENS[tab]} →`)
    : null);

  const openGuide = (id) => { ui.view = 'guides'; ui.guide = id; render(); window.scrollTo(0, 0); };
  const guideLink = (id) => (id ? h('button', { class: 'link', onClick: () => openGuide(id) }, 'Read the guide →') : null);

  function entryCard(entry) {
    const links = [guideLink(entry.guide), seeLink(entry.tab)].filter(Boolean);
    return h('li', { class: 'term' },
      h('h3', {}, entry.term, entry.expansion ? h('span', { class: 'muted expansion' }, ` ${entry.expansion}`) : ''),
      h('p', {}, entry.definition),
      entry.analogy && h('p', { class: 'analogy' }, h('strong', {}, 'Think of it as: '), entry.analogy),
      entry.seeIt && h('p', { class: 'see-it' }, entry.seeIt),
      links.length > 0 && h('p', { class: 'see-it links' }, links),
    );
  }

  function results() {
    const entries = searchGlossary(ui.query, ui.category);
    return entries.length
      ? [h('p', { class: 'muted small' }, `${entries.length} term${entries.length === 1 ? '' : 's'}`), h('ul', { class: 'terms' }, entries.map(entryCard))]
      : [h('p', { class: 'muted empty' }, 'No terms match. Try a different word.')];
  }

  function glossary() {
    const list = h('div', {}, ...results());
    return [
      h('div', { class: 'toolbar' },
        h('input', {
          type: 'search', class: 'search', placeholder: 'Search terms', 'aria-label': 'Search terms', value: ui.query,
          onInput: (event) => { ui.query = event.target.value; list.replaceChildren(...results()); },
        }),
        h('select', {
          'aria-label': 'Category',
          onChange: (event) => { ui.category = event.target.value; list.replaceChildren(...results()); },
        }, ['All', ...CATEGORIES].map((c) => h('option', { value: c, selected: c === ui.category }, c === 'All' ? 'All categories' : c))),
      ),
      list,
    ];
  }

  function lessons() {
    return [
      h('ol', { class: 'lessons' }, LESSONS.map((item, i) => h('li', { class: 'panel lesson' },
        h('span', { class: 'lesson-num' }, i + 1),
        h('div', {},
          h('h3', {}, item.title),
          h('p', { class: 'muted' }, item.happened),
          h('p', {}, h('strong', {}, 'The lesson: '), item.lesson),
          seeLink(item.tab) && h('p', { class: 'see-it' }, seeLink(item.tab)),
        ),
      ))),
    ];
  }

  function guideList() {
    return [
      h('ol', { class: 'guide-cards' }, GUIDES.map((guide, i) => h('li', {},
        h('button', { class: 'guide-card', onClick: () => openGuide(guide.id) },
          h('span', { class: 'lesson-num' }, i + 1),
          h('span', {}, h('strong', {}, guide.title), h('span', { class: 'muted' }, guide.summary), h('span', { class: 'muted small-inline' }, `About ${guide.minutes} minutes`)),
        )))),
    ];
  }

  function guidePage(guide) {
    const index = GUIDES.indexOf(guide);
    const next = GUIDES[index + 1];
    const previous = GUIDES[index - 1];
    return [
      h('button', { class: 'link', onClick: () => openGuide(null) }, '← All guides'),
      h('article', { class: 'guide' },
        h('h2', {}, guide.title),
        h('p', { class: 'muted guide-p' }, guide.summary),
        guide.blocks.map(block),
        h('h3', { class: 'guide-h' }, 'Check yourself'),
        h('p', { class: 'muted small' }, 'Answer in your own words first, then reveal.'),
        guide.checks.map((check) => h('details', { class: 'check' }, h('summary', {}, check.q), h('p', {}, check.a))),
      ),
      h('div', { class: 'guide-nav' },
        previous ? h('button', { onClick: () => openGuide(previous.id) }, `← ${previous.title}`) : h('span', {}),
        next && h('button', { class: 'primary', onClick: () => openGuide(next.id) }, `${next.title} →`),
      ),
    ];
  }

  function render() {
    const guide = GUIDES.find((g) => g.id === ui.guide);
    const sections = { guides: () => (guide ? guidePage(guide) : guideList()), glossary, lessons };
    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'Learn fleet management and telematics'),
        h('p', {}, 'How the technology works, what the words mean, and what building this taught us. These are general concepts, not any one product.'),
      ),
      h('div', { class: 'toolbar' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Section' },
          [['guides', `How it works (${GUIDES.length})`], ['glossary', `Glossary (${GLOSSARY.length})`], ['lessons', `Lessons learned (${LESSONS.length})`]].map(([id, label]) => h('button', {
            class: id === ui.view ? 'active' : '', 'aria-pressed': id === ui.view ? 'true' : 'false',
            onClick: () => { ui.view = id; if (id === 'guides') ui.guide = null; render(); },
          }, label))),
      ),
      ...sections[ui.view](),
    );
  }
  render();
}
