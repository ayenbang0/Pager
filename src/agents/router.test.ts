import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FORWARD_THRESHOLD, parseMentions, relevance } from './router.js'

const NAMES = ['omp', 'claude', 'omp-2']

test('several mentions all become targets, in first-appearance order, without duplicates', () => {
  assert.deepEqual(parseMentions('@claude and @omp: hello @claude', NAMES), { targets: ['claude', 'omp'], unknown: [] })
})

test('mentions work mid-sentence, are case-insensitive and keep hyphenated names whole', () => {
  assert.deepEqual(parseMentions('hey @OMP-2, ask @Omp.', NAMES).targets, ['omp-2', 'omp'])
})

test('@all expands to every name; later explicit mentions add nothing new', () => {
  assert.deepEqual(parseMentions('@all look at this @omp', NAMES).targets, NAMES)
  assert.deepEqual(parseMentions('@claude then @all', NAMES).targets, ['claude', 'omp', 'omp-2'])
})

test('unknown mentions are reported once and never targeted', () => {
  assert.deepEqual(parseMentions('@zed @omp @zed @all', ['omp']), { targets: ['omp'], unknown: ['zed'] })
})

test('no ready names: @all targets nobody', () => {
  assert.deepEqual(parseMentions('@all hi', []), { targets: [], unknown: [] })
})

test('emails, double @ and mid-word @ are not mentions', () => {
  assert.deepEqual(parseMentions('mail me at bob@omp.dev or @@omp or x@claude', NAMES), { targets: [], unknown: [] })
})

test('mentions inside inline code and fenced code are ignored', () => {
  assert.deepEqual(parseMentions('use `@omp` here', NAMES).targets, [])
  assert.deepEqual(parseMentions('```\n@omp\n```\n@claude', NAMES).targets, ['claude'])
  assert.deepEqual(parseMentions('```ts\n@omp unterminated', NAMES).targets, [])
})

test('the chain syntax @a>b yields no target but a plain @a> does', () => {
  assert.deepEqual(parseMentions('@omp>claude fix it', NAMES), { targets: [], unknown: [] })
  assert.deepEqual(parseMentions('@omp> quote', NAMES).targets, ['omp'])
  assert.deepEqual(parseMentions('@omp>claude fix, cc @omp-2', NAMES).targets, ['omp-2'])
})

test('a file the task touched is enough to forward', () => {
  const r = relevance('can you rename helpers in Sidebar.tsx?', { task: 'refactor', files: ['src/ui/sidebar.tsx'] })
  assert.equal(r.score, 3)
  assert.ok(r.score >= FORWARD_THRESHOLD)
  assert.match(r.reason, /sidebar\.tsx/)
})

test('file matching uses the basename of both path styles', () => {
  assert.equal(relevance('see engine.ts', { task: '', files: ['src\\engine.ts'] }).score, 3)
  assert.equal(relevance('nothing here', { task: '', files: ['src/engine.ts'] }).score, 0)
})

test('the same basename in two folders counts once', () => {
  assert.equal(relevance('index.ts', { task: '', files: ['a/index.ts', 'b/index.ts'] }).score, 3)
})

test('one shared keyword stays below the threshold, two reach it', () => {
  const task = 'migrate database schema'
  const one = relevance('the schema looks odd', { task, files: [] })
  assert.equal(one.score, 1)
  assert.ok(one.score < FORWARD_THRESHOLD)
  const two = relevance('is the database schema stable', { task, files: [] })
  assert.equal(two.score, 2)
  assert.ok(two.score >= FORWARD_THRESHOLD)
  assert.match(two.reason, /database/)
  assert.match(two.reason, /schema/)
})

test('repeated and stopword or short words do not count', () => {
  const task = 'please work with this thing and fix it'
  assert.equal(relevance('please work with this thing, schema schema schema', { task, files: [] }).score, 0)
  assert.equal(relevance('migrate migrate migrate', { task: 'migrate it', files: [] }).score, 1)
})

test('numbers alone are not keywords', () => {
  assert.equal(relevance('version 2024', { task: 'release 2024', files: [] }).score, 0)
})

test('empty task and files score zero with an empty reason', () => {
  assert.deepEqual(relevance('anything at all', { task: '', files: [] }), { score: 0, reason: '' })
  assert.deepEqual(relevance('', { task: 'migrate database', files: ['a.ts'] }), { score: 0, reason: '' })
})

test('file hits and keywords add up', () => {
  const r = relevance('router.ts needs the database schema', { task: 'database schema', files: ['router.ts'] })
  assert.equal(r.score, 3 + 2)
})
