import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  CONTEXT_MESSAGE_CHARS,
  CONTEXT_MESSAGES,
  EARLIER_MARKER,
  parseAsks,
  PROMPT_MAX_CHARS,
  REPLIES_MARKER,
  REQUEST_MAX_CHARS,
  splitArgs,
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
  const room = Array.from({ length: CONTEXT_MESSAGES }, (_, i) => ({ author: 'you', text: `${i}`.padEnd(CONTEXT_MESSAGE_CHARS, 'x') }))
  const task = 't'.repeat(PROMPT_MAX_CHARS - 10_000)
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

test('withReplies carries the agent\'s own earlier reply so a resumed run remembers it', () => {
  const out = withReplies('task', [{ run: 'omp-1', text: 'ok' }], 'I did X')
  assert.ok(out.endsWith(`${EARLIER_MARKER}\nI did X`))
})

test('ask blocks may be indented', () => {
  assert.deepEqual(parseAsks('done\n  @@ask omp\n  review it\n  @@end').asks, [{ agent: 'omp', request: 'review it' }])
})

test('splitArgs groups quoted words and keeps backslashes', () => {
  assert.deepEqual(splitArgs('mcp add "my server" --path C:\\x\\y \'a b\' ""'), ['mcp', 'add', 'my server', '--path', 'C:\\x\\y', 'a b', ''])
  assert.deepEqual(splitArgs('   '), [])
})
