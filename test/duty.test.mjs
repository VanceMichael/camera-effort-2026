import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:http'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { runRound } from '../duty/collect.mjs'
import { planFetches } from '../duty/plan.mjs'
import { computeCoverage, diffProven, parseStreams } from '../duty/coverage.mjs'
import { ProviderClient } from '../duty/provider.mjs'

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

async function makeStateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'duty-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const arrivals = async root => (await (await fetch(root + '/lab')).json()).arrivals
const inStage = (list, stage) => list.filter(a => a.stage === stage)
const gets = (list, path) => list.filter(a => a.method === 'GET' && a.path === path)
const posts = (list, path) => list.filter(a => a.method === 'POST' && a.path.startsWith(path))

test('值班流程:额度只给真实空档,撤并回读后才转派另一处', async t => {
  const sourceRoot = await listen(t, createSource())
  const providerRoot = await listen(t, provider())
  const stateDir = await makeStateDir(t)
  const run = () => runRound({ sourceRoot, providerRoot, windows: ['W1', 'W2'], stateDir })

  // 阶段一:r1 + fog。没有补录画面,缺口没有候选原图,一次取件都不能发生。
  let round = await run()
  let seen = inStage(await arrivals(providerRoot), 'fog')
  assert.equal(gets(seen, '/images/a62').length, 0, '没有候选就不该碰 a62')
  assert.equal(gets(seen, '/images/c62').length, 0, '没有候选就不该碰 c62')
  assert.deepEqual(round.coverage.perWindow.get('W1').proven, [60, 61, 63])
  assert.deepEqual(round.coverage.perWindow.get('W1').gaps, [62, 64])
  assert.deepEqual(round.coverage.perWindow.get('W2').proven, [62, 63, 64], 'J2 已回报,west 64 算覆盖')
  assert.deepEqual(round.coverage.perWindow.get('W2').gaps, [61])
  assert.equal(round.order.取件.length, 0)
  assert.ok(round.order.过岸.some(p => p.单号 === 'J1' && p.动作 === 'keep'), '缺口没填上,J1 必须保留')

  // 阶段二:r2 + fog。补录画面 c62 能填 east 62 的真实空档;a62 被遮挡否掉,不是候选。
  await fetch(sourceRoot + '/control?edition=r2', { method: 'POST' })
  round = await run()
  seen = inStage(await arrivals(providerRoot), 'fog')
  assert.equal(gets(seen, '/images/c62').length, 1, 'c62 领一次')
  assert.equal(gets(seen, '/images/a62').length, 0, 'a62 被遮挡记录否掉,不能为它花额度')
  const fetched = round.order.取件.find(x => x.图 === 'c62')
  assert.equal(fetched.结果, 'fetched')
  assert.equal(fetched.存储代, 'new')
  assert.equal(fetched.画面格, 'east')
  assert.ok(fetched.字节 > 30 && fetched.SHA256)
  assert.deepEqual(round.coverage.perWindow.get('W1').proven, [60, 61, 62, 63, 64])
  // fog 档预约台没有回执接口:没有凭据不能撤并
  assert.equal(posts(seen, '/crossings/withdraw').length, 0)
  assert.ok(round.order.过岸.some(p => p.单号 === 'J1' && p.动作 === 'pending-credential'))
  assert.ok(round.report.includes('可见无鸟'), '看得到但没鸟要单独标出')
  assert.ok(round.report.includes('无可见证据'), '缺口是无可见证据,不是没鸟')

  // 阶段三:clear。回执到了,J1 未出发且缺口已被 c62 证明 → 申请撤并;
  // 但释放没回读确认前,通道不能给另一处;J2 已出发,不能动。
  await fetch(providerRoot + '/lab?stage=clear', { method: 'POST' })
  round = await run()
  seen = inStage(await arrivals(providerRoot), 'clear')
  assert.equal(gets(seen, '/images/c62').length, 0, '已核验的图不重复领')
  const withdraws = posts(seen, '/crossings/withdraw')
  assert.equal(withdraws.length, 1)
  assert.deepEqual(withdraws[0].payload, { job: 'J1', receipt: 'A12' })
  assert.equal(posts(seen, '/crossings/hold').length, 0, '释放未回读,不得转派')
  assert.ok(round.order.过岸.some(p => p.单号 === 'J2' && p.动作 === 'keep'), 'J2 已出发,保留')
  assert.ok(round.stats.hits > 0, '目录重拉应命中 ETag 缓存')

  // 阶段四:released。回读到 J1 释放 → 通道 K 给另一处 west → 新单 J3。
  await fetch(providerRoot + '/lab?stage=released', { method: 'POST' })
  round = await run()
  seen = inStage(await arrivals(providerRoot), 'released')
  const holds = posts(seen, '/crossings/hold')
  assert.equal(holds.length, 1)
  assert.deepEqual(holds[0].payload, { slot: 'K', cell: 'west' })
  assert.ok(round.order.过岸.some(p => p.动作 === 'hold' && p.新单号 === 'J3'))
  assert.equal(round.order.合计.去重后证明分钟, 8, 'east 5 + west 3,相交分钟只算一次')
  assert.deepEqual(round.coverage.perWindow.get('W2').doubles, [64], '岸巡与相机重叠留作两次观察')
  assert.deepEqual(round.order.仍不能覆盖.map(g => g.分钟), [[61]], 'west 61 今天覆盖不了')
  assert.ok(round.order.遮挡失效.some(v => v.相机 === 'A' && v.不再证明覆盖的画面.includes('a62')))

  // 阶段五:再来一轮必须幂等——不重取、不重撤、不重约;补采单仍带着在册预约与已核验原件。
  round = await run()
  seen = inStage(await arrivals(providerRoot), 'released')
  assert.equal(posts(seen, '/crossings/hold').length, 1, '预约不重复提交')
  assert.equal(posts(seen, '/crossings/withdraw').length, 0, '已释放的班次要跳过')
  assert.equal(gets(seen, '/images/c62').length, 0)
  assert.ok(round.order.过岸.some(p => p.动作 === 'hold' && p.新单号 === 'J3'), '在册预约要留在当天补采单上')
  assert.ok(round.order.取件.some(x => x.图 === 'c62' && x.结果 === 'fetched'), '已核验原件要留在当天补采单上')
})

test('共享图只领一次,额度不够时先填真实空档', () => {
  const data = parseStreams({
    windows: [['W1', 'east', '60', '62'], ['W2', 'east', '60', '62']],
    views: [['C', 'east', '60', '62']],
    frames: [],
    recovered: [['C', '60', 'x60', '1'], ['C', '61', 'x61', '1']],
    blocked: [], notes: [], jobs: []
  })
  const windows = data.windows
  const coverage = computeCoverage(data, windows, {})
  const indexItems = new Map([
    ['x60', { id: 'x60', generation: 'new', cell: 'east', path: '/images/x60' }],
    ['x61', { id: 'x61', generation: 'new', cell: 'east', path: '/images/x61' }]
  ])
  const plan = planFetches(coverage, { indexItems, gone: new Set(), remaining: 1 })
  assert.equal(plan.chosen.length, 1, '额度只有一次')
  assert.equal(plan.chosen[0].uses.length, 2, '同一图号被两个观察单共享,只领一次')
  assert.equal(plan.others[0].status, 'pending-quota')
})

test('遮挡更正与批注:批注只改只数,遮挡让原时段失效', () => {
  const data = parseStreams({
    windows: [['W1', 'east', '60', '63']],
    views: [['A', 'east', '60', '63']],
    frames: [['A', '60', 'a60', '0'], ['A', '61', 'a61', '2'], ['A', '62', 'a62', '5']],
    recovered: [],
    blocked: [['A', '61', '63', 'n1']],
    notes: [['a60', 'r1', '3']],
    jobs: []
  })
  const coverage = computeCoverage(data, data.windows, {})
  const cov = coverage.perWindow.get('W1')
  assert.deepEqual(cov.proven, [60], '61、62 被遮挡否掉')
  assert.equal(cov.minutes[0].sources[0].count, 3, '批注更正只数')
  assert.deepEqual(coverage.voided[0].imgs.map(i => i.img), ['a61', 'a62'])
  const lost = diffProven({ W1: [60, 61, 62] }, coverage)
  assert.deepEqual(lost, [{ window: 'W1', reach: 'east', minutes: [61, 62] }], '要知道原来哪段失效了')
})

test('原图领取:410 记失效,截断续传要带 If-Match,换代(412)整件放弃', async t => {
  const png = Buffer.from('fake-png-0123456789')
  const server = createServer((req, res) => {
    if (req.url === '/gone') {
      res.writeHead(410, { 'Content-Type': 'application/json' })
      return res.end('{"error":"已失去原件"}')
    }
    if (req.url === '/flaky') {
      if (!req.headers.range) {
        res.writeHead(200, { 'Content-Length': png.length, ETag: '"v1"' })
        res.write(png.subarray(0, 6))
        return setImmediate(() => res.destroy()) // 半截断线
      }
      assert.equal(req.headers['if-match'], '"v1"', '续传必须钉住同一版本')
      assert.equal(req.headers.range, 'bytes=6-')
      res.writeHead(206, { 'Content-Range': `bytes 6-${png.length - 1}/${png.length}`, ETag: '"v1"' })
      return res.end(png.subarray(6))
    }
    if (req.url === '/replaced') {
      if (!req.headers.range) {
        res.writeHead(200, { 'Content-Length': png.length, ETag: '"v2"' })
        res.write(png.subarray(0, 6))
        return setImmediate(() => res.destroy())
      }
      res.writeHead(412, { ETag: '"v3"' })
      return res.end()
    }
    res.writeHead(404).end()
  })
  const root = await listen(t, server)
  const client = new ProviderClient(root)
  assert.equal((await client.fetchImage({ path: '/gone' })).status, 'gone')
  const resumed = await client.fetchImage({ path: '/flaky' })
  assert.equal(resumed.status, 'fetched')
  assert.deepEqual(resumed.body, png)
  assert.equal((await client.fetchImage({ path: '/replaced' })).status, 'mismatch', '存储代中途被换掉不能算')
})
