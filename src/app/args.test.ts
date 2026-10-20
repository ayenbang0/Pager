import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from './args.js'

test('no arguments runs pager', () => {
  assert.deepEqual(parseArgs([]), { command: 'run', lan: false, noAgents: false })
})

test('subcommands take no flags', () => {
  for (const c of ['update', 'docs', 'lock', 'unlock'] as const) {
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

test('--cwd on a normal start', () => {
  assert.deepEqual(parseArgs(['--cwd', 'C:\\work']), { command: 'run', lan: false, noAgents: false, cwd: 'C:\\work' })
  assert.deepEqual(parseArgs(['--cwd']), { error: '--cwd needs a folder' })
})

test('pager run: a command, --cwd, and the -- separator', () => {
  const base = { command: 'exec', lan: false, noAgents: false }
  assert.deepEqual(parseArgs(['run', 'npm', 'test', '--', '-x']), { ...base, words: ['npm', 'test', '--', '-x'] })
  assert.deepEqual(parseArgs(['run', '--cwd', 'd', '--', '-weird']), { ...base, cwd: 'd', words: ['-weird'] })
  assert.deepEqual(parseArgs(['run', '--cwd', 'd']), { ...base, cwd: 'd' })
  assert.deepEqual(parseArgs(['run']), { error: 'pager run needs a command or --cwd' })
  assert.deepEqual(parseArgs(['run', '-x']), { error: 'unknown argument: -x' })
  assert.deepEqual(parseArgs(['run', '--cwd']), { error: '--cwd needs a folder' })
})

test('pager desktop: actions, their flags and the errors', () => {
  const base = { command: 'desktop', lan: false, noAgents: false }
  assert.deepEqual(parseArgs(['desktop', 'status']), { ...base, desktop: { action: 'status' } })
  assert.deepEqual(parseArgs(['desktop', 'install', '--exe', 'C:\\p\\Pager.exe']), { ...base, desktop: { action: 'install', exe: 'C:\\p\\Pager.exe' } })
  assert.deepEqual(parseArgs(['desktop', 'launch', '--glass', '--cwd', 'd', '--', 'echo', 'hi']), { ...base, desktop: { action: 'launch', cwd: 'd', words: ['echo', 'hi'], glass: true } })
  assert.deepEqual(parseArgs(['desktop', 'launch']), { ...base, desktop: { action: 'launch' } })
  assert.deepEqual(parseArgs(['desktop']), { error: 'pager desktop needs one of: install, uninstall, launch, status' })
  assert.deepEqual(parseArgs(['desktop', 'nope']), { error: 'pager desktop needs one of: install, uninstall, launch, status' })
  assert.deepEqual(parseArgs(['desktop', 'status', '--exe']), { error: 'pager desktop status does not take --exe' })
  assert.deepEqual(parseArgs(['desktop', 'install', '--glass']), { error: 'pager desktop install does not take --glass' })
  assert.deepEqual(parseArgs(['desktop', 'launch', '--exe']), { error: 'pager desktop launch does not take --exe' })
  assert.deepEqual(parseArgs(['desktop', 'install', '--exe']), { error: '--exe needs a path' })
})
