import { analyze, calibrate, RIVER } from './model.js';

const R = 20037508.342789244;
const WMS = 'https://servicios.idee.es/wms-inspire/riesgos-naturales/inundaciones';
const OFFICIAL = [
  { id: 'NZ.Flood.FluvialT10', name: 'Official 10-yr' },
  { id: 'NZ.Flood.FluvialT100', name: 'Official 100-yr' },
  { id: 'NZ.Flood.FluvialT500', name: 'Official 500-yr' },
  { id: 'NZ.Flood.MarinaT100', name: 'Official coastal 100-yr' },
];
const HOTSPOTS = [
  { name: "Delta de l'Ebre", lat: 40.705, lon: 0.80, z: 12, preset: 'gloria', river: [40.81, 0.52] },
  { name: 'Tortosa · Ebre', lat: 40.81, lon: 0.52, z: 13, river: [40.81, 0.52] },
  { name: 'Delta del Llobregat', lat: 41.32, lon: 2.07, z: 13, river: [41.36, 2.07] },
  { name: 'Girona · Onyar-Ter', lat: 41.98, lon: 2.82, z: 13 },
  { name: 'Delta de la Tordera', lat: 41.66, lon: 2.77, z: 13 },
  { name: "Aiguamolls de l'Empordà", lat: 42.23, lon: 3.08, z: 12, river: [42.17, 3.0] },
  { name: 'Besòs · Sant Adrià', lat: 41.44, lon: 2.21, z: 13 },
  { name: 'Lleida · Segre', lat: 41.615, lon: 0.62, z: 13 },
];
const PRESETS = {
  gloria: { name: 'Storm Gloria (2020)', stage: 3.5, surge: 1.6 },
  t100: { name: '100-yr river flood', stage: 3, surge: 0 },
  dana: { name: 'Extreme DANA', stage: 7, surge: 1 },
  slr: { name: 'Sea +1 m (2100)', stage: 0, surge: 1.0 },
  calm: { name: 'Dry', stage: 0, surge: 0 },
};

const $ = (id) => document.getElementById(id);
const st = { z: 13, area: null, model: null, stage: 0, surge: 0, official: null, fc: null, layers: new Set(), drainage: false };
window.st = st;

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  center: [1.6, 41.75], zoom: 7.4, pitch: 45, bearing: -10, maxPitch: 80, antialias: true,
  style: {
    version: 8,
    sources: {
      esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: 'Esri' },
      orto: { type: 'raster', tiles: ['https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wmts/orto/MON3857NW/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© ICGC' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Mapzen Terrarium' },
    },
    layers: [
      { id: 'esri', type: 'raster', source: 'esri' },
      { id: 'orto', type: 'raster', source: 'orto', paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.92 } },
    ],
    terrain: { source: 'dem', exaggeration: 1.6 },
    sky: { 'sky-color': '#0b1630', 'horizon-color': '#284a7a', 'fog-color': '#0b1630', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2 },
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

map.on('load', () => {
  map.addSource('dem-hs', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 14, encoding: 'terrarium' });
  map.addLayer({ id: 'hill', type: 'hillshade', source: 'dem-hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0a1020' } });
  for (const o of OFFICIAL) {
    map.addSource(o.id, { type: 'raster', tileSize: 256, tiles: [`${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${o.id}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`], attribution: 'SNCZI · IDEE' });
    map.addLayer({ id: o.id, type: 'raster', source: o.id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.75 } });
  }
  map.addSource('bbox', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'bbox-glow', type: 'line', source: 'bbox', paint: { 'line-color': '#38bdf8', 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'bbox', type: 'line', source: 'bbox', paint: { 'line-color': '#7dd3fc', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  setTimeout(() => runArea(HOTSPOTS[0]), 600);
});

map.on('click', (e) => runArea({ name: `${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`, lat: e.lngLat.lat, lon: e.lngLat.lng, z: st.z }));

// ---------- geo helpers ----------
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

// ---------- pipeline ----------
const toast = (t) => { $('toast').classList.toggle('hidden', !t); if (t) $('toastT').textContent = t; };
const tick = () => new Promise((r) => setTimeout(r, 30));

async function runArea(spot) {
  if (st.busy) return; st.busy = true;
  try {
    const z = spot.z, NT = 4, T = 256;
    const x0 = Math.round(lon2x(spot.lon, z) - NT / 2), y0 = Math.round(lat2y(spot.lat, z) - NT / 2);
    const W = NT * T, H = NT * T;
    const west = x2lon(x0, z), east = x2lon(x0 + NT, z), north = y2lat(y0, z), south = y2lat(y0 + NT, z);
    const coords = [[west, north], [east, north], [east, south], [west, south]];
    map.getSource('bbox').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...coords, coords[0]] } });
    $('areaName').textContent = spot.name;
    document.querySelectorAll('#hotspots button').forEach((b) => b.classList.toggle('on', b.textContent === spot.name));
    map.flyTo({ center: [(west + east) / 2, (north + south) / 2], zoom: z - 1.15, pitch: 62, bearing: -18, duration: 2200, essential: true });

    toast(`Fetching ${NT * NT} elevation tiles (z${z})`);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    await Promise.all([...Array(NT * NT)].map(async (_, k) => {
      const tx = x0 + (k % NT), ty = y0 + Math.floor(k / NT);
      const im = await loadImg(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`);
      ctx.drawImage(im, (k % NT) * T, Math.floor(k / NT) * T);
    }));
    const px = ctx.getImageData(0, 0, W, H).data, elev = new Float32Array(W * H);
    for (let i = 0; i < elev.length; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;

    const sea = markSea(elev, W, H);
    const latC = (north + south) / 2;
    const cell = (40075016.686 * Math.cos((latC * Math.PI) / 180)) / (T * 2 ** z);
    const cellArea = cell * cell;
    const t0 = performance.now();
    const model = await analyze(elev, sea, W, H, cellArea, 1.5e6, async (s) => { toast(s); await tick(); });
    const ms = performance.now() - t0;

    st.area = { spot, z, W, H, coords, elev, sea, cellArea, cell, bounds: { minx: (x0 / 2 ** z) * 2 * R - R, maxx: ((x0 + NT) / 2 ** z) * 2 * R - R, maxy: R - (y0 / 2 ** z) * 2 * R, miny: R - ((y0 + NT) / 2 ** z) * 2 * R } };
    st.model = model;
    st.official = null; st.calib = null;
    setupWater();
    buildCurve();
    toast(`Model ready in ${(ms / 1000).toFixed(1)} s · ${(W * H / 1e6).toFixed(2)}M cells @ ${cell.toFixed(0)} m — checking official maps & forecasts`);
    if (spot.preset) applyPreset(PRESETS[spot.preset], true); else render();
    await Promise.allSettled([loadOfficial(), loadForecast(spot)]);
    render();
    toast(null);
  } catch (err) {
    console.error(err); toast('Could not analyse this area: ' + err.message); setTimeout(() => toast(null), 3000);
  } finally { st.busy = false; }
}

// Terrarium has no near-shore bathymetry here: the open sea is exactly 0 m while delta land can be < 0.
// Sea = cells reachable from the window edge through exact-0 or deep (< -10 m) cells.
function markSea(elev, W, H) {
  const N = W * H, sea = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;
  const cand = (i) => elev[i] === 0 || elev[i] < -10;
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i - x) / W;
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && cand(i)) { sea[i] = 1; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j < 0 || j >= N || sea[j] || !cand(j)) continue; sea[j] = 1; q[qt++] = j;
    }
  }
  return sea;
}

// ---------- water rendering ----------
const LUT = (() => {
  const stops = [[0, [165, 243, 252, 150]], [0.25, [56, 189, 248, 175]], [0.5, [37, 99, 235, 200]], [0.75, [30, 58, 138, 220]], [1, [11, 20, 70, 235]]];
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [a, ca] = stops[k], [b, cb] = stops[k + 1], f = (t - a) / (b - a);
    for (let c = 0; c < 4; c++) out[i * 4 + c] = ca[c] + (cb[c] - ca[c]) * f;
  }
  return out;
})();
let waterCanvas, waterCtx, waterImg;

function setupWater() {
  const { W, H, coords } = st.area;
  waterCanvas = document.createElement('canvas'); waterCanvas.width = W; waterCanvas.height = H;
  waterCtx = waterCanvas.getContext('2d'); waterImg = waterCtx.createImageData(W, H);
  if (map.getLayer('water')) map.removeLayer('water');
  if (map.getSource('water')) map.removeSource('water');
  map.addSource('water', { type: 'image', url: waterCanvas.toDataURL(), coordinates: coords });
  map.addLayer({ id: 'water', type: 'raster', source: 'water', paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, 'bbox-glow');
}

let waterPending = false;
function pushWater() {
  if (waterPending) return; waterPending = true;
  requestAnimationFrame(() => {
    waterPending = false;
    const src = map.getSource('water');
    if (src) src.updateImage({ url: waterCanvas.toDataURL(), coordinates: st.area.coords });
  });
}

function render() {
  if (!st.model) return;
  const { elev, sea, W, H, cellArea } = st.area, { hand, spill, stream, type } = st.model, d8 = waterImg.data;
  const stage = st.stage, surge = st.surge, drain = st.drainage, off = st.official;
  let n = 0, sum = 0, max = 0, land = 0, hit = 0, offN = 0;
  for (let i = 0, N = W * H; i < N; i++) {
    const e = elev[i], o = i * 4;
    if (sea[i]) { d8[o + 3] = 0; continue; }
    land++;
    let d = stage - hand[i];
    if (spill[i] <= surge) { const c = surge - (e > 0 ? e : 0); if (c > d) d = c; }
    if (off && off[i]) offN++;
    if (d > 0.03) {
      n++; sum += d; if (d > max) max = d; if (off && off[i]) hit++;
      const l = Math.min(255, (d / 6) * 255) << 2;
      d8[o] = LUT[l]; d8[o + 1] = LUT[l + 1]; d8[o + 2] = LUT[l + 2]; d8[o + 3] = LUT[l + 3];
    } else if (drain && stream[i] && type[i] === RIVER) { d8[o] = 125; d8[o + 1] = 211; d8[o + 2] = 252; d8[o + 3] = 200; }
    else d8[o + 3] = 0;
  }
  waterCtx.putImageData(waterImg, 0, 0);
  pushWater();
  const km2 = (n * cellArea) / 1e6;
  $('sArea').textContent = km2 < 10 ? km2.toFixed(2) : km2.toFixed(1);
  $('sPct').textContent = land ? ((100 * n) / land).toFixed(1) + '%' : '–';
  $('sMax').textContent = n ? max.toFixed(1) + 'm' : '–';
  $('sMean').textContent = n ? (sum / n).toFixed(2) + 'm' : '–';
  if (off && offN) {
    const union = offN + n - hit;
    $('vIoU').textContent = (hit / union).toFixed(2);
    $('vRecall').textContent = ((100 * hit) / offN).toFixed(0) + '%';
  }
  $('stageV').textContent = stage.toFixed(1) + ' m';
  $('surgeV').textContent = surge.toFixed(2) + ' m';
  $('stage').value = stage; $('surge').value = surge;
  drawCurveMarker();
}

// ---------- stage-area curve ----------
let curveData = null;
function buildCurve() {
  const { elev, sea, cellArea } = st.area, { hand, type } = st.model, step = 0.1, bins = 121, h = new Float64Array(bins + 1);
  for (let i = 0; i < elev.length; i++) if (!sea[i] && type[i] && hand[i] < 12) h[Math.floor(hand[i] / step) + 1]++;
  const pts = []; let c = 0;
  for (let b = 0; b <= bins; b++) { c += h[b]; pts.push([b * step, (c * cellArea) / 1e6]); }
  curveData = pts; drawCurveMarker();
}
function drawCurveMarker() {
  if (!curveData) return;
  const w = 330, hgt = 90, maxA = curveData[curveData.length - 1][1] || 1;
  const X = (s) => 28 + (s / 12) * (w - 34), Y = (a) => hgt - 14 - (a / maxA) * (hgt - 22);
  const path = curveData.map(([s, a], i) => `${i ? 'L' : 'M'}${X(s).toFixed(1)},${Y(a).toFixed(1)}`).join('');
  const k = Math.min(curveData.length - 1, Math.round(st.stage / 0.1)), [cs, ca] = curveData[k];
  let calib = '';
  if (st.calib) calib = `<line x1="${X(st.calib.best.stage)}" x2="${X(st.calib.best.stage)}" y1="6" y2="${hgt - 14}" stroke="#f43f5e" stroke-dasharray="3 3"/><text x="${X(st.calib.best.stage) + 4}" y="14" fill="#fb7185" font-size="9">T100 fit</text>`;
  $('curve').innerHTML = `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#38bdf8" stop-opacity=".5"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></linearGradient></defs>
    <path d="${path}L${X(12)},${hgt - 14}L${X(0)},${hgt - 14}Z" fill="url(#g)"/><path d="${path}" fill="none" stroke="#7dd3fc" stroke-width="1.6"/>
    ${calib}
    <circle cx="${X(cs)}" cy="${Y(ca)}" r="4.5" fill="#fff" stroke="#38bdf8" stroke-width="2"/>
    <text x="2" y="12" fill="#8ea0bf" font-size="9">${maxA.toFixed(0)} km²</text><text x="2" y="${hgt - 16}" fill="#8ea0bf" font-size="9">0</text>
    ${[0, 3, 6, 9, 12].map((s) => `<text x="${X(s) - 4}" y="${hgt - 2}" fill="#8ea0bf" font-size="9">${s}m</text>`).join('')}
  </svg>`;
}

// ---------- official flood map validation ----------
async function loadOfficial() {
  const { W, H, bounds: b } = st.area;
  $('vIoU').textContent = '…'; $('vRecall').textContent = '…'; $('calib').disabled = true;
  const url = `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=NZ.Flood.FluvialT100&STYLES=&CRS=EPSG:3857&BBOX=${b.minx},${b.miny},${b.maxx},${b.maxy}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/png&TRANSPARENT=true`;
  const area = st.area;
  const im = await loadImg(url);
  if (st.area !== area) return;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, W, H).data, off = new Uint8Array(W * H);
  let n = 0; for (let i = 0; i < off.length; i++) if (d[i * 4 + 3] > 40) { off[i] = 1; n++; }
  if (!n) { st.official = null; $('vIoU').textContent = 'n/a'; $('vRecall').textContent = 'n/a'; $('vNote').textContent = 'No official 100-yr fluvial zone mapped inside this area.'; return; }
  st.official = off;
  st.calib = calibrate(st.model, st.area.sea, off, 12, 0.1);
  $('calib').disabled = false;
  $('vNote').textContent = `${((n * st.area.cellArea) / 1e6).toFixed(1)} km² of official T100 zone in area. Best fit: ${st.calib.best.stage.toFixed(1)} m stage → IoU ${st.calib.best.iou.toFixed(2)}.`;
  drawCurveMarker();
}
$('calib').onclick = () => { if (st.calib) animateTo(st.calib.best.stage, 0); };

// ---------- live forecast ----------
async function loadForecast(spot) {
  $('fcNote').textContent = 'Loading forecast…'; $('applyFc').disabled = true;
  const [rlat, rlon] = spot.river || [spot.lat, spot.lon];
  const [rain, flood] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}&daily=precipitation_sum&forecast_days=7&timezone=auto`).then((r) => r.json()),
    fetch(`https://flood-api.open-meteo.com/v1/flood?latitude=${rlat}&longitude=${rlon}&daily=river_discharge,river_discharge_median,river_discharge_max&past_days=30&forecast_days=30`).then((r) => r.json()).catch(() => null),
  ]);
  const p = rain.daily.precipitation_sum.map((v) => v || 0), days = rain.daily.time;
  bars('rain', p, days);
  let qPeak = 0, qMed = 0, ratio = 1;
  if (flood && flood.daily) {
    const q = flood.daily.river_discharge.map((v) => v ?? 0), qmax = flood.daily.river_discharge_max.map((v) => v ?? 0), med = flood.daily.river_discharge_median.map((v) => v ?? 0);
    const today = flood.daily.time.indexOf(new Date().toISOString().slice(0, 10));
    const fut = today >= 0 ? today : 30;
    qPeak = Math.max(...qmax.slice(fut)); qMed = med.slice(fut).reduce((a, b) => a + b, 0) / Math.max(1, med.length - fut);
    ratio = qMed >= 3 ? Math.min(20, qPeak / qMed) : 1;
    spark('q', q, qmax, fut);
  } else $('q').innerHTML = '<div class="cap">No GloFAS river cell here</div>';
  const pMax = Math.max(...p), p7 = p.reduce((a, b) => a + b, 0);
  // Indicative mapping (not hydraulic): discharge anomaly + peak daily rain -> stage above channel
  const stage = Math.min(10, Math.max(0, 1.4 * Math.log(Math.max(1, ratio)) + 0.025 * pMax));
  st.fc = { stage, surge: 0 };
  $('fcNote').innerHTML = `Peak rain <b>${pMax.toFixed(0)} mm/day</b> · 7-day <b>${p7.toFixed(0)} mm</b>${qPeak ? ` · GloFAS peak <b>${qPeak.toFixed(0)} m³/s</b> (${ratio.toFixed(1)}× median)` : ''}<br/>→ indicative stage <b>${stage.toFixed(1)} m</b>`;
  $('applyFc').disabled = false;
}
$('applyFc').onclick = () => st.fc && animateTo(st.fc.stage, st.surge);

function bars(id, vals, labels) {
  const w = 330, h = 56, m = Math.max(10, ...vals), bw = (w - 10) / vals.length;
  $(id).innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${vals.map((v, i) => {
    const bh = (v / m) * (h - 18), x = 5 + i * bw;
    return `<rect x="${x + 3}" y="${h - 12 - bh}" width="${bw - 6}" height="${Math.max(1, bh)}" rx="3" fill="${v > 50 ? '#f43f5e' : v > 20 ? '#f59e0b' : '#38bdf8'}"/>
    <text x="${x + bw / 2}" y="${h - 2}" text-anchor="middle" fill="#8ea0bf" font-size="9">${new Date(labels[i]).toLocaleDateString('en', { weekday: 'short' })}</text>
    ${v >= 1 ? `<text x="${x + bw / 2}" y="${h - 15 - bh}" text-anchor="middle" fill="#c7d3e8" font-size="9">${v.toFixed(0)}</text>` : ''}`;
  }).join('')}</svg>`;
}
function spark(id, q, qmax, today) {
  const w = 330, h = 56, m = Math.max(1, ...qmax, ...q), X = (i) => (i / (q.length - 1)) * w, Y = (v) => h - 4 - (v / m) * (h - 10);
  const line = (a) => a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  $(id).innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${line(qmax)}" fill="none" stroke="#6366f1" stroke-width="1" stroke-dasharray="3 2"/>
    <path d="${line(q)}" fill="none" stroke="#38bdf8" stroke-width="1.8"/>
    <line x1="${X(today)}" x2="${X(today)}" y1="0" y2="${h}" stroke="#fff" stroke-opacity=".4"/><text x="${X(today) + 3}" y="10" fill="#c7d3e8" font-size="9">today</text>
    <text x="${w - 2}" y="10" text-anchor="end" fill="#8ea0bf" font-size="9">${m.toFixed(0)}</text></svg>`;
}

// ---------- controls ----------
function animateTo(stage, surge, ms = 2600) {
  const s0 = st.stage, g0 = st.surge, t0 = performance.now();
  cancelAnimationFrame(st.anim);
  const f = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    st.stage = s0 + (stage - s0) * e; st.surge = g0 + (surge - g0) * e; render();
    if (k < 1) st.anim = requestAnimationFrame(f);
  };
  st.anim = requestAnimationFrame(f);
}
function applyPreset(p, fromZero) { if (fromZero) { st.stage = 0; st.surge = 0; render(); } animateTo(p.stage, p.surge); }

$('stage').oninput = (e) => { cancelAnimationFrame(st.anim); st.stage = +e.target.value; render(); };
$('surge').oninput = (e) => { cancelAnimationFrame(st.anim); st.surge = +e.target.value; render(); };
$('animate').onclick = () => {
  const ts = st.stage || 4, tg = st.surge;
  st.stage = 0; st.surge = 0; render(); animateTo(ts, tg, 4000);
};
$('ex').oninput = (e) => { map.setTerrain({ source: 'dem', exaggeration: +e.target.value }); $('exV').textContent = (+e.target.value).toFixed(1) + '×'; };
document.querySelectorAll('#res button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#res button').forEach((x) => x.classList.toggle('on', x === b)); st.z = +b.dataset.z;
});
for (const h of HOTSPOTS) { const b = document.createElement('button'); b.textContent = h.name; b.onclick = () => runArea(h); $('hotspots').appendChild(b); }
for (const k in PRESETS) { const b = document.createElement('button'); b.textContent = PRESETS[k].name; b.onclick = () => applyPreset(PRESETS[k]); $('presets').appendChild(b); }
for (const o of [...OFFICIAL, { id: 'drainage', name: 'Drainage network' }]) {
  const b = document.createElement('button'); b.textContent = o.name;
  b.onclick = () => {
    const on = !b.classList.contains('on'); b.classList.toggle('on', on);
    if (o.id === 'drainage') { st.drainage = on; render(); } else map.setLayoutProperty(o.id, 'visibility', on ? 'visible' : 'none');
  };
  $('layers').appendChild(b);
}
