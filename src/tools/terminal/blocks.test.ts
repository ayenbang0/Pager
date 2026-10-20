import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BlockTracker, cwdFromUri, type CommandBlock } from './blocks.js'
import { newTerm } from './xterm.js'

const setup = (rows = 10, scrollback = 100) => {
  const term = newTerm({ cols: 40, rows, scrollback, allowProposedApi: true })
  let t = 1000
  const tracker = new BlockTracker(term, () => (t += 10))
  const feed = (d: string) => new Promise<void>((r) => term.write(d, r))
  return { term, tracker, feed }
}
const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D = (n: number) => `\x1b]133;D;${n}\x07`

test('a normal command becomes a finished block with output only', async () => {
  const { tracker, feed } = setup()
  const done: CommandBlock[] = []
  tracker.on('finished', (b: CommandBlock) => done.push(b))
  await feed(`${A}$ ${B}ls -l\r\n${C}one\r\ntwo\r\n${D(0)}${A}$ ${B}`)
  const [b] = tracker.list()
  assert.equal(b?.command, 'ls -l')
  assert.equal(b?.exit, 0)
  assert.equal(done.length, 1)
  assert.equal(tracker.text(b?.id ?? 0), 'one\ntwo')
  assert.equal(tracker.seen(), true)
  assert.ok((b?.endedAt ?? 0) > (b?.startedAt ?? 1))
})

test('failing exit codes are recorded and a running block is visible', async () => {
  const { tracker, feed } = setup()
  await feed(`${A}$ ${B}false\r\n${C}partial`)
  assert.equal(tracker.running()?.command, 'false')
  assert.equal(tracker.running()?.exit, null)
  await feed(`\r\n${D(2)}`)
  assert.equal(tracker.running(), undefined)
  assert.equal(tracker.list()[0]?.exit, 2)
})

test('empty Enter presses create no block', async () => {
  const { tracker, feed } = setup()
  await feed(`${A}$ ${B}\r\n${D(0)}${A}$ ${B}\r\n${D(0)}${A}$ ${B}`)
  assert.equal(tracker.list().length, 0)
})

test('a wrapped command is rejoined and a typed command (OSC 633;E) wins', async () => {
  const { tracker, feed } = setup()
  const long = 'x'.repeat(60)
  await feed(`${A}$ ${B}${long}\r\n${C}${D(0)}`)
  assert.equal(tracker.list()[0]?.command, long)
  const typed = Buffer.from('echo hi', 'utf8').toString('base64')
  await feed(`${A}$ ${B}echo hi\x1b]633;E;${typed}\x07${C}hi\r\n${D(0)}`)
  assert.equal(tracker.list()[1]?.command, 'echo hi')
})

test('when C arrives mid-line (PowerShell) output starts on the next row', async () => {
  const { tracker, feed } = setup()
  await feed(`${A}PS> ${B}dir\x1b]633;E;${Buffer.from('dir').toString('base64')}\x07${C}\r\nfile1\r\n${D(0)}`)
  const b = tracker.list()[0]
  assert.equal(tracker.text(b?.id ?? 0), 'file1')
})

test('scrollback overflow drops the oldest blocks', async () => {
  const { tracker, feed } = setup(5, 5)
  for (let i = 0; i < 12; i++) await feed(`${A}$ ${B}c${i}\r\n${C}o\r\no\r\no\r\n${D(0)}`)
  const list = tracker.list()
  assert.ok(list.length < 12 && list.length > 0)
  assert.equal(list.at(-1)?.command, 'c11')
})

test('marks inside the alternate screen are ignored', async () => {
  const { tracker, feed } = setup()
  await feed(`\x1b[?1049h${A}$ ${B}vim\r\n${C}x${D(0)}`)
  assert.equal(tracker.list().length, 0)
  assert.equal(tracker.seen(), false)
})

test('OSC 7 sets the cwd, including Windows drive paths', async () => {
  const { tracker, feed } = setup()
  await feed('\x1b]7;file://host/C:/Users/a%20b\x07')
  assert.equal(tracker.cwd(), 'C:/Users/a b')
  assert.equal(cwdFromUri('file://h/home/u'), '/home/u')
  assert.equal(cwdFromUri('nope'), undefined)
  await feed(`${A}$ ${B}ls\r\n${C}${D(0)}`)
  assert.equal(tracker.list()[0]?.cwd, 'C:/Users/a b')
})

test('text keeps only the last maxChars and rows() spans prompt to output', async () => {
  const { tracker, feed } = setup()
  await feed(`${A}$ ${B}go\r\n${C}abcdefghij\r\n${D(0)}`)
  const b = tracker.list()[0]
  assert.equal(tracker.text(b?.id ?? 0, 4), 'ghij')
  const r = tracker.rows(b?.id ?? 0)
  assert.equal(r?.first, 0)
  assert.equal(r?.last, 1)
})
