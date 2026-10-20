import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, test } from 'node:test'
import { removeTmpDirs, tmpDir } from '../../testing/testutil.js'
import { loadCustomThemes, saveCustomTheme, themesFile } from './customThemes.js'
import { allThemes, findTheme, resolveTheme, THEMES, withAccent } from './themes.js'

after(() => {
  loadCustomThemes(tmpDir('pager-th-'))
  removeTmpDirs()
})

test('themes.json adds themes on a base, as written, flat when asked; broken entries are named and skipped', () => {
  const dir = tmpDir('pager-th-')
  const themes = [
    { name: 'Mine', base: 'nord', accent: '#ff0000', surface: 'black', flat: true },
    { name: 'glow', gradient: ['#111111', '#eeeeee'], authors: ['#ff0000'] },
    { name: 'omp' },
    { name: 'bad', accent: 'not-a-color', base: 'nope' },
  ]
  fs.writeFileSync(themesFile(dir), JSON.stringify({ themes }))
  const problems = loadCustomThemes(dir)
  assert.equal(problems.length, 3, problems.join('\n'))
  assert.match(problems.join('\n'), /skipped bad: bad base, accent/)
  const mine = findTheme('mine')
  assert.ok(mine)
  assert.deepEqual([mine.accent, mine.surface, mine.text, mine.gradient], ['#ff0000', 'black', findTheme('nord')?.text, ['#ff0000', '#ff0000']])
  assert.deepEqual(withAccent(mine, '#00ff00').gradient, ['#00ff00', '#00ff00'], 'an accent keeps a flat theme flat')
  assert.equal(resolveTheme('mine', undefined, 24).name, 'mine')
  assert.equal(allThemes().length, THEMES.length + 1)
})

test('saving the current theme writes every token, refuses duplicates, and loads back', () => {
  const dir = tmpDir('pager-th-')
  const nord = findTheme('nord')
  assert.ok(nord)
  assert.equal(saveCustomTheme(dir, 'calm', nord), undefined)
  assert.match(saveCustomTheme(dir, 'calm', nord) ?? '', /already exists/)
  assert.match(saveCustomTheme(dir, 'Bad Name', nord) ?? '', /2-24 lowercase/)
  assert.deepEqual(loadCustomThemes(dir), [])
  const calm = findTheme('calm')
  assert.deepEqual([calm?.accent, calm?.surface, calm?.gradient], [nord.accent, nord.surface, nord.gradient])
})
