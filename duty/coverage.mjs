// 覆盖核算:把目录资料算成每个观察单每分钟的有效证据。
// 规则(来自资料格式与值班约定):
// - 每行画面只证明对应的一分钟;单图批注只更正只数,不改变覆盖
// - 有现场遮挡记录的相机图不能证明该分钟覆盖(遮挡更正后,原时段覆盖失效)
// - 相机挪机后画面格对不上:画面只算到该分钟相机实际对着的水面
// - 补录(recovered)画面必须已完整取回原件、存储代与目录一致、画面格对得到该水面,才算观察
// - 看得到但没鸟(只数为 0)是有效覆盖;没有可见证据才是缺口
// - 相交水面同一分钟只算一次(总计按 水面@分钟 去重)

export function parseStreams(raw) {
  return {
    windows: (raw.windows ?? []).map(r => ({ id: r[0], reach: r[1], from: Number(r[2]), until: Number(r[3]) })),
    views: (raw.views ?? []).map(r => ({ cam: r[0], reach: r[1], from: Number(r[2]), until: Number(r[3]) })),
    frames: (raw.frames ?? []).map(r => ({ cam: r[0], minute: Number(r[1]), img: r[2], count: Number(r[3]) })),
    recovered: (raw.recovered ?? []).map(r => ({ cam: r[0], minute: Number(r[1]), img: r[2], count: Number(r[3]) })),
    blocked: (raw.blocked ?? []).map(r => ({ cam: r[0], from: Number(r[1]), until: Number(r[2]), note: r[3] })),
    notes: new Map((raw.notes ?? []).map(r => [r[0], { note: r[1], count: Number(r[2]) }])),
    jobs: (raw.jobs ?? []).map(r => ({
      id: r[0], window: r[1], from: Number(r[2]), until: Number(r[3]),
      status: r[4], reported: r[5] === '-' || r[5] === undefined ? null : Number(r[5])
    }))
  }
}

export function computeCoverage(data, windows, evidence = {}) {
  const fetched = evidence.fetched ?? new Map()
  const indexItems = evidence.indexItems ?? new Map()
  const receipts = evidence.receiptsByJob ?? new Map()

  const reachesAt = (cam, m) =>
    data.views.filter(v => v.cam === cam && v.from <= m && m < v.until).map(v => v.reach)
  const blockAt = (cam, m) =>
    data.blocked.find(b => b.cam === cam && b.from <= m && m < b.until) ?? null

  // 遮挡失效段:被现场遮挡记录覆盖的相机画面,原来证明的时段失效
  const voided = data.blocked.map(b => ({
    cam: b.cam,
    from: b.from,
    until: b.until,
    note: b.note,
    reaches: [...new Set(data.views
      .filter(v => v.cam === b.cam && v.from < b.until && b.from < v.until)
      .map(v => v.reach))],
    imgs: [...data.frames, ...data.recovered]
      .filter(row => row.cam === b.cam && b.from <= row.minute && row.minute < b.until)
      .map(row => ({ img: row.img, minute: row.minute }))
  }))

  const perWindow = new Map()
  for (const w of windows) {
    const minutes = []
    for (let m = w.from; m < w.until; m++) {
      const sources = []
      const claims = [] // 有候选画面但原图尚未核验,可再取证
      for (const f of data.frames) {
        if (f.minute !== m || blockAt(f.cam, m)) continue
        if (!reachesAt(f.cam, m).includes(w.reach)) continue
        const note = data.notes.get(f.img)
        sources.push({
          kind: 'frame', cam: f.cam, img: f.img,
          count: note ? note.count : f.count,
          corrected: Boolean(note), noteId: note?.note ?? null
        })
      }
      for (const r of data.recovered) {
        if (r.minute !== m || blockAt(r.cam, m)) continue
        if (!reachesAt(r.cam, m).includes(w.reach)) continue
        const got = fetched.get(r.img)
        const listed = indexItems.get(r.img)
        const stale = got && listed && listed.generation !== got.generation
        if (got?.complete && got.cell === w.reach && !stale) {
          sources.push({
            kind: 'recovered', cam: r.cam, img: r.img, count: r.count,
            generation: got.generation, etag: got.etag
          })
        } else {
          claims.push({
            kind: 'recovered', cam: r.cam, img: r.img,
            reason: !got ? '未取原图'
              : !got.complete ? '下载不完整'
                : stale ? '存储代已被站点替换'
                  : got.cell !== w.reach ? `画面格${got.cell}对不到${w.reach}`
                    : '未核验'
          })
        }
      }
      for (const j of data.jobs) {
        if (j.window !== w.id || !(j.from <= m && m < j.until) || j.status !== 'done') continue
        sources.push({ kind: 'patrol', job: j.id, reported: j.reported, state: receipts.get(j.id)?.state ?? null })
      }
      minutes.push({ m, sources, claims })
    }
    const proven = minutes.filter(x => x.sources.length > 0).map(x => x.m)
    const gaps = minutes.filter(x => x.sources.length === 0).map(x => x.m)
    const doubles = minutes.filter(x => x.sources.length > 1).map(x => x.m)
    const zeroBird = minutes
      .filter(x => x.sources.length > 0 && x.sources.every(s => (s.count ?? s.reported ?? 0) === 0))
      .map(x => x.m)
    perWindow.set(w.id, { window: w, minutes, proven, gaps, doubles, zeroBird })
  }

  // 相交水面同一分钟只算一次
  const unionSet = new Set()
  for (const { window, proven } of perWindow.values()) {
    for (const m of proven) unionSet.add(`${window.reach}@${m}`)
  }

  return { perWindow, voided, unionMinutes: unionSet.size }
}

// 上一轮已证明、这一轮不再成立的分钟(遮挡更正/资料版更新后要知道哪段失效了)
export function diffProven(lastProven, coverage) {
  const lost = []
  for (const [id, cov] of coverage.perWindow) {
    const before = new Set(lastProven[id] ?? [])
    const now = new Set(cov.proven)
    const gone = [...before].filter(m => !now.has(m)).sort((a, b) => a - b)
    if (gone.length) lost.push({ window: id, reach: cov.window.reach, minutes: gone })
  }
  return lost
}

// 连续分钟并成左闭右开段,便于展示
export function mergeMinutes(minutes) {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b)
  const ranges = []
  for (const m of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && last.until === m) last.until = m + 1
    else ranges.push({ from: m, until: m + 1 })
  }
  return ranges
}

// 按来源签名把一窗的分钟并成段
export function segmentsOf(minutes) {
  const out = []
  for (const min of minutes) {
    const sig = min.sources.map(s => `${s.kind}:${s.cam ?? s.job ?? ''}:${s.img ?? ''}`).join('|') || 'gap'
    const last = out[out.length - 1]
    if (last && last.sig === sig && last.until === min.m) last.until = min.m + 1
    else out.push({ sig, from: min.m, until: min.m + 1, sources: min.sources, claims: min.claims })
  }
  return out
}
