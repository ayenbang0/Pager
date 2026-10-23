import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  avatarHue,
  highlightParts,
  initials,
  layoutGraph,
  parseDecoration,
  relativeTime,
  searchSubjects,
  WIP,
  withWorkingTree,
} from './gitgraph.js'

const c = (hash, ...parents) => ({ hash, parents })

test('a linear history stays in lane 0 with one colour', () => {
  const { rows, width } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
  assert.equal(width, 1)
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0])
  assert.equal(new Set(rows.map((r) => r.color)).size, 1)
  assert.deepEqual(rows[0].up, [])
  assert.deepEqual(rows[0].down, [{ lane: 0, color: rows[0].color }])
  assert.deepEqual(rows[1].up, [{ lane: 0, color: rows[0].color }])
  assert.deepEqual(rows[2].down, [])
})

test('a branch forks into lane 1 and rejoins when the base is reached', () => {
  // m merges f (feature) into main; both descend from base
  const { rows, width } = layoutGraph([c('m', 'b2', 'f2'), c('f2', 'f1'), c('b2', 'base'), c('f1', 'base'), c('base')])
  assert.equal(width, 2)
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]))
  assert.equal(byHash.m.lane, 0)
  assert.deepEqual(byHash.m.down.map((d) => d.lane), [0, 1])
  assert.equal(byHash.f2.lane, 1)
  assert.equal(byHash.f1.lane, 1)
  assert.equal(byHash.b2.lane, 0)
  // f2 is passed over by main's commit b2: lane 1 passes through the b2 row
  assert.deepEqual(byHash.b2.pass.map((p) => p.lane), [1])
  // f1's first parent `base` is already expected by lane 0, so its line joins lane 0 and lane 1 frees up
  assert.deepEqual(byHash.f1.down.map((d) => d.lane), [0])
  assert.equal(byHash.base.lane, 0)
  assert.deepEqual(byHash.base.up.map((u) => u.lane), [0])
  // the feature lane has its own colour, distinct from main's
  assert.notEqual(byHash.f2.color, byHash.m.color)
})

test('a second branch tip over an already-expected parent joins that lane right away', () => {
  const { rows } = layoutGraph([c('x', 'p'), c('y', 'p'), c('p')])
  assert.equal(rows[0].lane, 0)
  assert.equal(rows[1].lane, 1)
  assert.deepEqual(rows[1].down.map((d) => d.lane), [0])
  const p = rows[2]
  assert.equal(p.lane, 0)
  assert.deepEqual(p.up.map((u) => u.lane), [0])
})

test('lanes are reused once free', () => {
  const { rows, width } = layoutGraph([
    c('m1', 'a', 'b'), // opens lane 1 for b
    c('b', 'a'), // b's line joins lane 0 (a) -> lane 1 frees
    c('m2', 'a', 'd'), // new merge re-uses lane 1 for d
    c('d', 'a'),
    c('a'),
  ])
  assert.equal(width, 2)
  assert.equal(rows[2].down.find((x) => x.lane !== 0).lane, 1)
})

test('an octopus merge opens one lane per extra parent', () => {
  const { rows, width } = layoutGraph([c('o', 'a', 'b', 'd'), c('a'), c('b'), c('d')])
  assert.equal(width, 3)
  assert.deepEqual(rows[0].down.map((d) => d.lane), [0, 1, 2])
  assert.equal(new Set(rows[0].down.map((d) => d.color)).size, 3)
  assert.equal(rows[1].lane, 0)
  assert.equal(rows[2].lane, 1)
  assert.equal(rows[3].lane, 2)
})

test('parents missing from the list keep their line to the bottom edge', () => {
  const { rows } = layoutGraph([c('c', 'b'), c('b', 'cut-off')])
  assert.deepEqual(rows[1].down, [{ lane: 0, color: rows[1].color }])
})

test('colours cycle through the palette and stay stable down a lane', () => {
  const list = [c('m', 'a', 'b'), c('a', 'z'), c('b', 'y'), c('z'), c('y')]
  const { rows } = layoutGraph(list, 2)
  assert.ok(rows.every((r) => r.color < 2))
  const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]))
  assert.equal(byHash.a.color, byHash.z.color)
  assert.equal(byHash.b.color, byHash.y.color)
})

test('the working-tree row sits above HEAD and draws its line down to it', () => {
  const list = withWorkingTree([c('t', 'h'), c('h', 'g'), c('g')], 'h')
  assert.equal(list[0].hash, WIP)
  const { rows } = layoutGraph(list)
  assert.equal(rows[0].lane, 0)
  // HEAD is not the newest commit: the wip line goes to lane 0 while `t` takes lane 1
  assert.equal(rows[1].lane, 1)
  assert.deepEqual(rows[1].pass.map((p) => p.lane), [0])
  assert.equal(rows[2].lane, 0)
  assert.deepEqual(rows[2].up.map((u) => u.lane), [0])
})

test('initials, hue and decorations', () => {
  assert.equal(initials('Ada Lovelace'), 'AL')
  assert.equal(initials('ada'), 'AD')
  assert.equal(initials('', 'grace.hopper@x.org'), 'GH')
  assert.equal(initials(''), '?')
  assert.equal(avatarHue('a@b.c'), avatarHue('a@b.c'))
  assert.ok(avatarHue('a@b.c') >= 0 && avatarHue('a@b.c') < 360)
  assert.deepEqual(parseDecoration('HEAD -> main, tag: v0.1.0, origin/main, origin/HEAD, feature/x', ['origin']), [
    { type: 'branch', name: 'main', current: true },
    { type: 'branch', name: 'feature/x' },
    { type: 'remote', name: 'origin/main', remote: 'origin' },
    { type: 'tag', name: 'v0.1.0' },
  ])
  assert.deepEqual(parseDecoration('HEAD'), [{ type: 'head', name: 'HEAD', current: true }])
  assert.deepEqual(parseDecoration(''), [])
})

test('subject search is case-insensitive and ignores surrounding space', () => {
  const commits = [{ subject: 'Fix Case-insensitive search' }, { subject: 'Lay out commits' }, { subject: 'document the SEARCH syntax' }]
  assert.deepEqual(searchSubjects(commits, ' search '), [0, 2])
  assert.deepEqual(searchSubjects(commits, ''), [])
  assert.deepEqual(searchSubjects(commits, 'nope'), [])
  assert.deepEqual(highlightParts('Fix Search here', 'search'), [
    { text: 'Fix ', hit: false },
    { text: 'Search', hit: true },
    { text: ' here', hit: false },
  ])
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', hit: false }])
})

test('relative time', () => {
  const now = 1_000_000_000_000
  assert.equal(relativeTime(now / 1000 - 10, now), 'now')
  assert.equal(relativeTime(now / 1000 - 120, now), '2m')
  assert.equal(relativeTime(now / 1000 - 3 * 3600, now), '3h')
  assert.equal(relativeTime(now / 1000 - 2 * 86400, now), '2d')
  assert.equal(relativeTime(now / 1000 - 400 * 86400, now), '1y')
})

test('layout of a large history is linear and bounded', () => {
  const list = []
  for (let i = 0; i < 20000; i++) list.push(c(`h${i}`, `h${i + 1}`))
  const t = Date.now()
  const { rows, width } = layoutGraph(list)
  assert.equal(rows.length, 20000)
  assert.equal(width, 1)
  assert.ok(Date.now() - t < 2000)
})
