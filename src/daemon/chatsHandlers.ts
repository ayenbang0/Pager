import { AGENT_SUBCOMMANDS, BOT_SUBCOMMANDS, COMMANDS, GROUP_SUBCOMMANDS, parseCommand, type CommandSpec } from '../app/commands.js'
import type { ToggleKey } from '../app/engine.js'
import { VERSION } from '../app/version.js'
import { capsFor, ChatsError, type Ctx } from './chats.js'
import { action, bool, chatId, done, int, KEY_RE, oneLine, opt, slash, str, type Args, type Handler } from './chatsUtil.js'
import { shareHandlers, timelineShares } from './chatsShares.js'


/** Slash commands that belong to the terminal host: the reason is returned to the caller. */
const HOST_ONLY: Record<string, string> = {
  quit: 'the daemon keeps running; close the window, or run `pager daemon stop`',
  exit: 'the daemon keeps running; close the window, or run `pager daemon stop`',
  terminal: 'the desktop has real terminal panes',
  run: 'the desktop has real terminal panes (pane.run)',
  docs: 'use chats.docs.url',
  studio: 'use chats.docs.url {page:"studio"}',
  update: 'run `pager update` in a terminal',
  settings: 'use chats.settings.get / chats.settings.set',
  requests: 'use chats.requests',
  help: 'use chats.commands',
}
const RESTART_KEYS = new Set(['alerts', 'updateCheck', 'acp', 'web', 'agents', 'lan'])
const TOGGLES: readonly ToggleKey[] = ['alerts', 'updateCheck', 'acp', 'web', 'agents', 'lan']



function agentsState(c: Ctx): Promise<Args> {
  if (!c.agentsOn) return Promise.resolve({ on: false })
  const e = c.engine
  return e.refreshAgentSettings().then(() => ({
    on: true,
    room: e.agentRoom(),
    setup: e.agentSetup(),
    questions: e.questions(),
    settings: e.settingsView().agents,
    shared: e.sharedSessions(),
    guests: e.sessionGuests(),
    reviewsPending: e.agentReviewsPending(),
    goal: e.agentGoal(),
    usages: e.agentUsages(),
    stats: e.agentStats(),
    ai: e.aiView() ?? null,
    aiBusy: e.aiBusy(),
  }))
}

function needAgents(c: Ctx): void {
  if (!c.agentsOn) throw new ChatsError('unsupported', 'Agents are off (Settings > Privacy and Network)')
}

function specs(list: readonly CommandSpec[]): { name: string; usage: string; summary: string }[] {
  return list.map((s) => ({ name: s.name, usage: s.usage, summary: s.summary }))
}

async function stateOf(c: Ctx): Promise<Args> {
  const st = c.status()
  const base: Args = { ...st, caps: capsFor(c.agentsOn), version: VERSION, online: false, onlineCount: 0, encrypted: false, agentsOn: c.agentsOn, chats: [], pending: [], call: null, openChat: null }
  if (st.status !== 'ready') return base
  const e = c.engine
  const view = e.settingsView()
  return {
    ...base,
    me: { pk: e.me.pk, code: e.me.code, name: e.me.name, badge: e.settings().badge },
    online: e.listening(),
    onlineCount: e.onlineCount(),
    ...(view.privacy.lan === undefined ? {} : { lan: view.privacy.lan }),
    encrypted: e.locked,
    update: e.updateAvailable(),
    chats: c.summaries(),
    pending: c.pending(),
    call: e.myCall() ?? null,
    openChat: e.active(),
  }
}

const PLAIN = /^(dm|grp):/

export const handlers: Record<string, Handler> = {
  // ---- lifecycle / app -----------------------------------------------------------------------------------------------
  'chats.caps': { needsEngine: false, run: (c) => capsFor(c.agentsOn) },
  'chats.state': { allowNotReady: true, run: (c) => stateOf(c) },
  'chats.retry': {
    allowNotReady: true,
    run: async (c) => {
      await c.retry()
      return stateOf(c)
    },
  },
  // A terminal pager that finds the data folder locked by this daemon asks for it. It needs no engine, and must not start one just to give it up.
  'chats.yield': { needsEngine: false, run: async (c) => ({ yielded: await c.yield() }) },
  'chats.unlock': {
    allowNotReady: true,
    run: async (c, a) => {
      await c.unlock(str(a, 'passphrase', 1000))
      return stateOf(c)
    },
  },
  'chats.focus': {
    run: (c, a) => {
      c.focus(bool(a, 'focused'))
      if (a.chatId === null) c.engine.activate(null)
      else if (a.chatId !== undefined) c.activate(chatId(a))
      return {}
    },
  },
  'chats.stats': {
    run: (c) => {
      const e = c.engine
      return { ...e.stats(), ...(c.agentsOn ? { agents: e.agentStats() } : {}), ...(e.recapLine() === undefined ? {} : { recap: e.recapLine() }), ...(e.whatsNew() === undefined ? {} : { whatsNew: e.whatsNew() }) }
    },
  },
  'chats.search': {
    run: (c, a) => {
      const r = c.engine.searchChats(str(a, 'query', 200), int(a.limit, 1, 50, 20))
      return { hits: r.hits.map((h) => ({ ...(h.conv === undefined ? {} : { chatId: h.conv }), where: h.where, author: h.author, ts: h.ts, text: h.text, snippet: h.snippet })), total: r.total }
    },
  },
  'chats.commands': {
    needsEngine: false,
    run: () => {
      const subs: Record<string, readonly CommandSpec[]> = { group: GROUP_SUBCOMMANDS, bot: BOT_SUBCOMMANDS, agent: AGENT_SUBCOMMANDS }
      return COMMANDS.map((s) => ({ name: s.name, usage: s.usage, summary: s.summary, ...(subs[s.name] === undefined ? {} : { subs: specs(subs[s.name]!) }), ...(HOST_ONLY[s.name] === undefined ? {} : { hostOnly: HOST_ONLY[s.name] }) }))
    },
  },
  'chats.command': {
    run: async (c, a) => {
      const line = str(a, 'line').trim()
      if (!line.startsWith('/') || line.startsWith('//')) throw new ChatsError('invalid', 'line must be a slash command (use chats.send for text)')
      const name = parseCommand(line).name
      const why = HOST_ONLY[name]
      if (why !== undefined) throw new ChatsError('unsupported', `/${name} belongs to the terminal host: ${why}`)
      const e = c.engine
      const chat = opt(a, 'chatId', 100)
      const back = chat ?? e.active()
      if (chat !== undefined) c.activate(chat)
      const { toasts } = await c.act(() => e.run(line))
      // Output the terminal would show on its home screen (e.g. /agent runs): returned, then cleared.
      let lines: string[] | undefined
      if (!e.welcome()) {
        lines = e.home()
        e.goHome()
      }
      if (back !== null) {
        try {
          c.activate(back)
        } catch {
          // the command removed that chat (left a group): nothing is open
        }
      }
      return done(toasts, lines === undefined ? {} : { lines })
    },
  },

  // ---- conversations -------------------------------------------------------------------------------------------------
  'chats.open': {
    run: async (c, a) => {
      const id = chatId(a)
      const limit = int(a.limit, 1, 200, 50)
      const before = opt(a, 'before', 80)
      if (before !== undefined && !KEY_RE.test(before)) throw new ChatsError('invalid', 'before must be a message key')
      const e = c.engine
      if (a.markRead !== false && before === undefined) c.activate(id)
      else c.summary(id)
      const plain = PLAIN.test(id)
      let messages = e.messages(id, plain ? limit + 1 : limit, plain ? before : undefined)
      let hasMore = false
      if (plain && messages.length > limit) {
        messages = messages.slice(messages.length - limit)
        hasMore = true
      }
      const shares = plain ? timelineShares(c, id, hasMore && messages.length > 0 ? messages[0]!.ts : 0) : []
      const timeline = [...messages, ...shares].sort((x, y) => x.ts - y.ts)
      const out: Args = { chat: c.summary(id), messages: timeline, hasMore, call: e.myCall() ?? null }
      if (plain) {
        out.rooms = e.callRooms(id)
        const group = e.groupView(id)
        if (group !== undefined) {
          out.group = group
          out.bots = e.groupBots(id)
        }
      } else if (c.agentsOn) {
        out.agents = await agentsState(c)
        if (id.startsWith('shared:')) out.shared = e.sharedRoom(id.slice('shared:'.length)) ?? null
      }
      return out
    },
  },
  'chats.send': {
    run: async (c, a) => {
      if (a.replyTo !== undefined && a.replyTo !== null) throw new ChatsError('unsupported', 'replies are not part of the Pager chat protocol')
      if (Array.isArray(a.attachments) ? a.attachments.length > 0 : a.attachments !== undefined && a.attachments !== null) throw new ChatsError('unsupported', 'attachments are not part of the Pager chat protocol')
      const text = str(a, 'text')
      return action(c, chatId(a), () => c.engine.send(text))
    },
  },
  'chats.react': {
    run: (c, a) => {
      const key = str(a, 'key', 80)
      if (!KEY_RE.test(key)) throw new ChatsError('invalid', 'key must be a message key')
      return action(c, chatId(a), () => c.engine.react(key, str(a, 'emoji', 40)))
    },
  },
  'chats.read': {
    run: (c, a) => {
      c.activate(chatId(a))
      return {}
    },
  },
  'chats.stop': {
    run: (c, a) => {
      c.activate(chatId(a))
      return { stopped: c.engine.interrupt() }
    },
  },
  'chats.edit': {
    run: () => {
      throw new ChatsError('unsupported', 'editing is not part of the Pager chat protocol')
    },
  },
  'chats.delete': {
    run: () => {
      throw new ChatsError('unsupported', 'deleting is not part of the Pager chat protocol')
    },
  },
  'chats.typing': { run: () => ({ supported: false }) },
  'chats.pin': { run: (c, a) => viewPref(c, a, 'pinned') },
  'chats.mute': { run: (c, a) => viewPref(c, a, 'muted') },
  'chats.archive': { run: (c, a) => viewPref(c, a, 'archived') },

  // ---- contacts and requests -----------------------------------------------------------------------------------------
  'chats.contact.add': {
    run: (c, a) => {
      const code = oneLine(str(a, 'code', 400), 'code')
      if (/\s/.test(code)) throw new ChatsError('invalid', 'code must not contain spaces')
      const note = opt(a, 'note', 200)
      return action(c, undefined, () => c.engine.run(slash('add', code, note === undefined ? undefined : oneLine(note, 'note'))))
    },
  },
  'chats.contact.remove': { run: (c, a) => action(c, undefined, () => c.engine.run(slash('remove', oneLine(str(a, 'peer', 100), 'peer')))) },
  'chats.requests': { run: (c) => c.pending() },
  'chats.request.accept': { run: (c, a) => respond(c, a, 'accept') },
  'chats.request.decline': { run: (c, a) => respond(c, a, 'decline') },
  'chats.ping': {
    run: (c, a) => {
      const peer = opt(a, 'peer', 100)
      return action(c, chatId(a), () => c.engine.run(slash('ping', peer === undefined ? undefined : oneLine(peer, 'peer'))))
    },
  },

  // ---- groups --------------------------------------------------------------------------------------------------------
  'chats.group.new': {
    run: async (c, a) => {
      const r = await action(c, undefined, () => c.engine.run(slash('group', 'new', oneLine(str(a, 'title', 100), 'title'))))
      return { ...r, chatId: c.engine.active() }
    },
  },
  'chats.group.rename': { run: (c, a) => action(c, chatId(a), () => c.engine.run(slash('group', 'rename', oneLine(str(a, 'title', 100), 'title')))) },
  'chats.group.invite': { run: (c, a) => action(c, chatId(a), () => c.engine.run(slash('group', 'invite', oneLine(str(a, 'peer', 100), 'peer')))) },
  'chats.group.leave': { run: (c, a) => action(c, chatId(a), () => c.engine.run(slash('group', 'leave', chatId(a)))) },
  'chats.group.members': {
    run: (c, a) => {
      const g = c.engine.groupView(chatId(a))
      if (g === undefined) throw new ChatsError('not_found', 'not an active group')
      return g
    },
  },

  // ---- bots ----------------------------------------------------------------------------------------------------------
  'chats.bots.list': { run: (c, a) => botsOf(c, chatId(a)) },
  'chats.bots.add': {
    run: (c, a) => {
      needAgents(c)
      const name = botName(a)
      const backend = opt(a, 'backend', 40)
      return botAction(c, a, () => c.engine.run(slash('bot', 'add', name, backend === undefined ? undefined : `@${oneLine(backend, 'backend').replace(/^@/, '')}`, oneLine(str(a, 'job', 1000), 'job'))), name)
    },
  },
  'chats.bots.edit': {
    run: (c, a) => {
      needAgents(c)
      const backend = opt(a, 'backend', 40)
      const job = opt(a, 'job', 1000)
      if (backend === undefined && job === undefined) throw new ChatsError('invalid', 'backend or job is required')
      return botAction(c, a, () => c.engine.run(slash('bot', 'edit', botName(a), backend === undefined ? undefined : `@${oneLine(backend, 'backend').replace(/^@/, '')}`, job === undefined ? undefined : oneLine(job, 'job'))))
    },
  },
  'chats.bots.model': { run: (c, a) => botSetting(c, a, 'model') },
  'chats.bots.effort': { run: (c, a) => botSetting(c, a, 'effort') },
  'chats.bots.remove': {
    run: (c, a) => {
      needAgents(c)
      return botAction(c, a, () => c.engine.run(slash('bot', 'remove', botName(a))))
    },
  },
  'chats.bots.stop': {
    run: (c, a) => {
      needAgents(c)
      return botAction(c, a, () => c.engine.run(slash('bot', 'stop')))
    },
  },

  // ---- calls ---------------------------------------------------------------------------------------------------------
  'chats.call.state': { run: (c) => callState(c) },
  'chats.call.join': {
    run: async (c, a) => {
      const room = opt(a, 'room', 24)
      const r = await action(c, chatId(a), () => c.engine.run(slash('call', room === undefined ? undefined : oneLine(room, 'room').toLowerCase())))
      return { ...r, call: c.engine.myCall() ?? null }
    },
  },
  'chats.call.hangup': { run: (c) => action(c, undefined, () => c.engine.run('/hangup')) },
  'chats.call.mute': {
    run: async (c) => {
      const r = await action(c, undefined, () => c.engine.run('/mute'))
      return { ...r, muted: c.engine.myCall()?.muted ?? false }
    },
  },
  'chats.call.setup': { run: (c) => action(c, undefined, () => c.engine.run('/call setup')) },

  // ---- profile and settings ------------------------------------------------------------------------------------------
  'chats.profile.set': {
    run: async (c, a) => {
      const name = opt(a, 'name', 64)
      const badge = opt(a, 'badge', 40)
      if (name === undefined && badge === undefined) throw new ChatsError('invalid', 'name or badge is required')
      const e = c.engine
      const r = await action(c, undefined, () => {
        if (name !== undefined) e.setName(oneLine(name, 'name'))
        if (badge !== undefined) e.setBadge(badge)
      })
      return { ...r, me: { pk: e.me.pk, code: e.me.code, name: e.me.name, badge: e.settings().badge } }
    },
  },
  'chats.settings.get': { run: (c) => c.engine.settingsView() },
  'chats.settings.set': { run: (c, a) => setSetting(c, a) },

  // ---- agents --------------------------------------------------------------------------------------------------------
  'chats.agents.state': { run: (c) => agentsState(c) },
  'chats.agent.add': {
    run: async (c, a) => {
      needAgents(c)
      const cli = oneLine(str(a, 'cli', 40), 'cli')
      const name = opt(a, 'name', 40)
      return action(c, undefined, async () => {
        const problem = await c.engine.addAgent(cli, name === undefined ? undefined : oneLine(name, 'name'))
        if (problem !== undefined) throw new ChatsError('rejected', problem)
      })
    },
  },
  'chats.agent.remove': {
    run: (c, a) => {
      needAgents(c)
      const name = oneLine(str(a, 'name', 40), 'name')
      return action(c, undefined, () => (c.engine.agentTeam().includes(name) ? c.engine.removeAgent(name) : c.engine.removeAgentOf(name)))
    },
  },
  'chats.agent.custom': {
    run: (c, a) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.addCustomAgent(oneLine(str(a, 'line', 1000), 'line')))
    },
  },
  'chats.agent.recheck': {
    run: (c, a) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.recheckAgent(oneLine(str(a, 'cli', 40), 'cli')))
    },
  },
  'chats.agent.set': {
    run: (c, a) => {
      needAgents(c)
      const name = oneLine(str(a, 'name', 40), 'name')
      const value = str(a, 'value', 200)
      const kind = a.kind
      if (kind === 'color') return action(c, undefined, () => c.engine.setAgentColor(name, value))
      if (kind !== 'model' && kind !== 'effort') throw new ChatsError('invalid', "kind must be 'model', 'effort' or 'color'")
      return action(c, undefined, () => c.engine.setAgentSetting(name, kind, value))
    },
  },
  'chats.agent.choices': {
    run: (c, a) => {
      needAgents(c)
      const kind = a.kind
      if (kind !== 'model' && kind !== 'effort') throw new ChatsError('invalid', "kind must be 'model' or 'effort'")
      const name = oneLine(str(a, 'name', 40), 'name')
      return { settable: c.engine.agentSettable(name, kind), choices: c.engine.agentChoices(name, kind) }
    },
  },
  'chats.agent.config': { run: (c, a) => agentConfig(c, a) },
  'chats.agent.action': {
    run: (c, a) => {
      needAgents(c)
      const kind = a.kind
      if (kind !== 'compact' && kind !== 'reset' && kind !== 'commands' && kind !== 'checkpoints' && kind !== 'check' && kind !== 'usage') throw new ChatsError('invalid', 'unknown agent action')
      const name = opt(a, 'name', 40)
      return action(c, undefined, () => c.engine.agentAction(kind, name))
    },
  },
  'chats.agent.cli': {
    run: (c, a) => {
      needAgents(c)
      if (!Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string')) throw new ChatsError('invalid', 'args must be a list of strings')
      return action(c, undefined, () => c.engine.agentCli(oneLine(str(a, 'name', 40), 'name'), a.args as string[]))
    },
  },
  'chats.agent.commands': {
    run: (c, a) => {
      needAgents(c)
      return c.engine.agentCommands(oneLine(str(a, 'name', 40), 'name'))
    },
  },
  'chats.agent.answer': {
    run: (c, a) => {
      needAgents(c)
      const answers = a.answers === null ? null : a.answers
      if (answers !== null && (typeof answers !== 'object' || Array.isArray(answers) || answers === undefined)) throw new ChatsError('invalid', 'answers must be an object, or null to skip')
      return action(c, opt(a, 'chatId', 100), () => c.engine.answerQuestion(str(a, 'id', 100), answers as Record<string, string | string[]> | null))
    },
  },
  'chats.agent.invite': {
    run: (c, a) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.run(slash('agent', 'invite', oneLine(str(a, 'contact', 100), 'contact'), a.view === true ? '--view' : undefined)))
    },
  },
  'chats.agent.kick': {
    run: (c, a) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.agentKick(oneLine(str(a, 'query', 100), 'query')))
    },
  },
  'chats.agent.leave': {
    run: (c, a) => {
      needAgents(c)
      return action(c, opt(a, 'chatId', 100), () => c.engine.agentLeave(opt(a, 'query', 100) ?? ''))
    },
  },
  'chats.ai.set': {
    run: (c, a) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.setAi(oneLine(str(a, 'key', 40), 'key'), typeof a.value === 'string' ? a.value : ''))
    },
  },
  'chats.ai.clear': {
    run: (c) => {
      needAgents(c)
      return action(c, undefined, () => c.engine.clearAi())
    },
  },

  // ---- documents -----------------------------------------------------------------------------------------------------
  'chats.docs.list': { run: (c) => c.engine.docList() },
  'chats.docs.url': {
    run: async (c, a) => {
      const page = a.page === 'studio' ? 'studio' : undefined
      return { url: await c.engine.docsUrl(page) }
    },
  },
  'chats.docs.get': {
    run: (c, a) => {
      const id = oneLine(str(a, 'id', 100), 'id')
      const info = c.engine.docs.info(id)
      if (info === undefined) throw new ChatsError('not_found', 'no such document')
      return { ...info, where: c.engine.docList().find((d) => d.id === id)?.where, text: c.engine.docs.text(id), editors: c.engine.docEditors(id) }
    },
  },
  'chats.docs.new': {
    run: (c, a) => {
      const made = c.engine.newDoc(oneLine(str(a, 'name', 100), 'name'), opt(a, 'chatId', 100))
      if ('error' in made) throw new ChatsError('rejected', made.error)
      return { id: made.id }
    },
  },
  'chats.docs.set': {
    run: (c, a) => {
      const id = oneLine(str(a, 'id', 100), 'id')
      if (c.engine.docs.info(id) === undefined) throw new ChatsError('not_found', 'no such document')
      if (typeof a.text !== 'string' || a.text.length > 200_000) throw new ChatsError('invalid', 'text is required (max 200000 characters)')
      return { changed: c.engine.docs.setText(id, a.text) }
    },
  },
  'chats.docs.rename': {
    run: (c, a) => {
      const err = c.engine.docs.rename(oneLine(str(a, 'id', 100), 'id'), oneLine(str(a, 'name', 100), 'name'))
      if (err !== null) throw new ChatsError('rejected', err)
      return {}
    },
  },
  'chats.docs.remove': {
    run: (c, a) => {
      const id = oneLine(str(a, 'id', 100), 'id')
      if (c.engine.docs.info(id) === undefined) throw new ChatsError('not_found', 'no such document')
      c.engine.docs.remove(id)
      return {}
    },
  },
  ...shareHandlers,
}

// ---- helpers shared by several handlers ----------------------------------------------------------------------------

function viewPref(c: Ctx, a: Args, kind: 'pinned' | 'muted' | 'archived'): Args {
  const id = chatId(a)
  c.summary(id)
  if (c.prefs.set(kind, id, bool(a, 'on'))) c.touch(kind)
  return {}
}

async function respond(c: Ctx, a: Args, verb: 'accept' | 'decline'): Promise<Args> {
  const pending = c.pending()
  const id = opt(a, 'id', 200)
  const row = id !== undefined ? pending.find((p) => p.id === id) : pending.find((p) => p.n === a.n)
  if (row === undefined) throw new ChatsError('not_found', 'no such pending request')
  return action(c, undefined, () => c.engine.run(`/${verb} ${row.n}`))
}

function botName(a: Args): string {
  const name = oneLine(str(a, 'name', 40), 'name').toLowerCase()
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw new ChatsError('invalid', 'a bot name is lowercase letters, digits, - or _')
  return name
}

function botsOf(c: Ctx, id: string): Args {
  const e = c.engine
  const view = e.aiView()
  return { bots: e.groupBots(id), backends: view?.backends ?? [], default: view?.default ?? '' }
}

async function botAction(c: Ctx, a: Args, fn: () => unknown, _name?: string): Promise<Args> {
  const id = chatId(a)
  const r = await action(c, id, fn)
  return { ...r, ...botsOf(c, id) }
}

function botSetting(c: Ctx, a: Args, kind: 'model' | 'effort'): Promise<Args> {
  needAgents(c)
  const value = a.value === null ? 'default' : oneLine(str(a, 'value', 100), 'value')
  return botAction(c, a, () => c.engine.run(slash('bot', kind, botName(a), value)))
}

async function callState(c: Ctx): Promise<Args> {
  const e = c.engine
  const { findSox } = await import('../calls/audio.js')
  const ready = (await findSox()) !== undefined
  const rooms = e.convs().flatMap((v) => (v.call === undefined ? [] : e.callRooms(v.id).map((r) => ({ chatId: v.id, ...r }))))
  return { call: e.myCall() ?? null, ready, ...(ready ? {} : { hint: 'Calls need SoX: run chats.call.setup to install it' }), rooms }
}

function agentConfig(c: Ctx, a: Args): Promise<Args> {
  needAgents(c)
  const e = c.engine
  const key = a.key
  switch (key) {
    case 'review':
      return action(c, undefined, () => e.setAgentReview(bool(a, 'value')))
    case 'risk':
      return action(c, undefined, () => e.setAgentRisk(bool(a, 'value')))
    case 'goal':
      return action(c, undefined, () => e.setAgentGoal(typeof a.value === 'string' ? a.value : ''))
    case 'verify':
      return action(c, undefined, () => e.setAgentVerify(typeof a.value === 'string' ? a.value : ''))
    case 'budget': {
      const v = a.value as { key?: unknown; text?: unknown } | null
      if (typeof v !== 'object' || v === null || typeof v.key !== 'string' || typeof v.text !== 'string') throw new ChatsError('invalid', 'value must be {key, text}')
      return action(c, undefined, () => e.setAgentBudget(String(v.key), String(v.text)))
    }
    case 'memory': {
      const v = a.value as { action?: unknown; text?: unknown } | null
      if (typeof v !== 'object' || v === null || (v.action !== 'show' && v.action !== 'add' && v.action !== 'clear')) throw new ChatsError('invalid', "value must be {action: 'show'|'add'|'clear', text?}")
      return action(c, undefined, () => e.agentMemory(v.action as 'show' | 'add' | 'clear', typeof v.text === 'string' ? v.text : ''))
    }
    default:
      throw new ChatsError('invalid', 'key must be review, risk, goal, verify, budget or memory')
  }
}

function setSetting(c: Ctx, a: Args): Promise<Args> {
  const e = c.engine
  const key = str(a, 'key', 40)
  const value = a.value
  const text = (): string => (typeof value === 'string' ? value : '')
  const run = (fn: () => void, extra: Args = {}): Promise<Args> => action(c, undefined, fn, () => extra)
  switch (key) {
    case 'notify':
      return run(() => e.setNotify(bool(a, 'value')))
    case 'soundMode':
      return run(() => e.setSoundMode(text()))
    case 'notifySound':
    case 'ringSound':
      return run(() => e.setSoundPreset(key, text()))
    case 'folder.new':
      return run(() => e.folderNew(str(a, 'name', 24)))
    case 'folder.rename':
      return run(() => e.folderRename(str(a, 'from', 24), str(a, 'to', 24)))
    case 'folder.remove':
      return run(() => e.folderRemove(str(a, 'name', 24)))
    case 'folder.move':
      if (a.delta !== -1 && a.delta !== 1) throw new ChatsError('invalid', 'delta must be -1 or 1')
      return run(() => e.folderMove(str(a, 'name', 24), a.delta as -1 | 1))
    case 'folder.file':
      return run(() => e.folderFile(str(a, 'id', 100), a.folder === null ? null : str(a, 'folder', 24)))
    case 'section.toggle':
      return run(() => e.toggleSection(str(a, 'key', 60)))
    default: {
      if (!(TOGGLES as readonly string[]).includes(key)) throw new ChatsError('invalid', `unknown setting: ${key}`)
      return run(() => e.setSetting(key as ToggleKey, bool(a, 'value')), RESTART_KEYS.has(key) ? { restart: true } : {})
    }
  }
}
