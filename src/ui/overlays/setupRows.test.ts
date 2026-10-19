import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SetupRow } from '../../agents/orchestrator.js'
import { setupAction, setupDetail, setupKey, setupLine, type SetupState } from './setupRows.js'

const row = (id: string, readiness: SetupRow['readiness'], extra: Partial<SetupRow> = {}): SetupRow => ({
  id,
  label: id,
  readiness,
  instances: 0,
  command: `${id} acp`,
  custom: false,
  ...extra,
})

const rows = [
  row('omp', { state: 'ready' }),
  row('gemini', { state: 'missing', reason: 'gemini not found on PATH' }, { install: 'npm install -g @google/gemini-cli' }),
  row('goose', { state: 'failed', reason: 'handshake timed out' }),
  row('codex', { state: 'checking' }),
]

const at = (n: number, text = ''): SetupState => ({ row: n, text })

test('every readiness state has a glyph and a word, and the failure reason is carried', () => {
  assert.deepEqual(setupLine(rows[0]!), { glyph: '●', word: 'ready', tone: 'ok' })
  assert.deepEqual(setupLine(rows[1]!), { glyph: '✗', word: 'missing', tone: 'bad', reason: 'gemini not found on PATH' })
  assert.deepEqual(setupLine(rows[2]!), { glyph: '!', word: 'failed', tone: 'bad', reason: 'handshake timed out' })
  assert.equal(setupLine(rows[3]!).glyph, '◌')
  assert.equal(setupLine(row('x', { state: 'unknown' })).word, 'not checked')
})

test('detail lists the command; a ready agent needs nothing more, an agent that is not ready also shows why, install and sign-in', () => {
  assert.deepEqual(setupDetail(row('claude', { state: 'ready' }, { install: 'npm i', auth: 'claude auth login' })), ['runs: claude acp'])
  assert.deepEqual(setupDetail(row('claude', { state: 'failed', reason: 'not signed in' }, { install: 'npm i', auth: 'claude auth login' })), ['runs: claude acp', 'not signed in', 'install: npm i', 'sign in: claude auth login'])
  assert.deepEqual(setupDetail(rows[2]!), ['runs: goose acp', 'handshake timed out'])
})

test('Enter adds a ready agent, shows the install command for a missing one, rechecks a failed one and waits on a checking one', () => {
  assert.deepEqual(setupAction(rows[0]!), { kind: 'add', cli: 'omp' })
  assert.deepEqual(setupAction(rows[1]!), { kind: 'install', text: 'install gemini: npm install -g @google/gemini-cli' })
  assert.deepEqual(setupAction(rows[2]!), { kind: 'recheck', cli: 'goose' })
  assert.deepEqual(setupAction(rows[3]!), { kind: 'wait' })
})

test('Up and Down wrap around the agent rows and the custom row', () => {
  assert.equal(setupKey(at(0), rows, { input: '', upArrow: true }).state.row, rows.length)
  assert.equal(setupKey(at(rows.length), rows, { input: '', downArrow: true }).state.row, 0)
  assert.equal(setupKey(at(1), rows, { input: '', downArrow: true }).state.row, 2)
})

test('Esc closes', () => {
  assert.deepEqual(setupKey(at(0), rows, { input: '', escape: true }).effect, { kind: 'close' })
})

test('r rechecks the selected agent, but types when the custom row is focused', () => {
  assert.deepEqual(setupKey(at(1), rows, { input: 'r' }).effect, { kind: 'recheck', cli: 'gemini' })
  const typed = setupKey(at(rows.length, 'my'), rows, { input: 'r' })
  assert.equal(typed.effect, undefined)
  assert.equal(typed.state.text, 'myr')
})

test('x and Delete remove from the selected agent, but x types when the custom row is focused', () => {
  assert.deepEqual(setupKey(at(1), rows, { input: 'x' }).effect, { kind: 'remove', cli: 'gemini' })
  assert.deepEqual(setupKey(at(0), rows, { input: '', delete: true }).effect, { kind: 'remove', cli: 'omp' })
  assert.equal(setupKey(at(0), rows, { input: 'x', ctrl: true }).effect, undefined)
  const typed = setupKey(at(rows.length, 'my'), rows, { input: 'x' })
  assert.equal(typed.effect, undefined)
  assert.equal(typed.state.text, 'myx')
})

test('printable keys never act on an agent row other than r and x', () => {
  assert.equal(setupKey(at(0), rows, { input: 'q' }).effect, undefined)
  assert.equal(setupKey(at(0), rows, { input: 'a' }).state.text, '')
})

test('the custom row submits /agent add <id> <command…>, and refuses an incomplete line', () => {
  const filled = setupKey(at(rows.length, 'mine node agent.js --acp'), rows, { input: '', return: true })
  assert.deepEqual(filled.effect, { kind: 'custom', command: '/agent add mine node agent.js --acp' })
  assert.equal(filled.state.text, '')
  assert.deepEqual(setupKey(at(rows.length, 'mine'), rows, { input: '', return: true }).effect, { kind: 'usage' })
  assert.deepEqual(setupKey(at(rows.length), rows, { input: '', return: true }).effect, { kind: 'usage' })
})

test('Backspace edits the custom line', () => {
  assert.equal(setupKey(at(rows.length, 'ab'), rows, { input: '', backspace: true }).state.text, 'a')
})
