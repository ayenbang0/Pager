import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyText } from './clipboard.js'

test('PAGER_COPY_FILE receives the text, appended, and nothing is written to the terminal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pager-clip-'))
  const file = join(dir, 'copied.txt')
  const writes: unknown[] = []
  const realWrite = process.stdout.write
  process.env.PAGER_COPY_FILE = file
  process.stdout.write = ((chunk: unknown) => {
    writes.push(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    copyText('first line\nsecond ✓')
    copyText(' + more')
  } finally {
    process.stdout.write = realWrite
    delete process.env.PAGER_COPY_FILE
  }
  try {
    assert.equal(readFileSync(file, 'utf8'), 'first line\nsecond ✓ + more')
    assert.deepEqual(writes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unwritable PAGER_COPY_FILE path does not throw', () => {
  process.env.PAGER_COPY_FILE = join(tmpdir(), 'pager-clip-missing-dir', 'nope', 'x.txt')
  try {
    assert.doesNotThrow(() => copyText('anything'))
  } finally {
    delete process.env.PAGER_COPY_FILE
  }
})
