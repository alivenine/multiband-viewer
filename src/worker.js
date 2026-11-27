// One worker per image. Imports the file once into a JPEG tile pyramid stored on
// local disk (OPFS), then serves tiles. Nothing leaves the machine.
import { fromBlob } from 'geotiff';
import './lzw.js'; // fixed LZW decoder

const T = 512;            // tile size
const QUALITY = 0.92;     // tile JPEG quality
const OVERVIEW = 2048;    // max side of overview used for registration / thumbnails

let meta = null;          // { name, width, height, levels: [{w,h,cols,rows}], bits, index: [[off,len,...]] }
let store = null;         // { read(off,len) -> Uint8Array, write(bytes) -> off, flush(), close() }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'open') await open(m);
    else if (m.type === 'tile') {
      const i = (m.y * meta.levels[m.l].cols + m.x) * 2;
      const off = meta.index[m.l][i], len = meta.index[m.l][i + 1];
      const bmp = await createImageBitmap(new Blob([store.read(off, len)], { type: 'image/jpeg' }));
      self.postMessage({ type: 'tile', id: m.id, bmp }, [bmp]);
    } else if (m.type === 'pixel') {
      self.postMessage({ type: 'pixel', rgb: await pixel(Math.floor(m.x), Math.floor(m.y)).catch(() => null) });
    } else if (m.type === 'overview') {
      const ov = await overview();
      self.postMessage({ type: 'overview', id: m.id, ...ov }, [ov.data.buffer]);
    }
  } catch (err) {
    console.error(err);
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

// ---------- storage: OPFS file (disk), falls back to RAM ----------
async function cacheDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('mbv-cache', { create });
}

async function opfsStore(key, truncate) {
  const dir = await (await cacheDir(true)).getDirectoryHandle(key, { create: true });
  const fh = await dir.getFileHandle('tiles.bin', { create: true });
  const h = await fh.createSyncAccessHandle();
  if (truncate) h.truncate(0);
  let end = h.getSize();
  return {
    dir,
    read(off, len) { const b = new Uint8Array(len); h.read(b, { at: off }); return b; },
    write(bytes) { const off = end; h.write(bytes, { at: off }); end += bytes.length; return off; },
    flush() { h.flush(); },
    close() { h.close(); },
  };
}

function memStore() {
  const chunks = []; let end = 0; const offs = [];
  return {
    read(off, len) { // ponytail: linear chunk lookup via binary search on offsets
      let lo = 0, hi = offs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= off) lo = mid; else hi = mid - 1; }
      return chunks[lo];
    },
    write(bytes) { offs.push(end); chunks.push(bytes); const o = end; end += bytes.length; return o; },
    flush() {}, close() {},
  };
}

async function readMeta(key) {
  try {
    const dir = await (await cacheDir(false)).getDirectoryHandle(key);
    const f = await (await dir.getFileHandle('meta.json')).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

async function writeMeta(dir, obj) {
  const fh = await dir.getFileHandle('meta.json', { create: true });
  const h = await fh.createSyncAccessHandle();
  const b = new TextEncoder().encode(JSON.stringify(obj));
  h.truncate(0); h.write(b, { at: 0 }); h.flush(); h.close();
}

// ---------- open / import ----------
async function open({ file, key }) {
  meta = await readMeta(key);
  if (meta) {
    store = await opfsStore(key, false);
    self.postMessage({ type: 'ready', meta: info(), cached: true });
    return;
  }
  if (!file) throw new Error('Not in cache, please open the file again');
  try { store = await opfsStore(key, true); } catch (err) {
    console.warn('OPFS unavailable, keeping tiles in RAM', err);
    store = memStore();
  }
  const src = await openSource(file);
  self.postMessage({ type: 'info', width: src.width, height: src.height, bits: src.bits });
  meta = { name: file.name, size: file.size, width: src.width, height: src.height, bits: src.bits,
    channels: src.channels, levels: levelSizes(src.width, src.height), index: [], date: Date.now() };
  meta.index = meta.levels.map(l => new Array(l.cols * l.rows * 2).fill(0));
  await buildPyramid(src);
  src.close && src.close();
  store.flush();
  if (store.dir) await writeMeta(store.dir, meta);
  self.postMessage({ type: 'ready', meta: info(), cached: false });
}

function info() {
  const { name, size, width, height, bits, channels, levels, date } = meta;
  return { name, size, width, height, bits, channels, levels, date };
}

function levelSizes(w, h) {
  const out = [];
  for (;;) {
    out.push({ w, h, cols: Math.ceil(w / T), rows: Math.ceil(h / T) });
    if (w <= T && h <= T) return out;
    w = Math.ceil(w / 2); h = Math.ceil(h / 2);
  }
}

// ---------- sources: each gives readBand(y, h) -> RGBA8 (width*h*4) ----------
async function openSource(file) {
  const n = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isTiff = (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
  if (isTiff || n.endsWith('.tif') || n.endsWith('.tiff')) return tiffSource(file);
  return bitmapSource(file);
}

async function bitmapSource(file) {
  // Browser decoder (JPEG/PNG/WebP). Whole image decoded once into an ImageBitmap.
  let bmp;
  try { bmp = await createImageBitmap(file); } catch {
    throw new Error('This image could not be decoded (too large or damaged). Save it as TIFF and retry.');
  }
  const W = bmp.width, H = bmp.height, CW = 4096;
  const cv = new OffscreenCanvas(CW, T);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  return {
    width: W, height: H, bits: 8, channels: 3,
    async readBand(y, h) {
      const out = new Uint8ClampedArray(W * h * 4);
      for (let x = 0; x < W; x += CW) {
        const w = Math.min(CW, W - x);
        ctx.clearRect(0, 0, CW, T);
        ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let r = 0; r < h; r++) out.set(d.subarray(r * w * 4, (r + 1) * w * 4), (r * W + x) * 4);
      }
      return out;
    },
    close() { bmp.close(); },
  };
}

async function tiffSource(file) {
  const tiff = await fromBlob(file);
  // Pick the largest IFD (some files store a thumbnail first).
  let img = await tiff.getImage(0);
  const count = await tiff.getImageCount();
  for (let i = 1; i < Math.min(count, 8); i++) {
    const c = await tiff.getImage(i);
    if (c.getWidth() > img.getWidth()) img = c;
  }
  const W = img.getWidth(), H = img.getHeight();
  const fd = img.fileDirectory;
  const pi = fd.PhotometricInterpretation;
  const spp = img.getSamplesPerPixel();
  const bits = img.getBitsPerSample(0);
  const isFloat = (fd.SampleFormat && fd.SampleFormat[0] === 3);
  const useRGB = !(pi === 0 || pi === 1 || pi === 2); // palette / CMYK / YCbCr / Lab -> library converts to 8-bit RGB
  const nch = useRGB ? 3 : (pi === 2 && spp >= 3 ? 3 : 1);
  const samples = nch === 3 ? [0, 1, 2] : [0];

  const read = (y, h) => useRGB
    ? img.readRGB({ window: [0, y, W, y + h], interleave: true })
    : img.readRasters({ window: [0, y, W, y + h], samples, interleave: true });

  // Tone mapping: 8-bit = identity, >8-bit / float = auto stretch from sampled percentiles.
  let lo = 0, hi = 255;
  if (!useRGB && (bits > 8 || isFloat)) [lo, hi] = await sampleRange(read, W, H, nch);
  const invert = pi === 0;
  const scale = 255 / Math.max(1e-9, hi - lo);
  let lut = null;
  if (!isFloat && bits <= 16 && !useRGB) {
    lut = new Uint8ClampedArray(1 << bits);
    for (let v = 0; v < lut.length; v++) {
      const o = (v - lo) * scale;
      lut[v] = invert ? 255 - o : o;
    }
  }
  const map = lut ? (v) => lut[v] : (v) => { const o = (v - lo) * scale; return invert ? 255 - o : o; };

  return {
    width: W, height: H, bits: isFloat ? 32 : bits, channels: nch,
    async readBand(y, h) {
      const src = await read(y, h);
      const n = W * h, out = new Uint8ClampedArray(n * 4);
      if (useRGB) {
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          out[i * 4] = src[j]; out[i * 4 + 1] = src[j + 1]; out[i * 4 + 2] = src[j + 2]; out[i * 4 + 3] = 255;
        }
      } else if (nch === 1) {
        for (let i = 0; i < n; i++) { const v = map(src[i]); out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
      } else {
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          out[i * 4] = map(src[j]); out[i * 4 + 1] = map(src[j + 1]); out[i * 4 + 2] = map(src[j + 2]); out[i * 4 + 3] = 255;
        }
      }
      return out;
    },
  };
}

// Read ~40 thin bands spread over the image; return [p0.05, p99.95] over all channels.
async function sampleRange(read, W, H, nch) {
  const vals = [];
  const step = Math.max(1, Math.floor(W / 1500));
  const bands = Math.min(40, H);
  for (let b = 0; b < bands; b++) {
    const y = Math.floor((b + 0.5) * H / bands);
    const row = await read(y, 1);
    for (let x = 0; x < W; x += step) for (let c = 0; c < nch; c++) {
      const v = row[x * nch + c];
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.0005)], hi = vals[Math.floor(vals.length * 0.9995)];
  return hi > lo ? [lo, hi] : [vals[0], vals[vals.length - 1] || 1];
}

// ---------- pyramid ----------
// Bands of T rows flow into level 0; each full band is cut into tiles and
// downsampled 2x into the next level's band buffer.
async function buildPyramid(src) {
  const L = meta.levels;
  const lv = L.map((s) => ({ ...s, buf: new Uint8ClampedArray(s.w * T * 4), rows: 0, ty: 0 }));
  const cv = new OffscreenCanvas(T, T);
  const ctx = cv.getContext('2d');

  async function flush(k) {
    const l = lv[k];
    if (!l.rows) return;
    const pending = [];
    for (let tx = 0; tx < l.cols; tx++) {
      const x0 = tx * T, w = Math.min(T, l.w - x0), h = l.rows;
      const tile = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++) tile.set(l.buf.subarray((r * l.w + x0) * 4, (r * l.w + x0 + w) * 4), r * w * 4);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      ctx.putImageData(new ImageData(tile, w, h), 0, 0);
      pending.push(cv.convertToBlob({ type: 'image/jpeg', quality: QUALITY }));
    }
    const blobs = await Promise.all(pending);
    for (let tx = 0; tx < blobs.length; tx++) {
      const bytes = new Uint8Array(await blobs[tx].arrayBuffer());
      const i = (l.ty * l.cols + tx) * 2;
      meta.index[k][i] = store.write(bytes);
      meta.index[k][i + 1] = bytes.length;
    }
    if (k + 1 < lv.length) await push(k + 1, half(l.buf, l.w, l.rows), Math.ceil(l.rows / 2));
    l.rows = 0; l.ty++;
  }

  async function push(k, data, rows) {
    const l = lv[k];
    let r = 0;
    while (r < rows) {
      const n = Math.min(rows - r, T - l.rows);
      l.buf.set(data.subarray(r * l.w * 4, (r + n) * l.w * 4), l.rows * l.w * 4);
      l.rows += n; r += n;
      if (l.rows === T) await flush(k);
    }
  }

  for (let y = 0; y < src.height; y += T) {
    const h = Math.min(T, src.height - y);
    await push(0, await src.readBand(y, h), h);
    self.postMessage({ type: 'progress', p: (y + h) / src.height });
  }
  for (let k = 0; k < lv.length; k++) await flush(k); // partial last bands, top-down
}

// 2x2 box downsample of `rows` rows of width w.
function half(buf, w, rows) {
  const w2 = Math.ceil(w / 2), h2 = Math.ceil(rows / 2);
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w * 4, r1 = Math.min(2 * y + 1, rows - 1) * w * 4;
    for (let x = 0; x < w2; x++) {
      const c0 = 2 * x * 4, c1 = Math.min(2 * x + 1, w - 1) * 4, o = (y * w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = (buf[r0 + c0 + c] + buf[r0 + c1 + c] + buf[r1 + c0 + c] + buf[r1 + c1 + c] + 2) >> 2;
      }
    }
  }
  return out;
}

// Stitch the first level whose longest side <= OVERVIEW.
async function overview() {
  let k = meta.levels.findIndex((l) => Math.max(l.w, l.h) <= OVERVIEW);
  if (k < 0) k = meta.levels.length - 1;
  const l = meta.levels[k];
  const cv = new OffscreenCanvas(l.w, l.h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) {
    const i = (y * l.cols + x) * 2;
    const bmp = await createImageBitmap(new Blob([store.read(meta.index[k][i], meta.index[k][i + 1])], { type: 'image/jpeg' }));
    ctx.drawImage(bmp, x * T, y * T); bmp.close();
  }
  return { width: l.w, height: l.h, scale: 1 / 2 ** k, data: ctx.getImageData(0, 0, l.w, l.h).data };
}

// RGB at full-res pixel (x, y) from the stored level-0 tiles (8-bit display values).
const pxTiles = new Map(); // small cache of decoded tiles
async function pixel(x, y) {
  if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return null;
  const tx = Math.floor(x / T), ty = Math.floor(y / T), key = tx + '/' + ty;
  let t = pxTiles.get(key);
  if (!t) {
    const i = (ty * meta.levels[0].cols + tx) * 2;
    const bmp = await createImageBitmap(new Blob([store.read(meta.index[0][i], meta.index[0][i + 1])], { type: 'image/jpeg' }));
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    t = ctx.getImageData(0, 0, bmp.width, bmp.height); bmp.close();
    pxTiles.set(key, t);
    if (pxTiles.size > 6) pxTiles.delete(pxTiles.keys().next().value);
  }
  const o = ((y % T) * t.width + (x % T)) * 4;
  return [t.data[o], t.data[o + 1], t.data[o + 2]];
}
