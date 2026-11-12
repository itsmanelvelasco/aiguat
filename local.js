// Street-level detail, ACA live water data, hyper-local alerts and (simulated) alert dispatch.
const S = 'https://analisi.transparenciacatalunya.cat/resource';
const $ = (id) => document.getElementById(id);
const soql = (ds, p) => fetch(`${S}/${ds}.json?` + new URLSearchParams(p)).then((r) => r.json());
const LV = {
  3: { ca: 'VERMELL', es: 'ROJO', en: 'RED', c: '#ef4444' },
  2: { ca: 'TARONJA', es: 'NARANJA', en: 'ORANGE', c: '#f97316' },
  1: { ca: 'GROC', es: 'AMARILLO', en: 'YELLOW', c: '#facc15' },
  0: { ca: 'SENSE RISC', es: 'SIN RIESGO', en: 'NO RISK', c: '#22c55e' },
};
const levelOf = (d) => (d >= 1 ? 3 : d >= 0.3 ? 2 : d >= 0.05 ? 1 : 0);
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let map, st, api;
const L = { gauges: [], reservoirs: [], draft: null, log: [], marker: null };

export function depthAtLngLat(lon, lat) {
  const a = st.area; if (!a || !st.depth) return null;
  const px = Math.floor((lon2x(lon, a.z) - a.x0) * 256), py = Math.floor((lat2y(lat, a.z) - a.y0) * 256);
  if (px < 0 || py < 0 || px >= a.W || py >= a.H) return null;
  const i = py * a.W + px; return a.sea[i] ? null : st.depth[i];
}

export function initLocal(m, s, a) {
  map = m; st = s; api = a;
  const before = 'bbox-glow';
  map.addSource('ofm', { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenStreetMap · OpenFreeMap' });
  map.addSource('alert-blocks', { type: 'geojson', data: fc([]) });
  map.addSource('flooded-bldg', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'alerts-fill', type: 'fill', source: 'alert-blocks', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.38 } }, before);
  map.addLayer({ id: 'alerts-line', type: 'line', source: 'alert-blocks', paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 2.2], 'line-opacity': 0.95 } }, before);
  map.addLayer({ id: 'bldg', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 14,
    paint: { 'fill-extrusion-color': '#d6dde8', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.82] } }, before);
  map.addLayer({ id: 'bldg-flood', type: 'fill-extrusion', source: 'flooded-bldg', minzoom: 13,
    paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'd'], 0.05, '#fbbf24', 0.5, '#f97316', 1.5, '#dc2626', 3, '#7f1d1d'], 'fill-extrusion-height': ['+', ['get', 'h'], 0.6], 'fill-extrusion-opacity': 0.95 } }, before);
  map.addLayer({ id: 'streets-lbl', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 14,
    layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:ca'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
    paint: { 'text-color': '#fff', 'text-halo-color': '#0b1220', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'places-lbl', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 8,
    filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'neighbourhood']]],
    layout: { 'text-field': ['coalesce', ['get', 'name:ca'], ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 16, 'town', 14, 12], 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
    paint: { 'text-color': '#f1f5f9', 'text-halo-color': '#0b1220', 'text-halo-width': 1.8 } });

  map.on('moveend', () => map.once('idle', schedule));
  for (const id of ['alerts-fill']) map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
  for (const id of ['alerts-fill']) map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  $('addrGo').onclick = searchAddress;
  $('addr').onkeydown = (e) => e.key === 'Enter' && searchAddress();
  $('send').onclick = sendDraft;
  document.querySelectorAll('#langTabs button').forEach((b) => b.onclick = () => { document.querySelectorAll('#langTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderDraft(); });
  loadACA().catch((e) => { console.error(e); $('acaNote').textContent = 'ACA open data unavailable: ' + e.message; });
}

const fc = (features) => ({ type: 'FeatureCollection', features });

// ---------------- ACA live data ----------------
async function loadACA() {
  const [{ d: day }] = await soql('2bwe-vgpr', { $select: 'max(dia) as d' });
  const from = new Date(new Date(day) - 30 * 864e5).toISOString().slice(0, 10);
  const [today, hist, res, sewer] = await Promise.all([
    soql('2bwe-vgpr', { $where: `dia='${day}'`, $limit: 1000 }),
    soql('2bwe-vgpr', { $select: 'codi_variable,avg(cabal_riu_m3_s) as a,max(cabal_riu_m3_s) as m', $where: `dia>'${from}' and dia<'${day}'`, $group: 'codi_variable', $limit: 2000 }),
    soql('gn9e-3qhr', { $order: 'dia DESC', $limit: 60 }),
    soql('qb78-67ft', { $select: 'georefer,terme_municipal,subtipus,top_nim', $limit: 6000 }),
  ]);
  const H = Object.fromEntries(hist.map((h) => [h.codi_variable, h]));
  const coords = {};
  L.gauges = [];
  for (const g of today) {
    if (!g.lat) continue;
    const lon = +g.long, lat = +g.lat, q = +g.cabal_riu_m3_s, h = H[g.codi_variable], avg = h ? +h.a : NaN;
    coords[g.estaci] = [lon, lat];
    if (g.estaci.startsWith('Embassament')) continue;
    const ratio = avg > 0.05 ? q / avg : 1;
    L.gauges.push({ name: g.estaci.replace('Aforament - ', '').replace('Qualitat - ', ''), conca: g.conca, subconca: g.subconca, q, avg, max30: h ? +h.m : NaN, ratio, lon, lat });
  }
  const seen = new Set(); L.reservoirs = [];
  for (const r of res) {
    if (seen.has(r.estaci)) continue; seen.add(r.estaci);
    const c = coords[r.estaci]; if (!c) continue;
    const out = today.find((t) => t.estaci === r.estaci);
    L.reservoirs.push({ name: r.estaci.replace('Embassament de ', '').replace('Embassament del ', '').replace(/ \(.*\)/, ''), full: r.estaci, pct: +r.percentatge_volum_embassat, vol: +r.volum_embassat, level: +r.nivell_absolut, outflow: out ? +out.cabal_riu_m3_s : null, day: r.dia.slice(0, 10), lon: c[0], lat: c[1] });
  }
  L.reservoirs.sort((a, b) => b.vol - a.vol);
  const pt = (o, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: props });
  map.addSource('aca-gauges', { type: 'geojson', data: fc(L.gauges.map((g, k) => pt(g, { k, q: g.q, r: g.ratio, label: `${g.q.toFixed(g.q < 10 ? 2 : 0)} m³/s` }))) });
  map.addSource('aca-res', { type: 'geojson', data: fc(L.reservoirs.map((r, k) => pt(r, { k, pct: r.pct, label: `${r.name} ${r.pct.toFixed(0)}%` }))) });
  map.addSource('aca-sewer', { type: 'geojson', data: fc(sewer.filter((s) => s.georefer).map((s) => ({ type: 'Feature', geometry: s.georefer, properties: { m: s.terme_municipal, t: s.subtipus, o: s.top_nim } }))) });
  map.addLayer({ id: 'aca-sewer', type: 'circle', source: 'aca-sewer', minzoom: 10, layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 6], 'circle-color': '#a855f7', 'circle-stroke-color': '#f5d0fe', 'circle-stroke-width': 0.6 } });
  map.addLayer({ id: 'aca-gauges', type: 'circle', source: 'aca-gauges',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 14, 9], 'circle-color': ['step', ['get', 'r'], '#22d3ee', 1.5, '#f59e0b', 3, '#ef4444'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'aca-gauges-lbl', type: 'symbol', source: 'aca-gauges', minzoom: 9.5,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
    paint: { 'text-color': '#a5f3fc', 'text-halo-color': '#0b1220', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'aca-res', type: 'circle', source: 'aca-res',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 8, 13, 16], 'circle-color': ['interpolate', ['linear'], ['get', 'pct'], 20, '#ef4444', 50, '#f59e0b', 80, '#3b82f6'], 'circle-opacity': 0.9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'aca-res-lbl', type: 'symbol', source: 'aca-res', minzoom: 7,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.6], 'text-anchor': 'top' },
    paint: { 'text-color': '#fff', 'text-halo-color': '#1e3a8a', 'text-halo-width': 2 } });
  for (const id of ['aca-gauges', 'aca-res', 'aca-sewer']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }

  const totalVol = L.reservoirs.reduce((a, r) => a + r.vol, 0);
  const above = L.gauges.filter((g) => g.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio);
  $('acaNote').innerHTML = `<b>${L.gauges.length}</b> river gauges · <b>${L.reservoirs.length}</b> reservoirs (${totalVol.toFixed(0)} hm³ stored) · <b>${sewer.length.toLocaleString()}</b> sewer overflow points · data of ${day.slice(0, 10)}`;
  $('resList').innerHTML = L.reservoirs.map((r, k) => `<div class="res" data-k="${k}"><span>${esc(r.name)}</span><div class="bar"><i style="width:${r.pct}%;background:${r.pct < 30 ? '#ef4444' : r.pct < 60 ? '#f59e0b' : '#3b82f6'}"></i></div><b>${r.pct.toFixed(0)}%</b></div>`).join('');
  $('gaugeList').innerHTML = above.length
    ? above.slice(0, 6).map((g) => `<div class="res g" data-lon="${g.lon}" data-lat="${g.lat}"><span>${esc(g.name)}</span><b style="color:${g.ratio >= 3 ? '#ef4444' : '#f59e0b'}">${g.ratio.toFixed(1)}× normal</b></div>`).join('')
    : '<div class="cap">All gauges within normal range (≤1.5× their 30-day mean).</div>';
  document.querySelectorAll('#resList .res').forEach((el) => el.onclick = () => { const r = L.reservoirs[+el.dataset.k]; map.flyTo({ center: [r.lon, r.lat], zoom: 13.5, pitch: 65, duration: 2500 }); setTimeout(() => popRes(r), 2600); });
  document.querySelectorAll('#gaugeList .g').forEach((el) => el.onclick = () => map.flyTo({ center: [+el.dataset.lon, +el.dataset.lat], zoom: 14, pitch: 60, duration: 2500 }));
}

function popup(lngLat, html) { return new maplibregl.Popup({ maxWidth: '320px', className: 'dark' }).setLngLat(lngLat).setHTML(html).addTo(map); }
function popRes(r) {
  popup([r.lon, r.lat], `<div class="pt">ACA reservoir</div><h4>${esc(r.full)}</h4>
    <div class="bar big"><i style="width:${r.pct}%"></i></div>
    <div class="kv"><span>Stored</span><b>${r.vol} hm³ (${r.pct}%)</b><span>Water level</span><b>${r.level} m a.s.l.</b>${r.outflow != null ? `<span>Release</span><b>${r.outflow} m³/s</b>` : ''}<span>Spare capacity</span><b>${(r.vol / Math.max(r.pct, 1) * (100 - r.pct)).toFixed(1)} hm³</b></div>
    <div class="cap">Data ${r.day}. Spare capacity is what the dam can absorb from a flood peak before spilling.</div>`);
}
function popGauge(g) {
  popup([g.lon, g.lat], `<div class="pt">ACA river gauge · ${esc(g.conca)}</div><h4>${esc(g.name)}</h4>
    <div class="kv"><span>Flow today</span><b>${g.q} m³/s</b><span>30-day mean</span><b>${isNaN(g.avg) ? '–' : g.avg.toFixed(2) + ' m³/s'}</b><span>30-day max</span><b>${isNaN(g.max30) ? '–' : g.max30 + ' m³/s'}</b><span>Anomaly</span><b style="color:${g.ratio >= 3 ? '#ef4444' : g.ratio >= 1.5 ? '#f59e0b' : '#22d3ee'}">${g.ratio.toFixed(2)}×</b></div>`);
}

// Returns true if the click was consumed by a local feature.
export function handleClick(e) {
  const layers = ['aca-res', 'aca-gauges', 'aca-sewer', 'alerts-fill'].filter((l) => map.getLayer(l));
  const f = map.queryRenderedFeatures(e.point, { layers })[0];
  if (f) {
    if (f.layer.id === 'aca-res') popRes(L.reservoirs[f.properties.k]);
    else if (f.layer.id === 'aca-gauges') popGauge(L.gauges[f.properties.k]);
    else if (f.layer.id === 'aca-sewer') popup(e.lngLat, `<div class="pt">ACA sewer overflow point</div><h4>${esc(f.properties.m)}</h4><div class="cap">${esc(f.properties.t)} · ${esc(f.properties.o)}<br/>Combined-sewer overflows back up first in intense urban rain.</div>`);
    else probe(e.lngLat, f.properties);
    return true;
  }
  if (depthAtLngLat(e.lngLat.lng, e.lngLat.lat) !== null) { probe(e.lngLat); return true; }
  return false;
}

function probe(ll, block) {
  const d = depthAtLngLat(ll.lng, ll.lat) || 0, lv = block ? block.level : levelOf(d);
  const label = block ? `Block ${block.id}` : `Point ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  const streets = block ? streetsInBlock(block) : nearestStreets(ll);
  const html = `<div class="pt">${block ? '250 m alert block' : 'Point probe'}</div><h4><span class="lv" style="background:${LV[lv].c}"></span>${LV[lv].en} · ${label}</h4>
    <div class="kv">${block ? `<span>Max depth</span><b>${block.max.toFixed(2)} m</b><span>Flooded</span><b>${(block.frac * 100).toFixed(0)}% of block</b>` : `<span>Water depth</span><b>${d.toFixed(2)} m</b>`}</div>
    ${streets.length ? `<div class="cap">Streets: ${streets.slice(0, 4).map(esc).join(', ')}</div>` : ''}
    <button class="ghost" id="draftHere">Draft alert for this ${block ? 'block' : 'spot'}</button>`;
  const p = popup(ll, html);
  setTimeout(() => { const b = document.getElementById('draftHere'); if (b) b.onclick = () => { draft({ target: block ? `${streets[0] ? streets.slice(0, 2).join(' / ') + ' (block ' + block.id + ')' : 'block ' + block.id}` : (streets[0] || label), level: lv, depth: block ? block.max : d, scope: block ? '250 m block' : 'point' }); p.remove(); }; }, 0);
}

// ---------------- hyper-local computation ----------------
let tLocal = null;
let depthDirty = true;
export function scheduleLocal() { depthDirty = true; schedule(); }
function schedule() { clearTimeout(tLocal); tLocal = setTimeout(updateLocal, 350); }

function updateLocal() {
  if (!st.area || !st.depth) return;
  if (depthDirty) { computeBlocks(); depthDirty = false; }
  computeBuildingsAndStreets();
}

function computeBlocks() {
  const a = st.area, bs = Math.max(4, Math.round(250 / a.cell)), nb = Math.ceil(a.W / bs), feats = [], cnt = { 1: 0, 2: 0, 3: 0 };
  for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
    let land = 0, wet = 0, max = 0;
    for (let y = by * bs; y < Math.min(a.H, (by + 1) * bs); y++) for (let x = bx * bs; x < Math.min(a.W, (bx + 1) * bs); x++) {
      const i = y * a.W + x; if (a.sea[i]) continue; land++; const d = st.depth[i]; if (d > 0.05) { wet++; if (d > max) max = d; }
    }
    if (!land) continue;
    const frac = wet / land; let lv = max >= 1 && frac >= 0.1 ? 3 : max >= 0.3 && frac >= 0.03 ? 2 : frac >= 0.02 ? 1 : 0;
    if (!lv) continue; cnt[lv]++;
    const X = (px) => x2lon(a.x0 + px / 256, a.z), Y = (py) => y2lat(a.y0 + py / 256, a.z);
    const x0 = X(bx * bs), x1 = X(Math.min(a.W, (bx + 1) * bs)), y0 = Y(by * bs), y1 = Y(Math.min(a.H, (by + 1) * bs));
    feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] }, properties: { id: `${String.fromCharCode(65 + (bx % 26))}${bx >= 26 ? Math.floor(bx / 26) : ''}-${by + 1}`, level: lv, c: LV[lv].c, max, frac, w: x0, e: x1, n: y0, s: y1 } });
  }
  map.getSource('alert-blocks').setData(fc(feats));
  $('bRed').textContent = cnt[3]; $('bOr').textContent = cnt[2]; $('bYe').textContent = cnt[1];
}

function lineCoords(g) { return g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : []; }
function streetsInBlock(b) {
  const out = new Map();
  for (const f of map.querySourceFeatures('ofm', { sourceLayer: 'transportation_name' })) {
    const n = f.properties['name:ca'] || f.properties.name; if (!n) continue;
    if (lineCoords(f.geometry).some(([x, y]) => x >= b.w && x <= b.e && y <= b.n && y >= b.s)) out.set(n, 1);
  }
  return [...out.keys()];
}
function nearestStreets(ll) {
  let best = []; const k = Math.cos((ll.lat * Math.PI) / 180);
  for (const f of map.querySourceFeatures('ofm', { sourceLayer: 'transportation_name' })) {
    const n = f.properties['name:ca'] || f.properties.name; if (!n) continue;
    let dm = Infinity; for (const [x, y] of lineCoords(f.geometry)) { const d = ((x - ll.lng) * k) ** 2 + (y - ll.lat) ** 2; if (d < dm) dm = d; }
    best.push([dm, n]);
  }
  best.sort((a, b) => a[0] - b[0]); return [...new Set(best.filter((b) => b[0] < 4e-6).map((b) => b[1]))];
}

function computeBuildingsAndStreets() {
  const z = map.getZoom();
  if (z < 12.5) {
    map.getSource('flooded-bldg').setData(fc([]));
    $('bBld').textContent = '–'; $('streetList').innerHTML = '<div class="cap">Zoom into a town (closer than ~3 km) to list streets and buildings at risk.</div>';
    return;
  }
  const flooded = [], seen = new Set();
  for (const f of map.querySourceFeatures('ofm', { sourceLayer: 'building' })) {
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : null;
    if (!ring) continue;
    let sx = 0, sy = 0; for (const [x, y] of ring) { sx += x; sy += y; }
    const cx = sx / ring.length, cy = sy / ring.length, key = cx.toFixed(6) + cy.toFixed(6);
    if (seen.has(key)) continue; seen.add(key);
    const d = depthAtLngLat(cx, cy);
    if (d > 0.05) flooded.push({ type: 'Feature', geometry: f.geometry, properties: { d, h: f.properties.render_height || 8 } });
  }
  map.getSource('flooded-bldg').setData(fc(flooded));
  $('bBld').textContent = z >= 13 ? flooded.length.toLocaleString() : '–';

  const streets = new Map();
  for (const f of map.querySourceFeatures('ofm', { sourceLayer: 'transportation_name' })) {
    const n = f.properties['name:ca'] || f.properties.name; if (!n) continue;
    for (const [x, y] of lineCoords(f.geometry)) {
      const d = depthAtLngLat(x, y); if (!(d > 0.05)) continue;
      const s = streets.get(n); if (!s || d > s.d) streets.set(n, { n, d, x, y });
    }
  }
  const list = [...streets.values()].sort((a, b) => b.d - a.d).slice(0, 12);
  $('streetList').innerHTML = list.length ? list.map((s, k) => `<div class="res st" data-k="${k}"><span><i class="lv" style="background:${LV[levelOf(s.d)].c}"></i>${esc(s.n)}</span><b>${s.d.toFixed(2)} m</b></div>`).join('') : '<div class="cap">No streets flooded in view for this scenario.</div>';
  document.querySelectorAll('#streetList .st').forEach((el) => el.onclick = () => {
    const s = list[+el.dataset.k]; map.flyTo({ center: [s.x, s.y], zoom: 16, pitch: 60, duration: 2000 });
    draft({ target: s.n, level: levelOf(s.d), depth: s.d, scope: 'street' });
  });
}

// ---------------- address lookup ----------------
async function searchAddress() {
  const q = $('addr').value.trim(); if (!q) return;
  $('addrRes').innerHTML = '<div class="cap">Searching ICGC geocoder…</div>';
  const r = await fetch(`https://eines.icgc.cat/geocodificador/cerca?text=${encodeURIComponent(q)}&size=1`).then((r) => r.json()).catch(() => null);
  const f = r && r.features && r.features[0];
  if (!f) { $('addrRes').innerHTML = '<div class="cap">Address not found in Catalonia.</div>'; return; }
  const [lon, lat] = f.geometry.coordinates, name = f.properties.etiqueta;
  if (depthAtLngLat(lon, lat) === null) await api.runArea({ name: f.properties.municipi || name, lat, lon, z: 13 }, true);
  if (L.marker) L.marker.remove();
  const el = document.createElement('div'); el.className = 'pin';
  L.marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  map.flyTo({ center: [lon, lat], zoom: 16, pitch: 60, bearing: 25, duration: 3000 });
  L.addr = { name, lon, lat };
  showAddress();
}
export function showAddress() {
  if (!L.addr) return;
  const { name, lon, lat } = L.addr, d = depthAtLngLat(lon, lat) || 0, lv = levelOf(d);
  let g = null, gd = Infinity; for (const x of L.gauges) { const dd = (x.lon - lon) ** 2 + (x.lat - lat) ** 2; if (dd < gd) { gd = dd; g = x; } }
  const km = g ? Math.sqrt(gd) * 111 * Math.cos((lat * Math.PI) / 180) : 0;
  $('addrRes').innerHTML = `<div class="card" style="border-color:${LV[lv].c}"><div class="row"><b>${esc(name)}</b><span class="badge" style="background:${LV[lv].c}">${LV[lv].en}</span></div>
    <div class="kv"><span>Water at building</span><b>${d.toFixed(2)} m</b><span>Scenario</span><b>stage ${st.stage.toFixed(1)} m · surge ${st.surge.toFixed(1)} m</b>${g ? `<span>Nearest ACA gauge</span><b>${esc(g.name)} (${km.toFixed(1)} km): ${g.q} m³/s, ${g.ratio.toFixed(1)}×</b>` : ''}</div>
    <button class="ghost" id="draftAddr">Draft alert for this address</button></div>`;
  $('draftAddr').onclick = () => draft({ target: name, level: lv, depth: d, scope: 'address' });
}

// ---------------- communication ----------------
const ADV = {
  3: { ca: 'Puja a plantes altes. No baixis a soterranis ni aparcaments. No agafis el cotxe.', es: 'Sube a plantas altas. No bajes a sótanos ni garajes. No cojas el coche.', en: 'Move to upper floors. Stay out of basements and car parks. Do not drive.' },
  2: { ca: 'Evita plantes baixes i soterranis, retira vehicles de zones baixes i prepara\'t per evacuar.', es: 'Evita plantas bajas y sótanos, retira vehículos de zonas bajas y prepárate para evacuar.', en: 'Avoid ground floors and basements, move vehicles away from low areas, be ready to evacuate.' },
  1: { ca: 'Precaució: no travessis carrers inundats i segueix les indicacions oficials.', es: 'Precaución: no cruces calles inundadas y sigue las indicaciones oficiales.', en: 'Caution: do not cross flooded streets and follow official guidance.' },
  0: { ca: 'Sense risc previst en aquest escenari.', es: 'Sin riesgo previsto en este escenario.', en: 'No risk expected in this scenario.' },
};
export function draft(d) { L.draft = { ...d, when: st.fcPeak }; renderDraft(); $('comms').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function renderDraft() {
  const d = L.draft; if (!d) return;
  const lang = document.querySelector('#langTabs button.on').dataset.l, lv = LV[d.level];
  const depth = d.depth.toFixed(1), whenTx = d.when ? { ca: ` Pic previst: ${d.when}.`, es: ` Pico previsto: ${d.when}.`, en: ` Expected peak: ${d.when}.` } : { ca: '', es: '', en: '' };
  const T = {
    ca: `ES-ALERT · ALERTA INUNDACIÓ ${lv.ca}\n${d.target}: aigua prevista fins a ${depth} m.${whenTx.ca}\n${ADV[d.level].ca}\nInfo: Protecció Civil Catalunya. Emergències: 112.`,
    es: `ES-ALERT · ALERTA INUNDACIÓN ${lv.es}\n${d.target}: agua prevista hasta ${depth} m.${whenTx.es}\n${ADV[d.level].es}\nInfo: Protecció Civil Catalunya. Emergencias: 112.`,
    en: `ES-ALERT · FLOOD ALERT ${lv.en}\n${d.target}: water expected up to ${depth} m.${whenTx.en}\n${ADV[d.level].en}\nInfo: Catalan Civil Protection. Emergencies: 112.`,
  };
  const sms = `[${lv.ca}] Inundacio ${d.target.slice(0, 40)}: fins ${depth}m. ${ADV[d.level].ca.split('.')[0]}. 112`.slice(0, 160);
  $('draftBox').innerHTML = `<div class="row"><b>${esc(d.target)}</b><span class="badge" style="background:${lv.c}">${lv.en}</span></div>
    <div class="cap">Scope: ${d.scope} · broadcast polygon limited to the affected ${d.scope === 'street' ? 'street segment' : d.scope === 'address' ? 'building and neighbours' : '250 m block'}</div>
    <div class="phone"><div class="es">⚠ ${lang === 'ca' ? 'Alerta de Protecció Civil' : lang === 'es' ? 'Alerta de Protección Civil' : 'Civil Protection Alert'}</div><pre>${esc(T[lang])}</pre></div>
    <div class="cap">SMS (${sms.length}/160): ${esc(sms)}</div>
    <div class="cap">Push: <b>${lv.en} flood alert · ${esc(d.target)}</b> — up to ${depth} m expected.</div>`;
  $('send').disabled = false;
}
function sendDraft() {
  const d = L.draft; if (!d) return;
  const ch = [...document.querySelectorAll('#channels input:checked')].map((x) => x.value);
  L.log.unshift({ t: new Date().toLocaleTimeString(), d, ch });
  $('log').innerHTML = L.log.map((l) => `<div class="logi"><span class="lv" style="background:${LV[l.d.level].c}"></span><b>${l.t}</b> ${esc(l.d.target)} · ${l.ch.join(', ')} <span class="muted">(simulated)</span></div>`).join('');
  $('send').textContent = '✓ Dispatched (simulated)'; setTimeout(() => ($('send').textContent = 'Send alert (simulated)'), 1800);
}
