// One map for the life of the page, so tab changes and re-renders don't reload the tiles.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { boundsOf, circlePolygon, splitPath } from '../core/geo.js';
import { DEPOT, ROUTES, STATUS } from '../scenarios/operations.js';
import { h } from './dom.js';

// Vite moves the package, so the background worker has to be pointed at explicitly.
maplibregl.setWorkerUrl(workerUrl);

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const COLORS = { good: '#39ff88', warn: '#ffc21a', bad: '#ff2d3f', none: '#9aa4ad', todo: '#22e3ff', driven: '#5d6871' };
const ICON_FOR = {
  ON_TRACK: 'on-track', UNCONFIRMED: 'no-signal', NO_FORECAST: 'no-signal',
  AT_RISK: 'at-risk', PART_FAULT: 'at-risk', WONT_FINISH: 'critical', OUT_OF_SERVICE: 'critical',
};
const TILT = 60;
const BEARING = -18;
// Building shapes only exist from zoom 13, so the city view opens there, centered on the core.
const CITY = { center: [-118.262, 34.044], zoom: 13.05 };
const ALL_BOUNDS = boundsOf(ROUTES.map((r) => r.path));
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => window.innerWidth <= 760;

function icon(draw) {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  c.lineWidth = 4;
  draw(c);
  return c.getImageData(0, 0, size, size);
}

const circle = (c, fill, stroke) => {
  c.beginPath();
  c.arc(22, 22, 13, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = stroke;
  c.stroke();
};

const ICONS = {
  'on-track': (c) => circle(c, COLORS.good, '#06140c'),
  'no-signal': (c) => circle(c, '#10151a', '#e8eef2'),
  'at-risk': (c) => {
    c.beginPath();
    c.moveTo(22, 5); c.lineTo(39, 36); c.lineTo(5, 36); c.closePath();
    c.fillStyle = COLORS.warn; c.fill(); c.strokeStyle = '#1a1300'; c.stroke();
  },
  critical: (c) => { c.fillStyle = COLORS.bad; c.fillRect(8, 8, 28, 28); c.strokeStyle = '#ffffff'; c.strokeRect(8, 8, 28, 28); },
};

const lines = (coordinateSets) => ({
  type: 'FeatureCollection',
  features: coordinateSets.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })),
});

const points = (items) => ({
  type: 'FeatureCollection',
  features: items.map(({ at, ...properties }) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: at } })),
});

const polygons = (rings) => ({
  type: 'FeatureCollection',
  features: rings.map((ring) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })),
});

// A line with a soft halo behind it, so the route reads against the dark city.
function glowLine(map, id, color, width) {
  const layout = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: `${id}-glow`, type: 'line', source: id, layout, paint: { 'line-color': color, 'line-width': width * 4, 'line-blur': width * 3, 'line-opacity': 0.55 } });
  map.addLayer({ id, type: 'line', source: id, layout, paint: { 'line-color': color, 'line-width': width } });
}

function darkenBaseMap(map) {
  const { layers } = map.getStyle();
  for (const layer of layers) {
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#111418');
    if (layer.type === 'line' && layer['source-layer'] === 'transportation') map.setPaintProperty(layer.id, 'line-color', '#343b42');
    if (layer.type === 'fill' && layer['source-layer'] === 'building') map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
  // Above every road and fill, but under the labels. The style mixes a few labels in early.
  const lastShape = layers.findLastIndex((layer) => layer.type !== 'symbol');
  const firstLabel = layers.slice(lastShape + 1).find((layer) => layer.type === 'symbol')?.id;
  const source = layers.find((layer) => layer['source-layer'] === 'building')?.source ?? 'openmaptiles';
  map.setLight({ anchor: 'viewport', position: [1.3, 40, 60], intensity: 0.55, color: '#dfeaf2' });
  map.addLayer({
    id: 'buildings-3d', type: 'fill-extrusion', source, 'source-layer': 'building', minzoom: 13,
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#2b323a', 40, '#46515c', 150, '#7f8e9c'],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.95,
    },
  }, firstLabel);
}

let instance = null;

function createFleetMap() {
  const element = h('div', { class: 'fleetmap' });
  const canvas = h('div', { class: 'map-canvas' });
  element.append(canvas);

  const map = new maplibregl.Map({
    container: canvas,
    style: STYLE,
    ...CITY,
    pitch: TILT,
    bearing: BEARING,
    maxPitch: 70,
    cooperativeGestures: true,
    attributionControl: false,
  });
  // Bottom left, so the details panel can never cover the required credits.
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: 'Routes: <a href="https://project-osrm.org">OSRM</a>' }), 'bottom-left');

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
  const state = { ready: false, view: null, selected: null, hovered: null, focused: null, zones: [], tilted: true };
  const api = { element, onPick: () => {}, update };

  const camera = () => ({ pitch: state.tilted ? TILT : 0, bearing: state.tilted ? BEARING : 0 });
  const time = (duration) => (calm() ? 0 : duration);

  function fitFleet(duration = 700) {
    map.fitBounds(ALL_BOUNDS, { ...camera(), padding: narrow() ? 30 : { top: 70, bottom: 60, left: 110, right: 110 }, duration: time(duration) });
  }

  function frame(route, duration = 700) {
    if (route) {
      const padding = narrow() ? 30 : { top: 80, bottom: 80, left: 100, right: 460 };
      const fitted = map.cameraForBounds(boundsOf([route.path]), { ...camera(), padding });
      // Stay close enough for the buildings to exist, even if a long route runs off the edge.
      map.easeTo({ ...fitted, ...camera(), zoom: Math.max(fitted.zoom, CITY.zoom), duration: time(duration) });
    } else if (narrow()) {
      fitFleet(duration);
    } else {
      map.easeTo({ ...CITY, ...camera(), duration: time(duration) });
    }
  }

  const dimensions = h('button', {
    'aria-label': 'Switch between 2D and 3D',
    onClick: () => {
      state.tilted = !state.tilted;
      dimensions.textContent = state.tilted ? '2D' : '3D';
      map.easeTo({ ...camera(), duration: time(600) });
    },
  }, '2D');
  const needle = h('span', { class: 'needle' }, 'N');
  element.append(h('div', { class: 'map-controls' },
    h('button', { 'aria-label': 'Face north', onClick: () => map.easeTo({ bearing: 0, duration: time(500) }) }, needle),
    dimensions,
    h('button', { 'aria-label': 'Zoom in', onClick: () => map.zoomIn() }, '+'),
    h('button', { 'aria-label': 'Zoom out', onClick: () => map.zoomOut() }, '−'),
    h('button', { 'aria-label': 'Show the whole fleet', title: 'Show the whole fleet', onClick: () => fitFleet() }, '⌂'),
  ));
  map.on('rotate', () => { needle.style.transform = `rotate(${-map.getBearing()}deg)`; });

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
    map.getSource('zones').setData(polygons(state.zones.map((zone) => circlePolygon(zone))));
    applyFocus();

    if (selected !== state.focused) {
      state.focused = selected;
      frame(ROUTES.find((r) => r.id === selected));
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
    darkenBaseMap(map);
    for (const [name, draw] of Object.entries(ICONS)) map.addImage(name, icon(draw), { pixelRatio: 2 });

    map.addSource('zones', { type: 'geojson', data: polygons([]) });
    map.addSource('depot', { type: 'geojson', data: polygons([circlePolygon({ center: DEPOT, radiusKm: 0.14 }, 6)]) });
    for (const id of ['attention', 'driven', 'remaining']) map.addSource(id, { type: 'geojson', data: lines([]) });
    for (const id of ['stops', 'vehicles']) map.addSource(id, { type: 'geojson', data: points([]) });

    map.addLayer({ id: 'zones-3d', type: 'fill-extrusion', source: 'zones', paint: { 'fill-extrusion-color': COLORS.bad, 'fill-extrusion-height': 130, 'fill-extrusion-opacity': 0.42 } });
    map.addLayer({ id: 'depot-3d', type: 'fill-extrusion', source: 'depot', paint: { 'fill-extrusion-color': COLORS.todo, 'fill-extrusion-height': 170, 'fill-extrusion-opacity': 0.75 } });
    glowLine(map, 'attention', COLORS.bad, 3);
    map.addLayer({ id: 'driven', type: 'line', source: 'driven', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.driven, 'line-width': 3 } });
    glowLine(map, 'remaining', COLORS.todo, 4);
    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': COLORS.todo, 'circle-stroke-width': 2 } });
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
    frame(ROUTES.find((r) => r.id === state.selected), 0);
    state.focused = state.selected;
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
