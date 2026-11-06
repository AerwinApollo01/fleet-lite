// Finding one asset among thousands. Search narrows, facets show what's in the fleet, and only
// one page of rows ever reaches the screen.
import { componentById, STATE } from './components.js';

const conditionLabel = (row) => (row.condition === 'ok' ? 'Healthy' : STATE[row.condition].label);
const band = (value, edges) => edges.find(([limit]) => value < limit)?.[1] ?? edges.at(-1)[1];

export const FACETS = {
  vehicles: [
    { id: 'condition', label: 'Condition', value: conditionLabel },
    { id: 'component', label: 'Part needing attention', values: (row) => row.flagged.map((id) => componentById(id).label) },
    { id: 'status', label: 'Status', value: (row) => row.status },
    { id: 'signal', label: 'Connection', value: (row) => (row.online ? 'Connected' : 'No signal') },
    { id: 'depot', label: 'Depot', value: (row) => row.depot },
    { id: 'hardware', label: 'Hardware', value: (row) => row.hardware },
    { id: 'supplier', label: 'Battery supplier', value: (row) => row.supplier },
    { id: 'firmware', label: 'Firmware', value: (row) => row.firmware },
  ],
  packs: [
    { id: 'condition', label: 'Condition', value: conditionLabel },
    { id: 'status', label: 'Status', value: (row) => row.status },
    { id: 'health', label: 'Health', value: (row) => band(row.healthPct, [[90, 'Below 90%'], [95, '90–95%'], [Infinity, '95% and up']]) },
    { id: 'cycles', label: 'Charge cycles', value: (row) => band(row.cycles, [[250, 'Under 250'], [500, '250–500'], [Infinity, '500 and up']]) },
  ],
};

export const VIEWS = {
  vehicles: [
    { id: 'all', label: 'All', filters: {} },
    { id: 'attention', label: 'Needs attention', filters: { condition: ['Fault', 'Watch'] } },
    { id: 'faults', label: 'Faults', filters: { condition: ['Fault'] } },
    { id: 'offline', label: 'No signal', filters: { signal: ['No signal'] } },
  ],
  packs: [
    { id: 'all', label: 'All', filters: {} },
    { id: 'replace', label: 'Replace soon', filters: { condition: ['Watch'] } },
    { id: 'ready', label: 'Ready to swap', filters: { status: ['Ready'] } },
  ],
};

const facetValues = (facet, row) => (facet.values ? facet.values(row) : [facet.value(row)]);

function searchText(row, withRoute) {
  const route = withRoute ? [row.routeId, row.area] : [];
  const parts = [row.id, row.status, row.depot, row.hardware, row.firmware, row.supplier, row.packId, row.vin, ...route, ...(row.flagged ?? []).map((id) => componentById(id).label)];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function comparator({ key, dir }) {
  const sign = dir === 'desc' ? -1 : 1;
  const value = (row) => (key === 'condition' ? STATE[row.condition].rank : row[key]);
  return (a, b) => {
    const [x, y] = [value(a), value(b)];
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'en', { numeric: true });
    return sign * order || a.id.localeCompare(b.id, 'en', { numeric: true });
  };
}

// Words must all match. Within a facet any ticked value matches, and across facets all must.
export function queryAssets(rows, kind, { search = '', filters = {}, sort = { key: 'condition', dir: 'asc' }, page = 1, pageSize = 50, searchRoutes = false } = {}) {
  const facets = FACETS[kind];
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length ? rows.filter((row) => { const text = searchText(row, searchRoutes); return words.every((word) => text.includes(word)); }) : rows;
  const passes = (row, facet) => {
    const ticked = filters[facet.id];
    return !ticked?.length || facetValues(facet, row).some((value) => ticked.includes(value));
  };
  const matched = found.filter((row) => facets.every((facet) => passes(row, facet)));

  // A facet's counts ignore its own ticks, so they say what ticking one more would add.
  const facetCounts = facets.map((facet) => {
    const counts = new Map();
    for (const row of found) {
      if (!facets.every((other) => other === facet || passes(row, other))) continue;
      for (const value of facetValues(facet, row)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const options = [...counts].map(([value, count]) => ({ value, count, checked: Boolean(filters[facet.id]?.includes(value)) }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return { id: facet.id, label: facet.label, options };
  });

  const sorted = [...matched].sort(comparator(sort));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  return { rows: sorted.slice(start, start + pageSize), ids: sorted.map((row) => row.id), total: sorted.length, page: current, pages, start, facets: facetCounts };
}
