import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHANGELOG_KINDS, compareVersions, formatChangelog, getChangesSince, isNewer, latestVersion, loadChangelog, parseChangelog } from './changelog.js'
import { VERSION } from './version.js'

const SAMPLE = `# Changelog

## [1.2.1] - 2026-10-17

### Added

- **Peer-to-peer group chat**: with CRDT-based shared documents
- Agent orchestration: run multiple coding agents

### Changed

- Rebuilt UI with ink 8

## [1.1.0] - 2026-09-01

### Added

- Agent system with ACP support

### Fixed

- Direct message delivery reliability

## [1.0.0]

### Added

- Initial release
`

test('parseChangelog extracts versions, dates, sections, and entries', () => {
  const sections = parseChangelog(SAMPLE)
  assert.equal(sections.length, 3)
  assert.deepEqual(
    sections.map((s) => s.version),
    ['1.2.1', '1.1.0', '1.0.0'],
  )
  assert.equal(sections[0]?.date, '2026-10-17')
  assert.equal(sections[1]?.date, '2026-09-01')
  assert.equal(sections[2]?.date, null)

  const first = sections[0]
  assert.ok(first)
  const added = first.entries.filter((e) => e.kind === 'Added')
  assert.equal(added.length, 2)
  assert.match(added[0]?.text ?? '', /^with CRDT-based shared documents/)
  const changed = first.entries.filter((e) => e.kind === 'Changed')
  assert.equal(changed.length, 1)
  assert.match(changed[0]?.text ?? '', /^Rebuilt UI/)
})

test('parseChangelog handles plain dash entries without bold prefix', () => {
  const text = '## [2.0.0]\n\n### Fixed\n\n- Something broke\n- **Other thing**: was fixed\n'
  const sections = parseChangelog(text)
  assert.equal(sections.length, 1)
  const fixed = sections[0]?.entries.filter((e) => e.kind === 'Fixed')
  assert.equal(fixed?.length, 2)
  assert.equal(fixed?.[0]?.text, 'Something broke')
  assert.equal(fixed?.[1]?.text, 'was fixed')
})

test('compareVersions orders semver correctly', () => {
  assert.equal(compareVersions('1.2.1', '1.2.1'), 0)
  assert.ok(compareVersions('1.2.1', '1.2.0') > 0)
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0)
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0)
})

test('isNewer treats null as older than everything', () => {
  assert.equal(isNewer('1.0.0', null), true)
  assert.equal(isNewer('1.0.0', '1.0.0'), false)
  assert.equal(isNewer('1.0.0', '1.0.1'), false)
  assert.equal(isNewer('1.1.0', '1.0.9'), true)
})

test('getChangesSince returns only sections newer than the given version', () => {
  const sections = parseChangelog(SAMPLE)
  const since = getChangesSince(sections, '1.1.0')
  assert.deepEqual(
    since.map((s) => s.version),
    ['1.2.1'],
  )
  const all = getChangesSince(sections, '0.9.0')
  assert.equal(all.length, 3)
  const none = getChangesSince(sections, '1.2.1')
  assert.equal(none.length, 0)
})

test('latestVersion returns the first section version', () => {
  const sections = parseChangelog(SAMPLE)
  assert.equal(latestVersion(sections), '1.2.1')
  assert.equal(latestVersion([]), null)
})

test('formatChangelog renders version headers, kinds, and wraps text', () => {
  const sections = parseChangelog(SAMPLE)
  const lines = formatChangelog(sections, 60, 2)
  assert.ok(lines[0]?.startsWith('1.2.1'))
  assert.ok(lines.includes('Added:'))
  assert.ok(lines.includes('Changed:'))
  const joined = lines.join('\n')
  assert.ok(joined.includes('with CRDT-based shared documents'))
  assert.ok(joined.includes('Rebuilt UI'))
})

test('formatChangelog respects maxSections', () => {
  const sections = parseChangelog(SAMPLE)
  const lines = formatChangelog(sections, 60, 1)
  assert.ok(lines.join('\n').includes('1.2.1'))
  assert.ok(!lines.join('\n').includes('1.1.0'))
})

test('CHANGELOG_KINDS covers the six standard kinds', () => {
  assert.deepEqual([...CHANGELOG_KINDS], ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'])
})

test('parseChangelog tolerates malformed input', () => {
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog('not a changelog'), [])
  const noEntries = parseChangelog('## [1.0.0]\n\nSome text without sections\n')
  assert.equal(noEntries.length, 1)
  assert.deepEqual(noEntries[0]?.entries, [])
})

test('the real CHANGELOG.md is found from the compiled tree and its newest section is the running version', () => {
  const sections = loadChangelog()
  assert.ok(sections.length >= 4, 'the file was found')
  assert.equal(sections[0]?.version, VERSION)
  assert.ok((sections[0]?.entries.length ?? 0) > 5)
  assert.ok(sections.some((s) => s.version === '1.2.1'))
})

test('CRLF line endings (a Windows checkout) parse the same as LF', () => {
  const lf = parseChangelog(SAMPLE)
  const crlf = parseChangelog(SAMPLE.replace(/\n/g, '\r\n'))
  assert.deepEqual(crlf, lf)
  assert.ok((crlf[0]?.entries.length ?? 0) > 0)
})
