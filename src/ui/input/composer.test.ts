import assert from 'node:assert/strict'
import { test } from 'node:test'
import stringWidth from 'string-width'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { COMPOSER_ROWS, composerRows, cwdLabel, menuRow, type ComposerInput } from './composer.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const input = (over: Partial<ComposerInput> = {}): ComposerInput => ({
  width: 70,
  chip: { text: '→ alice' },
  extras: [],
  hint: 'PgUp scrolls',
  active: true,
  typed: false,
  ...over,
})

test('the composer card is four rows: edges, text, chips', () => {
  assert.equal(COMPOSER_ROWS, 4)
})

test('every composer row has its exact width, whatever the card width and chips', () => {
  const extras = [{ text: 'sonnet-5.5', kind: 'model' as const }, { text: '~/Desktop/Projects/Products/pager', kind: 'cwd' as const }]
  for (const width of [8, 12, 24, 40, 54, 80, 140]) {
    for (const typed of [false, true]) {
      const rows = composerRows(input({ width, extras, typed, chip: { text: '→ 漢字漢字漢字漢字' } }), theme)
      assert.equal(segsWidth(rows.top), width, `top ${width}`)
      assert.equal(segsWidth(rows.bottom), width, `bottom ${width}`)
      assert.ok(segsWidth(rows.chips) <= Math.max(0, width - 4), `chips ${width}: ${segsWidth(rows.chips)}`)
    }
  }
})

test('the edge is the accent while the prompt has focus and a quiet hairline otherwise', () => {
  assert.ok(composerRows(input({ active: true }), theme).top.every((s) => s.color === theme.accent))
  assert.ok(composerRows(input({ active: false }), theme).top.every((s) => s.color === theme.border))
  assert.match(text(composerRows(input(), theme).top), /^╭─+╮$/)
  assert.match(text(composerRows(input(), theme).bottom), /^╰─+ PgUp scrolls ─╯$/)
})

test('the chip row carries the recipient, then the model and the folder, then send at the right', () => {
  const extras = [{ text: 'sonnet-5.5', kind: 'model' as const }, { text: '~/pager', kind: 'cwd' as const }]
  const row = text(composerRows(input({ extras, typed: true }), theme).chips)
  assert.match(row, /^ → alice {3}sonnet-5\.5 {3}~\/pager +⏎ send $/)
  const idle = text(composerRows(input({ extras }), theme).chips)
  assert.ok(idle.endsWith(' ⏎ '), 'an empty prompt shows a dim enter key, not the send chip')
  const send = composerRows(input({ typed: true }), theme).chips.find((s) => s.text === ' ⏎ send ')
  assert.equal(send?.bg, theme.pill.accent.bg)
})

test('narrow cards drop the folder chip first, then the model chip, and never the recipient', () => {
  const extras = [{ text: 'sonnet-5.5', kind: 'model' as const }, { text: '~/Desktop/Projects/Products/pager', kind: 'cwd' as const }]
  const wide = text(composerRows(input({ width: 100, extras }), theme).chips)
  assert.ok(wide.includes('sonnet-5.5') && wide.includes('pager'))
  const mid = text(composerRows(input({ width: 44, extras }), theme).chips)
  assert.ok(mid.includes('sonnet-5.5') && !mid.includes('Products'), mid)
  const exact = text(composerRows(input({ width: 30, extras }), theme).chips)
  assert.ok(exact.includes('sonnet-5.5'), 'the model chip stays while it still fits beside send')
  const small = text(composerRows(input({ width: 28, extras }), theme).chips)
  assert.ok(small.includes('→ alice') && !small.includes('sonnet'), small)
})

test('a custom chip color fills the recipient chip', () => {
  const chips = composerRows(input({ chip: { text: '→ omp', color: '#ff8800' } }), theme).chips
  assert.equal(chips[0]?.bg, '#ff8800')
})

test('cwd labels: home becomes ~, slashes are forward, long paths keep their tail', () => {
  assert.equal(cwdLabel('C:\\Users\\welov\\Desktop\\pager', 'C:\\Users\\welov', 40), '~/Desktop/pager')
  assert.equal(cwdLabel('/home/ann/code', '/home/ann/', 40), '~/code')
  assert.equal(cwdLabel('/home/anna/code', '/home/ann', 40), '/home/anna/code', 'a sibling folder is not under home')
  assert.equal(cwdLabel('/srv/app', '', 40), '/srv/app')
  const cut = cwdLabel('~/Desktop/Projects/Products/pager'.replace('~', '/home/ann'), '/home/ann', 16)
  assert.equal(stringWidth(cut), 16)
  assert.ok(cut.startsWith('…') && cut.endsWith('pager'))
  assert.equal(cwdLabel('/a/b', '', 1), '…')
  assert.equal(cwdLabel('/a/b', '', 0), '')
})

test('completion rows fit the width; the chosen one is raised with an accent command', () => {
  for (const width of [10, 30, 60]) {
    for (const chosen of [false, true]) assert.equal(segsWidth(menuRow({ label: '/agent', summary: 'ask an agent' }, chosen, width, theme)), width)
  }
  const rest = menuRow({ label: '/agent', summary: 'ask an agent' }, false, 40, theme)
  assert.ok(rest.every((s) => s.bg === undefined))
  const row = menuRow({ label: '/agent', summary: 'ask an agent' }, true, 40, theme)
  assert.equal(row.find((s) => s.text === '/agent')?.color, theme.accent)
  assert.ok(row.every((s) => s.bg === theme.pill.muted.bg))
})
