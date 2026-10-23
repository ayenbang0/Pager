'use strict'
// node --test desktop/electron/blocks/board.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const board = require('./board.cjs')
const t = board._t

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-board-test-'))
test.after(() => {
  board.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const SIMPLE = [
  '# TODO',
  '',
  'Notes before the lanes stay put.',
  '',
  '## Todo',
  '',
  '- [ ] Write the parser #core 📅 2025-02-03',
  '  - [x] sketch the grammar',
  '  - [ ] handle CRLF',
  '  some note under the card',
  '- [ ] Ship it #release',
  '- plain bullet that is not a card',
  '',
  '## Doing',
  '',
  '- [ ] Review PR #review @{2025-01-31}',
  '',
  '## Done',
  '',
  '- [x] Init repo',
  '',
].join('\n')

const SAMPLES = {
  simple: SIMPLE,
  crlf: SIMPLE.replace(/\n/g, '\r\n'),
  mixed: SIMPLE.replace('Ship it', 'Ship it\r').replace(/\n(?=## Done)/, '\r\n'),
  noFinalNewline: SIMPLE.trimEnd(),
  bom: '\ufeff' + SIMPLE,
  empty: '',
  onlyNewline: '\n',
  fenced: ['## Todo', '', '```md', '## Not a lane', '- [ ] not a card', '```', '- [ ] real', ''].join('\n'),
  noLanes: ['- [ ] a', '- [x] b', 'prose', ''].join('\n'),
  obsidian: [
    '---',
    '',
    'kanban-plugin: board',
    '',
    '---',
    '',
    '## Backlog',
    '',
    '- [ ] one #a',
    '',
    '## Done',
    '',
    '**Complete**',
    '',
    '- [x] two',
    '',
    '',
    '***',
    '',
    '## Archive',
    '',
    '- [x] old',
    '',
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board"}',
    '```',
    '%%',
    '',
  ].join('\n'),
  weird: ['## ', '#no-space', '- [ ]', '- [] x', '-[ ] y', '* [X] star', '+ [ ] plus', '   - [ ] orphan sub', '\t- [ ] tab sub', 'text\r', ''].join('\n'),
  cr: 'a\r- [ ] b\rc',
}

test('parse -> join is byte-identical for every sample (CRLF, mixed, BOM, no final newline, fences, Obsidian)', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    assert.equal(t.joinLines(t.parse(text)), text, name)
  }
})

test('parses lanes, cards, labels, due dates, subtasks and notes', () => {
  const s = t.snapshot(t.parse(SIMPLE))
  assert.deepEqual(s.lanes.map((l) => [l.title, l.cards.length, l.done]), [['Todo', 2, false], ['Doing', 1, false], ['Done', 1, true]])
  const [a, b] = s.lanes[0].cards
  assert.equal(a.title, 'Write the parser')
  assert.deepEqual(a.labels, ['core'])
  assert.equal(a.due, '2025-02-03')
  assert.deepEqual(a.subtasks.map((x) => [x.text, x.done]), [['sketch the grammar', true], ['handle CRLF', false]])
  assert.deepEqual(a.notes, ['some note under the card'])
  assert.equal(b.title, 'Ship it')
  assert.equal(s.lanes[1].cards[0].due, '2025-01-31')
  assert.deepEqual(s.counts, { open: 3, done: 1 })
})

test('the plain bullet and prose are not cards; fenced headings and cards are ignored', () => {
  const f = t.snapshot(t.parse(SAMPLES.fenced))
  assert.deepEqual(f.lanes.map((l) => [l.title, l.cards.map((c) => c.title)]), [['Todo', ['real']]])
  const n = t.snapshot(t.parse(SAMPLES.noLanes))
  assert.equal(n.lanes.length, 1)
  assert.equal(n.lanes[0].implicit, true)
  assert.deepEqual(n.lanes[0].cards.map((c) => c.title), ['a', 'b'])
})

test('Obsidian Kanban: front matter, **Complete** lane, archive lane, settings footer', () => {
  const s = t.snapshot(t.parse(SAMPLES.obsidian))
  assert.equal(s.kanban, true)
  assert.deepEqual(s.lanes.map((l) => [l.title, l.done, l.archived]), [['Backlog', false, false], ['Done', true, false], ['Archive', false, true]])
  assert.deepEqual(s.counts, { open: 1, done: 1 })
})

test('tags ignore code spans, links and issue numbers; dates in code are not due dates', () => {
  const p = t.parseBody('fix `#nope` and [link](#anchor) issue #123 #real/sub 📅 2025-03-04 `📅 2020-01-01`')
  assert.deepEqual(p.labels, ['real/sub'])
  assert.equal(p.due, '2025-03-04')
  assert.equal(p.dueStyle, 'tasks')
  assert.equal(t.parseBody('x due:2025-05-06').due, '2025-05-06')
  assert.equal(t.parseBody('x [due:: 2025-05-06]').dueStyle, 'dataview')
})

test('toggling a card edits only its checkbox when there is no Done lane to move to', () => {
  const text = '## Todo\n- [ ] a\n- [ ] b\n'
  const id = t.parse(text).cards.get(1).id
  assert.equal(t.applyOp(text, 'toggle', { card: id }), '## Todo\n- [x] a\n- [ ] b\n')
})

test('checking a card moves it to the end of the Done lane; unchecking brings it back to the first lane', () => {
  const doc = t.parse(SIMPLE)
  const a = doc.lanes[0].cards[0]
  const checked = t.applyOp(SIMPLE, 'toggle', { card: a.id })
  const s = t.snapshot(t.parse(checked))
  assert.deepEqual(s.lanes[2].cards.map((c) => [c.title, c.done]), [['Init repo', true], ['Write the parser', true]])
  // subtasks and notes travelled with the card
  assert.equal(s.lanes[2].cards[1].subtasks.length, 2)
  assert.deepEqual(s.lanes[2].cards[1].notes, ['some note under the card'])
  const moved = t.parse(checked).lanes[2].cards[1]
  const back = t.snapshot(t.parse(t.applyOp(checked, 'toggle', { card: moved.id })))
  assert.equal(back.lanes[0].cards.at(-1).title, 'Write the parser')
  assert.equal(back.lanes[0].cards.at(-1).done, false)
})

test('unrelated lines survive edits untouched (prose, plain bullets, front matter, footer)', () => {
  const before = SAMPLES.obsidian
  const doc = t.parse(before)
  const out = t.applyOp(before, 'add', { lane: doc.lanes[0].id, text: 'brand new', labels: ['x'], due: '2025-12-24' })
  const lines = out.split('\n')
  assert.ok(lines.includes('- [ ] brand new #x 📅 2025-12-24'))
  assert.deepEqual(lines.filter((l) => l !== '- [ ] brand new #x 📅 2025-12-24'), before.split('\n'))
  const kept = SIMPLE.split('\n').filter((l) => l.startsWith('Notes') || l.startsWith('- plain'))
  const out2 = t.applyOp(SIMPLE, 'remove', { card: t.parse(SIMPLE).lanes[0].cards[1].id })
  for (const l of kept) assert.ok(out2.includes(l))
})

test('moving: between lanes, to an index, into an empty lane, with checkbox state following Done', () => {
  const doc = t.parse(SIMPLE)
  const ship = doc.lanes[0].cards[1]
  let out = t.applyOp(SIMPLE, 'move', { card: ship.id, lane: doc.lanes[1].id, index: 0 })
  let s = t.snapshot(t.parse(out))
  assert.deepEqual(s.lanes[1].cards.map((c) => c.title), ['Ship it', 'Review PR'])
  assert.deepEqual(s.lanes[0].cards.map((c) => c.title), ['Write the parser'])
  out = t.applyOp(SIMPLE, 'move', { card: ship.id, lane: doc.lanes[2].id })
  s = t.snapshot(t.parse(out))
  assert.equal(s.lanes[2].cards.at(-1).done, true)
  // within a lane: card 0 to the end
  const first = doc.lanes[0].cards[0]
  out = t.applyOp(SIMPLE, 'move', { card: first.id, lane: doc.lanes[0].id, index: 1 })
  assert.deepEqual(t.snapshot(t.parse(out)).lanes[0].cards.map((c) => c.title), ['Ship it', 'Write the parser'])
  // empty lane followed by another heading keeps a blank line before it
  const empty = '## A\n\n- [ ] x\n\n## B\n\n## C\n'
  const d2 = t.parse(empty)
  const m = t.applyOp(empty, 'move', { card: d2.lanes[0].cards[0].id, lane: d2.lanes[1].id })
  assert.equal(m, '## A\n\n\n## B\n\n- [ ] x\n\n## C\n')
  assert.deepEqual(t.snapshot(t.parse(m)).lanes.map((l) => l.cards.length), [0, 1, 0])
})

test('moving or adding at the very end of a file without a final newline keeps it newline-less', () => {
  const text = '## A\n- [ ] x\n## B\n- [ ] y'
  const d = t.parse(text)
  const out = t.applyOp(text, 'move', { card: d.lanes[0].cards[0].id, lane: d.lanes[1].id })
  assert.equal(out, '## A\n## B\n- [ ] y\n- [ ] x')
  const add = t.applyOp(text, 'add', { lane: d.lanes[1].id, text: 'z' })
  assert.equal(add, '## A\n- [ ] x\n## B\n- [ ] y\n- [ ] z')
})

test('CRLF files stay CRLF through add, move, remove and subtasks', () => {
  const text = SIMPLE.replace(/\n/g, '\r\n')
  let d = t.parse(text)
  let out = t.applyOp(text, 'add', { lane: d.lanes[1].id, text: 'crlf card' })
  assert.ok(!/(^|[^\r])\n/.test(out))
  d = t.parse(out)
  out = t.applyOp(out, 'move', { card: d.lanes[0].cards[0].id, lane: d.lanes[1].id, index: 0 })
  assert.ok(!/(^|[^\r])\n/.test(out))
  d = t.parse(out)
  out = t.applyOp(out, 'addSub', { card: d.lanes[1].cards[0].id, text: 'one more' })
  assert.ok(!/(^|[^\r])\n/.test(out))
  assert.equal(t.snapshot(t.parse(out)).lanes[1].cards[0].subtasks.at(-1).text, 'one more')
})

test('update rewrites only the changed card line; unchanged fields keep their original text', () => {
  const d = t.parse(SIMPLE)
  const card = d.lanes[1].cards[0]
  assert.equal(t.applyOp(SIMPLE, 'update', { card: card.id, title: card.title, labels: card.labels, due: card.due }), SIMPLE)
  const out = t.applyOp(SIMPLE, 'update', { card: card.id, title: 'Review the PR', labels: ['review', 'urgent'], due: '2025-02-01' })
  assert.ok(out.includes('- [ ] Review the PR #review #urgent @{2025-02-01}'))
  assert.equal(t.applyOp(SIMPLE, 'update', { card: card.id, due: null }).includes('Review PR #review\n'), true)
  assert.throws(() => t.applyOp(SIMPLE, 'update', { card: card.id, due: 'tomorrow' }), /Dates look like/)
  assert.throws(() => t.applyOp(SIMPLE, 'update', { card: card.id, title: '  ' }), /needs some text/)
})

test('stale references are rejected instead of editing the wrong line', () => {
  const d = t.parse(SIMPLE)
  const card = d.lanes[0].cards[1]
  const edited = SIMPLE.replace('Ship it', 'Ship it now')
  assert.throws(() => t.applyOp(edited, 'toggle', { card: card.id }), (e) => e.code === 'STALE')
  const shifted = 'new first line\n' + SIMPLE
  assert.throws(() => t.applyOp(shifted, 'toggle', { card: card.id }), (e) => e.code === 'STALE')
})

test('subtasks: add, toggle, remove; counters follow', () => {
  const d = t.parse(SIMPLE)
  const a = d.lanes[0].cards[0]
  let out = t.applyOp(SIMPLE, 'toggleSub', { sub: a.subtasks[1].id })
  assert.deepEqual(t.snapshot(t.parse(out)).lanes[0].cards[0].subtasks.map((s) => s.done), [true, true])
  out = t.applyOp(SIMPLE, 'removeSub', { sub: a.subtasks[0].id })
  assert.equal(t.snapshot(t.parse(out)).lanes[0].cards[0].subtasks.length, 1)
  const b = d.lanes[0].cards[1]
  out = t.applyOp(SIMPLE, 'addSub', { card: b.id, text: 'first sub' })
  assert.ok(out.includes('- [ ] Ship it #release\n  - [ ] first sub\n- plain bullet'))
})

test('lanes: add (before archive/footer), rename, remove only when empty', () => {
  let out = t.applyOp(SAMPLES.obsidian, 'addLane', { title: 'Review' })
  const s = t.snapshot(t.parse(out))
  assert.deepEqual(s.lanes.map((l) => l.title), ['Backlog', 'Done', 'Review', 'Archive'])
  assert.equal(s.lanes[2].archived, false)
  assert.equal(t.snapshot(t.parse(t.applyOp(SIMPLE, 'addLane', { title: 'Later' }))).lanes.at(-1).title, 'Later')
  const d = t.parse(SIMPLE)
  assert.throws(() => t.applyOp(SIMPLE, 'removeLane', { lane: d.lanes[0].id }), /cards first/)
  out = t.applyOp(SIMPLE, 'renameLane', { lane: d.lanes[1].id, title: 'In progress' })
  assert.ok(out.includes('## In progress\n'))
  const e = '## A\n\n- [ ] x\n\n## B\n\n## C\n\n- [ ] y\n'
  const de = t.parse(e)
  assert.equal(t.applyOp(e, 'removeLane', { lane: de.lanes[1].id }), '## A\n\n- [ ] x\n\n## C\n\n- [ ] y\n')
})

test('adding to an empty lane and to a lane right before the next heading', () => {
  const e = '## A\n## B\n- [ ] y\n'
  const d = t.parse(e)
  assert.equal(t.applyOp(e, 'add', { lane: d.lanes[0].id, text: 'x' }), '## A\n- [ ] x\n\n## B\n- [ ] y\n')
  const doneAdd = t.applyOp('## Done\n', 'add', { lane: t.parse('## Done\n').lanes[0].id, text: 'z' })
  assert.equal(doneAdd, '## Done\n- [x] z\n')
})

test('files: open finds TODO.md upward to the repo root, create writes lanes, edits are atomic and keep the file', async () => {
  const root = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  const none = await board.methods.open({ cwd: path.join(root, 'src', 'deep') })
  assert.equal(none.exists, false)
  assert.equal(path.basename(none.path), 'TODO.md')
  const created = await board.methods.create({ board: none.board })
  assert.deepEqual(created.lanes.map((l) => l.title), ['Todo', 'Doing', 'Done'])
  assert.throws(() => fs.readFileSync(path.join(root, 'src', 'deep', 'TODO.md.tmp')), /ENOENT/)
  const again = await board.methods.open({ cwd: path.join(root, 'src', 'deep') })
  assert.equal(fs.realpathSync(again.path), fs.realpathSync(path.join(root, 'src', 'deep', 'TODO.md')))
  // a TODO.md at the root is found from below
  const up = path.join(tmp, 'repo2')
  fs.mkdirSync(path.join(up, '.git'), { recursive: true })
  fs.mkdirSync(path.join(up, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(up, 'todo.md'), SIMPLE)
  const found = await board.methods.open({ cwd: path.join(up, 'a', 'b') })
  assert.equal(found.exists, true)
  assert.equal(found.counts.open, 3)
  const file = path.join(up, 'todo.md')
  const before = fs.statSync(file)
  const r = await board.methods.add({ board: found.board, lane: found.lanes[0].id, text: 'Disk test #t' })
  assert.equal(r.lanes[0].cards.at(-1).title, 'Disk test')
  assert.equal(fs.readFileSync(file, 'utf8'), t.applyOp(SIMPLE, 'add', { lane: t.parse(SIMPLE).lanes[0].id, text: 'Disk test #t' }))
  assert.deepEqual(fs.readdirSync(up).filter((n) => n.endsWith('.tmp')), [])
  assert.ok(fs.statSync(file).mtimeMs >= before.mtimeMs)
  await board.methods.close({ board: found.board })
  await assert.rejects(board.methods.load({ board: found.board }), /closed/)
})

test('an edit made on disk meanwhile is kept: ops re-read the file; a card edited elsewhere is reported stale', async () => {
  const dir = path.join(tmp, 'live')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'TODO.md')
  fs.writeFileSync(file, '## Todo\n\n- [ ] one\n- [ ] two\n')
  const events = []
  const o = await board.methods.open({ file }, { emit: (e, p) => events.push([e, p]) })
  // external append
  fs.appendFileSync(file, '\n## Extra\n\n- [ ] external\n')
  const card = o.lanes[0].cards[0]
  const r = await board.methods.toggle({ board: o.board, card: card.id, move: false })
  assert.equal(r.lanes.length, 2)
  assert.equal(r.lanes[0].cards[0].done, true)
  assert.ok(fs.readFileSync(file, 'utf8').includes('- [ ] external'))
  // external edit of the card's own line
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [x] one', '- [x] one (edited)'))
  await assert.rejects(board.methods.toggle({ board: o.board, card: r.lanes[0].cards[0].id }), (e) => e.code === 'STALE')
  // the watcher reports external changes (and not our own writes)
  await new Promise((res) => setTimeout(res, 400))
  assert.ok(events.some(([e]) => e === 'changed'))
  const n = events.length
  await board.methods.add({ board: o.board, lane: (await board.methods.load({ board: o.board })).lanes[0].id, text: 'ours' })
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(events.length, n)
  await board.methods.close({ board: o.board })
})

test('open refuses non-markdown files and missing folders', async () => {
  await assert.rejects(board.methods.open({ file: path.join(tmp, 'x.txt') }), /markdown/)
  await assert.rejects(board.methods.open({ cwd: path.join(tmp, 'nope') }), /Not a folder/)
})
