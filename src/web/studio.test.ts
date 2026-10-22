import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBotInput } from './studio.js'

const base = { conv: `grp:${'a'.repeat(32)}`, name: 'grumpy', backend: 'ollama', instructions: 'Complain.' }

test('the studio takes an optional model and effort and treats empty as unset', () => {
  assert.deepEqual(Object.keys(parseBotInput({ ...base, model: '', effort: '' }) as object).filter((k) => k === 'model' || k === 'effort'), [])
  const bot = parseBotInput({ ...base, model: 'llama3', effort: 'high' })
  assert.ok(typeof bot !== 'string' && bot.model === 'llama3' && bot.effort === 'high')
  assert.match(parseBotInput({ ...base, model: 'a\nb' }) as string, /model/)
  assert.match(parseBotInput({ ...base, effort: 5 }) as string, /effort/)
})
