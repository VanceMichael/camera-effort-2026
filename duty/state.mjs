import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const blank = () => ({
  version: 1,
  cache: {},      // 目录分页的条件请求缓存: url -> { etag, rows, next }
  fetched: {},    // 已核验原图: 图号 -> { generation, cell, etag, bytes, sha256, complete, verifiedAt }
  gone: {},       // 已失效原图(410): 图号 -> { at }
  jobs: {},       // 撤并跟踪: 单号 -> { withdrawn, requestReceipt, releaseReceipt, slot, cell, released, reallocated }
  holds: {},      // 已预约通道: "通道/水面" -> { job, slot, cell, state, for }
  lastProven: {}, // 上一轮各观察单已证明分钟,用于遮挡/资料更正后的失效比对
  lastEdition: null
})

export async function loadState(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    return { ...blank(), ...raw }
  } catch (error) {
    if (error.code === 'ENOENT') return blank()
    throw error
  }
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `state.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, join(dir, 'state.json'))
}
