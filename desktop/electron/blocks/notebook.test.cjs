'use strict'
// node --test desktop/electron/blocks/notebook.test.cjs   (kernel tests run when a Python 3.8+ is installed)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { after, before, describe, test } = require('node:test')
const nb = require('./notebook.cjs')

const { parseNotebook, serializeNotebook, LineSplitter, findPythons, splitLines, noPythonMessage } = nb._internals
const m = nb.methods

const SAMPLE = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "a1b2c3d4",
   "metadata": {
    "tags": [
     "intro"
    ]
   },
   "source": [
    "# Title\\n",
    "text ünïcode ✓"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 1,
   "id": "e5f6a7b8",
   "metadata": {},
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "hi\\n"
     ]
    },
    {
     "data": {
      "image/png": "iVBORw0KGgo=",
      "text/plain": [
       "<Figure size 640x480 with 1 Axes>"
      ]
     },
     "metadata": {
      "needs_background": "light"
     },
     "output_type": "display_data"
    }
   ],
   "source": [
    "print('hi')"
   ]
  }
 ],
 "metadata": {
  "custom_extension": {
   "keep": [
    1,
    2
   ]
  },
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
`

let tmp
let pythons = []
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-nb-'))
  pythons = await findPythons({ cwd: tmp, refresh: true })
})
after(async () => {
  nb.dispose()
  await new Promise((r) => setTimeout(r, 1200)) // let the kernels release their working directory (Windows)
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* a kernel still exiting: the OS temp cleaner takes it */
  }
})

describe('nbformat', () => {
  test('a Jupyter-written file round-trips byte for byte, unknown fields included', () => {
    const { nb: parsed, format } = parseNotebook(SAMPLE)
    assert.equal(format.indent, ' ')
    assert.equal(format.sortKeys, true)
    assert.equal(serializeNotebook(parsed, format), SAMPLE)
  })

  test('indent, key order and CRLF of the original are kept', () => {
    const text = JSON.stringify({ nbformat: 4, nbformat_minor: 2, metadata: { z: 1, a: 2 }, cells: [{ source: 'x = 1', cell_type: 'code', metadata: {}, outputs: [], execution_count: null }] }, null, 2).replace(/\n/g, '\r\n')
    const { nb: parsed, format } = parseNotebook(text)
    assert.equal(format.indent, '  ')
    assert.equal(format.sortKeys, false)
    assert.equal(format.eol, '\r\n')
    assert.equal(format.finalNewline, false)
    const out = serializeNotebook(parsed, format)
    assert.deepEqual(JSON.parse(out).metadata, { z: 1, a: 2 })
    assert.ok(out.indexOf('"nbformat"') < out.indexOf('"metadata"'))
    assert.ok(out.includes('\r\n  "'))
    assert.deepEqual(JSON.parse(out).cells[0].source, ['x = 1'])
  })

  test('edited sources are written as line lists; ids are added on nbformat >= 4.5 only', () => {
    const { nb: parsed, format } = parseNotebook(SAMPLE)
    parsed.cells.push({ cell_type: 'code', metadata: {}, source: 'a\nb\n', outputs: [{ output_type: 'stream', name: 'stderr', text: 'x\ny' }] })
    const out = JSON.parse(serializeNotebook(parsed, format))
    assert.deepEqual(out.cells[2].source, ['a\n', 'b\n'])
    assert.equal(typeof out.cells[2].id, 'string')
    assert.equal(out.cells[2].execution_count, null)
    assert.deepEqual(out.cells[2].outputs[0].text, ['x\n', 'y'])
    const old = parseNotebook(JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells: [{ cell_type: 'markdown', metadata: {}, source: 'x' }] }))
    assert.equal(JSON.parse(serializeNotebook(old.nb, old.format)).cells[0].id, undefined)
  })

  test('refuses other nbformats and broken files with a message', () => {
    assert.throws(() => parseNotebook('{"nbformat":3,"worksheets":[]}'), /nbformat 3 is not supported/)
    assert.throws(() => parseNotebook('{nope'), /not a valid notebook/)
    assert.throws(() => parseNotebook('[]'), /top level/)
    assert.throws(() => parseNotebook('{"nbformat":4,"metadata":{}}'), /cells is missing/)
  })

  test('splitLines', () => assert.deepEqual(splitLines('a\nb'), ['a\n', 'b']))
})

describe('open and save', () => {
  test('missing file opens as a new notebook, save creates it, a second create refuses', async () => {
    const file = path.join(tmp, 'new.ipynb')
    const opened = await m.open({ path: file })
    assert.equal(opened.missing, true)
    assert.equal(opened.nb.nbformat, 4)
    const saved = await m.save({ path: file, nb: opened.nb, format: opened.format, create: true })
    assert.equal(saved.ok, true)
    assert.equal((await m.save({ path: file, nb: opened.nb, create: true })).conflict, 'exists')
    const again = await m.open({ path: file })
    assert.equal(again.missing, false)
    assert.equal(again.nb.cells.length, 1)
    assert.equal(again.mtimeMs, saved.mtimeMs)
  })

  test('save detects a file that changed on disk', async () => {
    const file = path.join(tmp, 'conflict.ipynb')
    fs.writeFileSync(file, SAMPLE)
    const o = await m.open({ path: file })
    fs.writeFileSync(file, SAMPLE.replace('Title', 'Other'))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    const r = await m.save({ path: file, nb: o.nb, format: o.format, expectMtimeMs: o.mtimeMs })
    assert.equal(r.conflict, 'changed')
    assert.equal((await m.save({ path: file, nb: o.nb, format: o.format, expectMtimeMs: o.mtimeMs, force: true })).ok, true)
    assert.equal(fs.readFileSync(file, 'utf8'), SAMPLE)
  })

  test('errors come back as messages', async () => {
    const bad = path.join(tmp, 'bad.ipynb')
    fs.writeFileSync(bad, '{"nbformat": 3}')
    const r = await m.open({ path: bad })
    assert.equal(r.ok, false)
    assert.match(r.error, /nbformat 3/)
    assert.equal((await m.open({ path: tmp })).ok, false)
  })
})

describe('plumbing', () => {
  test('LineSplitter reassembles lines and UTF-8 split across chunks', () => {
    const lines = []
    const s = new LineSplitter((l) => lines.push(l))
    const bytes = Buffer.from('{"a":"é✓"}\n{"b":1}\n\npart')
    s.push(bytes.subarray(0, 8))
    s.push(bytes.subarray(8, 10))
    s.push(bytes.subarray(10))
    assert.deepEqual(lines, ['{"a":"é✓"}', '{"b":1}'])
    s.push(Buffer.from('ial\n'))
    assert.equal(lines[2], 'partial')
  })

  test('no Python: a clear message and no kernel', async () => {
    assert.deepEqual(await findPythons({ commands: [{ cmd: path.join(tmp, 'definitely-not-python'), args: [] }] }), [])
    assert.match(noPythonMessage(), /No Python 3\.8 or newer was found/)
    const r = await m.kernelStart({ key: 'bad', cwd: tmp, python: path.join(tmp, 'definitely-not-python') }, { emit() {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_PYTHON')
    assert.match(r.message, /Settings > Notebooks/)
  })
})

describe('kernel', { skip: process.env.PAGER_NO_PYTHON_TESTS === '1' }, () => {
  const events = []
  const waiters = []
  const ctx = {
    emit(name, payload) {
      if (name !== 'kernel') return
      events.push(payload.ev)
      for (const w of [...waiters]) if (w.test(payload.ev)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(payload.ev))
    },
  }
  const waitFor = (test, ms = 15000) => {
    const hit = events.find(test)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { test, resolve }
      waiters.push(w)
      setTimeout(() => reject(new Error('timeout waiting for kernel event')), ms).unref()
    })
  }
  const run = async (key, id, code, extra = {}) => {
    await new Promise((r) => setTimeout(r, 120)) // past the kernel's 50 ms abort window after a failed cell
    const done = waitFor((e) => e.type === 'done' && e.id === id)
    const r = await m.execute({ key, id, code, ...extra }, ctx)
    assert.equal(r.ok, true, r.message)
    await done
    return events.filter((e) => e.id === id)
  }

  test('start, run, results, errors, queue abort, interrupt, restart', async (t) => {
    if (!pythons.length) return t.skip('no Python on this machine')
    const key = 'k1'
    const started = await m.kernelStart({ key, cwd: tmp }, ctx)
    assert.equal(started.ok, true, started.message)
    assert.match(started.info.python, /^3\.\d+/)
    assert.equal(started.info.protocol, 1)

    let evs = await run(key, 'a', 'import sys\nprint("Hello", sys.version_info[0])\n1 + 2')
    assert.equal(evs.find((e) => e.type === 'started').count, 1)
    assert.equal(evs.filter((e) => e.type === 'stream').map((e) => e.text).join(''), 'Hello 3\n')
    assert.equal(evs.find((e) => e.type === 'result').data['text/plain'], '3')
    assert.equal(evs.find((e) => e.type === 'done').status, 'ok')

    evs = await run(key, 'b', 'x = 41\nraise ValueError("boom")')
    const err = evs.find((e) => e.type === 'error')
    assert.equal(err.ename, 'ValueError')
    assert.equal(err.evalue, 'boom')
    assert.ok(err.traceback.length > 0)
    assert.equal(evs.find((e) => e.type === 'done').status, 'error')

    // stop on error: cells queued in the same batch after the failing one are aborted
    const c = waitFor((e) => e.type === 'done' && e.id === 'e')
    await m.execute({ key, stopOnError: true, cells: [{ id: 'c', code: 'raise RuntimeError("x")' }, { id: 'd', code: 'print("never")' }, { id: 'e', code: 'print("never")' }] }, ctx)
    await c
    assert.equal(events.find((e) => e.type === 'done' && e.id === 'd').status, 'aborted')
    assert.equal(events.find((e) => e.type === 'done' && e.id === 'e').status, 'aborted')
    assert.equal(events.some((e) => e.type === 'stream' && e.id === 'd'), false)

    // state persists; completion and variables answer (a run after the abort window is not aborted)
    await new Promise((r) => setTimeout(r, 250))
    evs = await run(key, 'f', 'print(x + 1)')
    assert.equal(evs.filter((e) => e.type === 'stream').map((e) => e.text).join(''), '42\n')
    const comp = await m.complete({ key, code: 'import o', cursor: 8 })
    assert.ok(comp.matches.some((c) => c.text === 'os' && c.type === 'module'), JSON.stringify(comp).slice(0, 200))
    assert.equal(comp.cursor_start, 7)
    const attr = await m.complete({ key, code: 'x.bit_', cursor: 6 })
    assert.ok(attr.matches.some((c) => c.text === 'bit_length'), JSON.stringify(attr).slice(0, 200))
    const vars = await m.variables({ key })
    assert.ok(vars.vars.some((v) => v.name === 'x'))

    // interrupt a sleeping cell
    const sleeping = waitFor((e) => e.type === 'started' && e.id === 'g')
    const slept = waitFor((e) => e.type === 'done' && e.id === 'g')
    await m.execute({ key, id: 'g', code: 'import time\ntime.sleep(60)' }, ctx)
    await sleeping
    await new Promise((r) => setTimeout(r, 200))
    const t0 = Date.now()
    await m.interrupt({ key })
    const done = await slept
    assert.equal(done.status, 'error')
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(events.find((e) => e.type === 'error' && e.id === 'g').ename, 'KeyboardInterrupt')

    // input() (after the abort window of the interrupted cell)
    await new Promise((r) => setTimeout(r, 250))
    const asked = waitFor((e) => e.type === 'input' && e.id === 'h')
    const answered = waitFor((e) => e.type === 'done' && e.id === 'h')
    await m.execute({ key, id: 'h', code: 'name = input("who? ")\nprint("hi", name)', allowStdin: true }, ctx)
    const input = await asked
    assert.equal(input.prompt, 'who? ')
    await m.inputReply({ key, value: 'pager' })
    await answered
    assert.equal(events.filter((e) => e.type === 'stream' && e.id === 'h').map((e) => e.text).join(''), 'hi pager\n')

    // restart forgets everything
    const restarted = await m.restart({ key, cwd: tmp }, ctx)
    assert.equal(restarted.ok, true)
    evs = await run(key, 'i', 'print(x)')
    assert.equal(evs.find((e) => e.type === 'error').ename, 'NameError')
    assert.equal(evs.find((e) => e.type === 'started').count, 1)

    // C-level and child-process output lands in the cell
    evs = await run(key, 'j', 'import os, subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(5)"])\nos.write(1, b"raw\\n")')
    assert.equal(evs.filter((e) => e.type === 'stream').map((e) => e.text).join('').replace(/\r\n/g, '\n'), '5\nraw\n')

    assert.deepEqual((await m.status({ key })).running, [])
    assert.equal((await m.shutdown({ key })).ok, true)
  })

  test('one kernel per key; a dead kernel reports its exit', async (t) => {
    if (!pythons.length) return t.skip('no Python on this machine')
    await m.kernelStart({ key: 'k2', cwd: tmp }, ctx)
    await m.kernelStart({ key: 'k3', cwd: tmp }, ctx)
    const a = await run('k2', 'p', 'import os\nprint(os.getpid())')
    const b = await run('k3', 'q', 'import os\nprint(os.getpid())')
    assert.notEqual(a.find((e) => e.type === 'stream').text, b.find((e) => e.type === 'stream').text)
    const exited = waitFor((e) => e.type === 'exit' && !e.expected)
    await m.execute({ key: 'k2', id: 'r', code: 'import os\nos._exit(3)' }, ctx)
    const ev = await exited
    assert.equal(ev.code, 3)
    assert.equal((await m.status({ key: 'k2' })).alive, false)
    await m.shutdown({ key: 'k3' })
  })

  test('matplotlib figures and DataFrames arrive as rich output (when installed)', async (t) => {
    if (!pythons.length) return t.skip('no Python on this machine')
    const probe = require('node:child_process').spawnSync(pythons[0].exe, ['-c', 'import matplotlib, pandas'], { windowsHide: true })
    if (probe.status !== 0) return t.skip('matplotlib/pandas are not installed')
    const key = 'k4'
    await m.kernelStart({ key, cwd: tmp }, ctx)
    let evs = await run(key, 's', 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(3,2))\nax.plot([1,2,3])\nNone')
    const shown = evs.find((e) => e.type === 'display')
    assert.ok(shown && shown.data['image/png'], 'a PNG display')
    assert.equal(Buffer.from(shown.data['image/png'], 'base64').subarray(1, 4).toString(), 'PNG')
    evs = await run(key, 't', 'import pandas as pd\npd.DataFrame({"a": [1, 2]})')
    const result = evs.find((e) => e.type === 'result')
    assert.ok(result.data['text/html'].includes('<table'))
    await m.shutdown({ key })
  })
})
