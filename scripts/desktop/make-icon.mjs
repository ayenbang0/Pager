// Writes desktop/assets/pager.png and pager.ico: the simple pixel P on a transparent 16x16-cell grid (cell = 16 px), no dependencies.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CELL = 16
const N = 16
const SIZE = CELL * N
const out = (name) => fileURLToPath(new URL(`../../desktop/assets/${name}`, import.meta.url))

// The simple pixel P: a 5x7 glyph drawn at 2x2 cells, OMP's blue to purple down its height, a one-cell cyan shadow, no tile.
const P = ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....']
const X0 = 2
const lerp = (a, b, t) => Math.round(a + (b - a) * t)
const from = [0x7a, 0xa2, 0xf7]
const to = [0xbb, 0x9a, 0xf7]
const isP = (cx, cy) => {
  const gx = Math.floor((cx - X0) / 2)
  const gy = Math.floor(cy / 2)
  return cx >= X0 && gx < 5 && gy >= 0 && gy < 7 && P[gy][gx] === '#'
}

/** RGBA of one cell. */
function cell(cx, cy) {
  if (isP(cx, cy)) {
    const t = Math.floor(cy / 2) / 6
    return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t), 255]
  }
  if (isP(cx - 1, cy - 1)) return [0x2a, 0xc3, 0xde, 255]
  return [0, 0, 0, 0]
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  for (let x = 0; x < SIZE; x++) {
    const px = cell(Math.floor(x / CELL), Math.floor(y / CELL))
    const o = y * (SIZE * 4 + 1) + 1 + x * 4
    raw[o] = px[0]
    raw[o + 1] = px[1]
    raw[o + 2] = px[2]
    raw[o + 3] = px[3]
  }
}

const table = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// ICO with one PNG-compressed 256x256 image (width/height byte 0 means 256).
const head = Buffer.alloc(22)
head.writeUInt16LE(1, 2) // type: icon
head.writeUInt16LE(1, 4) // count
head[6] = 0
head[7] = 0
head.writeUInt16LE(1, 10) // planes
head.writeUInt16LE(32, 12) // bits per pixel
head.writeUInt32LE(png.length, 14)
head.writeUInt32LE(22, 18)

writeFileSync(out('pager.png'), png)
writeFileSync(out('pager.ico'), Buffer.concat([head, png]))
console.log(`pager.png ${png.length} bytes, pager.ico ${head.length + png.length} bytes`)
