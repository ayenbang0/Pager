import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME as theme } from '../theme/themes.js'
import { agentBanner, chooserRowSegs, columnHeader, columnRowSegs, explainLines, isCurrent } from './modelSegs.js'
import type { ColumnSpec } from './modelState.js'
import { segsWidth, type Seg } from '../kit/segs.js'

const text = (segs: Seg[]): string => segs.map((s) => s.text).join('')
const spec: ColumnSpec = { kind: 'model', settable: true, choices: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], current: 'a' }

test('column headers fill the width; the focused one wears the accent band and a gradient', () => {
  for (const width of [40, 20, 10]) {
    for (const focused of [true, false]) assert.equal(segsWidth(columnHeader('MODEL', spec, focused, width, theme)), width)
  }
  const on = columnHeader('MODEL', spec, true, 40, theme)
  const off = columnHeader('MODEL', spec, false, 40, theme)
  assert.equal(on[1]?.bg, theme.band.bg)
  assert.equal(off[1]?.bg, theme.pill.muted.bg)
  assert.match(text(on), /MODEL.*a .*━/)
  assert.match(text(off), /─/)
  assert.match(text(columnHeader('EFFORT', { kind: 'effort', settable: true, choices: [] }, true, 40, theme)), /default/)
})

test('the value in effect is marked ● in success; other rows ○', () => {
  assert.equal(isCurrent({ kind: 'choice', value: 'a', label: 'Alpha' }, spec), true)
  assert.equal(isCurrent({ kind: 'default' }, spec), false)
  assert.equal(isCurrent({ kind: 'default' }, { ...spec, current: undefined }), true)
  const on = columnRowSegs({ kind: 'choice', value: 'a', label: 'Alpha' }, spec, '', { focused: false, cursor: false }, '', 30, theme)
  assert.match(text(on), /● Alpha/)
  assert.equal(on.find((s) => s.text === '●')?.color, theme.success)
  const off = columnRowSegs({ kind: 'choice', value: 'b', label: 'Beta' }, spec, '', { focused: false, cursor: false }, '', 30, theme)
  assert.match(text(off), /○ Beta/)
})

test('the cursor row is the bar only in the focused column; the other column marks it with ›', () => {
  const row = { kind: 'choice', value: 'b', label: 'Beta' } as const
  assert.equal(columnRowSegs(row, spec, '', { focused: true, cursor: true }, '', 30, theme)[0]?.text, '▎')
  assert.equal(columnRowSegs(row, spec, '', { focused: false, cursor: true }, '', 30, theme)[0]?.text, '›')
  assert.equal(columnRowSegs(row, spec, '', { focused: true, cursor: false }, '', 30, theme)[0]?.text, ' ')
})

test('every row is exactly the width, long and wide labels included', () => {
  const rows = [{ kind: 'default' }, { kind: 'choice', value: 'x', label: 'a-very-long-model-name-from-some-provider' }, { kind: 'choice', value: 'y', label: '漢字漢字漢字漢字漢字' }, { kind: 'text' }] as const
  for (const row of rows) {
    for (const focused of [true, false]) {
      for (const cursor of [true, false]) {
        for (const width of [40, 15, 8]) {
          assert.equal(segsWidth(columnRowSegs(row, spec, 'typed text', { focused, cursor }, 'type a model id', width, theme)), width, `${row.kind} ${focused} ${cursor} ${width}`)
        }
      }
    }
  }
})

test('the free-text row is an input: cursor only when it is the focused cursor row, else the advertised hint', () => {
  const free: ColumnSpec = { kind: 'model', settable: true, choices: [] }
  const here = columnRowSegs({ kind: 'text' }, free, 'gpt', { focused: true, cursor: true }, 'type a model id', 30, theme)
  assert.match(text(here), /✎ gpt▁/)
  const away = columnRowSegs({ kind: 'text' }, free, '', { focused: false, cursor: true }, 'type a model id', 30, theme)
  assert.match(text(away), /none advertised/)
  assert.doesNotMatch(text(away), /▁/)
  assert.match(text(columnRowSegs({ kind: 'text' }, free, '', { focused: true, cursor: true }, 'type a model id', 30, theme)), /type a model id/)
})

test('unsettable columns explain themselves in info pills, wrapped and capped', () => {
  const lines = explainLines('omp', 'MODEL', 20, 10, theme)
  assert.ok(lines.length > 1)
  for (const line of lines) {
    assert.ok(segsWidth(line) <= 20)
    assert.equal(line[1]?.bg, theme.pill.info.bg)
  }
  assert.match(lines.map(text).join(' '), /Not settable/)
  assert.match(lines.map(text).join(' ').replace(/\s+/g, ' '), /answered a message/)
  const effort = explainLines('omp', 'EFFORT', 40, 10, theme).map(text).join(' ')
  assert.doesNotMatch(effort, /answered a message/)
  const capped = explainLines('omp', 'MODEL', 20, 2, theme)
  assert.equal(capped.length, 2)
  assert.match(text(capped[1] ?? []), /…/)
  for (const line of capped) assert.ok(segsWidth(line) <= 20)
})

test('chooser rows fit the width and show the cli pill and settings', () => {
  const agent = { name: 'omp', cli: 'omp', model: 'gpt-5', effort: 'high' }
  for (const selected of [false, true]) {
    for (const width of [60, 30, 12]) assert.equal(segsWidth(chooserRowSegs(agent, '#ff00ff', selected, width, theme)), width)
  }
  assert.match(text(chooserRowSegs(agent, '#ff00ff', false, 60, theme)), /● omp  omp  gpt-5 · high/)
  assert.equal(chooserRowSegs(agent, '#ff00ff', true, 60, theme)[0]?.text, '▎')
  assert.match(text(chooserRowSegs({ name: 'x1', cli: 'omp' }, '#fff', false, 40, theme)), /x1/)
  assert.match(text(agentBanner('omp', 'omp', theme)), / omp  omp {2}applies to its next message/)
})
