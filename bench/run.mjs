// Registration benchmark. Runs src/register.js on real band pairs and measures the error at FULL resolution.
// Usage: [EVAL=x,y,w,h] node bench/run.mjs [dir] [--full] [--only NAME] [--ref NAME]
// Error metric: after warping the target with the result, a grid of 256 px full-res patches is block-matched
// (NCC of gradient magnitude, +-24 px, sub-pixel) against the reference. The local shift of each confident patch
// is its residual error. Independent of the registration's own score. Also runs a synthetic pair with a known warp.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

sharp.cache(false);
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || 'Demo-P1';
const FULL = args.includes('--full');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const OVERVIEW = 2048;

// load register.js as if it were a worker
let reply;
globalThis.self = { postMessage: (m) => { if (!('progress' in m)) reply = m; } };
await import('../src/register.js');
const register = (ref, tgt, full) => { reply = null; self.onmessage({ data: { id: 1, ref, tgt, full} }); return reply; };

async function load(file) {
  const { data, info } = await sharp(file, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * data[i * c] + 0.587 * data[i * c + (c > 1 ? 1 : 0)] + 0.114 * data[i * c + (c > 2 ? 2 : 0)];
  return { w, h, d: g };
}

// same as the app: 2x2 box halving (ceil) until longest side <= OVERVIEW, as RGBA (gray)
function overview(img) {
  let { w, h, d } = img, k = 0;
  while (Math.max(w, h) > OVERVIEW) {
    const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), o = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const x1 = Math.min(w - 1, 2 * x + 1), y1 = Math.min(h - 1, 2 * y + 1);
      o[y * w2 + x] = (d[2 * y * w + 2 * x] + d[2 * y * w + x1] + d[y1 * w + 2 * x] + d[y1 * w + x1]) / 4;
    }
    w = w2; h = h2; d = o; k++;
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = d[i]; data[i * 4 + 3] = 255; }
  return { width: w, height: h, scale: 1 / 2 ** k, data };
}

function gradMag({ w, h, d }) {
  const o = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = d[i + 1] - d[i - 1], gy = d[i + w] - d[i - w];
    o[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return { w, h, d: o };
}

const inv = ([a, b, c, d, e, f]) => { const t = a * d - b * c; return [d / t, -b / t, -c / t, a / t, (c * f - d * e) / t, (b * e - a * f) / t]; };

// Residual field: for each patch centre in ref, local shift between ref and warped target.
// Evaluated only inside `box` (full-res [x, y, w, h], the painting): background error doesn't matter to the user.
function residuals(R, F, matrix, box, P = 256, S = 24, grid = [9, 7]) {
  const m = inv(matrix); // ref full -> target full
  const out = [];
  for (let gy = 0; gy < grid[1]; gy++) for (let gx = 0; gx < grid[0]; gx++) {
    const cx = Math.round(box[0] + (gx + 0.5) * box[2] / grid[0]), cy = Math.round(box[1] + (gy + 0.5) * box[3] / grid[1]);
    const x0 = cx - P / 2 - S, y0 = cy - P / 2 - S, N = P + 2 * S;
    if (x0 < 1 || y0 < 1 || x0 + N >= R.w - 1 || y0 + N >= R.h - 1) continue;
    // warped target over the search window
    const W = new Float32Array(N * N);
    let ok = true;
    for (let y = 0; y < N && ok; y++) for (let x = 0; x < N; x++) {
      const u = x0 + x, v = y0 + y, X = m[0] * u + m[2] * v + m[4], Y = m[1] * u + m[3] * v + m[5];
      if (X < 0 || Y < 0 || X >= F.w - 1 || Y >= F.h - 1) { ok = false; break; }
      const xi = Math.floor(X), yi = Math.floor(Y), fx = X - xi, fy = Y - yi, i = yi * F.w + xi;
      W[y * N + x] = (F.d[i] * (1 - fx) + F.d[i + 1] * fx) * (1 - fy) + (F.d[i + F.w] * (1 - fx) + F.d[i + F.w + 1] * fx) * fy;
    }
    if (!ok) continue;
    // ref patch stats
    let s1 = 0, s11 = 0;
    const k = (P / 2) ** 2; // every 2nd pixel
    for (let y = 0; y < P; y += 2) for (let x = 0; x < P; x += 2) { const a = R.d[(y0 + S + y) * R.w + x0 + S + x]; s1 += a; s11 += a * a; }
    if (s11 - s1 * s1 / k <= 1e-6 * k) continue;
    const C = new Float32Array((2 * S + 1) ** 2);
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      let sw = 0, sww = 0, srw = 0;
      for (let y = 0; y < P; y += 2) {
        const ro = (y0 + S + y) * R.w + x0 + S, wo = (S + y + dy) * N + S + dx;
        for (let x = 0; x < P; x += 2) { const a = R.d[ro + x], b = W[wo + x]; sw += b; sww += b * b; srw += a * b; }
      }
      const cov = srw - s1 * sw / k, v = Math.sqrt((s11 - s1 * s1 / k) * (sww - sw * sw / k));
      C[(dy + S) * (2 * S + 1) + dx + S] = v > 0 ? cov / v : -1;
    }
    let bi = 0;
    for (let i = 1; i < C.length; i++) if (C[i] > C[bi]) bi = i;
    const L = 2 * S + 1, bx = bi % L, by = Math.floor(bi / L);
    if (bx === 0 || by === 0 || bx === L - 1 || by === L - 1) continue; // peak on border: no reliable match
    const peak = C[bi];
    // second best outside +-3 px: distinctiveness
    let second = -1;
    for (let i = 0; i < C.length; i++) { const x = i % L, y = Math.floor(i / L); if (Math.abs(x - bx) > 3 || Math.abs(y - by) > 3) second = Math.max(second, C[i]); }
    if (peak < 0.25 || peak - second < 0.05) continue;
    const sub = (a, b, c) => { const d = a - 2 * b + c; return d < 0 ? 0.5 * (a - c) / d : 0; };
    const sx = bx - S + sub(C[bi - 1], C[bi], C[bi + 1]), sy = by - S + sub(C[bi - L], C[bi], C[bi + L]);
    out.push({ x: cx, y: cy, dx: sx, dy: sy, c: peak });
  }
  return out;
}

const pct = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function report(name, res, rs, ms) {
  const e = rs.map((r) => Math.hypot(r.dx, r.dy));
  const mx = rs.reduce((s, r) => s + r.dx, 0) / rs.length, my = rs.reduce((s, r) => s + r.dy, 0) / rs.length;
  const line = `${name.padEnd(16)} score ${res.score == null ? ' n/a' : res.score.toFixed(2)}  self-err ${res.err == null ? 'none' : (res.err / refOv.scale).toFixed(2)}  patches ${String(rs.length).padStart(2)}  ` +
    `median ${pct(e, 0.5).toFixed(2)} px  p95 ${pct(e, 0.95).toFixed(2)} px  max ${Math.max(...e).toFixed(2)}  mean-shift (${mx.toFixed(2)}, ${my.toFixed(2)})  ${ms} ms`;
  console.log(line);
  return { name, median: pct(e, 0.5), p95: pct(e, 0.95), n: rs.length, field: rs, matrix: res.matrix };
}

const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|tiff?|png)$/i.test(f)).sort();
const refArg = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : null;
const refName = refArg ? files.find((f) => f.endsWith(refArg)) : files.find((f) => /\bvis(ible)?\b/i.test(f) && !/vist|ir|uv/i.test(f.replace(/vis/i, ''))) || files[0];
console.log(`reference: ${refName}  mode: ${FULL ? 'full' : 'quick'}`);
const ref = await load(path.join(dir, refName)), refOv = overview(ref), refG = gradMag(ref);
// error is measured on the painting only: EVAL=x,y,w,h (overview px), default whole frame
const box = process.env.EVAL ? process.env.EVAL.split(',').map((v) => v / refOv.scale) : [0, 0, ref.w, ref.h];
const results = [];

// synthetic: reference warped by a known similarity -> exact error of the matrix itself
{
  const th = 0.35 * Math.PI / 180, s = 1.007, a = s * Math.cos(th), b = s * Math.sin(th);
  const T = [a, b, -b, a, 23.4, -17.8]; // target px -> ref px (ground truth)
  const Ti = inv(T), syn = { w: ref.w, h: ref.h, d: new Float32Array(ref.w * ref.h) };
  for (let y = 0; y < ref.h; y++) for (let x = 0; x < ref.w; x++) {
    const X = T[0] * x + T[2] * y + T[4], Y = T[1] * x + T[3] * y + T[5];
    if (X < 0 || Y < 0 || X >= ref.w - 1 || Y >= ref.h - 1) continue;
    const xi = Math.floor(X), yi = Math.floor(Y), fx = X - xi, fy = Y - yi, i = yi * ref.w + xi;
    syn.d[y * ref.w + x] = (ref.d[i] * (1 - fx) + ref.d[i + 1] * fx) * (1 - fy) + (ref.d[i + ref.w] * (1 - fx) + ref.d[i + ref.w + 1] * fx) * fy;
  }
  const t0 = Date.now(), res = register(refOv, overview(syn), FULL), ms = Date.now() - t0;
  let worst = 0;
  for (const [x, y] of [[0, 0], [ref.w, 0], [0, ref.h], [ref.w, ref.h], [ref.w / 2, ref.h / 2]]) {
    const m = res.matrix, p = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]], q = [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
    worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  console.log(`${'SYNTHETIC'.padEnd(16)} score ${res.score?.toFixed(2)}  true max corner error ${worst.toFixed(2)} px  ${ms} ms`);
  results.push({ name: 'SYNTHETIC', trueMax: worst });
}

// --via NAME: register target -> NAME (full) and chain with NAME -> reference, as the app does for unverified bands
const viaArg = args.includes('--via') ? args[args.indexOf('--via') + 1] : null;
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
let viaOv = null, viaM = null;
if (viaArg) {
  viaOv = overview(await load(path.join(dir, files.find((f) => f.endsWith(viaArg)))));
  const r = register(refOv, viaOv, FULL); viaM = r.matrix;
  console.log(`via ${viaArg}: self-err ${(r.err / refOv.scale).toFixed(2)}`);
}
for (const f of files) {
  if (f === refName || (only && !f.includes(only))) continue;
  const tgt = await load(path.join(dir, f));
  const t0 = Date.now();
  let res = register(refOv, overview(tgt), FULL);
  if (viaArg) { const v = register(viaOv, overview(tgt), true); res = { ...v, matrix: mul(viaM, v.matrix) }; }
  const ms = Date.now() - t0;
  if (res.error) { console.log(f, 'ERROR', res.error); continue; }
  results.push(report(f, res, residuals(refG, gradMag(tgt), res.matrix, box), ms));
}
fs.writeFileSync(path.join('bench', `last-${FULL ? 'full' : 'quick'}.json`), JSON.stringify(results, null, 1));
