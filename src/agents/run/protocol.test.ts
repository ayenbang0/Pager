import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrompt,
  chainTask,
  CONTEXT_MESSAGE_CHARS,
  CONTEXT_MESSAGES,
  DOCS_MARKER,
  docCap,
  DOCS_MAX_CHARS,
  formatMessages,
  MAX_CHAIN,
  MEMORY_MARKER,
  MESSAGES_MARKER,
  parseChain,
  PROMPT_MAX_CHARS,
  ROOM_MARKER,
  splitArgs,
} from './protocol.js'

const base = { agent: 'omp', branch: 'pager/omp', board: '--- BOARD ---', memory: '', room: [], messages: 'go', tools: true }

test('the prompt names the agent, its branch, and ends with the new messages', () => {
  const p = buildPrompt({ ...base, messages: formatMessages([{ from: 'you', kind: 'user', text: 'go' }]) })
  assert.match(p, /You are "omp"/)
  assert.match(p, /branch pager\/omp/)
  assert.ok(p.endsWith(`${MESSAGES_MARKER}\n[you user] go`))
})

test('messages show who spoke, of what kind, and who else heard it', () => {
  const text = formatMessages([
    { from: 'you', kind: 'user', text: 'split the work', also: ['claude'] },
    { from: 'claude', kind: 'peer', text: 'taking the css' },
  ])
  assert.equal(text, '[you user] (also sent to: claude) split the work\n[claude peer] taking the css')
})

test('the board goes ahead of memory, documents and the room', () => {
  const p = buildPrompt({ ...base, board: '--- BOARD ---\nGOAL: ship', memory: '- note', docs: [{ name: 'a.md', text: 'x' }], room: [{ author: 'you', text: 'hi' }] })
  const at = (marker: string): number => p.indexOf(marker)
  assert.ok(at('--- BOARD ---') > 0 && at('--- BOARD ---') < at(MEMORY_MARKER))
  assert.ok(at(MEMORY_MARKER) < at(DOCS_MARKER) && at(DOCS_MARKER) < at(ROOM_MARKER) && at(ROOM_MARKER) < at(MESSAGES_MARKER))
})

test('without tools the prompt says so instead of promising them', () => {
  assert.match(buildPrompt({ ...base, tools: false }), /TOOLS: unavailable this turn/)
  assert.doesNotMatch(buildPrompt({ ...base, tools: false }), /send_message/)
  assert.match(buildPrompt(base), /send_message/)
})

test('old room messages are dropped before the messages are touched', () => {
  const room = Array.from({ length: CONTEXT_MESSAGES }, (_, i) => ({ author: 'you', text: `${i}`.padEnd(CONTEXT_MESSAGE_CHARS, 'x') }))
  const messages = 't'.repeat(PROMPT_MAX_CHARS - 10_000)
  const p = buildPrompt({ ...base, room, messages })
  assert.ok(p.length <= PROMPT_MAX_CHARS)
  assert.ok(p.endsWith(messages))
})

test('a huge message is truncated as a last resort', () => {
  const p = buildPrompt({ ...base, messages: 't'.repeat(PROMPT_MAX_CHARS * 2) })
  assert.ok(p.length <= PROMPT_MAX_CHARS)
  assert.ok(p.endsWith('[truncated]'))
})

test('a MEMORY section appears only for non-blank memory and still honors the size cap', () => {
  const p = buildPrompt({ ...base, memory: '- 2024-01-01 (you) use tabs', room: [{ author: 'you', text: 'hi' }] })
  assert.ok(p.indexOf(MEMORY_MARKER) > 0 && p.indexOf(MEMORY_MARKER) < p.indexOf(ROOM_MARKER))
  assert.match(p, /use tabs/)
  assert.ok(buildPrompt({ ...base, memory: 'm'.repeat(50_000), messages: 't'.repeat(PROMPT_MAX_CHARS) }).length <= PROMPT_MAX_CHARS)
  assert.doesNotMatch(buildPrompt({ ...base, memory: '  ' }), /--- MEMORY ---/)
})

test('a DOCS section appears only when documents exist, and its size is capped', () => {
  assert.equal(buildPrompt(base).includes(DOCS_MARKER), false)
  const some = buildPrompt({ ...base, docs: [{ name: 'plan.md', text: '# Plan' }] })
  assert.ok(some.includes('## plan.md\n# Plan'))
  const big = buildPrompt({ ...base, docs: [{ name: 'a.md', text: 'x'.repeat(50_000) }] })
  assert.ok(big.includes('[truncated'))
  assert.ok(big.length < 20_000)
  assert.equal(docCap(2), DOCS_MAX_CHARS / 2)
})

test('parseChain accepts 2..MAX_CHAIN ready agents, case-insensitively', () => {
  const names = ['omp', 'claude', 'hermes', 'ui']
  assert.deepEqual(parseChain('omp>claude', names), ['omp', 'claude'])
  assert.deepEqual(parseChain('OMP>Claude>hermes', names), ['omp', 'claude', 'hermes'])
  assert.deepEqual(parseChain('omp>ui', names), ['omp', 'ui'])
  assert.equal(parseChain('omp', names), undefined)
  assert.equal(parseChain('omp>nope', names), undefined)
  assert.equal(parseChain(Array.from({ length: MAX_CHAIN + 1 }, () => 'omp').join('>'), names), undefined)
})

test('chainTask names the previous run and carries the original task and its reply', () => {
  const t = chainTask('add x', { run: 'omp-1', text: 'did x' })
  assert.match(t, /^Another agent \(omp-1\) already worked on this task/)
  assert.match(t, /Original task: add x/)
  assert.match(t, /omp-1 replied:\ndid x/)
})

test('splitArgs groups quoted words and keeps backslashes', () => {
  assert.deepEqual(splitArgs('mcp add "my server" --path C:\\x\\y \'a b\' ""'), ['mcp', 'add', 'my server', '--path', 'C:\\x\\y', 'a b', ''])
  assert.deepEqual(splitArgs('   '), [])
})
