import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as m from './home-model.js'

const pane = (id, kind, state = 'running', cwd = 'C:\\x') => ({ id, kind, state, cwd, title: id, cols: 80, rows: 24 })
const leaf = (id) => ({ type: 'pane', paneId: id })
const state = {
  sessions: [
    { id: 's1', name: 'Main', activeTab: 't1', tabs: [{ id: 't1', title: 'Home', focus: '1', root: leaf('1') }, { id: 't2', title: 'x', focus: '2', root: { type: 'split', dir: 'row', ratio: 0.5, a: leaf('2'), b: leaf('3') } }, { id: 't3', title: 'y', focus: '4', root: leaf('4') }] },
    { id: 's2', name: 'Work', activeTab: 't4', tabs: [{ id: 't4', title: 'z', focus: '5', root: leaf('5') }, { id: 't5', title: 'dead', focus: '6', root: leaf('6') }] },
  ],
  panes: [pane('1', 'block:home'), pane('2', 'shell'), pane('3', 'omp'), pane('4', 'block:files'), pane('5', 'pager', 'restored'), pane('6', 'shell', 'exited')],
}

test('livePanes: no home, no exited; running first, agents before shells before blocks, restored last', () => {
  const rows = m.livePanes(state)
  assert.deepEqual(rows.map((r) => r.paneId), ['3', '2', '4', '5'])
  assert.equal(rows[0].tabId, 't2')
  assert.equal(rows[3].sessionName, 'Work')
  assert.deepEqual(m.livePanes({ sessions: [], panes: [] }), [])
  assert.deepEqual(m.livePanes(null), [])
})

test('homeTab finds the tab of the Home pane', () => {
  assert.equal(m.homeTab(state).tab.id, 't1')
  assert.equal(m.homeTab(state).session.id, 's1')
  assert.equal(m.homeTab({ sessions: state.sessions, panes: [pane('2', 'shell')] }), null)
})

test('kindRank orders agents, pager, shell, blocks', () => {
  assert.ok(m.kindRank('claude') < m.kindRank('pager'))
  assert.ok(m.kindRank('pager') < m.kindRank('shell'))
  assert.ok(m.kindRank('shell') < m.kindRank('block:git'))
})

test('mergeRecent: open panes newest first, then history, deduped across case and slashes, home and blocks dropped', () => {
  const st = { panes: [pane('1', 'block:home', 'running', 'C:\\Users\\me'), pane('2', 'shell', 'running', 'C:\\Users\\me\\a'), pane('3', 'omp', 'running', 'C:\\Users\\me\\b\\'), pane('4', 'block:files', 'running', 'C:\\Users\\me\\files-only')] }
  const out = m.mergeRecent(['c:/users/me/B', 'D:\\old', 'C:\\Users\\me', 42, ''], st, 'C:\\Users\\me', 6)
  assert.deepEqual(out, ['C:\\Users\\me\\b\\', 'C:\\Users\\me\\a', 'D:\\old'])
  assert.equal(m.mergeRecent(['/a', '/b', '/c'], { panes: [] }, '', 2).length, 2)
  assert.deepEqual(m.mergeRecent(null, null, ''), [])
})

test('dayPart and displayName', () => {
  assert.equal(m.dayPart(new Date(2026, 0, 1, 8)), 'Good morning')
  assert.equal(m.dayPart(new Date(2026, 0, 1, 13)), 'Good afternoon')
  assert.equal(m.dayPart(new Date(2026, 0, 1, 20)), 'Good evening')
  assert.equal(m.dayPart(new Date(2026, 0, 1, 2)), 'Good evening')
  assert.equal(m.displayName('welov'), 'Welov')
  assert.equal(m.displayName('jane.doe_x'), 'Jane Doe X')
  assert.equal(m.displayName('  '), '')
})

const LOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.11.0] - 2026-10-22',
  '',
  '### Added',
  '',
  '- **Crash log**: an error nothing caught is written to `crash.log` in the data directory',
  '- **Board** (`Alt+Mod+K`): the [TODO.md](https://x.y/z) as a kanban',
  '- plain bullet without a lead',
  '',
  '### Changed',
  '',
  '- **New blocks from the + button.** Hovering the + opens a menu',
  '- Another change',
  '- Sixth item that is cut',
  '',
  '## [1.10.0] - 2026-10-21',
  '',
  '- old',
].join('\r\n')

test('parseChangelog: newest non-empty release, first bullets in file order, markdown stripped', () => {
  const c = m.parseChangelog(LOG, 5)
  assert.equal(c.version, '1.11.0')
  assert.equal(c.date, '2026-10-22')
  assert.equal(c.total, 6)
  assert.equal(c.items.length, 5)
  assert.deepEqual(c.items[0], { section: 'Added', lead: 'Crash log', text: 'an error nothing caught is written to crash.log in the data directory' })
  assert.equal(c.items[1].lead, 'Board')
  assert.equal(c.items[1].text, '(Alt+Mod+K): the TODO.md as a kanban')
  assert.equal(c.items[2].lead, '')
  assert.equal(c.items[3].section, 'Changed')
  assert.equal(c.items[3].lead, 'New blocks from the + button')
  assert.equal(c.items[3].text, 'Hovering the + opens a menu')
})

test('parseChangelog: long bullets are clipped at a word; no releases or no bullets give null', () => {
  const long = '## [2.0.0] - 2027-01-01\n### Added\n- **Big**: ' + 'word '.repeat(80) + '\n'
  const c = m.parseChangelog(long, 3, 60)
  assert.ok(c.items[0].text.length <= 61)
  assert.ok(c.items[0].text.endsWith('\u2026'))
  assert.equal(m.parseChangelog('# Changelog\n\nnothing\n'), null)
  assert.equal(m.parseChangelog('## [1.0.0] - 2020-01-01\n\nprose only\n'), null)
  assert.equal(m.parseChangelog(undefined), null)
})

test('clip and plain', () => {
  assert.equal(m.clip('short', 10), 'short')
  assert.equal(m.clip('alpha beta gamma delta', 12), 'alpha beta\u2026')
  assert.equal(m.plain('**a** `b` [c](http://d) *e*'), 'a b c e')
})

test('firstSentence keeps short openers and version numbers, drops what follows a full stop', () => {
  assert.equal(m.firstSentence('the pane TODO.md as a kanban board, lanes. Headings are lanes and more'), 'the pane TODO.md as a kanban board, lanes')
  assert.equal(m.firstSentence('see e.g. the docs. Then more'), 'see e.g. the docs. Then more')
  assert.equal(m.firstSentence('Done.'), 'Done')
  assert.equal(m.firstSentence('version 1.2 ships with a long enough line before the stop. Next'), 'version 1.2 ships with a long enough line before the stop')
})
