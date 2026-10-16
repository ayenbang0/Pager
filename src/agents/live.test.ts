import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { LiveMessage } from './live.js'

test('body interleaves text and tool lines; a finished tool changes its marker in place', () => {
  const live = new LiveMessage(() => {}, 1000)
  live.text('Looking')
  live.text(' around.')
  live.tool({ id: 'a', title: 'read src/x.ts', kind: 'read', status: 'pending' })
  assert.equal(live.body(), 'Looking around.\n⚙ read src/x.ts')
  live.tool({ id: 'a', title: 'read src/x.ts', kind: 'read', status: 'completed' })
  live.tool({ id: 'b', title: 'run tests', kind: 'execute', status: 'failed' })
  live.text('Done.')
  assert.equal(live.body(), 'Looking around.\n✓ read src/x.ts\n✗ run tests\nDone.')
  assert.equal(live.message(), 'Looking around.\nDone.')
  live.stop()
})

test('summary counts tools by kind, most used first, and is empty without tools', () => {
  const live = new LiveMessage(() => {}, 1000)
  live.text('hi')
  assert.equal(live.summary(), '')
  for (const [id, kind] of [['1', 'read'], ['2', 'edit'], ['3', 'read']] as const) live.tool({ id, title: id, kind, status: 'completed' })
  assert.equal(live.summary(), 'used 3 tools (read 2, edit 1)')
  live.stop()
})

test('a burst of chunks yields an immediate update and one trailing update', async () => {
  const seen: string[] = []
  const live = new LiveMessage((body) => seen.push(body), 40)
  for (const c of ['a', 'b', 'c', 'd']) live.text(c)
  assert.deepEqual(seen, ['a'])
  await sleep(120) // real timer: the throttle is wall-clock by design
  assert.deepEqual(seen, ['a', 'abcd'])
  live.stop()
})
