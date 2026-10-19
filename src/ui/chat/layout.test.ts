import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageView } from '../../app/engine.js'
import { DEFAULT_THEME, findTheme } from '../theme/themes.js'
import { buildLines, windowLines, type Line } from './layout.js'

const NOW = new Date(2024, 4, 10, 15, 0)
const T = DEFAULT_THEME

function msg(over: Partial<MessageView>): MessageView {
  return {
    key: 'k',
    ts: new Date(2024, 4, 10, 9, 5).getTime(),
    authorName: 'bob',
    authorKey: 'ab'.repeat(32),
    mine: false,
    kind: 'text',
    text: 'hi',
    status: null,
    ...over,
  }
}
const plain = (l: Line): string => l.segs.map((s) => s.text).join('')

/** What a row says, without the gutter bar, glyph and header decoration. */
const body = (l: Line): string => l.segs.filter((seg) => seg.chrome !== true).map((seg) => seg.text).join('')
const compact = { density: 'compact', badge: '', agentColors: {}, me: 'you' } as const

test('a message gets a header row with the speaker and time, and its body sits under the gutter bar', () => {
  const lines = buildLines([msg({ text: 'hello' })], 40, T, NOW)
  assert.deepEqual(lines.map(plain), ['▍ ● bob  09:05', '▍ hello'])
  assert.equal(lines[0]?.segs.find((seg) => seg.text === 'bob')?.bold, true)
})

test('wrapped body rows keep the gutter and stay within the width', () => {
  const lines = buildLines([msg({ text: 'aaaa bbbb cccc dddd eeee ffff' })], 20, T, NOW)
  assert.ok(lines.length > 2)
  for (const l of lines.slice(1)) assert.ok(plain(l).startsWith('▍ '))
  for (const l of lines) assert.ok(plain(l).length <= 20)
})

test('compact density keeps the speaker inline and aligns wrapped rows to the body column', () => {
  const lines = buildLines([msg({ text: 'aaaa bbbb cccc dddd eeee ffff' })], 30, T, NOW, undefined, compact)
  assert.equal(plain(lines[0]!).startsWith('▍ 09:05 ● bob  aaaa'), true)
  const bodyCol = '▍ 09:05 ● bob  '.length
  for (const l of lines.slice(1)) assert.equal(plain(l).startsWith(' '.repeat(bodyCol - 1)), false, 'the gutter bar stays in column 0')
  for (const l of lines.slice(1)) assert.equal(plain(l).slice(0, bodyCol).trim(), '▍')
  for (const l of lines) assert.ok(plain(l).length <= 30)
})

test('roomy density puts a blank row between speakers', () => {
  const roomy = { density: 'roomy', badge: '', agentColors: {}, me: 'you' } as const
  const lines = buildLines([msg({ key: '1', text: 'one' }), msg({ key: '2', authorName: 'ann', authorKey: 'aa'.repeat(32), text: 'two' })], 40, T, NOW, undefined, roomy)
  assert.equal(lines.filter((l) => plain(l).trim() === '').length, 1)
})

test('date prefix only when the message is not from today', () => {
  const old = msg({ ts: new Date(2024, 4, 9, 23, 59).getTime() })
  assert.equal(plain(buildLines([old], 60, T, NOW)[0]!).endsWith('05-09 23:59'), true)
})

test('own message status markers sit at the end of the last line', () => {
  const tick = (status: 'pending' | 'sent' | 'delivered' | 'read'): string => plain(buildLines([msg({ mine: true, status })], 40, T, NOW).at(-1)!)
  assert.equal(tick('pending').endsWith(' …'), true)
  assert.equal(tick('sent').endsWith(' ✓'), true)
  assert.equal(tick('sent').endsWith('✓✓'), false)
  assert.equal(tick('delivered').endsWith(' ✓✓'), true)
  assert.equal(tick('delivered').endsWith('✓✓✓'), false)
  assert.equal(tick('read').endsWith(' ✓✓✓'), true)
})

test('the status never changes how a message wraps', () => {
  const text = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ')
  const counts = (['pending', 'sent', 'delivered', 'read'] as const).map((status) => buildLines([msg({ mine: true, status, text })], 40, T, NOW).length)
  assert.deepEqual(new Set(counts).size, 1)
})

test('system messages are dim italic notes on the surface band, no author', () => {
  const [line] = buildLines([msg({ kind: 'system', text: 'bob left' })], 40, T, NOW)
  assert.equal(plain(line!).length, 40, 'the band fills the width')
  assert.equal(body(line!).trim(), 'bob left')
  const text = line?.segs.find((seg) => seg.text === 'bob left')
  assert.deepEqual({ dim: text?.color, italic: text?.italic, bg: text?.bg }, { dim: T.dim, italic: true, bg: T.surface })
})

test('tool summaries show each tool as a pill', () => {
  const [line] = buildLines([msg({ kind: 'system', authorName: 'pager', text: 'omp-ab12 used 3 tools (read 2, edit 1)' })], 60, T, NOW)
  assert.ok(line?.segs.some((seg) => seg.text === ' read 2 ' && seg.bg === T.pill.muted.bg))
  assert.ok(line?.segs.some((seg) => seg.text === ' edit 1 '))
})

test('author, gutter and status colors come from the theme', () => {
  const ocean = findTheme('ocean')!
  const mine = buildLines([msg({ mine: true, status: 'delivered' })], 40, ocean, NOW)
  assert.equal(mine[0]?.segs.find((seg) => seg.text === 'bob')?.color, ocean.mine)
  assert.equal(mine[0]?.segs[0]?.color, ocean.userBubble)
  assert.equal(mine.at(-1)?.segs.find((seg) => seg.text === ' ✓✓')?.color, ocean.success)
  const sent = buildLines([msg({ mine: true, status: 'sent' })], 40, ocean, NOW)
  assert.equal(sent.at(-1)?.segs.find((seg) => seg.text === ' ✓')?.color, ocean.dim)
  const read = buildLines([msg({ mine: true, status: 'read' })], 40, ocean, NOW)
  assert.equal(read.at(-1)?.segs.find((seg) => seg.text === ' ✓✓✓')?.color, ocean.accent)
  const other = buildLines([msg({})], 40, ocean, NOW)
  assert.ok(ocean.authors.includes(other[0]?.segs.find((seg) => seg.text === 'bob')?.color ?? ''))
})

test('an agent takes its personal color and the agent glyph', () => {
  const look = { density: 'cozy', badge: '', agentColors: { ui: '#ff00aa' }, me: 'you' } as const
  const [head] = buildLines([msg({ authorName: 'ui', agent: true })], 40, T, NOW, undefined, look)
  assert.equal(head?.segs.find((seg) => seg.text === 'ui')?.color, '#ff00aa')
  assert.ok(head?.segs.some((seg) => seg.text === '◆'))
})

test('your badge replaces the glyph on your own messages', () => {
  const look = { density: 'cozy', badge: '★', agentColors: {}, me: 'you' } as const
  const [head] = buildLines([msg({ mine: true })], 40, T, NOW, undefined, look)
  assert.ok(head?.segs.some((seg) => seg.text === '★'))
})

test('windowLines keeps the newest lines at offset 0 and clamps offsets', () => {
  const lines: Line[] = Array.from({ length: 10 }, (_, i) => ({ key: String(i), segs: [] }))
  assert.deepEqual(windowLines(lines, 4, 0).visible.map((l) => l.key), ['6', '7', '8', '9'])
  assert.deepEqual(windowLines(lines, 4, 2).visible.map((l) => l.key), ['4', '5', '6', '7'])
  const far = windowLines(lines, 4, 99)
  assert.equal(far.maxOffset, 6)
  assert.deepEqual(far.visible.map((l) => l.key), ['0', '1', '2', '3'])
  assert.deepEqual(windowLines(lines, 20, 5).visible.length, 10)
})

const long = (rows: number): string => Array.from({ length: rows }, (_, i) => `row ${i}`).join('\n')

test('a long text message folds to head + marker + tail; the marker row carries the fold key', () => {
  const lines = buildLines([msg({ text: long(40) })], 80, T, NOW)
  assert.equal(lines.length, 1 + 12 + 1 + 6, 'header, head, marker, tail')
  assert.deepEqual(lines.flatMap((l, i) => (l.fold === undefined ? [] : [i])), [13])
  assert.equal(lines[0]?.fold, undefined)
  assert.match(plain(lines[13]!), /▸ 22 more lines/)
  assert.equal(lines[13]?.fold, 'k')
  assert.match(plain(lines.at(-1)!), /row 39$/)
})

test('expanded, disabled and system messages are never folded', () => {
  assert.equal(buildLines([msg({ text: long(40) })], 80, T, NOW, { enabled: true, expanded: new Set(['k']) }).length, 41)
  assert.equal(buildLines([msg({ text: long(40) })], 80, T, NOW, { enabled: false, expanded: new Set() }).length, 41)
  assert.equal(buildLines([msg({ kind: 'system', text: long(40) })], 80, T, NOW).length, 40)
})

test('markdown messages render headings, bullets, code fences and inline spans', () => {
  const text = '# Title\n- item `x` and **b**\n```js\nlet a\n```'
  const [, ...lines] = buildLines([msg({ text, markdown: true })], 80, T, NOW)
  assert.deepEqual(lines.map((l) => body(l).trim()), ['Title', '• item x and b', 'js', 'let a'])
  assert.deepEqual(lines[0]?.segs.at(-1), { text: 'Title', bold: true, color: T.accent })
  assert.deepEqual(lines[1]?.segs.find((seg) => seg.text === 'x'), { text: 'x', color: T.info, bg: T.surface })
  assert.deepEqual(lines[1]?.segs.find((seg) => seg.text === 'b'), { text: 'b', bold: true })
  assert.ok(lines[3]?.segs.some((seg) => seg.color === T.info && seg.bg === T.surface), 'code sits on the surface band')
  assert.ok(lines[3]?.segs.some((seg) => seg.text === '▎' && seg.color === T.accent2), 'code has a colored left bar')
})

test('the same text without the markdown flag stays literal', () => {
  const [, ...lines] = buildLines([msg({ text: '# Title\n`x`' })], 80, T, NOW)
  assert.deepEqual(lines.map((l) => body(l).trim()), ['# Title', '`x`'])
})

test('a run of messages from one author names them once; a new speaker, or a system line between, names again', () => {
  const ann = 'aa'.repeat(32)
  const lines = buildLines(
    [
      msg({ key: '1', authorName: 'bob', text: 'one' }),
      msg({ key: '2', authorName: 'bob', text: 'two' }),
      msg({ key: '3', authorName: 'ann', authorKey: ann, text: 'three' }),
      msg({ key: '4', authorName: 'ann', authorKey: ann, text: 'four' }),
      msg({ key: '5', kind: 'system', text: 'ann left' }),
      msg({ key: '6', authorName: 'ann', authorKey: ann, text: 'five' }),
    ],
    60,
    T,
    NOW,
  )
  const heads = lines.filter((l) => l.key.endsWith(':head')).map(plain)
  assert.deepEqual(heads, ['▍ ● bob  09:05', '▍ ● ann  09:05', '▍ ● ann  09:05'])
  assert.deepEqual(lines.filter((l) => !l.key.endsWith(':head')).map((l) => body(l).trim()), ['one', 'two', 'three', 'four', 'ann left', 'five'])
})

test('a pause of five minutes names the speaker again', () => {
  const later = new Date(2024, 4, 10, 9, 20).getTime()
  const lines = buildLines([msg({ key: '1', text: 'one' }), msg({ key: '2', ts: later, text: 'two' })], 60, T, NOW)
  assert.equal(lines.filter((l) => l.key.endsWith(':head')).length, 2)
})

test('messages that share a key but not a name (agent runs, you/pager) each show their name', () => {
  const lines = buildLines(
    [msg({ key: '1', authorName: 'omp-1', text: 'a' }), msg({ key: '2', authorName: 'omp-2', text: 'b' }), msg({ key: '3', authorName: 'omp-2', text: 'c' })],
    60,
    T,
    NOW,
  )
  assert.deepEqual(lines.filter((l) => l.key.endsWith(':head')).map(plain), ['▍ ● omp-1  09:05', '▍ ● omp-2  09:05'])
})

test('reactions add one pill row under the message; none, no extra row', () => {
  const plainLines = buildLines([msg({ text: 'hello' })], 40, T, NOW)
  assert.deepEqual(plainLines.map(plain), ['▍ ● bob  09:05', '▍ hello'])
  const lines = buildLines([msg({ text: 'hello', reactions: [{ emoji: '🔥', count: 2, mine: true }, { emoji: '👍', count: 1, mine: false }] })], 40, T, NOW)
  assert.deepEqual(lines.map(plain), ['▍ ● bob  09:05', '▍ hello', '▍  🔥 2    👍 1 '])
  assert.equal(lines[2]?.key, 'k:react')
  const pills = lines[2]!.segs.filter((s) => s.bg !== undefined)
  assert.equal(pills[0]?.bg, T.pill.accent.bg, 'mine uses the accent pill')
  assert.equal(pills[1]?.bg, T.pill.muted.bg)
  assert.equal(lines[2]?.segs[0]?.chrome, true)
})

test('msg marks the header and body rows of reactable messages only', () => {
  const rows = buildLines([msg({ key: 'a:1', text: 'one\ntwo', reactable: true }), msg({ key: 'b:1', authorKey: 'cd'.repeat(32), text: 'plain' })], 40, T, NOW)
  assert.deepEqual(rows.map((l) => l.msg), ['a:1', 'a:1', 'a:1', undefined, undefined])
  const gap = buildLines([msg({ key: 'a:1', reactable: true }), msg({ key: 'b:1', authorKey: 'cd'.repeat(32), reactable: true })], 40, T, NOW, undefined, { ...compact, density: 'roomy' })
  const gaps = gap.filter((l) => l.key.includes(':gap'))
  assert.ok(gaps.length > 0)
  assert.ok(gaps.every((l) => l.msg === undefined))
})

test('the picker row lists the eight quick reactions and a … cell, four columns each, with the chosen one highlighted', () => {
  const m = msg({ key: 'a:1', text: 'hi', reactable: true })
  const lines = buildLines([m], 60, T, NOW, undefined, undefined, { key: 'a:1', at: 3 })
  const row = lines.at(-1)!
  assert.equal(row.key, 'a:1:pick')
  assert.deepEqual(row.pick, { col: 2, items: ['👍', '👎', '😂', '🔥', '🎉', '😮', '👀', '💯', '…'] })
  assert.equal(row.msg, undefined)
  const cells = row.segs.filter((s) => s.chrome !== true)
  assert.equal(cells.length >= 9, true)
  const hit = row.segs.find((s) => s.bg === T.band.bg)
  assert.match(hit?.text ?? '', /🔥/)
  // no picker for another message, none when closed
  assert.ok(!buildLines([m], 60, T, NOW, undefined, undefined, { key: 'z:9', at: 0 }).some((l) => l.pick !== undefined))
  assert.ok(!buildLines([m], 60, T, NOW).some((l) => l.pick !== undefined))
})
