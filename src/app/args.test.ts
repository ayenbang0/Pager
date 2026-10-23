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

test('daemon commands: daemon, split, capture, open, send, events', () => {
  const base = { command: 'daemon', lan: false, noAgents: false }
  assert.deepEqual(parseArgs(['daemon', 'start']), { ...base, daemon: { verb: 'daemon', action: 'start' } })
  assert.deepEqual(parseArgs(['daemon']), { ...base, daemon: { verb: 'daemon', action: 'serve' } })
  assert.ok('error' in parseArgs(['daemon', 'nope']))
  assert.deepEqual(parseArgs(['split', 'down', '--pane', '3', '--cwd', 'd', '--', 'npm', 'test']), { ...base, daemon: { verb: 'split', dir: 'col', pane: '3', cwd: 'd', words: ['npm', 'test'] } })
  assert.deepEqual(parseArgs(['split', 'right']), { ...base, daemon: { verb: 'split', dir: 'row', words: [] } })
  assert.ok('error' in parseArgs(['split', 'sideways']))
  assert.deepEqual(parseArgs(['capture', '--lines', '20', '--ansi']), { ...base, daemon: { verb: 'capture', ansi: true, json: false, lines: 20 } })
  assert.ok('error' in parseArgs(['capture', '--lines', 'x']))
  assert.deepEqual(parseArgs(['events', '--filter', 'pane_spawned,bell']), { ...base, daemon: { verb: 'events', filter: ['pane_spawned', 'bell'] } })
  assert.deepEqual(parseArgs(['open', '--tab', 'a.ts:3:4', 'https://x.dev']), { ...base, daemon: { verb: 'open', tab: true, targets: ['a.ts:3:4', 'https://x.dev'] } })
  assert.ok('error' in parseArgs(['open']))
  assert.deepEqual(parseArgs(['send', '--no-enter', 'ls', '-la']), { ...base, daemon: { verb: 'send', enter: false, text: 'ls -la' } })
  assert.deepEqual(parseArgs(['ls', '--json']), { ...base, daemon: { verb: 'ls', json: true } })
})
