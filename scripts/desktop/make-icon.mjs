// Rasterizes desktop/assets/pager.svg into desktop/assets/pager.png (256px) and
// desktop/assets/pager.ico (PNG entries at 16/24/32/48/64/256, each rendered natively at
// its own size). Dependency-free: a small SVG-subset renderer reads the SVG file on disk
// (so the PNG/ICO cannot drift from it) and rasterises with SS x SS point samples per pixel,
// compositing and averaging in linear light.
//
// Supported subset (everything the Pager logo files use, and a little more): <svg viewBox>,
// <g>, <defs>, <linearGradient gradientUnits="userSpaceOnUse"> + <stop>, <rect> (x y width
// height rx ry), <circle>, <ellipse>, <path> (M L H V C Q A Z, absolute and relative),
// presentation attributes fill / stroke / stroke-width / opacity / fill-opacity /
// stroke-opacity inherited through groups, hex colours, url(#gradient), and
// transform="translate(...) scale(...)" with uniform scale. Strokes must use round caps and
// round joins (distance-field strokes). Anything else throws instead of rendering wrongly.
//
// Usage: node scripts/desktop/make-icon.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = resolve(root, 'desktop', 'assets');
const SVG_PATH = resolve(outDir, 'pager.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 256];
const SS = 8; // SS x SS samples per pixel

// ------------------------------------------------------------------ SVG parse
function parseXml(src) {
  src = src.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const rootNode = { tag: '#root', attrs: {}, kids: [] };
  const stack = [rootNode];
  let m;
  while ((m = tagRe.exec(src))) {
    const [, close, tag, attrSrc, self] = m;
    if (close) {
      const top = stack.pop();
      if (top.tag !== tag) throw new Error(`make-icon: mismatched </${tag}> (open <${top.tag}>)`);
      continue;
    }
    const attrs = {};
    for (const a of attrSrc.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const node = { tag, attrs, kids: [] };
    stack[stack.length - 1].kids.push(node);
    if (!self) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('make-icon: unclosed element in SVG');
  const svg = rootNode.kids.find((k) => k.tag === 'svg');
  if (!svg) throw new Error('make-icon: no <svg> root');
  return svg;
}

const num = (v, d = 0) => (v === undefined ? d : Number.parseFloat(v));

function parseColor(v) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error(`make-icon: unsupported colour "${v}" (hex only)`);
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (l) => { const v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255); };

// ------------------------------------------------------------ path flattening
// Each subpath: { pts: [[x, y], ...], closed }
function arcPoints(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1, out) {
  if (rx === 0 || ry === 0) { out.push([x1, y1]); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x1) / 2, cy = sp * cxp + cp * cyp + (y0 + y1) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dth) * Math.max(rx, ry)) / 0.12));
  for (let i = 1; i <= n; i++) {
    const t = th1 + (dth * i) / n, c = Math.cos(t), s = Math.sin(t);
    out.push([cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp]);
  }
  out[out.length - 1] = [x1, y1];
}

function flattenPath(d) {
  const toks = d.match(/[MmLlHhVvCcQqAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, i = 0, cmd = '';
  const nextNum = () => {
    const v = Number.parseFloat(toks[i++]);
    if (Number.isNaN(v)) throw new Error('make-icon: bad path data: ' + d);
    return v;
  };
  const flag = () => { // arc flags may be glued to the next number ("0 0 1 0 0 21")
    const t = toks[i];
    if (t === '0' || t === '1') { i++; return Number(t); }
    if (/^[01]/.test(t)) { toks[i] = t.slice(1); return Number(t[0]); }
    throw new Error('make-icon: bad arc flag in ' + d);
  };
  const start = (px, py) => { cur = { pts: [[px, py]], closed: false }; subs.push(cur); };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      if (cur) { cur.closed = true; x = sx; y = sy; }
      continue;
    }
    if (C === 'M') {
      const nx = nextNum() + (rel ? x : 0), ny = nextNum() + (rel ? y : 0);
      x = sx = nx; y = sy = ny; start(x, y);
      cmd = rel ? 'l' : 'L'; // implicit lineto after the first pair
      continue;
    }
    if (!cur) throw new Error('make-icon: path segment before moveto: ' + d);
    if (C === 'L') { x = nextNum() + (rel ? x : 0); y = nextNum() + (rel ? y : 0); cur.pts.push([x, y]); }
    else if (C === 'H') { x = nextNum() + (rel ? x : 0); cur.pts.push([x, y]); }
    else if (C === 'V') { y = nextNum() + (rel ? y : 0); cur.pts.push([x, y]); }
    else if (C === 'C') {
      const o = rel ? [x, y] : [0, 0];
      const p1 = [nextNum() + o[0], nextNum() + o[1]], p2 = [nextNum() + o[0], nextNum() + o[1]], p3 = [nextNum() + o[0], nextNum() + o[1]];
      for (let k = 1; k <= 24; k++) {
        const t = k / 24, u = 1 - t;
        cur.pts.push([
          u * u * u * x + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * y + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
      }
      x = p3[0]; y = p3[1];
    } else if (C === 'Q') {
      const o = rel ? [x, y] : [0, 0];
      const p1 = [nextNum() + o[0], nextNum() + o[1]], p2 = [nextNum() + o[0], nextNum() + o[1]];
      for (let k = 1; k <= 20; k++) {
        const t = k / 20, u = 1 - t;
        cur.pts.push([u * u * x + 2 * u * t * p1[0] + t * t * p2[0], u * u * y + 2 * u * t * p1[1] + t * t * p2[1]]);
      }
      x = p2[0]; y = p2[1];
    } else if (C === 'A') {
      const rx = nextNum(), ry = nextNum(), rot = nextNum(), large = flag(), sweep = flag();
      const nx = nextNum() + (rel ? x : 0), ny = nextNum() + (rel ? y : 0);
      arcPoints(x, y, rx, ry, rot, large, sweep, nx, ny, cur.pts);
      x = nx; y = ny;
    } else throw new Error(`make-icon: unsupported path command ${cmd}`);
  }
  return subs;
}

function roundRectPath(x, y, w, h, rx, ry) {
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (!rx || !ry) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}z`;
}

// ------------------------------------------------------------- scene building
const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity'];

function parseTransform(v) {
  let s = 1, tx = 0, ty = 0;
  for (const m of (v || '').matchAll(/(translate|scale)\(([^)]*)\)/g)) {
    const a = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (m[1] === 'translate') { tx += s * a[0]; ty += s * (a[1] ?? 0); }
    else {
      if (a.length > 1 && a[1] !== a[0]) throw new Error('make-icon: non-uniform scale unsupported');
      s *= a[0];
    }
  }
  if (v && !/^\s*((translate|scale)\([^)]*\)\s*)+$/.test(v)) throw new Error(`make-icon: unsupported transform "${v}"`);
  return { s, tx, ty };
}

function buildScene(svg) {
  const vb = (svg.attrs.viewBox || '').split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(Number.isNaN)) throw new Error('make-icon: <svg> needs a viewBox');
  const gradients = new Map();
  (function collect(n) {
    if (n.tag === 'linearGradient') {
      if ((n.attrs.gradientUnits || 'objectBoundingBox') !== 'userSpaceOnUse') throw new Error('make-icon: gradients must use gradientUnits="userSpaceOnUse"');
      const stops = n.kids.filter((k) => k.tag === 'stop').map((k) => ({
        off: Math.min(1, Math.max(0, num(k.attrs.offset, 0))),
        rgb: parseColor(k.attrs['stop-color'] ?? '#000000').map(toLin),
        a: num(k.attrs['stop-opacity'], 1),
      }));
      gradients.set(n.attrs.id, { x1: num(n.attrs.x1), y1: num(n.attrs.y1), x2: num(n.attrs.x2, 1), y2: num(n.attrs.y2), stops });
    }
    n.kids.forEach(collect);
  })(svg);

  const draws = []; // { polys, kind:'fill'|'stroke', hw, paint(x,y)->[r,g,b,a] linear, bbox }
  const paintOf = (value, opacity) => {
    if (value === 'none') return null;
    const gm = /^url\(#([^)]+)\)$/.exec(value);
    if (gm) {
      const g = gradients.get(gm[1]);
      if (!g) throw new Error(`make-icon: missing gradient ${gm[1]}`);
      const dx = g.x2 - g.x1, dy = g.y2 - g.y1, len2 = dx * dx + dy * dy;
      return (px, py) => {
        const t = Math.min(1, Math.max(0, ((px - g.x1) * dx + (py - g.y1) * dy) / len2));
        // gradients interpolate in sRGB in browsers: lerp encoded values, then linearise
        let k = 0;
        while (k < g.stops.length - 2 && t > g.stops[k + 1].off) k++;
        const a = g.stops[k], b = g.stops[k + 1];
        const u = b.off === a.off ? 1 : Math.min(1, Math.max(0, (t - a.off) / (b.off - a.off)));
        const out = [0, 0, 0, (a.a + (b.a - a.a) * u) * opacity];
        for (let c = 0; c < 3; c++) {
          const sa = toSrgb(a.rgb[c]) / 255, sb = toSrgb(b.rgb[c]) / 255;
          out[c] = toLin(255 * (sa + (sb - sa) * u));
        }
        return out;
      };
    }
    const rgb = parseColor(value).map(toLin);
    const col = [rgb[0], rgb[1], rgb[2], opacity];
    return () => col;
  };

  (function walk(n, st, tf, groupOpacity) {
    const style = { ...st };
    for (const k of INHERITED) if (n.attrs[k] !== undefined) style[k] = n.attrs[k];
    const t = n.attrs.transform ? parseTransform(n.attrs.transform) : { s: 1, tx: 0, ty: 0 };
    const ntf = { s: tf.s * t.s, tx: tf.tx + tf.s * t.tx, ty: tf.ty + tf.s * t.ty };
    const op = groupOpacity * num(n.attrs.opacity, 1);
    if (n.tag === 'defs') return;
    let d = null;
    if (n.tag === 'path') d = n.attrs.d;
    else if (n.tag === 'rect') {
      const w = num(n.attrs.width), h = num(n.attrs.height);
      const rx = n.attrs.rx !== undefined ? num(n.attrs.rx) : num(n.attrs.ry, 0);
      const ry = n.attrs.ry !== undefined ? num(n.attrs.ry) : rx;
      d = roundRectPath(num(n.attrs.x), num(n.attrs.y), w, h, rx, ry);
    } else if (n.tag === 'circle' || n.tag === 'ellipse') {
      const cx = num(n.attrs.cx), cy = num(n.attrs.cy);
      const rx = n.tag === 'circle' ? num(n.attrs.r) : num(n.attrs.rx), ry = n.tag === 'circle' ? rx : num(n.attrs.ry);
      d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}z`;
    } else if (!['svg', 'g', 'linearGradient', 'stop'].includes(n.tag)) throw new Error(`make-icon: unsupported element <${n.tag}>`);
    if (d) {
      const polys = flattenPath(d).map((sp) => ({ closed: sp.closed, pts: sp.pts.map(([x, y]) => [ntf.s * x + ntf.tx, ntf.s * y + ntf.ty]) }));
      const fill = paintOf(style.fill ?? '#000000', num(style['fill-opacity'], 1) * op);
      if (fill) {
        const all = polys.flatMap((p) => p.pts);
        draws.push({ kind: 'fill', polys, paint: fill, bbox: bboxOf(all, 0) });
      }
      const strokeV = style.stroke ?? 'none';
      const stroke = paintOf(strokeV, num(style['stroke-opacity'], 1) * op);
      if (stroke) {
        if ((style['stroke-linecap'] ?? 'butt') !== 'round' || (style['stroke-linejoin'] ?? 'miter') !== 'round') throw new Error('make-icon: strokes must use round linecap and linejoin');
        const hw = (num(style['stroke-width'], 1) * ntf.s) / 2;
        const all = polys.flatMap((p) => p.pts);
        draws.push({ kind: 'stroke', polys, hw, paint: stroke, bbox: bboxOf(all, hw) });
      }
    }
    for (const k of n.kids) walk(k, style, ntf, op);
  })(svg, {}, { s: 1, tx: 0, ty: 0 }, 1);

  return { vb, draws };
}

function bboxOf(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// -------------------------------------------------------------- hit testing
function inFill(polys, px, py) { // nonzero winding, every subpath implicitly closed
  let wn = 0;
  for (const { pts } of polys) {
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a[1] <= py) {
        if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) wn++;
      } else if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) wn--;
    }
  }
  return wn !== 0;
}

function inStroke(polys, hw, px, py) { // union of capsules == round caps + round joins
  const r2 = hw * hw;
  for (const { pts, closed } of polys) {
    const n = pts.length;
    const segs = closed ? n : n - 1;
    if (n === 1) {
      const dx = px - pts[0][0], dy = py - pts[0][1];
      if (dx * dx + dy * dy <= r2) return true;
      continue;
    }
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const l2 = abx * abx + aby * aby;
      let t = l2 ? ((px - a[0]) * abx + (py - a[1]) * aby) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - (a[0] + abx * t), dy = py - (a[1] + aby * t);
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ rasterization
function render(scene, size) {
  const [vx, vy, vw, vh] = scene.vb;
  const out = Buffer.alloc(size * size * 4);
  const kx = vw / (size * SS), ky = vh / (size * SS);
  const inv = 1 / (SS * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = vy + (py * SS + sy + 0.5) * ky;
        for (let sx = 0; sx < SS; sx++) {
          const x = vx + (px * SS + sx + 0.5) * kx;
          let r = 0, g = 0, b = 0, a = 0; // premultiplied linear
          for (const d of scene.draws) {
            const bb = d.bbox;
            if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
            if (!(d.kind === 'fill' ? inFill(d.polys, x, y) : inStroke(d.polys, d.hw, x, y))) continue;
            const c = d.paint(x, y), ca = c[3], k = 1 - ca;
            r = c[0] * ca + r * k; g = c[1] * ca + g * k; b = c[2] * ca + b * k; a = ca + a * k;
          }
          ar += r; ag += g; ab += b; aa += a;
        }
      }
      const o = (py * size + px) * 4;
      const A = aa * inv;
      if (A > 0) {
        out[o] = toSrgb((ar * inv) / A); out[o + 1] = toSrgb((ag * inv) / A); out[o + 2] = toSrgb((ab * inv) / A);
      }
      out[o + 3] = Math.round(Math.min(1, A) * 255);
    }
  }
  return out;
}

// --------------------------------------------------------------------- PNG
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- ICO
function encodeIco(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size;
    head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

// -------------------------------------------------------------------- main
const scene = buildScene(parseXml(readFileSync(SVG_PATH, 'utf8')));
if (scene.vb[2] !== scene.vb[3]) throw new Error('make-icon: viewBox must be square');
mkdirSync(outDir, { recursive: true });
const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(render(scene, size), size) }));
const png256 = entries[entries.length - 1].png;
writeFileSync(resolve(outDir, 'pager.png'), png256);
writeFileSync(resolve(outDir, 'pager.ico'), encodeIco(entries));

// verify
const ico = readFileSync(resolve(outDir, 'pager.ico'));
const fail = (m) => { console.error('make-icon: verification failed: ' + m); process.exit(1); };
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) fail('bad ICO header');
const count = ico.readUInt16LE(4);
if (count !== ICO_SIZES.length) fail('expected ' + ICO_SIZES.length + ' entries, got ' + count);
const seen = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const size = ico[o] || 256;
  const len = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
  if (off + len > ico.length) fail('entry ' + size + ' out of range');
  const png = ico.subarray(off, off + len);
  if (png.readUInt32BE(0) !== 0x89504e47) fail('entry ' + size + ' is not a PNG');
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) fail('entry ' + size + ' has wrong IHDR size');
  seen.push(size);
}
if (seen.join() !== ICO_SIZES.join()) fail('sizes ' + seen.join());
const pngBuf = readFileSync(resolve(outDir, 'pager.png'));
if (pngBuf.readUInt32BE(16) !== 256 || pngBuf.readUInt32BE(20) !== 256) fail('pager.png not 256x256');
console.log('pager.png ' + pngBuf.length + ' B; pager.ico ' + ico.length + ' B; sizes ' + seen.join(', '));
