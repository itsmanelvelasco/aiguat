// Terrain-based flood model: priority-flood drainage tree -> flow accumulation -> HAND
// (Height Above Nearest Drainage) + sea-connected spill elevation for coastal flooding.

class MinHeap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    const k = this.k, v = this.v; let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], n = --this.n;
    if (n > 0) {
      const key = k[n], val = v[n]; let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    return top;
  }
}

const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];

export const RIVER = 2, SEA = 1, NONE = 0;

export async function analyze(elev, sea, W, H, cellArea, streamAreaM2, onStep = async () => {}) {
  const N = W * H;
  await onStep('Priority-flood: carving the drainage tree');
  const heap = new MinHeap(N), vis = new Uint8Array(N), rec = new Int32Array(N).fill(-1);
  const order = new Int32Array(N), filled = new Float32Array(N);
  let seaCells = 0;
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i - x) / W;
    if (sea[i]) seaCells++;
    if (sea[i] || x === 0 || y === 0 || x === W - 1 || y === H - 1) { vis[i] = 1; filled[i] = elev[i]; heap.push(elev[i], i); }
  }
  let n = 0;
  while (heap.n) {
    const i = heap.pop(); order[n++] = i;
    const x = i % W, y = (i - x) / W, fi = filled[i];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx; if (vis[j]) continue;
      vis[j] = 1; const f = elev[j] > fi ? elev[j] : fi + 1e-3;
      filled[j] = f; rec[j] = i; heap.push(f, j);
    }
  }

  await onStep('Flow accumulation over ' + (N / 1e6).toFixed(2) + 'M cells');
  const acc = new Float32Array(N).fill(1);
  for (let k = n - 1; k >= 0; k--) { const i = order[k], r = rec[i]; if (r >= 0) acc[r] += acc[i]; }

  await onStep('HAND: height above nearest drainage');
  const base = { elev, sea, order, rec, acc, n, N };
  const h = handFor(base, streamAreaM2 / cellArea);
  await onStep('Coastal connectivity (sea spill elevation)');
  const spill = new Float32Array(N).fill(Infinity);
  if (seaCells) {
    const h2 = new MinHeap(N), v2 = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (sea[i]) { v2[i] = 1; spill[i] = elev[i]; h2.push(elev[i], i); }
    while (h2.n) {
      const i = h2.pop(), x = i % W, y = (i - x) / W, si = spill[i];
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx; if (v2[j]) continue;
        v2[j] = 1; const s = elev[j] > si ? elev[j] : si; spill[j] = s; h2.push(s, j);
      }
    }
  }
  return { ...h, spill, acc, rec, order, n, seaCells, base };
}

// HAND for a given stream-initiation threshold (cells). Cheap: one pass over the drainage order.
export function handFor({ elev, sea, order, rec, acc, n, N }, thr) {
  const hand = new Float32Array(N).fill(Infinity), type = new Uint8Array(N), dEl = new Float32Array(N), stream = new Uint8Array(N);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (sea[i]) { type[i] = SEA; dEl[i] = 0; hand[i] = 0; continue; }
    if (acc[i] >= thr) { stream[i] = 1; type[i] = RIVER; dEl[i] = elev[i]; hand[i] = 0; continue; }
    const r = rec[i];
    if (r < 0 || type[r] === NONE) { type[i] = NONE; continue; }
    type[i] = type[r]; dEl[i] = dEl[r];
    const h = elev[i] - dEl[i]; hand[i] = h > 0 ? h : 0;
  }
  return { hand, type, dEl, stream, thr };
}

// Flooded cells vs official mask, swept over river stage using HAND histograms.
export function calibrate(model, sea, official, maxStage = 15, step = 0.1) {
  const bins = Math.ceil(maxStage / step) + 1;
  const all = new Float64Array(bins), hit = new Float64Array(bins);
  let offCount = 0;
  const { hand, type } = model;
  for (let i = 0; i < sea.length; i++) {
    if (sea[i]) continue;
    const o = official[i]; if (o) offCount++;
    if (!type[i]) continue;
    const h = hand[i]; if (!(h < maxStage)) continue;
    const b = Math.floor(h / step) + 1; // flooded when stage > hand
    all[b]++; if (o) hit[b]++;
  }
  const curve = []; let ca = 0, ch = 0, best = { iou: 0, stage: 0 };
  for (let b = 0; b < bins; b++) {
    ca += all[b]; ch += hit[b];
    const stage = b * step, union = offCount + ca - ch, iou = union ? ch / union : 0;
    curve.push({ stage, iou, recall: offCount ? ch / offCount : 0, cells: ca });
    if (iou > best.iou) best = { iou, stage };
  }
  return { curve, best, offCount };
}
