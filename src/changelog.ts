import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface ChangelogSection {
  version: string
  date: string | null
  entries: ChangelogEntry[]
}

export type ChangelogKind = 'Added' | 'Changed' | 'Fixed' | 'Removed' | 'Deprecated' | 'Security'

export interface ChangelogEntry {
  kind: ChangelogKind
  text: string
}

export const CHANGELOG_KINDS: readonly ChangelogKind[] = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security']

const SECTION_RE = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/i
const ENTRY_BOLD_RE = /^[-*]\s+\*\*(.+?)\*\*:\s*(.+)$/
const ENTRY_PLAIN_RE = /^[-*]\s+(.+)$/

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function isNewer(current: string, than: string | null): boolean {
  return than === null || compareVersions(current, than) > 0
}

export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let current: ChangelogSection | null = null
  let currentKind: ChangelogKind | null = null

  for (const line of text.split('\n')) {
    const heading = SECTION_RE.exec(line)
    if (heading) {
      current = { version: heading[1] ?? '0.0.0', date: heading[2] ?? null, entries: [] }
      sections.push(current)
      currentKind = null
      continue
    }
    if (!current) continue

    const kind = /^###\s+(Added|Changed|Fixed|Removed|Deprecated|Security)\s*$/i.exec(line)
    if (kind) {
      const raw = (kind[1] ?? '').toLowerCase()
      const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1)
      if ((CHANGELOG_KINDS as readonly string[]).includes(capitalized)) {
        currentKind = capitalized as ChangelogKind
      }
      continue
    }

    const bold = ENTRY_BOLD_RE.exec(line)
    if (bold && currentKind) {
      current.entries.push({ kind: currentKind, text: bold[2] ?? '' })
      continue
    }

    const plain = ENTRY_PLAIN_RE.exec(line)
    if (plain && currentKind) {
      const text = (plain[1] ?? '').trim()
      if (text !== '') current.entries.push({ kind: currentKind, text })
    }
  }

  return sections
}

export function getChangesSince(sections: readonly ChangelogSection[], sinceVersion: string): ChangelogSection[] {
  return sections.filter((s) => compareVersions(s.version, sinceVersion) > 0)
}

export function latestVersion(sections: readonly ChangelogSection[]): string | null {
  return sections[0]?.version ?? null
}

function stringWidth(s: string): number {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch) ? 2 : 1
  return n
}

function wrapText(text: string, width: number): string[] {
  if (stringWidth(text) <= width) return [text]
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line === '') line = word
    else if (stringWidth(line) + 1 + stringWidth(word) <= width) line += ' ' + word
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  return out.length > 0 ? out : ['']
}

export function formatSection(section: ChangelogSection, width: number): string[] {
  const head = section.version + (section.date !== null ? ` (${section.date})` : '')
  const out: string[] = [head, '-'.repeat(Math.min(width, head.length))]
  for (const kind of CHANGELOG_KINDS) {
    const entries = section.entries.filter((e) => e.kind === kind)
    if (entries.length === 0) continue
    out.push('', `${kind}:`)
    for (const entry of entries) {
      const indent = '  '
      for (const line of wrapText(entry.text, Math.max(10, width - indent.length))) out.push(indent + line)
    }
  }
  return out
}

export function formatChangelog(sections: readonly ChangelogSection[], width: number, maxSections = 3): string[] {
  const out: string[] = []
  for (const section of sections.slice(0, maxSections)) {
    if (out.length > 0) out.push('', '')
    out.push(...formatSection(section, width))
  }
  return out
}

export function loadChangelog(): ChangelogSection[] {
  try {
    return parseChangelog(fs.readFileSync(require.resolve('../../CHANGELOG.md'), 'utf8'))
  } catch {
    return []
  }
}
