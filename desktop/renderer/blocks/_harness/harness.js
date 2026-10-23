// Mounts one block in a plain page with the contract's ctx, talking to _harness/serve.cjs (real main-process handlers)
// or, for blocks that need Electron (screen), to an in-page mock passed as `rpc`.
const params = new URLSearchParams(location.search)

export async function boot(name, { rpc, args = {}, width, height, ctx: extra } = {}) {
  const theme = params.get('theme') || 'dark'
  document.documentElement.dataset.theme = theme
  const config = await fetch('/config').then((r) => r.json()).catch(() => ({}))
  const host = document.getElementById('host')
  if (width) host.style.width = width + 'px'
  if (height) host.style.height = height + 'px'
  const toasts = document.getElementById('toasts')
  const listeners = new Set()
  const ctx = {
    rpc:
      rpc ||
      (async (method, a) => {
        const r = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager-harness': '1' }, body: JSON.stringify({ block: name, method, args: a }) })
        const j = await r.json()
        if (j.error) throw new Error(j.error)
        return j.result
      }),
    onEvent(fn) {
      if (rpc) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
      const es = new EventSource('/events?block=' + name)
      es.onmessage = (m) => {
        const { event, payload } = JSON.parse(m.data)
        fn(event, payload)
      }
      return () => es.close()
    },
    emit: (event, payload) => listeners.forEach((fn) => fn(event, payload)),
    theme: getComputedStyle(document.documentElement),
    cwd: params.get('cwd') || config.boardDir,
    args,
    setTitle: (t) => (document.title = t + ' · harness'),
    close() {},
    openBlock() {},
    openPath() {},
    toast(level, text) {
      const t = document.createElement('div')
      t.className = 'toast ' + level
      t.textContent = text
      toasts.append(t)
      setTimeout(() => t.remove(), 4000)
    },
  }
  Object.assign(ctx, extra)
  const mod = (await import(`../${name}.js`)).default
  const api = mod.mount(host, ctx)
  window.__block = { api, ctx }
  return api
}
