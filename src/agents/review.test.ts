import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feedbackText, pickReviewer, REVIEW_DIFF_MAX_CHARS, reviewRequest } from './review.js'
import type { AgentState } from './types.js'

const w = (name: string, cli: string, state: AgentState = 'idle'): { name: string; cli: string; state: AgentState } => ({
  name,
  cli,
  state,
})

test('the author never reviews their own work; a lone agent has no reviewer', () => {
  assert.equal(pickReviewer('a', [w('a', 'omp')], -1), undefined)
  assert.equal(pickReviewer('a', [w('a', 'omp'), w('b', 'omp')], -1), 'b')
})

test('round robin continues after lastIndex and wraps around', () => {
  const ws = [w('a', 'omp'), w('b', 'omp'), w('c', 'omp'), w('d', 'omp')]
  assert.equal(pickReviewer('a', ws, -1), 'b')
  assert.equal(pickReviewer('a', ws, 1), 'c')
  assert.equal(pickReviewer('a', ws, 3), 'b')
  assert.equal(pickReviewer('d', ws, 2), 'a')
  assert.equal(pickReviewer('b', ws, 1), 'c')
  assert.equal(pickReviewer('b', ws, 2), 'd')
})

test('the author is skipped when round robin lands on them', () => {
  const ws = [w('a', 'omp'), w('b', 'omp'), w('c', 'omp')]
  assert.equal(pickReviewer('b', ws, 0), 'c')
  assert.equal(pickReviewer('c', ws, 1), 'a')
})

test('a different cli is preferred over the next in line', () => {
  const ws = [w('a', 'omp'), w('b', 'omp'), w('c', 'claude')]
  assert.equal(pickReviewer('a', ws, -1), 'c')
  assert.equal(pickReviewer('c', ws, -1), 'a')
})

test('round robin still rotates among several different-cli candidates', () => {
  const ws = [w('a', 'omp'), w('b', 'claude'), w('c', 'omp'), w('d', 'hermes')]
  assert.equal(pickReviewer('a', ws, -1), 'b')
  assert.equal(pickReviewer('a', ws, 1), 'd')
  assert.equal(pickReviewer('a', ws, 3), 'b')
})

test('asking workers are skipped, and when only they remain there is no reviewer', () => {
  const ws = [w('a', 'omp'), w('b', 'claude', 'asking'), w('c', 'omp')]
  assert.equal(pickReviewer('a', ws, -1), 'c')
  assert.equal(pickReviewer('a', [w('a', 'omp'), w('b', 'claude', 'asking')], -1), undefined)
})

test('working and reviewing workers can still be picked', () => {
  assert.equal(pickReviewer('a', [w('a', 'omp'), w('b', 'omp', 'working')], -1), 'b')
  assert.equal(pickReviewer('a', [w('a', 'omp'), w('b', 'omp', 'reviewing')], -1), 'b')
})

test('empty list and out-of-range lastIndex do not crash', () => {
  assert.equal(pickReviewer('a', [], -1), undefined)
  const ws = [w('a', 'omp'), w('b', 'omp')]
  assert.equal(pickReviewer('a', ws, 99), 'b')
  assert.equal(pickReviewer('a', ws, -5), 'b')
})

const file = (name: string, body: string): string => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`
const base = { author: 'omp', branch: 'pager/omp', dir: '/w/omp', stat: ' a.ts | 2 +-', finalText: 'did it' }

test('the review request carries author, branch, worktree, stat, diff, final message and the tool name', () => {
  const text = reviewRequest({ ...base, diff: file('a.ts', '+x') })
  for (const part of ['Author: omp', 'Branch: pager/omp', '/w/omp', '\na.ts | 2 +-\n', 'diff --git a/a.ts', 'did it', 'submit_review', 'approve', 'changes']) {
    assert.ok(text.includes(part), part)
  }
  assert.ok(!text.includes('truncated'))
})

test('a diff over the limit is cut at a file boundary and the omitted files are counted', () => {
  const big = 'z'.repeat(9000)
  const diff = file('a.ts', big) + file('b.ts', big) + file('c.ts', big) + file('d.ts', big)
  assert.ok(diff.length > REVIEW_DIFF_MAX_CHARS)
  const text = reviewRequest({ ...base, diff })
  assert.ok(text.includes('diff --git a/a.ts'))
  assert.ok(text.includes('diff --git a/b.ts'))
  assert.ok(!text.includes('diff --git a/c.ts'))
  assert.ok(text.includes('[diff truncated: 2 more files]'))
  const shown = text.slice(text.indexOf('Diff:'), text.indexOf('[diff truncated'))
  assert.ok(shown.length < REVIEW_DIFF_MAX_CHARS + 100)
  assert.ok(shown.trimEnd().endsWith('z'), 'no file is cut half-way')
})

test('a diff exactly at the limit is kept whole', () => {
  const head = 'diff --git a/a.ts b/a.ts\n'
  const diff = head + 'q'.repeat(REVIEW_DIFF_MAX_CHARS - head.length)
  assert.equal(diff.length, REVIEW_DIFF_MAX_CHARS)
  assert.ok(!reviewRequest({ ...base, diff }).includes('truncated'))
})

test('a single file over the limit still shows its head and says so', () => {
  const diff = file('a.ts', 'z'.repeat(REVIEW_DIFF_MAX_CHARS * 2)) + file('b.ts', 'x')
  const text = reviewRequest({ ...base, diff })
  assert.ok(text.includes('[diff truncated: 1 more files; the first file is cut too]'))
  assert.ok(!text.includes('diff --git a/b.ts'))
  assert.ok(text.length < REVIEW_DIFF_MAX_CHARS + 2000)
})

test('empty stat, diff and final message are labelled rather than blank', () => {
  const text = reviewRequest({ ...base, stat: '', diff: '', finalText: '  ' })
  assert.ok(text.includes('(none)') && text.includes('(no diff)') && text.includes('(empty)'))
})

test('feedback text names the reviewer and carries the comments for each verdict', () => {
  assert.match(feedbackText('claude', 'changes', 'rename x'), /claude.*asks for changes[\s\S]*rename x[\s\S]*finish your turn/)
  assert.match(feedbackText('claude', 'approve', 'lgtm'), /approved[\s\S]*lgtm/)
  assert.match(feedbackText('claude', 'unknown', 'hmm'), /no explicit verdict[\s\S]*hmm/)
  assert.match(feedbackText('claude', 'changes', '  '), /\(no comments\)/)
})
