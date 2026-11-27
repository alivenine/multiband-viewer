// Registration worker. Input: two overviews (RGBA + scale = overviewW / fullW).
// Output: matrix [a,b,c,d,e,f] mapping TARGET full-res px -> REFERENCE full-res px
// (x' = a x + c y + e, y' = b x + d y + f), plus score 0..1.
// Quick: gradient-magnitude images (works across IR / UV / visible bands),
//   brute-force scale+shift search at ~128 px, then ECC (Evangelidis 2008) coarse-to-fine.
// Full: wide rotation/scale/shift search, then mutual-information refinement
//   (handles very different content, e.g. IR transmission, low-detail IR), then ECC polish.
// All warps are similarity: p = [a, b, tx, ty], X = a x - b y + tx, Y = b x + a y + ty
// (ref-level coords -> target-level coords).

self.onmessage = (e) => {
  const { id, ref, tgt, full } = e.data;
  const progress = (f) => self.postMessage({ id, progress: f });
  try {
    self.postMessage({ id, ...(full ? registerFull(ref, tgt, progress) : register(ref, tgt)) });
  } catch (err) {
    self.postMessage({ id, error: String(err.message || err) });
  }
};

function setup(ref, tgt) {
  const R = pyramid(gray(ref), 64), F = pyramid(gray(tgt), 64, R.length);
  const n = R.length, r0 = R[n - 1], f0 = F[n - 1];
  const k = (f0.w / r0.w + f0.h / r0.h) / 2;
  return { R, F, n, p0: [k, 0, f0.w / 2 - k * r0.w / 2, f0.h / 2 - k * r0.h / 2] };
}

// p at pyramid level `lvl` -> matrix target full-res -> ref full-res
function toMatrix(p, lvl, ref, tgt) {
  const m = 2 ** lvl, q = [p[0], p[1], p[2] * m, p[3] * m];
  // full-res -> overview pixel centers: x_ov = (x + 0.5) * s - 0.5 (box-filter pyramid)
  const P = (s) => [s, 0, 0, s, 0.5 * s - 0.5, 0.5 * s - 0.5];
  const A = [q[0], q[1], -q[1], q[0], q[2], q[3]];
  return invert(mul(invert(P(tgt.scale)), mul(A, P(ref.scale)))); // inverse of: ref full -> target full
}

function eccPyramid(R, F, p, from) {
  let cc = 0;
  for (let i = from; i >= 0; i--) {
    if (i < from) { p = [p[0], p[1], p[2] * 2, p[3] * 2]; }
    const fr = feat(R[i]), ff = feat(F[i]);
    const res = ecc(fr, ff, grad(ff), p, i === 0 ? 15 : 30);
    p = res.p; cc = res.cc;
  }
  return { p, cc };
}

function register(ref, tgt) {
  const { R, F, n, p0 } = setup(ref, tgt);
  const p = coarseSearch(feat(R[n - 1]), feat(F[n - 1]), p0);
  const res = eccPyramid(R, F, p, n - 1);
  const rf = patchRefine(R[0], F[0], res.p);
  return { matrix: toMatrix(rf ? rf.p : res.p, 0, ref, tgt), score: res.cc, err: rf?.err };
}

function registerFull(ref, tgt, progress) {
  const { R, F, n, p0 } = setup(ref, tgt);
  const top = n - 1;
  // 0. quick result first: full must never end up worse than quick
  const q = eccPyramid(R, F, coarseSearch(feat(R[top]), feat(F[top]), p0), top);
  progress(0.05);
  if (q.cc >= 0.5 && q.p.every(Number.isFinite)) return polish(R, F, q, ref, tgt, progress);
  // 1. global search on gradient images: rotation x scale x shift, keep best few
  const fr = feat(R[top]), ff = feat(F[top]);
  const cands = [];
  for (let deg = -8; deg <= 8.001; deg += 2) {
    const th = deg * Math.PI / 180;
    const base = rotateAbout(p0, th, R[top]);
    for (const c of coarseSearch(fr, ff, base, 0.85, 1.15, 0.03, 6)) cands.push(c);
    progress(0.05 + 0.25 * (deg + 8) / 16);
  }
  cands.push({ p: p0, c: 0 });
  if (q.p.every(Number.isFinite)) cands.push({ p: [q.p[0], q.p[1], q.p[2] / 2 ** top, q.p[3] / 2 ** top], c: 1 }); // quick result
  // 2. mutual information on intensity, refine each candidate at 2 coarse levels, keep best
  const lv = Math.max(0, top - 1);
  const mR = miPrep(R[lv]), mF = miPrep(F[lv]);
  const sc = 2 ** (top - lv);
  cands.sort((a, b) => b.c - a.c);
  const uniq = [];
  for (const c of cands) if (!uniq.some((u) => near(u.p, c.p, R[top].w))) uniq.push(c);
  let best = null;
  uniq.slice(0, 12).forEach((c, i) => {
    const p = [c.p[0], c.p[1], c.p[2] * sc, c.p[3] * sc];
    const r = nelderMead((q) => -nmi(mR, mF, q), p, [0.01 * p[0], 0.01 * p[0], 3, 3], 200);
    if (!best || r.f < best.f) best = r;
    progress(0.3 + 0.3 * (i + 1) / Math.min(12, uniq.length));
  });
  // 3. MI coarse-to-fine up to the overview resolution
  let p = best.x, score = -best.f;
  for (let i = lv - 1; i >= 0; i--) {
    p = [p[0], p[1], p[2] * 2, p[3] * 2];
    const a = miPrep(R[i]), b = miPrep(F[i]);
    const r = nelderMead((q) => -nmi(a, b, q), p, [0.003 * p[0], 0.003 * p[0], 1.5, 1.5], 160);
    p = r.x; score = -r.f;
    progress(0.6 + 0.3 * (lv - i) / lv);
  }
  // 4. ECC polish (sub-pixel) when the bands share enough edges; keep it only if MI agrees
  const e = eccPyramid(R, F, [p[0], p[1], p[2] / 2, p[3] / 2], 1);
  if (e.p.every(Number.isFinite)) {
    const a = miPrep(R[0]), b = miPrep(F[0]);
    const sE = nmi(a, b, e.p);
    if (sE >= nmi(a, b, p) - 1e-4) { p = e.p; score = sE; }
  }
  const rf = patchRefine(R[0], F[0], p);
  progress(1);
  return { matrix: toMatrix(rf ? rf.p : p, 0, ref, tgt), score: null, full: true, err: rf?.err }; // MI value isn't comparable to the % match
}

// Quick result is good: refine with MI at the two finest levels, keep only if MI improves and it stays close.
function polish(R, F, q, ref, tgt, progress) {
  let p = q.p;
  const a0 = miPrep(R[0]), b0 = miPrep(F[0]);
  const s0 = nmi(a0, b0, p);
  let r = [p[0], p[1], p[2] / 2, p[3] / 2];
  if (R.length > 1) {
    const a1 = miPrep(R[1]), b1 = miPrep(F[1]);
    r = nelderMead((x) => -nmi(a1, b1, x), r, [0.002 * r[0], 0.002 * r[0], 0.7, 0.7], 120).x;
    progress(0.5);
  }
  r = nelderMead((x) => -nmi(a0, b0, x), [r[0], r[1], r[2] * 2, r[3] * 2], [0.001 * p[0], 0.001 * p[0], 0.5, 0.5], 120).x;
  const s1 = nmi(a0, b0, r);
  const close = Math.abs(r[0] - p[0]) + Math.abs(r[1] - p[1]) < 0.01 * Math.abs(p[0]) && Math.hypot(r[2] - p[2], r[3] - p[3]) < 0.01 * R[0].w;
  if (s1 > s0 && close) p = r;
  const rf = patchRefine(R[0], F[0], p);
  progress(1);
  return { matrix: toMatrix(rf ? rf.p : p, 0, ref, tgt), score: q.cc, full: true, err: rf?.err };
}

function rotateAbout(p, th, { w, h }) {
  const cx = w / 2, cy = h / 2, T0 = [p[0] * cx - p[1] * cy + p[2], p[1] * cx + p[0] * cy + p[3]];
  const a = p[0] * Math.cos(th) - p[1] * Math.sin(th), b = p[0] * Math.sin(th) + p[1] * Math.cos(th);
  return [a, b, T0[0] - (a * cx - b * cy), T0[1] - (b * cx + a * cy)];
}

const near = (p, q, w) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 0.01 * Math.abs(p[0]) &&
  Math.abs(p[2] - q[2]) + Math.abs(p[3] - q[3]) < 0.03 * w;

// ---------- mutual information ----------
const BINS = 32;
// blur + robust normalise to [0, BINS)
function miPrep(img) {
  const { w, h, d } = img, b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1), xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
    b[y * w + x] = (d[ym * w + x] + d[yp * w + x] + d[y * w + xm] + d[y * w + xp] + 4 * d[y * w + x]) / 8;
  }
  const s = Array.from(b.filter((_, i) => i % 7 === 0)).sort((x, y) => x - y);
  const lo = s[Math.floor(s.length * 0.005)], hi = s[Math.floor(s.length * 0.995)];
  const k = (BINS - 0.001) / Math.max(1e-6, hi - lo);
  const q = new Float32Array(w * h);
  for (let i = 0; i < q.length; i++) q[i] = Math.min(BINS - 0.001, Math.max(0, (b[i] - lo) * k));
  return { w, h, d: q };
}

// normalised MI (H(A)+H(B))/H(A,B), 1 = independent, 2 = identical. Partial-volume binning.
function nmi(r, f, p) {
  const [a, b, tx, ty] = p, { w, h } = r;
  const J = new Float64Array(BINS * BINS);
  const step = Math.max(1, Math.round(Math.sqrt(w * h / 120000)));
  let n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const X = a * x - b * y + tx, Y = b * x + a * y + ty;
    if (X < 0 || Y < 0 || X >= f.w - 1 || Y >= f.h - 1) continue;
    const v = bilinear(f.d, f.w, f.h, X, Y), i0 = Math.floor(v), fr = v - i0, row = Math.floor(r.d[y * w + x]) * BINS;
    J[row + i0] += 1 - fr;
    if (i0 + 1 < BINS) J[row + i0 + 1] += fr;
    n++;
  }
  if (n < w * h / (step * step) * 0.25) return 1; // too little overlap
  const A = new Float64Array(BINS), B = new Float64Array(BINS);
  let hj = 0;
  for (let i = 0; i < BINS; i++) for (let j = 0; j < BINS; j++) {
    const v = J[i * BINS + j] / n;
    if (v > 0) { hj -= v * Math.log(v); A[i] += v; B[j] += v; }
  }
  let ha = 0, hb = 0;
  for (let i = 0; i < BINS; i++) { if (A[i] > 0) ha -= A[i] * Math.log(A[i]); if (B[i] > 0) hb -= B[i] * Math.log(B[i]); }
  return (ha + hb) / hj;
}

// Nelder–Mead minimiser
function nelderMead(f, x0, steps, maxIter) {
  const n = x0.length;
  let S = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; S.push(x); }
  let F = S.map(f);
  for (let it = 0; it < maxIter; it++) {
    const idx = F.map((v, i) => i).sort((i, j) => F[i] - F[j]);
    S = idx.map((i) => S[i]); F = idx.map((i) => F[i]);
    if (Math.abs(F[n] - F[0]) < 1e-7) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const pt = (t) => c.map((v, j) => v + t * (S[n][j] - v));
    const xr = pt(-1), fr = f(xr);
    if (fr < F[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
    else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
    else {
      const xc = pt(fr < F[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, F[n])) { S[n] = xc; F[n] = fc; }
      else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); } }
    }
  }
  const i = F.indexOf(Math.min(...F));
  return { x: S[i], f: F[i] };
}

function gray({ width: w, height: h, data }) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { w, h, d: g };
}

function half({ w, h, d }) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * w2 + x] = (d[i] + d[i + 1] + d[i + w] + d[i + w + 1]) / 4;
  }
  return { w: w2, h: h2, d: o };
}

// Levels finest -> coarsest until max side <= min (or exactly `count` levels).
function pyramid(img, min, count) {
  const out = [img];
  while (count ? out.length < count : Math.max(img.w, img.h) > min * 2) {
    img = half(img); out.push(img);
  }
  return out;
}

// blur (binomial 3x3) then gradient magnitude
function feat({ w, h, d }) {
  const b = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1), xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
    b[y * w + x] = (d[ym * w + xm] + 2 * d[ym * w + x] + d[ym * w + xp] + 2 * d[y * w + xm] + 4 * d[y * w + x]
      + 2 * d[y * w + xp] + d[yp * w + xm] + 2 * d[yp * w + x] + d[yp * w + xp]) / 16;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = b[i + 1] - b[i - 1], gy = b[i + w] - b[i - w];
    o[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return { w, h, d: o };
}

function grad({ w, h, d }) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (d[i + 1] - d[i - 1]) / 2; gy[i] = (d[i + w] - d[i - w]) / 2;
  }
  return { gx, gy };
}

function bilinear(d, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

// Try scales around p (keeping rotation), integer shifts in ref grid.
// Returns best p, or when `topK` is given, the best `topK` as [{p, c}].
function coarseSearch(r, f, p, s0 = 0.9, s1 = 1.1, ds = 0.02, topK = 0) {
  const { w, h } = r, S = Math.round(Math.max(w, h) * 0.12);
  const found = [];
  const cx = w / 2, cy = h / 2;
  const T0 = [p[0] * cx - p[1] * cy + p[2], p[1] * cx + p[0] * cy + p[3]];
  for (let s = s0; s <= s1 + 1e-9; s += ds) {
    const a = p[0] * s, b = p[1] * s;
    const tx = T0[0] - (a * cx - b * cy), ty = T0[1] - (b * cx + a * cy);
    const wv = new Float32Array(w * h), m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = a * x - b * y + tx, Y = b * x + a * y + ty;
      if (X >= 0 && Y >= 0 && X < f.w - 1 && Y < f.h - 1) { wv[y * w + x] = bilinear(f.d, f.w, f.h, X, Y); m[y * w + x] = 1; }
    }
    let best = -2, bp = null;
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      let n = 0, sr = 0, sf = 0, srr = 0, sff = 0, srf = 0;
      const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy), x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
      for (let y = y0; y < y1; y++) {
        const ro = y * w, fo = (y + dy) * w + dx;
        for (let x = x0; x < x1; x++) {
          if (!m[fo + x]) continue;
          const A = r.d[ro + x], B = wv[fo + x];
          n++; sr += A; sf += B; srr += A * A; sff += B * B; srf += A * B;
        }
      }
      if (n < w * h * 0.3) continue;
      const cov = srf - sr * sf / n, v = Math.sqrt((srr - sr * sr / n) * (sff - sf * sf / n));
      const c = v > 0 ? cov / v : -1;
      // shift (dx,dy) in ref grid: target sampled at W(x + d)
      if (c > best) { best = c; bp = [a, b, tx + a * dx - b * dy, ty + b * dx + a * dy]; }
    }
    if (bp) found.push({ p: bp, c: best });
  }
  found.sort((x, y) => y.c - x.c);
  if (topK) return found.slice(0, topK);
  return found.length ? found[0].p : p;
}

// ECC with similarity warp: X = a x - b y + tx, Y = b x + a y + ty
function ecc(r, f, g, p, iters) {
  p = p.slice();
  const { w, h } = r;
  let cc = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 400000))); // subsample huge levels
  for (let it = 0; it < iters; it++) {
    const [a, b, tx, ty] = p;
    // pass 1: means
    let n = 0, mr = 0, mw = 0;
    const buf = [];
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
      const X = a * x - b * y + tx, Y = b * x + a * y + ty;
      if (X < 1 || Y < 1 || X >= f.w - 2 || Y >= f.h - 2) continue;
      const ir = r.d[y * w + x], iw = bilinear(f.d, f.w, f.h, X, Y);
      const gx = bilinear(g.gx, f.w, f.h, X, Y), gy = bilinear(g.gy, f.w, f.h, X, Y);
      buf.push(x, y, ir, iw, gx, gy);
      n++; mr += ir; mw += iw;
    }
    if (n < 100) break;
    mr /= n; mw /= n;
    const H = new Float64Array(16), gi = new Float64Array(4), gr = new Float64Array(4);
    let rw = 0, ww = 0, rr = 0;
    const J = new Float64Array(4);
    for (let k = 0; k < buf.length; k += 6) {
      const x = buf[k], y = buf[k + 1], ir = buf[k + 2] - mr, iw = buf[k + 3] - mw, gx = buf[k + 4], gy = buf[k + 5];
      J[0] = gx * x + gy * y; J[1] = -gx * y + gy * x; J[2] = gx; J[3] = gy;
      for (let i = 0; i < 4; i++) {
        gi[i] += J[i] * iw; gr[i] += J[i] * ir;
        for (let j = i; j < 4; j++) H[i * 4 + j] += J[i] * J[j];
      }
      rw += ir * iw; ww += iw * iw; rr += ir * ir;
    }
    for (let i = 0; i < 4; i++) for (let j = 0; j < i; j++) H[i * 4 + j] = H[j * 4 + i];
    cc = rw / Math.sqrt(rr * ww);
    const Hi_gi = solve(H, gi);
    if (!Hi_gi) break;
    const ln = ww - dot(gi, Hi_gi), ld = rw - dot(gr, Hi_gi);
    if (ld <= 0) break;
    const lam = ln / ld;
    const ep = gr.map((v, i) => lam * v - gi[i]);
    const dp = solve(H, ep);
    if (!dp) break;
    for (let i = 0; i < 4; i++) p[i] += dp[i];
    if (Math.abs(dp[2]) + Math.abs(dp[3]) < 0.01 && Math.abs(dp[0]) + Math.abs(dp[1]) < 1e-5) break;
  }
  return { p, cc };
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// Gaussian elimination, 4x4
function solve(H, v) {
  const n = 4, A = [];
  for (let i = 0; i < n; i++) A.push([...H.slice(i * 4, i * 4 + 4), v[i]]);
  for (let c = 0; c < n; c++) {
    let pr = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pr][c])) pr = r;
    if (Math.abs(A[pr][c]) < 1e-12) return null;
    [A[c], A[pr]] = [A[pr], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------- robust patch refinement ----------
// Block-match a grid of small patches (NCC of gradient magnitude) between the reference and the warped target,
// then fit the similarity to the matches with outlier rejection. Unlike whole-image ECC, regions that move
// differently (stretcher-bar shadow in transmitted light, background at another depth, lamps, glare) are voted
// out instead of pulling the whole result. Returns null when there are too few good matches (keep the input).
// err = median residual of the inliers in level-0 px (multiply by 1/scale for full-res px).
function patchRefine(R0, F0, p, searches = [8, 3, 2]) {
  const fr = feat(R0), ff = feat(F0), { w, h } = fr;
  const P = 32, G = 20; // patch side, grid step (level-0 px)
  let fit = null;
  for (const S of searches) {
    const pairs = matchPatches(fr, ff, p, P, G, S);
    if (pairs.length < 12) return fit;
    const f = robustSimilarity(pairs);
    if (!f || f.inliers < 12 || f.err > 1) return fit; // err > 1 px: matches don't agree, not a real fit
    // inliers must cover the image, not one corner
    const xs = f.in.map((q) => q.x).sort((a, b) => a - b), ys = f.in.map((q) => q.y).sort((a, b) => a - b);
    const q = (a, t) => a[Math.floor(t * (a.length - 1))];
    if (q(xs, 0.9) - q(xs, 0.1) < 0.3 * w || q(ys, 0.9) - q(ys, 0.1) < 0.3 * h) return fit;
    p = f.p; fit = { p, err: f.err, inliers: f.inliers };
  }
  return fit;
}

function matchPatches(fr, ff, p, P, G, S) {
  const { w, h } = fr, [a, b, tx, ty] = p, N = P + 2 * S, L = 2 * S + 1, k = (P / 2) ** 2;
  const W = new Float32Array(N * N), C = new Float32Array(L * L), out = [];
  for (let y0 = S; y0 + N <= h; y0 += G) for (let x0 = S; x0 + N <= w; x0 += G) {
    // patch at (x0+S, y0+S) .. +P in ref; window x0..x0+N
    let s1 = 0, s11 = 0;
    for (let y = 0; y < P; y += 2) for (let x = 0; x < P; x += 2) { const v = fr.d[(y0 + S + y) * w + x0 + S + x]; s1 += v; s11 += v * v; }
    const vr = s11 - s1 * s1 / k;
    if (!(vr > k * 4)) continue; // flat patch (std < 2 grey levels of gradient)
    let ok = true;
    for (let y = 0; y < N && ok; y++) for (let x = 0; x < N; x++) {
      const u = x0 + x, v = y0 + y, X = a * u - b * v + tx, Y = b * u + a * v + ty;
      if (X < 0 || Y < 0 || X >= ff.w - 1 || Y >= ff.h - 1) { ok = false; break; }
      W[y * N + x] = bilinear(ff.d, ff.w, ff.h, X, Y);
    }
    if (!ok) continue;
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
      let sw = 0, sww = 0, srw = 0;
      for (let y = 0; y < P; y += 2) {
        const ro = (y0 + S + y) * w + x0 + S, wo = (S + y + dy) * N + S + dx;
        for (let x = 0; x < P; x += 2) { const r = fr.d[ro + x], t = W[wo + x]; sw += t; sww += t * t; srw += r * t; }
      }
      const v = Math.sqrt(vr * (sww - sw * sw / k));
      C[(dy + S) * L + dx + S] = v > 0 ? (srw - s1 * sw / k) / v : -1;
    }
    let bi = 0;
    for (let i = 1; i < C.length; i++) if (C[i] > C[bi]) bi = i;
    const bx = bi % L, by = (bi / L) | 0;
    if (bx === 0 || by === 0 || bx === L - 1 || by === L - 1 || C[bi] < 0.3) continue;
    let second = -1;
    for (let i = 0; i < C.length; i++) { const x = i % L, y = (i / L) | 0; if (Math.abs(x - bx) > 2 || Math.abs(y - by) > 2) second = Math.max(second, C[i]); }
    if (C[bi] - second < 0.05) continue; // repetitive texture (canvas weave): ambiguous
    const sub = (l, c, r) => { const d = l - 2 * c + r; return d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)) : 0; };
    const dx = bx - S + sub(C[bi - 1], C[bi], C[bi + 1]), dy = by - S + sub(C[bi - L], C[bi], C[bi + L]);
    const cx = x0 + S + P / 2 - 0.5, cy = y0 + S + P / 2 - 0.5, u = cx + dx, v = cy + dy;
    out.push({ x: cx, y: cy, X: a * u - b * v + tx, Y: b * u + a * v + ty, c: C[bi] });
  }
  return out;
}

// Least-squares similarity ref (x,y) -> target (X,Y), refitted while dropping matches beyond 3 robust sigmas.
function robustSimilarity(pairs) {
  let use = pairs, p = null, err = 0;
  for (let it = 0; it < 6; it++) {
    if (use.length < 3) return null;
    let mx = 0, my = 0, mX = 0, mY = 0, sw = 0;
    for (const q of use) { mx += q.x; my += q.y; mX += q.X; mY += q.Y; }
    const n = use.length; mx /= n; my /= n; mX /= n; mY /= n;
    let sxx = 0, A = 0, B = 0;
    for (const q of use) {
      const x = q.x - mx, y = q.y - my, X = q.X - mX, Y = q.Y - mY;
      sxx += x * x + y * y; A += x * X + y * Y; B += x * Y - y * X;
    }
    const a = A / sxx, b = B / sxx;
    p = [a, b, mX - a * mx + b * my, mY - b * mx - a * my];
    const res = pairs.map((q) => Math.hypot(a * q.x - b * q.y + p[2] - q.X, b * q.x + a * q.y + p[3] - q.Y));
    const sorted = res.filter((_, i) => use.includes(pairs[i])).sort((u, v) => u - v);
    err = sorted[sorted.length >> 1];
    const lim = Math.max(0.5, 3 * 1.4826 * err);
    const next = pairs.filter((_, i) => res[i] < lim);
    if (next.length === use.length) { use = next; break; }
    use = next;
  }
  return { p, err, inliers: use.length, in: use };
}
