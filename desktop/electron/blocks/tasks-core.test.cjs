'use strict'
// node --test desktop/electron/blocks/tasks-core.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const core = require('./tasks-core.cjs')
const tasks = require('./tasks.cjs')

const line = (o) => JSON.stringify(o)

test('parseSample: shapes the helper line; reports helper errors and malformed input', () => {
  const s = core.parseSample(line({ ts: 5, p: [[4, 100, 1000, 7]], n: [[4, 0, 123, 'System', null], [10, 4, 124, 'a.exe', 'a.exe -x']], g: false }))
  assert.equal(s.ts, 5)
  assert.deepEqual(s.n[1], { pid: 10, ppid: 4, create: 124, name: 'a.exe', cmd: 'a.exe -x' })
  assert.equal(s.n[0].cmd, null)
  assert.equal(s.g, false)
  assert.equal(core.parseSample(line({ ts: 1, p: [], n: [], g: null })).g, null)
  assert.deepEqual(core.parseSample(line({ ts: 1, p: [], n: [], g: { total: 4, p: { 3: 4 } } })).g, { total: 4, p: { 3: 4 } })
  assert.throws(() => core.parseSample(line({ error: 'boom' })), /boom/)
  assert.throws(() => core.parseSample(line({ ts: 'x' })), /malformed/)
  assert.throws(() => core.parseSample('not json'))
})

test('cpuPercents: share of the whole machine from cumulative 100 ns counters; first sight is 0; clamps; forgets dead pids', () => {
  const prev = new Map()
  const ncpu = 4
  // 1 s of wall time = 1e7 ticks; one core fully busy = 25 %
  const a = core.cpuPercents(prev, { ts: 1e7, p: [[1, 1, 0, 0], [2, 1, 0, 5e6]] }, ncpu)
  assert.equal(a.get(1), 0)
  const b = core.cpuPercents(prev, { ts: 2e7, p: [[1, 1, 0, 1e7], [2, 1, 0, 5e6 + 4e7]] }, ncpu)
  assert.equal(Math.round(b.get(1)), 25)
  assert.equal(b.get(2), 100) // 4 cores' worth = 100 %, never above
  core.cpuPercents(prev, { ts: 3e7, p: [[1, 1, 0, 1e7]] }, ncpu)
  assert.equal(prev.has(2), false)
  // a counter that went backwards (pid reuse) is not a negative percentage
  const c = core.cpuPercents(prev, { ts: 4e7, p: [[1, 1, 0, 5]] }, ncpu)
  assert.equal(c.get(1), 0)
})

test('systemCpu: busy share between two os.cpus() snapshots', () => {
  const t = (user, sys, idle) => ({ times: { user, nice: 0, sys, idle, irq: 0 } })
  assert.equal(core.systemCpu(null, [t(0, 0, 0)]), 0)
  assert.equal(core.systemCpu([t(0, 0, 0), t(0, 0, 0)], [t(50, 0, 50), t(0, 0, 100)]), 25)
  assert.equal(core.systemCpu([t(1, 1, 1)], [t(1, 1, 1)]), 0)
})

const table = (rows) => new Map(rows.map(([pid, ppid, name, cmd = null]) => [pid, { ppid, name, cmd, create: pid * 10 }]))

test('classify: own pids are self, the session daemon is found by its command line, descendants are children', () => {
  const info = table([
    [1, 0, 'explorer.exe'],
    [100, 1, 'pager.exe'], // main
    [101, 100, 'pager.exe'], // renderer
    [200, 1, 'node.exe', 'node C:\\x\\pager\\dist\\cli.js daemon'],
    [201, 200, 'pwsh.exe'],
    [202, 201, 'vim.exe'],
    [300, 1, 'node.exe', 'node server.js'],
    [301, 300, 'cmd.exe'],
  ])
  const k = core.classify(info, new Set([100, 101]), [])
  assert.equal(k.get(100), 'self')
  assert.equal(k.get(101), 'self')
  assert.equal(k.get(200), 'daemon')
  assert.equal(k.get(201), 'child')
  assert.equal(k.get(202), 'child')
  assert.equal(k.has(300), false)
  assert.equal(k.has(301), false)
  assert.equal(k.has(1), false)
})

test('descendants lists a tree deepest first and survives cycles', () => {
  const info = table([[1, 0, 'a'], [2, 1, 'b'], [3, 2, 'c'], [4, 1, 'd']])
  assert.deepEqual(core.descendants(info, 1), [3, 2, 4, 1])
  info.get(1).ppid = 3
  assert.deepEqual(core.descendants(info, 1).sort(), [1, 2, 3, 4])
})

test('guardTargets: refuses critical, Pager-own, protected and stale targets; allows ordinary processes and their trees', () => {
  const info = table([
    [4, 0, 'System'],
    [10, 4, 'lsass.exe'],
    [100, 1, 'pager.exe'],
    [200, 1, 'node.exe', 'node pager daemon'],
    [201, 200, 'pwsh.exe'],
    [300, 1, 'notepad.exe'],
    [301, 300, 'helper.exe'],
    [400, 1, 'wrapper.exe'],
    [401, 400, 'pager.exe'], // a Pager process hiding under an ordinary parent
  ])
  const kinds = core.classify(info, new Set([100, 401]), [])
  assert.deepEqual(core.guardTargets(info, kinds, 300), [300])
  assert.deepEqual(core.guardTargets(info, kinds, 300, { tree: true }), [301, 300])
  assert.throws(() => core.guardTargets(info, kinds, 4), /critical/)
  assert.throws(() => core.guardTargets(info, kinds, 10), /critical/)
  assert.throws(() => core.guardTargets(info, kinds, 100), /part of Pager/)
  assert.throws(() => core.guardTargets(info, kinds, 200), /daemon stop/)
  assert.throws(() => core.guardTargets(info, kinds, 400, { tree: true }), /part of Pager/)
  assert.deepEqual(core.guardTargets(info, kinds, 400), [400]) // alone it is fine: the tree is what holds a Pager process
  assert.throws(() => core.guardTargets(info, kinds, 300, { protect: new Set([300]) }), /part of Pager/)
  assert.throws(() => core.guardTargets(info, kinds, 999), /already ended/)
  assert.throws(() => core.guardTargets(info, kinds, 300, { create: 1 }), /different process/)
  assert.deepEqual(core.guardTargets(info, kinds, 300, { create: 3000 }), [300])
  // terminals under the daemon are children: allowed (the UI confirms with a stronger warning)
  assert.deepEqual(core.guardTargets(info, kinds, 201), [201])
})

test('actions need explicit confirmation before anything else is looked at', async () => {
  await assert.rejects(tasks.methods.kill({ pid: 12345 }), /Not confirmed/)
  await assert.rejects(tasks.methods.stop({ pid: 12345, confirm: 'yes' }), /Not confirmed/)
  await assert.rejects(tasks.methods.suspend({ pid: 12345 }), /Not confirmed/)
  assert.throws(() => tasks._t.prepare({ pid: -1, confirm: true }), /Invalid process id/)
})

test('the helper boot script quotes paths safely and loads the cached assembly from bytes', () => {
  const s = require('./ps-helper.cjs').bootScript("C:\\Users\\O'Brien\\a.cs", "C:\\Users\\O'Brien\\a.dll", 'PagerProc')
  assert.ok(s.includes("'C:\\Users\\O''Brien\\a.cs'"))
  assert.ok(s.includes('ReadAllBytes($dll)'))
  assert.ok(s.includes("GetType('PagerProc')"))
})
