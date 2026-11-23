// 原图库与过岸预约台客户端。
// 原图库每轮只开放有限取件,每次尝试大图都可能消耗一次领取;
// 撤回只是受理(202),释放与否只能回读 /crossings/receipts 确认。
export class ProviderClient {
  #root

  constructor(root) {
    this.#root = root
  }

  async #getJson(path) {
    const response = await fetch(this.#root + path)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`${path} 读取失败(${response.status})`)
    return response.json()
  }

  // 待取图批: { remaining, items: [{ id, generation, cell, path }] };本轮未开放返回 null
  index() {
    return this.#getJson('/images/index')
  }

  slots() {
    return this.#getJson('/crossings/slots')
  }

  receipts() {
    return this.#getJson('/crossings/receipts')
  }

  async #postJson(path, payload) {
    const response = await fetch(this.#root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  // 撤并申请: 提交单号与旧凭据;202 只表示岸巡收到了申请
  withdraw(job, receipt) {
    return this.#postJson('/crossings/withdraw', { job, receipt })
  }

  // 通道释放后才能为另一处预约
  hold(slot, cell) {
    return this.#postJson('/crossings/hold', { slot, cell })
  }

  // 领取一件原图。没完整下载不能算作观察:核对 Content-Length,
  // 截断时带 If-Match 续传一次;存储代在中途被换掉(412)就整件放弃。
  async fetchImage(item) {
    let response
    try {
      response = await fetch(this.#root + item.path)
    } catch (error) {
      return { status: 'error', message: error.message }
    }
    if (response.status === 410) return { status: 'gone' }
    if (response.status === 429) return { status: 'quota' }
    if (!response.ok) return { status: 'error', code: response.status }
    const etag = response.headers.get('etag')
    const total = Number(response.headers.get('content-length'))
    const chunks = []
    try {
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
    } catch {
      // 连接中断:留住已收到的部分,按截断续传
    }
    let body = Buffer.concat(chunks)
    if (Number.isFinite(total) ? body.length === total : true) {
      return { status: 'fetched', etag, body, bytes: body.length, total }
    }
    if (!etag) return { status: 'incomplete', bytes: body.length, total }
    let more
    try {
      more = await fetch(this.#root + item.path, {
        headers: { Range: `bytes=${body.length}-`, 'If-Match': etag }
      })
    } catch (error) {
      return { status: 'incomplete', bytes: body.length, total, message: error.message }
    }
    if (more.status === 412) return { status: 'mismatch', etag }
    if (more.status === 410) return { status: 'gone' }
    if (more.status !== 206) return { status: 'incomplete', bytes: body.length, total, quota: more.status === 429 }
    const rest = Buffer.from(await more.arrayBuffer())
    body = Buffer.concat([body, rest])
    return body.length === total
      ? { status: 'fetched', etag, body, bytes: body.length, total }
      : { status: 'incomplete', bytes: body.length, total }
  }
}
