// 取件与过岸班次的计划(纯函数,不做 IO)。

// 只取能填真实观察空档的候选原图;同一图号被多个观察单共享只领一次;
// 被遮挡否掉的画面(如挪机/芦苇挡住的机位)不构成候选,不能为它浪费额度。
export function planFetches(coverage, { indexItems, gone, remaining }) {
  const claims = new Map() // 图号 -> { img, cam, uses: [{ window, reach, m }] }
  for (const [id, cov] of coverage.perWindow) {
    for (const min of cov.minutes) {
      if (min.sources.length > 0) continue
      for (const c of min.claims) {
        if (!claims.has(c.img)) claims.set(c.img, { img: c.img, cam: c.cam, uses: [] })
        claims.get(c.img).uses.push({ window: id, reach: cov.window.reach, m: min.m })
      }
    }
  }
  const entries = []
  for (const claim of claims.values()) {
    const listed = indexItems.get(claim.img)
    if (gone.has(claim.img)) {
      entries.push({ ...claim, status: 'gone', reason: '原图已失效(410),不再重试' })
    } else if (!listed) {
      entries.push({ ...claim, status: 'unlisted', reason: '本轮原图目录未开放该件' })
    } else if (!claim.uses.every(u => u.reach === listed.cell)) {
      entries.push({ ...claim, status: 'cell-mismatch', reason: `画面格${listed.cell}对不到指定水面` })
    } else {
      entries.push({ ...claim, status: 'fetchable', generation: listed.generation, cell: listed.cell, path: listed.path })
    }
  }
  const fetchable = entries
    .filter(e => e.status === 'fetchable')
    .sort((a, b) => b.uses.length - a.uses.length ||
      Math.min(...a.uses.map(u => u.m)) - Math.min(...b.uses.map(u => u.m)))
  const budget = Math.max(0, remaining ?? 0)
  const chosen = fetchable.slice(0, budget)
  const queued = fetchable.slice(budget)
    .map(e => ({ ...e, status: 'pending-quota', reason: `本轮剩余取件${budget}次,排到下一轮` }))
  return { chosen, others: [...entries.filter(e => e.status !== 'fetchable'), ...queued] }
}

// 过岸班次处置:
// - 已出发班次一律保留,不自动清除
// - 缺口已由补取原图证明的未出发班次,凭受理凭据申请撤并
// - 没有受理凭据只能等预约台回执,不能凭空撤
export function planPatrol(data, coverage, windows, { slots, receipts }, state) {
  const receiptsByJob = new Map((receipts ?? []).map(r => [r.job, r]))
  const slotByOccupant = new Map((slots ?? []).filter(s => s.occupied).map(s => [s.occupied, s]))
  const actions = []
  for (const w of windows) {
    const cov = coverage.perWindow.get(w.id)
    for (const j of data.jobs.filter(j => j.window === w.id)) {
      const receipt = receiptsByJob.get(j.id)
      const recState = receipt?.state ?? null
      const tracked = state.jobs[j.id]
      const jobMinutes = []
      for (let m = Math.max(j.from, w.from); m < Math.min(j.until, w.until); m++) jobMinutes.push(m)
      const provenElsewhere = jobMinutes.length > 0 && jobMinutes.every(m => {
        const min = cov.minutes.find(x => x.m === m)
        return min?.sources.some(s => !(s.kind === 'patrol' && s.job === j.id))
      })
      const base = {
        job: j.id, window: w.id, reach: w.reach, from: j.from, until: j.until,
        catalogStatus: j.status, receiptState: recState, reported: j.reported
      }
      if (tracked?.released) {
        actions.push({ ...base, action: 'released', reason: '已撤并并回读到释放结果' })
      } else if (recState === 'departed') {
        actions.push({ ...base, action: 'keep', reason: '已出发班次保留,不自动清除' })
      } else if (j.status === 'done') {
        actions.push({ ...base, action: 'keep', reason: '现场已回报,留作观察证据' })
      } else if (!provenElsewhere) {
        actions.push({ ...base, action: 'keep', reason: '对应缺口尚未由其他证据填满,班次保留' })
      } else if (tracked?.withdrawn) {
        actions.push({ ...base, action: 'pending-readback', reason: '撤并已申请,待回读释放结果' })
      } else if (!receipt) {
        actions.push({ ...base, action: 'pending-credential', reason: '预约台尚无受理凭据,暂不能撤并' })
      } else if (recState === 'reserved' || recState === 'received') {
        actions.push({
          ...base, action: 'withdraw', receiptCredential: receipt.receipt,
          slot: slotByOccupant.get(j.id)?.id ?? null,
          reason: '缺口已由补取原图证明,未出发班次申请撤并'
        })
      } else {
        actions.push({ ...base, action: 'keep', reason: `回执状态 ${recState},不动作` })
      }
    }
  }
  return actions
}

// 通道释放后,这个时段给另一处:候选水面不能是刚撤下班次所在的水面,
// 且在该通道可达时段内确有补采需要(未覆盖优先,其次单一来源留作两次观察)。
export function reallocationNeeds(coverage, windows, slot, excludeCell) {
  const needs = []
  for (const w of windows) {
    if (w.reach === excludeCell) continue
    const from = Math.max(w.from, slot.from)
    const until = Math.min(w.until, slot.until)
    if (from >= until) continue
    const cov = coverage.perWindow.get(w.id)
    const uncovered = []
    const single = []
    for (let m = from; m < until; m++) {
      const min = cov.minutes.find(x => x.m === m)
      if (!min || min.sources.length === 0) uncovered.push(m)
      else if (min.sources.length === 1) single.push(m)
    }
    if (uncovered.length || single.length) needs.push({ cell: w.reach, window: w.id, uncovered, single })
  }
  return needs.sort((a, b) =>
    b.uncovered.length - a.uncovered.length ||
    b.single.length - a.single.length ||
    a.cell.localeCompare(b.cell))
}
