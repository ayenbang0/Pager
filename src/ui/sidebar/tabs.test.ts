import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConvView } from '../../app/engine.js'
import { agentTabId, sharedTabId } from '../../agents/ids.js'
import { ROOM_ID } from '../../agents/orchestrator.js'
import { AI_ID } from '../../ai/chat.js'
import { SETTINGS_ID } from '../../app/settingsView.js'
import { DOCS_ID } from '../../docs/store.js'
import { TERM_ID } from '../../tools/terminal/sessions.js'
import { entryIndexOf, fileable, sidebarEntries, sidebarHit, visibleTabIds, type SidebarEntry, type SidebarInput } from './tabs.js'

const conv = (id: string, kind: ConvView['kind']): ConvView => ({ id, kind, title: id, unread: 0, online: true }) as ConvView

const input = (over: Partial<SidebarInput> = {}): SidebarInput => ({
  convs: [conv('g1', 'group'), conv('d1', 'dm'), conv('d2', 'dm')],
  pendingCount: 0,
  agentNames: ['omp', 'claude'],
  shared: [],
  agentsOn: true,
  folders: [],
  collapsed: new Set(),
  activeId: null,
  terminals: [TERM_ID],
  ...over,
})

const shape = (entries: readonly SidebarEntry[]): string[] =>
  entries.map((e) => (e.kind === 'static' ? `# ${e.title}` : e.kind === 'header' ? `${e.open ? 'v' : '>'} ${e.key} (${e.count})` : e.kind === 'pending' ? `pending ${e.n}` : String(e.id)))

test('order: home, direct, groups, agents (room, ai, each agent, shared), then tools', () => {
  const entries = sidebarEntries(input({ shared: ['ab'.repeat(32)] }))
  assert.deepEqual(shape(entries), [
    '# HOME', 'null',
    'v direct (2)', 'd1', 'd2',
    'v groups (1)', 'g1',
    'v agents (5)', ROOM_ID, AI_ID, agentTabId('omp'), agentTabId('claude'), sharedTabId('ab'.repeat(32)),
    'v tools (3)', TERM_ID, DOCS_ID, SETTINGS_ID,
  ])
  assert.deepEqual(visibleTabIds(entries), [null, 'd1', 'd2', 'g1', ROOM_ID, AI_ID, agentTabId('omp'), agentTabId('claude'), sharedTabId('ab'.repeat(32)), TERM_ID, DOCS_ID, SETTINGS_ID])
})

test('extra terminal tabs sit right after the first, ahead of docs', () => {
  const ids = visibleTabIds(sidebarEntries(input({ terminals: [TERM_ID, 'terminal:2', 'terminal:3'] })))
  assert.deepEqual(ids.slice(-5), [TERM_ID, 'terminal:2', 'terminal:3', DOCS_ID, SETTINGS_ID])
})

test('empty DIRECT and GROUPS are omitted; pending rows come right after HOME', () => {
  const entries = sidebarEntries(input({ convs: [], pendingCount: 2 }))
  assert.deepEqual(shape(entries).slice(0, 6), ['# HOME', 'null', '# PENDING', 'pending 1', 'pending 2', 'v agents (4)'])
  assert.ok(!shape(entries).some((x) => x.includes('direct') || x.includes('groups')))
})

test('agentsOn false hides the whole AGENTS section', () => {
  const entries = sidebarEntries(input({ agentsOn: false }))
  assert.ok(!shape(entries).some((x) => x.includes('agents')))
  assert.ok(!visibleTabIds(entries).includes(ROOM_ID))
  assert.ok(visibleTabIds(entries).includes(DOCS_ID))
})

test('folders come first, in stored order, and filed tabs leave their own section', () => {
  const entries = sidebarEntries(input({ folders: [{ name: 'work', ids: ['d2', ROOM_ID] }, { name: 'empty', ids: [] }] }))
  assert.deepEqual(shape(entries).slice(0, 8), ['# HOME', 'null', 'v folder:work (2)', 'd2', ROOM_ID, 'v folder:empty (0)', 'v direct (1)', 'd1'])
  assert.ok(!shape(entries).slice(8).includes('d2'))
  assert.ok(!shape(entries).includes(`${ROOM_ID}x`))
  assert.equal(shape(entries).filter((x) => x === ROOM_ID).length, 1)
})

test('ids of removed chats, and rooms that are off, are ignored inside a folder', () => {
  const gone = sidebarEntries(input({ folders: [{ name: 'work', ids: ['dead', 'd1', ROOM_ID] }] }))
  assert.equal(shape(gone)[2], 'v folder:work (2)')
  const off = sidebarEntries(input({ agentsOn: false, folders: [{ name: 'work', ids: [ROOM_ID, AI_ID, 'd1'] }] }))
  assert.equal(shape(off)[2], 'v folder:work (1)')
})

test('a collapsed section hides its rows but keeps the active one', () => {
  const closed = sidebarEntries(input({ collapsed: new Set(['direct', 'tools']) }))
  assert.ok(shape(closed).includes('> direct (2)'))
  assert.ok(!visibleTabIds(closed).includes('d1'))
  assert.ok(!visibleTabIds(closed).includes(TERM_ID))
  const active = sidebarEntries(input({ collapsed: new Set(['direct']), activeId: 'd2' }))
  assert.deepEqual(visibleTabIds(active).filter((id) => id === 'd1' || id === 'd2'), ['d2'])
  assert.ok(shape(active).includes('> direct (2)'), 'the count still says how many are inside')
})

test('hit-testing maps a 1-based row through the scroll offset', () => {
  const entries = sidebarEntries(input())
  assert.deepEqual(sidebarHit(entries, 0, 2), { kind: 'tab', id: null })
  assert.deepEqual(sidebarHit(entries, 0, 3), { kind: 'header', key: 'direct', title: 'DIRECT', open: true, count: 2 })
  assert.deepEqual(sidebarHit(entries, 2, 1), { kind: 'header', key: 'direct', title: 'DIRECT', open: true, count: 2 })
  assert.equal(sidebarHit(entries, 0, 0), undefined)
  assert.equal(sidebarHit(entries, 0, 500), undefined)
  assert.equal(entryIndexOf(entries, 'd2'), 4)
})

test('only chats, docs, the AI tab and the agents room can be filed', () => {
  const convs = [conv('d1', 'dm')]
  for (const id of ['d1', DOCS_ID, ROOM_ID, AI_ID]) assert.equal(fileable(id, convs, true), true, id)
  for (const id of [null, TERM_ID, SETTINGS_ID, agentTabId('omp'), sharedTabId('ab'), 'nope']) assert.equal(fileable(id, convs, true), false, String(id))
  assert.equal(fileable(ROOM_ID, convs, false), false)
})
