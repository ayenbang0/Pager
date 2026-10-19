import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Suggester } from './suggest.js'

function taught(lines: string[]): Suggester {
  const s = new Suggester()
  for (const l of lines) s.learn(l)
  return s
}

test('completes a whole earlier line, preferring the one used most', () => {
  const s = taught(['see you tomorrow', 'see you soon', 'see you soon'])
  assert.equal(s.complete('see you t'), 'omorrow')
  assert.equal(s.complete('see you s'), 'oon')
})

test('with no matching line it completes the word from the user vocabulary and runs on with their usual next words', () => {
  const s = taught(['deploy the staging build now', 'deploy the staging build later', 'deploy the staging build now'])
  assert.equal(s.complete('please depl'), 'oy the staging build')
  assert.equal(s.complete('and the stag'), 'ing build now')
})

test('predicts the next word after a space, only from a repeated habit', () => {
  const s = taught(['good morning team', 'good morning all', 'good evening'])
  assert.equal(s.complete('hello good '), 'morning')
  assert.equal(s.complete('hello good e'), 'vening')
})

test('a word seen once is not suggested, and punctuation or empty input gives nothing', () => {
  const s = taught(['a quokka', 'ok'])
  assert.equal(s.complete('quo'), '')
  assert.equal(s.complete('a quokka,'), '')
  assert.equal(s.complete(''), '')
})

test('commands complete as whole lines only and keep their words out of chat suggestions', () => {
  const s = taught(['/agent omp fix the build', '/agent omp fix the build'])
  assert.equal(s.complete('/agent omp f'), 'ix the build')
  assert.equal(s.complete('the bu'), '')
  const shell = new Suggester()
  shell.learn('git status --short', false)
  assert.equal(shell.complete('git s'), 'tatus --short')
  assert.equal(shell.complete('hi sta'), '')
})

test('keeps the capitalisation the user last used', () => {
  const s = taught(['ping Alexandria', 'ask Alexandria'])
  assert.equal(s.complete('hi Alex'), 'andria')
})
