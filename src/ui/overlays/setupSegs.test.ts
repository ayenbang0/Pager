import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SetupRow } from '../../agents/orchestrator.js'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { segsWidth, type Seg } from '../kit/segs.js'
import { SPINNER_CELL } from '../kit/spinnerCells.js'
import { customHelp, customRowSegs, detailLines, readyPill, setupRowSegs, statusSegs } from './setupSegs.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const row = (readiness: SetupRow['readiness'], extra: Partial<SetupRow> = {}): SetupRow => ({ id: 'omp', label: 'omp', readiness, instances: 0, command: 'omp acp', custom: false, ...extra })

test('each readiness is a pill of its own color with a word', () => {
  const ready = statusSegs(row({ state: 'ready' }), theme)
  assert.equal(text(ready), ' ● ready ')
  assert.equal(ready[0]?.bg, theme.pill.success.bg)
  assert.equal(statusSegs(row({ state: 'missing', reason: 'x' }), theme)[0]?.bg, theme.pill.error.bg)
  assert.equal(statusSegs(row({ state: 'failed', reason: 'x' }), theme)[0]?.bg, theme.pill.warning.bg)
  assert.equal(statusSegs(row({ state: 'unknown' }), theme)[0]?.bg, theme.pill.muted.bg)
  assert.match(text(statusSegs(row({ state: 'missing', reason: 'x' }), theme)), /✗ missing/)
  assert.match(text(statusSegs(row({ state: 'failed', reason: 'x' }), theme)), /! failed/)
})

test('checking is an accent pill around a live spinner cell', () => {
  const segs = statusSegs(row({ state: 'checking' }), theme)
  assert.ok(segs.some((s) => s.text === SPINNER_CELL))
  assert.ok(segs.every((s) => s.bg === theme.pill.accent.bg))
  assert.match(text(segs), /checking/)
})

test('rows are exactly the width in every state, selected or not', () => {
  const states: SetupRow['readiness'][] = [{ state: 'ready' }, { state: 'checking' }, { state: 'unknown' }, { state: 'missing', reason: 'omp not found on PATH, install it first please' }, { state: 'failed', reason: 'handshake timed out after fifteen seconds' }]
  for (const readiness of states) {
    for (const extra of [{}, { instances: 2 }, { custom: true, instances: 12, id: 'a-rather-long-agent-id' }]) {
      for (const selected of [false, true]) {
        for (const width of [100, 60, 30, 14]) {
          assert.equal(segsWidth(setupRowSegs(row(readiness, extra), selected, width, theme)), width, `${readiness.state} ${selected} ${width}`)
        }
      }
    }
  }
})

test('rows carry the instance count and custom chip as pills, and the reason after', () => {
  const line = text(setupRowSegs(row({ state: 'missing', reason: 'not on PATH' }, { instances: 2, custom: true }), false, 100, theme))
  assert.match(line, /×2/)
  assert.match(line, /custom/)
  assert.match(line.trimEnd(), /not on PATH$/)
  const selected = setupRowSegs(row({ state: 'ready' }), true, 60, theme)
  assert.equal(selected[0]?.text, '▎')
})

test('detail lines turn runs/install/sign in into chips and color the reason by state', () => {
  const failed = detailLines(row({ state: 'failed', reason: 'handshake failed' }, { install: 'npm i -g x', auth: 'x login' }), theme)
  assert.equal(failed.length, 4)
  assert.match(text(failed[0] ?? []), /‹runs› omp acp/)
  assert.equal(failed[1]?.[1]?.color, theme.warning)
  assert.match(text(failed[2] ?? []), /‹install› npm i -g x/)
  assert.match(text(failed[3] ?? []), /‹sign in› x login/)
  const missing = detailLines(row({ state: 'missing', reason: 'not found' }), theme)
  assert.equal(missing[1]?.[1]?.color, theme.error)
  assert.equal(detailLines(row({ state: 'ready' }), theme).length, 1)
  assert.equal(customHelp(theme).length, 2)
})

test('the custom row is an input of the exact width, with the cursor only when focused', () => {
  for (const width of [80, 30, 12]) {
    for (const focused of [false, true]) {
      for (const typed of ['', 'mine node my-agent.js --acp', 'x'.repeat(200)]) {
        assert.equal(segsWidth(customRowSegs(typed, focused, width, theme)), width, `${width} ${focused} ${typed.length}`)
      }
    }
  }
  assert.match(text(customRowSegs('abc', true, 40, theme)), /custom {2}abc▁/)
  assert.doesNotMatch(text(customRowSegs('abc', false, 40, theme)), /▁/)
  assert.match(text(customRowSegs('', false, 40, theme)), /<id> <command…>/)
  assert.equal(customRowSegs('', true, 40, theme)[0]?.text, '▎')
})

test('the ready pill turns green once anything is ready', () => {
  assert.equal(readyPill(0, 5, theme).bg, theme.pill.muted.bg)
  assert.equal(readyPill(2, 5, theme).bg, theme.pill.success.bg)
  assert.equal(readyPill(2, 5, theme).text, ' 2/5 ready ')
})
