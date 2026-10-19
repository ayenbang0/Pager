import assert from 'node:assert/strict'
import path from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../chat/db.js'
import { identityLockState, loadOrCreateIdentity, lockIdentity } from '../chat/identity.js'
import { deriveSecrets } from '../chat/secrets.js'
import { removeTmpDirs, tmpDir } from '../testing/testutil.js'
import { runLock, runUnlock, type LockIo } from './lockCommand.js'

const io = (answers: string[]): LockIo & { lines: string[] } => {
  const lines: string[] = []
  return { lines, ask: async () => answers.shift() ?? '', out: (l) => void lines.push(l) }
}

const A = 'a'.repeat(64)
const G = 'grp:' + '1'.repeat(32)

function seed(dir: string): void {
  loadOrCreateIdentity(dir)
  const s = new Store(path.join(dir, 'pager.db'))
  s.upsertConv({ id: G, kind: 'group', title: 'team', creator: A, peer: null, state: 'active', readAt: 0, createdAt: 1 })
  s.insertEvent({ conv: G, author: A, seq: 1, ts: 1, kind: 'text', body: 'hello world', sig: 'f'.repeat(128) }, 1)
  s.close()
}

const body = (dir: string): string => {
  const raw = new DatabaseSync(path.join(dir, 'pager.db'))
  try {
    return String(raw.prepare('SELECT body FROM events').get()?.body)
  } finally {
    raw.close()
  }
}

test('lock encrypts, re-lock changes the passphrase, unlock restores plaintext', async () => {
  const dir = tmpDir('pager-lock-')
  seed(dir)
  const pk = loadOrCreateIdentity(dir).pk
  const a = io(['correct-horse', 'correct-horse'])
  assert.equal(await runLock(dir, {}, a), 0)
  assert.match(a.lines.at(-1)!, /^Encrypted\./)
  assert.match(body(dir), /^pgrenc1:/)
  assert.equal(identityLockState(dir).locked, true)

  const b = io(['battery-staple', 'battery-staple'])
  assert.equal(await runLock(dir, { PAGER_PASSPHRASE: 'correct-horse' }, b), 0)
  assert.match(body(dir), /^pgrenc1:/)

  const wrong = io(['nope-nope-1', 'nope-nope-2', 'nope-nope-3'])
  assert.equal(await runUnlock(dir, {}, wrong), 1)
  assert.equal(wrong.lines.filter((l) => l === 'Wrong passphrase.').length, 3)

  const c = io([])
  assert.equal(await runUnlock(dir, { PAGER_PASSPHRASE: 'battery-staple' }, c), 0)
  assert.deepEqual(c.lines, ['Decrypted.'])
  assert.equal(body(dir), 'hello world')
  assert.equal(loadOrCreateIdentity(dir).pk, pk)
  assert.equal(await runUnlock(dir, {}, io([])), 0)
})

test('lock refuses short or mismatched passphrases and changes nothing', async () => {
  const dir = tmpDir('pager-lock-')
  seed(dir)
  assert.equal(await runLock(dir, {}, io(['short', 'short'])), 1)
  assert.equal(await runLock(dir, {}, io(['long-enough-1', 'long-enough-2'])), 1)
  assert.equal(body(dir), 'hello world')
  assert.equal(identityLockState(dir).locked, false)
})

test('an interrupted lock (identity locked, database still plain) still opens and a re-run finishes it', async () => {
  const dir = tmpDir('pager-lock-')
  seed(dir)
  const pk = loadOrCreateIdentity(dir).pk
  const salt = Buffer.alloc(16, 1)
  const secrets = deriveSecrets('correct-horse', salt)
  lockIdentity(dir, secrets, salt)
  assert.equal(loadOrCreateIdentity(dir, secrets).pk, pk)
  const half = new Store(path.join(dir, 'pager.db'), secrets.dbKey)
  assert.equal(half.listMessages(G, 5)[0]?.body, 'hello world')
  half.close()
  assert.equal(await runLock(dir, { PAGER_PASSPHRASE: 'correct-horse' }, io(['battery-staple', 'battery-staple'])), 0)
  assert.match(body(dir), /^pgrenc1:/)
  assert.equal(await runUnlock(dir, { PAGER_PASSPHRASE: 'battery-staple' }, io([])), 0)
  assert.equal(body(dir), 'hello world')
})

after(removeTmpDirs)
