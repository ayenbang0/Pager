// Pager UI icon set + brand marks. One smooth vector style: 16x16 grid, fill none,
// stroke currentColor 1.45, round caps/joins, class `ico`. No pixel art anywhere.
//
// API
//   icon(name, size?, cls?)  -> SVGElement   (unknown name -> neutral rounded square, never throws)
//   iconHTML(name, size?, cls?) -> string
//   ICONS                    -> { name: inner svg markup }
//   markEl(size = 16)        -> SVGElement   Pager mark; markup of desktop/assets/pager-mark.svg
//                                            with per-instance unique gradient ids
//   MARK_SVG                 -> string       pager-mark.svg verbatim (keep in sync with the file)
//   agentTile(kind, size = 20) -> SVGElement rounded-square brand tile: omp claude opencode hermes custom pager shell
//   ompWordmark(height = 44) -> SVGElement   big two-column "TT" omp mark (fill currentColor)
//   pagerWordmark(size = 22) -> HTMLElement  mark + "pager" in Geist 600
//
// Names (aliases in brackets):
//   activity arrow-down arrow-left arrow-right arrow-up back forward bell bell-off bolt box
//   branch brain check check-circle chev-down [chev-d] chev-right [chev-r] chev-up [chev-u]
//   chev-left [chev-l] clock close [x] code columns commit copy cpu database diff download
//   upload ellipsis eye eye-off file file-code file-plus files folder folder-open folder-plus
//   globe grid home info keyboard layers layout-rail layout-float layout-tiles layout-studio
//   link lock unlock mic mic-off minus maximize restore moon sun monitor palette pin pin-off
//   plus puzzle python refresh search send server sliders sparkle split-right split-down
//   square terminal trash user warn [alert] error edit external notebook board tasks screen
//   plug slash stop play sidebar changes spinner sort filter undo redo stash tag star
//   drag-grip pager book hash wand rocket shield zap list table image markdown json
//   help enter bookmark clipboard history key cloud bug merge save
//   win-min win-max win-restore win-close   (caption glyphs: 10x10 box, 1px butt strokes, default size 10)
import { fromHTML } from './dom.js'

const R = (x, y, w, h, rx = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''}/>`
const C = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`
const P = (d) => `<path d="${d}"/>`
const DOT = (cx, cy, r = 0.95) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`

const FILE_BODY = 'M9 1.8H4.2A1.4 1.4 0 0 0 2.8 3.2v9.6a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V5.8zM9 1.8v4h4.2'
const FOLDER_BODY = 'M2.2 4.4a1.3 1.3 0 0 1 1.3-1.3h2.6l1.4 1.6h5.2a1.3 1.3 0 0 1 1.3 1.3v5.7a1.3 1.3 0 0 1-1.3 1.3H3.5a1.3 1.3 0 0 1-1.3-1.3z'
const BELL_BODY = 'M3.6 11.4 4.6 10V7a3.4 3.4 0 0 1 6.8 0v3l1 1.4zM6.5 13.4a1.6 1.6 0 0 0 3 0'
const MIC_BODY = R(6, 1.8, 4, 7.4, 2) + P('M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14M5.8 14h4.4')
const PIN_BODY = 'M6.2 2.5h3.6l-.4 4 2 2.2v.8H4.6v-.8l2-2.2zM8 9.7v4.3'
const PY_PIECE = 'M5.7 5.3V4.2a1.7 1.7 0 0 1 1.7-1.7h1.3a1.7 1.7 0 0 1 1.7 1.7v2.4a1.5 1.5 0 0 1-1.5 1.5H5.2A1.7 1.7 0 0 0 3.5 9.8v.4'
const SPARK = (cx, cy, r) => `M${cx} ${cy - r}Q${cx + r * 0.1} ${cy - r * 0.1} ${cx + r} ${cy}Q${cx + r * 0.1} ${cy + r * 0.1} ${cx} ${cy + r}Q${cx - r * 0.1} ${cy + r * 0.1} ${cx - r} ${cy}Q${cx - r * 0.1} ${cy - r * 0.1} ${cx} ${cy - r}z`

export const ICONS = {
  activity: P('M1.8 8h2.6l2-5 3.2 10 2-5h2.6'),
  'arrow-down': P('M8 3v10M4 9l4 4 4-4'),
  'arrow-left': P('M13 8H3M7 4 3 8l4 4'),
  'arrow-right': P('M3 8h10M9 4l4 4-4 4'),
  'arrow-up': P('M8 13V3M4 7l4-4 4 4'),
  back: P('M9.5 3 4.5 8l5 5'),
  forward: P('M6.5 3l5 5-5 5'),
  bell: P(BELL_BODY),
  'bell-off': P(BELL_BODY + 'M2.5 2.5l11 11'),
  bolt: P('M9 1.8 3.8 9h3.9L7 14.2 12.2 7H8.3z'),
  box: P('M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.8 5 8 8l5.2-3M8 8v6'),
  branch: C(5, 3.4, 1.6) + C(5, 12.6, 1.6) + C(11.5, 5.4, 1.6) + P('M5 5v6M11.5 7c0 3-6.5 2-6.5 4'),
  brain: P('M8 3.2a2.2 2.2 0 0 0-4.2.8A2.5 2.5 0 0 0 3 8.6a2.5 2.5 0 0 0 2.4 3.9A2.2 2.2 0 0 0 8 12.8M8 3.2a2.2 2.2 0 0 1 4.2.8 2.5 2.5 0 0 1 .8 4.6 2.5 2.5 0 0 1-2.4 3.9A2.2 2.2 0 0 1 8 12.8M8 3.2v9.6M5 7.4h3M8 9.6h3'),
  check: P('M3 8.5l3.2 3.2L13 4.5'),
  'check-circle': C(8, 8, 6) + P('M5.2 8.2l2 2 3.6-4'),
  'chev-down': P('M4 6l4 4 4-4'),
  'chev-right': P('M6 4l4 4-4 4'),
  'chev-up': P('M4 10l4-4 4 4'),
  'chev-left': P('M10 4 6 8l4 4'),
  clock: C(8, 8, 6) + P('M8 4.5V8l2.3 1.5'),
  close: P('M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4'),
  code: P('M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9.2 3.5 6.8 12.5'),
  columns: R(2, 2.8, 12, 10.4, 2.2) + P('M6 2.8v10.4M10 2.8v10.4'),
  commit: C(8, 8, 2.6) + P('M1.8 8h3.6M10.6 8h3.6'),
  copy: R(5.5, 5.5, 8, 8, 1.8) + P('M10.5 5.5v-.7A1.8 1.8 0 0 0 8.7 3H4.3a1.8 1.8 0 0 0-1.8 1.8v4.4A1.8 1.8 0 0 0 4.3 11h1.2'),
  cpu: R(4, 4, 8, 8, 1.5) + R(6.5, 6.5, 3, 3, 0.6) + P('M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2'),
  database: '<ellipse cx="8" cy="4" rx="5" ry="2"/>' + P('M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2'),
  diff: R(2.2, 2.2, 11.6, 11.6, 2.4) + P('M5 5.8h3M6.5 4.3v3M8.8 10.4H12'),
  download: P('M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11'),
  upload: P('M8 10.5v-8M4.5 6 8 2.5 11.5 6M2.5 13.5h11'),
  ellipsis: DOT(3.5, 8, 1.05) + DOT(8, 8, 1.05) + DOT(12.5, 8, 1.05),
  eye: P('M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z') + C(8, 8, 2),
  'eye-off': P('M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M4 5.2A10.8 10.8 0 0 0 1.5 8S4 12.5 8 12.5a6.4 6.4 0 0 0 2.6-.6M6.6 6.6a2 2 0 0 0 2.8 2.8M2.5 2.5l11 11'),
  file: P(FILE_BODY),
  'file-code': P(FILE_BODY + 'M6.3 8.8 5 10l1.3 1.2M9.7 8.8 11 10l-1.3 1.2'),
  'file-plus': P(FILE_BODY + 'M8 8.4v3.6M6.2 10.2h3.6'),
  files: P('M5.6 4V2.9a1.2 1.2 0 0 1 1.2-1.2h3.6l2.8 2.8v5.8a1.2 1.2 0 0 1-1.2 1.2h-1.8M2.8 5.2A1.2 1.2 0 0 1 4 4h3.2L10 6.8V13a1.2 1.2 0 0 1-1.2 1.2H4A1.2 1.2 0 0 1 2.8 13z'),
  folder: P(FOLDER_BODY),
  'folder-open': P('M2.2 11.8V4.4a1.3 1.3 0 0 1 1.3-1.3h2.6l1.4 1.6h4.3a1.3 1.3 0 0 1 1.3 1.3v1.1M3.5 13.2h8.7a1.3 1.3 0 0 0 1.2-.9l1.2-3.9a.9.9 0 0 0-.9-1.2H5.4a1.3 1.3 0 0 0-1.2.9l-2 4.4'),
  'folder-plus': P(FOLDER_BODY + 'M8 7.4v3.4M6.3 9.1h3.4'),
  globe: C(8, 8, 6) + P('M2 8h12M8 2c2 1.7 2.8 3.7 2.8 6s-.8 4.3-2.8 6c-2-1.7-2.8-3.7-2.8-6S6 3.7 8 2z'),
  grid: R(2.5, 2.5, 4.5, 4.5, 1.2) + R(9, 2.5, 4.5, 4.5, 1.2) + R(2.5, 9, 4.5, 4.5, 1.2) + R(9, 9, 4.5, 4.5, 1.2),
  home: P('M2.5 7.3 8 2.6l5.5 4.7V13a1.2 1.2 0 0 1-1.2 1.2H3.7A1.2 1.2 0 0 1 2.5 13zM6.5 14.2v-4h3v4'),
  info: C(8, 8, 6) + P('M8 7.4v3.6M8 5.2h.01'),
  keyboard: R(1.5, 3.5, 13, 9, 2) + P('M4.6 6.4h.01M7 6.4h.01M9.4 6.4h.01M11.4 6.4h.01M5 9.8h6'),
  layers: P('M8 2 2 5.2l6 3.2 6-3.2zM2 8.2l6 3.2 6-3.2M2 11l6 3.2 6-3.2'),
  'layout-rail': R(2, 2.8, 12, 10.4, 2.2) + P('M5.7 2.8v10.4M8.2 6h3.6M8.2 8.6h2.4'),
  'layout-float': R(2, 2.8, 12, 10.4, 2.2) + R(5, 5, 6, 2.4, 1.2),
  'layout-tiles': R(2.2, 2.2, 5.2, 11.6, 1.6) + R(8.6, 2.2, 5.2, 5.2, 1.6) + R(8.6, 8.6, 5.2, 5.2, 1.6),
  'layout-studio': R(2, 2.8, 12, 10.4, 2.2) + P('M2 6.2h12M8 6.2v7'),
  link: P('M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7'),
  lock: R(3.5, 7, 9, 6.6, 1.8) + P('M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7M8 9.6v1.2'),
  unlock: R(3.5, 7, 9, 6.6, 1.8) + P('M5.3 7V5.3a2.7 2.7 0 0 1 5.2-.9M8 9.6v1.2'),
  mic: MIC_BODY,
  'mic-off': MIC_BODY + P('M2.5 2.5l11 11'),
  minus: P('M3.5 8h9'),
  maximize: P('M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9'),
  restore: R(2.5, 5.5, 8, 8, 1.8) + P('M5.5 5.5V4.3a1.8 1.8 0 0 1 1.8-1.8h5.4a1.8 1.8 0 0 1 1.8 1.8v5.4a1.8 1.8 0 0 1-1.8 1.8h-2.2'),
  moon: P('M13.2 9.4A5.8 5.8 0 0 1 6.6 2.8a5.8 5.8 0 1 0 6.6 6.6z'),
  sun: C(8, 8, 2.7) + P('M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1'),
  monitor: R(1.8, 2.8, 12.4, 8.4, 1.8) + P('M5.5 13.8h5M8 11.2v2.6'),
  palette: P('M8 2a6 6 0 1 0 0 12c1 0 1.5-.7 1.5-1.4 0-.9-.7-1.1-.7-1.9 0-.8.7-1.3 1.5-1.3H12a2.2 2.2 0 0 0 2.2-2.2C14.2 4.6 11.5 2 8 2zM5 7.4h.01M7.2 4.8h.01M10.4 5h.01'),
  pin: P(PIN_BODY),
  'pin-off': P(PIN_BODY + 'M2.5 2.5l11 11'),
  plus: P('M8 3.5v9M3.5 8h9'),
  puzzle: P('M3 4.5h3.2V3.4A1.4 1.4 0 0 1 9 3.4v1.1h3v3.1a1.4 1.4 0 0 1 0 2.8v3.1H9.2A1.4 1.4 0 0 0 6.4 13.5H3v-3.1a1.4 1.4 0 0 0 0-2.8z'),
  python: P(PY_PIECE) + `<g transform="rotate(180 8 8)">${P(PY_PIECE)}</g>` + P('M7.1 4.5h.01M8.9 11.5h.01'),
  refresh: P('M13.5 8a5.5 5.5 0 0 1-9.6 3.7M2.5 8a5.5 5.5 0 0 1 9.6-3.7M12.3 1.8v2.8H9.5M3.7 14.2v-2.8h2.8'),
  search: C(7, 7, 4.5) + P('M10.4 10.4l3.4 3.4'),
  send: P('M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z'),
  server: R(2.5, 2.8, 11, 4, 1.5) + R(2.5, 9.2, 11, 4, 1.5) + P('M5 4.8h.01M5 11.2h.01'),
  sliders: P('M2.5 5h5.9M11.6 5h1.9M2.5 11h1.9M7.6 11h5.9') + C(10, 5, 1.6) + C(6, 11, 1.6),
  sparkle: P(SPARK(8, 8, 6.2)),
  'split-right': R(2, 2.8, 12, 10.4, 2.2) + P('M8 2.8v10.4'),
  'split-down': R(2, 2.8, 12, 10.4, 2.2) + P('M2 8h12'),
  square: R(3, 3, 10, 10, 2.2),
  terminal: R(1.8, 2.8, 12.4, 10.4, 2.2) + P('M4.8 6.3 7 8 4.8 9.7M8.4 10h3'),
  trash: P('M2.8 4.5h10.4M6.2 4.5V3a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.1a1.3 1.3 0 0 0 1.3 1.2h4.2a1.3 1.3 0 0 0 1.3-1.2l.6-8.1M6.7 7.3v4M9.3 7.3v4'),
  user: C(8, 5.3, 2.7) + P('M2.8 13.8a5.2 5.2 0 0 1 10.4 0'),
  warn: P('M6.9 2.9a1.3 1.3 0 0 1 2.2 0l4.6 8a1.3 1.3 0 0 1-1.1 2H3.4a1.3 1.3 0 0 1-1.1-2zM8 6.3v2.9M8 11.2h.01'),
  error: C(8, 8, 6) + P('M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4'),
  edit: P('M10.3 3.2l2.5 2.5-7.4 7.4-3.1.6.6-3.1zM9 4.5 11.5 7'),
  external: P('M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9v3a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h3'),
  notebook: R(3.5, 2, 9.5, 12, 1.8) + P('M6.2 2v12M8.8 5.5h2.4M8.8 8h2.4'),
  board: R(2, 2.5, 12, 11, 2) + P('M5.2 5.5v5M8 5.5v3M10.8 5.5v6'),
  tasks: R(2, 2.5, 12, 11, 2) + P('M2 6.2h12M5 9h2.5M5 11.4h4M11 9h.01'),
  screen: P('M8 12.5H3.9a1.7 1.7 0 0 1-1.7-1.7V4.5a1.7 1.7 0 0 1 1.7-1.7h8.2a1.7 1.7 0 0 1 1.7 1.7V8M9 8.8l4.8 1.9-2 .8 1.2 2.1-1 .6-1.2-2.1-1.6 1.3z'),
  plug: P('M6 2v3.5M10 2v3.5M4 5.5h8V8a4 4 0 0 1-8 0zM8 12v2.2'),
  slash: P('M10.6 2.4 5.4 13.6'),
  ban: C(8, 8, 6) + P('M3.8 3.8l8.4 8.4'),
  stop: R(4, 4, 8, 8, 2),
  play: P('M5 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z'),
  sidebar: R(2, 2.8, 12, 10.4, 2.2) + P('M6 2.8v10.4'),
  changes: P('M8 2.5v6M5 5.5h6M5 12.5h6'),
  spinner: P('M8 2a6 6 0 1 1-6 6'),
  sort: P('M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5'),
  filter: P('M2 3h12l-4.6 5.4v4.1L6.6 14V8.4z'),
  undo: P('M3.5 6.5h6a3.5 3.5 0 0 1 0 7H6M6 3.5l-3 3 3 3'),
  redo: P('M12.5 6.5h-6a3.5 3.5 0 0 0 0 7H10M10 3.5l3 3-3 3'),
  stash: P('M2.5 9.5h3.2l1 1.8h2.6l1-1.8h3.2v3a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2zM8 2.3v5.5M5.7 5.8 8 8.1l2.3-2.3'),
  tag: P('M2.5 8.2V3.7a1.2 1.2 0 0 1 1.2-1.2h4.5l5.3 5.3a1.2 1.2 0 0 1 0 1.7l-4.5 4.5a1.2 1.2 0 0 1-1.7 0zM5.5 5.5h.01'),
  star: P('M8 2l1.8 3.8 4.2.6-3 3 .7 4.2L8 11.6l-3.7 2 .7-4.2-3-3 4.2-.6z'),
  'drag-grip': [5, 8, 11].flatMap((x) => [4, 8, 12].map((y) => DOT(x, y, 0.95))).join(''),
  pager: P('M5.5 14V2.5h3a3.3 3.3 0 0 1 0 6.6h-3'),
  book: P('M3.5 13V3.5A1.5 1.5 0 0 1 5 2h7.5v9.5H5A1.5 1.5 0 0 0 3.5 13a1.5 1.5 0 0 0 1.5 1.5h7.5v-3'),
  hash: P('M6 2.5 5 13.5M11 2.5l-1 11M2.8 6h10.4M2.8 10h10.4'),
  wand: P('M2.8 13.2 9.5 6.5M12.5 2v3M11 3.5h3M4 3v2M3 4h2'),
  rocket: P('M8 1.8C10.8 3.2 12 6 11.6 9.2L10.2 10.6H5.8L4.4 9.2C4 6 5.2 3.2 8 1.8zM4.4 9.2 2.6 11.6l2.8-.4M11.6 9.2l1.8 2.4-2.8-.4M8 12v2.2') + C(8, 6.3, 1.1),
  shield: P('M8 1.8 13 3.6v4.2c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.6zM5.9 8.1l1.5 1.5 2.8-3'),
  zap: P('M9.5 2 4 9h8l-5.5 5'),
  list: P('M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01'),
  table: R(2, 2.5, 12, 11, 2) + P('M2 6.3h12M2 9.9h12M6.2 6.3v7.2'),
  image: R(2, 2.8, 12, 10.4, 2) + C(5.6, 6.2, 1.1) + P('M2.5 12l3.7-3.8 3 3 1.8-1.8 3 2.6'),
  markdown: R(1.5, 3.5, 13, 9, 2) + P('M4 10.5v-5l1.8 2.2 1.8-2.2v5M11.2 5.5V10M9.8 8.8l1.4 1.5 1.4-1.5'),
  json: P('M6 2.5C4.3 2.5 4.2 3.5 4.2 4.7v1.1c0 1-.7 2.2-1.7 2.2 1 0 1.7 1.2 1.7 2.2v1.1c0 1.2.1 2.2 1.8 2.2M10 2.5c1.7 0 1.8 1 1.8 2.2v1.1c0 1 .7 2.2 1.7 2.2-1 0-1.7 1.2-1.7 2.2v1.1c0 1.2-.1 2.2-1.8 2.2'),
  help: C(8, 8, 6) + P('M6.1 6.3a2 2 0 1 1 2.9 1.8c-.6.3-1 .8-1 1.5M8 11.6h.01'),
  enter: P('M13 3.5v5a1.5 1.5 0 0 1-1.5 1.5H3M6.2 6.8 3 10l3.2 3.2'),
  bookmark: P('M4.2 2.5h7.6v11.2L8 10.8l-3.8 2.9z'),
  clipboard: R(3, 3, 10, 11, 1.8) + R(5.8, 1.6, 4.4, 2.8, 1),
  history: P('M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.8v3h3M8 5v3.2l2 1.3'),
  key: C(5, 11, 2.6) + P('M6.9 9.1 13.5 2.5M11.3 4.7l1.8 1.8M9.4 6.6l1.4 1.4'),
  cloud: P('M4.6 12.5A3.1 3.1 0 0 1 4.3 6.3 4.2 4.2 0 0 1 12.2 7a2.8 2.8 0 0 1-.4 5.5z'),
  bug: '<ellipse cx="8" cy="9.2" rx="3.2" ry="4"/>' + P('M6 3.5 7 5M10 3.5 9 5M4.8 7H2.5M11.2 7h2.3M4.8 11H2.5M11.2 11h2.3M8 5.2v8'),
  merge: C(4.5, 3.4, 1.6) + C(4.5, 12.6, 1.6) + C(11.5, 10, 1.6) + P('M4.5 5v6M4.5 5.5c0 3 7 1.2 7 3'),
  save: P('M3.8 2.5h6.8l2.7 2.7v7.3a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3V3.8a1.3 1.3 0 0 1 1.3-1.3zM5.5 2.5v3.2h4.2V2.5M5.2 13.7V9.5h5.6v4.2'),
  // window caption glyphs (10x10 box; see META)
  'win-min': P('M0 5.5h10'),
  'win-max': R(0.5, 0.5, 9, 9),
  'win-restore': P('M2.5 2.5V.5h7v7h-2') + R(0.5, 2.5, 7, 7),
  'win-close': P('M0 0l10 10M10 0 0 10'),
}

// Aliases kept as one-liners so callers can use either spelling.
const ALIASES = { x: 'close', alert: 'warn', 'chev-d': 'chev-down', 'chev-u': 'chev-up', 'chev-l': 'chev-left', 'chev-r': 'chev-right' }
for (const k in ALIASES) ICONS[k] = ICONS[ALIASES[k]]

const WIN_META = { vb: 10, sw: 1, size: 10, cap: 'butt', join: 'miter' }
const META = { 'win-min': WIN_META, 'win-max': WIN_META, 'win-restore': WIN_META, 'win-close': WIN_META }
const FALLBACK = R(3, 3, 10, 10, 2.5)

export function iconHTML(name, size, cls = '') {
  const known = Object.hasOwn(ICONS, name)
  const m = (known && META[name]) || null
  const vb = m ? m.vb : 16
  const s = size ?? (m ? m.size : 16)
  const body = known ? ICONS[name] : FALLBACK
  return `<svg class="ico${known ? ` ico-${name}` : ''}${cls ? ` ${cls}` : ''}" viewBox="0 0 ${vb} ${vb}" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="${m ? m.sw : 1.45}" stroke-linecap="${m ? m.cap : 'round'}" stroke-linejoin="${m ? m.join : 'round'}" aria-hidden="true" focusable="false">${body}</svg>`
}

export const icon = (name, size, cls) => fromHTML(iconHTML(name, size, cls))

// ---------------------------------------------------------------- Pager mark
// desktop/assets/pager-mark.svg verbatim. Keep in sync with the file.
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>
    <linearGradient id="pg" x1="12" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7fd4ff"/><stop offset="1" stop-color="#5a7bff"/></linearGradient>
  </defs>
  <path d="M23 50V14h14.5a10.5 10.5 0 0 1 0 21H23" stroke="url(#pg)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

let uidN = 0
const uniq = (svg) => {
  const n = ++uidN
  return svg.replace(/\bid="([^"]+)"/g, (_, id) => `id="${id}-m${n}"`).replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${id}-m${n})`)
}

/** The Pager mark as an inline SVG; gradient ids are unique per instance. */
export function markEl(size = 16) {
  const el = fromHTML(uniq(MARK_SVG))
  el.setAttribute('width', size)
  el.setAttribute('height', size)
  el.setAttribute('class', 'pager-mark')
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('focusable', 'false')
  return el
}

// ------------------------------------------------------------- agent tiles
// 24x24 rounded squares; marks are original simplified vector shapes.
const TT = (x, y, w, bar, stem, rx, fill) => {
  const half = w / 2
  return `<rect x="${x}" y="${y}" width="${w}" height="${bar}" rx="${rx}" fill="${fill}"/><rect x="${x + half - stem / 2}" y="${y}" width="${stem}" height="${w * 1.55}" rx="${rx}" fill="${fill}"/>`
}
const WHITE = '#fff'
const TILES = {
  omp: { bg: '#2f6df6', mark: TT(4.2, 6, 7, 2.2, 2.2, 0.7, WHITE) + TT(12.8, 6, 7, 2.2, 2.2, 0.7, WHITE) },
  claude: {
    bg: '#d97757',
    mark: Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4
      const r = i % 2 ? 4.6 : 6.2
      return `<path d="M12 12L${(12 + Math.sin(a) * r).toFixed(2)} ${(12 - Math.cos(a) * r).toFixed(2)}" stroke="${WHITE}" stroke-width="1.9" stroke-linecap="round"/>`
    }).join(''),
  },
  opencode: {
    bg: '#17191f',
    ring: 'rgba(255,255,255,.16)',
    mark: `<rect x="7" y="5.5" width="10" height="13" rx="2.4" fill="none" stroke="${WHITE}" stroke-width="2"/><rect x="10.2" y="10" width="3.6" height="4" rx=".8" fill="#7b8190"/>`,
  },
  hermes: {
    bg: '#6b4df0',
    mark: ['M6 15.6c3-.3 6-2.6 8-7', 'M9 18c3.2-.6 6.2-3 8.2-7.5', 'M12.6 18.4c2.8-.9 5.2-3.2 6.4-6.6'].map((d) => `<path d="${d}" fill="none" stroke="${WHITE}" stroke-width="1.8" stroke-linecap="round"/>`).join(''),
  },
  custom: { bg: '#7b8190', mark: `<path d="${SPARK(12, 12, 6.4)}" fill="${WHITE}" stroke="${WHITE}" stroke-width="1" stroke-linejoin="round"/>` },
  pager: {
    bg: '#0b0c10',
    ring: 'rgba(255,255,255,.14)',
    // pager-mark.svg geometry (64 box) scaled into the tile, gradient shared per tile
    mark: `<g transform="translate(12 12.4) scale(.33) translate(-30 -32)"><path d="M23 50V14h14.5a10.5 10.5 0 0 1 0 21H23" fill="none" stroke="url(#@pg)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></g>`,
    defs: '<linearGradient id="@pg" x1="12" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7fd4ff"/><stop offset="1" stop-color="#5a7bff"/></linearGradient>',
  },
  shell: {
    bg: '#4a505c',
    mark: `<path d="M7 8.6 10.6 12 7 15.4M12.4 16h4.8" fill="none" stroke="${WHITE}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
}

/** Rounded-square brand tile for an agent kind: omp, claude, opencode, hermes, custom, pager, shell. */
export function agentTile(kind, size = 20) {
  const t = TILES[kind] || TILES.custom
  const n = ++uidN
  const sheen = `ts${n}`
  const defs = (t.defs || '').replaceAll('@pg', `pg${n}`)
  const mark = t.mark.replaceAll('@pg', `pg${n}`)
  const ring = t.ring || 'rgba(0,0,0,.14)'
  return fromHTML(
    `<svg class="agent-tile at-${TILES[kind] ? kind : 'custom'}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
      `<defs><linearGradient id="${sheen}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>${defs}</defs>` +
      `<rect width="24" height="24" rx="6.5" fill="${t.bg}"/><rect width="24" height="24" rx="6.5" fill="url(#${sheen})"/>${mark}` +
      `<rect x=".4" y=".4" width="23.2" height="23.2" rx="6.1" fill="none" stroke="${ring}" stroke-width=".8"/></svg>`,
  )
}

// --------------------------------------------------------------- wordmarks
/** The big omp "TT" mark (two columns). Inherits currentColor; ~44px high. */
export function ompWordmark(height = 44) {
  const w = (height * 60) / 44
  return fromHTML(
    `<svg class="omp-wordmark" viewBox="0 0 60 44" width="${w.toFixed(2)}" height="${height}" fill="currentColor" aria-hidden="true" focusable="false">` +
      `<rect x="0" y="0" width="26" height="9.5" rx="2.2"/><rect x="8.25" y="0" width="9.5" height="44" rx="2.2"/>` +
      `<rect x="34" y="0" width="26" height="9.5" rx="2.2"/><rect x="42.25" y="0" width="9.5" height="44" rx="2.2"/></svg>`,
  )
}

/** Pager mark + "pager" in Geist 600. */
export function pagerWordmark(size = 22) {
  const el = document.createElement('span')
  el.className = 'pager-wordmark'
  el.style.cssText = `display:inline-flex;align-items:center;gap:${Math.round(size * 0.32)}px;font:600 ${size}px/1 var(--sans);letter-spacing:-.02em;color:inherit`
  el.append(markEl(Math.round(size * 1.15)), document.createTextNode('pager'))
  return el
}
