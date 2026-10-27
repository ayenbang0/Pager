import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

// The daemon keeps every terminal alive and is replaced by `pager update`, so it must start without the chat engine's native addons
// (sodium-native, udx): a policy that blocks one .node file would otherwise kill the daemon, and a loaded one cannot be replaced on Windows.
// Chat code reaches them only through the dynamic imports in chats.ts.
// Dynamic imports are the point here: the probe loads the modules in a fresh process under a resolve hook, which a static import in the test cannot do.
const PROBE = `
import { registerHooks } from 'node:module'
const seen = new Set()
registerHooks({ resolve(spec, ctx, next) { seen.add(spec); return next(spec, ctx) } })
for (const m of process.argv.slice(1)) await import(m)
console.log(JSON.stringify([...seen]))
process.exit(0)
`

test('loading the daemon modules resolves no chat-native module', () => {
  const mods = ['./cli.js', './server.js', './chats.js', './chatsHandlers.js', './chatsShares.js'].map((m) => new URL(m, import.meta.url).href)
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, ...mods], { encoding: 'utf8', timeout: 30_000 })
  const seen = JSON.parse(out.trim().split('\n').at(-1)!) as string[]
  assert.ok(seen.length > 20, 'the probe saw the module graph')
  const native = seen.filter((s) => /hypercore-crypto|hyperdht|sodium|udx/.test(s))
  assert.deepEqual(native, [])
})
