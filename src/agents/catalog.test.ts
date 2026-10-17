import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launch, PRESETS } from './catalog.js'

test('every preset has a bin, a matching id and can be launched or run one-shot', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.equal(preset.id, id)
    assert.ok(preset.bin.length > 0, `${id} has no bin`)
    assert.ok(launch(preset) !== undefined || preset.oneShot === true, `${id} cannot be launched`)
  }
})

test('the four original agents are one-shot capable, the rest are ACP-only', () => {
  for (const id of ['omp', 'claude', 'opencode', 'hermes']) assert.equal(PRESETS[id]?.oneShot, true, id)
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (!['omp', 'claude', 'opencode', 'hermes'].includes(id)) assert.ok(!preset.oneShot && launch(preset), id)
  }
})

test('launch uses the ACP binary and arguments of the preset', () => {
  assert.deepEqual(launch(PRESETS['omp']!), { bin: 'omp', args: ['acp'] })
  assert.deepEqual(launch(PRESETS['claude']!), { bin: 'claude-agent-acp', args: [] })
  assert.deepEqual(launch(PRESETS['codex']!), { bin: 'codex-acp', args: [] })
  assert.deepEqual(launch(PRESETS['grok']!), { bin: 'grok', args: ['agent', 'stdio'] })
  assert.deepEqual(launch(PRESETS['copilot']!), { bin: 'copilot', args: ['--acp', '--stdio'] })
  assert.deepEqual(launch(PRESETS['kiro']!), { bin: 'kiro-cli-chat', args: ['acp'] })
  assert.deepEqual(launch(PRESETS['qoder']!), { bin: 'qodercli', args: ['--acp'] })
  assert.deepEqual(launch(PRESETS['cursor']!), { bin: 'cursor-agent', args: ['acp'] })
})

test('launch is undefined for a CLI without an ACP mode', () => {
  assert.equal(launch({ id: 'x', label: 'X', bin: 'x', oneShot: true }), undefined)
})

test('claude keeps its own bin for one-shot and names the ACP bridge separately', () => {
  assert.equal(PRESETS['claude']?.bin, 'claude')
  assert.equal(PRESETS['claude']?.acpBin, 'claude-agent-acp')
})

test('preset ids are valid agent ids so they can be default instance names', () => {
  for (const id of Object.keys(PRESETS)) assert.match(id, /^[a-z][a-z0-9_-]{1,23}$/)
})
