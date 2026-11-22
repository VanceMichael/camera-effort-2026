import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('相机略图目录可见但原图失效，岸巡撤回分请求和释放', async t => {
  const root = await listen(t)
  assert.equal((await (await fetch(root + '/images/index')).json()).remaining, 1)
  assert.equal((await fetch(root + '/images/a62')).status, 410)
  await post(root, '/lab?stage=clear')
  const image = Buffer.from(await (await fetch(root + '/images/c62')).arrayBuffer())
  assert.equal(image.subarray(1, 4).toString(), 'PNG')
  assert.equal((await post(root, '/crossings/withdraw', { job: 'J1', receipt: 'A12' })).status, 202)
  assert.equal((await post(root, '/crossings/withdraw', { job: 'J2', receipt: 'B11' })).status, 409)
  await post(root, '/lab?stage=released')
  assert.equal((await (await fetch(root + '/crossings/slots')).json())[0].occupied, null)
})
