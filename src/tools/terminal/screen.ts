import type { IBufferCell } from '@xterm/headless'
import type { Seg } from '../../ui/kit/segs.js'
import type { XTerm } from './xterm.js'

export interface ScreenView {
  rows: Seg[][]
  /** Absolute buffer line of rows[0]. */
  top: number
  cursor: { x: number; y: number } | null
  alt: boolean
  atBottom: boolean
  /** The child asked for mouse reports. */
  mouse: boolean
  title: string
}

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
const BRIGHT = ['blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright'] as const

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40)

/** Palette 0-15 map to named colors so the user's terminal theme applies; 16-255 become fixed RGB. */
export function paletteColor(i: number): string {
  if (i < 8) return NAMES[i] ?? 'white'
  if (i < 16) return BRIGHT[i - 8] ?? 'whiteBright'
  if (i < 232) {
    const c = i - 16
    return hex((level(Math.floor(c / 36)) << 16) | (level(Math.floor(c / 6) % 6) << 8) | level(c % 6))
  }
  const g = 8 + (i - 232) * 10
  return hex((g << 16) | (g << 8) | g)
}

interface Cell {
  text: string
  style: Omit<Seg, 'text'>
  blank: boolean
}

function colorOf(rgb: boolean, palette: boolean, value: number): string | undefined {
  if (rgb) return hex(value)
  if (palette) return paletteColor(value)
  return undefined
}

function cellOf(c: IBufferCell): Cell {
  const style: Omit<Seg, 'text'> = {}
  const color = colorOf(c.isFgRGB(), c.isFgPalette(), c.getFgColor())
  const bg = colorOf(c.isBgRGB(), c.isBgPalette(), c.getBgColor())
  if (color !== undefined) style.color = color
  if (bg !== undefined) style.bg = bg
  if (c.isBold()) style.bold = true
  if (c.isDim()) style.dim = true
  if (c.isItalic()) style.italic = true
  if (c.isUnderline()) style.underline = true
  if (c.isStrikethrough()) style.strike = true
  if (c.isInverse()) style.inverse = true
  const width = Math.max(1, c.getWidth())
  const text = c.isInvisible() ? ' '.repeat(width) : c.getChars() || ' '
  return { text, style, blank: text.trim() === '' && Object.keys(style).length === 0 }
}

const same = (a: Omit<Seg, 'text'>, b: Omit<Seg, 'text'>): boolean =>
  a.color === b.color && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.inverse === b.inverse

/** Snapshot of the viewport as styled segment rows. The cursor cell is drawn inverse when visible. */
export function readScreen(term: XTerm, cursorHidden: boolean, title = ''): ScreenView {
  const buf = term.buffer.active
  const atBottom = buf.viewportY === buf.baseY
  const showCursor = atBottom && !cursorHidden
  const cy = buf.baseY + buf.cursorY - buf.viewportY
  const scratch = buf.getNullCell()
  const rows: Seg[][] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    const cells: Cell[] = []
    if (line !== undefined) {
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x, scratch)
        if (c === undefined || c.getWidth() === 0) continue
        const cell = cellOf(c)
        if (showCursor && y === cy && x === buf.cursorX) {
          cell.style = { ...cell.style, inverse: !cell.style.inverse || undefined }
          cell.blank = false
        }
        cells.push(cell)
      }
    }
    while (cells.length > 0 && cells[cells.length - 1]?.blank === true) cells.pop()
    const segs: Seg[] = []
    for (const cell of cells) {
      const last = segs[segs.length - 1]
      if (last !== undefined && same(last, cell.style)) last.text += cell.text
      else segs.push({ ...cell.style, text: cell.text })
    }
    rows.push(segs)
  }
  return {
    rows,
    top: buf.viewportY,
    cursor: showCursor ? { x: buf.cursorX, y: cy } : null,
    alt: buf.type === 'alternate',
    atBottom,
    mouse: term.modes.mouseTrackingMode !== 'none',
    title,
  }
}
