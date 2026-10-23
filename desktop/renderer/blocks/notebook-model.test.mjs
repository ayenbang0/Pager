import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ansiRuns,
  appendStream,
  applyEvent,
  autoIndent,
  formatDuration,
  highlightPython,
  newRun,
  normalizeStream,
  pickMime,
  pythonTokens,
  renderMarkdown,
  setSource,
  splitLines,
  updateDisplay,
  wantsCompletion,
} from './notebook-model.js'

test('splitLines keeps newlines and drops nothing', () => {
  assert.deepEqual(splitLines('a\nb\n\nc'), ['a\n', 'b\n', '\n', 'c'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('x\n'), ['x\n'])
})

test('setSource leaves the original representation when unchanged', () => {
  const raw = { source: 'print(1)\nprint(2)' }
  assert.equal(setSource(raw, 'print(1)\nprint(2)'), false)
  assert.equal(raw.source, 'print(1)\nprint(2)')
  assert.equal(setSource(raw, 'x\ny'), true)
  assert.deepEqual(raw.source, ['x\n', 'y'])
})

test('tqdm carriage returns collapse to the last frame', () => {
  let text = ''
  for (const p of [0, 10, 50, 100]) text = appendStream(text, `\rLoading: ${String(p).padStart(3)}%|##|`)
  assert.equal(text, '\rLoading: 100%|##|'.replace('\r', '') + '')
  text = appendStream(text, '\n')
  assert.equal(text, 'Loading: 100%|##|\n')
})

test('a shorter redraw only overwrites its own prefix', () => {
  assert.equal(normalizeStream('abcdef\rxy'), 'xycdef')
  assert.equal(normalizeStream('abc\r\ndef'), 'abc\ndef')
  assert.equal(normalizeStream('abc\r'), 'abc\r')
  assert.equal(appendStream('abc\r', 'de'), 'dec')
  assert.equal(normalizeStream('ab\b\bxy'), 'xy')
  assert.equal(normalizeStream('one\ntwo\rTW'), 'one\nTWo')
})

test('appendStream caps by dropping the oldest lines', () => {
  const big = 'x'.repeat(50) + '\n'
  let text = ''
  for (let i = 0; i < 100; i++) text = appendStream(text, big, 1000)
  assert.ok(text.length <= 1100)
  assert.ok(text.startsWith('… earlier output truncated …\n'))
})

test('a cell run builds nbformat outputs from kernel events', () => {
  const raw = { cell_type: 'code', outputs: [{ output_type: 'stream', name: 'stdout', text: 'old' }], execution_count: null }
  const st = newRun()
  assert.deepEqual(applyEvent(raw, st, { type: 'started', count: 3 }), { type: 'reset' })
  assert.equal(raw.outputs.length, 0)
  assert.equal(raw.execution_count, 3)
  assert.deepEqual(applyEvent(raw, st, { type: 'stream', name: 'stdout', text: 'a' }), { type: 'append', index: 0 })
  assert.deepEqual(applyEvent(raw, st, { type: 'stream', name: 'stdout', text: 'b\n' }), { type: 'stream', index: 0 })
  assert.deepEqual(applyEvent(raw, st, { type: 'stream', name: 'stderr', text: 'e\n' }), { type: 'append', index: 1 })
  assert.equal(raw.outputs[0].text, 'ab\n')
  applyEvent(raw, st, { type: 'display', data: { 'text/plain': 'x' }, metadata: {}, display_id: 'd1' })
  applyEvent(raw, st, { type: 'result', count: 3, data: { 'text/plain': '1' }, metadata: {} })
  assert.equal(raw.outputs[3].output_type, 'execute_result')
  assert.equal(raw.outputs[3].execution_count, 3)
  updateDisplay(st.displays.get('d1'), { data: { 'text/plain': 'y' }, metadata: {} })
  assert.equal(raw.outputs[2].data['text/plain'], 'y')
  applyEvent(raw, st, { type: 'error', ename: 'ValueError', evalue: 'no', traceback: ['tb'] })
  assert.equal(raw.outputs[4].ename, 'ValueError')
  const done = applyEvent(raw, st, { type: 'done', status: 'error', count: 3, ms: 12 })
  assert.deepEqual(done, { type: 'done', status: 'error', ms: 12, count: 3 })
})

test('clear_output(wait=True) waits for the next output', () => {
  const raw = { outputs: [{ output_type: 'stream', name: 'stdout', text: 'x' }] }
  const st = newRun()
  assert.equal(applyEvent(raw, st, { type: 'clear', wait: true }), null)
  assert.equal(raw.outputs.length, 1)
  assert.deepEqual(applyEvent(raw, st, { type: 'stream', name: 'stdout', text: 'y' }), { type: 'append', index: 0 })
  assert.equal(raw.outputs.length, 1)
  assert.equal(raw.outputs[0].text, 'y')
  assert.deepEqual(applyEvent(raw, st, { type: 'clear', wait: false }), { type: 'reset' })
  assert.equal(raw.outputs.length, 0)
})

test('an aborted run keeps the previous execution count', () => {
  const raw = { outputs: [], execution_count: 7 }
  applyEvent(raw, newRun(), { type: 'done', status: 'aborted', count: 9, ms: 0 })
  assert.equal(raw.execution_count, 7)
})

test('pickMime prefers html, then images, then plain', () => {
  assert.equal(pickMime({ 'text/plain': 'x', 'text/html': '<b>x</b>' }), 'text/html')
  assert.equal(pickMime({ 'text/plain': 'x', 'image/png': 'AAAA' }), 'image/png')
  assert.equal(pickMime({ 'text/plain': 'x' }), 'text/plain')
  assert.equal(pickMime({ 'application/x-foo': 'x' }), null)
})

test('ansi runs: colours, bold, reset, 256 and truecolor, stray escapes dropped', () => {
  const runs = ansiRuns('\x1b[1;31mred\x1b[0m plain \x1b[38;5;196mhot\x1b[38;2;1;2;3mrgb\x1b[2K\x1b[39m')
  assert.deepEqual(
    runs.map((r) => [r.text, r.fg, r.bold]),
    [
      ['red', 1, true],
      [' plain ', null, false],
      ['hot', 'rgb(255,0,0)', false],
      ['rgb', 'rgb(1,2,3)', false],
    ],
  )
  assert.equal(ansiRuns('\x1b[0;32mok\x1b[0m')[0].fg, 2)
  assert.equal(ansiRuns('\x1b[92mhi')[0].fg, 10)
  assert.equal(ansiRuns('plain')[0].fg, null)
})

test('python highlighter classes', () => {
  const kinds = (src) => pythonTokens(src).map(([c, t]) => `${c}:${t}`)
  assert.equal(kinds('import os  # hi')[0], 'kw:import')
  const t = pythonTokens('def f(x):\n    return "a" + f"{x}" % 3.5  # c\n')
  const find = (c) => t.filter(([k]) => k === c).map(([, s]) => s)
  assert.deepEqual(find('kw'), ['def', 'return'])
  assert.deepEqual(find('fn'), ['f'])
  assert.deepEqual(find('st'), ['"a"', 'f"{x}"'])
  assert.deepEqual(find('nu'), ['3.5'])
  assert.deepEqual(find('cm'), ['# c'])
  assert.deepEqual(pythonTokens("%config InlineBackend.figure_format = 'retina'")[0], ['mg', "%config InlineBackend.figure_format = 'retina'"])
  assert.deepEqual(find('mg'), [])
  const triple = pythonTokens('s = """a\nb"""\nx = 1')
  assert.ok(triple.some(([k, s]) => k === 'st' && s === '"""a\nb"""'))
  assert.equal(highlightPython('a < b & c'), 'a &lt; b &amp; c')
  assert.ok(!pythonTokens('x = 5 % 3').some(([k]) => k === 'mg'))
  assert.ok(pythonTokens('@property\ndef a(self): pass').some(([k, s]) => k === 'dc' && s === '@property'))
})

test('markdown: headings, emphasis, code, lists, tables, quotes', () => {
  assert.equal(renderMarkdown('# Data'), '<h1>Data</h1>')
  assert.equal(renderMarkdown('A pandas frame renders as a table:'), '<p>A pandas frame renders as a table:</p>')
  assert.equal(renderMarkdown('**b** *i* `c<d>` ~~x~~'), '<p><strong>b</strong> <em>i</em> <code>c&lt;d&gt;</code> <del>x</del></p>')
  assert.equal(renderMarkdown('[a](https://x.y "t")'), '<p><a href="https://x.y" title="t">a</a></p>')
  assert.equal(renderMarkdown('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>')
  assert.equal(renderMarkdown('```py\nx = 1 < 2\n```'), '<pre class="nb-md-code"><code class="language-py">x = 1 &lt; 2</code></pre>')
  assert.equal(renderMarkdown('- a\n- b\n  - c\n- [x] d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li class="task"><input type="checkbox" disabled checked> d</li></ul>')
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
  assert.equal(renderMarkdown('3. a'), '<ol start="3"><li>a</li></ol>')
  assert.equal(renderMarkdown('> q\n> r'), '<blockquote><p>q\nr</p></blockquote>')
  assert.equal(renderMarkdown('---'), '<hr>')
  assert.equal(renderMarkdown('T\n===\n'), '<h1>T</h1>')
  const table = renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |')
  assert.equal(table, '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>')
  assert.equal(renderMarkdown('<div>x</div>\n\nafter'), '<div>x</div>\n<p>after</p>')
  assert.equal(renderMarkdown('<b>x</b> & y'), '<p><b>x</b> &amp; y</p>')
})

test('editing helpers', () => {
  assert.equal(autoIndent('    if x:'), '        ')
  assert.equal(autoIndent('  y = 1'), '  ')
  assert.equal(autoIndent('x = [  # open'), '    ')
  assert.equal(wantsCompletion('import o'), true)
  assert.equal(wantsCompletion('x = '), false)
  assert.equal(wantsCompletion('a\n    '), false)
  assert.equal(wantsCompletion('np.'), true)
})

test('formatDuration', () => {
  assert.equal(formatDuration(598), '598ms')
  assert.equal(formatDuration(12), '12ms')
  assert.equal(formatDuration(1234), '1.23s')
  assert.equal(formatDuration(15_400), '15.4s')
  assert.equal(formatDuration(64_000), '1m 4s')
  assert.equal(formatDuration(3_900_000), '1h 5m')
})
