// Child process of the bundled node: owns one SQLite connection (see database-engine.mjs) and answers requests from
// database.cjs over the IPC channel. Requests: { id, method, args }. Replies: { id, ok: true, result } or
// { id, ok: false, error: { code, message } }. SQL runs synchronously here, so Electron's main thread never waits on it.
import { Engine, METHODS } from './database-engine.mjs'

const engine = new Engine()

process.on('message', (msg) => {
  const { id, method, args } = msg || {}
  let reply
  try {
    if (!METHODS.has(method)) throw Object.assign(new Error(`Unknown method ${method}.`), { code: 'BAD_METHOD' })
    reply = { id, ok: true, result: engine[method](args) }
  } catch (e) {
    reply = { id, ok: false, error: { code: e?.code ?? 'ERROR', message: e?.message ?? String(e), errcode: e?.errcode } }
  }
  process.send(reply)
})

process.on('disconnect', () => {
  engine.close()
  process.exit(0)
})
process.send({ ready: true })
