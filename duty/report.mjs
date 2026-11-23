import { mergeMinutes, segmentsOf } from './coverage.mjs'

const fmtRanges = minutes =>
  mergeMinutes(minutes).map(r => (r.until - r.from === 1 ? `${r.from}` : `${r.from}–${r.until - 1}`)).join('、') || '无'

const fmtSpan = (from, until) => `${from}–${until}`

function sourceLabel(s) {
  if (s.kind === 'frame') {
    const base = `相机${s.cam}·图${s.img}·${s.count}只`
    return base + (s.corrected ? `(批注${s.noteId}更正)` : '') + (s.count === 0 ? '·可见无鸟' : '')
  }
  if (s.kind === 'recovered') {
    return `相机${s.cam}·补图${s.img}(存储代${s.generation})·${s.count}只` + (s.count === 0 ? '·可见无鸟' : '')
  }
  return `岸巡${s.job}` + (s.reported != null ? `·回报${s.reported}只` : '') + (s.state ? `·${s.state}` : '')
}

// 补采单(当天):值班员要的五件事都在里面——已证明时段、来源与画面格、
// 可再从哪里取证、现场单受理情况、仍不能覆盖的水面与时间。
export function buildOrder(model) {
  const { date, edition, coverage, fetchEntries, patrolEntries, holdEntries, gapDetails, jobView, invalidated } = model
  return {
    日期: date,
    资料版: edition,
    观察单: [...coverage.perWindow.values()].map(cov => ({
      单号: cov.window.id,
      水面: cov.window.reach,
      时窗: [cov.window.from, cov.window.until],
      已证明分钟: cov.proven,
      其中可见无鸟: cov.zeroBird,
      双份观察分钟: cov.doubles,
      缺口分钟: cov.gaps
    })),
    取件: fetchEntries.map(e => ({
      图: e.img,
      存储代: e.generation ?? null,
      画面格: e.cell ?? null,
      用途: e.uses.map(u => ({ 观察单: u.window, 水面: u.reach, 分钟: u.m })),
      结果: e.status,
      ...(e.etag ? { ETag: e.etag, 字节: e.bytes, SHA256: e.sha256 } : {}),
      ...(e.reason ? { 说明: e.reason } : {})
    })),
    过岸: [
      ...patrolEntries.map(p => ({
        动作: p.action,
        单号: p.job,
        观察单: p.window,
        时段: [p.from, p.until],
        ...(p.slot ? { 通道: p.slot } : {}),
        ...(p.receiptState ? { 受理状态: p.receiptState } : {}),
        ...(p.note ? { 说明: p.note } : { 说明: p.reason })
      })),
      ...holdEntries.map(h => ({
        动作: h.action,
        通道: h.slot,
        水面: h.cell ?? null,
        ...(h.job ? { 新单号: h.job } : {}),
        ...(h.for ? { 用途: `观察单${h.for.window} ${fmtRanges([...h.for.uncovered, ...h.for.single])}分钟` } : {}),
        ...(h.reason ? { 说明: h.reason } : {})
      }))
    ],
    现场单: jobView,
    仍不能覆盖: gapDetails
      .filter(g => g.disposition === 'uncoverable')
      .map(g => ({ 观察单: g.window, 水面: g.reach, 分钟: g.minutes, 原因: g.reason })),
    遮挡失效: coverage.voided.map(v => ({
      相机: v.cam, 水面: v.reaches, 时段: [v.from, v.until], 记事: v.note,
      不再证明覆盖的画面: v.imgs.map(i => i.img)
    })),
    跨轮失效: invalidated.map(x => ({ 观察单: x.window, 水面: x.reach, 分钟: x.minutes })),
    合计: {
      去重后证明分钟: coverage.unionMinutes,
      各单: Object.fromEntries([...coverage.perWindow.values()].map(cov => [
        cov.window.id, { 已证明: cov.proven.length, 共: cov.window.until - cov.window.from }
      ]))
    }
  }
}

export function renderReport(model, order) {
  const { date, edition, coverage, fetchEntries, gapDetails, jobView, orderPath } = model
  const lines = []
  lines.push(`值班采集报告 ${date} · 资料版 ${edition}`)
  lines.push('')

  for (const [id, cov] of coverage.perWindow) {
    const w = cov.window
    const total = w.until - w.from
    lines.push(`观察单 ${id} · 水面 ${w.reach} · 时窗 ${fmtSpan(w.from, w.until)}(共${total}分钟)`)
    lines.push(`  已证明 ${cov.proven.length}/${total} 分钟` +
      (cov.zeroBird.length ? `(其中可见无鸟 ${cov.zeroBird.length} 分钟)` : '') +
      (cov.doubles.length ? ` · 双份观察 ${fmtRanges(cov.doubles)}(重叠只计一份)` : ''))
    for (const seg of segmentsOf(cov.minutes)) {
      if (seg.sources.length === 0) continue
      const double = seg.sources.length > 1 ? '  ← 双份观察,计一次' : ''
      lines.push(`    ${fmtSpan(seg.from, seg.until)}  ${seg.sources.map(sourceLabel).join('; ')}${double}`)
    }
    for (const g of gapDetails.filter(g => g.window === id)) {
      lines.push(`    ${fmtSpan(g.from, g.until)}  缺口·无可见证据 — ${g.reason}`)
    }
    lines.push('')
  }

  if (coverage.voided.some(v => v.imgs.length)) {
    lines.push('遮挡更正失效(原来证明的时段不再成立):')
    for (const v of coverage.voided) {
      if (!v.imgs.length) continue
      lines.push(`  相机${v.cam} ${v.reaches.join('/')} ${fmtSpan(v.from, v.until)}(记事${v.note}):画面 ${v.imgs.map(i => i.img).join('、')} 不再证明覆盖`)
    }
    lines.push('')
  }

  if (model.invalidated.length) {
    lines.push('跨轮失效(上一轮已证明、本轮不再成立):')
    for (const x of model.invalidated) lines.push(`  观察单${x.window} ${x.reach} 分钟 ${fmtRanges(x.minutes)}`)
    lines.push('')
  }

  if (fetchEntries.length) {
    lines.push('取证(原图库):')
    for (const e of fetchEntries) {
      const uses = e.uses.map(u => `${u.window}第${u.m}分钟`).join('、')
      if (e.status === 'fetched') {
        lines.push(`  图${e.img} 存储代${e.generation} 格${e.cell} → 已取回核验(${e.bytes}字节)${e.reason ? `,${e.reason}` : ''},填 ${uses}`)
      } else {
        lines.push(`  图${e.img} → ${e.status}${e.reason ? `(${e.reason})` : ''},候选: ${uses}`)
      }
    }
    lines.push('')
  }

  lines.push('现场单:')
  for (const j of jobView) lines.push(`  ${j}`)
  lines.push('')

  const uncovered = order.仍不能覆盖
  if (uncovered.length) {
    lines.push('仍不能覆盖:')
    for (const g of uncovered) lines.push(`  观察单${g.观察单} ${g.水面} 分钟 ${fmtRanges(g.分钟)} — ${g.原因}`)
    lines.push('')
  }

  lines.push(`合计:相交水面同分钟去重后共证明 ${coverage.unionMinutes} 分钟`)
  lines.push(`补采单已写入 ${orderPath}`)
  return lines.join('\n')
}
