// attachSurface(term, opts): teach one xterm.js Terminal the Pager surface protocol (see protocol.js).
//
// The OSC 7777 handler decodes and validates the payload, registers a marker on the cursor's line and an xterm decoration
// `rows` tall from that line down. The decoration is a DOM overlay xterm keeps positioned on the marked line, so the block
// scrolls with the scrollback, reflows (the marker follows its line) and goes away with it (trimmed, cleared, reset).
// The emitter prints `rows` line feeds after the sequence, so those lines are blank and nothing is drawn under the block.
//
// opts: {
//   openBlock?(name, args): ask the shell to open a block pane (the "open in pane" button; needs the `surface` block registered),
//   openInPane?(msg): override of the above,
//   onError?(message): a refused payload (bad base64, over the size cap, unknown kind ...),
// }
import { decodeOsc, MAX_BLOCKS, OSC_CODE, rowsOf } from './protocol.js'
import { mountSurface } from './render.js'
import { stashSurface } from './stash.js'

export function attachSurface(term, opts = {}) {
  /** id -> { msg, deco, marker, view } in arrival order (Map keeps insertion order) */
  const blocks = new Map()
  const onError = opts.onError || (() => {})
  const openInPane = opts.openInPane || (opts.openBlock ? (msg) => opts.openBlock('surface', { stash: stashSurface(msg) }) : undefined)

  const drop = (id) => {
    const e = blocks.get(id)
    if (!e) return
    blocks.delete(id)
    if (e.view) e.view.dispose()
    e.deco.dispose()
    e.marker.dispose()
  }

  const place = (msg) => {
    drop(msg.id) // the same id again replaces the earlier block
    while (blocks.size >= MAX_BLOCKS) drop(blocks.keys().next().value)
    const marker = term.registerMarker(0)
    if (!marker) return
    const deco = term.registerDecoration({ marker, x: 0, width: term.cols, height: rowsOf(msg), layer: 'top' })
    if (!deco) {
      marker.dispose()
      return
    }
    const entry = { msg, deco, marker, view: null }
    blocks.set(msg.id, entry)
    deco.onRender((el) => {
      if (!entry.view) {
        el.classList.add('pgs-slot')
        // keep clicks inside the block from starting a terminal selection or being reported to the program
        for (const t of ['mousedown', 'mouseup', 'dblclick', 'contextmenu']) el.addEventListener(t, (ev) => ev.stopPropagation())
        entry.view = mountSurface(el, msg, { openInPane })
      }
    })
    deco.onDispose(() => {
      if (blocks.get(msg.id) === entry) blocks.delete(msg.id)
      if (entry.view) entry.view.dispose()
      entry.marker.dispose()
    })
  }

  const handler = term.parser.registerOscHandler(OSC_CODE, (data) => {
    const r = decodeOsc(data)
    if (r === null) return false // some other 7777 sub-protocol
    if (!r.ok) {
      onError(r.error)
      return true
    }
    if (term.buffer.active.type === 'alternate') return true // full-screen programs own the whole screen
    place(r.msg)
    return true
  })

  return {
    count: () => blocks.size,
    ids: () => [...blocks.keys()],
    dispose() {
      handler.dispose()
      for (const id of [...blocks.keys()]) drop(id)
    },
  }
}
