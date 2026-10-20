import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explainPrompt } from './explain.js'

const b = { command: 'npm test', exit: 1, cwd: '/p' }

test('the prompt carries cwd, command and exit code', () => {
  const p = explainPrompt(b, 'boom')
  assert.ok(p.startsWith('Explain what this command did'))
  assert.ok(p.includes('cwd: /p\n$ npm test\n(exit 1)\n\nboom'))
})

test('output is cut to its last 6000 characters only past the limit', () => {
  const exact = 'x'.repeat(6000)
  assert.ok(explainPrompt(b, exact).endsWith(`\n\n${exact}`))
  assert.ok(!explainPrompt(b, exact).includes('…'))
  const over = `a${'x'.repeat(6000)}`
  const p = explainPrompt(b, over)
  assert.ok(p.endsWith(`…\n${'x'.repeat(6000)}`))
  assert.ok(!p.includes('a'.repeat(1) + 'x'))
})

test('a running command says so and multi-line output is kept', () => {
  const p = explainPrompt({ ...b, exit: null }, 'l1\nl2')
  assert.ok(p.includes('(exit running)'))
  assert.ok(p.endsWith('l1\nl2'))
})
