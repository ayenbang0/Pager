// Screen block: see and drive THIS machine's displays. Nothing is captured until the user picks a display here;
// driving is a second, explicit, per-session step behind a banner. Sharing a screen with another machine is not part
// of this block.
import { h, fromHTML } from '../ui/dom.js'

const CSS = new URL('./screen.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  screen: svg('<rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.8"/><path d="M5.5 13.6h5M8 11v2.6"/>'),
  eye: svg('<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/>'),
  pointer: svg('<path d="M4 2.5l8 4.2-3.4 1.1L7.4 11.4z"/><path d="M8.8 8.6l2.8 3.6"/>'),
  fit: svg('<path d="M2.5 6V3.5H5M11 3.5h2.5V6M13.5 10v2.5H11M5 12.5H2.5V10"/>'),
  actual: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/><path d="M6 8h4M8 6v4"/>'),
  rec: svg('<circle cx="8" cy="8" r="3.2"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.6"/>'),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  warn: svg('<path d="M8 2.2l6 10.6H2z"/><path d="M8 6.5v3M8 11.3h.01"/>'),
  lock: svg('<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.8"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>'),
}
const ico = (k) => fromHTML(ICONS[k])
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
const clock = (ms) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const eventOf = (a, b) => (typeof a === 'string' ? { name: a, data: b } : { name: a && (a.event || a.name), data: a && (a.payload !== undefined ? a.payload : a.data) })

const ESC_CHORD = 3 // Escape pressed this many times quickly leaves control mode

function mount(el, ctx) {
  const state = {
    sources: null, // picker list
    loading: false,
    session: null, // { sid, source }
    mode: 'view', // view | control
    fit: true,
    live: false, // frames are coming in
    snapshot: false, // fallback capture (no smooth video)
    recording: null, // { rec, chunks, t0 }
    error: null,
    confirm: false,
  }
  let disposed = false
  let stream = null
  let media = null // <video> or <img> showing the display
  let pollTimer = 0
  let recTimer = 0
  let visible = true
  let escTimes = []

  const root = h('div', { class: 'sc' })
  const bar = h('div', { class: 'sc-bar' })
  const banner = h('div', { class: 'sc-banner', hidden: true })
  const stage = h('div', { class: 'sc-stage' })
  const dialog = h('div', { class: 'sc-scrim', hidden: true })
  root.append(bar, banner, stage, dialog)
  el.append(root)

  // ------------------------------------------------------------ rpc
  const call = async (method, a) => {
    try {
      return await ctx.rpc(method, a)
    } catch (e) {
      toast('error', cleanErr(e))
      throw e
    }
  }
  const toast = (level, text) => ctx.toast && ctx.toast(level, text)

  const offEvent = ctx.onEvent
    ? ctx.onEvent((a, b) => {
        const { name, data } = eventOf(a, b)
        if (name === 'mode' && state.session && data && data.sid === state.session.sid && data.mode === 'view' && state.mode === 'control') {
          state.mode = 'view'
          toast('info', data.reason === 'idle' ? 'Control ended after 10 idle minutes.' : 'Control ended.')
          render()
        }
      })
    : null

  // ------------------------------------------------------------ picker
  async function loadSources() {
    state.loading = true
    state.error = null
    render()
    try {
      state.sources = await ctx.rpc('sources', {})
    } catch (e) {
      state.error = cleanErr(e)
    }
    state.loading = false
    render()
  }

  async function choose(src) {
    try {
      const r = await call('select', { sourceId: src.id })
      state.session = r
      state.mode = 'view'
      render()
      await startCapture()
    } catch {
      state.session = null
      render()
    }
  }

  // ------------------------------------------------------------ capture
  async function startCapture() {
    const s = state.session
    if (!s || disposed) return
    stopCapture()
    try {
      stream = ctx.captureStream
        ? await ctx.captureStream(s.source)
        : await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: s.source.id, maxFrameRate: 30 } },
          })
      const v = h('video', { class: 'sc-media', muted: true, playsInline: true, autoplay: true })
      v.srcObject = stream
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (!disposed && state.session) {
          state.live = false
          toast('info', 'The display stopped sharing.')
          render()
        }
      })
      media = v
      state.snapshot = false
      v.addEventListener('loadedmetadata', () => {
        state.live = true
        layoutMedia()
        render()
      })
      await v.play().catch(() => {})
    } catch (e) {
      // Chromium's capture API refused: fall back to stills from the main process (slower, view and drive still work)
      stream = null
      startPolling()
    }
    render()
  }

  function startPolling() {
    const s = state.session
    const img = h('img', { class: 'sc-media', draggable: false })
    media = img
    state.snapshot = true
    const tick = async () => {
      pollTimer = 0
      if (disposed || !visible || !state.session || state.session.sid !== s.sid) return
      const t0 = performance.now()
      try {
        const f = await ctx.rpc('frame', { sid: s.sid, maxWidth: 1600 })
        img.src = f.url
        if (!state.live) {
          state.live = true
          img.addEventListener('load', () => layoutMedia(), { once: true })
          render()
        }
      } catch (e) {
        state.error = cleanErr(e)
        state.live = false
        render()
        return
      }
      pollTimer = setTimeout(tick, Math.max(120, 220 - (performance.now() - t0)))
    }
    tick()
  }

  function stopCapture() {
    clearTimeout(pollTimer)
    pollTimer = 0
    if (state.recording) finishRecording(false)
    if (stream) stream.getTracks().forEach((t) => t.stop())
    stream = null
    if (media && media.srcObject) media.srcObject = null
    media = null
    state.live = false
  }

  const natural = () => (media instanceof HTMLVideoElement ? { w: media.videoWidth, h: media.videoHeight } : media ? { w: media.naturalWidth, h: media.naturalHeight } : { w: 0, h: 0 })

  function layoutMedia() {
    if (!media) return
    const n = natural()
    const wrap = stage.querySelector('.sc-view')
    if (!wrap || !n.w) return
    wrap.classList.toggle('fit', state.fit)
    if (state.fit) {
      media.style.width = ''
      media.style.height = ''
    } else {
      // Actual size: one captured pixel per device pixel
      const dpr = window.devicePixelRatio || 1
      media.style.width = n.w / dpr + 'px'
      media.style.height = n.h / dpr + 'px'
    }
  }

  // ------------------------------------------------------------ recording
  function startRecording() {
    if (!stream || state.recording) return
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => saveRecording(chunks, rec)
    rec.start(1000)
    state.recording = { rec, chunks, t0: Date.now() }
    recTimer = setInterval(() => paintPill(), 500)
    render()
  }

  function finishRecording(save) {
    const r = state.recording
    if (!r) return
    r.rec.__skip = !save
    clearInterval(recTimer)
    recTimer = 0
    state.recording = null
    if (r.rec.state !== 'inactive') r.rec.stop()
    render()
  }

  async function saveRecording(chunks, rec) {
    const sid = state.session && state.session.sid
    const blob = new Blob(chunks, { type: 'video/webm' })
    if (!blob.size) return
    // stopped by the Stop button: ask where to save; stopped by a display change, hide or close: drop it
    if (rec.__skip) return
    try {
      const data = new Uint8Array(await blob.arrayBuffer())
      const r = await ctx.rpc('saveRecording', { sid, data })
      if (r && r.saved) toast('info', 'Saved recording to ' + r.path)
    } catch (e) {
      toast('error', cleanErr(e))
    }
  }

  // ------------------------------------------------------------ control
  function askControl() {
    state.confirm = true
    render()
  }

  async function setMode(mode) {
    const s = state.session
    if (!s) return
    try {
      await ctx.rpc('mode', { sid: s.sid, mode, confirm: mode === 'control' ? true : undefined })
      state.mode = mode
      state.confirm = false
      queue.length = 0
      render()
      if (mode === 'control') stage.querySelector('.sc-view')?.focus()
    } catch (e) {
      state.confirm = false
      toast('error', cleanErr(e))
      render()
    }
  }

  // Input is batched: pointer moves coalesce to the newest, everything else keeps order; one request in flight.
  const queue = []
  let sending = false
  let raf = 0
  function push(ev) {
    if (state.mode !== 'control') return
    if (ev.t === 'move' && queue.length && queue[queue.length - 1].t === 'move') queue[queue.length - 1] = ev
    else queue.push(ev)
    if (!raf) raf = requestAnimationFrame(flush)
  }
  async function flush() {
    raf = 0
    if (sending || !queue.length || state.mode !== 'control' || !state.session) return
    sending = true
    const events = queue.splice(0, 200)
    try {
      await ctx.rpc('input', { sid: state.session.sid, events })
    } catch (e) {
      queue.length = 0
      if (state.mode === 'control') {
        state.mode = 'view'
        toast('error', cleanErr(e))
        render()
      }
    }
    sending = false
    if (queue.length && !raf) raf = requestAnimationFrame(flush)
  }

  /** Pointer position -> 0..1 inside the displayed picture (letterbox bars excluded), or null. */
  function norm(e) {
    if (!media) return null
    const n = natural()
    if (!n.w) return null
    const r = media.getBoundingClientRect()
    // object-fit: contain inside a larger box: find the picture's own rectangle
    const scale = Math.min(r.width / n.w, r.height / n.h)
    const w = n.w * scale
    const hh = n.h * scale
    const x = (e.clientX - (r.left + (r.width - w) / 2)) / w
    const y = (e.clientY - (r.top + (r.height - hh) / 2)) / hh
    if (x < 0 || y < 0 || x > 1 || y > 1) return null
    return { x, y }
  }

  function wireInput(view) {
    view.addEventListener('pointermove', (e) => {
      const p = norm(e)
      if (p) push({ t: 'move', ...p })
    })
    view.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'control') return
      view.focus()
      const p = norm(e)
      if (!p) return
      view.setPointerCapture(e.pointerId)
      push({ t: 'down', button: e.button, ...p })
      e.preventDefault()
    })
    view.addEventListener('pointerup', (e) => {
      if (state.mode !== 'control') return
      const p = norm(e)
      push({ t: 'up', button: e.button, ...(p || {}) })
      if (view.hasPointerCapture(e.pointerId)) view.releasePointerCapture(e.pointerId)
      e.preventDefault()
    })
    view.addEventListener('contextmenu', (e) => state.mode === 'control' && e.preventDefault())
    view.addEventListener(
      'wheel',
      (e) => {
        if (state.mode !== 'control') return
        const p = norm(e)
        if (!p) return
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1
        push({ t: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k, ...p })
        e.preventDefault()
      },
      { passive: false },
    )
    view.addEventListener('keydown', (e) => {
      if (state.mode !== 'control') return
      // Escape x3 leaves control at once; the third press is not sent
      if (e.code === 'Escape' && !e.repeat) {
        const now = performance.now()
        escTimes = escTimes.filter((t) => now - t < 900)
        escTimes.push(now)
        if (escTimes.length >= ESC_CHORD) {
          escTimes = []
          e.preventDefault()
          setMode('view')
          return
        }
      }
      push({ t: 'key', code: e.code, down: true })
      e.preventDefault()
      e.stopPropagation()
    })
    view.addEventListener('keyup', (e) => {
      if (state.mode !== 'control') return
      push({ t: 'key', code: e.code, down: false })
      e.preventDefault()
      e.stopPropagation()
    })
    // losing keyboard focus mid-chord must not leave a key held on the display: the main process releases everything on view
    view.addEventListener('blur', () => {
      if (state.mode === 'control') {
        for (const code of ['ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft']) push({ t: 'key', code, down: false })
      }
    })
  }

  // ------------------------------------------------------------ chrome
  function paintPill() {
    const pill = bar.querySelector('.sc-pill')
    if (!pill) return
    const r = state.recording
    if (r) pill.querySelector('b').textContent = `REC ${clock(Date.now() - r.t0)}`
  }

  function renderBar() {
    bar.replaceChildren()
    const s = state.session
    if (!s) {
      bar.append(h('div', { class: 'sc-title' }, ico('screen'), 'Screen'), h('div', { class: 'sc-gap' }), h('button', { class: 'sc-btn', onClick: loadSources, disabled: state.loading }, ico('refresh'), 'Refresh displays'))
      return
    }
    const n = natural()
    const rec = state.recording
    const items = [
      h(
        'button',
        { class: 'sc-btn', title: 'Pick a different display', onClick: disconnect },
        ico('screen'),
        s.source.name,
        h('span', { class: 'sc-dim mono' }, `${s.source.size.w}×${s.source.size.h}`),
      ),
      h(
        'div',
        { class: 'seg', title: 'How the picture fits the pane' },
        ...[
          ['fit', 'Fit', true],
          ['actual', 'Actual size', false],
        ].map(([k, label, v]) =>
          h('button', { class: 'seg-b' + (state.fit === v ? ' on' : ''), onClick: () => ((state.fit = v), render()) }, ico(k), h('span', null, label)),
        ),
      ),
      h(
        'div',
        { class: 'seg', title: 'View only never sends input; Control needs your confirmation each session' },
        h('button', { class: 'seg-b' + (state.mode === 'view' ? ' on' : ''), onClick: () => state.mode === 'control' && setMode('view') }, ico('eye'), h('span', null, 'View only')),
        h('button', { class: 'seg-b control' + (state.mode === 'control' ? ' on' : ''), onClick: () => state.mode !== 'control' && askControl() }, ico('pointer'), h('span', null, 'Control')),
      ),
      h('div', { class: 'sc-gap' }),
      state.live
        ? h(
            'div',
            { class: 'sc-pill' + (rec ? ' rec' : ' live'), title: rec ? 'Recording this display to a file' : 'This display is being captured and shown here' },
            h('i'),
            h('b', null, rec ? `REC ${clock(Date.now() - rec.t0)}` : state.snapshot ? 'LIVE · stills' : 'LIVE'),
            h('span', { class: 'sc-dim mono' }, n.w ? `${n.w}×${n.h}` : ''),
          )
        : null,
      stream && state.live
        ? h('button', { class: 'sc-btn' + (rec ? ' danger' : ''), title: rec ? 'Stop and save' : 'Record this display to a video file', onClick: () => (rec ? finishRecording(true) : startRecording()) }, ico(rec ? 'stop' : 'rec'), rec ? 'Stop' : 'Record')
        : null,
      h('button', { class: 'sc-btn icon', title: 'Stop sharing this display', onClick: disconnect }, ico('close')),
    ]
    bar.append(...items.filter(Boolean))
  }

  function renderBanner() {
    const s = state.session
    if (!s || state.mode !== 'control') {
      banner.hidden = true
      banner.replaceChildren()
      return
    }
    banner.hidden = false
    banner.replaceChildren(
      ico('warn'),
      h('span', { class: 'sc-banner-t' }, h('b', null, `Controlling ${s.source.name}.`), ' Your mouse and keyboard over the picture are sent to that display. Press Esc three times to stop.'),
      h('button', { class: 'sc-btn', onClick: () => setMode('view') }, 'Stop controlling'),
    )
  }

  function renderStage() {
    const keepView = stage.querySelector('.sc-view')
    const s = state.session
    if (!s) {
      stage.replaceChildren(pickerEl())
      return
    }
    let view = keepView
    if (!view) {
      view = h('div', { class: 'sc-view', tabIndex: 0 })
      wireInput(view)
      stage.replaceChildren(view)
    }
    view.classList.toggle('control', state.mode === 'control')
    view.classList.toggle('fit', state.fit)
    if (media && media.parentNode !== view) view.replaceChildren(media)
    if (!media) view.replaceChildren(h('div', { class: 'sc-wait' }, state.error ? state.error : 'Starting capture…'))
    layoutMedia()
  }

  function pickerEl() {
    const wrap = h('div', { class: 'sc-pick' })
    wrap.append(
      h('div', { class: 'sc-pick-t' }, ico('lock'), 'Choose a display to view'),
      h('div', { class: 'sc-pick-s' }, 'Nothing is captured until you pick one. Pager shows it here and, only if you turn on Control for the session, lets you drive it.'),
    )
    if (state.error) wrap.append(h('div', { class: 'sc-err' }, state.error))
    if (!state.sources) {
      wrap.append(h('div', { class: 'sc-pick-a' }, h('button', { class: 'sc-btn primary', disabled: state.loading, onClick: loadSources }, state.loading ? 'Looking…' : 'Show my displays')))
      return wrap
    }
    wrap.append(
      h(
        'div',
        { class: 'sc-grid' },
        state.sources.map((src) =>
          h(
            'button',
            { class: 'sc-card', onClick: () => choose(src), title: `Share ${src.name}` },
            h('div', { class: 'sc-thumb' }, src.thumb ? h('img', { src: src.thumb, alt: '', draggable: false }) : ico('screen')),
            h(
              'div',
              { class: 'sc-card-t' },
              h('span', null, src.name),
              src.primary ? h('span', { class: 'sc-tag' }, 'Primary') : null,
              src.hostsPager ? h('span', { class: 'sc-tag warn', title: 'Pager is on this display: driving it moves the pointer out from under this pane' }, 'Pager is here') : null,
            ),
            h('div', { class: 'sc-card-s mono' }, `${src.size.w}×${src.size.h} · ${Math.round(src.scale * 100)}%`),
          ),
        ),
      ),
    )
    if (!state.sources.length) wrap.append(h('div', { class: 'sc-err' }, 'No displays were reported.'))
    return wrap
  }

  function renderDialog() {
    const s = state.session
    if (!state.confirm || !s) {
      dialog.hidden = true
      dialog.replaceChildren()
      return
    }
    dialog.hidden = false
    const go = h('button', { class: 'sc-btn danger-solid', onClick: () => setMode('control') }, 'Allow control')
    dialog.replaceChildren(
      h(
        'div',
        { class: 'sc-dlg', role: 'alertdialog' },
        h('div', { class: 'sc-dlg-t' }, ico('warn'), `Drive ${s.source.name}?`),
        h('div', { class: 'sc-dlg-b' }, 'While Control is on, your mouse clicks, scrolling and typing over the picture are sent to that display as if you used it directly. This applies to this session only and ends when you stop, hide this pane, or after 10 idle minutes.'),
        s.source.hostsPager ? h('div', { class: 'sc-dlg-note' }, 'Pager is on this display, so the pointer will jump out from under this pane. Pick another display to drive comfortably.') : null,
        h('div', { class: 'sc-dlg-a' }, h('button', { class: 'sc-btn', onClick: () => ((state.confirm = false), render()) }, 'Cancel'), go),
      ),
    )
    go.focus()
  }

  function render() {
    if (disposed) return
    renderBar()
    renderBanner()
    renderStage()
    renderDialog()
    root.classList.toggle('controlling', state.mode === 'control')
  }

  async function disconnect() {
    const s = state.session
    stopCapture()
    state.session = null
    state.mode = 'view'
    state.confirm = false
    state.error = null
    stage.replaceChildren()
    if (s) ctx.rpc('release', { sid: s.sid }).catch(() => {})
    loadSources()
  }

  // Hidden (another tab, minimised): stop capturing and drop control; come back view-only with capture resumed.
  function setVisible(v) {
    if (v === visible) return
    visible = v
    const s = state.session
    if (!s) return
    if (!v) {
      if (state.mode === 'control') {
        state.mode = 'view'
        ctx.rpc('mode', { sid: s.sid, mode: 'view' }).catch(() => {})
      }
      stopCapture()
      render()
    } else startCapture()
  }
  const io = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting && document.visibilityState === 'visible'))
  io.observe(root)
  const onVis = () => setVisible(document.visibilityState === 'visible')
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('resize', layoutMedia)

  render()

  return {
    dispose() {
      disposed = true
      const s = state.session
      stopCapture()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', layoutMedia)
      if (typeof offEvent === 'function') offEvent()
      if (s) ctx.rpc('release', { sid: s.sid }).catch(() => {})
      root.remove()
    },
    focus: () => stage.querySelector('.sc-view')?.focus(),
    resize: layoutMedia,
  }
}

export default { id: 'screen', title: 'Screen', icon: ICONS.screen, mount }
