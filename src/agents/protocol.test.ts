import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  parseAsks,
  PROMPT_MAX_CHARS,
  REPLIES_MARKER,
  REQUEST_MAX_CHARS,
  TASK_MARKER,
  withReplies,
} from './protocol.js'

test('parseAsks extracts several blocks and keeps surrounding prose', () => {
  const { clean, asks } = parseAsks('Done.\n@@ask omp\nadd tests\n@@end\nmore\n@@ask Claude\nreview\nit\n@@end\nbye')
  assert.deepEqual(asks, [
    { agent: 'omp', request: 'add tests' },
    { agent: 'claude', request: 'review\nit' },
  ])
  assert.equal(clean, 'Done.\n\nmore\n\nbye')
})

test('parseAsks handles CRLF input', () => {
  const { asks } = parseAsks('x\r\n@@ask omp\r\nhello\r\n@@end\r\n')
  assert.deepEqual(asks, [{ agent: 'omp', request: 'hello' }])
})

test('an unterminated block stays in the text and yields no ask', () => {
  const text = 'a\n@@ask omp\nnever closed'
  assert.deepEqual(parseAsks(text), { clean: text, asks: [] })
})

test('only the first three asks are returned but all blocks are stripped', () => {
  const blocks = ['a', 'b', 'c', 'd'].map((n) => `@@ask omp\n${n}\n@@end`).join('\n')
  const { clean, asks } = parseAsks(`${blocks}\ntail`)
  assert.deepEqual(asks.map((a) => a.request), ['a', 'b', 'c'])
  assert.equal(clean, 'tail')
})

test('over-long requests are cut and empty ones ignored', () => {
  const { asks } = parseAsks(`@@ask omp\n${'x'.repeat(REQUEST_MAX_CHARS + 50)}\n@@end\n@@ask omp\n  \n@@end`)
  assert.equal(asks.length, 1)
  assert.equal(asks[0]?.request.length, REQUEST_MAX_CHARS)
})

test('buildPrompt lists peers without the agent itself', () => {
  const p = buildPrompt({ agent: 'omp', branch: 'pager/omp-1', peers: ['omp', 'claude'], room: [], task: 'go' })
  assert.match(p, /one of several coding agents \(claude\)/)
  assert.match(p, /branch pager\/omp-1/)
  assert.ok(p.endsWith(`${TASK_MARKER}\ngo`))
})

test('buildPrompt drops old room messages before touching the task', () => {
  const room = Array.from({ length: 12 }, (_, i) => ({ author: 'you', text: `${i}`.padEnd(1500, 'x') }))
  const task = 't'.repeat(10_000)
  const p = buildPrompt({ agent: 'omp', branch: 'b', peers: [], room, task })
  assert.ok(p.length <= PROMPT_MAX_CHARS)
  assert.ok(p.endsWith(task))
})

test('buildPrompt truncates a huge task as a last resort', () => {
  const p = buildPrompt({ agent: 'omp', branch: 'b', peers: [], room: [], task: 't'.repeat(PROMPT_MAX_CHARS * 2) })
  assert.ok(p.length <= PROMPT_MAX_CHARS)
  assert.ok(p.endsWith('[truncated]'))
})

test('withReplies appends a marked replies section', () => {
  assert.equal(
    withReplies('task', [
      { run: 'claude-1', text: 'ok' },
      { run: 'omp-2', text: 'fine' },
    ]),
    `task\n\n${REPLIES_MARKER}\n[claude-1] ok\n\n[omp-2] fine`,
  )
})
