'use strict';

/* ------------------------------------------------------------------
 * Nav 3D : carte 3D, guidage et alertes trafic pour le navigateur Tesla.
 * Sources gratuites :
 *  - Carte : OpenFreeMap (tuiles OpenStreetMap, sans clé)
 *  - Itinéraire : serveur OSRM public (sans clé, usage raisonnable)
 *  - Adresses : Base Adresse Nationale (France) ou Photon (Europe)
 *  - Alertes : TomTom Traffic Incidents (clé gratuite)
 *  - Limitations de vitesse : TomTom (sur l'itinéraire) ou OpenStreetMap (Overpass)
 *  - Météo (pluie, brouillard) : Open-Meteo (sans clé)
 * ------------------------------------------------------------------ */

const CFG = {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  osrm: 'https://router.project-osrm.org/route/v1/driving/',
  geocoders: {
    fr: 'https://api-adresse.data.gouv.fr/search/',
    eu: 'https://photon.komoot.io/api/',
  },
  search: 'https://api.tomtom.com/search/2/search/',
  ttRoute: 'https://api.tomtom.com/routing/1/calculateRoute/',
  incidents: 'https://api.tomtom.com/traffic/services/5/incidentDetails',
  flowTiles: 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png',
  start: [2.3522, 48.8566], // Paris tant que le GPS n'a pas répondu
  incidentRefreshMs: 120000, // 2 min : ~720 requêtes/jour en roulant 24 h
  incidentRadiusKm: 45, // la zone TomTom est limitée à 10 000 km²
  offRouteM: 50,
  alertAheadM: 5000,
  demoSpeed: 15, // m/s (~54 km/h)
  overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  meteo: 'https://api.open-meteo.com/v1/forecast',
  osmRadiusM: 700, // zone de routes OpenStreetMap chargée autour de la voiture
  weatherRefreshMs: 600000, // météo : toutes les 10 min (ou après 15 km)
  exitZoneM: 900, // vue « sortie » à l'approche d'une sortie / bifurcation
};

/* ---------- Réglages enregistrés dans le navigateur ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('nav.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nav.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const params = new URLSearchParams(location.search);
// Clé TomTom : lien ?key=... > clé saisie dans ⚙ > fichier config.js
const configKey = ((window.NAV_CONFIG && window.NAV_CONFIG.tomtomKey) || '').trim();
const settings = {
  key: (params.get('key') || '').trim() || store.get('key', '') || configKey,
  geocoder: store.get('geocoder', 'fr'),
  voice: store.get('voice', true),
  demo: params.has('demo') || store.get('demo', false),
  flow: store.get('flow', false),
  is3d: store.get('is3d', true),
  compact: store.get('compact', true),
  wx: store.get('wx', 'auto'), // météo : auto / pluie forcée / sec forcé
};
if (params.get('key')) {
  store.set('key', settings.key);
  // On retire la clé de l'adresse : le favori enregistré ensuite reste propre.
  params.delete('key');
  const qs = params.toString();
  try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch { /* ignoré */ }
}

const $ = (id) => document.getElementById(id);

/* ---------- Géométrie ---------- */
const R = 6371000;
const rad = (d) => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Projette p sur la polyligne : distance à la ligne et position le long (m).
function project(p, line) {
  const kx = Math.cos(rad(p[1])) * R * Math.PI / 180, ky = R * Math.PI / 180;
  let best = { d: Infinity, along: 0, i: 0 };
  for (let i = 0; i < line.coords.length - 1; i++) {
    const a = line.coords[i], b = line.coords[i + 1];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y);
    if (d < best.d) best = { d, along: line.cum[i] + t * (line.cum[i + 1] - line.cum[i]), i };
  }
  return best;
}
function pointAt(line, along) {
  const c = line.coords, cum = line.cum;
  if (along <= 0) return c[0];
  for (let i = 0; i < c.length - 1; i++) {
    if (cum[i + 1] >= along) {
      const t = (along - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
      return [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])];
    }
  }
  return c[c.length - 1];
}
function fmtDist(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
function fmtTime(date) { return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Carte ---------- */
const map = new maplibregl.Map({
  container: 'map',
  style: CFG.style,
  center: store.get('lastPos', CFG.start),
  zoom: 15,
  pitch: settings.is3d ? 60 : 0,
  maxPitch: 75,
  attributionControl: { compact: true },
});

const state = {
  pos: null, heading: 0, speed: 0,
  follow: true,
  route: null, // { coords, cum, steps, distance, duration, dest }
  offCount: 0, lastReroute: 0,
  avoid: [], // routes fermées à contourner pour le trajet en cours [[lon, lat]]
  closureChecked: new Set(),
  spoken: new Set(),
  incidents: [], incidentMarkers: [], lastIncidentFetch: 0, lastIncidentCenter: null,
  demoTimer: null, demoAlong: 0,
  along: null, // position le long de l'itinéraire (m), si on est dessus
  exitMode: false,
  limit: null, lastLimitSaid: null,
  osm: { ways: [], center: null, at: 0, busy: false, cur: null },
  weather: { wet: false, fog: false, at: 0, center: null, text: '' },
};

const meEl = document.createElement('div');
meEl.className = 'me';
meEl.innerHTML = '<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#3e8ef7" fill-opacity="0.25"/><path d="M22 6 L34 36 L22 29 L10 36 Z" fill="#fff" stroke="#3e8ef7" stroke-width="2.5" stroke-linejoin="round"/></svg>';
const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map', pitchAlignment: 'map' });

map.on('load', () => {
  add3dBuildings();
  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#0b3d91', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 16] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#3e8ef7', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 11] } });
  // Branche de la prochaine sortie, mise en évidence en vue « sortie ».
  map.addSource('maneuver', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'maneuver-casing', type: 'line', source: 'maneuver', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#0b3d91', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 10, 18, 30] } });
  map.addLayer({ id: 'maneuver-line', type: 'line', source: 'maneuver', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#7fd3ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 20] } });
  map.addSource('incident-lines', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'incident-lines', type: 'line', source: 'incident-lines', layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['match', ['get', 'mag'], 4, '#8b0000', 3, '#e5484d', 2, '#f76b15', 1, '#f5a524', '#b0b0b0'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 8], 'line-opacity': 0.85 } });
  if (settings.flow) setFlow(true);
  refreshIncidents(true);
});
map.on('error', (e) => console.warn('Carte :', e && e.error ? e.error.message : e));

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

// Bâtiments en relief : le style "liberty" en a déjà ; sinon on les ajoute.
function add3dBuildings() {
  const layers = map.getStyle().layers || [];
  if (layers.some((l) => l.type === 'fill-extrusion')) return;
  if (!map.getSource('openmaptiles')) return;
  const firstSymbol = layers.find((l) => l.type === 'symbol');
  map.addLayer({ id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
    paint: { 'fill-extrusion-color': '#c9c3bb', 'fill-extrusion-opacity': 0.8,
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] } }, firstSymbol && firstSymbol.id);
}

// Quand l'utilisateur touche la carte, on arrête de suivre la voiture.
map.on('dragstart', () => setFollow(false));
function setFollow(on) {
  state.follow = on;
  $('recenter').classList.toggle('on', on);
  if (on && state.pos) moveCamera(true);
}

function moveCamera(force) {
  if (!state.follow || !state.pos) return;
  const opts = { center: state.pos, duration: force ? 600 : 900, easing: (t) => t };
  if (state.speed > 1.5) opts.bearing = state.heading;
  if (state.route) {
    opts.zoom = state.speed > 25 ? 14.5 : state.speed > 14 ? 15.5 : 16.5;
    opts.pitch = settings.is3d ? 60 : 0;
    if (state.exitMode) {
      // Vue « sortie » : on zoome et on incline pour bien voir la bretelle.
      opts.zoom = state.speed > 25 ? 16.6 : 17.2;
      opts.pitch = settings.is3d ? 72 : 0;
      if (state.along != null) opts.bearing = bearing(state.pos, pointAt(state.route, state.along + 120));
    }
    // Décale la voiture vers le bas de l'écran pour voir plus loin devant.
    // Et vers la droite, pour qu'elle ne soit pas cachée par le panneau de gauche.
    const w = map.getContainer().clientWidth;
    const panelW = $('panel').offsetWidth + 16;
    const dx = w > 900 ? panelW / 2 : 0;
    opts.offset = [dx, map.getContainer().clientHeight * 0.2];
  }
  map.easeTo(opts);
}

/* ---------- Position ---------- */
function onPosition(lngLat, heading, speed) {
  const prev = state.pos;
  state.pos = lngLat;
  if (typeof speed === 'number' && !Number.isNaN(speed)) state.speed = speed;
  if (typeof heading === 'number' && !Number.isNaN(heading) && state.speed > 1) state.heading = heading;
  else if (prev && dist(prev, lngLat) > 3) state.heading = bearing(prev, lngLat);
  meMarker.setLngLat(lngLat).setRotation(state.heading);
  if (!meMarker._map) meMarker.addTo(map);
  $('speed').hidden = false;
  $('speed-val').textContent = Math.round(state.speed * 3.6);
  store.set('lastPos', lngLat);
  if (state.route) updateGuidance();
  else { state.along = null; setExitMode(false); }
  moveCamera(false);
  refreshIncidents(false);
  refreshWeather(false);
  updateLimit();
}

let gpsWatch = null;
function startGps() {
  if (!('geolocation' in navigator)) { setStatus('gps', 'GPS indisponible'); return; }
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      if (state.demoTimer) return;
      setStatus('gps', `GPS ±${Math.round(p.coords.accuracy)} m`);
      onPosition([p.coords.longitude, p.coords.latitude], p.coords.heading, p.coords.speed);
    },
    (err) => setStatus('gps', err.code === 1 ? 'GPS refusé : autorisez la localisation' : 'Recherche GPS…'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
}

/* ---------- Recherche d'adresse et de lieux ---------- */
let searchTimer = null, searchSeq = 0;
const DEFAULT_PLACEHOLDER = $('q').placeholder;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  $('places').hidden = q.length > 0;
  if (q.length < 3) { $('results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => search(q), 700);
});
$('search').addEventListener('submit', (e) => { e.preventDefault(); const q = $('q').value.trim(); if (q) search(q); });

// Trois sources interrogées en même temps, puis fusionnées :
//  - TomTom (si clé) : lieux et commerces (« Enedis Caen », « Leclerc »…), triés près de vous
//  - Photon (OpenStreetMap) : lieux et adresses, gratuit, sans clé
//  - Base Adresse Nationale : adresses françaises précises (mode France)
async function searchTomTom(q, near) {
  if (!settings.key) return [];
  const countries = settings.geocoder === 'fr' ? '&countrySet=FR' : '';
  const url = `${CFG.search}${encodeURIComponent(q)}.json?key=${encodeURIComponent(settings.key)}&lat=${near[1]}&lon=${near[0]}&limit=8&language=fr-FR${countries}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('tomtom ' + res.status);
  const data = await res.json();
  return (data.results || []).map((r) => {
    const a = r.address || {};
    const isPoi = r.type === 'POI' && r.poi;
    return {
      label: isPoi ? r.poi.name : (a.freeformAddress || q),
      sub: isPoi ? (a.freeformAddress || a.municipality || '') : [a.municipality, a.country].filter(Boolean).join(', '),
      coord: [r.position.lon, r.position.lat],
    };
  });
}
async function searchPhoton(q, near) {
  const url = `${CFG.geocoders.eu}?q=${encodeURIComponent(q)}&limit=6&lang=fr&lat=${near[1]}&lon=${near[0]}&location_bias_scale=0.5`;
  const data = await (await fetch(url)).json();
  return data.features.map((f) => {
    const p = f.properties;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const label = p.name || street || p.city;
    const sub = [p.name ? street : '', p.postcode, p.city].filter(Boolean).join(' ');
    return { label, sub, coord: f.geometry.coordinates };
  });
}
async function searchBan(q, near) {
  const url = `${CFG.geocoders.fr}?q=${encodeURIComponent(q)}&limit=5&lat=${near[1]}&lon=${near[0]}`;
  const data = await (await fetch(url)).json();
  return data.features.map((f) => ({ label: f.properties.label, sub: f.properties.context, coord: f.geometry.coordinates, score: f.properties.score }));
}

async function search(q) {
  const seq = ++searchSeq;
  const near = state.pos || map.getCenter().toArray();
  const jobs = [searchTomTom(q, near), searchPhoton(q, near)];
  if (settings.geocoder === 'fr') jobs.push(searchBan(q, near));
  const results = await Promise.allSettled(jobs);
  if (seq !== searchSeq) return;
  const [tt, ph, ban] = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
  if (results.every((r) => r.status === 'rejected')) {
    $('results').innerHTML = '<li>Recherche impossible (réseau ?)</li>';
    return;
  }
  // Adresses BAN sûres d'abord (numéro + rue), puis lieux TomTom, puis OpenStreetMap.
  const goodBan = (ban || []).filter((x) => x.score > 0.6);
  const merged = [...goodBan, ...tt, ...ph, ...(ban || []).filter((x) => x.score <= 0.6)];
  const items = [];
  for (const it of merged) {
    if (!it.label || !it.coord) continue;
    if (items.some((o) => dist(o.coord, it.coord) < 150 && o.label.toLowerCase() === it.label.toLowerCase())) continue;
    items.push(it);
    if (items.length >= 8) break;
  }
  const ul = $('results');
  ul.innerHTML = items.length ? '' : '<li>Aucun résultat</li>';
  items.forEach((it) => {
    const li = document.createElement('li');
    const km = fmtDist(dist(near, it.coord));
    li.innerHTML = `${esc(it.label)}<small>${esc(it.sub || '')} · ${esc(km)}</small><button type="button" class="fav-btn" title="Enregistrer">☆</button>`;
    li.querySelector('.fav-btn').addEventListener('click', (e) => { e.stopPropagation(); openFavSheet(it); });
    li.addEventListener('click', () => {
      ul.innerHTML = '';
      $('q').blur();
      if (state.pendingFav) { saveFav(state.pendingFav, it); $('q').value = ''; return; }
      $('q').value = it.label;
      startRoute(it.coord, it.label);
    });
    ul.appendChild(li);
  });
}

/* ---------- Lieux favoris (enregistrés dans le navigateur de la voiture) ---------- */
const FAV_ICONS = { domicile: '🏠', travail: '💼' };
const favIcon = (name) => FAV_ICONS[name.toLowerCase()] || '⭐';
function getFavs() { return store.get('places', []); }
function saveFav(name, it) {
  name = name.trim();
  if (!name) return;
  const favs = getFavs().filter((f) => f.name.toLowerCase() !== name.toLowerCase());
  favs.push({ name, label: it.label, sub: it.sub || '', coord: it.coord });
  store.set('places', favs);
  state.pendingFav = null;
  $('q').placeholder = DEFAULT_PLACEHOLDER;
  renderFavs();
  setStatus('route', `${favIcon(name)} ${name} enregistré`);
}
function renderFavs() {
  const ul = $('places');
  ul.innerHTML = '';
  const favs = getFavs();
  // Domicile et Travail toujours proposés, même pas encore définis.
  ['Domicile', 'Travail'].forEach((n) => {
    if (!favs.some((f) => f.name.toLowerCase() === n.toLowerCase())) favs.push({ name: n, todo: true });
  });
  const order = (f) => ({ domicile: 0, travail: 1 }[f.name.toLowerCase()] ?? 2);
  favs.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, 'fr'));
  favs.forEach((f) => {
    const li = document.createElement('li');
    if (f.todo) {
      li.className = 'todo';
      li.innerHTML = `${favIcon(f.name)} ${esc(f.name)}<small>Toucher pour définir l'adresse</small>`;
      li.addEventListener('click', () => askFavAddress(f.name));
      ul.appendChild(li);
      return;
    }
    li.innerHTML = `${favIcon(f.name)} ${esc(f.name)}<small>${esc(f.label)}</small><button type="button" class="del-btn" title="Supprimer">✕</button>`;
    li.addEventListener('click', () => { $('places').hidden = true; startRoute(f.coord, f.name); });
    li.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer « ${f.name} » ?`)) return;
      store.set('places', getFavs().filter((x) => x.name !== f.name));
      renderFavs();
    });
    ul.appendChild(li);
  });
}
function askFavAddress(name) {
  state.pendingFav = name;
  $('q').value = '';
  $('q').placeholder = `Adresse de « ${name} » ?`;
  $('q').focus();
}
let favTarget = null;
function openFavSheet(it) {
  favTarget = it;
  $('favWhat').textContent = `${it.label}${it.sub ? ' · ' + it.sub : ''}`;
  $('favName').value = '';
  $('favSheet').hidden = false;
}
document.querySelectorAll('#favSheet [data-fav]').forEach((b) => b.addEventListener('click', () => {
  saveFav(b.dataset.fav, favTarget); $('favSheet').hidden = true;
}));
$('favSave').addEventListener('click', () => {
  if (!$('favName').value.trim()) { $('favName').focus(); return; }
  saveFav($('favName').value, favTarget); $('favSheet').hidden = true;
});
$('favCancel').addEventListener('click', () => { $('favSheet').hidden = true; });

/* ---------- Itinéraire ---------- */
async function startRoute(dest, label) {
  const from = state.pos || map.getCenter().toArray();
  state.avoid = [];
  state.closureChecked.clear();
  setStatus('route', 'Calcul de l\'itinéraire…');
  try {
    const route = await fetchRoute(from, dest);
    route.label = label;
    setRoute(route);
    const b = new maplibregl.LngLatBounds();
    route.coords.forEach((c) => b.extend(c));
    setFollow(false);
    map.fitBounds(b, { padding: { top: 80, bottom: 80, left: 480, right: 120 }, pitch: 0, bearing: 0, duration: 800 });
    setTimeout(() => { setFollow(true); if (settings.demo) startDemo(); }, 2500);
    speak(`Itinéraire calculé. ${fmtDist(route.distance)}, ${fmtDuration(route.duration)}.`);
  } catch (e) {
    console.warn(e);
    setStatus('route', 'Itinéraire impossible');
  }
}

// Itinéraire : TomTom (trafic en temps réel, évite les routes fermées) si une clé est
// configurée, sinon OSRM (gratuit, sans trafic).
async function fetchRoute(from, dest) {
  if (settings.key) {
    try { return await fetchRouteTomTom(from, dest); } catch (e) { console.warn('TomTom routing', e); }
  }
  return fetchRouteOsrm(from, dest);
}

function lineFrom(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return { coords, cum };
}

async function fetchRouteTomTom(from, dest) {
  // Limitations de vitesse et voies (flèches) demandées en plus ; si TomTom refuse, on réessaie sans.
  const base = `${CFG.ttRoute}${from[1]},${from[0]}:${dest[1]},${dest[0]}/json?key=${encodeURIComponent(settings.key)}`
    + '&traffic=true&travelMode=car&routeType=fastest&instructionsType=text&language=fr-FR&routeRepresentation=polyline';
  const extras = ['&sectionType=speedLimit&sectionType=lanes', '&sectionType=speedLimit', ''];
  const opts = {};
  if (state.avoid.length) {
    // Petit rectangle (~150 m) autour de chaque fermeture.
    const rectangles = state.avoid.map(([lon, lat]) => {
      const dLat = 0.0013, dLon = 0.0013 / Math.cos(rad(lat));
      return { southWestCorner: { latitude: lat - dLat, longitude: lon - dLon }, northEastCorner: { latitude: lat + dLat, longitude: lon + dLon } };
    });
    opts.method = 'POST';
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify({ avoidAreas: { rectangles } });
  }
  let res;
  for (const extra of extras) {
    res = await fetch(base + extra, opts);
    if (res.status !== 400) break;
  }
  if (!res.ok) throw new Error('tomtom ' + res.status);
  const data = await res.json();
  const r = data.routes && data.routes[0];
  if (!r) throw new Error('aucun itinéraire');
  const coords = [];
  r.legs.forEach((leg) => leg.points.forEach((pt) => coords.push([pt.longitude, pt.latitude])));
  const line = lineFrom(coords);
  const total = r.summary.lengthInMeters || line.cum[line.cum.length - 1];
  const scale = line.cum[line.cum.length - 1] / (total || 1);
  const steps = ((r.guidance && r.guidance.instructions) || [])
    .filter((i) => i.message && i.maneuver !== 'DEPART')
    .map((i) => ({
      along: (i.routeOffsetInMeters || 0) * scale, text: i.message, icon: ttIcon(i.maneuver),
      exit: TT_EXITS.test(i.maneuver || '') || i.junctionType === 'BIFURCATION',
      sign: { num: i.exitNumber || '', towards: i.signpostText || '', roads: (i.roadNumbers || []).join(' · '), motorway: !!i.exitNumber || /MOTORWAY/.test(i.maneuver || '') },
    }));
  // Sections : limitations de vitesse et voies, repérées par index de points du tracé.
  const at = (idx) => line.cum[Math.max(0, Math.min(line.cum.length - 1, idx || 0))];
  const speeds = [], lanes = [];
  (r.sections || []).forEach((s) => {
    if (s.sectionType === 'SPEED_LIMIT' && s.maxSpeedLimitInKmh) {
      speeds.push({ from: at(s.startPointIndex), to: at(s.endPointIndex), kmh: s.maxSpeedLimitInKmh });
    } else if (s.sectionType === 'LANES' && Array.isArray(s.lanes) && s.lanes.length > 1) {
      lanes.push({ from: at(s.startPointIndex), to: at(s.endPointIndex),
        lanes: s.lanes.map((l) => ({ dirs: (l.directions || []).map(normDir), ok: !!l.follow })) });
    }
  });
  return { ...line, steps, speeds, lanes, distance: total, duration: r.summary.travelTimeInSeconds, dest, source: 'tomtom' };
}
const TT_EXITS = /EXIT|KEEP_|BEAR_|SWITCH_|TAKE_RAMP|FORK/;
// Direction d'une voie, au format commun : 'straight', 'slight right', 'left'…
const normDir = (d) => String(d || '').toLowerCase().replace(/_/g, ' ').replace('u turn', 'uturn');
function ttIcon(m = '') {
  if (m === 'ARRIVE' || m.startsWith('ARRIVE')) return '⚑';
  if (m.includes('ROUNDABOUT')) return '⟳';
  if (m.includes('UTURN')) return '↶';
  if (m === 'SHARP_LEFT') return '↙';
  if (m === 'SHARP_RIGHT') return '↘';
  if (m === 'TURN_LEFT') return '←';
  if (m === 'TURN_RIGHT') return '→';
  if (m.includes('LEFT')) return '↖';
  if (m.includes('RIGHT')) return '↗';
  return '↑';
}

async function fetchRouteOsrm(from, dest) {
  const url = `${CFG.osrm}${from[0]},${from[1]};${dest[0]},${dest[1]}?overview=full&geometries=geojson&steps=true`;
  const data = await (await fetch(url)).json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.message || data.code);
  const r = data.routes[0];
  const line = lineFrom(r.geometry.coordinates);
  const cum = line.cum;
  // Position de chaque manœuvre le long du tracé.
  const steps = [];
  let acc = 0;
  r.legs.forEach((leg) => leg.steps.forEach((s) => {
    const t = s.maneuver.type;
    steps.push({ ...s, along: acc, text: instruction(s), icon: icon(s),
      exit: t === 'off ramp' || t === 'fork',
      sign: { num: s.exits ? String(s.exits).split(';')[0] : '', towards: s.destinations ? s.destinations.split(':').pop().trim() : '',
        roads: s.ref || '', motorway: !!s.exits } });
    acc += s.distance;
  }));
  const scale = cum[cum.length - 1] / (acc || 1); // aligne nos distances sur celles d'OSRM
  steps.forEach((s) => { s.along *= scale; });
  // Voies (flèches) au carrefour de chaque manœuvre, affichées dans les 600 m avant.
  const lanes = [];
  steps.forEach((s) => {
    const l = s.intersections && s.intersections[0] && s.intersections[0].lanes;
    if (l && l.length > 1) lanes.push({ from: s.along - 600, to: s.along, lanes: l.map((x) => ({ dirs: x.indications || [], ok: !!x.valid })) });
  });
  return { ...line, steps, lanes, speeds: [], distance: r.distance, duration: r.duration, dest, source: 'osrm' };
}

function setRoute(route) {
  state.route = route;
  state.offCount = 0;
  state.spoken.clear();
  map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} });
  $('guidance').hidden = false;
  $('guidance').classList.toggle('compact', settings.compact);
  document.body.classList.add('navigating');
  setStatus('route', `${fmtDist(route.distance)} · ${fmtDuration(route.duration)}`);
  updateGuidance();
  refreshIncidents(true);
  keepAwake(true);
}

function stopRoute() {
  state.route = null;
  stopDemo();
  if (map.getSource('route')) map.getSource('route').setData(emptyFC());
  state.along = null;
  setExitMode(false);
  $('lanes').innerHTML = '';
  $('guidance').hidden = true;
  $('alert').hidden = true;
  document.body.classList.remove('navigating');
  $('q').value = '';
  $('places').hidden = false;
  setStatus('route', '');
  map.easeTo({ pitch: settings.is3d ? 60 : 0, offset: [0, 0] });
  keepAwake(false);
}

// Écran toujours allumé pendant le guidage (téléphone, tablette).
// Le navigateur relâche ce verrou quand on change d'appli : on le reprend au retour.
let wakeLock = null;
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* refusé (batterie faible…) : on n'insiste pas */ }
}
document.addEventListener('visibilitychange', () => { if (state.route) keepAwake(true); });
$('stop').addEventListener('click', (e) => { e.stopPropagation(); stopRoute(); });
// Toucher la carte de guidage la réduit / l'agrandit (choix mémorisé).
$('guidance').addEventListener('click', () => {
  settings.compact = !settings.compact;
  store.set('compact', settings.compact);
  $('guidance').classList.toggle('compact', settings.compact);
  if (state.follow) moveCamera(true);
});

const DIRS = {
  left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite',
  'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit', uturn: 'demi-tour',
};
function instruction(s) {
  const m = s.maneuver, mod = m.modifier || '';
  const road = s.name || s.ref || '';
  const on = road ? ` sur ${road}` : '';
  const toward = s.destinations ? ` vers ${s.destinations.split(':').pop().trim()}` : (road ? ` vers ${road}` : '');
  const dir = DIRS[mod] || '';
  switch (m.type) {
    case 'depart': return `Partez${on}`;
    case 'arrive': return 'Arrivée à destination';
    case 'roundabout': case 'rotary':
      return m.exit ? `Au rond-point, prenez la ${m.exit === 1 ? '1re' : m.exit + 'e'} sortie${on}` : `Prenez le rond-point${on}`;
    case 'exit roundabout': case 'exit rotary': return `Sortez du rond-point${on}`;
    case 'merge': return `Insérez-vous${on}`;
    case 'on ramp': return `Prenez la bretelle${toward}`;
    case 'off ramp': return `Prenez la sortie${toward}`;
    case 'fork': return `Restez ${mod.includes('left') ? 'à gauche' : 'à droite'}${toward}`;
    case 'end of road': return `Au bout de la route, tournez ${dir}${on}`;
    case 'continue': case 'new name':
      return !mod || mod === 'straight' ? `Continuez${on}` : mod === 'uturn' ? `Faites demi-tour${on}` : `Continuez ${dir}${on}`;
    default:
      if (mod === 'uturn') return `Faites demi-tour${on}`;
      if (mod === 'straight') return `Continuez tout droit${on}`;
      return `Tournez ${dir}${on}`;
  }
}
function icon(s) {
  const t = s.maneuver.type, mod = s.maneuver.modifier || 'straight';
  if (t === 'arrive') return '⚑';
  if (t === 'roundabout' || t === 'rotary') return '⟳';
  return { straight: '↑', 'slight left': '↖', 'slight right': '↗', left: '←', right: '→', 'sharp left': '↙', 'sharp right': '↘', uturn: '↶' }[mod] || '↑';
}

function updateGuidance() {
  const r = state.route;
  if (!r || !state.pos) return;
  const p = project(state.pos, r);

  // Hors itinéraire : recalcul après 3 positions consécutives trop loin.
  if (p.d > CFG.offRouteM) {
    if (++state.offCount >= 3 && Date.now() - state.lastReroute > 15000) {
      state.lastReroute = Date.now();
      state.offCount = 0;
      speak('Recalcul de l\'itinéraire');
      fetchRoute(state.pos, r.dest).then((nr) => { nr.label = r.label; setRoute(nr); }).catch(() => setStatus('route', 'Recalcul impossible'));
    }
  } else state.offCount = 0;

  state.along = p.d <= CFG.offRouteM ? p.along : null;
  const remaining = Math.max(0, r.cum[r.cum.length - 1] - p.along);
  const idx = r.steps.findIndex((s) => s.along > p.along + 5);
  if (idx === -1 || remaining < 25) {
    $('next-icon').textContent = '⚑';
    $('next-dist').textContent = 'Arrivé';
    $('next-text').textContent = r.label || 'Destination';
    $('then').textContent = '';
    $('eta').textContent = fmtTime(new Date());
    $('remain').textContent = '0 m';
    $('mini').textContent = 'Toucher pour arrêter';
    sayOnce('arrive', 'Vous êtes arrivé à destination');
    setExitMode(false);
    $('lanes').innerHTML = '';
    if (state.demoTimer) stopDemo();
    return;
  }
  const next = r.steps[idx], after = r.steps[idx + 1];
  const d = next.along - p.along;
  $('next-icon').textContent = next.icon;
  $('next-dist').textContent = fmtDist(d);
  $('next-text').textContent = next.text;
  $('then').textContent = after && after.along - next.along < 400 ? `Puis : ${after.text}` : '';
  const secs = r.duration * (remaining / (r.distance || 1));
  $('eta').textContent = fmtTime(new Date(Date.now() + secs * 1000));
  $('remain').textContent = `${fmtDist(remaining)} · ${fmtDuration(secs)}`;
  $('mini').textContent = `Arrivée ${$('eta').textContent} · ${$('remain').textContent}`;

  // Annonces vocales à 1 km, 300 m et juste avant la manœuvre.
  if (d < 60) sayOnce(`${idx}-now`, next.text);
  else if (d < 300) sayOnce(`${idx}-300`, `Dans ${fmtDist(d)}, ${lower(next.text)}`);
  else if (d < 1000 && d > 800) sayOnce(`${idx}-1000`, `Dans 1 kilomètre, ${lower(next.text)}`);

  updateRouteAlert(p.along);
  updateLanes(p.along);
  // Vue « sortie » : à l'approche d'une sortie ou bifurcation, et 150 m après.
  const prev = r.steps[idx - 1];
  const exitStep = next.exit && d < CFG.exitZoneM ? next : prev && prev.exit && p.along - prev.along < 150 ? prev : null;
  setExitMode(!!exitStep && state.along != null, exitStep, next === exitStep ? d : 0);
}

/* ---------- Voies et vue « sortie » ---------- */
const LANE_ARROWS = { straight: '↑', 'slight right': '↗', right: '→', 'sharp right': '↘', 'slight left': '↖', left: '←', 'sharp left': '↙', uturn: '↶', none: '↑', '': '↑' };
function updateLanes(along) {
  const r = state.route;
  const entry = (r.lanes || []).find((l) => along >= l.from - 300 && along <= l.to);
  const el = $('lanes');
  const key = entry ? r.lanes.indexOf(entry) : -1;
  if (el.dataset.key === String(key)) return;
  el.dataset.key = String(key);
  el.innerHTML = entry ? entry.lanes.map((l) => {
    const arrows = [...new Set((l.dirs.length ? l.dirs : ['straight']).map((d) => LANE_ARROWS[d] || '↑'))].join('');
    return `<span class="lane${l.ok ? ' ok' : ''}">${esc(arrows)}</span>`;
  }).join('') : '';
}

let exitKey = null;
function setExitMode(on, step, d) {
  const was = state.exitMode;
  state.exitMode = on;
  document.body.classList.toggle('exit-mode', on);
  $('junction').hidden = !on;
  if (!on) {
    exitKey = null;
    if (map.getSource('maneuver')) map.getSource('maneuver').setData(emptyFC());
    if (was && state.follow) moveCamera(true);
    return;
  }
  const r = state.route;
  if (exitKey !== step) {
    exitKey = step;
    const s = step.sign || {};
    $('junction').classList.toggle('motorway', !!s.motorway);
    $('j-num').textContent = s.num ? `Sortie ${s.num}` : (step.icon || '↗');
    $('j-num').hidden = false;
    $('j-towards').textContent = s.towards || step.text;
    $('j-roads').textContent = s.roads || '';
    // Tronçon à surligner : de 200 m avant la sortie à 350 m après.
    const pts = [];
    for (let a = Math.max(0, step.along - 200); a <= step.along + 350; a += 10) pts.push(pointAt(r, a));
    if (map.getSource('maneuver')) map.getSource('maneuver').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
    if (state.follow) moveCamera(true);
  }
  $('j-bar').style.width = `${Math.max(0, Math.min(100, 100 * (1 - d / CFG.exitZoneM)))}%`;
  $('j-dist').textContent = d > 20 ? fmtDist(d) : 'Maintenant';
}

/* ---------- Limitation de vitesse (TomTom / OpenStreetMap) et météo ---------- */
// France métropolitaine (approximatif) : règles « par temps de pluie » du Code de la route.
const inFrance = (p) => p && p[0] > -5.3 && p[0] < 8.3 && p[1] > 42.3 && p[1] < 51.1;
// Pluie (ou autres précipitations) : 130 → 110, 110 → 100, 90 → 80. Brouillard (< 50 m) : 50.
function wetLimit(kmh) {
  if (kmh >= 130) return 110;
  if (kmh === 110) return 100;
  if (kmh === 90) return 80;
  return kmh;
}
function isWet() { return settings.wx === 'rain' || (settings.wx === 'auto' && state.weather.wet); }

function updateLimit() {
  const base = baseLimit();
  let kmh = base, reason = '';
  if (base && inFrance(state.pos)) {
    if (isWet() && wetLimit(base) < base) { kmh = wetLimit(base); reason = 'pluie'; }
    if (settings.wx === 'auto' && state.weather.fog && kmh > 50) { kmh = 50; reason = 'brouillard'; }
  }
  state.limit = kmh || null;
  const el = $('limit');
  el.hidden = !kmh;
  $('speed').classList.toggle('over', !!kmh && state.speed * 3.6 > kmh + 3);
  if (!kmh) return;
  $('limit-val').textContent = kmh;
  el.classList.toggle('wet', !!reason);
  $('limit-note').textContent = reason === 'pluie' ? `🌧 ${base}→${kmh}` : reason === 'brouillard' ? '🌫 brouillard' : '';
  const said = `${kmh}-${reason}`;
  if (reason && state.lastLimitSaid !== said) speak(`${reason === 'pluie' ? 'Pluie' : 'Brouillard'} : vitesse limitée à ${kmh}`);
  state.lastLimitSaid = said;
}

function baseLimit() {
  const r = state.route;
  if (r && state.along != null && r.speeds && r.speeds.length) {
    const s = r.speeds.find((x) => state.along >= x.from && state.along < x.to);
    if (s) return s.kmh;
  }
  if (!state.pos) return null;
  refreshOsm();
  return osmLimit();
}

// Routes OpenStreetMap autour de la voiture (avec leur « maxspeed »), rechargées en roulant.
async function refreshOsm() {
  const o = state.osm, pos = state.pos;
  if (o.busy || Date.now() - o.at < 8000) return;
  if (o.center && dist(o.center, pos) < CFG.osmRadiusM * 0.55) return;
  o.busy = true;
  o.at = Date.now();
  const q = `[out:json][timeout:15];way(around:${CFG.osmRadiusM},${pos[1].toFixed(5)},${pos[0].toFixed(5)})`
    + '[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$"];out tags geom;';
  try {
    let data = null;
    for (const url of CFG.overpass) {
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (res.ok) { data = await res.json(); break; }
      } catch { /* serveur suivant */ }
    }
    if (!data) return;
    o.ways = (data.elements || []).filter((w) => w.geometry && w.geometry.length > 1)
      .map((w) => ({ tags: w.tags || {}, line: lineFrom(w.geometry.map((g) => [g.lon, g.lat])) }));
    o.center = pos;
    updateLimit();
  } finally { o.busy = false; }
}

function osmLimit() {
  const pos = state.pos;
  let best = null;
  for (const w of state.osm.ways) {
    const p = project(pos, w.line);
    if (p.d > 30) continue;
    const c = w.line.coords;
    const segB = bearing(c[p.i], c[p.i + 1] || c[p.i]);
    const diff = Math.abs(((state.heading - segB) % 360 + 540) % 360 - 180); // 0 = même sens
    const oneway = ['yes', '1', 'true'].includes(w.tags.oneway) || /motorway/.test(w.tags.highway);
    let score = p.d;
    if (state.speed > 2) {
      const aligned = diff < 60 || (!oneway && diff > 120);
      if (!aligned) score += 40;
    }
    if (w === state.osm.cur) score -= 5; // évite de sauter d'une route à l'autre
    if (!best || score < best.score) best = { w, score, forward: diff < 90 };
  }
  if (!best) return null;
  state.osm.cur = best.w;
  const t = best.w.tags;
  const dirTag = best.forward ? t['maxspeed:forward'] : t['maxspeed:backward'];
  return parseMaxspeed(dirTag || t.maxspeed || t['zone:maxspeed'], t.highway);
}

function parseMaxspeed(v, highway) {
  if (v) {
    const s = String(v).split(';')[0].trim();
    const zones = { 'FR:urban': 50, 'FR:rural': 80, 'FR:motorway': 130, 'FR:zone30': 30, 'FR:30': 30, 'FR:walk': 20, 'FR:living_street': 20 };
    if (zones[s]) return zones[s];
    const m = s.match(/^(\d+)\s*(mph)?$/);
    if (m) return m[2] ? Math.round(+m[1] * 1.609) : +m[1];
    return null; // « none », « signals »… : on n'affiche rien
  }
  if (highway === 'motorway' && inFrance(state.pos)) return 130;
  if (highway === 'living_street') return 20;
  return null;
}

// Météo actuelle (Open-Meteo) : pluie, neige, brouillard.
async function refreshWeather(force) {
  const w = state.weather, pos = state.pos;
  if (!pos || w.busy) return;
  if (!force && w.center && Date.now() - w.at < CFG.weatherRefreshMs && dist(w.center, pos) < 15000) return;
  w.busy = true;
  w.at = Date.now();
  w.center = pos;
  try {
    const url = `${CFG.meteo}?latitude=${pos[1].toFixed(3)}&longitude=${pos[0].toFixed(3)}&current=precipitation,weather_code,visibility`;
    const c = (await (await fetch(url)).json()).current || {};
    const code = c.weather_code || 0;
    // Codes WMO : 51-67 bruine/pluie, 71-77 neige, 80-86 averses, 95-99 orages.
    w.wet = (c.precipitation || 0) >= 0.1 || (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;
    w.fog = typeof c.visibility === 'number' && c.visibility < 50;
    w.text = w.fog ? '🌫 Brouillard' : w.wet ? '🌧 Pluie' : '☀ Sec';
  } catch (e) {
    console.warn('Météo', e);
    w.text = '';
  } finally { w.busy = false; }
  showWeather();
  updateLimit();
}
function showWeather() {
  const auto = state.weather.text ? `Météo : ${state.weather.text}` : '';
  const txt = settings.wx === 'rain' ? 'Météo : 🌧 pluie (manuel)' : settings.wx === 'dry' ? 'Météo : ☀ sec (manuel)' : auto;
  setStatus('wx', txt);
  const b = $('toggleWx');
  b.textContent = settings.wx === 'rain' ? '🌧' : settings.wx === 'dry' ? '☀' : isWet() ? '🌧' : '☀';
  b.classList.toggle('on', settings.wx !== 'auto');
  b.title = settings.wx === 'auto' ? 'Météo automatique' : 'Météo forcée (toucher pour changer)';
}
// Bouton météo : automatique → pluie forcée → sec forcé → automatique.
$('toggleWx').addEventListener('click', () => {
  settings.wx = { auto: 'rain', rain: 'dry', dry: 'auto' }[settings.wx] || 'auto';
  store.set('wx', settings.wx);
  showWeather();
  updateLimit();
});
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/* ---------- Voix ---------- */
function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function sayOnce(id, text) { if (state.spoken.has(id)) return; state.spoken.add(id); speak(text); }

/* ---------- Alertes trafic (TomTom) ---------- */
const CATS = {
  0: ['❔', 'Incident'], 1: ['💥', 'Accident'], 2: ['🌫️', 'Brouillard'], 3: ['⚠️', 'Danger'], 4: ['🌧️', 'Pluie'],
  5: ['🧊', 'Verglas'], 6: ['🚗', 'Bouchon'], 7: ['🚧', 'Voie fermée'], 8: ['⛔', 'Route fermée'], 9: ['🦺', 'Travaux'],
  10: ['💨', 'Vent fort'], 11: ['🌊', 'Inondation'], 14: ['🛻', 'Véhicule en panne'],
};
const FIELDS = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},from,to,length,delay,roadNumbers}}}';

async function refreshIncidents(force) {
  if (!settings.key) { setStatus('inc', 'Alertes : ajoutez une clé TomTom (⚙)'); return; }
  const center = state.pos || map.getCenter().toArray();
  const now = Date.now();
  const moved = state.lastIncidentCenter ? dist(center, state.lastIncidentCenter) : Infinity;
  if (!force && now - state.lastIncidentFetch < CFG.incidentRefreshMs && moved < 20000) return;
  state.lastIncidentFetch = now;
  state.lastIncidentCenter = center;
  const dLat = CFG.incidentRadiusKm / 111;
  const dLon = CFG.incidentRadiusKm / (111 * Math.cos(rad(center[1])));
  const bbox = [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat].map((v) => v.toFixed(5)).join(',');
  const url = `${CFG.incidents}?key=${encodeURIComponent(settings.key)}&bbox=${bbox}&fields=${encodeURIComponent(FIELDS)}&language=fr-FR&timeValidityFilter=present`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status === 403 ? 'clé refusée' : `erreur ${res.status}`);
    const data = await res.json();
    state.incidents = (data.incidents || []).map(normIncident).filter(Boolean);
    drawIncidents();
    setStatus('inc', `Alertes : ${state.incidents.length} · ${fmtTime(new Date())}`);
    if (state.route) updateGuidance();
  } catch (e) {
    console.warn(e);
    setStatus('inc', `Alertes indisponibles (${e.message})`);
  }
}

function normIncident(inc) {
  const g = inc.geometry, p = inc.properties || {};
  if (!g) return null;
  const pts = g.type === 'Point' ? [g.coordinates] : g.coordinates;
  const [emoji, name] = CATS[p.iconCategory] || CATS[0];
  const desc = (p.events || []).map((e) => e.description).filter(Boolean).join(', ');
  return {
    id: p.id || JSON.stringify(pts[0]), pts, line: g.type === 'LineString' ? g.coordinates : null,
    cat: p.iconCategory, emoji, name, desc, mag: p.magnitudeOfDelay || 0, delay: p.delay || 0,
    road: (p.roadNumbers || []).join(', '), from: p.from, to: p.to,
  };
}

function drawIncidents() {
  state.incidentMarkers.forEach((m) => m.remove());
  state.incidentMarkers = [];
  const lines = state.incidents.filter((i) => i.line).map((i) => ({ type: 'Feature', properties: { mag: i.mag }, geometry: { type: 'LineString', coordinates: i.line } }));
  if (map.getSource('incident-lines')) map.getSource('incident-lines').setData({ type: 'FeatureCollection', features: lines });
  state.incidents.slice(0, 200).forEach((i) => {
    const el = document.createElement('div');
    el.className = 'inc';
    el.textContent = i.emoji;
    const html = `<b>${esc(i.emoji)} ${esc(i.name)}</b>${i.road ? ' · ' + esc(i.road) : ''}<br>${esc(i.desc)}`
      + (i.from ? `<br><small>${esc(i.from)}${i.to ? ' → ' + esc(i.to) : ''}</small>` : '')
      + (i.delay ? `<br>Retard : ${fmtDuration(i.delay)}` : '');
    const m = new maplibregl.Marker({ element: el }).setLngLat(i.pts[0]).setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(html)).addTo(map);
    state.incidentMarkers.push(m);
  });
}

// Prochaine alerte située sur l'itinéraire, devant la voiture.
function updateRouteAlert(myAlong) {
  const r = state.route;
  let best = null;
  for (const inc of state.incidents) {
    const pr = project(inc.pts[0], r);
    if (pr.d > 80) continue;
    const ahead = pr.along - myAlong;
    if (ahead < -20 || ahead > CFG.alertAheadM) continue;
    if (!best || ahead < best.ahead) best = { inc, ahead };
  }
  const el = $('alert');
  if (!best) { el.hidden = true; return; }
  const { inc, ahead } = best;
  el.hidden = false;
  if (inc.cat === 8) avoidClosure(inc);
  el.className = [1, 8, 5].includes(inc.cat) || inc.mag >= 3 ? 'danger' : '';
  el.textContent = `${inc.emoji} ${inc.name} ${ahead > 30 ? 'dans ' + fmtDist(ahead) : 'ici'}${inc.road ? ' · ' + inc.road : ''}${inc.delay ? ' · +' + fmtDuration(inc.delay) : ''}`;
  if (ahead < 1500) sayOnce(`inc-${inc.id}`, `Attention, ${inc.name.toLowerCase()} dans ${fmtDist(ahead)}`);
}

// Route fermée sur l'itinéraire : on demande à TomTom un trajet qui l'évite.
async function avoidClosure(inc) {
  if (!settings.key || state.closureChecked.has(inc.id)) return;
  state.closureChecked.add(inc.id);
  const r = state.route;
  const pts = inc.line ? [inc.line[0], inc.line[Math.floor(inc.line.length / 2)], inc.line[inc.line.length - 1]] : [inc.pts[0]];
  state.avoid.push(...pts);
  try {
    const nr = await fetchRouteTomTom(state.pos || r.coords[0], r.dest);
    if (state.route !== r) return; // trajet arrêté ou déjà recalculé entre-temps
    const stillBlocked = pts.some((pt) => project(pt, nr).d < 40);
    if (stillBlocked) { sayOnce(`closure-none-${inc.id}`, 'Route fermée devant, pas d\'autre itinéraire trouvé'); return; }
    nr.label = r.label;
    setRoute(nr);
    speak(`Route fermée devant. Nouvel itinéraire, arrivée à ${fmtTime(new Date(Date.now() + nr.duration * 1000))}`);
  } catch (e) {
    console.warn(e);
  }
}

function setFlow(on) {
  settings.flow = on;
  store.set('flow', on);
  $('toggleFlow').classList.toggle('on', on);
  if (!map.isStyleLoaded()) return;
  if (on && settings.key && !map.getSource('flow')) {
    map.addSource('flow', { type: 'raster', tileSize: 256, tiles: [CFG.flowTiles + `?key=${encodeURIComponent(settings.key)}`] });
    map.addLayer({ id: 'flow', type: 'raster', source: 'flow', paint: { 'raster-opacity': 0.8 } }, 'route-casing');
  } else if (!on && map.getSource('flow')) {
    map.removeLayer('flow');
    map.removeSource('flow');
  }
}

/* ---------- Mode démo : simule la conduite sur l'itinéraire ---------- */
function startDemo() {
  stopDemo();
  if (!state.route) return;
  const line = state.route;
  state.demoAlong = state.pos ? project(state.pos, line).along : 0;
  setStatus('gps', 'Mode démo');
  state.demoTimer = setInterval(() => {
    state.demoAlong += CFG.demoSpeed;
    const p = pointAt(line, state.demoAlong);
    const ahead = pointAt(line, state.demoAlong + 15);
    onPosition(p, bearing(p, ahead), CFG.demoSpeed);
    if (state.route !== line) stopDemo();
  }, 1000);
}
function stopDemo() { clearInterval(state.demoTimer); state.demoTimer = null; }

/* ---------- Boutons et réglages ---------- */
$('recenter').addEventListener('click', () => setFollow(true));
$('toggle3d').addEventListener('click', () => {
  settings.is3d = !settings.is3d;
  store.set('is3d', settings.is3d);
  $('toggle3d').textContent = settings.is3d ? '2D' : '3D';
  map.easeTo({ pitch: settings.is3d ? 60 : 0 });
});
$('toggleFlow').addEventListener('click', () => {
  if (!settings.key) { openSettings(); return; }
  setFlow(!settings.flow);
});
// Plein écran (si le navigateur le permet)
{
  const d = document, el = d.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = d.exitFullscreen || d.webkitExitFullscreen;
  const isFs = () => !!(d.fullscreenElement || d.webkitFullscreenElement);
  if (req && (d.fullscreenEnabled || d.webkitFullscreenEnabled)) {
    $('fullscreen').hidden = false;
    $('fullscreen').addEventListener('click', () => {
      try {
        const r = isFs() ? exit.call(d) : req.call(el);
        if (r && r.catch) r.catch(() => setStatus('gps', 'Plein écran refusé par le navigateur'));
      } catch { /* ignoré */ }
    });
    const sync = () => { $('fullscreen').classList.toggle('on', isFs()); setTimeout(() => map.resize(), 300); };
    d.addEventListener('fullscreenchange', sync);
    d.addEventListener('webkitfullscreenchange', sync);
  }
}
function openSettings() {
  $('key').value = settings.key === configKey ? '' : settings.key;
  $('key').placeholder = configKey ? 'Clé du fichier config.js utilisée' : 'Collez votre clé ici';
  $('geocoder').value = settings.geocoder;
  $('voice').checked = settings.voice;
  $('demo').checked = settings.demo;
  $('settings').hidden = false;
}
$('settingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
$('saveSettings').addEventListener('click', () => {
  const newKey = $('key').value.trim() || configKey;
  const keyChanged = newKey !== settings.key;
  settings.key = newKey;
  settings.geocoder = $('geocoder').value;
  settings.voice = $('voice').checked;
  settings.demo = $('demo').checked;
  store.set('key', $('key').value.trim());
  ['geocoder', 'voice', 'demo'].forEach((k) => store.set(k, settings[k]));
  $('settings').hidden = true;
  if (keyChanged) {
    if (map.getSource('flow')) { map.removeLayer('flow'); map.removeSource('flow'); }
    if (settings.flow) setFlow(true);
    refreshIncidents(true);
  }
  if (settings.demo && state.route && !state.demoTimer) startDemo();
  if (!settings.demo) stopDemo();
});

const statusParts = {};
function setStatus(k, text) {
  statusParts[k] = text;
  $('status').innerHTML = ['gps', 'route', 'wx', 'inc'].filter((x) => statusParts[x]).map((x) => `<span>${esc(statusParts[x])}</span>`).join('');
}

$('toggle3d').textContent = settings.is3d ? '2D' : '3D';
$('recenter').classList.add('on');
setStatus('gps', 'Recherche GPS…');
startGps();
renderFavs();
showWeather();
