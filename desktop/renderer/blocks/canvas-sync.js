// Canvas block: the window's side of persistence. It keeps the main handler's copy of the document up to date:
//   - local changes are pushed (throttled) as full shape arrays with the seq they were based on
//   - a refused push (someone else saved first) and a pushed `changed` event (agent edit, file edited on disk) are folded in
//     with a three-way merge against the last acknowledged shapes, so neither side's edits are lost
// No DOM; `rpc(method, args)` and the callbacks are injected, so this runs under node tests against the real handler.
import { mergeShapes } from './canvas-model.js'

export class Sync {
  /**
   * @param {object} o
   * @param {(method:string,args:object)=>Promise<any>} o.rpc
   * @param {()=>Array} o.getShapes        current shapes (the history head)
   * @param {()=>object} o.getDoc          { view, settings, name }
   * @param {(shapes:Array, meta:{source:string,label:string,ids?:object})=>void} o.onRemote  apply merged shapes to the editor
   * @param {(status:'saved'|'saving'|'error')=>void} [o.onStatus]
   * @param {number} [o.delay] push throttle in ms
   * @param {number} [o.viewDelay]
   */
  constructor(o) {
    this.o = o
    this.id = null
    this.seq = 0
    this.base = []
    this.label = ''
    this.timer = 0
    this.viewTimer = 0
    this.viewDirty = false
    this.busy = null
    this.again = false
    this.retry = 0
    this.dead = false
    this.status = 'saved'
  }

  setStatus(s) {
    if (s !== this.status) {
      this.status = s
      if (this.o.onStatus) this.o.onStatus(s)
    }
  }

  /** Open the canvas: returns the handler's snapshot ({ id, name, seq, doc, ... }). */
  async open(args) {
    const snap = await this.o.rpc('open', args)
    this.id = snap.id
    this.seq = snap.seq
    this.base = snap.doc.shapes
    return snap
  }

  /** The shapes changed locally. */
  touch(label = '') {
    if (this.dead || this.id === null) return
    if (label && !this.label) this.label = label
    this.setStatus('saving')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.push(), this.o.delay ?? 120)
  }

  /** Pan/zoom or settings changed. */
  touchView() {
    if (this.dead || this.id === null) return
    this.viewDirty = true
    clearTimeout(this.viewTimer)
    this.viewTimer = setTimeout(() => this.push(), this.o.viewDelay ?? 700)
  }

  push() {
    clearTimeout(this.timer)
    clearTimeout(this.viewTimer)
    if (this.busy) {
      this.again = true
      return this.busy
    }
    this.busy = this.run().finally(() => {
      this.busy = null
    })
    return this.busy
  }

  async run() {
    let conflicts = 0
    try {
      do {
        this.again = false
        const shapes = this.o.getShapes()
        const doc = this.o.getDoc()
        if (shapes === this.base) {
          if (!this.viewDirty) break
          this.viewDirty = false
          await this.o.rpc('saveView', { id: this.id, view: doc.view, settings: doc.settings, name: doc.name })
          continue
        }
        this.setStatus('saving')
        const label = this.label
        this.label = ''
        this.viewDirty = false
        const res = await this.o.rpc('save', { id: this.id, baseSeq: this.seq, doc: { shapes, view: doc.view, settings: doc.settings, name: doc.name }, label })
        if (res.ok) {
          this.seq = res.seq
          this.base = shapes
        } else if (res.conflict) {
          if (++conflicts > 6) throw new Error('could not resolve a save conflict')
          const remote = res.doc.shapes
          const merged = mergeShapes(this.base, this.o.getShapes(), remote)
          this.base = remote
          this.seq = res.seq
          this.label = label || this.label
          this.o.onRemote(merged, { source: 'merge', label: 'Merged changes' })
        } else throw new Error('save refused')
      } while (this.again || this.o.getShapes() !== this.base || this.viewDirty)
      this.retry = 0
      this.setStatus('saved')
    } catch (err) {
      this.setStatus('error')
      this.lastError = err
      // back off and try again: the main process may be restarting
      if (!this.dead) {
        this.retry = Math.min(this.retry + 1, 5)
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.push(), 800 * this.retry)
      }
    }
  }

  /** Push everything now and wait (before the pane closes). */
  async flush() {
    clearTimeout(this.timer)
    clearTimeout(this.viewTimer)
    if (this.busy) await this.busy
    if (this.o.getShapes() !== this.base || this.viewDirty) await this.push()
    try {
      await this.o.rpc('flush', { id: this.id })
    } catch { /* the handler is gone */ }
  }

  /** A `changed` event from the handler (an agent edit, another window's save, or the file changed on disk). */
  async remote(ev) {
    if (this.dead || !ev || ev.id !== this.id) return
    if (this.busy) await this.busy.catch(() => {})
    if (ev.seq <= this.seq) return // our own save echoing back, or already merged
    if (!ev.doc) {
      // a large document is announced without its shapes
      const snap = await this.o.rpc('open', { id: this.id })
      ev = { ...ev, seq: snap.seq, doc: snap.doc }
      if (ev.seq <= this.seq) return
    }
    const remote = ev.doc.shapes
    const local = this.o.getShapes()
    const merged = local === this.base ? remote : mergeShapes(this.base, local, remote)
    this.base = remote
    this.seq = ev.seq
    this.o.onRemote(merged, { source: ev.source || 'remote', label: ev.label || 'Remote change', ids: ev.ids })
  }

  dispose() {
    this.dead = true
    clearTimeout(this.timer)
    clearTimeout(this.viewTimer)
  }
}
