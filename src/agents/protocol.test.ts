import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  chainTask,
  CONTEXT_MESSAGE_CHARS,
  CONTEXT_MESSAGES,
  EARLIER_MARKER,
  MAX_CHAIN,
  MAX_NOTES_PER_RUN,
  MEMORY_MARKER,
  NOTE_MAX_CHARS,
  parseAsks,
  parseChain,
  parseDocEdits,
  DOCS_MARKER,
  parseRemember,
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
  const p = buildPrompt({ agent: 'omp', branch: 'pager/omp-1', peers: ['omp', 'claude'], memory: '', room: [], task: 'go' })
  assert.match(p, /one of several coding agents \(claude\)/)
  assert.match(p, /branch pager\/omp-1/)
  assert.ok(p.endsWith(`${TASK_MARKER}\ngo`))
})

test('buildPrompt drops old room messages before touching the task', () => {
  const room = Array.from({ length: CONTEXT_MESSAGES }, (_, i) => ({ author: 'you', text: `${i}`.padEnd(CONTEXT_MESSAGE_CHARS, 'x') }))
  const task = 't'.repeat(PROMPT_MAX_CHARS - 10_000)
  const p = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '', room, task })
  assert.ok(p.length <= PROMPT_MAX_CHARS)
  assert.ok(p.endsWith(task))
})

test('buildPrompt truncates a huge task as a last resort', () => {
  const p = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '', room: [], task: 't'.repeat(PROMPT_MAX_CHARS * 2) })
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

test('parseRemember extracts one-line notes, tolerates indentation and strips every block', () => {
  const { clean, notes } = parseRemember('Done.\n@@remember\nuse tabs\nfor indent\n@@end\n  @@remember\n  run npm test\n  @@end\nbye')
  assert.deepEqual(notes, ['use tabs for indent', 'run npm test'])
  assert.equal(clean, 'Done.\n\n\nbye')
})

test('parseRemember caps note length and count and drops empty notes', () => {
  const long = parseRemember(`@@remember\n${'x'.repeat(NOTE_MAX_CHARS + 50)}\n@@end`)
  assert.equal(long.notes[0]?.length, NOTE_MAX_CHARS)
  const many = Array.from({ length: MAX_NOTES_PER_RUN + 2 }, (_, i) => `@@remember\nn${i}\n@@end`).join('\n')
  assert.equal(parseRemember(many).notes.length, MAX_NOTES_PER_RUN)
  assert.deepEqual(parseRemember('@@remember\n  \n@@end').notes, [])
})

test('buildPrompt places MEMORY before ROOM and still honors the size cap', () => {
  const p = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '- 2024-01-01 (you) use tabs', room: [{ author: 'you', text: 'hi' }], task: 'go' })
  assert.ok(p.indexOf(MEMORY_MARKER) > 0 && p.indexOf(MEMORY_MARKER) < p.indexOf('--- ROOM ---'))
  assert.match(p, /use tabs/)
  const big = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: 'm'.repeat(50_000), room: [], task: 't'.repeat(PROMPT_MAX_CHARS) })
  assert.ok(big.length <= PROMPT_MAX_CHARS)
  assert.doesNotMatch(buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '  ', room: [], task: 'go' }), /--- MEMORY ---/)
})

test('parseChain accepts 2..MAX_CHAIN known agents, case-insensitively', () => {
  assert.deepEqual(parseChain('omp>claude'), ['omp', 'claude'])
  assert.deepEqual(parseChain('OMP>Claude>hermes'), ['omp', 'claude', 'hermes'])
  assert.equal(parseChain('omp'), undefined)
  assert.equal(parseChain('omp>nope'), undefined)
  assert.equal(parseChain(Array.from({ length: MAX_CHAIN + 1 }, () => 'omp').join('>')), undefined)
})

test('chainTask names the previous run and carries the original task and its reply', () => {
  const t = chainTask('add x', { run: 'omp-1', text: 'did x' })
  assert.match(t, /^Another agent \(omp-1\) already worked on this task/)
  assert.match(t, /Original task: add x/)
  assert.match(t, /omp-1 replied:\ndid x/)
})

test('@@doc and @@docappend blocks become edits and leave the reply clean; extra blocks are dropped', () => {
  const reply = ['Done.', '@@doc plan.md', '# Plan', '', 'step', '@@end', 'More text', '@@docappend notes.md', 'one more line', '@@end'].join('\n')
  const { clean, edits } = parseDocEdits(reply)
  assert.equal(clean, 'Done.\n\nMore text')
  assert.deepEqual(edits, [
    { name: 'plan.md', append: false, text: '# Plan\n\nstep', cut: false },
    { name: 'notes.md', append: true, text: 'one more line', cut: false },
  ])
  const many = Array.from({ length: 9 }, (_, i) => `@@doc d${i}.md\nx\n@@end`).join('\n')
  assert.equal(parseDocEdits(many).edits.length, 5)
  assert.equal(parseDocEdits(many).clean, '')
})

test('buildPrompt includes a DOCS section only when documents exist, and caps its size', () => {
  const none = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '', room: [], task: 't' })
  assert.equal(none.includes(DOCS_MARKER), false)
  const some = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '', docs: [{ name: 'plan.md', text: '# Plan' }], room: [], task: 't' })
  assert.ok(some.indexOf(DOCS_MARKER) > 0 && some.indexOf(DOCS_MARKER) < some.indexOf('--- ROOM ---'))
  assert.ok(some.includes('## plan.md\n# Plan'))
  const big = buildPrompt({ agent: 'omp', branch: 'b', peers: [], memory: '', docs: [{ name: 'a.md', text: 'x'.repeat(50_000) }], room: [], task: 't' })
  assert.ok(big.includes('[truncated'))
  assert.ok(big.length < 20_000)
})
