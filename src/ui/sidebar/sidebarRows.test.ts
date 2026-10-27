import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentView } from '../../agents/types.js'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { agentBadge, agentRowSpec, buildRow, chatRowSpec, groupHeader, unreadBadge, type RowSpec } from './sidebarRows.js'
import { raisedFill } from '../kit/tern.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { SPINNER_CELL } from '../kit/spinnerCells.js'

const WIDTH = 25
const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const agent = (state: AgentView['state'], unread = 0): AgentView => ({ name: 'omp', cli: 'omp', state, task: '', unread })

test('group headers are a quiet dim label then a rule, exactly the width, with no band fill', () => {
  for (const width of [25, 12, 6]) {
    const row = groupHeader('CHATS', width, theme)
    assert.equal(segsWidth(row), width)
    assert.ok(text(row).startsWith(' CHATS'.padEnd(width).slice(0, width).trimEnd()))
    assert.ok(row.every((s) => s.bg === undefined), 'no banded fill')
  }
  assert.match(text(groupHeader('CHATS', WIDTH, theme)), /^ CHATS ─+$/)
  assert.equal(groupHeader('CHATS', WIDTH, theme).find((s) => s.text.includes('CHATS'))?.color, theme.dim)
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

test('the active row sits on the raised fill with a bold accent label; its pills keep their own colors; idle rows are flat', () => {
  const raised = raisedFill(theme)
  const dotBadge = unreadBadge(3, theme)
  const row = buildRow({ glyph: '●', label: 'bob', badge: dotBadge }, true, WIDTH, theme)
  assert.equal(row[0]?.bg, raised)
  assert.ok(row.every((s) => s.bg === raised), 'the whole row is filled')
  const label = row.find((s) => s.text === 'bob')
  assert.equal(label?.bold, true)
  assert.equal(label?.color, theme.accent)
  assert.equal(row.find((s) => s.text === '●3')?.color, theme.accent, 'the unread dot keeps the accent')
  const asking = buildRow({ glyph: '?', label: 'bob', badge: agentBadge(agent('asking'), theme, true) }, true, WIDTH, theme)
  assert.equal(asking.find((s) => s.text === ' ? ask ')?.bg, theme.pill.warning.bg, 'a pill keeps its own fill on the active row')
  const idle = buildRow({ glyph: '●', label: 'bob' }, false, WIDTH, theme)
  assert.ok(idle.every((s) => s.bg === undefined), 'idle rows have no fill')
  const idleLabel = idle.find((s) => s.text === 'bob')
  assert.notEqual(idleLabel?.bold, true)
  assert.equal(idleLabel?.color, theme.text)
})

test('a long label gives way to the pill instead of pushing it out', () => {
  const row = buildRow({ glyph: '#', label: 'x'.repeat(60), badge: unreadBadge(12, theme) }, false, WIDTH, theme)
  assert.match(text(row), /…\s+●12\s+$/)
  assert.equal(segsWidth(row), WIDTH)
})

test('unread badges are a bare accent dot with the count, capped at 99+', () => {
  assert.deepEqual(unreadBadge(0, theme), [])
  assert.equal(unreadBadge(3, theme)[0]?.text, '●3')
  assert.equal(unreadBadge(99, theme)[0]?.text, '●99')
  assert.equal(unreadBadge(100, theme)[0]?.text, '●99+')
  assert.equal(unreadBadge(3, theme)[0]?.bg, undefined)
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
  assert.equal(agentBadge(agent('idle', 4), theme, true)[0]?.text, '●4')
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

test('foldable headers show the fold glyph, a rule and the item count at the end, and still fill the width', () => {
  assert.match(text(groupHeader('work', 25, theme, 'open', 3)), /^ ▾ work ─+ 3 $/)
  assert.match(text(groupHeader('work', 25, theme, 'closed', 0)), /^ ▸ work ─+ 0 $/)
  assert.match(text(groupHeader('DIRECT', 25, theme, 'open')), /^ ▾ DIRECT ─+$/)
  for (const width of [25, 12, 6]) assert.equal(segsWidth(groupHeader('漢字漢字', width, theme, 'closed', 12)), width)
  assert.ok(!text(groupHeader('a-long-group-name', 10, theme, 'open', 12)).includes('12'), 'the count gives way to the title when tight')
})

test('chat rows: a contact is a presence dot, a group a #, with time, call and unread, and every width stays exact', () => {
  const now = 1_000_000_000
  const dm = { kind: 'dm' as const, online: true, title: 'alice', unread: 2, last: now - 5 * 60_000 }
  const live = chatRowSpec(dm, now, theme)
  assert.equal(live.glyph, '●')
  assert.equal(live.glyphColor, theme.online)
  assert.equal(live.time, '5m')
  assert.match(text(buildRow(live, false, WIDTH, theme)), /^ ● alice\s+5m ●2 $/)
  const away = chatRowSpec({ ...dm, online: false, unread: 0 }, now, theme)
  assert.equal(away.glyph, '○')
  assert.equal(away.labelColor, theme.dim)
  assert.equal(away.badge?.length, 0)
  const group = chatRowSpec({ kind: 'group', online: null, title: 'team', unread: 0, call: 3, thinking: true }, now, theme)
  assert.equal(group.glyph, '#')
  assert.equal(group.spinner, true)
  assert.equal(group.time, undefined, 'an empty conversation has no time')
  assert.match(text(group.badge ?? []), /^☎3 $/)
  for (const title of ['alice', '漢字漢字漢字漢字漢字漢字', 'a-very-long-conversation-title']) {
    for (const width of [40, 25, 12, 6]) {
      for (const spec of [chatRowSpec({ ...dm, title, unread: 120, call: 2 }, now, theme), chatRowSpec({ ...dm, kind: 'group', online: null, title }, now, theme)]) {
        assert.equal(segsWidth(buildRow(spec, false, width, theme)), width, `${title} ${width}`)
      }
    }
  }
})
