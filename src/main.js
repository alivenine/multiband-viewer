const T = 512;               // must match worker tile size
const MAX_TILES = 320;       // decoded tiles kept in memory (~1 MB each)
const MAX_INFLIGHT = 12;     // per image
const $ = (s) => document.querySelector(s);
const dpr = () => window.devicePixelRatio || 1;

// ---------------- state ----------------
const images = [];           // {id,key,name,worker,meta,status,progress,matrix,score,adj,inflight,ov}
let refId = null;
const view = { cx: 0, cy: 0, s: 0 };   // center in reference px, CSS px per reference px
let layout = 'auto';
let panels = [];             // {el, ic, oc, ictx, octx, sel, imgId, w, h}
let anns = [];               // annotations in reference coords
let selected = null;
let tool = 'pan';
let activeId = null;         // image picked by clicking its panel: highlighted in panel + sidebar
let hover = null;            // {panel, x, y} ref coords
let manual = null;           // {imgId, pairs:[{t:[x,y], r:[x,y]}], pendingRef}
const history = [];
let nextId = 1;
const tiles = new Map();     // key -> ImageBitmap | null (pending)
let dirtyImg = true, dirtyOv = true;
const pendingProject = { entries: [] };

// ---------------- matrices ([a,b,c,d,e,f]: x' = a x + c y + e, y' = b x + d y + f) ----------------
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const ID = [1, 0, 0, 1, 0, 0];
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const byId = (id) => images.find((i) => i.id === id);
const refImg = () => byId(refId);

// Default placement: fit target over reference, centered (before/without registration).
function fitMatrix(img) {
  const r = refImg();
  if (!r || r === img || !r.meta || !img.meta) return ID.slice();
  const k = (r.meta.width / img.meta.width + r.meta.height / img.meta.height) / 2;
  return [k, 0, 0, k, (r.meta.width - k * img.meta.width) / 2, (r.meta.height - k * img.meta.height) / 2];
}

// ---------------- cache key ----------------
function keyOf(f) {
  let h = 2166136261;
  const s = `${f.name}|${f.size}|${f.lastModified}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + '-' + f.size.toString(36);
}

// ---------------- opening images ----------------
// Visible / white-light image goes to panel 1 and becomes the reference.
const word = (w) => new RegExp(`(^|[^a-z])(${w})([^a-z]|$)`);
const VIS = word('visible|vis|vis light|white|white light|whitelight|d65|halogen|rgb|color|colour');
const NOT_VIS = word('uv|uvf|uvr|uvl|ir|irr|nir|swir|irfc|infrared|fluo|fluorescence|x ?ray|xray|xrf|fc|false|raking|transmitted');
function isVisibleName(name) {
  const s = name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[_\-.]+/g, ' ');
  return VIS.test(s) && !NOT_VIS.test(s);
}

function openFiles(files) {
  files = [...files].sort((a, b) => isVisibleName(b.name) - isVisibleName(a.name));
  for (const f of files) {
    if (!/\.(tiff?|jpe?g|png|webp)$/i.test(f.name) && !f.type.startsWith('image/')) continue;
    const key = keyOf(f);
    const slot = pendingProject.entries.find((e) => e.key === key);
    if (images.some((i) => i.key === key)) continue;
    addImage({ key, file: f, name: f.name, saved: slot });
  }
}

function addImage({ key, file, name, saved }) {
  const img = {
    id: nextId++, key, name, worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    meta: null, status: 'importing', progress: 0, matrix: null, score: null,
    adj: { b: 100, c: 100, inv: false }, inflight: 0, ov: null, cbs: new Map(), aligned: false,
  };
  if (saved) {
    img.matrix = saved.matrix; img.adj = saved.adj || img.adj; img.aligned = true; img.score = saved.score; img.err = saved.err ?? null; img.via = saved.via ?? null;
    pendingProject.entries = pendingProject.entries.filter((e) => e !== saved);
  }
  const vis = !saved && isVisibleName(name) && !images.some((i) => i.vis);
  img.vis = vis;
  if (vis) {
    images.unshift(img);
    if (refId != null && refImg()?.status === 'ready') img.wantRef = true; else refId = img.id;
    panels.forEach((p, i) => { p.imgId = images[i]?.id ?? null; }); // visible -> panel 1, others shift right
  } else images.push(img);
  if (refId == null) refId = img.id;
  img.worker.onmessage = (e) => onWorker(img, e.data);
  startImport(img, { type: 'open', file, key });
  syncPanels(); renderList();
}

// At most 3 imports at once: each large JPEG decode holds ~4 bytes/pixel in RAM until tiled.
const IMPORT_SLOTS = 3, importQ = [];
let importing = 0;
function startImport(img, msg) {
  if (importing >= IMPORT_SLOTS) { importQ.push([img, msg]); return; }
  importing++; img.slot = true;
  img.worker.postMessage(msg);
}
function releaseSlot(img) {
  const qi = importQ.findIndex(([i]) => i === img);
  if (qi >= 0) importQ.splice(qi, 1);
  if (!img.slot) return;
  img.slot = false; importing--;
  const next = importQ.shift();
  if (next) startImport(...next);
}

function onWorker(img, m) {
  if (m.type === 'progress') { img.progress = m.p; renderListThrottled(); return; }
  if (m.type === 'info') { img.meta = { width: m.width, height: m.height, bits: m.bits }; renderList(); return; }
  if (m.type === 'ready') {
    img.meta = m.meta; img.status = 'ready'; img.name = m.meta.name; releaseSlot(img);
    if (!img.matrix) img.matrix = fitMatrix(img);
    if (img.wantRef) { // visible arrived after others: make it the reference and re-align the rest
      img.wantRef = false; setReference(img);
      images.forEach((i) => { if (i !== img) { i.aligned = false; i.score = null; i.alignFailed = false; i.err = null; i.via = null; } });
    }
    if (img.id === refId && !view.s) fit();
    renderList(); renderLibrary(); dirtyImg = true;
    return; // no auto-alignment on open: user clicks "Auto-align all" 
  }
  if (m.type === 'tile') {
    img.inflight--;
    tiles.set(m.id, m.bmp); evict(); dirtyImg = true; return;
  }
  if (m.type === 'overview') { img.cbs.get(m.id)?.(m); img.cbs.delete(m.id); return; }
  if (m.type === 'pixel') {
    img.rgb = m.rgb; img.pxBusy = false; showRgb();
    if (img.pxNext) { const [x, y] = img.pxNext; img.pxNext = null; queryPixel(img, x, y); }
    return;
  }
  if (m.type === 'error') {
    if (m.id && tiles.has(m.id)) { tiles.delete(m.id); img.inflight--; return; }
    if (m.id && img.cbs.has(m.id)) { img.cbs.get(m.id)(null); img.cbs.delete(m.id); return; }
    img.status = 'error'; img.error = m.message; releaseSlot(img); renderList();
  }
}

function overviewOf(img) {
  if (!img.ov) img.ov = new Promise((res) => {
    const id = 'ov' + Math.random();
    img.cbs.set(id, res);
    img.worker.postMessage({ type: 'overview', id });
  });
  return img.ov;
}

function closeImage(img) {
  img.worker.terminate();
  releaseSlot(img);
  if (img.status !== 'ready') setTimeout(renderLibrary, 1000); // cancelled import: cache list removes the partial entry
  images.splice(images.indexOf(img), 1);
  for (const k of [...tiles.keys()]) if (k.startsWith(img.id + '/')) { tiles.get(k)?.close(); tiles.delete(k); }
  if (refId === img.id) {
    const n = images.find((i) => i.status === 'ready');
    refId = null;
    if (n) setReference(n); else refId = images[0]?.id ?? null;
  }
  syncPanels(); renderList(); renderLibrary();
}

// ---------------- registration ----------------
const regWorker = new Worker(new URL('./register.js', import.meta.url), { type: 'module' });
const regCbs = new Map();
regWorker.onmessage = (e) => {
  const cb = regCbs.get(e.data.id);
  if (e.data.progress != null) { cb?.progress?.(e.data.progress); return; }
  cb?.(e.data); regCbs.delete(e.data.id);
};
let regQueue = Promise.resolve();

// Alignment history so a bad result can be undone.
function pushAlign(img) {
  (img.alignHist ||= []).push({ matrix: img.matrix.slice(), score: img.score, alignFailed: img.alignFailed, aligned: img.aligned, full: img.full, err: img.err, via: img.via });
  if (img.alignHist.length > 20) img.alignHist.shift();
}
function undoAlign(img) {
  const h = img.alignHist?.pop();
  if (!h) return;
  Object.assign(img, h); dirtyImg = dirtyOv = true; renderList();
}

// Reject results far from the default fit: >10° rotation, scale off by >30%, or center moved >25%.
function plausible(img, m) {
  if (!m?.every(Number.isFinite)) return false;
  const fit = fitMatrix(img), r = refImg();
  const ratio = scaleOf(m) / scaleOf(fit), rot = Math.abs(Math.atan2(m[1], m[0])) * 180 / Math.PI;
  const c = [img.meta.width / 2, img.meta.height / 2], a = apply(m, c), b = apply(fit, c);
  return ratio > 0.7 && ratio < 1.4 && rot < 10 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.25 * Math.max(r.meta.width, r.meta.height);
}

function runReg(base, img, full, progress) {
  return regQueue = regQueue.then(async () => {
    const [a, b] = await Promise.all([overviewOf(base), overviewOf(img)]);
    if (!a || !b) return { error: 'no overview' };
    const id = Math.random();
    const res = await new Promise((done) => {
      done.progress = progress;
      regCbs.set(id, done);
      // copy buffers: overviews are reused for later alignments
      regWorker.postMessage({ id, full, ref: { ...a, data: a.data.slice() }, tgt: { ...b, data: b.data.slice() } });
    });
    if (res.err != null) res.err /= a.scale; // overview px -> full-res px of `base`
    return res;
  });
}

// Bands that share little with the reference (transmitted IR vs visible) often match a sibling band well
// (IRT vs IR: same wavelength and focus). Try the closest-named verified bands; chain target -> via -> reference.
function viaCandidates(img, r) {
  const band = (i) => i.name.replace(/\.[^.]+$/, '').split(/[\s_-]+/).pop().toUpperCase();
  const t = band(img), common = (s) => { let k = 0; while (k < s.length && s[k] === t[k]) k++; return k; };
  return images.filter((i) => i !== img && i !== r && i.status === 'ready' && i.err != null && !i.via)
    .sort((x, y) => common(band(y)) - common(band(x)) || band(x).length - band(y).length).slice(0, 3);
}

async function autoAlign(img, full = false) {
  const r = refImg();
  if (!r || r.status !== 'ready' || img === r || img.aligning) return;
  img.aligning = full ? 'full' : 'quick'; img.alignProgress = 0; renderList();
  const progress = (f) => { img.alignProgress = f; renderListThrottled(); };
  let res = await runReg(r, img, full, progress), via = null;
  if (!res.error && res.err == null) { // not verified by the patch check: try through a sibling band
    // with "Auto-align all", let the other bands finish first so they can serve as the link
    img.aligning = 'waiting'; renderList();
    while (images.some((i) => i !== img && i.aligning && i.aligning !== 'waiting' && !i.aligning.startsWith('via'))) await regQueue;
    for (const m of viaCandidates(img, r)) {
      img.aligning = 'via ' + m.name; renderList();
      const v = await runReg(m, img, true, progress);
      if (v.error || v.err == null) continue;
      res = { matrix: mul(m.matrix, v.matrix), score: null, err: Math.hypot(v.err, m.err), full: true };
      via = m.name; break;
    }
  }
  img.aligning = false;
  if (refImg() !== r || !images.includes(img)) { renderList(); return; }
  const bad = res.error || !plausible(img, res.matrix) || (!full && !via && res.err == null && !(res.score > 0.1));
  if (bad) { img.alignFailed = true; } // keep the current placement
  else {
    pushAlign(img);
    img.matrix = res.matrix; img.score = res.score; img.alignFailed = false; img.aligned = true; img.full = full || !!via;
    img.err = res.err ?? null; img.via = via;
  }
  dirtyImg = dirtyOv = true; renderList();
}

// Similarity transform (target px -> ref px) from >= 2 point pairs, least squares.
function similarityFrom(pairs) {
  const n = pairs.length;
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (const { t, r } of pairs) { mx += t[0]; my += t[1]; mu += r[0]; mv += r[1]; }
  mx /= n; my /= n; mu /= n; mv /= n;
  let sxx = 0, a = 0, b = 0;
  for (const { t, r } of pairs) {
    const x = t[0] - mx, y = t[1] - my, u = r[0] - mu, v = r[1] - mv;
    sxx += x * x + y * y; a += x * u + y * v; b += x * v - y * u;
  }
  a /= sxx; b /= sxx;
  return [a, b, -b, a, mu - a * mx + b * my, mv - b * mx - a * my];
}

function setReference(img) {
  if (!img.meta || img.id === refId) { refId = img.id; return; }
  const T_ = invert(img.matrix);   // old ref coords -> new ref coords
  for (const i of images) {
    if (i.matrix) i.matrix = mul(T_, i.matrix);
    i.alignHist?.forEach((h) => { h.matrix = mul(T_, h.matrix); });
  }
  img.matrix = ID.slice();
  for (const a of anns) {
    if (a.pts) a.pts = a.pts.map((p) => apply(T_, p));
    if (a.x != null) [a.x, a.y] = apply(T_, [a.x, a.y]);
  }
  [view.cx, view.cy] = apply(T_, [view.cx, view.cy]);
  view.s /= scaleOf(T_);
  refId = img.id;
  dirtyImg = dirtyOv = true; renderList();
}

// ---------------- layout / panels ----------------
function gridDims() {
  if (layout !== 'auto') return layout.split('x').map(Number);
  const n = Math.max(1, images.length);
  const g = $('#grid'), wide = g.clientWidth >= g.clientHeight;
  const cols = wide ? Math.ceil(Math.sqrt(n * 1.5)) : Math.ceil(Math.sqrt(n / 1.5));
  const c = Math.min(n, Math.max(1, cols));
  return [c, Math.ceil(n / c)];
}

function syncPanels() {
  const [c, r] = gridDims();
  const n = c * r, g = $('#grid');
  g.style.gridTemplateColumns = `repeat(${c}, 1fr)`;
  g.style.gridTemplateRows = `repeat(${r}, 1fr)`;
  while (panels.length > n) panels.pop().el.remove();
  while (panels.length < n) panels.push(makePanel(panels.length));
  panels.forEach((p, i) => {
    if (p.imgId == null || !byId(p.imgId)) p.imgId = images[i]?.id ?? null;
    p.sel.innerHTML = '<option value="">—</option>' + images.map((im) =>
      `<option value="${im.id}" ${im.id === p.imgId ? 'selected' : ''}>${esc(im.name)}</option>`).join('');
  });
  resize();
}

function makePanel(i) {
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = '<canvas class="im"></canvas><canvas class="ov"></canvas><div class="hdr"><select></select><span class="rgb" hidden></span></div>';
  $('#grid').appendChild(el);
  const p = { el, ic: el.querySelector('.im'), oc: el.querySelector('.ov'), sel: el.querySelector('select'), rgbEl: el.querySelector('.rgb'), imgId: null, w: 0, h: 0 };
  p.ictx = p.ic.getContext('2d'); p.octx = p.oc.getContext('2d');
  p.rgbEl.hidden = !rgbOn;
  p.sel.onchange = () => { p.imgId = p.sel.value ? +p.sel.value : null; applyFilter(p); markActive(); dirtyImg = dirtyOv = true; };
  bindPointer(p);
  return p;
}

function resize() {
  for (const p of panels) {
    const r = p.el.getBoundingClientRect();
    p.w = r.width; p.h = r.height;
    for (const c of [p.ic, p.oc]) { c.width = Math.round(r.width * dpr()); c.height = Math.round(r.height * dpr()); }
    applyFilter(p);
  }
  if (!(view.s > 0)) fit();
  dirtyImg = dirtyOv = true;
}
new ResizeObserver(() => { if (layout === 'auto') syncPanels(); else resize(); }).observe($('#grid'));

function applyFilter(p) {
  const img = byId(p.imgId);
  const a = img?.adj;
  p.ic.style.filter = a ? `brightness(${a.b}%) contrast(${a.c}%)${a.inv ? ' invert(1)' : ''}` : '';
}

function fit() {
  const r = refImg();
  const p = panels[0];
  if (!r?.meta || !p?.w || !p?.h) return;
  view.cx = r.meta.width / 2; view.cy = r.meta.height / 2;
  view.s = Math.min(p.w / r.meta.width, p.h / r.meta.height) * 0.96;
  dirtyImg = dirtyOv = true;
}

// ---------------- rendering ----------------
function requestTile(img, l, x, y, key) {
  if (img.inflight >= MAX_INFLIGHT) return;
  img.inflight++;
  tiles.set(key, null);
  img.worker.postMessage({ type: 'tile', id: key, l, x, y });
}

function evict() {
  if (tiles.size <= MAX_TILES) return;
  for (const [k, v] of tiles) {
    if (tiles.size <= MAX_TILES) break;
    if (v) { v.close(); tiles.delete(k); }
  }
}

function screenMatrix(p, img) {
  const s = view.s * dpr(), M = img.matrix;
  return [s * M[0], s * M[1], s * M[2], s * M[3],
    s * (M[4] - view.cx) + p.w * dpr() / 2, s * (M[5] - view.cy) + p.h * dpr() / 2];
}

// Compare: overlay the reference on each panel to check alignment. Swipe follows the cursor (same painting
// spot in every panel), flicker alternates, difference shows misregistration as doubled edges.
let cmpMode = '', flickOn = false;
setInterval(() => { if (cmpMode === 'flicker') { flickOn = !flickOn; dirtyImg = true; } }, 450);
function setCompare(m) { cmpMode = m; $('#compare').value = m; dirtyImg = true; }
$('#compare').onchange = (e) => { setCompare(e.target.value); e.target.blur(); };
setCompare(''); // always start with Compare off (browsers restore select values on reload)

function drawImagePanel(p) {
  const ctx = p.ictx, W = p.ic.width, H = p.ic.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const img = byId(p.imgId), r = refImg();
  if (!img || img.status !== 'ready' || !img.matrix) return;
  if (!cmpMode || !r || r === img || r.status !== 'ready') return drawLayers(p, img);
  if (cmpMode === 'flicker') return drawLayers(p, flickOn ? r : img);
  drawLayers(p, img);
  // reference rendered separately first: it is drawn in several pyramid levels, which must not each be differenced
  const t = p.tmp ||= document.createElement('canvas');
  if (t.width !== W || t.height !== H) { t.width = W; t.height = H; }
  const tc = t.getContext('2d');
  tc.setTransform(1, 0, 0, 1, 0, 0); tc.clearRect(0, 0, W, H);
  drawLayers(p, r, tc);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (cmpMode === 'swipe') {
    const x = hover ? view.s * dpr() * (hover.x - view.cx) + W / 2 : W / 2;
    ctx.beginPath(); ctx.rect(x, 0, W - x, H); ctx.clip();
  } else ctx.globalCompositeOperation = 'difference';
  ctx.drawImage(t, 0, 0);
  ctx.restore();
  if (cmpMode === 'swipe') {
    const x = hover ? view.s * dpr() * (hover.x - view.cx) + W / 2 : W / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0af'; ctx.fillRect(x - dpr() / 2, 0, dpr(), H);
  }
}

function drawLayers(p, img, ctx = p.ictx) {
  const W = p.ic.width, H = p.ic.height;
  const A = screenMatrix(p, img), ex = scaleOf(A), L = img.meta.levels.length;
  const l = Math.max(0, Math.min(L - 1, Math.floor(Math.log2(1 / ex))));
  const inv = invert(A);
  const cs = [[0, 0], [W, 0], [0, H], [W, H]].map((c) => apply(inv, c));
  const x0 = Math.min(...cs.map((c) => c[0])), x1 = Math.max(...cs.map((c) => c[0]));
  const y0 = Math.min(...cs.map((c) => c[1])), y1 = Math.max(...cs.map((c) => c[1]));
  ctx.imageSmoothingEnabled = ex < 2.5;
  ctx.imageSmoothingQuality = 'high';
  for (let lv = L - 1; lv >= l; lv--) {
    if (lv !== L - 1 && lv > l + 3) continue;
    const k = 2 ** lv, lev = img.meta.levels[lv], ts = T * k;
    ctx.setTransform(A[0] * k, A[1] * k, A[2] * k, A[3] * k, A[4], A[5]);
    const eps = 0.6 / (ex * k);
    const tx0 = Math.max(0, Math.floor(x0 / ts)), tx1 = Math.min(lev.cols - 1, Math.floor(x1 / ts));
    const ty0 = Math.max(0, Math.floor(y0 / ts)), ty1 = Math.min(lev.rows - 1, Math.floor(y1 / ts));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${img.id}/${lv}/${tx}/${ty}`;
      const bmp = tiles.get(key);
      if (bmp) {
        tiles.delete(key); tiles.set(key, bmp); // LRU touch
        const ew = tx < lev.cols - 1 ? eps : 0, eh = ty < lev.rows - 1 ? eps : 0;
        ctx.drawImage(bmp, tx * T, ty * T, bmp.width + ew, bmp.height + eh);
      } else if (bmp === undefined && (lv === l || lv === L - 1)) requestTile(img, lv, tx, ty, key);
    }
  }
}

function drawOverlay(p) {
  const ctx = p.octx;
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, p.w, p.h);
  const img = byId(p.imgId);
  if (!img) {
    ctx.fillStyle = getComputedStyle(document.body).color; ctx.globalAlpha = 0.4;
    ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(images.length ? 'Choose an image for this panel' : 'Open or drop multiband images', p.w / 2, p.h / 2);
    if (!images.length) ctx.fillText('🔒 Processed on this computer — nothing is uploaded', p.w / 2, p.h / 2 + 24);
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
    return;
  }
  if (img.status !== 'ready') {
    ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(img.status === 'error' ? 'Error: ' + img.error : `Preparing ${Math.round(img.progress * 100)}% …`, p.w / 2, p.h / 2);
    ctx.textAlign = 'left';
    return;
  }
  const S = (q) => toScreen(p, q);
  for (const a of anns) drawAnn(ctx, a, S, a === selected);
  if (hover && hover.panel !== p) {
    const [x, y] = S([hover.x, hover.y]);
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 12); ctx.stroke();
  }
  if (manual) {
    manual.pairs.forEach((pr, i) => {
      if (p.imgId === refId) dot(ctx, S(pr.r), '#00c853', i + 1);
      if (p.imgId === manual.imgId) dot(ctx, S(apply(byId(manual.imgId).matrix, pr.t)), '#ff9100', i + 1);
    });
    if (manual.pendingRef && p.imgId === refId) dot(ctx, S(manual.pendingRef), '#00c853', manual.pairs.length + 1);
  }
}

function dot(ctx, [x, y], color, n) {
  ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke();
  ctx.font = 'bold 12px sans-serif'; ctx.fillText('A' + n, x + 8, y - 6);
}

function toScreen(p, [x, y]) { return [(x - view.cx) * view.s + p.w / 2, (y - view.cy) * view.s + p.h / 2]; }
function toRef(p, x, y) { return [(x - p.w / 2) / view.s + view.cx, (y - p.h / 2) / view.s + view.cy]; }

function drawAnn(ctx, a, S, sel) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = a.color;
  ctx.lineWidth = a.width || 3; ctx.lineCap = ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 3;
  const P = a.pts?.map(S);
  if (a.type === 'marker' || a.type === 'text') {
    const [x, y] = S([a.x, a.y]);
    if (a.type === 'marker') {
      ctx.beginPath(); ctx.arc(x, y, 13, 0, 7); ctx.fill();
      ctx.shadowBlur = 0; ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(a.n), x, y + 0.5);
      if ($('#showNotes').checked && a.note) label(ctx, a.note, x + 18, y, a.color);
    } else {
      ctx.font = `600 ${a.size || 18}px sans-serif`; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 0; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.strokeText(a.text, x, y); ctx.fillText(a.text, x, y);
    }
  } else if (a.type === 'rect') {
    ctx.strokeRect(P[0][0], P[0][1], P[1][0] - P[0][0], P[1][1] - P[0][1]);
  } else if (a.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2, Math.abs(P[1][0] - P[0][0]) / 2, Math.abs(P[1][1] - P[0][1]) / 2, 0, 0, 7);
    ctx.stroke();
  } else if (a.type === 'arrow') {
    const [[x1, y1], [x2, y2]] = P, ang = Math.atan2(y2 - y1, x2 - x1), hs = 8 + ctx.lineWidth * 2.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(ang) * hs * 0.6, y2 - Math.sin(ang) * hs * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hs * Math.cos(ang - 0.45), y2 - hs * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - hs * Math.cos(ang + 0.45), y2 - hs * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
  } else if (a.type === 'pen') {
    ctx.beginPath(); P.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  }
  ctx.restore();
  if (sel) {
    const b = bbox(a, S);
    ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1;
    ctx.strokeRect(b[0] - 4, b[1] - 4, b[2] - b[0] + 8, b[3] - b[1] + 8); ctx.restore();
  }
}

function label(ctx, text, x, y, color) {
  ctx.save(); ctx.shadowBlur = 0;
  ctx.font = '13px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const lines = text.split('\n').slice(0, 4), w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12, h = lines.length * 17 + 6;
  ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(x, y - h / 2, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y - h / 2, 3, h);
  ctx.fillStyle = '#fff'; lines.forEach((l, i) => ctx.fillText(l, x + 8, y - h / 2 + 11.5 + i * 17));
  ctx.restore();
}

function bbox(a, S) {
  if (a.type === 'marker') { const [x, y] = S([a.x, a.y]); return [x - 13, y - 13, x + 13, y + 13]; }
  if (a.type === 'text') {
    const [x, y] = S([a.x, a.y]), c = panels[0].octx;
    c.font = `600 ${a.size || 18}px sans-serif`;
    const w = c.measureText(a.text).width, s = a.size || 18;
    return [x, y - s / 2, x + w, y + s / 2];
  }
  const P = a.pts.map(S);
  return [Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])), Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1]))];
}

function hit(p, x, y) {
  const S = (q) => toScreen(p, q);
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i], tol = 7;
    if (a.type === 'marker' || a.type === 'text' || a.type === 'rect' || a.type === 'ellipse') {
      const b = bbox(a, S);
      if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) return a;
    } else {
      const P = a.pts.map(S);
      for (let j = 1; j < P.length; j++) if (segDist(x, y, P[j - 1], P[j]) < tol) return a;
    }
  }
  return null;
}

function segDist(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l)) : 0;
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
}

function frame() {
  if (dirtyImg) { dirtyImg = false; panels.forEach(drawImagePanel); dirtyOv = true; }
  if (dirtyOv) { dirtyOv = false; panels.forEach(drawOverlay); updateZoomLabel(); drawNav(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateZoomLabel() {
  const r = refImg();
  $('#zoomlbl').textContent = r?.meta && view.s ? `${(view.s * dpr() * 100).toFixed(view.s * dpr() < 0.1 ? 1 : 0)}%` : '';
}

// ---------------- navigator (reference image thumbnail + viewport box) ----------------
const nav = $('#nav'), navCtx = nav.getContext('2d'), navZoom = $('#navZoom');
const NAV_MAX = 256; // longest side of pyramid level used for the thumbnail

function navGeom() {
  const r = refImg();
  if (!r?.meta || r.status !== 'ready') return null;
  const W = nav.parentElement.clientWidth, k = Math.min(W / r.meta.width, 220 / r.meta.height);
  return { r, k, w: r.meta.width * k, h: r.meta.height * k };
}

function zoomRange() {
  const r = refImg(), p = panels[0];
  const fitS = Math.min(p.w / r.meta.width, p.h / r.meta.height);
  return [fitS * 0.25, 40 / dpr()];
}

function drawNav() {
  const g = navGeom();
  nav.hidden = navZoom.parentElement.hidden = !g;
  if (!g) return;
  const { r, k, w, h } = g;
  if (nav.width !== Math.round(w * dpr()) || nav.height !== Math.round(h * dpr())) {
    nav.style.height = h + 'px'; nav.width = Math.round(w * dpr()); nav.height = Math.round(h * dpr());
  }
  const ctx = navCtx;
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, w, h);
  const L = r.meta.levels;
  let lv = L.findIndex((l) => Math.max(l.w, l.h) <= NAV_MAX * dpr());
  if (lv < 0) lv = L.length - 1;
  const f = 2 ** lv * k;
  for (let ty = 0; ty < L[lv].rows; ty++) for (let tx = 0; tx < L[lv].cols; tx++) {
    const key = `${r.id}/${lv}/${tx}/${ty}`, bmp = tiles.get(key);
    if (bmp) { tiles.delete(key); tiles.set(key, bmp); ctx.drawImage(bmp, tx * T * f, ty * T * f, bmp.width * f, bmp.height * f); }
    else if (bmp === undefined) requestTile(r, lv, tx, ty, key);
  }
  const p = panels[0];
  if (!p?.w) return;
  const [x0, y0] = toRef(p, 0, 0), [x1, y1] = toRef(p, p.w, p.h);
  // viewport box, at least 8 px so it stays visible at deep zoom
  const bw = Math.max(8, (x1 - x0) * k), bh = Math.max(8, (y1 - y0) * k);
  const bx = (x0 + x1) / 2 * k - bw / 2, by = (y0 + y1) / 2 * k - bh / 2;
  ctx.fillStyle = 'rgba(0,0,0,.35)';  // dim outside the viewport
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.rect(bx, by, bw, bh); ctx.fill('evenodd');
  ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, bw, bh);
  const [a, b] = zoomRange();
  navZoom.value = Math.round(1000 * Math.log(view.s / a) / Math.log(b / a));
}

function navMove(e) {
  const g = navGeom(); if (!g) return;
  const rc = nav.getBoundingClientRect();
  view.cx = Math.max(0, Math.min(g.r.meta.width, (e.clientX - rc.left) / g.k));
  view.cy = Math.max(0, Math.min(g.r.meta.height, (e.clientY - rc.top) / g.k));
  dirtyImg = true;
}
nav.addEventListener('pointerdown', (e) => { nav.setPointerCapture(e.pointerId); navMove(e); });
nav.addEventListener('pointermove', (e) => { if (e.buttons & 1) navMove(e); });
nav.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = panels[0]; if (!p || !navGeom()) return;
  zoomAt(p, p.w / 2, p.h / 2, Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0025));
}, { passive: false });
navZoom.addEventListener('input', () => {
  const p = panels[0]; if (!p || !navGeom()) return;
  const [a, b] = zoomRange();
  zoomAt(p, p.w / 2, p.h / 2, a * (b / a) ** (navZoom.value / 1000) / view.s);
});
$('#navOut').onclick = () => { const p = panels[0]; if (p) zoomAt(p, p.w / 2, p.h / 2, 1 / 1.5); };
$('#navIn').onclick = () => { const p = panels[0]; if (p) zoomAt(p, p.w / 2, p.h / 2, 1.5); };

// ---------------- RGB readout: value under the cursor, for every panel at the same spot ----------------
let rgbOn = false;
function toggleRgb() {
  rgbOn = !rgbOn;
  $('#rgbBtn').classList.toggle('on', rgbOn);
  panels.forEach((p) => { p.rgbEl.hidden = !rgbOn; p.rgbEl.textContent = 'R — G — B —'; });
}
function queryPixel(img, x, y) {
  if (img.pxBusy) { img.pxNext = [x, y]; return; } // only latest position matters
  img.pxBusy = true;
  img.worker.postMessage({ type: 'pixel', x, y });
}
function probeRgb(r) {
  for (const img of new Set(panels.map((p) => byId(p.imgId)).filter((i) => i?.status === 'ready'))) {
    const [x, y] = apply(invert(img.matrix), r);
    queryPixel(img, x, y);
  }
}
const pad3 = (v) => String(v).padStart(3, '\u2007');
function showRgb() {
  if (!rgbOn) return;
  for (const p of panels) {
    const c = byId(p.imgId)?.rgb;
    p.rgbEl.textContent = c ? `R ${pad3(c[0])}  G ${pad3(c[1])}  B ${pad3(c[2])}` : 'R — G — B —';
  }
}
$('#rgbBtn').onclick = toggleRgb;

// ---------------- interaction ----------------
function zoomAt(p, x, y, f) {
  const [rx, ry] = toRef(p, x, y);
  const r = refImg();
  const min = r?.meta ? Math.min(p.w / r.meta.width, p.h / r.meta.height) * 0.25 : 1e-4;
  view.s = Math.max(min, Math.min(40 / dpr(), view.s * f));
  view.cx = rx - (x - p.w / 2) / view.s; view.cy = ry - (y - p.h / 2) / view.s;
  dirtyImg = true;
}

function pushHistory() { history.push(JSON.stringify(anns)); if (history.length > 200) history.shift(); }

function bindPointer(p) {
  const c = p.oc;
  let drag = null;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = pos(e);
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(p, x, y, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0025)));
  }, { passive: false });

  c.addEventListener('pointerdown', (e) => {
    if (!byId(p.imgId) || byId(p.imgId).status !== 'ready') return;
    e.preventDefault(); // keep focus on floating text input
    document.querySelector('.floatInput')?.blur(); // commit a pending text note
    c.setPointerCapture(e.pointerId);
    const [x, y] = pos(e), r = toRef(p, x, y);
    const panMode = e.button === 1 || e.button === 2 || spaceDown;
    if (manual && !panMode) { manualClick(p, r); return; }
    if (tool === 'pan' && !panMode) setActive(p.imgId);
    if (tool === 'pan' || panMode) {
      const h = panMode ? null : hit(p, x, y);
      if (h) {
        selected = h; pushHistory(); drag = { move: h, last: r }; renderNotes();
      } else { selected = null; drag = { pan: true, x, y }; renderNotes(); }
      dirtyOv = true; return;
    }
    const base = { id: nextId++, color: $('#color').value, width: +$('#width').value };
    if (tool === 'marker') {
      pushHistory();
      const n = Math.max(0, ...anns.filter((a) => a.type === 'marker').map((a) => a.n)) + 1;
      const a = { ...base, type: 'marker', x: r[0], y: r[1], n, note: '' };
      anns.push(a); selected = a; renderNotes(true); dirtyOv = true; return;
    }
    if (tool === 'text') { textInput(p, x, y, r); return; }
    pushHistory();
    const a = { ...base, type: tool, pts: tool === 'pen' ? [r] : [r, r] };
    anns.push(a); selected = a; drag = { draw: a }; dirtyOv = true;
  });

  c.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e), r = toRef(p, x, y);
    hover = { panel: p, x: r[0], y: r[1] }; dirtyOv = true; if (cmpMode === 'swipe') dirtyImg = true;
    if (rgbOn) probeRgb(r);
    if (!drag) return;
    if (drag.pan) {
      view.cx -= (x - drag.x) / view.s; view.cy -= (y - drag.y) / view.s;
      drag.x = x; drag.y = y; dirtyImg = true;
    } else if (drag.move) {
      const dx = r[0] - drag.last[0], dy = r[1] - drag.last[1], a = drag.move;
      if (a.pts) a.pts = a.pts.map(([px, py]) => [px + dx, py + dy]); else { a.x += dx; a.y += dy; }
      drag.last = r;
    } else if (drag.draw) {
      const a = drag.draw;
      if (a.type === 'pen') {
        const last = toScreen(p, a.pts[a.pts.length - 1]);
        if (Math.hypot(last[0] - x, last[1] - y) > 2) a.pts.push(r);
      } else {
        let q = r;
        if (e.shiftKey && (a.type === 'rect' || a.type === 'ellipse')) {
          const dx = r[0] - a.pts[0][0], dy = r[1] - a.pts[0][1], m = Math.max(Math.abs(dx), Math.abs(dy));
          q = [a.pts[0][0] + Math.sign(dx) * m, a.pts[0][1] + Math.sign(dy) * m];
        }
        a.pts[1] = q;
      }
    }
  });

  const end = () => {
    if (drag?.draw) {
      const a = drag.draw, b = bbox(a, (q) => toScreen(p, q));
      if (b[2] - b[0] < 3 && b[3] - b[1] < 3) { anns.pop(); history.pop(); selected = null; }
    }
    if (drag?.move) { const h = history[history.length - 1]; if (h === JSON.stringify(anns)) history.pop(); }
    drag = null; dirtyOv = true;
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', () => { hover = null; dirtyOv = true; if (cmpMode === 'swipe') dirtyImg = true; });
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('dblclick', (e) => {
    const [x, y] = pos(e), h = hit(p, x, y);
    if (h?.type === 'text') {
      const [sx, sy] = toScreen(p, [h.x, h.y]);
      textInput(p, sx, sy, [h.x, h.y], h);
    } else if (h?.type === 'marker') { selected = h; renderNotes(true); }
  });

  // drop files onto a panel
  p.el.addEventListener('dragover', (e) => { e.preventDefault(); p.el.classList.add('drop'); });
  p.el.addEventListener('dragleave', () => p.el.classList.remove('drop'));
}

function textInput(p, x, y, r, existing) {
  const inp = document.createElement('input');
  inp.className = 'floatInput';
  inp.style.left = x + 'px'; inp.style.top = (y - 14) + 'px';
  inp.value = existing?.text || '';
  inp.placeholder = 'Type note, Enter to place';
  p.el.appendChild(inp); inp.focus();
  let done = false;
  const commit = (ok) => {
    if (done) return; done = true;
    const v = inp.value.trim(); inp.remove();
    if (!ok) return;
    pushHistory();
    if (existing) { if (v) existing.text = v; else anns.splice(anns.indexOf(existing), 1); }
    else if (v) anns.push({ id: nextId++, type: 'text', x: r[0], y: r[1], text: v, color: $('#color').value, size: 12 + 3 * +$('#width').value });
    else history.pop();
    renderNotes(); dirtyOv = true;
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); };
  inp.onblur = () => commit(true);
}

function manualClick(p, r) {
  if (p.imgId === refId) { manual.pendingRef = r; }
  else if (p.imgId === manual.imgId && manual.pendingRef) {
    manual.pairs.push({ r: manual.pendingRef, t: apply(invert(byId(manual.imgId).matrix), r) });
    manual.pendingRef = null;
  }
  updateManualMsg(); dirtyOv = true;
}

function startManual(img) {
  manual = { imgId: img.id, pairs: [], pendingRef: null };
  const vis = new Set(panels.map((p) => p.imgId));
  if (!vis.has(refId) || !vis.has(img.id)) {
    if (panels.length < 2) { layout = '2x1'; $('#layout').value = '2x1'; syncPanels(); }
    panels[0].imgId = refId; panels[1].imgId = img.id; syncPanels();
  }
  $('#manualBox').hidden = false; updateManualMsg(); dirtyImg = dirtyOv = true;
}

function updateManualMsg() {
  if (!manual) return;
  const t = byId(manual.imgId), r = refImg();
  $('#manualMsg').innerHTML = `Aligning <b>${esc(t.name)}</b> to <b>${esc(r.name)}</b>.<br>` +
    (manual.pendingRef ? `Now click the same spot in <b>${esc(t.name)}</b>.` : `Click a sharp feature in <b>${esc(r.name)}</b> (green).`) +
    `<br>${manual.pairs.length} pair(s) — need at least 2, spread far apart. Right-drag to pan.`;
  $('#manualApply').disabled = manual.pairs.length < 2;
}

// ---------------- sidebar ----------------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB'; }

let listTimer = 0;
function renderListThrottled() {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = 0; renderList(); }, 250);
  dirtyOv = true;
}

function renderList() {
  $('#dropHint').hidden = images.length > 0;
  $('#closeAllRow').hidden = images.length === 0;
  const ab = $('#alignAll');
  ab.textContent = images.some((i) => i.aligning) ? 'Aligning…' : 'Auto-align all';
  ab.disabled = $('#fullAll').disabled = images.filter((i) => i.status === 'ready').length < 2;
  $('#revertAll').disabled = !images.some((i) => i.alignHist?.length && !i.aligning);
  const missing = pendingProject.entries.map((e) => `<li class="muted">Missing: <b>${esc(e.name)}</b> — open this file to restore it.</li>`).join('');
  queueMicrotask(markActive);
  $('#images').innerHTML = images.map((img) => {
    const m = img.meta;
    const st = img.status === 'error' ? `<span class="warn">${esc(img.error)}</span>`
      : img.status !== 'ready' && !img.slot ? 'Waiting to import…'
      : img.status !== 'ready' ? `Preparing… ${Math.round(img.progress * 100)}%<div class="bar"><i style="width:${img.progress * 100}%"></i></div>`
        : img.id === refId ? 'Reference'
          : img.aligning ? (img.aligning === 'quick' ? 'Aligning…' : img.aligning === 'waiting' ? 'Waiting for other bands…' : `${img.aligning === 'full' ? 'Full aligning' : 'Aligning ' + esc(img.aligning)}… ${Math.round((img.alignProgress || 0) * 100)}%`)
            : img.alignFailed ? '<span class="warn">Align failed — kept previous. Try Full or Manual</span>'
              : img.err != null ? `<span title="Checked by matching many small patches across the painting. Typical patch disagreement: ${img.err.toFixed(1)} px at full resolution.">Aligned${img.via ? ` via ${esc(img.via)}` : ''} · verified ✓</span>${img.err > 6 ? ' <span class="warn">loose — check with Compare</span>' : ''}`
              : img.full ? '<span class="warn">Full aligned, not verified — check with Compare</span>'
              : img.score != null ? `<span class="warn">Aligned, not verified (match ${(img.score * 100).toFixed(0)}%) — try Full or Manual</span>`
                : img.aligned ? 'Aligned (manual)' : 'Not aligned';
    return `<li data-id="${img.id}" class="${img.id === refId ? 'ref' : ''} ${img.id === activeId ? 'active' : ''}">
      <div class="name">${esc(img.name)}</div>
      <div class="meta">${m ? `${m.width} × ${m.height}px · ${m.bits}-bit` : ''}</div>
      <div class="meta">${st}</div>
      ${img.status === 'ready' ? `<div class="adj">
        <span>Brightness</span><input type="range" min="20" max="300" value="${img.adj.b}" data-k="b">
        <span>Contrast</span><input type="range" min="20" max="400" value="${img.adj.c}" data-k="c">
        <span>Invert</span><input type="checkbox" ${img.adj.inv ? 'checked' : ''} data-k="inv">
      </div>
      <div class="acts">
        ${img.id !== refId ? `<button data-a="ref">Set reference</button><button data-a="auto">Auto-align</button><button data-a="full" title="Slower, robust: for low-detail or very different bands">Full align</button><button data-a="manual">Manual align</button><button data-a="undo" ${img.alignHist?.length ? '' : 'disabled'} title="Restore the previous alignment">↶ Undo align</button>` : ''}
        <button data-a="resetadj">Reset tone</button><button data-a="close">Close</button>
      </div>` : '<div class="acts"><button data-a="close">Cancel</button></div>'}
    </li>`;
  }).join('') + missing;
}

$('#images').addEventListener('input', (e) => {
  const li = e.target.closest('li'), img = li && byId(+li.dataset.id), k = e.target.dataset.k;
  if (!img || !k) return;
  img.adj[k] = k === 'inv' ? e.target.checked : +e.target.value;
  panels.forEach(applyFilter);
});
$('#images').addEventListener('click', (e) => {
  const a = e.target.dataset.a; if (!a) return;
  const img = byId(+e.target.closest('li').dataset.id);
  if (a === 'ref') setReference(img);
  if (a === 'auto') autoAlign(img);
  if (a === 'full') autoAlign(img, true);
  if (a === 'undo') undoAlign(img);
  if (a === 'manual') startManual(img);
  if (a === 'resetadj') { img.adj = { b: 100, c: 100, inv: false }; panels.forEach(applyFilter); renderList(); }
  if (a === 'close') closeImage(img);
});

// Highlight the clicked image's panel(s) and its sidebar card, and scroll the card into view.
function setActive(id) {
  if (id == null || id === activeId) return;
  activeId = id;
  markActive();
  const li = document.querySelector(`#images li[data-id="${id}"]`);
  if (li) { li.style.scrollMarginTop = $('#navBox').offsetHeight + 8 + 'px'; li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
function markActive() {
  document.querySelectorAll('#images li').forEach((li) => li.classList.toggle('active', +li.dataset.id === activeId));
}

function renderNotes(focus) {
  const ms = anns.filter((a) => a.type === 'marker').sort((a, b) => a.n - b.n);
  $('#notes').innerHTML = ms.map((m) => `<li data-id="${m.id}" class="${m === selected ? 'sel' : ''}">
    <span class="num" style="background:${m.color}" title="Go to point">${m.n}</span>
    <textarea rows="1" placeholder="Note for point ${m.n}">${esc(m.note)}</textarea></li>`).join('')
    || '<li class="muted" style="display:block">Use ① Point to place numbered points.</li>';
  if (focus && selected?.type === 'marker') $(`#notes li[data-id="${selected.id}"] textarea`)?.focus();
}
$('#notes').addEventListener('input', (e) => {
  const a = anns.find((x) => x.id === +e.target.closest('li').dataset.id);
  if (a) { a.note = e.target.value; dirtyOv = true; }
});
$('#notes').addEventListener('focusin', (e) => {
  if (e.target.tagName !== 'TEXTAREA') return;
  pushHistory(); // ponytail: one undo step per focus, not per keystroke
});
$('#notes').addEventListener('click', (e) => {
  if (!e.target.classList.contains('num')) return;
  const a = anns.find((x) => x.id === +e.target.closest('li').dataset.id);
  if (a) { view.cx = a.x; view.cy = a.y; selected = a; dirtyImg = true; renderNotes(); }
});
$('#renumber').onclick = () => {
  pushHistory();
  anns.filter((a) => a.type === 'marker').sort((a, b) => a.n - b.n).forEach((a, i) => { a.n = i + 1; });
  renderNotes(); dirtyOv = true;
};
$('#showNotes').onchange = () => { dirtyOv = true; };

async function renderLibrary() {
  let dir;
  try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mbv-cache', { create: true }); } catch { $('#library').innerHTML = '<li class="muted">Disk cache unavailable — using RAM.</li>'; return; }
  const items = [];
  for await (const [key, h] of dir.entries()) {
    if (h.kind !== 'directory') continue;
    let meta = null, size = 0;
    try { meta = JSON.parse(await (await (await h.getFileHandle('meta.json')).getFile()).text()); } catch { /* incomplete import */ }
    try { size = (await (await h.getFileHandle('tiles.bin')).getFile()).size; } catch { /* none */ }
    // unfinished import that isn't running: useless, delete it
    if (!meta && !images.some((i) => i.key === key)) { await dir.removeEntry(key, { recursive: true }).catch(() => {}); continue; }
    items.push({ key, meta, size });
  }
  items.sort((a, b) => (b.meta?.date || 0) - (a.meta?.date || 0));
  const open = new Set(images.map((i) => i.key));
  const LIB_SHOW = 6, hidden = libAll ? 0 : Math.max(0, items.length - LIB_SHOW);
  $('#library').innerHTML = items.slice(0, items.length - hidden).map((it) => `<li data-key="${it.key}">
    <span title="${esc(it.meta?.name || 'incomplete')}">${esc(it.meta?.name || '(incomplete)')} · ${fmtBytes(it.size)}</span>
    ${open.has(it.key) ? '<i class="muted">open</i>' : `${it.meta ? '<button data-a="open">Open</button>' : ''}<button data-a="del">✕</button>`}
  </li>`).join('') + (items.length > LIB_SHOW
    ? `<li><button data-a="more" class="linkish">${libAll ? 'Show fewer' : `Show all (${hidden} more)`}</button></li>` : '')
    || '<li class="muted">Empty</li>';
  const total = items.reduce((s, i) => s + i.size, 0);
  const est = await navigator.storage.estimate?.().catch(() => null);
  $('#libSize').textContent = `${fmtBytes(total)} used` + (est?.quota ? ` of ${fmtBytes(est.quota)}` : '');
}
let libAll = false;
$('#library').addEventListener('click', async (e) => {
  const a = e.target.dataset.a; if (!a) return;
  if (a === 'more') { libAll = !libAll; renderLibrary(); return; }
  const key = e.target.closest('li').dataset.key;
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mbv-cache');
  if (a === 'del') { await dir.removeEntry(key, { recursive: true }).catch(() => {}); renderLibrary(); }
  if (a === 'open' && !images.some((i) => i.key === key)) {
    const meta = JSON.parse(await (await (await (await dir.getDirectoryHandle(key)).getFileHandle('meta.json')).getFile()).text());
    addImage({ key, name: meta.name, saved: pendingProject.entries.find((x) => x.key === key) });
  }
});
$('#libClear').onclick = async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mbv-cache');
  const open = new Set(images.map((i) => i.key));
  for await (const [key] of dir.entries()) if (!open.has(key)) await dir.removeEntry(key, { recursive: true }).catch(() => {});
  renderLibrary();
};

// ---------------- toolbar ----------------
function setTool(t) {
  tool = t;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  panels.forEach((p) => { p.oc.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; });
}
$('#tools').onclick = (e) => { const t = e.target.closest('button')?.dataset.tool; if (t) setTool(t); };
$('#file').onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
$('#layout').onchange = (e) => { layout = e.target.value; syncPanels(); };
$('#fit').onclick = fit;
$('#one').onclick = () => { view.s = 1 / dpr(); dirtyImg = true; };
$('#undo').onclick = undo;
$('#delete').onclick = delSelected;
$('#closeAll').onclick = () => { [...images].forEach(closeImage); activeId = null; };
$('#alignAll').onclick = () => images.forEach((i) => { if (i.id !== refId && i.status === 'ready') autoAlign(i); });
$('#fullAll').onclick = () => images.forEach((i) => { if (i.id !== refId && i.status === 'ready') autoAlign(i, true); });
$('#revertAll').onclick = () => images.forEach((i) => { if (!i.aligning) undoAlign(i); });
$('#manualApply').onclick = () => {
  const img = byId(manual.imgId);
  pushAlign(img);
  img.matrix = similarityFrom(manual.pairs); img.score = null; img.alignFailed = false; img.aligned = true; img.full = false; img.err = null; img.via = null;
  manual = null; $('#manualBox').hidden = true; dirtyImg = true; renderList();
};
$('#manualCancel').onclick = () => { manual = null; $('#manualBox').hidden = true; dirtyOv = true; };
$('#color').oninput = (e) => { if (selected) { selected.color = e.target.value; dirtyOv = true; renderNotes(); } };
$('#width').onchange = (e) => { if (selected?.width) { selected.width = +e.target.value; dirtyOv = true; } };
$('#present').onclick = present;
if (window.__TAURI_INTERNALS__) document.querySelectorAll('.webOnly').forEach((e) => e.remove());
$('#privacyBtn').onclick = (e) => { e.preventDefault(); $('#privacy').showModal(); };
$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mbv-theme', next); } catch { /* private mode */ }
  dirtyOv = true;
};
try { const t = localStorage.getItem('mbv-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }

function present() {
  const on = document.body.classList.toggle('present');
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('present'); });

function undo() {
  if (!history.length) return;
  anns = JSON.parse(history.pop()); selected = null; renderNotes(); dirtyOv = true;
}
function delSelected() {
  if (!selected) return;
  pushHistory(); anns = anns.filter((a) => a !== selected); selected = null; renderNotes(); dirtyOv = true;
}

let spaceDown = false;
window.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, select, input:not([type=checkbox]):not([type=range]):not([type=color])')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (mod) return;
  const p = panels[0];
  const k = e.key.toLowerCase();
  if (k === ' ') { spaceDown = true; e.preventDefault(); }
  else if (k === 'delete' || k === 'backspace') delSelected();
  else if (k === 'escape') { selected = null; if (manual) $('#manualCancel').click(); if (document.body.classList.contains('present')) present(); dirtyOv = true; }
  else if (k === '+' || k === '=') zoomAt(p, p.w / 2, p.h / 2, 1.4);
  else if (k === '-') zoomAt(p, p.w / 2, p.h / 2, 1 / 1.4);
  else if (k === '0') fit();
  else if (k === '1') $('#one').click();
  else if (k === 'f') present();
  else if (k.startsWith('arrow')) {
    const d = 80 / view.s;
    if (k === 'arrowleft') view.cx -= d; if (k === 'arrowright') view.cx += d;
    if (k === 'arrowup') view.cy -= d; if (k === 'arrowdown') view.cy += d;
    dirtyImg = true; e.preventDefault();
  } else {
    if (k === 'i') { toggleRgb(); return; }
    if (k === 'c') { setCompare({ '': 'swipe', swipe: 'flicker', flicker: 'diff', diff: '' }[cmpMode]); return; }
    const t = { v: 'pan', n: 'marker', t: 'text', a: 'arrow', r: 'rect', e: 'ellipse', p: 'pen' }[k];
    if (t) setTool(t);
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

// drag & drop anywhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.querySelectorAll('.panel.drop').forEach((x) => x.classList.remove('drop'));
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});

// ---------------- save / load / export ----------------
async function saveBlob(blob, name) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close(); return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function saveProject() {
  const ref = refImg();
  const proj = {
    app: 'multiband-viewer', version: 1,
    images: images.filter((i) => i.meta).map((i) => ({ key: i.key, name: i.name, matrix: i.matrix, adj: i.adj, score: i.score, err: i.err, via: i.via, ref: i.id === refId })),
    layout, panels: panels.map((p) => images.findIndex((i) => i.id === p.imgId)),
    view, annotations: anns, showNotes: $('#showNotes').checked,
  };
  saveBlob(new Blob([JSON.stringify(proj, null, 1)], { type: 'application/json' }), (ref?.name.replace(/\.\w+$/, '') || 'project') + '.mbv.json');
}

async function loadProject(file) {
  const proj = JSON.parse(await file.text());
  if (proj.app !== 'multiband-viewer') throw new Error('Not a Multiband Viewer project');
  [...images].forEach(closeImage);
  refId = null; anns = proj.annotations || []; history.length = 0; selected = null;
  nextId = Math.max(1, ...anns.map((a) => a.id + 1));
  layout = proj.layout || 'auto'; $('#layout').value = layout;
  $('#showNotes').checked = !!proj.showNotes;
  Object.assign(view, proj.view);
  // reference first so its id is the ref
  const list = [...proj.images].sort((a, b) => (b.ref ? 1 : 0) - (a.ref ? 1 : 0));
  pendingProject.entries = list.slice();
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('mbv-cache', { create: true }).catch(() => null);
  for (const e of list) {
    let cached = false;
    try { await (await dir.getDirectoryHandle(e.key)).getFileHandle('meta.json'); cached = true; } catch { /* not cached */ }
    if (cached) addImage({ key: e.key, name: e.name, saved: e });
  }
  const panelImgs = proj.panels || [];
  syncPanels();
  panels.forEach((p, i) => { const k = proj.images[panelImgs[i]]?.key; const im = images.find((x) => x.key === k); if (im) p.imgId = im.id; });
  syncPanels(); renderList(); renderNotes();
}
$('#save').onclick = saveProject;
$('#load').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) loadProject(f).catch((err) => alert(err.message));
};

$('#export').onclick = () => {
  const g = $('#grid').getBoundingClientRect(), k = dpr();
  const out = new OffscreenCanvas(Math.round(g.width * k), Math.round(g.height * k));
  const ctx = out.getContext('2d');
  ctx.fillStyle = getComputedStyle($('#grid')).backgroundColor; ctx.fillRect(0, 0, out.width, out.height);
  for (const p of panels) {
    const r = p.el.getBoundingClientRect(), x = (r.left - g.left) * k, y = (r.top - g.top) * k;
    ctx.fillStyle = getComputedStyle(p.el).backgroundColor; ctx.fillRect(x, y, p.ic.width, p.ic.height);
    ctx.filter = p.ic.style.filter || 'none';
    ctx.drawImage(p.ic, x, y); ctx.filter = 'none';
    ctx.drawImage(p.oc, x, y);
    const img = byId(p.imgId);
    if (img && panels.length > 1) {
      ctx.font = `${12 * k}px sans-serif`;
      const w = ctx.measureText(img.name).width;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 6 * k, y + 6 * k, w + 12 * k, 20 * k);
      ctx.fillStyle = '#fff'; ctx.fillText(img.name, x + 12 * k, y + 20 * k);
    }
  }
  out.convertToBlob({ type: 'image/png' }).then((b) => saveBlob(b, 'multiband-view.png'));
};

// ---------------- boot ----------------
syncPanels(); renderList(); renderNotes(); renderLibrary(); setTool('pan');
navigator.storage?.persist?.().catch(() => {});
if (import.meta.env.DEV) window.mbv = { images, view, panels, get anns() { return anns; } };
