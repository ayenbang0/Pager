import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { isValidAgentId, Registry, RESERVED_NAMES } from './registry.js'
import { removeTmpDirs, tmpDir } from '../testutil.js'

const tmp = (): string => tmpDir('pager-reg-')

test('default names are the cli, then cli-2, cli-3; an explicit name wins', () => {
  const reg = new Registry(tmp())
  assert.deepEqual(reg.addInstance('omp'), { name: 'omp', cli: 'omp' })
  assert.deepEqual(reg.addInstance('omp'), { name: 'omp-2', cli: 'omp' })
  assert.deepEqual(reg.addInstance('omp'), { name: 'omp-3', cli: 'omp' })
  assert.deepEqual(reg.addInstance('omp', 'ui'), { name: 'ui', cli: 'omp' })
  assert.deepEqual(
    reg.instances().map((c) => c.name),
    ['omp', 'omp-2', 'omp-3', 'ui'],
  )
})

test('removing a name frees it for the next default', () => {
  const reg = new Registry(tmp())
  reg.addInstance('omp')
  reg.addInstance('omp')
  assert.equal(reg.removeInstance('omp'), true)
  assert.equal(reg.removeInstance('omp'), false)
  assert.deepEqual(reg.addInstance('omp'), { name: 'omp', cli: 'omp' })
})

test('explicit names are validated: reserved, malformed and taken are refused', () => {
  const reg = new Registry(tmp())
  reg.addInstance('omp', 'ui')
  for (const name of RESERVED_NAMES) assert.equal(typeof reg.addInstance('omp', name), 'string', name)
  for (const name of ['A', 'x', '1abc', 'has space', 'a'.repeat(25), '-ab']) {
    assert.equal(typeof reg.addInstance('omp', name), 'string', name)
  }
  assert.match(String(reg.addInstance('claude', 'ui')), /already exists/)
  assert.deepEqual(reg.addInstance('claude', 'a'.repeat(24)), { name: 'a'.repeat(24), cli: 'claude' })
  assert.equal(reg.instances().length, 2)
})

test('isValidAgentId boundaries', () => {
  assert.equal(isValidAgentId('ab'), true)
  assert.equal(isValidAgentId('a_b-9'), true)
  assert.equal(isValidAgentId('a'), false)
  assert.equal(isValidAgentId('all'), false)
  assert.equal(isValidAgentId('Omp'), false)
})

test('an unknown cli is refused until a custom agent defines it', () => {
  const reg = new Registry(tmp())
  assert.match(String(reg.addInstance('nope')), /unknown agent/)
  assert.equal(reg.addCustom('nope', ['nope-bin', '--acp']), null)
  assert.deepEqual(reg.addInstance('nope'), { name: 'nope', cli: 'nope' })
})

test('addCustom rejects bad ids and empty commands and keeps nothing', () => {
  const reg = new Registry(tmp())
  assert.match(String(reg.addCustom('all', ['x'])), /reserved/)
  assert.match(String(reg.addCustom('Bad Id', ['x'])), /not a valid id/)
  assert.match(String(reg.addCustom('mine', [])), /command/)
  assert.match(String(reg.addCustom('mine', ['  '])), /command/)
  assert.deepEqual(reg.custom(), {})
})

test('a custom agent wins over a preset with the same id', () => {
  const reg = new Registry(tmp())
  assert.deepEqual(reg.launchFor('omp'), { bin: 'omp', args: ['acp'] })
  assert.equal(reg.addCustom('omp', ['node', 'fake.js', 'x'], { K: 'V' }), null)
  assert.deepEqual(reg.launchFor('omp'), { bin: 'node', args: ['fake.js', 'x'], env: { K: 'V' } })
  assert.equal(reg.launchFor('does-not-exist'), undefined)
  assert.deepEqual(reg.launchFor('claude'), { bin: 'claude-agent-acp', args: [] })
})

test('custom() hands out copies so callers cannot mutate the registry', () => {
  const reg = new Registry(tmp())
  reg.addCustom('mine', ['bin', 'a'])
  reg.custom()['mine']!.args.push('b')
  reg.instances().push({ name: 'x', cli: 'omp' })
  assert.deepEqual(reg.custom()['mine']?.args, ['a'])
  assert.equal(reg.hasInstances(), false)
})

test('ready() filters by readiness and keeps config order', () => {
  const reg = new Registry(tmp())
  reg.addInstance('claude')
  reg.addInstance('omp')
  reg.addInstance('hermes')
  reg.addInstance('omp')
  assert.deepEqual(reg.ready(), [])
  reg.setReadiness('omp', { state: 'ready' })
  reg.setReadiness('hermes', { state: 'failed', reason: 'auth' })
  reg.setReadiness('claude', { state: 'checking' })
  assert.deepEqual(
    reg.ready().map((c) => c.name),
    ['omp', 'omp-2'],
  )
  reg.setReadiness('claude', { state: 'ready' })
  assert.deepEqual(
    reg.ready().map((c) => c.name),
    ['claude', 'omp', 'omp-2'],
  )
  assert.deepEqual(reg.readiness('opencode'), { state: 'unknown' })
  assert.deepEqual(reg.readiness('hermes'), { state: 'failed', reason: 'auth' })
})

test('state persists across a second Registry and leaves no temp file', () => {
  const dir = tmp()
  const first = new Registry(dir)
  first.addCustom('mine', ['bin', '--acp'], { A: 'B' })
  first.addInstance('omp')
  first.addInstance('mine', 'helper')
  first.setModel('omp', 'gpt-5')
  first.setEffort('omp', 'high')
  first.setReview(false)
  first.setAutoCompact(false)
  assert.equal(first.saveError, undefined)
  const second = new Registry(dir)
  assert.deepEqual(second.instances(), [
    { name: 'omp', cli: 'omp', model: 'gpt-5', effort: 'high' },
    { name: 'helper', cli: 'mine' },
  ])
  assert.deepEqual(second.custom(), { mine: { command: 'bin', args: ['--acp'], env: { A: 'B' } } })
  assert.equal(second.review, false)
  assert.equal(second.autoCompact, false)
  assert.deepEqual(fs.readdirSync(dir), ['agents.json'])
  second.setModel('omp', undefined)
  second.setEffort('omp', undefined)
  assert.deepEqual(new Registry(dir).instances()[0], { name: 'omp', cli: 'omp' })
})

test('defaults: review and auto-compact on, nothing configured, readiness is not persisted', () => {
  const dir = tmp()
  const reg = new Registry(dir)
  assert.equal(reg.review, true)
  assert.equal(reg.autoCompact, true)
  assert.equal(reg.hasInstances(), false)
  assert.equal(fs.existsSync(path.join(dir, 'agents.json')), false)
  reg.addInstance('omp')
  reg.setReadiness('omp', { state: 'ready' })
  assert.deepEqual(new Registry(dir).ready(), [])
})

test('a corrupt file yields defaults and is moved to agents.json.bad', () => {
  for (const body of ['{ not json', '[1,2]', '"str"', 'null']) {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'agents.json'), body)
    const reg = new Registry(dir)
    assert.equal(reg.hasInstances(), false, body)
    assert.equal(fs.readFileSync(path.join(dir, 'agents.json.bad'), 'utf8'), body)
    assert.equal(fs.existsSync(path.join(dir, 'agents.json')), false)
    reg.addInstance('omp')
    assert.equal(new Registry(dir).instances().length, 1)
  }
})

test('invalid entries are dropped individually and valid ones survive', () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, 'agents.json'),
    JSON.stringify({
      custom: { good: { command: 'bin', args: ['a', 3], env: { A: 'B', C: 4 } }, all: { command: 'x' }, empty: { command: '' }, bad: 'str' },
      instances: [
        { name: 'omp', cli: 'omp', model: 'm', effort: 5 },
        { name: 'omp', cli: 'claude' },
        { name: 'ghost', cli: 'not-a-cli' },
        { name: 'agents', cli: 'omp' },
        { name: 'g', cli: 'omp' },
        'junk',
        { name: 'helper', cli: 'good' },
      ],
      review: 'yes',
      autoCompact: false,
    }),
  )
  const reg = new Registry(dir)
  assert.deepEqual(reg.custom(), { good: { command: 'bin', args: ['a'], env: { A: 'B' } } })
  assert.deepEqual(reg.instances(), [
    { name: 'omp', cli: 'omp', model: 'm' },
    { name: 'helper', cli: 'good' },
  ])
  assert.equal(reg.review, true)
  assert.equal(reg.autoCompact, false)
  assert.equal(fs.existsSync(path.join(dir, 'agents.json.bad')), false)
})

test('setModel and setEffort on an unknown name change nothing', () => {
  const reg = new Registry(tmp())
  reg.addInstance('omp')
  reg.setModel('ghost', 'x')
  reg.setEffort('ghost', 'x')
  assert.deepEqual(reg.instances(), [{ name: 'omp', cli: 'omp' }])
})

test('a failed save is reported in saveError and does not throw', () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'agents.json'))
  const reg = new Registry(dir)
  assert.equal(typeof reg.addInstance('omp'), 'object')
  assert.equal(typeof reg.saveError, 'string')
  assert.equal(reg.instances().length, 1)
})

after(removeTmpDirs)
