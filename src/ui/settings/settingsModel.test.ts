import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../../app/settings.js'
import type { SettingsView } from '../../app/settingsView.js'
import { accentChoice, buildSettingsRows } from './settingsModel.js'

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  settings: DEFAULT_SETTINGS,
  name: 'alice',
  code: 'CODE',
  version: '1.5.1',
  update: null,
  locks: {},
  themes: ['omp', 'mono'],
  folders: [],
  agentsOn: true,
  agents: { agents: [], review: false, risk: false, goal: '', verify: '', budgets: [], guests: [], sessions: [] },
  ...over,
})

test('rows are grouped under section headers in order', () => {
  const rows = buildSettingsRows(view())
  const sections = rows.flatMap((r) => (r.kind === 'section' ? [r.section] : []))
  assert.deepEqual(sections.slice(0, 3), ['profile', 'appearance', 'notifications'])
  assert.ok(sections.includes('updates') && sections.includes('advanced'))
  const ids = rows.flatMap((r) => ('id' in r ? [r.id] : []))
  for (const id of ['name', 'code', 'badge', 'theme', 'accent', 'density', 'sidebar', 'notify', 'sound', 'alerts', 'update.check', 'updateCheck', 'changelog', 'reduceMotion', 'mouse', 'acp']) {
    assert.ok(ids.includes(id), id)
  }
  assert.equal(new Set(ids).size, ids.length)
})

test('values come from the view', () => {
  const rows = buildSettingsRows(view({ name: 'zed', settings: { ...DEFAULT_SETTINGS, density: 'roomy', mouse: false, accent: '#ff8a00' }, update: '9.9.9' }))
  const byId = (id: string) => rows.find((r) => 'id' in r && r.id === id)
  assert.deepEqual(byId('name'), { kind: 'text', id: 'name', label: 'Display name', value: 'zed' })
  assert.equal((byId('density') as { value: string }).value, 'roomy')
  assert.equal((byId('mouse') as { value: boolean }).value, false)
  assert.equal((byId('accent') as { value: string }).value, 'orange')
  assert.match(rows.find((r) => r.kind === 'info')?.value ?? '', /update available 9\.9\.9/)
})

test('locked settings carry their source on the row', () => {
  const rows = buildSettingsRows(view({ locks: { mouse: 'PAGER_NO_MOUSE' } }))
  const mouse = rows.find((r) => r.kind === 'toggle' && r.id === 'mouse')
  assert.equal(mouse?.kind === 'toggle' && mouse.locked, 'PAGER_NO_MOUSE')
})

test('accentChoice maps a stored color back to its word', () => {
  assert.equal(accentChoice(''), 'auto')
  assert.equal(accentChoice('#ff8a00'), 'orange')
  assert.equal(accentChoice('#123456'), '#123456')
})
