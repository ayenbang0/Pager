import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentView } from '../../agents/types.js'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { agentBadge, agentRowSpec, buildRow, groupHeader, unreadBadge, type RowSpec } from './sidebarRows.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { SPINNER_CELL } from '../kit/spinnerCells.js'

const WIDTH = 25
const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const agent = (state: AgentView['state'], unread = 0): AgentView => ({ name: 'omp', cli: 'omp', state, task: '', unread })

test('group headers are a banded label then a rule, exactly the width', () => {
  for (const width of [25, 12, 6]) {
    const row = groupHeader('CHATS', width, theme)
    assert.equal(segsWidth(row), width)
    assert.ok(text(row).startsWith('▌ CHATS '.slice(0, width)))
  }
  assert.equal(groupHeader('CHATS', WIDTH, theme)[1]?.bg, theme.band.bg)
})

test('every row is exactly the sidebar width, active or not, with long and wide labels', () => {
  const labels = ['home', 'a-very-long-conversation-title-that-overflows', '漢字漢字漢字漢字漢字漢字漢字漢字', '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂']
  for (const label of labels) {
    for (const badge of [undefined, unreadBadge(7, theme), unreadBadge(250, theme)]) {
      for (const active of [false, true]) {
        const spec: RowSpec = { glyph: '●', label, ...(badge === undefined ? {} : { badge }) }
        assert.equal(segsWidth(buildRow(spec, active, WIDTH, theme)), WIDTH, `${label} ${badge === undefined} ${active}`)
      }
    }
  }
})

test('a row without a glyph still fits and carries its label', () => {
  const row = buildRow({ glyph: '', label: 'plain' }, false, WIDTH, theme)
  assert.equal(segsWidth(row), WIDTH)
  assert.match(text(row), /plain/)
})

test('the active row is the accent bar with the marker; its pills keep their own colors', () => {
  const pill = unreadBadge(3, theme)
  const row = buildRow({ glyph: '●', label: 'bob', badge: pill }, true, WIDTH, theme)
  assert.equal(row[0]?.text, '▎')
  assert.equal(row[0]?.bg, theme.band.bg)
  const shown = row.find((s) => s.text === ' ●3 ')
  assert.equal(shown?.bg, theme.pill.warning.bg)
  const idle = buildRow({ glyph: '●', label: 'bob' }, false, WIDTH, theme)
  assert.equal(idle[0]?.text, ' ')
  assert.equal(idle[0]?.bg, undefined)
})

test('a long label gives way to the pill instead of pushing it out', () => {
  const row = buildRow({ glyph: '#', label: 'x'.repeat(60), badge: unreadBadge(12, theme) }, false, WIDTH, theme)
  assert.match(text(row), /…\s+●12\s+$/)
  assert.equal(segsWidth(row), WIDTH)
})

test('unread pills are padded and capped', () => {
  assert.deepEqual(unreadBadge(0, theme), [])
  assert.equal(unreadBadge(3, theme)[0]?.text, ' ●3 ')
  assert.equal(unreadBadge(100, theme)[0]?.text, ' ●99+ ')
})

test('an asking agent shows a ? ask pill that alternates colors but keeps its text', () => {
  const on = agentBadge(agent('asking'), theme, true)
  const off = agentBadge(agent('asking'), theme, false)
  assert.equal(on[0]?.text, ' ? ask ')
  assert.equal(off[0]?.text, ' ? ask ')
  assert.equal(on[0]?.bg, theme.pill.warning.bg)
  assert.equal(off[0]?.bg, theme.pill.accent.bg)
})

test('reviewing agents show rev in the info pill, others their unread count', () => {
  assert.equal(agentBadge(agent('reviewing', 4), theme, true)[0]?.bg, theme.pill.info.bg)
  assert.equal(agentBadge(agent('reviewing', 4), theme, true)[0]?.text, ' rev ')
  assert.equal(agentBadge(agent('idle', 4), theme, true)[0]?.text, ' ●4 ')
  assert.deepEqual(agentBadge(agent('working'), theme, true), [])
})

test('agent state dots: spinner, blinking ?, info diamond, tinted dot', () => {
  const tint = '#ff00aa'
  const working = agentRowSpec(agent('working'), tint, theme, true)
  assert.equal(working.spinner, true)
  assert.ok(buildRow(working, false, WIDTH, theme).some((s) => s.text === SPINNER_CELL && s.color === tint))
  assert.equal(agentRowSpec(agent('asking'), tint, theme, true).glyph, '?')
  assert.equal(agentRowSpec(agent('asking'), tint, theme, true).glyphColor, theme.warning)
  assert.equal(agentRowSpec(agent('asking'), tint, theme, false).glyphColor, tint)
  const reviewing = agentRowSpec(agent('reviewing'), tint, theme, true)
  assert.deepEqual([reviewing.glyph, reviewing.glyphColor], ['◆', theme.info])
  const idle = agentRowSpec(agent('idle'), tint, theme, true)
  assert.deepEqual([idle.glyph, idle.glyphColor, idle.labelColor], ['●', tint, tint])
})

test('foldable headers show the fold glyph and the item count, and still fill the width', () => {
  assert.match(text(groupHeader('work', 25, theme, 'open', 3)), /^▌ ▾ work \(3\) /)
  assert.match(text(groupHeader('work', 25, theme, 'closed', 0)), /^▌ ▸ work \(0\) /)
  assert.match(text(groupHeader('DIRECT', 25, theme, 'open')), /^▌ ▾ DIRECT /)
  for (const width of [25, 12, 6]) assert.equal(segsWidth(groupHeader('漢字漢字', width, theme, 'closed', 12)), width)
})
