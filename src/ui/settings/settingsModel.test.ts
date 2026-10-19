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
  privacy: { encrypted: false, net: { listening: true, contacts: [], stats: '', logPath: '/x/net.log' } },
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
  const version = rows.find((r) => r.kind === 'info' && r.label === 'Version')
  assert.match(version?.kind === 'info' ? version.value : '', /update available 9\.9\.9/)
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

test('agents, AI and privacy rows follow the view; no-agents hides the first two', () => {
  const on = buildSettingsRows(
    view({
      agents: { agents: [{ name: 'omp', cli: 'omp', model: 'm', effort: 'high', color: 'auto', ready: true }], review: true, risk: false, goal: 'ship', verify: 'npm test', budgets: [{ key: '*', text: 'turns=5' }], guests: [{ pk: 'ab'.repeat(32), name: 'bob', mode: 'view' }], sessions: [{ pk: 'cd'.repeat(32), name: 'ann' }] },
      ai: { default: 'auto', backends: ['omp', 'ollama', 'openai'], ollama: { url: 'http://x', model: '' }, openai: { url: 'https://y', model: 'gpt', keyHint: '••••1234' }, locks: { 'ai.openai.key': 'PAGER_AI_KEY' } },
      folders: [{ name: 'work', count: 2 }],
      privacy: { encrypted: true, lan: { hosting: true, address: '10.0.0.2' }, net: { listening: true, contacts: [{ name: 'bob', pending: false, online: true, caps: ['read'] }], stats: 's', logPath: '/p/net.log' } },
    }),
  )
  const ids = on.flatMap((r) => ('id' in r ? [r.id] : []))
  for (const id of ['agents.setup', 'agent.model:omp', 'agent.color:omp', 'agents.review', 'agents.risk', 'agents.budget:*', 'agents.budget:omp', 'agents.verify', 'agents.goal', 'agents.memory.show', 'agents.memory.add', 'agents.memory.clear', `guest.kick:${'ab'.repeat(32)}`, 'guest.kickall', `session.leave:${'cd'.repeat(32)}`, 'ai.default', 'ai.ollama.url', 'ai.openai.key', 'ai.clear', 'folder.new', 'folder:work', 'folder.delete:work', 'lan', 'agents', 'net.log', 'web']) {
    assert.ok(ids.includes(id), id)
  }
  assert.equal(new Set(ids).size, ids.length)
  const key = on.find((r) => r.kind === 'text' && r.id === 'ai.openai.key')
  assert.deepEqual(key && key.kind === 'text' && [key.value, key.masked, key.locked, key.initial], ['••••1234', true, 'PAGER_AI_KEY', ''])
  const verify = on.find((r) => r.kind === 'text' && r.id === 'agents.verify')
  assert.deepEqual(verify && verify.kind === 'text' && [verify.value, verify.initial], ['npm test', 'npm test'])
  assert.ok(on.some((r) => r.kind === 'info' && r.label === 'Encryption' && r.value === 'on (passphrase)'))
  assert.ok(on.some((r) => r.kind === 'info' && r.label === 'This run' && r.value === 'LAN: hosting 10.0.0.2 · Agents: on'))

  const off = buildSettingsRows(view({ agentsOn: false }))
  const offIds = off.flatMap((r) => ('id' in r ? [r.id] : []))
  assert.ok(!offIds.some((id) => id.startsWith('agent') && id !== 'agents') && !offIds.some((id) => id.startsWith('ai.')))
  assert.ok(offIds.includes('agents') && offIds.includes('web'), 'the switches that turn them back on stay')
  assert.ok(!off.some((r) => r.kind === 'section' && r.section === 'agents'))
})
