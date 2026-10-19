import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunView } from '../../agents/orchestrator.js'
import type { QuestionView } from '../../agents/run/questions.js'
import type { AgentView } from '../../agents/types.js'
import { DEFAULT_THEME } from '../theme/themes.js'
import { agentChip, agentHeaderLeft, chipPillKind, chipSegs, chipWidth, ctxTone, filesChanged, hubHeaderSegs, inviteChipSegs, inviteChipWidth, questionBanner, questionFor, questionTarget, whoDoesWhat } from './agentChrome.js'
import { segsWidth } from '../kit/segs.js'

const agent = (over: Partial<AgentView> = {}): AgentView => ({ name: 'omp', cli: 'omp', state: 'idle', task: '', unread: 0, ...over })
const ask = (id: string, who: string): QuestionView => ({ id, agent: who, message: 'm', fields: [] })

test('context pressure is green below 60, yellow below 85, red from 85', () => {
  assert.deepEqual([0, 59, 60, 84, 85, 100].map(ctxTone), ['ok', 'ok', 'warn', 'warn', 'bad', 'bad'])
})

test('the chip reads model, effort, ctx and never has holes', () => {
  const chip = agentChip(agent({ model: 'gpt-5', effort: 'high', contextPct: 0.416 }))
  assert.deepEqual(chip.map((p) => p.text), ['gpt-5', 'high', 'ctx 42%'])
  assert.deepEqual(chip.map((p) => p.tone), ['ok', 'ok', 'ok'])
  const bare = agentChip(agent())
  assert.deepEqual(bare.map((p) => p.text), ['default model', 'default effort', 'ctx —'])
  assert.equal(agentChip(agent({ contextPct: 0.9 }))[2]?.tone, 'bad')
  assert.equal(agentChip(agent({ contextPct: 0.7 }))[2]?.tone, 'warn')
})

test('chip width is pills with one space of padding each side and one space between, review pill included', () => {
  const chip = agentChip(agent({ model: 'gpt-5', effort: 'high', contextPct: 0.4 }))
  assert.equal(chipWidth(chip, false), ' gpt-5 '.length + 1 + ' high '.length + 1 + ' ctx 40% '.length)
  assert.equal(chipWidth(chip, false), 24)
  assert.equal(chipWidth(chip, true), 24 + 1 + ' ⚑ review on '.length)
  assert.equal(chipWidth(chip, true), 38)
  assert.equal(chipWidth(agentChip(agent()), false), ' default model '.length + 1 + ' default effort '.length + 1 + ' ctx — '.length)
})

test('chipWidth is exactly the width the rendered pills take, so a click on the chip lands on it', () => {
  for (const view of [agent(), agent({ model: 'gpt-5', effort: 'high', contextPct: 0.4 }), agent({ model: 'claude-opus', contextPct: 0.95 })]) {
    for (const review of [false, true]) {
      const chip = agentChip(view)
      assert.equal(segsWidth(chipSegs(chip, review, DEFAULT_THEME)), chipWidth(chip, review))
    }
  }
})

test('chip pills: model accent, effort accent2, context by pressure, defaults muted', () => {
  assert.deepEqual([chipPillKind(0, 'ok'), chipPillKind(1, 'ok'), chipPillKind(2, 'ok'), chipPillKind(2, 'warn'), chipPillKind(2, 'bad')], ['accent', 'accent2', 'success', 'warning', 'error'])
  assert.deepEqual([0, 1, 2].map((i) => chipPillKind(i, 'dim')), ['muted', 'muted', 'muted'])
  const segs = chipSegs(agentChip(agent({ model: 'gpt-5', contextPct: 0.9 })), true, DEFAULT_THEME)
  assert.deepEqual(segs.filter((s) => s.bg !== undefined).map((s) => s.bg), [
    DEFAULT_THEME.pill.accent.bg,
    DEFAULT_THEME.pill.muted.bg,
    DEFAULT_THEME.pill.error.bg,
    DEFAULT_THEME.pill.success.bg,
  ])
})

const textOf = (segs: readonly { text: string }[]): string => segs.map((s) => s.text).join('')

test('agent header: identity pill in the agent color, cli, dim idle, task, files pill', () => {
  const left = agentHeaderLeft(agent({ name: 'omp', cli: 'oh-my-pi', task: 'fix parser' }), 3, DEFAULT_THEME, '#ff00aa')
  assert.equal(left.cell, undefined)
  assert.equal(textOf(left.before), ' ' + ' ◆ omp ' + ' oh-my-pi' + ' ' + '●' + ' idle' + ' fix parser' + ' ' + ' 3 files changed ')
  assert.equal(left.before[1]?.bg, '#ff00aa')
  assert.equal(left.before.at(-1)?.bg, DEFAULT_THEME.pill.muted.bg)
  assert.equal(textOf(agentHeaderLeft(agent(), 1, DEFAULT_THEME, '#ff00aa').before).endsWith(' 1 file changed '), true)
})

test('agent header: working and asking leave one cell for the spinner or blinking ? inside their pill', () => {
  const working = agentHeaderLeft(agent({ state: 'working', task: 't' }), 0, DEFAULT_THEME, '#ff00aa')
  assert.equal(working.cell?.kind, 'spinner')
  assert.equal(working.cell?.pill, DEFAULT_THEME.pill.accent2)
  assert.equal(textOf(working.before).endsWith(' ') && working.before.at(-1)?.bg === DEFAULT_THEME.pill.accent2.bg, true)
  assert.equal(textOf(working.after), ' working ' + ' t')
  const asking = agentHeaderLeft(agent({ state: 'asking' }), 0, DEFAULT_THEME, '#ff00aa')
  assert.equal(asking.cell?.kind, 'blink')
  assert.equal(textOf(asking.after), ' asking you ')
  assert.equal(agentHeaderLeft(agent({ state: 'reviewing' }), 0, DEFAULT_THEME, '#ff00aa').cell, undefined)
  assert.equal(textOf(agentHeaderLeft(agent({ state: 'reviewing' }), 0, DEFAULT_THEME, '#ff00aa').before).includes(' reviewing '), true)
})

test('hub header: AGENTS pill, goal pill clipped to its budget, who-does-what text', () => {
  const agents = [agent({ state: 'working', task: 'fix parser' })]
  assert.equal(textOf(hubHeaderSegs(agents, '', 40, DEFAULT_THEME)), ' ' + ' ⌁ AGENTS ' + ' omp ▸ fix parser')
  assert.equal(textOf(hubHeaderSegs(agents, 'ship it', 40, DEFAULT_THEME)), ' ' + ' ⌁ AGENTS ' + ' ' + ' goal: ship it ' + ' omp ▸ fix parser')
  const clipped = hubHeaderSegs(agents, 'x'.repeat(100), 30, DEFAULT_THEME)
  assert.equal(clipped[3]?.text, ` goal: ${'x'.repeat(21)}… `)
})

test('files changed come from the latest run of that agent', () => {
  const runs: RunView[] = [
    { id: 'omp-1', agent: 'omp', state: 'done', files: 3, mergeable: false },
    { id: 'claude-1', agent: 'claude', state: 'done', files: 9, mergeable: false },
    { id: 'omp-2', agent: 'omp', state: 'done', files: 1, mergeable: true },
  ]
  assert.equal(filesChanged(runs, 'omp'), 1)
  assert.equal(filesChanged(runs, 'hermes'), 0)
})

test('the hub header says who works on what', () => {
  assert.equal(whoDoesWhat([]), 'no agents ready — Alt+S › Agents')
  assert.equal(
    whoDoesWhat([agent({ state: 'working', task: 'fix parser' }), agent({ name: 'claude', cli: 'claude' }), agent({ name: 'oc', state: 'asking' }), agent({ name: 'h', state: 'reviewing' })]),
    'omp ▸ fix parser · claude idle · oc asks · h reviews',
  )
})

test('the banner points at questions the picker is not already showing', () => {
  const views = [ask('q1', 'omp'), ask('q2', 'claude'), ask('q3', 'hermes')]
  assert.equal(questionBanner([], undefined), undefined)
  assert.equal(questionBanner([views[0]!], views[0]), undefined)
  assert.equal(questionBanner(views, views[0]), 'claude has a question — Alt+Q (+1 more)')
  assert.equal(questionBanner([views[0]!], undefined), 'omp has a question — Alt+Q')
})

test('an agent tab shows its own question; the hub shows the oldest; other tabs show none', () => {
  const views = [ask('q1', 'omp'), ask('q2', 'claude')]
  assert.equal(questionFor(views, 'claude', false)?.id, 'q2')
  assert.equal(questionFor(views, 'hermes', false), undefined)
  assert.equal(questionFor(views, undefined, true)?.id, 'q1')
  assert.equal(questionFor(views, undefined, false), undefined)
})

test('Alt+Q goes to the oldest question that is not on screen, else the oldest', () => {
  const views = [ask('q1', 'omp'), ask('q2', 'claude')]
  assert.equal(questionTarget(views, views[0])?.id, 'q2')
  assert.equal(questionTarget(views, undefined)?.id, 'q1')
  assert.equal(questionTarget([views[0]!], views[0])?.id, 'q1')
  assert.equal(questionTarget([], undefined), undefined)
})

test('the invite chip width matches what is drawn, with and without guests', () => {
  for (const guests of [0, 1, 2]) {
    assert.equal(inviteChipWidth(guests), segsWidth(inviteChipSegs(guests, DEFAULT_THEME)), `${guests} guests`)
  }
  assert.match(inviteChipSegs(2, DEFAULT_THEME).map((s) => s.text).join(''), /2 guests .*Alt\+I/)
})
