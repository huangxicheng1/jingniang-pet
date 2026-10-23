/**
 * 用 CDP 连上无头 Edge，把真实几何量出来（不靠肉眼估）。
 *   node test/probe.mjs [url] [expression]
 */
const url = process.argv[2] || 'http://127.0.0.1:8899/'
const custom = process.argv[3]

const EXPR =
  custom ||
  `(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) } }
    const ta = document.querySelector('textarea')
    const pet = document.getElementById('jingniang-pet')
    const img = pet && pet.querySelector('img')
    const chain = []
    let el = ta
    for (let i = 0; i < 6 && el; i++) { chain.push({ tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''), ...r(el) }); el = el.parentElement }
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight },
      textarea: r(ta),
      petBox: r(pet),
      petDisplay: pet && getComputedStyle(pet).display,
      petTransform: pet && getComputedStyle(pet).transform,
      imgSrc: img && img.getAttribute('src'),
      imgNatural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      chain,
      composer: r(document.getElementById('composer')),
    }, null, 1)
  })()`

const PORT = process.env.CDP_PORT || '9222'
const listRes = await fetch('http://127.0.0.1:' + PORT + '/json/list')
const targets = await listRes.json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.log('no page target: ' + JSON.stringify(targets.map((t) => [t.type, t.url])))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function send(method, params) {
  id += 1
  const mid = id
  return new Promise((resolve) => {
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

if (custom === undefined) {
  await send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, 2500))
}

const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
const value = out.result && out.result.result && out.result.result.value
console.log(value === undefined ? JSON.stringify(out.result) : value)
ws.close()
