import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HomeStats } from '../../app/engine.js'
import { DEFAULT_THEME as theme, THEMES } from '../theme/themes.js'
import { LOGO, REVEAL_FRAMES, tagline } from './banner.js'
import type { HomeAgentRow, HomeAgents } from './homeAgents.js'
import {
  agentColumns,
  agentRow,
  agentsCard,
  BANNER_ROWS,
  bodyRows,
  codeRows,
  dropToFit,
  fitText,
  GLITCH_EVERY,
  GLITCH_FRAMES,
  glitchAt,
  flowSegs,
  greetingWord,
  homeRows,
  logoRows,
  parseInfo,
  renderCard,
  stackedOrder,
  visualFrame,
  wrapText,
  type HomeInput,
} from './homeRows.js'
import { agentTint, DEFAULT_LOOK, type Look } from '../theme/look.js'
import { segsWidth, type Seg } from '../kit/segs.js'

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
  hint: '/agent usage · /agent review on|off · Alt+M model',
  ...over,
})
const input = (over: Partial<HomeInput> = {}): HomeInput => ({
  width: 92,
  height: 31,
  frame: 0,
  animate: false,
  hour: 20,
  theme,
  look: { ...DEFAULT_LOOK, me: 'welo', badge: '◆' },
  stats: stats(),
  agents: agents(),
  info: INFO,
  ...over,
})
const text = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('')
const lines = (rows: readonly (readonly Seg[])[]): string[] => rows.map(text)

test('every row fits the pane at every width and height, with wide glyphs and long names', () => {
  const wide: HomeAgents = agents({ rows: ['漢字漢字漢字漢字', 'a-very-long-agent-name', '🙂🙂🙂', 'omp', 'claude', 'hermes'].map((name) => row({ name, model: 'claude-sonnet-5-5-thinking', ctx: 99 })) })
  for (const t of [theme, THEMES.at(-1) ?? theme]) {
    for (const width of [150, 92, 84, 83, 60, 40, 20]) {
      for (const height of [60, 31, 24, 23, 12, 6, 1]) {
        for (const a of [agents(), wide, agents({ rows: [] })]) {
          const rows = homeRows(input({ width, height, theme: t, agents: a, look: { ...DEFAULT_LOOK, me: '漢字名前', badge: '🙂' } }))
          assert.ok(rows.length <= height, `${t.name} ${width}x${height}: ${rows.length} rows`)
          for (const r of rows) assert.ok(segsWidth(r) <= width, `${t.name} ${width}x${height}: "${text(r)}" is ${segsWidth(r)}`)
        }
      }
    }
  }
})

test('animation frames never change the width of a row', () => {
  for (const frame of [0, 5, 12, 24, 40, 100]) {
    for (const r of logoRows(frame, theme, true)) assert.equal(segsWidth(r), LOGO[0]?.length)
    for (const r of homeRows(input({ frame, animate: true }))) assert.ok(segsWidth(r) <= 92)
  }
})

test('the block logo appears on a big pane and is a one-line mark on a small one', () => {
  const big = lines(homeRows(input()))
  assert.ok(big.some((l) => l.includes(LOGO[0] ?? 'x')))
  for (const [width, height] of [[92, 20], [52, 31], [59, 40]] as const) {
    const small = lines(homeRows(input({ width, height })))
    assert.ok(!small.some((l) => l.includes(LOGO[0] ?? 'x')), `${width}x${height}`)
    assert.ok(small.some((l) => l.includes('P A G E R')), `${width}x${height}`)
  }
})

test('after the reveal the logo is still except for a short, small glitch burst', () => {
  const calm = logoRows(REVEAL_FRAMES, theme, false).map(text)
  const frames = Array.from({ length: GLITCH_EVERY * 4 }, (_, i) => REVEAL_FRAMES + i)
  const glitching = frames.filter((f) => glitchAt(f) !== undefined)
  assert.equal(glitching.length, 4 * GLITCH_FRAMES, 'bursts are rare and short')
  for (const f of frames) {
    const rows = logoRows(f, theme, true)
    const changed = rows.map(text).flatMap((t, r) => [...t].filter((ch, c) => ch !== [...(calm[r] ?? '')][c]).map(() => 1)).length
    if (glitchAt(f) === undefined) assert.equal(changed, 0, `frame ${f} is calm`)
    else assert.ok(changed > 0 && changed <= 40, `frame ${f} glitches a little (${changed} cells)`)
    for (const r of rows) assert.equal(segsWidth(r), LOGO[0]?.length)
  }
  assert.deepEqual(logoRows(REVEAL_FRAMES + 7, theme, true), logoRows(REVEAL_FRAMES + 7, theme, true), 'a frame always glitches the same way')
})

test('the logo is a gradient: colors differ across the row, solid and shadow differ', () => {
  const colors = new Set(logoRows(0, theme, false).flat().filter((s) => s.text.trim() !== '').map((s) => s.color))
  assert.ok(colors.size > 6)
  const frame0 = logoRows(0, theme, true)
  assert.equal(frame0.map(text).join('').trim(), '')
})

test('the greeting carries the user name and badge, and follows the hour', () => {
  const out = lines(homeRows(input({ hour: 8 }))).join('\n')
  assert.match(out, /Good morning, welo ◆/)
  assert.equal(greetingWord(2), 'Up late')
  assert.equal(greetingWord(13), 'Good afternoon')
  assert.equal(greetingWord(21), 'Good evening')
  assert.match(lines(homeRows(input({ look: DEFAULT_LOOK }))).join('\n'), /, welo/, 'falls back to the name in the welcome lines')
})

test('the whole contact code stays readable, wrapped when the pane is narrow', () => {
  for (const width of [92, 60, 40, 30]) {
    const rows = codeRows(CODE, width, theme)
    for (const r of rows) assert.ok(segsWidth(r) <= width)
    const joined = rows.map((r) => r.filter((s) => s.bold === true && s.color === theme.glow).map((s) => s.text).join('')).join('')
    assert.equal(joined, CODE, `${width}`)
  }
  const shown = lines(homeRows(input({ width: 40, height: BANNER_ROWS + 2 }))).join('')
  assert.ok(shown.replaceAll(' ', '').includes(CODE.slice(0, 20)))
})

test('two columns on a wide pane, one stack on a narrow one, START and AGENTS in both', () => {
  const wide = lines(homeRows(input({ width: 92, height: 40 })))
  assert.ok(wide.some((l) => l.includes('START') && l.includes('AGENTS')))
  assert.ok(wide.some((l) => l.includes('PEOPLE')) && wide.some((l) => l.includes('ACTIVITY')))
  const narrow = lines(homeRows(input({ width: 70, height: 60 })))
  for (const title of ['START', 'PEOPLE', 'AGENTS', 'ACTIVITY']) assert.ok(narrow.some((l) => l.includes(title)), title)
  assert.ok(!narrow.some((l) => l.includes('START') && l.includes('AGENTS')))
})

test('a short pane loses cards from the bottom, whole, and never half a title', () => {
  const header = homeRows(input({ width: 92, height: 24 })).length
  const tall = lines(homeRows(input({ width: 70, height: 80 })))
  assert.ok(tall.some((l) => l.includes('START')))
  assert.ok(header > 0)
  // The logo shrinks to a one-line mark at 23 rows, which gives rows back, so each logo mode is checked on its own.
  for (const [from, to] of [[60, 24], [23, BANNER_ROWS]] as const) {
    let last = Number.POSITIVE_INFINITY
    for (let height = from; height >= to; height--) {
      const out = lines(homeRows(input({ width: 70, height }))).join('\n')
      const shown = ['AGENTS', 'PEOPLE', 'ACTIVITY', 'START'].filter((t) => out.includes(t)).length
      assert.ok(shown <= last, `${height}`)
      last = shown
    }
  }
  const tiny = lines(homeRows(input({ width: 70, height: 12 }))).join('\n')
  assert.ok(tiny.includes('AGENTS'))
  assert.ok(!tiny.includes('ACTIVITY'))
})

test('a fresh pager starts with START, everyone else with their agents', () => {
  assert.deepEqual(stackedOrder(stats({ sent: 0, received: 0 }), agents({ rows: [] })), ['start', 'people', 'agents', 'activity'])
  assert.equal(stackedOrder(stats(), agents())[0], 'agents')
  assert.equal(stackedOrder(stats({ sent: 0, received: 0 }), agents())[0], 'agents')
})

test('START shows the key hints as keycaps and every step in full', () => {
  const out = lines(bodyRows(input({ width: 70, height: 80, stats: stats({ sent: 0, received: 0 }), agents: agents({ rows: [] }) }), parseInfo(INFO), 80)).join('\n')
  for (const key of ['‹Ctrl+P›', '‹Ctrl+G›', '‹Alt+↑↓›', '‹/agent setup›']) assert.ok(out.includes(key), key)
  const flat = out.replace(/\s+/g, ' ')
  assert.ok(flat.includes('Send your contact code to a friend'))
  assert.ok(flat.includes('They run /add <your code>; you run /accept 1'))
  assert.ok(flat.includes('Ctrl+P opens the command palette, Ctrl+G shows shortcuts'))
})

test('PEOPLE and ACTIVITY carry the existing numbers as pills', () => {
  const out = lines(bodyRows(input({ width: 70, height: 80 }), parseInfo(INFO), 80)).join('\n')
  for (const needle of ['2 online', 'of 5 contacts', '1 group', '1 pending', '3 unread', '40 sent', '55 received', '28 in 7d', 'top #team']) assert.ok(out.includes(needle), needle)
  assert.ok(lines(bodyRows(input({ width: 70, stats: stats({ busiest: null }) }), parseInfo(INFO), 80)).join('\n').includes('no chats yet'))
})

test('AGENTS: rows in the agent color, state words, pills by context pressure, sparkline, reviews, usage and the hint', () => {
  const look: Look = { ...DEFAULT_LOOK, agentColors: { omp: '#ff00aa' } }
  const card = agentsCard(60, stats(), agents(), look, theme)
  const [first, second] = card.lines
  assert.equal(first?.[0]?.color, '#ff00aa')
  assert.equal(first?.[1]?.color, '#ff00aa')
  assert.ok(first?.[1]?.bold)
  assert.equal(second?.[0]?.color, agentTint(theme, look, 'claude'))
  assert.match(text(first ?? []), /idle/)
  assert.match(text(second ?? []), /working/)
  const ctxPill = (r: readonly Seg[] | undefined): Seg | undefined => r?.find((s) => s.text.includes('ctx'))
  assert.equal(ctxPill(first)?.bg, theme.pill.success.bg)
  assert.equal(ctxPill(second)?.bg, theme.pill.error.bg)
  const body = lines(card.lines).join('\n')
  assert.match(body, /14d/)
  assert.match(body, /1 running/)
  assert.match(body, /2 to merge/)
  assert.match(body, /usage omp: Plan: 41% used, resets in 2h · 5m ago/)
  assert.match(body, /✓ 2/)
  assert.match(lines(card.tail ?? []).join(''), /Alt\+M model/)
  const spark = card.lines.find((r) => text(r).includes('turns in 14d'))
  assert.ok(new Set(spark?.map((s) => s.color)).size > 3, 'sparkline is a gradient')
})

test('AGENTS: with none ready the hint points at /agent setup, in a bright color', () => {
  const card = agentsCard(50, stats(), agents({ rows: [], hint: 'no agents ready — /agent setup · 2 installed, not added' }), DEFAULT_LOOK, theme)
  assert.match(lines(card.lines).join(' '), /coding agents you @mention/)
  const tail = card.tail ?? []
  assert.match(lines(tail).join(' ').replace(/\s+/g, ' '), /no agents ready — \/agent setup · 2 installed, not added/)
  assert.ok(tail.flat().some((s) => s.color === theme.glow))
  assert.match(text(tail[0] ?? []), /^▸ /)
})

test('AGENTS: more than four agents says +N more; a pending question or review shows on the reviews row', () => {
  const many = agents({ rows: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((name) => row({ name })), questions: 2, reviewsPending: 1 })
  const body = lines(agentsCard(60, stats(), many, DEFAULT_LOOK, theme).lines).join('\n')
  assert.match(body, /\+2 more/)
  assert.match(body, /2 asking/)
  assert.match(body, /1 running/)
})

test('agent rows align and drop counts, then model, then context as they narrow, never the name', () => {
  const rows = [row({ name: 'omp', model: 'gpt-5', ctx: 40 }), row({ name: 'opencode', state: 'asking', model: 'sonnet', ctx: 5, changes: 3 })]
  const cols = agentColumns(rows)
  const widths = rows.map((r) => segsWidth(agentRow(r, cols, 200, theme, theme.accent)))
  assert.equal(widths[0], widths[1], 'same width in a column')
  const full = widths[0] ?? 0
  const stages = new Set<string>()
  for (let w = full; w >= 12; w--) {
    const out = text(agentRow(rows[1] ?? row(), cols, w, theme, theme.accent))
    assert.ok(out.startsWith('● opencode'), `${w}`)
    assert.ok(segsWidth(agentRow(rows[1] ?? row(), cols, w, theme, theme.accent)) <= w)
    stages.add(`${out.includes('t ')}${out.includes('sonnet')}${out.includes('ctx')}${out.includes('asking')}`)
  }
  assert.ok(stages.size >= 4, [...stages].join(' '))
})

test('dropToFit removes the highest rank first and keeps rank 0', () => {
  const parts = [
    { rank: 0, segs: [{ text: 'name ' }] },
    { rank: 2, segs: [{ text: 'bb ' }] },
    { rank: 1, segs: [{ text: 'a ' }] },
    { rank: 3, segs: [{ text: 'ccc' }] },
  ]
  assert.equal(text(dropToFit(parts, 20)), 'name bb a ccc')
  assert.equal(text(dropToFit(parts, 10)), 'name bb a ')
  assert.equal(text(dropToFit(parts, 7)), 'name a ')
  assert.equal(text(dropToFit(parts, 3)), 'nam')
})

test('renderCard keeps the tail when lines are cut and cuts from the bottom', () => {
  const card = { title: 'T', lines: [[{ text: 'l1' }], [{ text: 'l2' }], [{ text: 'l3' }]], tail: [[{ text: 'tail' }]] }
  assert.deepEqual(lines(renderCard(card, 20, 99, theme)).slice(1), ['l1', 'l2', 'l3', 'tail'])
  assert.deepEqual(lines(renderCard(card, 20, 4, theme)).slice(1), ['l1', 'l2', 'tail'])
  assert.deepEqual(lines(renderCard(card, 20, 2, theme)).slice(1), ['tail'])
  assert.equal(renderCard(card, 20, 1, theme).length, 1)
})

test('text helpers: wrap by display width, fit pads and ellipsizes, flow breaks rows', () => {
  assert.deepEqual(wrapText('aa bb cc dd', 5), ['aa bb', 'cc dd'])
  assert.deepEqual(wrapText('abcdefgh', 3), ['abc', 'def', 'gh'])
  assert.deepEqual(wrapText('漢字漢字', 4), ['漢字', '漢字'])
  assert.deepEqual(wrapText('漢', 1), ['漢'])
  assert.deepEqual(wrapText('', 5), [''])
  assert.equal(fitText('ab', 5), 'ab   ')
  assert.equal(fitText('abcdef', 4), 'abc…')
  assert.equal(segsWidth([{ text: fitText('漢字漢字', 5) }]), 5)
  const flow = flowSegs([[{ text: 'aaa' }], [{ text: 'bbb' }], [{ text: 'ccc' }]], 8)
  assert.deepEqual(lines(flow), ['aaa  bbb', 'ccc'])
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

test('a tall pane puts the content a little below the top; a short one starts at row 0 with the header only', () => {
  const tall = homeRows(input({ width: 92, height: 80 }))
  assert.equal(text(tall[0] ?? []).trim(), '')
  const short = homeRows(input({ width: 70, height: BANNER_ROWS }))
  assert.ok(short.length <= BANNER_ROWS)
  assert.match(text(short[0] ?? []), /P A G E R/)
})

test('visualFrame draws exactly what the frame it replaces draws, so idle ticks need no re-render', () => {
  for (let f = 0; f < 800; f++) {
    const v = visualFrame(f)
    assert.deepEqual(logoRows(v, theme, true), logoRows(f, theme, true), `logo at ${f}`)
    assert.equal(tagline(v, true), tagline(f, true), `tagline at ${f}`)
  }
  assert.ok(new Set(Array.from({ length: 800 }, (_, f) => visualFrame(f))).size < 120, 'the calm frames collapse onto a few')
})
