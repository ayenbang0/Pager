import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TermInfo } from '../../tools/terminal/sessions.js'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { termStatus, terminalTitle } from './terminalChrome.js'

const text = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('')
const idle: TermInfo = { shell: 'bash', cwd: 'C:/Users/me/project', title: '', exited: null, running: null, last: null, unavailable: null }

test('status pill: idle, running, exit codes, shell exit, unavailable', () => {
  assert.deepEqual(termStatus(idle), { text: 'idle', kind: 'muted' })
  assert.deepEqual(termStatus({ ...idle, running: { command: 'npm test', since: 0 } }), { text: '● running', kind: 'info' })
  assert.deepEqual(termStatus({ ...idle, last: { command: 'ls', exit: 0, ms: 5 } }), { text: '✓ exit 0', kind: 'success' })
  assert.deepEqual(termStatus({ ...idle, last: { command: 'x', exit: 2, ms: 5 } }), { text: '✗ exit 2', kind: 'error' })
  assert.deepEqual(termStatus({ ...idle, exited: 0 }), { text: 'exit 0', kind: 'muted' })
  assert.deepEqual(termStatus({ ...idle, exited: 1 }), { text: 'exit 1', kind: 'error' })
  assert.deepEqual(termStatus({ ...idle, unavailable: 'no prebuild' }), { text: '✗ unavailable', kind: 'error' })
})

test('the title row is exactly the width, with the band, shell, directory and status', () => {
  for (const width of [120, 80, 60, 38, 24]) assert.equal(segsWidth(terminalTitle(idle, width, theme)), width, `idle ${width}`)
  const row = terminalTitle(idle, 120, theme)
  assert.ok(text(row).startsWith('▌ ▸ terminal'))
  assert.ok(text(row).includes('bash') && text(row).includes('C:/Users/me/project') && text(row).trimEnd().endsWith('idle'))
})

test('a running command replaces the directory and the status stays visible when narrow', () => {
  const running: TermInfo = { ...idle, running: { command: 'npm run build', since: 0 } }
  for (const width of [120, 60, 30, 20]) {
    const row = terminalTitle(running, width, theme)
    assert.equal(segsWidth(row), width, `running ${width}`)
    assert.ok(text(row).includes('running'), `status at ${width}`)
  }
  assert.ok(text(terminalTitle(running, 120, theme)).includes('❯ npm run build'))
})

test('later tabs are numbered, the window title follows the directory, and a missing shell has no pill', () => {
  assert.ok(text(terminalTitle(idle, 120, theme, 3)).includes('▸ terminal 3'))
  assert.ok(text(terminalTitle({ ...idle, title: 'vim' }, 120, theme)).includes('C:/Users/me/project · vim'))
  const none = terminalTitle({ ...idle, shell: '' }, 80, theme)
  assert.equal(segsWidth(none), 80)
  assert.ok(!text(none).includes('bash'))
})

test('exit status pills are filled with the theme success and error colors', () => {
  const ok = terminalTitle({ ...idle, last: { command: 'ls', exit: 0, ms: 1 } }, 80, theme)
  assert.equal(ok.findLast((s) => s.text.includes('exit'))?.bg, theme.pill.success.bg)
  const bad = terminalTitle({ ...idle, last: { command: 'ls', exit: 1, ms: 1 } }, 80, theme)
  assert.equal(bad.findLast((s) => s.text.includes('exit'))?.bg, theme.pill.error.bg)
})
