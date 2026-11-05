// One map for the life of the page, so tab changes and re-renders don't reload the tiles.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { boundsOf, circlePolygon, splitPath } from '../core/geo.js';
import { DEPOT, ROUTES, STATUS } from '../scenarios/operations.js';
import { h } from './dom.js';

// Vite moves the package, so the background worker has to be pointed at explicitly.
maplibregl.setWorkerUrl(workerUrl);

const STYLE = (dark) => `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`;
const COLORS = { good: '#0ca30c', warn: '#fab219', bad: '#d03b3b', none: '#8b938c', todo: '#2f6fed' };
const ICON_FOR = {
  ON_TRACK: 'on-track', UNCONFIRMED: 'no-signal', NO_FORECAST: 'no-signal',
  AT_RISK: 'at-risk', WONT_FINISH: 'critical', OUT_OF_SERVICE: 'critical',
};
const ALL_BOUNDS = boundsOf(ROUTES.map((r) => r.path));

function icon(draw) {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  c.lineWidth = 4;
  c.strokeStyle = '#ffffff';
  draw(c);
  return c.getImageData(0, 0, size, size);
}

const circle = (c, fill, stroke = '#ffffff') => {
  c.beginPath();
  c.arc(22, 22, 13, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = stroke;
  c.stroke();
};

const ICONS = {
  'on-track': (c) => circle(c, COLORS.good),
  'no-signal': (c) => circle(c, '#ffffff', COLORS.none),
  'at-risk': (c) => {
    c.beginPath();
    c.moveTo(22, 5); c.lineTo(39, 36); c.lineTo(5, 36); c.closePath();
    c.fillStyle = COLORS.warn; c.fill(); c.stroke();
  },
  critical: (c) => { c.fillStyle = COLORS.bad; c.fillRect(8, 8, 28, 28); c.strokeRect(8, 8, 28, 28); },
  depot: (c) => { c.fillStyle = '#1d2320'; c.fillRect(6, 6, 32, 32); c.strokeRect(6, 6, 32, 32); },
};

const lines = (coordinateSets) => ({
  type: 'FeatureCollection',
  features: coordinateSets.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })),
});

const points = (items) => ({
  type: 'FeatureCollection',
  features: items.map(({ at, ...properties }) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: at } })),
});

let instance = null;

function createFleetMap() {
  const element = h('div', { class: 'fleetmap' });
  const canvas = h('div', { class: 'map-canvas' });
  element.append(canvas);

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const map = new maplibregl.Map({
    container: canvas,
    style: STYLE(dark),
    bounds: ALL_BOUNDS,
    fitBoundsOptions: { padding: 30 },
    cooperativeGestures: true,
    attributionControl: { compact: false, customAttribution: 'Routes: <a href="https://project-osrm.org">OSRM</a>' },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
  const state = { ready: false, view: null, selected: null, hovered: null, focused: null };
  const api = { element, onPick: () => {}, update };

  function applyFocus() {
    const id = state.selected ?? state.hovered;
    const row = id ? state.view.rows.find((r) => r.route.id === id) : null;
    if (!row) {
      map.getSource('driven').setData(lines([]));
      map.getSource('remaining').setData(lines([]));
      map.getSource('stops').setData(points([]));
      return;
    }
    const { driven, remaining } = splitPath(row.route.path, row.routeDone);
    map.getSource('driven').setData(lines([driven]));
    map.getSource('remaining').setData(lines([remaining]));
    map.getSource('stops').setData(points(row.route.stops.map((at) => ({ at }))));
  }

  function applyView() {
    const { view, selected } = state;
    map.getSource('vehicles').setData(points(view.rows.map((row) => ({
      at: row.position,
      id: row.route.id,
      icon: ICON_FOR[row.status],
      order: 10 - STATUS[row.status].rank,
      label: `${row.route.id} · ${row.route.area} · ${STATUS[row.status].label}`,
    }))));
    map.getSource('attention').setData(lines(view.decisions.map((d) => d.row.route.path)));
    map.getSource('zones').setData({
      type: 'FeatureCollection',
      features: state.zones.map((zone) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(zone)] } })),
    });
    applyFocus();

    if (selected !== state.focused) {
      state.focused = selected;
      const route = ROUTES.find((r) => r.id === selected);
      map.fitBounds(route ? boundsOf([route.path]) : ALL_BOUNDS, { padding: route ? 40 : 24, duration: 500 });
    }
  }

  function update(view, selected, zones = []) {
    state.view = view;
    state.selected = selected;
    state.zones = zones;
    // Resize first: the map may have just come back on screen, and fitting needs its real size.
    requestAnimationFrame(() => {
      map.resize();
      if (state.ready) applyView();
    });
  }

  // The map style names a texture it doesn't ship. A blank image keeps the console clean.
  map.setMissingStyleImageResolver((id) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  map.on('load', () => {
    for (const [name, draw] of Object.entries(ICONS)) map.addImage(name, icon(draw), { pixelRatio: 2 });
    map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': COLORS.bad, 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': COLORS.bad, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    for (const id of ['attention', 'driven', 'remaining']) map.addSource(id, { type: 'geojson', data: lines([]) });
    for (const id of ['stops', 'vehicles']) map.addSource(id, { type: 'geojson', data: points([]) });
    map.addSource('depot', { type: 'geojson', data: points([{ at: DEPOT }]) });

    map.addLayer({ id: 'attention', type: 'line', source: 'attention', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.warn, 'line-width': 2, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'driven', type: 'line', source: 'driven', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.none, 'line-width': 3 } });
    map.addLayer({ id: 'remaining', type: 'line', source: 'remaining', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.todo, 'line-width': 4 } });
    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': COLORS.todo, 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'depot', type: 'symbol', source: 'depot', layout: { 'icon-image': 'depot', 'icon-allow-overlap': true } });
    map.addLayer({ id: 'vehicles', type: 'symbol', source: 'vehicles', layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'symbol-sort-key': ['get', 'order'] } });

    map.on('click', 'vehicles', (event) => api.onPick(event.features[0].properties.id));
    map.on('mousemove', 'vehicles', (event) => {
      const [feature] = event.features;
      map.getCanvas().style.cursor = 'pointer';
      popup.setLngLat(feature.geometry.coordinates).setText(feature.properties.label).addTo(map);
      if (state.hovered !== feature.properties.id) {
        state.hovered = feature.properties.id;
        applyFocus();
      }
    });
    map.on('mouseleave', 'vehicles', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
      state.hovered = null;
      applyFocus();
    });

    state.ready = true;
    map.resize();
    map.fitBounds(ALL_BOUNDS, { padding: 24, duration: 0 });
    if (state.view) applyView();
  });

  map.on('error', (event) => {
    if (event.error?.name === 'AbortError') return;
    console.error('Map error:', event.error?.message ?? event.error);
    if (state.ready || element.querySelector('.map-note')) return;
    element.append(h('p', { class: 'map-note' }, 'The map couldn’t load. Every route is still in the table below.'));
  });

  return api;
}

export function getFleetMap() {
  instance ??= createFleetMap();
  return instance;
}
