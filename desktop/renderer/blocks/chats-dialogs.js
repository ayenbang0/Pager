// Chats block dialogs and pages: the generic in-block dialog (confirm / prompt), the New chat dialog (contact code + copy, add by
// code, new group, open an existing chat), and the requests inbox (accept / decline).
import { avatar } from './chats-ui.js'
import { copyText } from './chats-ui.js'
import { plural, rankMatch } from './chats-util.js'

const CODE_RE = /^pgr1-[ybndrfg8ejkmcpqxot1uwisza345h769]{56}$/i

/** Plausibility check for a contact code before it is sent (the engine verifies the checksum). Returns '' when fine. */
export function codeProblem(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (!/^pgr1-/i.test(s)) return 'A contact code starts with pgr1-'
  if (s.length < 61) return 'That code is too short'
  if (s.length > 61) return 'That code is too long'
  if (!CODE_RE.test(s)) return 'That code has characters a contact code never has'
  return ''
}

/** Contact code in readable groups (display only; copy uses the raw code). */
export const groupCode = (code) => {
  const c = String(code ?? '')
  return c.startsWith('pgr1-') ? ['pgr1-', ...(c.slice(5).match(/.{1,8}/g) || [])].join(' ').replace('pgr1- ', 'pgr1-') : c
}

export function createDialogs(ui) {
  const { h, icon } = ui.b
  let top = null

  /** open({ title, icon?, danger?, body: Node|Node[], actions?: Node[], onClose?, wide? }) -> { close, el } */
  function open(o) {
    close()
    const prevFocus = typeof document !== 'undefined' ? document.activeElement : null
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', on: { click: () => close() } }, icon('close', 16))
    const card = h(
      'div',
      { class: 'cm-dlg' + (o.danger ? ' danger' : '') + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('div', { class: 'cm-dlg-head' }, h('span', { class: 'cm-dlg-ic' }, icon(o.icon || (o.danger ? 'warn' : 'chat'), 17)), h('div', { class: 'cm-dlg-t' }, o.title), closeBtn),
      h('div', { class: 'cm-dlg-body' }, o.body),
      o.actions ? h('div', { class: 'cm-dlg-foot' }, o.actions) : null,
    )
    const scrim = h('div', { class: 'cm-scrim', on: { pointerdown: (e) => e.target === scrim && close() } }, card)
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        close()
      } else if (e.key === 'Tab') {
        const f = Array.from(card.querySelectorAll('button, input, textarea, [tabindex="0"]')).filter((x) => !x.disabled && !x.hidden)
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus())
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus())
      }
    }
    document.addEventListener('keydown', key, true)
    ui.root.append(scrim)
    const cur = {
      el: card,
      scrim,
      close: () => {
        if (top !== cur) return
        top = null
        document.removeEventListener('keydown', key, true)
        scrim.classList.add('out')
        setTimeout(() => scrim.remove(), 160)
        o.onClose?.()
        prevFocus?.focus?.()
      },
    }
    top = cur
    setTimeout(() => (card.querySelector('[data-autofocus]') || card.querySelector('input, textarea, button'))?.focus?.(), 30)
    return cur
  }
  function close() {
    top?.close()
  }

  const btn = (label, fn, kind = '') => h('button', { class: 'btn ' + kind, type: 'button', on: { click: fn } }, label)

  function confirm({ title, body, confirm: yes = 'OK', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        d.close()
        resolve(v)
      }
      const d = open({ title, danger, icon: danger ? 'warn' : 'help', body: body ? h('p', null, body) : [], actions: [btn(cancel, () => finish(false), 'quiet'), btn(yes, () => finish(true), danger ? 'danger' : 'accent')], onClose: () => finish(false) })
    })
  }

  function prompt({ title, label, value = '', placeholder = '', confirm: yes = 'Save', icon: ic = 'edit', max = 64 }) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        d.close()
        resolve(v)
      }
      const input = h('input', { class: 'cm-field', value, placeholder, maxlength: max, spellcheck: false, 'data-autofocus': '1', 'aria-label': label || title, on: { keydown: (e) => e.key === 'Enter' && go() } })
      const go = () => input.value.trim() && finish(input.value.trim())
      const d = open({ title, icon: ic, body: [label ? h('label', { class: 'cm-lbl' }, label) : null, input], actions: [btn('Cancel', () => finish(null), 'quiet'), btn(yes, go, 'accent')], onClose: () => finish(null) })
    })
  }

  return { open, close, confirm, prompt }
}

// ------------------------------------------------------------------------------------------------ new chat
export function openNewChat(ui, start = 'add') {
  const { h, icon } = ui.b
  const store = ui.store
  let tab = start
  const body = h('div', { class: 'cm-nc' })
  const tabs = ['add', 'group', 'open'].map((t) => h('button', { class: 'cm-tab', type: 'button', role: 'tab', 'data-t': t, on: { click: () => ((tab = t), paint()) } }, t === 'add' ? 'Add a contact' : t === 'group' ? 'New group' : 'Open chat'))
  const bar = h('div', { class: 'cm-tabs', role: 'tablist' }, tabs)
  const d = ui.dialogs.open({ title: 'New chat', icon: 'chat-plus', wide: true, body: [bar, body] })

  function codeCard() {
    const code = store.me?.code || ''
    const copyBtn = h('button', { class: 'btn sm', type: 'button', disabled: !code, on: { click: async () => {
      const ok = await copyText(code)
      copyBtn.classList.toggle('done', ok)
      copyBtn.lastChild.textContent = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => (copyBtn.classList.remove('done'), (copyBtn.lastChild.textContent = 'Copy code')), 1400)
    } } }, icon('copy', 14), h('span', null, 'Copy code'))
    return h('div', { class: 'cm-code-card' }, h('div', { class: 'cm-code-l' }, 'Your contact code'), h('div', { class: 'cm-code', title: 'Share this code so people can add you' }, code ? groupCode(code) : 'Not available while chat is offline'), h('div', { class: 'cm-code-f' }, h('span', null, 'Anyone with this code can send you a request.'), copyBtn))
  }

  function paintAdd() {
    const code = h('input', { class: 'cm-field mono', placeholder: 'pgr1-…', spellcheck: false, autocomplete: 'off', 'data-autofocus': '1', 'aria-label': 'Contact code', maxlength: 80 })
    const note = h('input', { class: 'cm-field', placeholder: 'Say hi (optional)', maxlength: 200, 'aria-label': 'Note' })
    const msg = h('div', { class: 'cm-form-msg', hidden: true, role: 'status' })
    const go = h('button', { class: 'btn accent', type: 'button', disabled: true, on: { click: () => submit() } }, 'Send request')
    const validate = () => {
      const p = codeProblem(code.value)
      msg.hidden = !p
      msg.textContent = p
      msg.className = 'cm-form-msg bad'
      code.classList.toggle('bad', !!p)
      go.disabled = !code.value.trim() || !!p
    }
    async function submit() {
      go.disabled = true
      go.classList.add('busy')
      try {
        const r = await store.addContact(code.value.trim(), note.value.trim())
        ui.toast('ok', r?.message || 'Request sent')
        d.close()
      } catch (e) {
        msg.hidden = false
        msg.textContent = e.message
        msg.className = 'cm-form-msg bad'
        go.disabled = false
      } finally {
        go.classList.remove('busy')
      }
    }
    code.addEventListener('input', validate)
    code.addEventListener('keydown', (e) => e.key === 'Enter' && !go.disabled && submit())
    body.replaceChildren(codeCard(), h('label', { class: 'cm-lbl' }, "Add someone's code"), code, note, msg, h('div', { class: 'cm-form-foot' }, go))
  }

  function paintGroup() {
    const name = h('input', { class: 'cm-field', placeholder: 'Group name', maxlength: 64, 'data-autofocus': '1', 'aria-label': 'Group name' })
    const msg = h('div', { class: 'cm-form-msg bad', hidden: true })
    const go = h('button', { class: 'btn accent', type: 'button', disabled: true, on: { click: () => submit() } }, 'Create group')
    name.addEventListener('input', () => (go.disabled = !name.value.trim()))
    name.addEventListener('keydown', (e) => e.key === 'Enter' && !go.disabled && submit())
    async function submit() {
      go.disabled = true
      try {
        const r = await store.newGroup(name.value.trim())
        d.close()
        if (r?.chatId) ui.openChat(r.chatId)
      } catch (e) {
        msg.hidden = false
        msg.textContent = e.message
        go.disabled = false
      }
    }
    body.replaceChildren(h('p', { class: 'cm-hint' }, 'Groups are invite-only. After creating one you can invite your contacts from the group info.'), h('label', { class: 'cm-lbl' }, 'Name'), name, msg, h('div', { class: 'cm-form-foot' }, go))
  }

  function paintOpen() {
    const q = h('input', { class: 'cm-field', placeholder: 'Search contacts and groups', spellcheck: false, 'data-autofocus': '1', 'aria-label': 'Search' })
    const list = h('div', { class: 'cm-pick' })
    const fill = () => {
      const items = store.chats.filter((c) => rankMatch(q.value, c.title) >= 0).slice(0, 40)
      list.replaceChildren(...(items.length ? items.map((c) => h('button', { class: 'cm-pick-row', type: 'button', on: { click: () => (d.close(), ui.openChat(c.id)) } }, avatar(ui.b, c, { size: 32 }), h('span', { class: 'cm-pick-t' }, c.title), h('span', { class: 'cm-pick-s' }, c.kind === 'dm' ? (c.online ? 'online' : '') : c.kind === 'group' ? plural(c.members || 0, 'member') : 'agent'))) : [h('div', { class: 'cm-empty-s' }, 'Nothing found')]))
    }
    q.addEventListener('input', fill)
    fill()
    body.replaceChildren(q, list)
  }

  function paint() {
    for (const t of tabs) {
      const on = t.getAttribute('data-t') === tab
      t.classList.toggle('on', on)
      t.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    if (tab === 'add') paintAdd()
    else if (tab === 'group') paintGroup()
    else paintOpen()
    setTimeout(() => body.querySelector('[data-autofocus]')?.focus?.(), 20)
  }
  paint()
  return d
}

// ------------------------------------------------------------------------------------------------ requests inbox
const TYPE_LABEL = { contact: 'Contact request', group: 'Group invite', session: 'Agent session invite' }

/** The inbox page: accept / decline contact requests, group invites and agent-session invites. */
export function buildRequests(ui) {
  const { h, icon } = ui.b
  const store = ui.store
  const list = h('div', { class: 'cm-req-list' })
  const el = h('section', { class: 'cm-page cm-reqs', 'aria-label': 'Requests' }, h('div', { class: 'cm-head' }, h('button', { class: 'icon-btn cm-back', type: 'button', title: 'Back', 'aria-label': 'Back', on: { click: () => ui.closePage() } }, icon('chev-left', 17)), h('div', { class: 'cm-h-txt' }, h('div', { class: 'cm-h-t' }, 'Requests'), h('div', { class: 'cm-h-s' }, 'People who want to talk to you'))), list)

  function paint() {
    const items = store.pending
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'cm-empty-card big' }, icon('inbox', 28), h('b', null, 'No requests'), h('span', null, 'New contact requests and invites show up here.')))
      return
    }
    list.replaceChildren(
      ...items.map((p, i) => {
        const busy = { v: false }
        const act = async (fn, okText, e) => {
          if (busy.v) return
          busy.v = true
          card.classList.add('busy')
          try {
            const r = await fn(p)
            ui.toast('ok', r?.message || okText)
          } catch (err) {
            ui.toast('error', err.message)
            busy.v = false
            card.classList.remove('busy')
          }
        }
        const card = h(
          'div',
          { class: 'cm-req', style: { '--i': Math.min(i, 8) } },
          avatar(ui.b, { title: p.label, kind: p.type === 'group' ? 'group' : 'dm', pk: p.id }, { size: 44, dot: false }),
          h('div', { class: 'cm-req-main' }, h('div', { class: 'cm-req-t' }, p.label), h('div', { class: 'cm-req-k' }, TYPE_LABEL[p.type] || 'Request'), p.note ? h('div', { class: 'cm-req-n' }, p.note) : null),
          h('div', { class: 'cm-req-btns' }, h('button', { class: 'btn sm', type: 'button', on: { click: (e) => act((x) => store.decline(x), 'Declined', e) } }, p.type === 'contact' ? 'Block' : 'Decline'), h('button', { class: 'btn sm accent', type: 'button', on: { click: (e) => act((x) => store.accept(x), 'Accepted', e) } }, 'Accept')),
        )
        return card
      }),
    )
  }
  paint()
  const off = store.on('list', paint)
  return { el, paint, dispose: off }
}
