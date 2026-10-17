import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConvView } from '../engine.js'
import { agentTabId, sharedTabId } from '../agents/ids.js'
import { ROOM_ID } from '../agents/orchestrator.js'
import { DOCS_ID } from '../docs/store.js'
import { TERM_ID } from '../terminal.js'
import { tabGroups, tabOrder } from './tabs.js'

const conv = (id: string, kind: ConvView['kind']): ConvView => ({ id, kind, title: id, unread: 0, online: true }) as ConvView

test('tab order is people, groups, the agents hub, each agent, then terminal and docs', () => {
  const convs = [conv('g1', 'group'), conv('d1', 'dm'), conv('d2', 'dm')]
  const groups = tabGroups(convs, ['omp', 'claude'])
  assert.deepEqual(groups.chats, ['d1', 'd2', 'g1', ROOM_ID, agentTabId('omp'), agentTabId('claude')])
  assert.deepEqual(groups.tools, [TERM_ID, DOCS_ID])
  assert.deepEqual(tabOrder(groups), [null, 'd1', 'd2', 'g1', ROOM_ID, agentTabId('omp'), agentTabId('claude'), TERM_ID, DOCS_ID])
})

test('with no agents ready the hub is still a tab', () => {
  assert.deepEqual(tabOrder(tabGroups([], [])), [null, ROOM_ID, TERM_ID, DOCS_ID])
})

test('shared agent sessions follow the agent tabs, before terminal and docs', () => {
  const groups = tabGroups([conv('d1', 'dm')], ['omp'], ['ab'.repeat(32)])
  assert.deepEqual(groups.chats, ['d1', ROOM_ID, agentTabId('omp'), sharedTabId('ab'.repeat(32))])
})
