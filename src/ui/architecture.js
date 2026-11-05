import { COLUMNS, EDGES, NODES, nodeStats, TRACES, traceSteps } from '../scenarios/architecture.js';
import { operationsView, ROUTES } from '../scenarios/operations.js';
import { badge, h, panel } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const KIND = {
  measured: ['Measured', 'good'],
  modeled: ['Modeled', 'warn'],
  policy: ['Policy', 'neutral'],
  claim: ['Result', 'good'],
  fact: ['', 'neutral'],
};

const ui = { trace: 'claim' };

function edgePath(from, to, origin) {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const sameColumn = Math.abs(a.left - b.left) < 20;
  if (sameColumn) {
    const down = a.top < b.top;
    const gap = down ? b.top - a.bottom : a.top - b.bottom;
    if (gap > 30) {
      // Not neighbours, so bow out past the cards in between instead of running behind them.
      const x = a.right - origin.left;
      const y1 = a.top + a.height / 2 - origin.top;
      const y2 = b.top + b.height / 2 - origin.top;
      return `M${x} ${y1}C${x + 34} ${y1} ${x + 34} ${y2} ${x} ${y2}`;
    }
    const x = a.left + a.width / 2 - origin.left;
    const y1 = (down ? a.bottom : a.top) - origin.top;
    const y2 = (down ? b.top : b.bottom) - origin.top;
    return `M${x} ${y1}L${x} ${y2}`;
  }
  const right = a.left < b.left;
  const x1 = (right ? a.right : a.left) - origin.left;
  const x2 = (right ? b.left : b.right) - origin.left;
  const y1 = a.top + a.height / 2 - origin.top;
  const y2 = b.top + b.height / 2 - origin.top;
  const bend = (x2 - x1) / 2;
  return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
}

export function mountArchitecture(root, { world, goTo }) {
  let observer = null;

  function defaultRoute() {
    const view = operationsView(world);
    return world.traceRoute ?? view.decisions[0]?.row.route.id ?? ROUTES[0].id;
  }

  function render() {
    observer?.disconnect();
    const routeId = defaultRoute();
    world.traceRoute = routeId;
    const trace = TRACES.find((t) => t.id === ui.trace);
    const steps = traceSteps(world, ui.trace, routeId);
    const stats = nodeStats(world);
    const order = new Map();
    trace.path.forEach((id, i) => order.set(id, i + 1));

    const nodeEls = new Map();
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'arch-lines');
    svg.setAttribute('aria-hidden', 'true');

    const columns = COLUMNS.map((column) => h('section', { class: 'arch-col', 'aria-label': column.label },
      h('header', {}, h('h3', {}, column.label), h('p', { class: 'muted' }, column.note)),
      NODES.filter((n) => n.column === column.id).map((node) => {
        const step = order.get(node.id);
        const el = h('div', { class: `arch-node ${step ? 'on' : ''}` },
          step && h('span', { class: 'step-num' }, step),
          h('strong', {}, node.title),
          h('p', {}, node.text),
          h('p', { class: 'live' }, stats[node.id]),
          h('span', { class: 'ref' }, node.ref),
        );
        nodeEls.set(node.id, el);
        return el;
      }),
    ));

    const canvas = h('div', { class: 'arch-canvas' }, svg, ...columns);

    function draw() {
      const origin = canvas.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`);
      const onPath = new Set(trace.path.slice(1).map((id, i) => `${trace.path[i]}>${id}`));
      const lines = EDGES.filter(([a, b]) => !onPath.has(`${a}>${b}`) && !onPath.has(`${b}>${a}`))
        .map(([a, b]) => ({ a, b, on: false }));
      const active = trace.path.slice(1).map((id, i) => ({ a: trace.path[i], b: id, on: true }));
      svg.replaceChildren(...[...lines, ...active].map(({ a, b, on }) => {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', edgePath(nodeEls.get(a), nodeEls.get(b), origin));
        path.setAttribute('class', on ? 'edge on' : 'edge');
        return path;
      }));
    }

    root.replaceChildren(
      h('div', { class: 'intro' },
        h('h2', {}, 'How the system fits together'),
        h('p', {}, 'Every value below is live from the same fleet as the Today screen. Pick a path to follow it through the layers.'),
      ),
      h('div', { class: 'toolbar' },
        h('span', { class: 'label inline' }, 'Follow'),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Trace' },
          TRACES.map((t) => h('button', {
            class: t.id === ui.trace ? 'active' : '', 'aria-pressed': t.id === ui.trace ? 'true' : 'false',
            onClick: () => { ui.trace = t.id; render(); },
          }, t.label))),
        h('label', { class: 'inline-field' }, h('span', { class: 'label inline' }, 'Route'),
          h('select', { onChange: (event) => { world.traceRoute = event.target.value; render(); } },
            ROUTES.map((r) => h('option', { value: r.id, selected: r.id === routeId }, `${r.id} · ${r.driver}`)))),
        h('button', { class: 'end-btn', onClick: () => goTo('operator') }, '← Back to Today'),
      ),
      canvas,
      panel(`${trace.label}: ${routeId}`,
        h('ol', { class: 'trace' }, steps.map((step) => {
          const [label, tone] = KIND[step.kind];
          return h('li', {},
            h('span', { class: 'step-num' }, order.get(step.node)),
            h('div', {}, h('p', {}, step.text), h('code', {}, step.value)),
            label && badge(label, tone),
          );
        })),
      ),
    );

    draw();
    observer = new ResizeObserver(draw);
    observer.observe(canvas);
  }
  render();
}
