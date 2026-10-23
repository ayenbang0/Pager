// Pure unified-diff helpers for the git block: parse one file's diff into hunks/lines, and build a patch that
// applies only the selected hunks or lines with `git apply --cached [-R]`. No DOM, no I/O (see gitpatch.test.mjs).

/**
 * Parses the diff of ONE file.
 * @returns {{ oldPath:string|null, newPath:string|null, isNew:boolean, isDeleted:boolean, binary:boolean,
 *   mode:string|null, hunks: Hunk[] }}
 * Hunk: { header, oldStart, oldLines, newStart, newLines, section, lines: Line[] }
 * Line: { t: ' '|'+'|'-'|'\\', text, oldNo:number|null, newNo:number|null }
 */
export function parseDiff(text) {
  const res = { oldPath: null, newPath: null, isNew: false, isDeleted: false, binary: false, mode: null, hunks: [] }
  if (!text) return res
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let i = 0
  for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
    const l = lines[i]
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l)
      if (m) {
        res.oldPath = m[1]
        res.newPath = m[2]
      }
    } else if (l.startsWith('new file mode ')) {
      res.isNew = true
      res.mode = l.slice(14).trim()
    } else if (l.startsWith('deleted file mode ')) {
      res.isDeleted = true
      res.mode = l.slice(18).trim()
    } else if (l.startsWith('--- ')) {
      if (l.startsWith('--- /dev/null')) res.oldPath = null
      else if (l.startsWith('--- a/')) res.oldPath = l.slice(6)
    } else if (l.startsWith('+++ ')) {
      if (l.startsWith('+++ /dev/null')) res.newPath = null
      else if (l.startsWith('+++ b/')) res.newPath = l.slice(6)
    } else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) {
      res.binary = true
    }
  }
  let cur = null
  let o = 0
  let n = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l)
    if (m) {
      cur = {
        header: l,
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5] ?? '',
        lines: [],
      }
      res.hunks.push(cur)
      o = cur.oldStart
      n = cur.newStart
      continue
    }
    if (!cur) continue
    const c = l[0]
    if (c === '+') cur.lines.push({ t: '+', text: l.slice(1), oldNo: null, newNo: n++ })
    else if (c === '-') cur.lines.push({ t: '-', text: l.slice(1), oldNo: o++, newNo: null })
    else if (c === '\\') cur.lines.push({ t: '\\', text: l.slice(1).trim(), oldNo: null, newNo: null })
    else cur.lines.push({ t: ' ', text: l.slice(1), oldNo: o++, newNo: n++ })
  }
  return res
}

/** Number of changed (+/-) lines in a hunk. */
export const changeCount = (h) => h.lines.reduce((a, l) => a + (l.t === '+' || l.t === '-' ? 1 : 0), 0)

/** Total +/- counts of a parsed diff. */
export function diffStat(d) {
  let add = 0
  let del = 0
  for (const h of d.hunks) for (const l of h.lines) l.t === '+' ? add++ : l.t === '-' && del++
  return { add, del }
}

/**
 * Builds a patch from the chosen parts of a parsed diff.
 *
 * `selection` is an array of `{ hunk: number, lines: number[] | null }`: `lines` are indexes into `hunk.lines`
 * (only +/- lines count), `null` selects the whole hunk. Unselected changes become context (or vanish) so the
 * patch applies cleanly:
 *   forward (stage):    unselected `-` -> context, unselected `+` -> dropped
 *   reverse (unstage):  unselected `+` -> context, unselected `-` -> dropped; apply with `git apply -R`
 * Returns null when nothing selectable remains.
 */
export function buildPatch(diff, selection, { reverse = false } = {}) {
  const byHunk = new Map()
  for (const s of selection) {
    const prev = byHunk.get(s.hunk)
    if (s.lines === null || prev === null) byHunk.set(s.hunk, null)
    else byHunk.set(s.hunk, new Set([...(prev ?? []), ...s.lines]))
  }
  const out = []
  let delta = 0 // new-side shift accumulated by earlier hunks
  let totalPlus = 0
  let totalMinus = 0
  let selPlus = 0
  let selMinus = 0
  for (let hi = 0; hi < diff.hunks.length; hi++) {
    const h = diff.hunks[hi]
    for (const l of h.lines) l.t === '+' ? totalPlus++ : l.t === '-' && totalMinus++
    if (!byHunk.has(hi)) continue
    const pick = byHunk.get(hi)
    const body = []
    let oldLines = 0
    let newLines = 0
    let changed = 0
    let lastKept = false
    for (let li = 0; li < h.lines.length; li++) {
      const l = h.lines[li]
      if (l.t === '\\') {
        if (lastKept) body.push('\\' + (l.text ? ' ' + l.text : ''))
        continue
      }
      if (l.t === ' ') {
        body.push(' ' + l.text)
        oldLines++
        newLines++
        lastKept = true
        continue
      }
      const selected = pick === null || pick.has(li)
      if (selected) {
        body.push(l.t + l.text)
        changed++
        if (l.t === '+') {
          newLines++
          selPlus++
        } else {
          oldLines++
          selMinus++
        }
        lastKept = true
      } else if ((l.t === '-' && !reverse) || (l.t === '+' && reverse)) {
        body.push(' ' + l.text)
        oldLines++
        newLines++
        lastKept = true
      } else lastKept = false
    }
    if (!changed) continue
    const creating = h.oldStart === 0 && oldLines === 0
    const oldStart = creating ? 0 : h.oldStart || 1
    const newStart = creating ? 1 : newLines === 0 ? 0 : oldStart + delta
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${h.section ? ' ' + h.section : ''}`)
    out.push(...body)
    delta += newLines - oldLines
  }
  if (!out.length) return null

  // Header rebuilt without `index` lines. Whether the patch creates/deletes the file depends on direction: staging a
  // new file always creates it (even partially), unstaging a deleted one always re-creates it; any other partial
  // change to a created/deleted file is a plain modification.
  const oldP = diff.oldPath ?? diff.newPath
  const newP = diff.newPath ?? diff.oldPath
  const creation = diff.isNew && (!reverse || selPlus === totalPlus)
  const deletion = diff.isDeleted && (reverse || selMinus === totalMinus)
  const head = [`diff --git a/${oldP} b/${newP}`]
  if (creation) head.push(`new file mode ${diff.mode ?? '100644'}`)
  if (deletion) head.push(`deleted file mode ${diff.mode ?? '100644'}`)
  head.push(creation ? '--- /dev/null' : `--- a/${oldP}`)
  head.push(deletion ? '+++ /dev/null' : `+++ b/${newP}`)
  return head.concat(out).join('\n') + '\n'
}
