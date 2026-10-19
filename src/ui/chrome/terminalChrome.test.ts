import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { shellLabel, termStatus, terminalTitle, type TermInfo } from './terminalChrome.js'

const text = (segs: readonly Seg[]): string => segs.map((s) => s.text).join('')
const idle: TermInfo = { running: false, cwd: 'C:/Users/me/project', last: null }

test('shell names are short and lowercase on every platform', () => {
  assert.equal(shellLabel({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'), 'cmd')
  assert.equal(shellLabel({}, 'win32'), 'cmd')
  assert.equal(shellLabel({ SHELL: '/usr/bin/zsh' }, 'linux'), 'zsh')
  assert.equal(shellLabel({}, 'darwin'), 'sh')
  assert.equal(shellLabel({ ComSpec: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, 'win32'), 'pwsh')
})

test('status pill: idle, running, exit codes, stopped', () => {
  assert.deepEqual(termStatus(idle), { text: 'idle', kind: 'muted' })
  assert.deepEqual(termStatus({ running: true, cwd: '.', last: { command: 'npm test', state: 'running', code: null } }), { text: '● running', kind: 'info' })
  assert.deepEqual(termStatus({ running: false, cwd: '.', last: { command: 'ls', state: 'done', code: 0 } }), { text: '✓ exit 0', kind: 'success' })
  assert.deepEqual(termStatus({ running: false, cwd: '.', last: { command: 'x', state: 'failed', code: 2 } }), { text: '✗ exit 2', kind: 'error' })
  assert.deepEqual(termStatus({ running: false, cwd: '.', last: { command: 'x', state: 'failed', code: null } }), { text: '✗ failed', kind: 'error' })
  assert.deepEqual(termStatus({ running: false, cwd: '.', last: { command: 'x', state: 'stopped', code: null } }), { text: '■ stopped', kind: 'warning' })
})

test('the title row is exactly the width, with the band, shell, directory and status', () => {
  for (const width of [120, 80, 60, 38, 24]) assert.equal(segsWidth(terminalTitle(idle, 'cmd', width, theme)), width, `idle ${width}`)
  const row = terminalTitle(idle, 'bash', 120, theme)
  assert.ok(text(row).startsWith('▌ ▸ terminal'))
  assert.ok(text(row).includes('bash') && text(row).includes('C:/Users/me/project') && text(row).trimEnd().endsWith('idle'))
})

test('a running command replaces the directory; the status pill survives a narrow row', () => {
  const running: TermInfo = { running: true, cwd: 'C:/x', last: { command: 'npm run build -- --watch', state: 'running', code: null } }
  for (const width of [120, 60, 30, 20]) {
    const row = terminalTitle(running, 'cmd', width, theme)
    assert.equal(segsWidth(row), width, `running ${width}`)
    assert.ok(text(row).includes('running'), `status at ${width}`)
  }
  assert.ok(text(terminalTitle(running, 'cmd', 120, theme)).includes('❯ npm run build'))
})

test('exit status pills are filled with the theme success and error colors', () => {
  const ok = terminalTitle({ running: false, cwd: '.', last: { command: 'ls', state: 'done', code: 0 } }, 'sh', 80, theme)
  assert.equal(ok.findLast((s) => s.text.includes('exit'))?.bg, theme.pill.success.bg)
  const bad = terminalTitle({ running: false, cwd: '.', last: { command: 'ls', state: 'failed', code: 1 } }, 'sh', 80, theme)
  assert.equal(bad.findLast((s) => s.text.includes('exit'))?.bg, theme.pill.error.bg)
})
