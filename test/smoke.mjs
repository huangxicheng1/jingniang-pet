/**
 * 宿主半边的冒烟测试：不需要启动 DSH。
 * 用假的 ctx 把 webServer 路由、会话事件投影、配置读写都走一遍。
 *
 *   node test/smoke.mjs
 */
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import path from 'node:path'

const routes = new Map()
const rootHandlers = {}
const indexTaps = []
const injectRows = []
let effects = 0

const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      indexTaps.push(fn)
      return () => {}
    },
  },
  on(name, fn) {
    rootHandlers[name] = fn
    return () => {}
  },
  effect(fn) {
    effects += 1
    fn()
    return () => {}
  },
}

const root = {
  effect(fn) {
    effects += 1
    fn()
    return () => {}
  },
  on(name, fn) {
    rootHandlers[name] = fn
    return () => {}
  },
  inject(_deps, cb) {
    cb(ctx)
  },
}

const plugin = (await import('../lib/index.js')).default
assert.equal(typeof plugin.apply, 'function')
plugin.apply(root)

function call(pathname, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const handler = routes.get(pathname)
    if (handler === undefined) {
      resolve({ status: 404, body: Buffer.from('no route') })
      return
    }
    const req = new EventEmitter()
    req.method = method
    req.headers = { host: '127.0.0.1:57558' }
    const res = {
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(buf) {
        resolve({ status: this.status, headers: this.headers, body: Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)) })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'))
}

const results = []
function ok(name, detail) {
  results.push('  ok   ' + name + (detail ? '  — ' + detail : ''))
}

// 1. 路由表齐了
assert.ok(routes.has('/jingniang/pet.js'))
assert.ok(routes.has('/jingniang/config'))
assert.ok(routes.has('/jingniang/phase'))
assert.ok(routes.has('/jingniang/debug'))
let assetRoutes = 0
for (const p of routes.keys()) if (p.startsWith('/jingniang/asset/')) assetRoutes += 1
assert.equal(assetRoutes, 22, '应注册 22 条素材路由')
ok('路由', '23 条 + 22 条素材')

// 2. 配置能读，且认到了素材目录
const cfgRes = await call('/jingniang/config')
const cfgBody = json(cfgRes)
assert.equal(cfgBody.ok, true)
assert.ok(cfgBody.assetDir.endsWith(path.join('assets', 'gifs')), 'assetDir 应指向 assets\\gifs，实际 ' + cfgBody.assetDir)
assert.equal(cfgBody.config.size, 138)
ok('配置读取', cfgBody.assetDir)

// 3. GIF 真的发得出来，字节数对得上
const gif = await call('/jingniang/asset/01-idle.gif')
assert.equal(gif.status, 200)
assert.equal(gif.headers['Content-Type'], 'image/gif')
assert.equal(gif.body.length, 231526)
assert.equal(gif.body.slice(0, 3).toString('latin1'), 'GIF')
ok('素材下发', gif.body.length + ' bytes, GIF 头正确')

// 4. 脚本发得出来
const js = await call('/jingniang/pet.js')
assert.equal(js.status, 200)
assert.ok(js.body.length > 5000)
ok('浏览器脚本下发', js.body.length + ' bytes')

// 5. 初始 idle
assert.equal(json(await call('/jingniang/phase')).phase, 'idle')

// 6. 会话事件 → 相位
const session = { id: 's1' }
const emit = (event) => rootHandlers['session/event'](session, event)

emit({ type: 'turn/start' })
assert.equal(json(await call('/jingniang/phase')).phase, 'waiting')
ok('turn/start → waiting')

emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: {} } })
let phaseNow = json(await call('/jingniang/phase'))
assert.equal(phaseNow.phase, 'tool')
assert.equal(phaseNow.detail, 'pwsh')
ok('tool/call → tool', 'detail=' + phaseNow.detail)

emit({ type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
assert.equal(json(await call('/jingniang/phase')).phase, 'thinking')
ok('tool/result（无错） → thinking')

emit({ type: 'tool/call', data: { callId: 'c2', name: 'grep' } })
emit({ type: 'tool/result', data: { message: { toolCallId: 'c2', isError: true } } })
assert.equal(json(await call('/jingniang/phase')).phase, 'failed')
ok('tool/result（报错） → failed')

emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
assert.equal(json(await call('/jingniang/phase')).phase, 'done')
ok('turn/end completed → done')

emit({ type: 'turn/start' })
emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
assert.equal(json(await call('/jingniang/phase')).phase, 'idle')
ok('turn/end aborted → idle')

// 7. 流式：思考 / 写正文
rootHandlers['agent/assistant-stream']({
  agent: { session },
  frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '嗯' } },
})
assert.equal(json(await call('/jingniang/phase')).phase, 'thinking')
ok('reasoning-delta → thinking')

rootHandlers['agent/assistant-stream']({
  agent: { session },
  frame: { type: 'chunk', chunk: { type: 'text-delta', text: '好的' } },
})
assert.equal(json(await call('/jingniang/phase')).phase, 'review')
ok('text-delta → review')

// 8. 两个会话同时跑工具 → toolSessions=2（戴耳机）
const s2 = { id: 's2' }
rootHandlers['session/event'](s2, { type: 'turn/start' })
rootHandlers['session/event'](s2, { type: 'tool/call', data: { callId: 'x1', name: 'pwsh' } })
rootHandlers['session/event'](session, { type: 'tool/call', data: { callId: 'x2', name: 'pwsh' } })
const both = json(await call('/jingniang/phase'))
assert.equal(both.toolSessions, 2, '应统计到 2 个会话在跑工具，实际 ' + JSON.stringify(both))
ok('并发会话统计', 'toolSessions=' + both.toolSessions)

// 9. 未识别事件不炸，也不乱改相位
const before = json(await call('/jingniang/phase')).phase
emit({ type: 'some/future-event', data: {} })
assert.equal(json(await call('/jingniang/phase')).phase, before)
ok('未知事件被忽略')

// 10. 配置写入
const posted = await call('/jingniang/config', { method: 'POST', body: JSON.stringify({ size: 207, offsetY: -12 }) })
const postedBody = json(posted)
assert.equal(postedBody.config.size, 207)
assert.equal(postedBody.config.offsetY, -12)
const reread = json(await call('/jingniang/config'))
assert.equal(reread.config.size, 207)
ok('配置写入并持久化')
await call('/jingniang/config', { method: 'POST', body: JSON.stringify({ size: 138, offsetY: 0 }) })

// 11. 注入通道
const html = '<html><body><div id="app"></div></body></html>'
const patched = indexTaps[0](html)
assert.ok(patched.includes('/jingniang/pet.js'), 'tapIndex 应注入 script 标签')
assert.equal(indexTaps[0](patched), patched, '重复注入应幂等')
ok('网页端注入（tapIndex）')

rootHandlers['webserver/index-inject'](injectRows)
assert.equal(injectRows.length, 1)
assert.equal(injectRows[0].kind, 'script')
assert.ok(injectRows[0].text.includes('/jingniang/pet.js'))
rootHandlers['webserver/index-inject'](injectRows)
assert.equal(injectRows.length, 1, '重复注入应幂等')
ok('桌面端注入（index-inject）')

// 12. debug 端点
const dbg = json(await call('/jingniang/debug'))
assert.ok(Array.isArray(dbg.events) && dbg.events.length > 0)
assert.ok(dbg.sessions.length >= 2)
ok('debug 端点', dbg.events.length + ' 条事件 / ' + dbg.sessions.length + ' 个会话')

console.log(results.join('\n'))
console.log('\n全部通过：' + results.length + ' 项')
