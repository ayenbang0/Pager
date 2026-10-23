'use strict'
// Builds a throwaway repository for the git block's harness and tests: branches, a merge, tags, a remote that is one
// commit behind, and a working tree with staged, unstaged and untracked changes. Never touches any other repository.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PEOPLE = {
  AL: ['Ada Lovelace', 'ada@example.com'],
  TE: ['Tess Ellery', 'tess@example.com'],
  GH: ['Grace Hopper', 'grace@example.com'],
  AT: ['Alan Turing', 'alan@example.com'],
}

const LIB = [
  '//! orbit: a tiny commit-graph library.',
  '',
  'pub struct Place {',
  '    pub lane: usize,',
  '    pub row: usize,',
  '}',
  '',
  'pub fn layout(commits: &[Commit]) -> Vec<Place> {',
  '    let mut lanes: Vec<Option<String>> = Vec::new();',
  '    let mut out = Vec::with_capacity(commits.len());',
  '    for (row, c) in commits.iter().enumerate() {',
  '        let lane = lanes.iter().position(|l| l.as_deref() == Some(&c.id)).unwrap_or(lanes.len());',
  '        if lane == lanes.len() {',
  '            lanes.push(None);',
  '        }',
  '        lanes[lane] = c.parents.first().cloned();',
  '        out.push(Place { lane, row });',
  '    }',
  '    out',
  '}',
  '',
  'pub fn search<\'a>(commits: &\'a [Commit], query: &str) -> Vec<&\'a Commit> {',
  '    let q = query.to_lowercase();',
  '    commits.iter().filter(|c| c.subject.to_lowercase().contains(&q)).collect()',
  '}',
  '',
  'pub struct Commit {',
  '    pub id: String,',
  '    pub parents: Vec<String>,',
  '    pub subject: String,',
  '}',
  '',
  'pub fn color(lane: usize) -> usize {',
  '    lane % 8',
  '}',
  '',
  'pub fn width(places: &[Place]) -> usize {',
  '    places.iter().map(|p| p.lane + 1).max().unwrap_or(0)',
  '}',
  '',
].join('\n')

function makeFixture(base) {
  const dir = base || fs.mkdtempSync(path.join(os.tmpdir(), 'pager-git-fixture-'))
  const repo = path.join(dir, 'orbit')
  const origin = path.join(dir, 'origin.git')
  fs.mkdirSync(repo, { recursive: true })
  let tick = Date.parse('2025-03-01T09:00:00Z') / 1000
  const g = (args, who, input) => {
    tick += 1800
    const p = PEOPLE[who || 'AL']
    const date = `${tick} +0000`
    return execFileSync('git', args, {
      cwd: repo,
      input,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_NAME: p[0], GIT_AUTHOR_EMAIL: p[1], GIT_COMMITTER_NAME: p[0], GIT_COMMITTER_EMAIL: p[1], GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_EDITOR: 'true' },
    })
  }
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text)
  }
  const commit = (who, subject, files) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text)
    g(['add', '-A'], who)
    g(['commit', '-q', '-m', subject], who)
  }

  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.name', 'Fixture'])
  g(['config', 'user.email', 'fixture@example.com'])
  g(['config', 'core.autocrlf', 'false'])
  commit('AL', 'Start orbit, a tiny commit-graph library', { 'src/lib.rs': LIB, 'README.md': '# orbit\n\nA tiny commit-graph library.\n', 'Cargo.toml': '[package]\nname = "orbit"\nversion = "0.1.0"\n' })
  commit('GH', 'Lay out commits in lanes', { 'src/layout.rs': 'pub const LANES: usize = 8;\n' })
  commit('AL', 'Search commit subjects', { 'src/search.rs': 'pub fn find() {}\n' })
  g(['tag', '-a', 'v0.1.0', '-m', 'First release'])
  g(['checkout', '-q', '-b', 'feature/lanes'])
  commit('AT', 'Color lanes by branch', { 'src/color.rs': 'pub fn color(lane: usize) -> usize { lane % 8 }\n' })
  commit('AT', 'Cache lane colors between frames', { 'src/color.rs': 'pub fn color(lane: usize) -> usize { lane % 8 }\n// cached\n' })
  g(['checkout', '-q', 'main'])
  commit('GH', 'Fix case-insensitive search of subjects', { 'src/search.rs': 'pub fn find() { /* lowercased */ }\n' })
  g(['merge', '--no-ff', '-q', '-m', "Merge branch 'feature/lanes'", 'feature/lanes'], 'TE')
  commit('AL', 'Document the search syntax', { 'README.md': '# orbit\n\nA tiny commit-graph library.\n\n## Search\n\nType part of a subject.\n' })
  commit('GH', 'Speed up layout for deep histories', { 'src/layout.rs': 'pub const LANES: usize = 8;\npub const FAST: bool = true;\n' })
  g(['checkout', '-q', '-b', 'fix/long-subjects'])
  commit('AT', 'Wrap long subjects in the detail pane', { 'src/detail.rs': 'pub fn wrap() {}\n' })
  g(['checkout', '-q', 'main'])
  commit('AL', 'Explain lane colors', { 'docs/colors.md': '# Lane colors\n\nEach lane cycles through eight colors.\n' })
  g(['tag', 'nightly'])
  // A bare remote that has everything so far; main then moves one commit ahead.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true })
  g(['remote', 'add', 'origin', origin])
  g(['push', '-q', '-u', 'origin', 'main'])
  g(['push', '-q', 'origin', 'feature/lanes'])
  commit('TE', 'feat(lib): re-exported layout and Place', { 'src/mod.rs': 'pub use crate::lib::{layout, Place};\n' })

  // Working tree: one staged file, unstaged edits to lib.rs (two far-apart hunks, one with a deletion), an untracked file.
  write('docs/notes.md', '# Notes\n\n- first idea\n- second idea\n')
  g(['add', 'docs/notes.md'])
  const lines = LIB.split('\n')
  lines[0] = '//! orbit: a tiny commit-graph library (lane layout and search).'
  lines.splice(3, 0, '    // Column of the commit node.')
  lines[16] = '        out.push(Place { lane, row }); // one place per commit'
  lines.splice(19, 1)
  lines.splice(35, 0, '', 'pub fn colors() -> usize {', '    8', '}')
  write('src/lib.rs', lines.join('\n'))
  write('TODO.txt', 'ship it\n')
  return { dir, repo, origin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

module.exports = { makeFixture, LIB }
