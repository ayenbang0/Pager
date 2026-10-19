import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPrivateHost } from './host.js'

test('private and local hosts', () => {
  for (const h of ['localhost', 'LOCALHOST', 'printer.local', 'a.b.local', '127.0.0.1', '127.255.0.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '', 'foo.localhost', 'localhost.']) {
    assert.equal(isPrivateHost(h), true, h)
  }
})

test('public hosts', () => {
  for (const h of ['example.com', 'duckduckgo.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.253.0.1', '2606:4700::1111', 'fec0::1', '::ffff:8.8.8.8', 'localhost.example.com', 'notlocal']) {
    assert.equal(isPrivateHost(h), false, h)
  }
})
