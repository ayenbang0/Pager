import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEnvFromSettings } from './envSettings.js'
import { DEFAULT_SETTINGS, type Settings } from './settings.js'

const noFlags = { lan: false, noAgents: false }
const rows: [keyof Settings, string, boolean][] = [
  ['reduceMotion', 'PAGER_REDUCE_MOTION', true],
  ['mouse', 'PAGER_NO_MOUSE', false],
  ['alerts', 'PAGER_NO_NOTIFY', false],
  ['updateCheck', 'PAGER_NO_UPDATE_CHECK', false],
  ['acp', 'PAGER_NO_ACP', false],
  ['web', 'PAGER_NO_WEB', false],
  ['agents', 'PAGER_NO_AGENTS', false],
  ['lan', 'PAGER_LAN', true],
]

test('defaults set no variable and lock nothing', () => {
  const env: NodeJS.ProcessEnv = {}
  assert.deepEqual(applyEnvFromSettings(DEFAULT_SETTINGS, env, noFlags), [])
  assert.deepEqual(env, {})
})

for (const [key, name, sets] of rows) {
  test(`${key} <-> ${name}`, () => {
    const env: NodeJS.ProcessEnv = {}
    assert.deepEqual(applyEnvFromSettings({ ...DEFAULT_SETTINGS, [key]: sets }, env, noFlags), [])
    assert.equal(env[name], '1')
    const preset: NodeJS.ProcessEnv = { [name]: '1' }
    assert.deepEqual(applyEnvFromSettings(DEFAULT_SETTINGS, preset, noFlags), [{ key, source: name }])
    assert.equal(preset[name], '1')
  })
}

test('the environment wins over the stored value and only "1" counts', () => {
  const env: NodeJS.ProcessEnv = { PAGER_NO_MOUSE: '0' }
  assert.deepEqual(applyEnvFromSettings({ ...DEFAULT_SETTINGS, mouse: true }, env, noFlags), [])
  assert.equal(env.PAGER_NO_MOUSE, '0')
})

test('--lan and --no-agents lock their settings and set the variables', () => {
  const env: NodeJS.ProcessEnv = {}
  const locks = applyEnvFromSettings(DEFAULT_SETTINGS, env, { lan: true, noAgents: true })
  assert.deepEqual(locks, [{ key: 'agents', source: '--no-agents' }, { key: 'lan', source: '--lan' }])
  assert.equal(env.PAGER_NO_AGENTS, '1')
  assert.equal(env.PAGER_LAN, '1')
})
