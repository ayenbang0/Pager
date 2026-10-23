// Writes the Pager mark as 4-bit (16-colour) pixel art: the simple rounded P (same shape and size as before) on a 32x32 grid of 2-unit square pixels, coloured with a stepped, dithered
// purple-to-blue gradient and a lit top-left / shaded bottom-right edge. Every pixel is a whole rect on the 2-unit grid, no strokes.
// Usage: node scripts/logo/make-logo.mjs   (writes desktop/assets/pager.svg and pager-mark.svg)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop', 'assets')
// A 6.5-unit stroke is exactly 4 cells of 1.625 units. The grid is offset so the P's edges (x 19.75, y 10.75) fall on cell borders.
const CELL = 1.625
const OX = 0.25
const OY = 1

// The P is the earlier simple logo: a 6.5-unit round-capped stroke along M23 50 V14 H37.5 A10.5 10.5 0 0 1 37.5 35 H23. A cell is
// lit when its centre lies within half the stroke width of that centreline.
const HALF = 3.25
const seg = (x, y, x0, y0, x1, y1) => {
  const dx = x1 - x0, dy = y1 - y0
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
}
const inP = (x, y) => {
  let d = Math.min(seg(x, y, 23, 50, 23, 14), seg(x, y, 23, 14, 37.5, 14), seg(x, y, 37.5, 35, 23, 35))
  if (x >= 37.5) d = Math.min(d, Math.abs(Math.hypot(x - 37.5, y - 24.5) - 10.5))
  return d <= HALF
}

const N = Math.ceil(64 / CELL)
const on = Array.from({ length: N }, (_, j) => Array.from({ length: N }, (_, i) => inP(OX + (i + 0.5) * CELL, OY + (j + 0.5) * CELL)))
const at = (i, j) => on[j]?.[i] === true

// 4-bit palette: 16 colours in total, the tile background plus 5 blue-to-purple steps in three tones (lit / base / shade).
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const mix = (c, to, k) => c.map((v, n) => v + (to[n] - v) * k)
const STEPS = [[58, 160, 255], [86, 140, 255], [118, 118, 255], [150, 98, 255], [182, 80, 255]]
const RAMP = STEPS.map(hex)
const LIT = STEPS.map((c) => hex(mix(c, [255, 255, 255], 0.38)))
const SHADE = STEPS.map((c) => hex(mix(c, [0, 0, 0], 0.28)))
const BAYER = [[0, 2], [3, 1]]

const cells = []
let [minI, maxI, minJ, maxJ] = [N, 0, N, 0]
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (on[j][i]) { minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j) }
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  if (!on[j][i]) continue
  const t = ((i - minI) / (maxI - minI) * 0.4 + (j - minJ) / (maxJ - minJ) * 0.6)
  const band = Math.max(0, Math.min(RAMP.length - 1, Math.floor(t * RAMP.length + (BAYER[j & 1][i & 1] - 1.5) / 4)))
  const palette = !at(i, j - 1) || !at(i - 1, j) ? LIT : !at(i, j + 1) || !at(i + 1, j) ? SHADE : RAMP
  cells.push({ i, j, fill: palette[band] })
}
// Merge horizontal runs of the same colour into one rect each.
const rects = []
for (let j = 0; j < N; j++) {
  let run = null
  for (const c of cells.filter((c) => c.j === j)) {
    if (run && run.fill === c.fill && run.i + run.n === c.i) run.n++
    else { if (run) rects.push(run); run = { i: c.i, j, n: 1, fill: c.fill } }
  }
  if (run) rects.push(run)
}
const num = (v) => +v.toFixed(3)
const body = rects.map((r) => `<rect x="${num(OX + r.i * CELL)}" y="${num(OY + r.j * CELL)}" width="${num(r.n * CELL)}" height="${num(CELL)}" fill="${r.fill}"/>`).join('\n  ')
const svg = (tile) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" shape-rendering="crispEdges">\n  ${tile ? '<rect width="64" height="64" rx="16" fill="#0b0c10"/>\n  ' : ''}${body}\n</svg>\n`
fs.writeFileSync(path.join(out, 'pager.svg'), svg(true))
fs.writeFileSync(path.join(out, 'pager-mark.svg'), svg(false))
console.log('rects', rects.length)
