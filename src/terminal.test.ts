import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Terminal, type TermEntry } from './terminal.js'

const done = (t: Terminal): Promise<TermEntry> => {
  const { promise, resolve } = Promise.withResolvers<TermEntry>()
  t.once('finished', resolve)
  return promise
}

test('runs a command in the working directory and captures its output', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pager-term-')))
  const t = new Terminal(dir)
  try {
    const finished = done(t)
    t.run('node -e "console.log(process.cwd()); console.error(\'boom\'); process.exit(3)"')
    const e = await finished
    assert.equal(e.state, 'failed')
    assert.equal(e.code, 3)
    assert.ok(e.lines.some((l) => fs.realpathSync(l) === dir))
    assert.ok(e.lines.includes('boom'))
  } finally {
    t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cd moves later commands, rejects missing directories and handles ~', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pager-term-')))
  fs.mkdirSync(path.join(dir, 'sub'))
  const t = new Terminal(dir)
  try {
    t.run('cd sub')
    assert.equal(t.cwd, path.join(dir, 'sub'))
    t.run('cd nope')
    assert.equal(t.list().at(-1)?.state, 'failed')
    assert.equal(t.cwd, path.join(dir, 'sub'))
    t.run('cd ..')
    assert.equal(t.cwd, dir)
    t.run('cd ~')
    assert.equal(t.cwd, os.homedir())
  } finally {
    t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('output drops escape codes and keeps only what a carriage return leaves visible', async () => {
  const t = new Terminal(process.cwd())
  try {
    const finished = done(t)
    t.run('node -e "process.stdout.write(\'\\x1b[31mred\\x1b[0m\\n10%\\r100%\\n\')"')
    const e = await finished
    assert.deepEqual(e.lines.slice(0, 2), ['red', '100%'])
  } finally {
    t.close()
  }
})

test('typed lines reach a running command and stop() ends it', async () => {
  const t = new Terminal(process.cwd())
  try {
    const finished = done(t)
    t.run('node -e "process.stdin.once(\'data\', (d) => { console.log(\'got:\' + d.toString().trim()); setInterval(() => {}, 1000) })"')
    assert.equal(t.running, true)
    t.run('hello')
    const deadline = Date.now() + 10_000
    // Real child process: poll until it echoes the input back.
    while (!t.list().at(-1)?.lines.includes('got:hello') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert.ok(t.list().at(-1)?.lines.includes('got:hello'))
    assert.equal(t.stop(), true)
    const e = await finished
    assert.equal(e.state, 'stopped')
    assert.equal(t.running, false)
    assert.equal(t.stop(), false)
  } finally {
    t.close()
  }
})
