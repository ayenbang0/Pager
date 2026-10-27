'use strict'
// Main-process handler of the Home block: the few facts the renderer cannot know by itself. It reads exactly one file
// (CHANGELOG.md, next to the packed app or at the repository root when run from source), capped in size, and never
// takes a path from the window.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_CHANGELOG = 96 * 1024

/** Packed: resources/app/electron/blocks -> resources/app/pager/CHANGELOG.md. Source: desktop/electron/blocks -> ./CHANGELOG.md. */
const CHANGELOGS = [path.join(__dirname, '..', '..', 'pager', 'CHANGELOG.md'), path.join(__dirname, '..', '..', '..', 'CHANGELOG.md')]

function changelog() {
  for (const file of CHANGELOGS) {
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(MAX_CHANGELOG)
        const n = fs.readSync(fd, buf, 0, MAX_CHANGELOG, 0)
        return buf.toString('utf8', 0, n)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // try the next place
    }
  }
  return ''
}

function userName() {
  try {
    return os.userInfo().username || ''
  } catch {
    return process.env.USERNAME || process.env.USER || ''
  }
}

const methods = {
  /** { user, home, platform, changelog } */
  async info() {
    return { user: userName(), home: os.homedir(), platform: process.platform, changelog: changelog() }
  },
}

module.exports = { methods, _t: { CHANGELOGS, changelog } }
