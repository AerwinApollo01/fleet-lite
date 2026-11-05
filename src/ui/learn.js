import { CATEGORIES, GLOSSARY, LESSONS, searchGlossary } from '../data/learn.js';
import { roleOf, ROLES } from '../core/roles.js';
import { h, panel } from './dom.js';

const TAB_LABELS = {
  operator: 'Operator', alerts: 'Alerts', maintenance: 'Maintenance', reports: 'Reports', architecture: 'Architecture',
  vehicle: 'Vehicle', ota: 'OTA rollout', transfer: 'Transfer', revocation: 'Revocation', range: 'Range',
};

const ui = { view: 'glossary', query: '', category: 'All' };

export function mountLearn(root, { world, goTo }) {
  const seeLink = (tab) => (tab && ROLES[roleOf(world)].tabs.includes(tab)
    ? h('button', { class: 'link', onClick: () => goTo(tab) }, `Open ${TAB_LABELS[tab]} →`)
    : null);

  function entryCard(entry) {
    return h('li', { class: 'term' },
      h('h3', {}, entry.term, entry.expansion ? h('span', { class: 'muted expansion' }, ` ${entry.expansion}`) : ''),
      h('p', {}, entry.definition),
      entry.analogy && h('p', { class: 'analogy' }, h('strong', {}, 'Think of it as: '), entry.analogy),
      (entry.seeIt || entry.tab) && h('p', { class: 'see-it' }, entry.seeIt ?? '', entry.seeIt ? ' ' : '', seeLink(entry.tab)),
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

  function render() {
    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'Learn fleet management and telematics'),
        h('p', {}, 'Plain definitions, everyday comparisons, and what building this taught us.'),
      ),
      h('div', { class: 'toolbar' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Section' },
          [['glossary', `Glossary (${GLOSSARY.length})`], ['lessons', `Lessons learned (${LESSONS.length})`]].map(([id, label]) => h('button', {
            class: id === ui.view ? 'active' : '', 'aria-pressed': id === ui.view ? 'true' : 'false',
            onClick: () => { ui.view = id; render(); },
          }, label))),
      ),
      ...(ui.view === 'glossary' ? glossary() : lessons()),
    );
  }
  render();
}
