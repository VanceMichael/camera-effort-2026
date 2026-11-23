// 值班采集工具:给它今天关心的水面和时窗,在还来得及的时候领相机原图,当天出补采单。
//
//   node duty/collect.mjs [--window W1 --window W2] [--surface east:60-65]
//                         [--source http://127.0.0.1:8700] [--provider http://127.0.0.1:8701]
//                         [--state .duty-state] [--out 目录] [--settle 毫秒] [--json]
//
// 一轮的动作:核覆盖 → 按真实空档取原图(额度有限,共享图只领一次) →
// 重核覆盖 → 过岸班次处置(撤并需凭据、释放需回读、已出发保留) → 出补采单与值班报告。
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { SourceClient } from './source.mjs'
import { ProviderClient } from './provider.mjs'
import { computeCoverage, diffProven, mergeMinutes, parseStreams } from './coverage.mjs'
import { planFetches, planPatrol, reallocationNeeds } from './plan.mjs'
import { buildOrder, renderReport } from './report.mjs'
import { loadState, saveState } from './state.mjs'

const STREAMS = ['windows', 'views', 'frames', 'recovered', 'blocked', 'notes', 'jobs']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = body => createHash('sha256').update(body).digest('hex')

export async function runRound(options) {
  const now = options.now ?? new Date()
  const date = options.date ?? now.toISOString().slice(0, 10)
  const stateDir = options.stateDir
  const outDir = options.outDir ?? stateDir
  const settleMs = options.settleMs ?? 0

  const state = await loadState(stateDir)
  const cache = new Map(Object.entries(state.cache))
  const source = new SourceClient(options.sourceRoot, cache)
  const provider = new ProviderClient(options.providerRoot)

  // 目录快照:钉定同一资料版,逐页领全部分析用到的流
  const catalog = await source.catalog()
  const edition = catalog.edition
  const raw = {}
  for (const name of STREAMS) {
    raw[name] = catalog.streams.includes(name) ? (await source.stream(name, { edition })) ?? [] : []
  }
  const data = parseStreams(raw)

  // 今天关心的水面与时窗:观察单编号,或临时 水面:起-止
  let windows = data.windows
  if (options.windows?.length) {
    const missing = options.windows.filter(id => !data.windows.some(w => w.id === id))
    if (missing.length) throw new Error(`没有该观察单: ${missing.join(',')}(现有 ${data.windows.map(w => w.id).join('、')})`)
    windows = data.windows.filter(w => options.windows.includes(w.id))
  }
  const adhoc = (options.surfaces ?? []).map((text, i) => {
    const m = /^(\S+):(\d+)-(\d+)$/.exec(text)
    if (!m) throw new Error(`水面时窗格式应为 名称:起-止,收到 ${text}`)
    return { id: `S${i + 1}`, reach: m[1], from: Number(m[2]), until: Number(m[3]) }
  })
  windows = [...windows, ...adhoc]

  // 证据台账:已核验原图、已失效图号、本轮原图目录
  const fetched = new Map(Object.entries(state.fetched))
  const gone = new Set(Object.keys(state.gone))
  const index = await provider.index().catch(() => null)
  const indexItems = new Map((index?.items ?? []).map(item => [item.id, item]))
  const evidence = { fetched, indexItems, receiptsByJob: new Map() }

  let coverage = computeCoverage(data, windows, evidence)

  // 取件:只取能填真实观察空档的候选,共享图只领一次,额度用尽即停
  const fetchPlan = planFetches(coverage, { indexItems, gone, remaining: index?.remaining ?? 0 })
  const fetchResults = []
  for (const item of fetchPlan.chosen) {
    const res = await provider.fetchImage(item)
    if (res.status === 'fetched') {
      const record = {
        generation: item.generation, cell: item.cell, etag: res.etag,
        bytes: res.bytes, sha256: sha256(res.body), complete: true,
        verifiedAt: now.toISOString()
      }
      state.fetched[item.img] = record
      fetched.set(item.img, record)
      fetchResults.push({ ...item, status: 'fetched', etag: res.etag, bytes: res.bytes, sha256: record.sha256 })
    } else if (res.status === 'gone') {
      state.gone[item.img] = { at: now.toISOString() }
      gone.add(item.img)
      fetchResults.push({ ...item, status: 'gone', reason: '原图已失效(410)' })
    } else if (res.status === 'quota') {
      fetchResults.push({ ...item, status: 'pending-quota', reason: '本轮取件额度已尽' })
      break
    } else {
      fetchResults.push({ ...item, status: res.status, reason: '未完整核验,不算观察' })
    }
  }

  // 过岸班次:受理回执与通道占用
  const [slots, receipts] = await Promise.all([
    provider.slots().catch(() => null),
    provider.receipts().catch(() => null)
  ])
  evidence.receiptsByJob = new Map((receipts ?? []).map(r => [r.job, r]))

  // 补取原图可能已填上缺口,重核后再决定班次去留
  coverage = computeCoverage(data, windows, evidence)

  const patrolActions = planPatrol(data, coverage, windows, { slots, receipts }, state)
  const patrolEntries = []
  for (const action of patrolActions) {
    if (action.action !== 'withdraw') {
      patrolEntries.push(action)
      continue
    }
    const res = await provider.withdraw(action.job, action.receiptCredential)
    if (res.status === 202) {
      state.jobs[action.job] = {
        withdrawn: true, released: false,
        requestReceipt: res.body?.receipt ?? null,
        slot: action.slot, cell: action.reach, at: now.toISOString()
      }
      patrolEntries.push({ ...action, note: `撤并申请已受理(凭据${state.jobs[action.job].requestReceipt}),待回读释放结果` })
    } else if (res.status === 409) {
      patrolEntries.push({ ...action, action: 'keep', note: '回执显示已出发,撤并被拒,班次保留' })
    } else {
      patrolEntries.push({ ...action, action: 'withdraw-failed', note: `撤并请求未被受理(${res.status})` })
    }
  }

  // 回读释放结果:只有 receipts 确认 released,通道时段才能给另一处
  const readBack = async () => {
    const pending = Object.entries(state.jobs).filter(([, t]) => t.withdrawn && !t.released)
    if (!pending.length) return receipts
    const deadline = Date.now() + settleMs
    let current = receipts
    for (;;) {
      current = (await provider.receipts().catch(() => current)) ?? current
      for (const [job, tracked] of pending) {
        const rec = (current ?? []).find(r => r.job === job && r.state === 'released')
        if (rec) {
          tracked.released = true
          tracked.releaseReceipt = rec.receipt
        }
      }
      if (Object.values(state.jobs).every(t => !t.withdrawn || t.released)) return current
      if (Date.now() >= deadline) return current
      await sleep(250)
    }
  }
  const finalReceipts = await readBack()

  // 释放出来的通道,转派给另一处确有补采需要的水面
  const holdEntries = []
  const slotsNow = (await provider.slots().catch(() => null)) ?? slots
  for (const tracked of Object.values(state.jobs)) {
    if (!tracked.released || tracked.reallocated || !tracked.slot) continue
    const slot = (slotsNow ?? []).find(s => s.id === tracked.slot)
    if (!slot || slot.occupied) {
      holdEntries.push({ action: 'hold-pending', slot: tracked.slot, reason: '通道仍被占用或暂不可见,下轮再试' })
      continue
    }
    const best = reallocationNeeds(coverage, windows, slot, tracked.cell)[0]
    if (!best) {
      tracked.reallocated = true
      holdEntries.push({ action: 'release-unused', slot: slot.id, reason: '其他水面在该时段没有补采需要,通道留空' })
      continue
    }
    const key = `${slot.id}/${best.cell}`
    if (state.holds[key]) {
      tracked.reallocated = true
      continue
    }
    const res = await provider.hold(slot.id, best.cell)
    if (res.status === 200 || res.status === 201) {
      state.holds[key] = {
        job: res.body?.job ?? null, slot: slot.id, cell: best.cell,
        state: res.body?.state ?? 'reserved', for: best, at: now.toISOString()
      }
      tracked.reallocated = true
      holdEntries.push({ action: 'hold', slot: slot.id, cell: best.cell, job: state.holds[key].job, for: best })
    } else {
      holdEntries.push({ action: 'hold-failed', slot: slot.id, cell: best.cell, reason: `预约未被受理(${res.status})` })
    }
  }

  // 遮挡/资料更正后,原来哪段的覆盖失效了
  const invalidated = diffProven(state.lastProven, coverage)
  state.lastProven = Object.fromEntries([...coverage.perWindow].map(([id, cov]) => [id, cov.proven]))
  state.lastEdition = edition

  // 缺口明细:可再从哪里取证、过岸通道可达性、现场单占用
  const gapDetails = []
  for (const [id, cov] of coverage.perWindow) {
    for (const range of mergeMinutes(cov.gaps)) {
      const minutes = []
      for (let m = range.from; m < range.until; m++) minutes.push(m)
      const claims = new Map()
      for (const m of minutes) {
        for (const c of cov.minutes.find(x => x.m === m).claims) claims.set(c.img, c)
      }
      const reachable = (slotsNow ?? []).filter(s =>
        s.cells.includes(cov.window.reach) && s.from < range.until && range.from < s.until)
      const planned = data.jobs.filter(j =>
        j.window === id && j.status !== 'done' && j.from < range.until && range.from < j.until)
      const parts = []
      for (const [img] of claims) {
        const listed = indexItems.get(img)
        parts.push(listed
          ? `可补取图${img}(存储代${listed.generation},格${listed.cell},本轮剩余取件${index?.remaining ?? 0})`
          : gone.has(img) ? `图${img}原图已失效` : `图${img}本轮目录未开放`)
      }
      if (!claims.size) parts.push('无可取原图')
      parts.push(reachable.length
        ? reachable.map(s => `过岸${s.id} ${s.from}–${s.until}可达${cov.window.reach}${s.occupied ? `(被${s.occupied}占用)` : '(空闲)'}`).join(';')
        : '过岸班次够不到该时段')
      if (planned.length) parts.push(`现场单${planned.map(j => j.id).join('、')}已登记(${planned.map(j => j.status).join('/')})`)
      const disposition = [...claims.keys()].some(img => indexItems.has(img)) ? 'fetchable'
        : reachable.some(s => !s.occupied) ? 'patrolable'
          : planned.length ? 'job-planned'
            : 'uncoverable'
      gapDetails.push({
        window: id, reach: cov.window.reach, from: range.from, until: range.until,
        minutes, disposition, reason: parts.join(';')
      })
    }
  }

  // 现场单现状:目录状态 + 预约台回执 + 本机撤并/预约台账
  const receiptsByJob = new Map((finalReceipts ?? []).map(r => [r.job, r]))
  const jobView = []
  for (const w of windows) {
    for (const j of data.jobs.filter(j => j.window === w.id)) {
      const rec = receiptsByJob.get(j.id)
      const tracked = state.jobs[j.id]
      const parts = [`${j.id} ${j.window} ${j.from}–${j.until} 目录:${j.status}`]
      if (j.reported != null) parts.push(`回报${j.reported}只`)
      if (rec) parts.push(`预约台:${rec.state}(凭据${rec.receipt})`)
      if (tracked?.released) parts.push(`已撤并释放(回读凭据${tracked.releaseReceipt})`)
      else if (tracked?.withdrawn) parts.push('撤并申请已提交,待回读')
      else if (rec?.state === 'departed') parts.push('已出发,保留')
      jobView.push(parts.join(' · '))
    }
  }
  for (const h of Object.values(state.holds)) {
    jobView.push(`${h.job ?? '?'} 通道${h.slot}/${h.cell} 预约台:${h.state}(为观察单${h.for.window}补${h.for.uncovered.concat(h.for.single).join('、')}分钟)`)
  }

  state.cache = Object.fromEntries(cache)
  await saveState(stateDir, state)

  // 补采单是当天的活文档:本轮动作之外,在册的预约与已核验原件也要带上
  const fetchEntries = [...fetchResults, ...fetchPlan.others]
  for (const [img, record] of Object.entries(state.fetched)) {
    if (fetchEntries.some(e => e.img === img)) continue
    const uses = []
    for (const [id, cov] of coverage.perWindow) {
      for (const min of cov.minutes) {
        if (min.sources.some(s => s.img === img)) uses.push({ window: id, reach: cov.window.reach, m: min.m })
      }
    }
    fetchEntries.push({
      img, generation: record.generation, cell: record.cell, uses,
      status: 'fetched', etag: record.etag, bytes: record.bytes, sha256: record.sha256,
      reason: `前轮已核验(${record.verifiedAt})`
    })
  }
  const standingHolds = Object.values(state.holds)
    .filter(h => !holdEntries.some(e => e.action === 'hold' && e.slot === h.slot && e.cell === h.cell))
    .map(h => ({ action: 'hold', slot: h.slot, cell: h.cell, job: h.job, for: h.for, reason: `预约在册(${h.state})` }))
  const model = {
    date, edition, coverage, fetchEntries, patrolEntries,
    holdEntries: [...holdEntries, ...standingHolds],
    gapDetails, jobView, invalidated, state
  }
  const order = buildOrder(model)
  await mkdir(outDir, { recursive: true })
  const orderPath = join(outDir, `order-${date}.json`)
  await writeFile(orderPath, JSON.stringify(order, null, 2))
  const report = renderReport({ ...model, orderPath }, order)
  return { order, report, orderPath, coverage, state, stats: source.stats }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: 'http://127.0.0.1:8700' },
      provider: { type: 'string', default: 'http://127.0.0.1:8701' },
      window: { type: 'string', multiple: true },
      surface: { type: 'string', multiple: true },
      state: { type: 'string', default: '.duty-state' },
      out: { type: 'string' },
      settle: { type: 'string', default: '0' },
      json: { type: 'boolean', default: false }
    }
  })
  try {
    const { order, report, orderPath } = await runRound({
      sourceRoot: values.source,
      providerRoot: values.provider,
      windows: values.window,
      surfaces: values.surface,
      stateDir: values.state,
      outDir: values.out,
      settleMs: Number(values.settle)
    })
    console.log(report)
    if (values.json) console.log('\n' + JSON.stringify(order, null, 2))
    else console.error(`(补采单: ${orderPath})`)
  } catch (error) {
    console.error(`值班采集失败: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
