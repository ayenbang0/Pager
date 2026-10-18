import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentStats } from '../agents/orchestrator.js'
import type { AgentView } from '../agents/types.js'
import { agentHelpSections } from './agentHelp.js'
import { ageText, homeAgents, type HomeAgentsInput } from './homeAgents.js'

const agent = (over: Partial<AgentView> = {}): AgentView => ({ name: 'omp', cli: 'omp', state: 'idle', task: '', unread: 0, ...over })
const week = (): number[] => Array.from({ length: 14 }, (_, i) => (i === 13 ? 3 : 0))
const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
  perAgent: { omp: { turns: 5, files: 7, ms: 1, approved: 2, changes: 1, lastTs: 0 } },
  week: week(),
  reviews: { approved: 2, changes: 1 },
  ...over,
})
const input = (over: Partial<HomeAgentsInput> = {}): HomeAgentsInput => ({
  agents: [agent({ model: 'gpt-5', contextPct: 0.416 })],
  stats: stats(),
  questions: [],
  reviewsPending: 0,
  usages: [],
  unadded: 0,
  now: 1_000_000_000,
  ...over,
})

test('a row per ready agent carries live state, model, context percent and its recorded totals', () => {
  const home = homeAgents(input())
  assert.deepEqual(home.rows, [{ name: 'omp', cli: 'omp', state: 'idle', model: 'gpt-5', ctx: 42, turns: 5, files: 7, approved: 2, changes: 1 }])
  assert.equal(home.week.length, 14)
  assert.equal(home.weekTotal, 3)
  assert.deepEqual([home.approved, home.changes], [2, 1])
})

test('an agent with no recorded turns has zero totals, and a name like a prototype key is safe', () => {
  const home = homeAgents(input({ agents: [agent({ name: 'constructor' })] }))
  assert.equal(home.rows[0]?.turns, 0)
})

test('the hint with no agent ready says /agent setup, and mentions installed agents not yet added', () => {
  assert.equal(homeAgents(input({ agents: [] })).hint, 'no agents ready — /agent setup')
  assert.equal(homeAgents(input({ agents: [], unadded: 2 })).hint, 'no agents ready — /agent setup · 2 installed, not added')
})

test('the hint follows what needs attention: questions, then reviews, then a first task, then more agents', () => {
  const q = [{ id: 'q1', agent: 'omp', message: '', fields: [] }]
  assert.equal(homeAgents(input({ questions: q })).hint, '1 question waiting — Alt+Q')
  assert.equal(homeAgents(input({ reviewsPending: 2 })).hint, '2 reviews running')
  assert.equal(homeAgents(input({ stats: stats({ perAgent: {} }) })).hint, 'try @omp <task> in any chat')
  assert.equal(homeAgents(input({ unadded: 1 })).hint, '1 more installed — /agent setup')
  assert.match(homeAgents(input()).hint, /Alt\+M/)
  assert.match(homeAgents(input()).hint, /Alt\+I invite a contact/)
})

test('usage shows the first non-empty line of the newest fresh text, with its age; stale or empty text is hidden', () => {
  const now = 1_000_000_000
  const usages = [
    { agent: 'omp', text: '\n  Plan: 41% used, resets in 2h\nmore', at: now - 5 * 60_000 },
    { agent: 'claude', text: 'older', at: now - 3_600_000 },
  ]
  assert.deepEqual(homeAgents(input({ usages })).usage, { agent: 'omp', line: 'Plan: 41% used, resets in 2h', age: '5m ago' })
  assert.equal(homeAgents(input({ usages: [{ agent: 'omp', text: 'x', at: now - 2 * 86_400_000 }] })).usage, undefined)
  assert.equal(homeAgents(input({ usages: [{ agent: 'omp', text: '  \n ', at: now }] })).usage, undefined)
})

test('ageText', () => {
  assert.deepEqual([0, 59_000, 60_000, 3_599_000, 7_200_000].map(ageText), ['just now', 'just now', '1m ago', '59m ago', '2h ago'])
})

test('help gets one section per agent: how to talk to it, model and effort, usage, and every advertised command', () => {
  const sections = agentHelpSections({
    agents: [agent({ model: 'gpt-5', contextPct: 0.5 }), agent({ name: 'claude', cli: 'claude' })],
    commandsOf: (n) =>
      n === 'omp'
        ? [
            { name: 'compact', description: 'Shrink context' },
            { name: 'usage', description: 'Limits', hint: 'show|reset' },
          ]
        : [],
    usageOf: (n) => (n === 'omp' ? { text: 'Plan 41%', at: 1_000_000_000 - 60_000 } : undefined),
    now: 1_000_000_000,
  })
  assert.deepEqual(sections.map((s) => s.title), ['Agent omp (omp)', 'Agent claude (claude)'])
  const omp = sections[0]!.rows
  assert.deepEqual(omp[0], ['@omp <message>', 'Talk to it from any chat, or open its tab (omp)'])
  assert.match(omp[1]?.[1] ?? '', /Model gpt-5 · effort default · context 50%/)
  assert.deepEqual(omp[2], ['/agent usage omp', 'Plan 41% (1m ago)'])
  assert.ok(omp.some(([k]) => k === '/agent compact omp'))
  assert.ok(omp.some(([k, v]) => k === '/usage <show|reset>' && v === 'Limits'))
  assert.ok(sections[1]!.rows.some(([k]) => k === 'commands'))
})
