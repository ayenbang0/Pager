import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from './args.js'

test('no arguments runs pager', () => {
  assert.deepEqual(parseArgs([]), { command: 'run', lan: false, noAgents: false })
})

test('subcommands take no flags', () => {
  for (const c of ['update', 'lock', 'unlock'] as const) {
    assert.equal((parseArgs([c]) as { command: string }).command, c)
    assert.ok('error' in parseArgs([c, '--lan']))
  }
})

test('help and version flags', () => {
  assert.equal((parseArgs(['-h']) as { command: string }).command, 'help')
  assert.equal((parseArgs(['--help']) as { command: string }).command, 'help')
  assert.equal((parseArgs(['-v']) as { command: string }).command, 'version')
  assert.equal((parseArgs(['--version']) as { command: string }).command, 'version')
})

test('--lan alone, with host:port, and --no-agents', () => {
  assert.deepEqual(parseArgs(['--lan']), { command: 'run', lan: true, noAgents: false })
  assert.deepEqual(parseArgs(['--lan', '192.168.1.5:49737']), { command: 'run', lan: true, lanTarget: '192.168.1.5:49737', noAgents: false })
  assert.deepEqual(parseArgs(['--lan', '--no-agents']), { command: 'run', lan: true, noAgents: true })
  assert.deepEqual(parseArgs(['--no-agents', '--lan', 'box.local:9000']), { command: 'run', lan: true, lanTarget: 'box.local:9000', noAgents: true })
})

test('anything else is an error', () => {
  assert.ok('error' in parseArgs(['--wat']))
  assert.ok('error' in parseArgs(['--lan', 'nope']))
  assert.ok('error' in parseArgs(['update', 'x']))
})
