// 相机目录(资料来源)客户端:资料版钉定、逐页领取、ETag 条件请求。
// 目录只能看见略图的时间与画面格,不说明原图是否仍在;原图要走 provider。
export class SourceClient {
  #root
  #cache
  stats = { requests: 0, hits: 0 }

  constructor(root, cache = new Map()) {
    this.#root = root
    this.#cache = cache
  }

  async catalog() {
    const response = await fetch(this.#root + '/catalog')
    if (!response.ok) throw new Error(`目录不可用(${response.status})`)
    return response.json()
  }

  // 拉取一个数据流的全部行;返回 null 表示该资料版没有这个流。
  async stream(name, { edition } = {}) {
    const rows = []
    let url = new URL(this.#root + '/records/' + name)
    if (edition) url.searchParams.set('edition', edition)
    const seen = new Set()
    while (url) {
      const key = String(url)
      if (seen.has(key)) throw new Error(`分页出现循环: ${name}`)
      seen.add(key)
      const cached = this.#cache.get(key)
      this.stats.requests++
      const response = await fetch(url, { headers: cached?.etag ? { 'If-None-Match': cached.etag } : {} })
      if (response.status === 304 && cached) {
        this.stats.hits++
        rows.push(...cached.rows)
        url = cached.next ? new URL(cached.next) : null
        continue
      }
      if (response.status === 404) return null
      if (response.status === 409) throw new Error(`继续标记对不上资料版: ${name}`)
      if (!response.ok) throw new Error(`${name} 读取失败(${response.status})`)
      const actual = response.headers.get('x-edition')
      if (edition && actual && actual !== edition) {
        throw new Error(`资料版不一致: 期望 ${edition},实际 ${actual}`)
      }
      const text = await response.text()
      const pageRows = text.split('\n').filter(Boolean).map(line => line.split('\t'))
      rows.push(...pageRows)
      const link = response.headers.get('link')
      const next = link ? new URL(/^<([^>]+)>/.exec(link)[1], this.#root) : null
      this.#cache.set(key, {
        etag: response.headers.get('etag'),
        rows: pageRows,
        next: next ? String(next) : null
      })
      url = next
    }
    return rows
  }
}
