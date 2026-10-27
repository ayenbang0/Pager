// Shared blocks: the renderer's adapter registry plus the RPC/event plumbing (local://chats-contract.md, "Sharing").
//
//   registerShare(blockName, factory)      a block KIND can be shared; factory(ctx) -> adapter (see the contract)
//   registerInstance(id, block, title, modes, adapter)   a MOUNTED block joins the registry; the Chats Share menu
//                                                        offers exactly these (plus agent sessions) and labels the modes
//   shareables() -> [{ instanceId, block, title, modes }]
//   bindDaemonApi(api) / currentDaemon()   the daemon client the RPCs ride on (window.pager.d unless bound otherwise)
//   routeEvents(api?)                      forwards chat_share / chat_share_op to the owning instance's adapter
//   startShare/joinShare/leaveShare/endShare, sendOp, sendPresence, cacheSnapshot
//
// Plumbing owned here per the contract: ops are queued while the snapshot is pending and applied in `ver` order (the
// host numbers every op; guests see ver 0 and apply in arrival order), presence is relayed, a guest rejoins when the
// host comes back (chat_share 'presence'), and the host answers a join_request with a fresh snapshot. Share payloads
// (op, snapshot, args) are opaque strings from peers: parsed defensively, never eval'd, never innerHTML.

/** The daemon client shape share.js needs: { call(type, args) -> Promise, onEvent(fn) -> unsubscribe }. */
let bound = null
export function bindDaemonApi(api) {
  bound = api
  return () => (bound === api ? (bound = null) : undefined)
}
const currentDaemon = () => bound || (typeof window !== 'undefined' && window.pager?.d ? window.pager.d : null)
const call = (api, type, args) => {
  const d = api || currentDaemon()
  if (!d || typeof d.call !== 'function') return Promise.reject(new Error('share: no daemon connection'))
  return d.call(type, args)
}

// ---------------------------------------------------------------------------------------------------- registries
const factories = new Map() // block name -> factory(ctx) -> adapter
const instances = new Map() // instanceId -> { instanceId, block, title, modes, adapter, api }
const byShare = new Map() // shareId -> { inst, host, pending, queue, buf, lastVer, hostOnline }

let mePk = ''
/** My public key, so a relayed echo of my own op is marked mine (adapters may ignore it). */
export const setMe = (pk) => (mePk = String(pk || ''))
export const myPk = () => mePk

/** Register what a block kind can do. Returns an unregister function. */
export function registerShare(blockName, factory) {
  factories.set(blockName, factory)
  return () => factories.delete(blockName)
}
export const adapterFor = (blockName) => factories.get(blockName) || null

/**
 * A mounted block instance with an adapter. modes: 'live'|'readonly'|'snapshot' (what the block can really do).
 * The adapter's onLocalOp / presence.local are wired to the transport here; unregistering unwires them.
 */
export function registerInstance(instanceId, block, title, modes, adapter, api) {
  if (!instanceId || !block || !adapter) return () => {}
  const rec = { instanceId, block, title: title || block, modes: [...(modes || ['live'])], adapter, api }
  instances.set(instanceId, rec)
  const uns = []
  if (typeof adapter.onLocalOp === 'function') uns.push(adapter.onLocalOp((op) => { for (const shareId of sharesOf(instanceId)) void sendOp(api, shareId, op) }))
  if (adapter.presence && typeof adapter.presence.local === 'function') uns.push(adapter.presence.local((d) => { for (const shareId of sharesOf(instanceId)) void sendPresence(api, shareId, d) }))
  return () => {
    for (const u of uns) u()
    for (const shareId of sharesOf(instanceId)) byShare.delete(shareId)
    instances.delete(instanceId)
  }
}
export function unregisterInstance(instanceId) {
  const rec = instances.get(instanceId)
  if (!rec) return
  for (const shareId of sharesOf(instanceId)) byShare.delete(shareId)
  instances.delete(instanceId)
}

/** Mounted instances with an adapter, for the Chats Share menu. */
export const shareables = () => [...instances.values()].map(({ instanceId, block, title, modes }) => ({ instanceId, block, title, modes }))

/** Block kinds that have an adapter AND the daemon can carry (caps.share.blocks). */
export function blocksFor(caps) {
  const carried = new Set(caps?.share?.blocks || [])
  return [...factories.keys()].filter((b) => carried.has(b))
}

const sharesOf = (instanceId) => {
  const out = []
  for (const [shareId, r] of byShare) if (r.inst === instanceId) out.push(shareId)
  return out
}

// ---------------------------------------------------------------------------------------------------- transport
/** Host: offer a block into a chat. opts: { chatId, block, title?, mode?, args?, snapshot?, instanceId? }. */
export async function startShare(api, opts) {
  const r = await call(api, 'chats.share.start', opts)
  if (r?.share) track(opts.instanceId || null, r.share, true, !!opts.snapshot)
  return r
}

/** Guest: join a share. The snapshot may arrive later as a chat_share_op{type:'snapshot'}; ops queue until then. */
export async function joinShare(api, shareId, instanceId = null) {
  const r = await call(api, 'chats.share.join', { shareId })
  const share = r?.share || { shareId }
  track(instanceId, share, false, false)
  const rec = byShare.get(shareId)
  const ad = adapterOf(rec)
  if (r?.snapshot) {
    ad?.applySnapshot?.(tryJson(r.snapshot.d ?? r.snapshot))
    if (rec) rec.pending = false
  } else if (rec) {
    rec.pending = true // ops queue until the snapshot arrives
  }
  return r
}

export async function leaveShare(api, shareId) {
  const r = await call(api, 'chats.share.leave', { shareId })
  if (byShare.get(shareId)?.host) return r // hosting: leave = end, the card stays as ended
  byShare.delete(shareId)
  return r
}
export async function endShare(api, shareId) {
  const r = await call(api, 'chats.share.end', { shareId })
  byShare.delete(shareId)
  return r
}

/** Send one operation (apply it locally first, then send — the caller's block already did the local apply). */
export const sendOp = (api, shareId, op) => call(api, 'chats.share.op', { shareId, op: typeof op === 'string' ? op : JSON.stringify(op) })
/** Cursors/selection; relayed, never stored. */
export const sendPresence = (api, shareId, d) => call(api, 'chats.share.presence', { shareId, d: JSON.stringify(d ?? {}) })
/** Host: cache the current state for late joiners. */
export const cacheSnapshot = (api, shareId, d, ver) => call(api, 'chats.share.snapshot', { shareId, d: typeof d === 'string' ? d : JSON.stringify(d), ver })

function track(instanceId, share, host, snapshotKnown) {
  if (!share?.shareId) return null
  const rec = { inst: instanceId, host, pending: !snapshotKnown, queue: [], buf: [], lastVer: 0, hostOnline: share.hostOnline !== false }
  byShare.set(share.shareId, rec)
  return rec
}
const adapterOf = (rec) => (rec?.inst ? instances.get(rec.inst)?.adapter : null)

/** Subscribe the chat events and route share frames to the owning instance's adapter. Returns an unsubscribe. */
export function routeEvents(api) {
  const d = api || currentDaemon()
  if (!d || typeof d.onEvent !== 'function') return () => {}
  return d.onEvent((ev) => {
    if (!ev) return
    if (ev.event === 'chat_share_op') return onOp(ev)
    if (ev.event === 'chat_share') return onShare(ev)
  })
}

// ---------------------------------------------------------------------------------------------------- event routing
function tryJson(s) {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {
    return s // opaque text stays text; the adapter decides what it is
  }
}

function onOp(ev) {
  const rec = byShare.get(ev.shareId)
  if (!rec) return
  const ad = adapterOf(rec)
  if (!ad) return
  const meta = { from: ev.from, ver: ev.ver ?? 0, mine: ev.from === mePk }
  const d = tryJson(ev.op)
  if (ev.type === 'snapshot') {
    ad.applySnapshot?.(d)
    rec.pending = false
    drain(rec, ad)
  } else if (ev.type === 'op') {
    if (rec.pending) rec.queue.push({ ver: ev.ver ?? 0, op: d, meta })
    else apply(ad, rec, d, meta)
  } else if (ev.type === 'presence') {
    ad.presence?.remote?.({ pk: ev.from, name: ev.fromName || '', hue: 0 }, d)
  } else if (ev.type === 'join_request') {
    if (rec.host) void answerJoin(rec, ev.from)
  }
}

function onShare(ev) {
  const s = ev.share
  if (!s?.shareId) return
  const rec = byShare.get(s.shareId)
  if (ev.kind === 'ended') {
    if (rec) byShare.delete(s.shareId)
    return
  }
  if (ev.kind === 'presence') {
    if (!rec) return
    const was = rec.hostOnline
    rec.hostOnline = s.hostOnline !== false
    if (!was && rec.hostOnline && !rec.host) rejoin(s.shareId) // the host is back: rejoin and take a fresh snapshot
  }
}

/** Ver-ordered application; guests (ver 0) apply in arrival order. */
function apply(ad, rec, op, meta) {
  if (!meta.ver) return ad.applyOp?.(op, meta)
  if (meta.ver <= rec.lastVer) return // an old op (or my own echo) never re-applies
  rec.buf.push({ ver: meta.ver, op, meta })
  rec.buf.sort((a, b) => a.ver - b.ver)
  while (rec.buf.length && rec.buf[0].ver === rec.lastVer + 1) {
    const x = rec.buf.shift()
    rec.lastVer = x.ver
    ad.applyOp?.(x.op, x.meta)
  }
}

/** Ops that arrived while the snapshot was pending, applied once it landed. */
function drain(rec, ad) {
  const q = rec.queue
  rec.queue = []
  for (const x of q) apply(ad, rec, x.op, x.meta)
}

async function answerJoin(rec, to) {
  const ad = adapterOf(rec)
  if (typeof ad?.snapshot !== 'function') return
  let d
  try {
    d = ad.snapshot()
  } catch {
    return
  }
  await call(null, 'chats.share.snapshot', { shareId: shareOfRec(rec), d: JSON.stringify(d), to })
}
const shareOfRec = (rec) => {
  for (const [id, r] of byShare) if (r === rec) return id
  return ''
}

async function rejoin(shareId) {
  const rec = byShare.get(shareId)
  if (!rec || rec.host) return
  const ad = adapterOf(rec)
  rec.pending = true // queue ops until the fresh snapshot lands
  try {
    const r = await call(null, 'chats.share.join', { shareId })
    if (r?.snapshot) {
      ad?.applySnapshot?.(tryJson(r.snapshot.d ?? r.snapshot))
      rec.pending = false
      drain(rec, ad)
    }
  } catch {
    rec.pending = false
  }
}
