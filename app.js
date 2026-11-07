'use strict';

/* ------------------------------------------------------------------
 * Nav 3D : carte 3D, guidage et alertes trafic pour le navigateur Tesla.
 * Sources gratuites :
 *  - Carte : OpenFreeMap (tuiles OpenStreetMap, sans clé)
 *  - Itinéraire : serveur OSRM public (sans clé, usage raisonnable)
 *  - Adresses : Base Adresse Nationale (France) ou Photon (Europe)
 *  - Alertes : TomTom Traffic Incidents (clé gratuite)
 * ------------------------------------------------------------------ */

const CFG = {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  osrm: 'https://router.project-osrm.org/route/v1/driving/',
  geocoders: {
    fr: 'https://api-adresse.data.gouv.fr/search/',
    eu: 'https://photon.komoot.io/api/',
  },
  incidents: 'https://api.tomtom.com/traffic/services/5/incidentDetails',
  flowTiles: 'https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png',
  start: [2.3522, 48.8566], // Paris tant que le GPS n'a pas répondu
  incidentRefreshMs: 120000, // 2 min : ~720 requêtes/jour en roulant 24 h
  incidentRadiusKm: 45, // la zone TomTom est limitée à 10 000 km²
  offRouteM: 50,
  alertAheadM: 5000,
  demoSpeed: 15, // m/s (~54 km/h)
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
  spoken: new Set(),
  incidents: [], incidentMarkers: [], lastIncidentFetch: 0, lastIncidentCenter: null,
  demoTimer: null, demoAlong: 0,
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
    // Décale la voiture vers le bas de l'écran pour voir plus loin devant.
    opts.offset = [0, map.getContainer().clientHeight * 0.2];
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
  moveCamera(false);
  refreshIncidents(false);
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

/* ---------- Recherche d'adresse ---------- */
let searchTimer = null, searchSeq = 0;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  if (q.length < 3) { $('results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => search(q), 300);
});
$('search').addEventListener('submit', (e) => { e.preventDefault(); const q = $('q').value.trim(); if (q) search(q); });

async function search(q) {
  const seq = ++searchSeq;
  const near = state.pos || map.getCenter().toArray();
  try {
    let items;
    if (settings.geocoder === 'eu') {
      const url = `${CFG.geocoders.eu}?q=${encodeURIComponent(q)}&limit=6&lang=fr&lat=${near[1]}&lon=${near[0]}`;
      const data = await (await fetch(url)).json();
      items = data.features.map((f) => {
        const p = f.properties;
        const line1 = [p.housenumber, p.street || p.name].filter(Boolean).join(' ') || p.name;
        return { label: line1, sub: [p.postcode, p.city, p.country].filter(Boolean).join(' '), coord: f.geometry.coordinates };
      });
    } else {
      const url = `${CFG.geocoders.fr}?q=${encodeURIComponent(q)}&limit=6&lat=${near[1]}&lon=${near[0]}`;
      const data = await (await fetch(url)).json();
      items = data.features.map((f) => ({ label: f.properties.label, sub: f.properties.context, coord: f.geometry.coordinates }));
    }
    if (seq !== searchSeq) return;
    const ul = $('results');
    ul.innerHTML = items.length ? '' : '<li>Aucun résultat</li>';
    items.forEach((it) => {
      const li = document.createElement('li');
      li.innerHTML = `${esc(it.label)}<small>${esc(it.sub)}</small>`;
      li.addEventListener('click', () => {
        ul.innerHTML = '';
        $('q').value = it.label;
        $('q').blur();
        startRoute(it.coord, it.label);
      });
      ul.appendChild(li);
    });
  } catch (e) {
    console.warn(e);
    $('results').innerHTML = '<li>Recherche impossible (réseau ?)</li>';
  }
}

/* ---------- Itinéraire ---------- */
async function startRoute(dest, label) {
  const from = state.pos || map.getCenter().toArray();
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

async function fetchRoute(from, dest) {
  const url = `${CFG.osrm}${from[0]},${from[1]};${dest[0]},${dest[1]}?overview=full&geometries=geojson&steps=true`;
  const data = await (await fetch(url)).json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.message || data.code);
  const r = data.routes[0];
  const coords = r.geometry.coordinates;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  const line = { coords, cum };
  // Position de chaque manœuvre le long du tracé.
  const steps = [];
  let acc = 0;
  r.legs.forEach((leg) => leg.steps.forEach((s) => {
    steps.push({ ...s, along: acc, text: instruction(s), icon: icon(s) });
    acc += s.distance;
  }));
  const scale = cum[cum.length - 1] / (acc || 1); // aligne nos distances sur celles d'OSRM
  steps.forEach((s) => { s.along *= scale; });
  return { ...line, steps, distance: r.distance, duration: r.duration, dest };
}

function setRoute(route) {
  state.route = route;
  state.offCount = 0;
  state.spoken.clear();
  map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} });
  $('guidance').hidden = false;
  setStatus('route', `${fmtDist(route.distance)} · ${fmtDuration(route.duration)}`);
  updateGuidance();
  refreshIncidents(true);
}

function stopRoute() {
  state.route = null;
  stopDemo();
  if (map.getSource('route')) map.getSource('route').setData(emptyFC());
  $('guidance').hidden = true;
  $('alert').hidden = true;
  $('q').value = '';
  setStatus('route', '');
  map.easeTo({ pitch: settings.is3d ? 60 : 0, offset: [0, 0] });
}
$('stop').addEventListener('click', stopRoute);

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

  const remaining = Math.max(0, r.cum[r.cum.length - 1] - p.along);
  const idx = r.steps.findIndex((s) => s.along > p.along + 5);
  if (idx === -1 || remaining < 25) {
    $('next-icon').textContent = '⚑';
    $('next-dist').textContent = 'Arrivé';
    $('next-text').textContent = r.label || 'Destination';
    $('then').textContent = '';
    $('eta').textContent = fmtTime(new Date());
    $('remain').textContent = '0 m';
    sayOnce('arrive', 'Vous êtes arrivé à destination');
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

  // Annonces vocales à 1 km, 300 m et juste avant la manœuvre.
  if (d < 60) sayOnce(`${idx}-now`, next.text);
  else if (d < 300) sayOnce(`${idx}-300`, `Dans ${fmtDist(d)}, ${lower(next.text)}`);
  else if (d < 1000 && d > 800) sayOnce(`${idx}-1000`, `Dans 1 kilomètre, ${lower(next.text)}`);

  updateRouteAlert(p.along);
}
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
  el.className = [1, 8, 5].includes(inc.cat) || inc.mag >= 3 ? 'danger' : '';
  el.textContent = `${inc.emoji} ${inc.name} ${ahead > 30 ? 'dans ' + fmtDist(ahead) : 'ici'}${inc.road ? ' · ' + inc.road : ''}${inc.delay ? ' · +' + fmtDuration(inc.delay) : ''}`;
  if (ahead < 1500) sayOnce(`inc-${inc.id}`, `Attention, ${inc.name.toLowerCase()} dans ${fmtDist(ahead)}`);
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
  $('status').innerHTML = ['gps', 'route', 'inc'].filter((x) => statusParts[x]).map((x) => `<span>${esc(statusParts[x])}</span>`).join('');
}

$('toggle3d').textContent = settings.is3d ? '2D' : '3D';
$('recenter').classList.add('on');
setStatus('gps', 'Recherche GPS…');
startGps();
