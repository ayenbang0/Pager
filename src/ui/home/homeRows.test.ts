import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HomeStats } from '../../app/engine.js'
import { DEFAULT_THEME as theme, THEMES } from '../theme/themes.js'
import type { HomeAgentRow, HomeAgents } from './homeAgents.js'
import {
  actionItems,
  actionRows,
  agentColumns,
  agentLine,
  blockOrder,
  chatRows,
  clipText,
  codeLines,
  detailFor,
  fitText,
  greetingWord,
  heading,
  homeRows,
  newsRows,
  parseInfo,
  recentChats,
  sparkline,
  summaryRows,
  wrapText,
  type HomeChat,
  type HomeInput,
} from './homeRows.js'
import { agentTint, DEFAULT_LOOK, type Look } from '../theme/look.js'
import { raisedFill } from '../kit/tern.js'
import { segsWidth, type Seg } from '../kit/segs.js'

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)
const CODE = `pgr1-${'ybndrfg8ejkm'.repeat(4)}abcdefgh`
const INFO = ['You            welo', 'Contact code', `  ${CODE}`, '', 'Get started', '  1. Send your contact code to a friend', '  2. They run /add <your code>; you run /accept 1', '  3. Ctrl+P opens the command palette, Ctrl+G shows shortcuts']
const stats = (over: Partial<HomeStats> = {}): HomeStats => ({
  contacts: 5,
  online: 2,
  groups: 1,
  pending: 1,
  unread: 3,
  sent: 40,
  received: 55,
  week: [1, 2, 3, 4, 5, 6, 7],
  busiest: { title: '#team', count: 30 },
  agentRuns: 4,
  agentsRunning: 1,
  mergeable: 2,
  ...over,
})
const row = (over: Partial<HomeAgentRow> = {}): HomeAgentRow => ({ name: 'omp', cli: 'omp', state: 'idle', turns: 5, files: 7, approved: 2, changes: 1, ...over })
const agents = (over: Partial<HomeAgents> = {}): HomeAgents => ({
  rows: [row({ model: 'gpt-5', ctx: 42 }), row({ name: 'claude', cli: 'claude', state: 'working', ctx: 90 })],
  week: Array.from({ length: 14 }, (_, i) => i),
  weekTotal: 91,
  questions: 0,
  reviewsPending: 0,
  approved: 2,
  changes: 1,
  usage: { agent: 'omp', line: 'Plan: 41% used, resets in 2h', age: '5m ago' },
  unadded: 0,
  hint: 'Alt+I invite a contact · Ctrl+P usage · Alt+M model',
  ...over,
})
const chat = (over: Partial<HomeChat> = {}): HomeChat => ({ kind: 'dm', online: true, title: 'alice', unread: 0, last: NOW - 5 * 60_000, ...over })
const chats: HomeChat[] = [
  chat({ title: 'old', last: NOW - 3 * 86_400_000, online: false }),
  chat({ title: 'alice', unread: 2 }),
  chat({ kind: 'group', online: null, title: 'team', last: NOW - 3_600_000 }),
  chat({ title: 'bob', last: NOW - 2 * 3_600_000 }),
  chat({ title: 'quiet', last: undefined }),
]
const news = { version: '1.11.0', fresh: true, items: [{ kind: 'Added' as const, text: 'a crash log' }, { kind: 'Changed' as const, text: 'one smooth look' }, { kind: 'Fixed' as const, text: 'a taskbar button that kept the Electron icon' }] }
const input = (over: Partial<HomeInput> = {}): HomeInput => ({
  width: 92,
  height: 40,
  hour: 20,
  now: NOW,
  theme,
  look: { ...DEFAULT_LOOK, me: 'welo', badge: '◆' },
  stats: stats(),
  agents: agents(),
  chats,
  info: INFO,
  news,
  ...over,
})
const text = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('')
const lines = (rows: readonly (readonly Seg[])[]): string[] => rows.map(text)
const HEADINGS = ['Agents', 'Chats', 'Quick actions', 'Contact code', "What's new"]
/** A section heading row (a summary line starts with the same word but has no hairline). */
const isHeading = (line: string, title: string): boolean => line.startsWith(` ${title} `) && line.includes('──')

test('every row is exactly the pane width (capped) and fits the height, with wide glyphs, long names and tiny panes', () => {
  const wide: HomeAgents = agents({ rows: ['漢字漢字漢字漢字', 'a-very-long-agent-name', '🙂🙂🙂', 'omp', 'claude', 'hermes'].map((name) => row({ name, model: 'claude-sonnet-5-5-thinking', ctx: 99 })) })
  const longChats = [chat({ title: '漢字漢字漢字漢字漢字漢字', unread: 120, call: 3 }), chat({ kind: 'group', online: null, title: 'a-very-long-group-title-indeed' })]
  for (const t of [theme, THEMES.at(-1) ?? theme]) {
    for (const width of [150, 110, 92, 80, 79, 60, 40, 20]) {
      for (const height of [60, 31, 24, 12, 6, 3, 1]) {
        for (const a of [agents(), wide, agents({ rows: [] })]) {
          const rows = homeRows(input({ width, height, theme: t, agents: a, chats: longChats, look: { ...DEFAULT_LOOK, me: '漢字名前', badge: '🙂' }, recap: 'Since you left (3h ago): agents: 1 turn' }))
          assert.ok(rows.length <= height, `${t.name} ${width}x${height}: ${rows.length} rows`)
          for (const r of rows) assert.equal(segsWidth(r), width, `${t.name} ${width}x${height}: "${text(r)}"`)
        }
      }
    }
  }
})

test('Home is flat like the other screens: no box corners, vertical bars, heavy rules or banded pills', () => {
  for (const width of [100, 60]) {
    const out = lines(homeRows(input({ width, height: 60 }))).join('\n')
    assert.ok(!/[╭╮╰╯│┃┏┓┗┛━▌]/.test(out), out)
    for (const r of homeRows(input({ width, height: 60 }))) {
      for (const s of r) assert.ok(s.bg === undefined || s.bg === raisedFill(theme) || Object.values(theme.pill).some((p) => p.bg === s.bg), `${s.text} has an off-palette fill`)
    }
  }
})

test('the greeting is the first row, carries the name and badge, and follows the hour', () => {
  const first = text(homeRows(input({ hour: 8 }))[0] ?? [])
  assert.match(first, /^ Good morning, welo ◆ *$/)
  assert.equal(greetingWord(2), 'Up late')
  assert.equal(greetingWord(13), 'Good afternoon')
  assert.equal(greetingWord(21), 'Good evening')
  assert.match(text(homeRows(input({ look: DEFAULT_LOOK }))[0] ?? []), /, welo/, 'falls back to the name in the welcome lines')
  assert.match(text(homeRows(input({ look: DEFAULT_LOOK, info: [] }))[0] ?? []), /, you/)
})

test('the summary lines carry the chat and agent counts, and drop the least important ones as the pane narrows', () => {
  const wide = lines(summaryRows(input(), 100)).join('\n')
  for (const needle of ['2 online of 5 contacts', '1 group', '3 unread', '1 pending', '2 ready', '1 running', '2 to merge', 'reviews ✓2 ↻1']) assert.ok(wide.includes(needle), needle)
  assert.equal(summaryRows(input({ agentsOn: false }), 100).length, 1, 'no agent line without agents')
  const narrow = lines(summaryRows(input(), 40)).join('\n')
  assert.ok(narrow.includes('2 online'), 'the first count survives')
  assert.ok(!narrow.includes('reviews'))
  assert.match(lines(summaryRows(input({ stats: stats({ online: 0, contacts: 1 }) }), 100))[0] ?? '', /○ 0 online of 1 contact(?!s)/)
})

test('the recap shows under the summary, never replacing it', () => {
  const rows = lines(homeRows(input({ recap: 'Since you left (3h ago): agents: 1 turn' })))
  assert.ok(rows[3]?.includes('Since you left (3h ago): agents: 1 turn'), rows.slice(0, 5).join('|'))
  assert.ok(rows.some((l) => l.includes('Agents')))
})

test('a tall pane shows every block in order, starting at the top; each heading is a label then a hairline', () => {
  const out = lines(homeRows(input({ height: 60 })))
  let last = -1
  for (const h of HEADINGS) {
    const at = out.findIndex((l) => isHeading(l, h))
    assert.ok(at > last, `${h} after the previous block`)
    last = at
  }
  assert.ok(out[0]?.trim().startsWith('Good evening'))
  const head = heading('Chats', [{ text: '6' }], 30, theme)
  assert.equal(segsWidth(head), 30)
  assert.equal(text(head).slice(0, 7), ' Chats ')
  assert.ok(head.some((s) => s.text.includes('─') && s.color === theme.border))
  assert.equal(text(head).trimEnd().slice(-1), '6')
})

test('a short pane loses blocks from the bottom, never fewer rows than before as it grows', () => {
  let last = 0
  for (let height = 3; height <= 60; height++) {
    const out = lines(homeRows(input({ height })))
    const shown = HEADINGS.filter((h) => out.some((l) => isHeading(l, h))).length
    assert.ok(shown >= last, `${height}`)
    last = shown
  }
  assert.equal(last, HEADINGS.length)
  const tiny = lines(homeRows(input({ height: 8 }))).join('\n')
  assert.ok(tiny.includes(' Agents '))
  assert.ok(!tiny.includes(" What's new "))
  assert.equal(homeRows(input({ height: 3 })).length, 3)
})

test('the contact code is shown whole or not at all, wrapped when the pane is narrow', () => {
  for (const width of [100, 60, 40, 30]) {
    const joined = codeLines(CODE, width, theme).map((r) => text(r).trim()).join('')
    assert.equal(joined, CODE, `${width}`)
    for (const r of codeLines(CODE, width, theme)) assert.ok(segsWidth(r) <= width)
  }
  for (const width of [100, 60, 40]) {
    for (let height = 3; height <= 60; height++) {
      const out = lines(homeRows(input({ width, height }))).map((l) => l.trim()).join('')
      const shown = out.includes(CODE.slice(0, 20))
      if (shown) assert.ok(out.includes(CODE), `${width}x${height}: the code is cut`)
    }
  }
})

test('a fresh pager starts with how to get started, everyone else with what is running', () => {
  const fresh = stats({ sent: 0, received: 0, contacts: 0, online: 0, groups: 0, unread: 0, pending: 0 })
  assert.deepEqual(blockOrder(fresh, agents({ rows: [] }), true), ['start', 'actions', 'agents', 'chats', 'news'])
  assert.deepEqual(blockOrder(stats(), agents(), true), ['agents', 'chats', 'actions', 'code', 'news'])
  assert.equal(blockOrder(fresh, agents(), true)[0], 'agents', 'agents make it not fresh')
  assert.ok(!blockOrder(stats(), agents(), false).includes('agents'))
  const out = lines(homeRows(input({ stats: fresh, agents: agents({ rows: [] }), chats: [], height: 60 }))).map((l) => l.replace(/\s+/g, ' '))
  assert.ok(out.some((l) => l.includes('Get started')))
  for (const step of ['Send your contact code to a friend', 'They run /add <your code>; you run /accept 1', 'Ctrl+P opens the command palette, Ctrl+G shows shortcuts']) assert.ok(out.some((l) => l.includes(step)), step)
  assert.ok(out.findIndex((l) => l.includes('Get started')) < out.findIndex((l) => l.includes('Quick actions')))
})

test('the engine\'s other welcome lines (LAN mode) stay on the screen', () => {
  const out = lines(homeRows(input({ info: [...INFO, '', 'LAN mode: joined 192.168.1.9'], height: 60 }))).join('\n')
  assert.ok(out.includes('LAN mode: joined 192.168.1.9'))
})

test('quick actions: every key and what it does, one column below 80 and two from 80, no agent keys without agents', () => {
  for (const [key, label] of actionItems(true)) assert.ok(lines(actionRows(input(), 100)).join('\n').includes(label), `${key} ${label}`)
  const one = actionRows(input(), 79)
  assert.equal(one.length, 1 + actionItems(true).length)
  const two = actionRows(input(), 80)
  assert.equal(two.length, 1 + Math.ceil(actionItems(true).length / 2))
  for (const r of two.slice(1)) assert.equal(segsWidth(r), 80)
  for (const r of one.slice(1)) assert.ok(segsWidth(r) <= 79)
  const keys = two.slice(1).flatMap((r) => r.filter((s) => s.bg === raisedFill(theme)).map((s) => s.text))
  assert.ok(new Set(keys.map((k) => k.length)).size === 1, 'keys are padded to one width')
  const none = lines(actionRows(input({ agentsOn: false }), 100)).join('\n')
  assert.ok(!none.includes('Alt+M') && !none.includes('Alt+I'))
  assert.ok(none.includes('Ctrl+P') && none.includes('/add'))
})

test('chats: the newest first, at most four, sidebar-style rows with time and unread', () => {
  assert.deepEqual(recentChats(chats).map((c) => c.title), ['alice', 'team', 'bob', 'old'])
  assert.equal(recentChats(chats, 2).length, 2)
  const rows = chatRows(input(), 70)
  assert.equal(rows.length, 1 + 4 + 1)
  assert.equal(segsWidth(rows[0] ?? []), 70)
  for (const r of rows.slice(1, 5)) assert.equal(segsWidth(r), 70)
  const alice = text(rows[1] ?? [])
  assert.match(alice, /^ ● alice\s+5m ●2 $/)
  assert.match(text(rows[2] ?? []), /^ # team\s+1h $/)
  assert.match(text(rows[4] ?? []), /^ ○ old\s+3d $/)
  const totals = text(rows[5] ?? [])
  for (const needle of ['↑ 40 sent', '↓ 55 received', '28 this week', 'top #team 30']) assert.ok(totals.includes(needle), needle)
  assert.ok(!text(chatRows(input({ stats: stats({ sent: 0, received: 0 }) }), 60).at(-1) ?? []).includes('sent'))
})

test('chats: an empty list invites the first chat', () => {
  const rows = lines(chatRows(input({ chats: [], stats: stats({ contacts: 0, groups: 0, sent: 0, received: 0 }) }), 60))
  assert.equal(rows.length, 2)
  assert.match(rows[1] ?? '', /no chats yet · \/add <code> adds a friend/)
  assert.match(rows[0] ?? '', /Chats .*0 $/)
})

test('agent rows: the dot and name in the agent color, state word in its color, aligned, dropping counts then model then context, never the name', () => {
  const look: Look = { ...DEFAULT_LOOK, agentColors: { omp: '#ff00aa' } }
  const rows = [row({ name: 'omp', model: 'gpt-5', ctx: 40 }), row({ name: 'opencode', state: 'asking', model: 'sonnet', ctx: 95, changes: 3 })]
  const cols = agentColumns(rows)
  const first = agentLine(rows[0] ?? row(), cols, 80, theme, agentTint(theme, look, 'omp'))
  assert.equal(first[1]?.color, '#ff00aa')
  assert.ok(first.some((s) => s.text.trim() === 'idle'))
  const asking = agentLine(rows[1] ?? row(), cols, 80, theme, theme.accent)
  assert.ok(asking.some((s) => s.text.trim().startsWith('asking') && s.color === theme.warning && s.bold === true))
  assert.ok(asking.some((s) => s.text.includes('ctx 95%') && s.color === theme.error), 'context pressure colors the text, not a pill')
  assert.equal(segsWidth(first), 80)
  assert.equal(segsWidth(asking), 80)
  const stages = new Set<string>()
  for (let w = 80; w >= 12; w--) {
    const line = agentLine(rows[1] ?? row(), cols, w, theme, theme.accent)
    const out = text(line)
    assert.equal(segsWidth(line), w)
    assert.ok(out.startsWith(' ● opencode') || w < 20, `${w}: ${out}`)
    stages.add(`${out.includes('t ')}${out.includes('sonnet')}${out.includes('ctx')}${out.includes('asking')}`)
  }
  assert.ok(stages.size >= 4, [...stages].join(' '))
})

test('agents block: rows, +N more, usage, and the next step first when it is urgent, last otherwise', () => {
  const many = agents({ rows: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((name) => row({ name })), questions: 2, hint: '2 questions waiting — Alt+Q' })
  const out = lines(homeRows(input({ agents: many, height: 60 })))
  const at = out.findIndex((l) => isHeading(l, 'Agents'))
  assert.match(out[at + 1] ?? '', /^ ▸ 2 questions waiting — Alt\+Q/)
  assert.match(out[at + 2] ?? '', /^ ● a1/)
  assert.ok(out.some((l) => l.includes('+2 more')))
  assert.ok(out.some((l) => l.includes('2 asking')))
  const calm = lines(homeRows(input({ height: 60 })))
  const calmAt = calm.findIndex((l) => isHeading(l, 'Agents'))
  assert.match(calm[calmAt + 3] ?? '', /usage omp: Plan: 41% used, resets in 2h · 5m ago/)
  assert.match(calm[calmAt + 4] ?? '', /^ {3}Alt\+I invite a contact/)
  const none = lines(homeRows(input({ agents: agents({ rows: [], hint: 'no agents ready — Alt+S › Agents · 2 installed, not added' }), height: 60 }))).join('\n')
  assert.match(none, /▸ no agents ready — Alt\+S › Agents · 2 installed, not added/)
  assert.match(none, /coding agents you @mention in any chat/)
})

test('without agents the agent line, block and keys are all left out', () => {
  const out = lines(homeRows(input({ agentsOn: false, height: 60 }))).join('\n')
  assert.ok(!out.includes('Agents') && !out.includes('ready') && !out.includes('Alt+M'))
  assert.ok(out.includes('Chats') && out.includes('Quick actions'))
})

test("What's new: the version, a fresh chip the first time, one clipped line per highlight", () => {
  const rows = newsRows(news, 60, theme)
  assert.equal(rows.length, 4)
  assert.equal(segsWidth(rows[0] ?? []), 60)
  for (const r of rows) assert.ok(segsWidth(r) <= 60)
  assert.match(text(rows[0] ?? []), /^ What's new ─+ v1\.11\.0 · \/changelog\s+new\s*$/)
  assert.match(text(rows[1] ?? []), /^ \+ a crash log/)
  assert.match(text(rows[2] ?? []), /^ ~ one smooth look/)
  assert.match(text(rows[3] ?? []), /^ ✓ a taskbar button/)
  assert.ok(!/changelog\s+new/.test(text(newsRows({ ...news, fresh: false }, 60, theme)[0] ?? [])))
  const narrow = newsRows(news, 24, theme)
  assert.ok(text(narrow[3] ?? []).endsWith('…'), text(narrow[3] ?? []))
  assert.equal(segsWidth(narrow[0] ?? []), 24)
  for (const r of narrow) assert.ok(segsWidth(r) <= 24)
  assert.equal(homeRows(input({ height: 60, news: undefined })).some((r) => text(r).includes("What's new")), false)
})

test('detailFor drops the highest rank first and returns nothing when not even the first part fits', () => {
  const parts = [
    { rank: 1, segs: [{ text: 'name' }] },
    { rank: 3, segs: [{ text: 'ccc' }] },
    { rank: 2, segs: [{ text: 'bb' }] },
  ]
  assert.equal(text(detailFor(parts, 20)), 'name  ccc  bb')
  assert.equal(text(detailFor(parts, 10)), 'name  bb')
  assert.equal(text(detailFor(parts, 4)), 'name')
  assert.deepEqual(detailFor(parts, 3), [])
})

test('text helpers: wrap by display width, fit pads and ellipsizes, sparkline scales', () => {
  assert.deepEqual(wrapText('aa bb cc dd', 5), ['aa bb', 'cc dd'])
  assert.deepEqual(wrapText('abcdefgh', 3), ['abc', 'def', 'gh'])
  assert.deepEqual(wrapText('漢字漢字', 4), ['漢字', '漢字'])
  assert.deepEqual(wrapText('漢', 1), ['漢'])
  assert.deepEqual(wrapText('', 5), [''])
  assert.equal(fitText('ab', 5), 'ab   ')
  assert.equal(fitText('abcdef', 4), 'abc…')
  assert.equal(clipText('abcdef', 0), '')
  assert.equal(segsWidth([{ text: fitText('漢字漢字', 5) }]), 5)
  assert.equal(sparkline([0, 0, 0]), '▁▁▁')
  assert.equal(sparkline([0, 7, 14]), '▁▅█')
})

test('parseInfo splits the welcome lines and keeps unknown ones', () => {
  const parsed = parseInfo([...INFO, 'something else'])
  assert.equal(parsed.name, 'welo')
  assert.equal(parsed.code, CODE)
  assert.equal(parsed.steps.length, 3)
  assert.equal(parsed.steps[1], 'They run /add <your code>; you run /accept 1')
  assert.deepEqual(parsed.extra, ['something else'])
  assert.deepEqual(parseInfo([]), { steps: [], extra: [] })
})
