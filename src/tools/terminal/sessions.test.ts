import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, test } from 'node:test'
import type { PtySession } from './pty.js'
import { isTermTab, MAX_TERMS, TERM_ID, Terminals, termTabId } from './sessions.js'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'

after(removeTmpDirs)

interface Fake extends EventEmitter {
  cwd: string
  killed: boolean
  seen: boolean
  written: string[]
}

const make = (integrated = true) => {
  const started: Fake[] = []
  const t = new Terminals({
    cwd: '/start',
    env: {},
    dir: tmpDir('pager-terms-'),
    start: async () => {
      await new Promise((r) => setTimeout(r, 5))
      const f = Object.assign(new EventEmitter(), {
        cwd: `/s${started.length}`,
        killed: false,
        seen: false,
        written: [] as string[],
        shell: { label: 'bash', integrated },
        title: '',
        exit: null,
        blocks: { running: () => undefined, list: () => [], seen: (): boolean => (f as Fake).seen },
        resize() {},
        write(d: string): void {
          ;(f as Fake).written.push(d)
        },
        kill() {
          this.killed = true
        },
      })
      started.push(f)
      return f as unknown as PtySession
    },
  })
  return { t, started }
}

test('tab id helpers', () => {
  assert.equal(termTabId(1), TERM_ID)
  assert.equal(termTabId(3), 'terminal:3')
  assert.equal(isTermTab('terminal'), true)
  assert.equal(isTermTab('terminal:6'), true)
  assert.equal(isTermTab('terminal:7'), false)
  assert.equal(isTermTab('terminal:1'), false)
  assert.equal(isTermTab(null), false)
})

test('open stops at the maximum and reuses freed ids', () => {
  const { t } = make()
  const ids = []
  for (let i = 1; i < MAX_TERMS; i++) ids.push(t.open())
  assert.deepEqual(ids, ['terminal:2', 'terminal:3', 'terminal:4', 'terminal:5', 'terminal:6'])
  assert.equal(t.open(), undefined)
  t.close('terminal:3')
  assert.equal(t.open(), 'terminal:3')
})

test('concurrent ensure starts one session', async () => {
  const { t, started } = make()
  await Promise.all([t.ensure(TERM_ID), t.ensure(TERM_ID)])
  await t.ensure(TERM_ID)
  assert.equal(started.length, 1)
  assert.ok(t.get(TERM_ID))
})

test('closing keeps the first tab listed but removes others', async () => {
  const { t, started } = make()
  const id = t.open() ?? ''
  await t.ensure(TERM_ID)
  await t.ensure(id)
  t.close(TERM_ID)
  t.close(id)
  assert.equal(started.every((s) => s.killed), true)
  assert.deepEqual(t.ids(), [TERM_ID])
  assert.equal(t.get(TERM_ID), undefined)
  await t.ensure(TERM_ID)
  assert.equal(started.length, 3)
})

test('a new tab starts in the cwd of the tab it was opened from', async () => {
  const { t } = make()
  await t.ensure(TERM_ID)
  const id = t.open({ from: TERM_ID }) ?? ''
  assert.equal(t.info(id)?.cwd, '/s0')
})

test('open with a cwd starts the tab there', async () => {
  const { t } = make()
  const id = t.open({ cwd: '/work' }) ?? ''
  assert.equal(t.info(id)?.cwd, '/work')
})

// Short waits: run() is time-based by design (prompt mark, else a fixed delay).
test('run on an integrated shell types the command only after the first prompt mark', async () => {
  const { t, started } = make()
  const p = t.run(TERM_ID, 'echo hi', { integrated: 2000 })
  await t.ensure(TERM_ID)
  const f = started[0]
  assert.deepEqual(f?.written, [])
  if (f !== undefined) f.seen = true
  f?.emit('change')
  await p
  assert.deepEqual(f?.written, ['echo hi\r'])
})

test('run on an integrated shell types anyway when no prompt mark ever arrives', async () => {
  const { t, started } = make()
  await t.run(TERM_ID, 'echo hi', { integrated: 20 })
  assert.deepEqual(started[0]?.written, ['echo hi\r'])
})

test('run on a plain shell types after the fixed delay', async () => {
  const { t, started } = make(false)
  await t.run(TERM_ID, 'dir', { plain: 10 })
  assert.deepEqual(started[0]?.written, ['dir\r'])
})

test('a start failure is reported, not thrown', async () => {
  const t = new Terminals({
    cwd: '/',
    env: {},
    dir: tmpDir('pager-terms-'),
    start: async () => {
      throw new Error('no prebuild')
    },
  })
  await t.ensure(TERM_ID)
  assert.equal(t.info(TERM_ID)?.unavailable, 'no prebuild')
  assert.equal(t.get(TERM_ID), undefined)
})

test('a shell that finishes starting after closeAll is killed, and nothing starts afterwards', async () => {
  const { t, started } = make()
  const pending = t.ensure(TERM_ID)
  t.closeAll()
  await pending
  assert.equal(started[0]?.killed, true)
  assert.equal(t.get(TERM_ID), undefined)
  await t.ensure(TERM_ID)
  assert.equal(started.length, 1)
})
