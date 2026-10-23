/**
 * 本地假 DSH 页面：把浏览器端脚本真跑起来，用来验证「她趴在哪」。
 *
 *   node test/mock-server.mjs
 *   http://127.0.0.1:8899/            圆角卡片的输入框（正常情况）
 *   http://127.0.0.1:8899/?plain=1    卡片没有圆角/底色（验证兜底分支）
 *   http://127.0.0.1:8899/?phase=tool 预置一个状态：tool/thinking/review/failed/done
 *
 * 路由直接复用宿主半边的真实代码（同一套 stub ctx），不是另写一份。
 */
import http from 'node:http'

const PORT = 8899

const routes = new Map()
const handlers = {}
const taps = []

const ctx = {
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  on(name, fn) {
    handlers[name] = fn
    return () => {}
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

const root = {
  effect(fn) {
    fn()
    return () => {}
  },
  on(name, fn) {
    handlers[name] = fn
    return () => {}
  },
  inject(_deps, cb) {
    cb(ctx)
  },
}

const plugin = (await import('../lib/index.js')).default
plugin.apply(root)

const session = { id: 'mock' }
const emit = (event) => handlers['session/event'](session, event)

function presetPhase(phase) {
  emit({ type: 'turn/start' })
  if (phase === 'tool') {
    emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } })
  } else if (phase === 'failed') {
    emit({ type: 'tool/result', data: { message: { toolCallId: 'c9', isError: true } } })
  } else if (phase === 'done') {
    emit({ type: 'tool/call', data: { callId: 'c2', name: 'pwsh' } })
    emit({ type: 'tool/result', data: { message: { toolCallId: 'c2', isError: false } } })
    emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  } else if (phase === 'thinking') {
    handlers['agent/assistant-stream']({
      agent: { session },
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } },
    })
  } else if (phase === 'review') {
    handlers['agent/assistant-stream']({
      agent: { session },
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'writing' } },
    })
  }
}

function page(plain) {
  const radius = plain ? '0px' : '18px'
  const bg = plain ? 'transparent' : '#141824'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>mock dsh</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; background:#0b0d12; color:#e6e8f0;
         font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif }
  .app { display:flex; height:100vh }
  .nav { width:220px; border-right:1px solid #1d2130; padding:14px }
  .nav div { color:#8890a8; padding:6px 8px; border-radius:8px; margin-bottom:4px }
  .nav div.on { background:#171b27; color:#e6e8f0 }
  .main { flex:1; display:flex; flex-direction:column; min-width:0 }
  .thread { flex:1; overflow:auto; padding:28px 0 }
  .col { width:min(820px, 92%); margin:0 auto }
  .msg { margin:16px 0 }
  .msg .who { color:#8890a8; font-size:12px; margin-bottom:4px }
  .bubble { background:#12151f; border:1px solid #1d2130; border-radius:12px; padding:12px 14px }
  .dock { padding:0 0 22px }
  .composer { width:min(820px, 92%); margin:0 auto; background:${bg};
              border:1px solid #262b3c; border-radius:${radius}; padding:14px 16px 10px;
              box-shadow:0 18px 40px rgba(0,0,0,.45) }
  .composer textarea { width:100%; height:56px; background:transparent; border:0; outline:0;
                       color:#e6e8f0; font:15px/1.5 inherit; resize:none; display:block }
  .bar { display:flex; align-items:center; gap:10px; margin-top:6px; color:#8890a8; font-size:12px }
  .bar .spacer { flex:1 }
  .chip { border:1px solid #262b3c; border-radius:999px; padding:3px 10px }
</style></head><body>
<div class="app">
  <aside class="nav">
    <div class="on">新会话</div><div>鲸娘桌宠</div><div>昨天的活</div>
  </aside>
  <main class="main">
    <div class="thread"><div class="col">
      <div class="msg"><div class="who">你</div><div class="bubble">希望我的鲸娘放到我的每次对话框的右上角</div></div>
      <div class="msg"><div class="who">DeepSeek</div><div class="bubble">好，她现在就在下面那条输入框的右上角趴着。</div></div>
    </div></div>
    <div class="dock">
      <div class="composer" id="composer">
        <div class="pad"><textarea placeholder="我需要" rows="2"></textarea></div>
        <div class="bar">
          <span class="chip">+</span>
          <span class="chip">工作区内修改</span>
          <span class="spacer"></span>
          <span class="chip">DeepSeek-V4.1-Flash High</span>
        </div>
      </div>
    </div>
  </main>
</div>
__INJECT__</body></html>`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const phase = url.searchParams.get('phase')
    if (phase) presetPhase(phase)
    const html = page(url.searchParams.get('plain') === '1')
    const injected = taps.length > 0 ? taps[0](html) : html
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(injected)
    return
  }
  const handler = routes.get(url.pathname)
  if (handler !== undefined) {
    handler(req, res)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('no')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock dsh on http://127.0.0.1:' + PORT + '/')
})
