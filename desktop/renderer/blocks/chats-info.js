// Chats block info panel: contact info or the group member panel (members, invite, rename, leave), local chat prefs
// (pin / mute / archive) and the live shares of the conversation.
import { avatar } from './chats-ui.js'
import { copyText } from './chats-ui.js'
import { activeMembers, blockMeta } from './chats-share.js'
import { plural, rankMatch } from './chats-util.js'

export function createInfo(ui) {
  const { h, icon } = ui.b
  const store = ui.store
  let chatId = null
  const body = h('div', { class: 'cm-info-body' })
  const el = h('aside', { class: 'cm-info', 'aria-label': 'Chat info' }, h('div', { class: 'cm-info-head' }, h('div', { class: 'cm-info-t' }, 'Chat info'), h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close info', on: { click: () => ui.toggleInfo(false) } }, icon('close', 16))), body)

  const action = (name, label, fn, on = false, danger = false) => h('button', { class: 'cm-ia' + (on ? ' on' : '') + (danger ? ' danger' : ''), type: 'button', on: { click: fn } }, icon(name, 16), h('span', null, label))

  function inviteDialog(chat, t) {
    const members = new Set((t?.group?.people || []).map((p) => p.name))
    const contacts = store.chats.filter((c) => c.kind === 'dm' && !members.has(c.title))
    const q = h('input', { class: 'cm-field', placeholder: 'Search contacts', spellcheck: false, 'data-autofocus': '1', 'aria-label': 'Search contacts' })
    const list = h('div', { class: 'cm-pick' })
    let d
    const fill = () => {
      const items = contacts.filter((c) => rankMatch(q.value, c.title) >= 0)
      list.replaceChildren(
        ...(items.length
          ? items.map((c) =>
              h('button', { class: 'cm-pick-row', type: 'button', on: { click: async () => {
                try {
                  await store.api.call('chats.group.invite', { chatId: chat.id, peer: c.title })
                  ui.toast('ok', `Invited ${c.title}`)
                  d.close()
                  void store.refreshGroup(chat.id).catch(() => {})
                } catch (e) {
                  ui.toast('error', e.message)
                }
              } } }, avatar(ui.b, c, { size: 32 }), h('span', { class: 'cm-pick-t' }, c.title), h('span', { class: 'cm-pick-s' }, c.online ? 'online' : '')),
            )
          : [h('div', { class: 'cm-empty-s' }, contacts.length ? 'No contacts match' : 'Everyone you know is already here')]),
      )
    }
    q.addEventListener('input', fill)
    fill()
    d = ui.dialogs.open({ title: 'Invite to ' + chat.title, icon: 'user-plus', body: [q, list] })
  }

  function paint() {
    const chat = store.chat(chatId)
    if (!chat) return body.replaceChildren()
    const t = store.thread(chatId)
    const caps = store.caps
    const out = []
    out.push(
      h('div', { class: 'cm-info-who' }, avatar(ui.b, chat, { size: 72 }), h('div', { class: 'cm-info-n' }, chat.title), h('div', { class: 'cm-info-s' }, chat.kind === 'dm' ? (chat.online ? 'online' : 'offline') : chat.kind === 'group' ? plural(chat.members || t?.group?.people?.length || 0, 'member') : chat.kind === 'room' ? 'Your coding agents' : chat.kind === 'ai' ? 'AI assistant' : chat.kind === 'shared' ? 'Shared agent session' : 'Agent')),
    )
    out.push(
      h('div', { class: 'cm-ia-row' }, action(chat.pinned ? 'pin-off' : 'pin', chat.pinned ? 'Unpin' : 'Pin', () => ui.setPref(chat.id, 'pin', !chat.pinned), chat.pinned), action(chat.muted ? 'bell' : 'bell-off', chat.muted ? 'Unmute' : 'Mute', () => ui.setPref(chat.id, 'mute', !chat.muted), chat.muted), action('archive', chat.archived ? 'Unarchive' : 'Archive', () => ui.setPref(chat.id, 'archive', !chat.archived), chat.archived)),
    )

    // live shares in this chat
    const shares = (t?.messages || []).filter((m) => m.kind === 'share' && m.share && m.share.state === 'live').map((m) => m.share)
    if (shares.length) {
      out.push(
        h('div', { class: 'cm-isec' }, h('div', { class: 'cm-isec-h' }, 'Live now'), ...shares.map((s) => {
          const meta = blockMeta(s.block)
          const mem = activeMembers(s)
          const joined = s.members.some((m) => m.me && m.active)
          return h('div', { class: 'cm-ishare' }, h('span', { class: 'cm-ishare-ic' }, icon(meta.icon, 16)), h('span', { class: 'cm-ishare-t' }, h('b', null, s.title || meta.label), h('i', null, `${mem.length} here`)), h('button', { class: 'btn sm', type: 'button', on: { click: () => (joined || s.mine ? ui.openShare(s) : ui.joinShare(s)) } }, joined || s.mine ? 'Open' : 'Join'))
        })),
      )
    }

    if (chat.kind === 'dm') {
      out.push(h('div', { class: 'cm-isec' }, h('div', { class: 'cm-isec-h' }, 'Contact'), chat.peer ? h('button', { class: 'cm-ikey', type: 'button', title: 'Copy public key', on: { click: async () => ui.toast((await copyText(chat.peer)) ? 'ok' : 'error', 'Public key copied') } }, h('span', { class: 'mono' }, chat.peer.slice(0, 8) + '…' + chat.peer.slice(-6)), icon('copy', 13)) : null))
      out.push(h('div', { class: 'cm-isec' }, action('trash', 'Remove contact', () => void ui.removeContact(chat), false, true)))
    } else if (chat.kind === 'group') {
      const people = t?.group?.people || []
      out.push(
        h('div', { class: 'cm-isec' }, h('div', { class: 'cm-isec-h' }, 'Members', h('span', { class: 'cm-isec-n' }, people.length || chat.members || '')),
          ...people.map((p) => h('div', { class: 'cm-member' }, avatar(ui.b, { title: p.name, pk: p.pk, online: p.online || p.me }, { size: 32 }), h('span', { class: 'cm-member-t' }, p.name, p.me ? h('i', null, ' you') : null), p.creator ? h('span', { class: 'cm-tag' }, 'creator') : null))),
      )
      const mgmt = []
      if (chat.creator && caps.groups) mgmt.push(action('user-plus', 'Invite', () => inviteDialog(chat, t)), action('edit', 'Rename', () => void ui.renameGroup(chat)))
      mgmt.push(action('close', 'Leave group', () => void ui.leaveGroup(chat), false, true))
      out.push(h('div', { class: 'cm-isec cm-ia-col' }, ...mgmt))
    }
    body.replaceChildren(...out)
  }

  const offs = [store.on('thread', (e) => e.id === chatId && paint()), store.on('list', () => chatId && paint())]
  return {
    el,
    show(id) {
      chatId = id
      paint()
    },
    paint,
    dispose() {
      for (const o of offs) o()
    },
  }
}
