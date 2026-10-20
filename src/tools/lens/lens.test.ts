import assert from 'node:assert/strict'
import { test } from 'node:test'
import { segsWidth } from '../../ui/kit/segs.js'
import { DEFAULT_THEME as theme } from '../../ui/theme/themes.js'
import { lensFor, programOf, renderLens, sparkline } from './lens.js'

const UNIX_PING = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=11.2 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=12.8 ms
64 bytes from 93.184.216.34: icmp_seq=3 ttl=56 time=10.1 ms

--- example.com ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 10.100/11.367/12.800/1.119 ms
`

const WIN_PING = `Pinging example.com [93.184.216.34] with 32 bytes of data:
Reply from 93.184.216.34: bytes=32 time=12ms TTL=56
Reply from 93.184.216.34: bytes=32 time<1ms TTL=56
Request timed out.
Reply from 93.184.216.34: bytes=32 time=14ms TTL=56

Ping statistics for 93.184.216.34:
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
Approximate round trip times in milli-seconds:
    Minimum = 0ms, Maximum = 14ms, Average = 8ms
`

test('programOf strips sudo, env words, paths and .exe, and rejects compound lines', () => {
  assert.deepEqual(programOf('sudo FOO=1 /usr/bin/Ping.exe -c 3 host'), { name: 'ping', args: ['-c', '3', 'host'] })
  for (const c of ['ping a | tee x', 'ping a && ls', 'ping a; ls', 'ping a > out', '']) assert.equal(programOf(c), null, c)
})

test('ping, Unix flavor', () => {
  const d = lensFor('ping -c 3 example.com', UNIX_PING)
  assert.equal(d?.title, 'ping example.com')
  assert.deepEqual(d?.badges, [{ text: '0% loss', tone: 'good' }])
  assert.deepEqual(d?.kv.find(([k]) => k === 'avg'), ['avg', '11.37 ms'])
  assert.deepEqual(d?.spark?.values, [11.2, 12.8, 10.1])
})

test('ping, Windows flavor with a timeout and time<1ms', () => {
  const d = lensFor('ping -n 4 example.com', WIN_PING)
  assert.deepEqual(d?.badges, [{ text: '25% loss', tone: 'bad' }])
  assert.deepEqual(d?.kv.find(([k]) => k === 'max'), ['max', '14 ms'])
  assert.deepEqual(d?.kv.find(([k]) => k === 'sent'), ['sent', '4'])
  assert.deepEqual(d?.spark?.values, [12, 1, 14])
})

test('ping without a summary falls back', () => {
  assert.equal(lensFor('ping example.com', '64 bytes from x: icmp_seq=1 ttl=5 time=1 ms\n'), null)
  assert.equal(lensFor('ping example.com', 'ping: unknown host example.com\n'), null)
})

test('total loss is a bad badge', () => {
  const out = 'PING x (1.1.1.1) 56(84) bytes of data.\n\n--- x ping statistics ---\n2 packets transmitted, 0 received, 100% packet loss, time 1001ms\n'
  const d = lensFor('ping -c2 x', out)
  assert.deepEqual(d?.badges, [{ text: '100% loss', tone: 'bad' }])
  assert.equal(d?.spark, undefined)
})

const DIG = `; <<>> DiG 9.18 <<>> example.com
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; QUESTION SECTION:
;example.com.			IN	A

;; ANSWER SECTION:
example.com.		300	IN	A	93.184.216.34
example.com.		300	IN	A	93.184.216.35

;; Query time: 23 msec
;; SERVER: 1.1.1.1#53(1.1.1.1) (UDP)
`

test('dig answers and failures', () => {
  const d = lensFor('dig example.com', DIG)
  assert.equal(d?.title, 'dig example.com')
  assert.deepEqual(d?.badges, [{ text: 'NOERROR', tone: 'good' }])
  assert.deepEqual(d?.kv, [['server', '1.1.1.1#53(1.1.1.1)'], ['query time', '23 ms']])
  assert.deepEqual(d?.table?.rows[1], ['example.com.', '300', 'A', '93.184.216.35'])
  const nx = lensFor('dig nope.invalid', ';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1\n\n;; Query time: 5 msec\n')
  assert.deepEqual(nx?.badges, [{ text: 'NXDOMAIN', tone: 'bad' }])
  assert.equal(nx?.table, undefined)
  assert.equal(lensFor('dig example.com', 'connection timed out; no servers could be reached\n'), null)
})

const CURL = `HTTP/2 301 \r
location: https://example.com/\r
content-type: text/html\r
server: nginx\r
\r
`

test('curl needs a header flag and a status line; -v strips the < prefix', () => {
  const d = lensFor('curl -sI http://example.com', CURL)
  assert.equal(d?.title, 'curl http://example.com')
  assert.deepEqual(d?.badges, [{ text: '301', tone: 'warn' }])
  assert.deepEqual(d?.kv, [['content-type', 'text/html'], ['server', 'nginx'], ['location', 'https://example.com/']])
  assert.equal(lensFor('curl http://example.com', CURL), null)
  const v = lensFor('curl -v https://example.com', '* Trying 1.2.3.4...\n> GET / HTTP/2\n> Host: example.com\n\n< HTTP/2 200\n< content-type: text/plain\n< content-length: 5\n<\nhello')
  assert.deepEqual(v?.badges, [{ text: '200', tone: 'good' }])
  assert.deepEqual(v?.table?.rows, [['content-type', 'text/plain'], ['content-length', '5']])
  assert.equal(lensFor('curl -i https://x', 'curl: (6) Could not resolve host: x\n'), null)
})

test('traceroute, Unix flavor', () => {
  const out = `traceroute to example.com (93.184.216.34), 30 hops max, 60 byte packets
 1  gateway (192.168.1.1)  1.2 ms  1.1 ms  1.0 ms
 2  * * *
 3  example.com (93.184.216.34)  11.0 ms  12.0 ms  13.0 ms
`
  const d = lensFor('traceroute example.com', out)
  assert.deepEqual(d?.badges, [{ text: 'reached', tone: 'good' }])
  assert.deepEqual(d?.table?.rows, [['1', 'gateway (192.168.1.1)', '1.1'], ['2', '*', '*'], ['3', 'example.com (93.184.216.34)', '12']])
})

test('tracert, Windows flavor, stops short', () => {
  const out = `Tracing route to example.com [93.184.216.34]
over a maximum of 30 hops:

  1    <1 ms    <1 ms    <1 ms  router.lan [192.168.1.1]
  2     *        *        *     Request timed out.
  3    14 ms    15 ms    16 ms  10.0.0.1

Trace complete.
`
  const d = lensFor('tracert example.com', out)
  assert.deepEqual(d?.badges, [{ text: 'incomplete', tone: 'warn' }])
  assert.deepEqual(d?.table?.rows, [['1', 'router.lan [192.168.1.1]', '0.5'], ['2', '*', '*'], ['3', '10.0.0.1', '15']])
  assert.equal(lensFor('traceroute x', 'traceroute: unknown host x\n'), null)
})

test('unknown programs and compound lines have no lens', () => {
  assert.equal(lensFor('ls -l', 'total 0\n'), null)
  assert.equal(lensFor('ping example.com | cat', UNIX_PING), null)
})

test('sparkline scales between min and max; renderLens rows are exactly the width', () => {
  assert.equal(sparkline([1, 8]), '▁█')
  assert.equal(sparkline([5, 5]), '▁▁')
  const data = lensFor('dig example.com', DIG)
  assert.ok(data)
  for (const width of [80, 40, 20]) for (const row of renderLens(data, width, theme)) assert.equal(segsWidth(row), width)
  const ping = lensFor('ping -c 3 example.com', UNIX_PING)
  assert.ok(ping)
  const rows = renderLens(ping, 60, theme).map((r) => r.map((s) => s.text).join(''))
  assert.ok(rows[0]?.includes('ping example.com') && rows[0]?.includes('0% loss'))
  assert.ok(rows.some((r) => r.includes('rtt') && /[▁-█]/.test(r)))
})
