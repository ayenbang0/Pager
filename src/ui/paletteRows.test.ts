import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../themes.js'
import { fuzzyFilter } from './fuzzy.js'
import { labelSegs, matchCount, matchIndexes, noMatchSegs, paletteRow } from './paletteRows.js'
import { segsWidth, type Seg } from './segs.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')

test('matchIndexes mirrors the fuzzy matcher: substring first, else letters in order', () => {
  assert.deepEqual(matchIndexes('Agents: setup', 'set'), [8, 9, 10])
  assert.deepEqual(matchIndexes('Agents: setup', 'ast'), [0, 5, 10])
  assert.deepEqual(matchIndexes('Quit pager', 'qp'), [0, 5])
  assert.deepEqual(matchIndexes('Quit pager', 'zzz'), [])
  assert.deepEqual(matchIndexes('Quit pager', ''), [])
  assert.deepEqual(matchIndexes('Quit pager', '  '), [])
})

test('every item the filter keeps has indexes, and they point at the query letters', () => {
  const items = [{ label: 'Agents: setup' }, { label: 'Quit pager' }, { label: 'Theme: pick…' }, { label: 'Model & effort: omp' }]
  for (const query of ['set', 'qp', 'me', 'ef', 'omp']) {
    for (const item of fuzzyFilter(items, query)) {
      const at = matchIndexes(item.label, query)
      assert.equal(at.length, query.length, `${item.label} ${query}`)
      assert.equal(at.map((i) => item.label[i]?.toLowerCase()).join(''), query)
    }
  }
})

test('labelSegs lights the matched letters in glow and leaves the rest as text', () => {
  const segs = labelSegs('Quit pager', 'pa', theme)
  assert.equal(text(segs), 'Quit pager')
  assert.deepEqual(
    segs.filter((s) => s.color === theme.glow).map((s) => s.text),
    ['pa'],
  )
  assert.ok(segs.every((s) => s.bold === true))
  assert.equal(labelSegs('Quit', '', theme).length, 1)
})

test('rows are exactly the width, selected or not, hint or not, long and wide labels', () => {
  const labels = ['Quit', 'A very long palette label that cannot possibly fit in the pane', '漢字漢字漢字漢字漢字漢字漢字漢字漢字', '🙂 emoji 🙂']
  for (const label of labels) {
    for (const hint of [undefined, 'Ctrl+G', 'a long shortcut hint /quit · /exit']) {
      for (const selected of [false, true]) {
        for (const width of [60, 30, 12]) {
          const row = paletteRow(hint === undefined ? { label } : { label, hint }, 'q', selected, width, theme)
          assert.equal(segsWidth(row), width, `${label} ${hint} ${selected} ${width}`)
        }
      }
    }
  }
})

test('the selected row is the accent bar and the hint is a keycap', () => {
  const row = paletteRow({ label: 'Help', hint: 'Ctrl+G' }, '', true, 40, theme)
  assert.equal(row[0]?.text, '▎')
  assert.equal(row[0]?.bg, theme.band.bg)
  assert.match(text(row), /‹Ctrl\+G›/)
  const plain = paletteRow({ label: 'Help', hint: 'Ctrl+G' }, '', false, 40, theme)
  assert.equal(plain[0]?.text, ' ')
  assert.match(text(plain), /‹Ctrl\+G›$/)
})

test('count and empty-result rows', () => {
  assert.equal(text(matchCount(12, 12, theme)), ' 12 ')
  assert.equal(text(matchCount(3, 12, theme)), ' 3/12 ')
  assert.match(text(noMatchSegs(theme)), /no matches/)
})
