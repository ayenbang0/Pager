import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrapRows } from '../../docs/view.js'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import {
  ago,
  charCount,
  commandRow,
  docRowSegs,
  editorRowSegs,
  emptyListRows,
  frameBottom,
  frameTop,
  listFooter,
  listSummary,
  modePill,
  peerPill,
  peerPills,
  statusRow,
  syncPill,
  type DocRowInput,
} from './docsChrome.js'
import { segsWidth, type Seg } from '../kit/segs.js'

const text = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('')
const doc = (over: Partial<DocRowInput> = {}): DocRowInput => ({ name: 'notes.md', where: '#team', length: 1234, lastEdit: 0, peers: [], unsent: false, ...over })
const WIDTHS = [120, 80, 60, 38, 20, 12]

test('every list row is exactly the width: selected or not, long and wide names, peers and unsent', () => {
  const names = ['a.md', 'a-very-long-document-name-that-keeps-going-and-going.md', '漢字漢字漢字漢字漢字漢字漢字漢字.md', '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂.md']
  const peers = [{ name: 'alice', color: '#ff00aa' }, { name: 'bob', color: '#00aaff' }, { name: 'carol', color: '#aaff00' }]
  for (const width of WIDTHS) {
    for (const name of names) {
      for (const selected of [false, true]) {
        for (const extra of [{}, { peers, unsent: true }]) {
          assert.equal(segsWidth(docRowSegs(doc({ name, ...extra }), selected, width, 1_000_000, theme)), width, `${name} ${width} ${selected}`)
        }
      }
    }
  }
})

test('the selected row is the accent bar with the marker; others are not', () => {
  const on = docRowSegs(doc(), true, 60, 0, theme)
  assert.equal(on[0]?.text, '▎')
  assert.equal(on[0]?.bg, theme.band.bg)
  const off = docRowSegs(doc(), false, 60, 0, theme)
  assert.equal(off[0]?.bg, undefined)
  assert.ok(text(on).includes('notes.md'))
})

test('a narrow row drops size and chat before it drops the name', () => {
  const wide = text(docRowSegs(doc(), false, 120, 0, theme))
  assert.ok(wide.includes('1.2k chars') && wide.includes('#team'))
  const narrow = text(docRowSegs(doc(), false, 24, 0, theme))
  assert.ok(narrow.includes('notes.md'))
  assert.ok(!narrow.includes('chars'))
})

test('live editors and unsent edits show as pills on the row', () => {
  const row = docRowSegs(doc({ peers: [{ name: 'alice', color: '#ff00aa' }], unsent: true }), false, 120, 0, theme)
  assert.ok(text(row).includes('● alice'))
  assert.ok(text(row).includes('unsent'))
  assert.equal(row.find((s) => s.text.includes('alice'))?.bg, '#ff00aa')
})

test('peer pills are filled with the author color and cap with +N', () => {
  const pill = peerPill({ name: 'zed', color: '#102030' })
  assert.equal(pill.bg, '#102030')
  assert.equal(pill.color, '#ffffff')
  const many = peerPills([{ name: 'a', color: '#111111' }, { name: 'b', color: '#222222' }, { name: 'c', color: '#333333' }], 2, theme)
  assert.ok(text(many).includes('+1'))
})

test('mode pills use distinct colors: normal accent, insert success, visual accent2', () => {
  assert.equal(modePill('normal', theme).bg, theme.pill.accent.bg)
  assert.equal(modePill('insert', theme).bg, theme.pill.success.bg)
  assert.equal(modePill('visual', theme).bg, theme.pill.accent2.bg)
  assert.equal(modePill('vline', theme).bg, theme.pill.accent2.bg)
  assert.equal(modePill('insert', theme).text, ' INSERT ')
})

test('sync pill reads synced or unsent', () => {
  assert.equal(syncPill(false, theme).text, ' ✓ synced ')
  assert.equal(syncPill(true, theme).text, ' ● unsent ')
})

test('frame borders are exactly the width and carry the mode and sync pills', () => {
  for (const width of WIDTHS) {
    const top = frameTop(width, modePill('normal', theme), syncPill(false, theme), theme)
    assert.ok(segsWidth(top) <= width, `top ${width}`)
    if (width >= 30) assert.equal(segsWidth(top), width, `top ${width}`)
    assert.equal(segsWidth(frameBottom(width, theme)), width, `bottom ${width}`)
  }
  const wide = text(frameTop(80, modePill('insert', theme), syncPill(true, theme), theme))
  assert.ok(wide.startsWith('╭─') && wide.endsWith('─╮') && wide.includes('INSERT') && wide.includes('unsent'))
  assert.ok(text(frameBottom(40, theme)).startsWith('╰') && text(frameBottom(40, theme)).endsWith('╯'))
})

test('editor rows: dim numbers, glow on the cursor line, inverse cursor cell, accent band selection', () => {
  const body = 'hello world\nsecond'
  const rows = wrapRows(body, 40)
  const first = rows[0]!
  const plain = editorRowSegs(body, first, { gutter: 3, onCursorLine: false, kind: 'text', cursor: 99, sel: null }, theme)
  assert.equal(plain[0]?.text, ' 1 ')
  assert.equal(plain[0]?.color, theme.dim)
  const at = editorRowSegs(body, first, { gutter: 3, onCursorLine: true, kind: 'text', cursor: 1, sel: null }, theme)
  assert.equal(at[0]?.color, theme.glow)
  assert.equal(at[0]?.bold, true)
  assert.equal(at.find((s) => s.inverse)?.text, 'e')
  const picked = editorRowSegs(body, first, { gutter: 3, onCursorLine: true, kind: 'text', cursor: 0, sel: { start: 2, end: 5 } }, theme)
  const band = picked.find((s) => s.bg === theme.band.bg)
  assert.equal(band?.text, 'llo')
  assert.equal(band?.color, theme.band.fg)
})

test('editor rows style Markdown kinds and blank rows keep a cell', () => {
  const heading = editorRowSegs('# Title', wrapRows('# Title', 40)[0]!, { gutter: 3, onCursorLine: false, kind: 'heading', cursor: 99, sel: null }, theme)
  assert.equal(heading[1]?.color, theme.accent)
  assert.equal(heading[1]?.bold, true)
  const blank = editorRowSegs('', wrapRows('', 40)[0]!, { gutter: 3, onCursorLine: false, kind: 'text', cursor: 99, sel: null }, theme)
  assert.equal(text(blank), ' 1  ')
})

test('a wrapped continuation row has a blank gutter', () => {
  const long = 'word '.repeat(20)
  const rows = wrapRows(long, 20)
  assert.ok(rows.length > 1)
  const cont = editorRowSegs(long, rows[1]!, { gutter: 4, onCursorLine: false, kind: 'text', cursor: 0, sel: null }, theme)
  assert.equal(cont[0]?.text, '    ')
})

test('the status row is exactly the width with position, name, tinted peers and the message', () => {
  const input = { line: 12, col: 4, name: 'notes.md', peers: [{ name: 'alice', color: '#ff00aa' }], message: 'copied', pending: '' }
  for (const width of WIDTHS) assert.equal(segsWidth(statusRow(input, width, theme)), width, `status ${width}`)
  const row = statusRow(input, 100, theme)
  assert.ok(text(row).includes('12:4') && text(row).includes('notes.md') && text(row).includes('● alice') && text(row).includes('copied'))
  assert.equal(row.find((s) => s.text.includes('alice'))?.bg, '#ff00aa')
  const pending = statusRow({ ...input, message: '', pending: '2d' }, 100, theme)
  assert.ok(text(pending).includes('2d'))
})

test('a very long message never pushes the position off the row', () => {
  const row = statusRow({ line: 1, col: 1, name: 'n.md', peers: [], message: 'x'.repeat(500), pending: '' }, 60, theme)
  assert.equal(segsWidth(row), 60)
  assert.ok(text(row).includes('1:1'))
})

test('the command row shows the prefix, the tail of long text and a cursor block, exactly the width', () => {
  for (const width of [80, 20, 8]) {
    const row = commandRow(':', 'w'.repeat(200), width, theme)
    assert.equal(segsWidth(row), width)
    assert.equal(row.find((s) => s.inverse)?.text, ' ')
  }
  const short = commandRow('/', 'foo', 40, theme)
  assert.ok(text(short).startsWith(' /foo'))
  assert.equal(segsWidth(commandRow(':', '漢字漢字漢字漢字', 12, theme)), 12)
})

test('list summary, empty state and footer fit the width', () => {
  for (const width of WIDTHS) {
    assert.equal(segsWidth(listSummary({ docs: 3, live: 1, unsent: 2 }, width, theme)), width)
    assert.equal(segsWidth(listFooter(width, theme)), width)
    for (const row of emptyListRows(width, theme)) assert.equal(segsWidth(row), width)
  }
  assert.ok(text(listSummary({ docs: 1, live: 0, unsent: 0 }, 80, theme)).includes('1 doc '))
  assert.ok(text(listSummary({ docs: 3, live: 1, unsent: 2 }, 120, theme)).includes('● 1 live'))
})

test('ago and charCount', () => {
  assert.equal(ago(0, 5), 'new')
  assert.equal(ago(1000, 1500), 'just now')
  assert.equal(ago(0 + 1, 3 * 60_000), '2m ago')
  assert.equal(ago(1, 2 * 3_600_000), '1h ago')
  assert.equal(ago(1, 3 * 86_400_000), '2d ago')
  assert.equal(charCount(812), '812')
  assert.equal(charCount(1234), '1.2k')
  assert.equal(charCount(15_400), '15k')
})
