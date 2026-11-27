// TIFF LZW decoder (MSB-first, "early change"), replaces geotiff's, which overruns
// its 4093-entry table on files that fill the table to 4094 before a Clear code.
import { addDecoder, BaseDecoder } from 'geotiff';

export function lzwDecode(src) {
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
  let out = new Uint8Array(Math.max(1024, src.length * 3)), op = 0;
  let next = 258, width = 9, old = -1, pos = 0;
  const nbits = src.length * 8;

  const emit = (c) => {
    const l = len[c];
    if (op + l > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + l)); o.set(out); out = o; }
    for (let i = op + l - 1; c !== -1; i--) { out[i] = suffix[c]; c = prefix[c]; }
    op += l;
  };
  const add = (p, ch) => {
    if (next >= 4096) return;
    prefix[next] = p; suffix[next] = ch; first[next] = first[p]; len[next] = len[p] + 1; next++;
  };

  while (pos + width <= nbits) {
    const b = pos >> 3;
    const v = (src[b] << 16) | ((src[b + 1] || 0) << 8) | (src[b + 2] || 0);
    const code = (v >> (24 - (pos & 7) - width)) & ((1 << width) - 1);
    pos += width;
    if (code === 257) break;                       // end of information
    if (code === 256) { next = 258; width = 9; old = -1; continue; } // clear
    if (old === -1) { if (code > 255) break; emit(code); old = code; continue; }
    if (code < next) { emit(code); add(old, first[code]); }
    else { add(old, first[old]); emit(next - 1); } // KwKwK case
    old = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  return out.subarray(0, op);
}

class LZWDecoder extends BaseDecoder {
  decodeBlock(buffer) { return lzwDecode(new Uint8Array(buffer)).slice().buffer; }
}
addDecoder(5, () => Promise.resolve(LZWDecoder));
