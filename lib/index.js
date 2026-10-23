/**
 * dsh-jingniang-pet —— 宿主半边。
 *
 * 只做三件事：
 *   1. 把浏览器端脚本 /jingniang/pet.js 和 22 个 GIF 通过 webServer 发出去；
 *   2. 把 DSH 的会话活动投影成一个粗粒度的 phase，供浏览器端轮询；
 *   3. 存一份配置（大小 / 微调 / 开关），浏览器端右键菜单改的就是它。
 *
 * 注入通道两条，和 dsh-whale-widget 一致：
 *   · 网页形态：webServer.tapIndex() 改写 index.html；
 *   · 桌面形态（Electron 直接读 dist）：webserver/index-inject 推一行内联 script，
 *     由这行自己建 <script src> 并吞掉 onerror —— 路由没了也只是静默失败，
 *     绝不让宿主因为我们起不来。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'jingniang-pet.json')
const API = '/jingniang'

/** 22 个动作的固定文件名（与 assets\gifs 目录一一对应）。 */
const ANIM_FILES = [
  '01-idle.gif',
  '02-idle-look.gif',
  '03-idle-spout.gif',
  '04-thinking.gif',
  '05-typing.gif',
  '06-music.gif',
  '07-conducting.gif',
  '08-building.gif',
  '09-error.gif',
  '10-happy.gif',
  '11-notification.gif',
  '12-compacting.gif',
  '13-carrying.gif',
  '14-sleeping.gif',
  '15-waking.gif',
  '16-poke-left.gif',
  '17-poke-right.gif',
  '18-tickle.gif',
  '19-drag.gif',
  '20-swim.gif',
  '21-smile-hearts.gif',
  '22-thumbs-up.gif',
]

const DEFAULT_CONFIG = {
  enabled: true,
  size: 138,
  offsetX: 0,
  offsetY: 0,
  randomIdle: true,
  sleepAfterSeconds: 60,
}

const BOOT_ROW =
  '(function(){try{var d=document.body||document.documentElement;if(!d)return;' +
  'if(window.__jingniangPetLoaded)return;' +
  'var s=document.createElement("script");s.src="' + API + '/pet.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// ---------------------------------------------------------------- 配置

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch (err) {}
  return { ...DEFAULT_CONFIG }
}

function writeConfig(patch) {
  const next = { ...readConfig() }
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (patch[key] !== undefined && typeof patch[key] === typeof DEFAULT_CONFIG[key]) {
        next[key] = patch[key]
      }
    }
  }
  next.size = Math.min(400, Math.max(60, Math.round(next.size)))
  next.offsetX = Math.min(600, Math.max(-600, Math.round(next.offsetX)))
  next.offsetY = Math.min(600, Math.max(-600, Math.round(next.offsetY)))
  next.sleepAfterSeconds = Math.min(3600, Math.max(0, Math.round(next.sleepAfterSeconds)))
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {}
  return next
}

// ---------------------------------------------------------------- 素材

function findAssetDir() {
  const candidates = [
    process.env.JINGNIANG_ASSETS || '',
    path.join(PLUGIN_ROOT, 'assets'),
    path.join(PLUGIN_ROOT, '..', 'assets', 'gifs'),
    path.join(DSH_HOME, 'jingniang-assets'),
  ]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      if (fs.existsSync(path.join(dir, ANIM_FILES[0]))) return path.resolve(dir)
    } catch (err) {}
  }
  return ''
}

const fileCache = new Map()

function readCachedFile(file) {
  const st = fs.statSync(file)
  const hit = fileCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.buf
  const buf = fs.readFileSync(file)
  fileCache.set(file, { mtimeMs: st.mtimeMs, buf })
  return buf
}

// ---------------------------------------------------------------- 活动投影

/** 最近事件环形表，/jingniang/debug 里能看见，方便对不上的时候排查。 */
const EVENT_LOG = []
function logEvent(entry) {
  EVENT_LOG.push(entry)
  if (EVENT_LOG.length > 80) EVENT_LOG.shift()
}

/** sessionId -> { phase, detail, at, tools:Set, failed, settledAt } */
const sessions = new Map()

function sessionOf(id) {
  let s = sessions.get(id)
  if (s === undefined) {
    s = { phase: 'idle', detail: '', at: 0, tools: new Set(), failed: false, settledAt: 0 }
    sessions.set(id, s)
  }
  return s
}

function setPhase(id, phase, detail) {
  const s = sessionOf(id)
  const now = Date.now()
  if (s.phase !== phase) {
    s.settledAt = phase === 'done' || phase === 'failed' ? now : 0
  }
  s.phase = phase
  s.detail = detail || ''
  s.at = now
}

/**
 * 当前该显示什么。取"最近有动静"的那个会话；同时统计还有几个会话在干活
 * （用来选 06 戴耳机听歌）。
 */
function snapshot() {
  const now = Date.now()
  let best = null
  let active = 0
  let toolSessions = 0
  for (const [id, s] of sessions) {
    if (now - s.at > 10 * 60 * 1000) {
      sessions.delete(id)
      continue
    }
    if (s.phase !== 'idle' && s.phase !== 'done' && now - s.at < 120 * 1000) {
      active += 1
      if (s.phase === 'tool') toolSessions += 1
    }
    if (best === null || s.at > best.s.at) best = { id, s }
  }
  if (best === null) {
    return { phase: 'idle', detail: '', active: 0, toolSessions: 0, tools: 0, at: now }
  }
  return {
    phase: best.s.phase,
    detail: best.s.detail,
    active,
    toolSessions,
    tools: best.s.tools.size,
    at: best.s.at,
  }
}

function projectSessionEvent(session, event) {
  const id = String((session && session.id) || 'main')
  const type = String((event && event.type) || '')
  const data = (event && event.data) || {}
  logEvent({ t: Date.now(), id, type, callId: data.callId, name: data.name, reason: data.reason && data.reason.kind })

  const s = sessionOf(id)

  switch (type) {
    case 'turn/start':
      s.tools.clear()
      s.failed = false
      setPhase(id, 'waiting', '')
      return
    case 'step/start':
      s.tools.clear()
      s.failed = false
      setPhase(id, 'waiting', '')
      return
    case 'assistant/message':
      setPhase(id, 'review', '')
      return
    case 'tool/call': {
      const callId = String(data.callId || '')
      if (callId) s.tools.add(callId)
      setPhase(id, 'tool', String(data.name || ''))
      return
    }
    case 'tool/result': {
      const message = data.message || {}
      const callId = String(message.toolCallId || '')
      const failed = data.error !== undefined || message.isError === true
      if (callId) s.tools.delete(callId)
      s.failed = s.failed || failed
      if (failed) setPhase(id, 'failed', '')
      else if (s.tools.size > 0) setPhase(id, 'tool', '')
      else setPhase(id, 'thinking', '')
      return
    }
    case 'turn/end': {
      s.tools.clear()
      const kind = data.reason && data.reason.kind
      if (kind === 'completed') setPhase(id, 'done', '')
      else if (kind === 'error' || kind === 'max-tokens' || kind === 'interrupted') setPhase(id, 'failed', '')
      else setPhase(id, 'idle', '')
      return
    }
    default:
      // 事件词表是合并可扩展的：压缩 / 权限确认 / 工作区分派这几类
      // 目前没有稳定的公开类型名，靠关键字兜一层，认不出就什么都不做。
      if (/compact/i.test(type)) setPhase(id, 'compacting', '')
      else if (/permission|approval|confirm/i.test(type)) setPhase(id, 'confirm', '')
      else if (/worktree|work-tree/i.test(type)) setPhase(id, 'carrying', '')
      return
  }
}

function projectStreamFrame(agent, frame) {
  if (!frame || frame.type !== 'chunk') return
  const chunk = frame.chunk
  if (!chunk || typeof chunk.text !== 'string' || chunk.text.length === 0) return
  const id = String((agent && agent.session && agent.session.id) || 'main')
  const s = sessionOf(id)
  // 一轮刚收尾，别让迟到的流把 done 盖掉
  if (s.settledAt && Date.now() - s.settledAt < 1200) return
  if (chunk.type === 'reasoning-delta') setPhase(id, 'thinking', '')
  else if (chunk.type === 'text-delta') setPhase(id, 'review', '')
}

// ---------------------------------------------------------------- 小工具

/** 浏览器端每次轮询都带上的显示参数：改配置文件立刻生效，不用刷新。 */
function displayConfig() {
  const c = readConfig()
  return {
    size: c.size,
    offsetX: c.offsetX,
    offsetY: c.offsetY,
    enabled: c.enabled,
    randomIdle: c.randomIdle,
  }
}

/** 浏览器端报上来的锚点几何，用来按数字调位置。 */
let lastGeom = null

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) data = data.slice(0, 64 * 1024)
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(data))
  })
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

function sendBytes(res, status, bytes, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

// ---------------------------------------------------------------- 插件

export default {
  name: 'jingniang-pet',

  apply(root) {
    // ① 桌面端注入行：必须在 apply 一开始就注册（渲染层的注入表是启动时一次性收集的）
    const rowDisposers = []
    root.effect(() => () => {
      for (const dispose of rowDisposers) {
        try {
          dispose()
        } catch (err) {}
      }
    })
    rowDisposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(API + '/pet.js') !== -1) return
            if (row.kind === 'script-src' && row.src === API + '/pet.js') return
          }
          table.push({ kind: 'script', placement: 'body', text: BOOT_ROW })
        } catch (err) {}
      }),
    )

    // ② 路由 + 网页端注入
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const register = (pathname, handler) => {
        try {
          const dispose = ctx.webServer.register({ kind: 'exact', path: pathname, handler })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (err) {
          try {
            console.warn('[jingniang-pet] 注册路由失败 ' + pathname + '：' + String((err && err.message) || err))
          } catch (e2) {}
        }
      }

      const assetDir = findAssetDir()
      if (!assetDir) {
        try {
          console.warn(
            '[jingniang-pet] 没找到动画素材目录。请把 22 个 GIF 放在 ' +
              path.join(PLUGIN_ROOT, 'assets') +
              ' 或 ' +
              path.join(PLUGIN_ROOT, '..', 'assets', 'gifs') +
              '，或用环境变量 JINGNIANG_ASSETS 指过去。',
          )
        } catch (err) {}
      }

      // —— 浏览器端脚本
      register(API + '/pet.js', (req, res) => {
        try {
          const file = path.join(PLUGIN_ROOT, 'client', 'pet.js')
          sendBytes(res, 200, readCachedFile(file), 'application/javascript; charset=utf-8')
        } catch (err) {
          sendBytes(res, 404, Buffer.from('pet.js unavailable', 'utf8'), 'text/plain; charset=utf-8')
        }
      })

      // 启动时替浏览器先做一次语法检查：脚本写坏了会让宿主直接打日志，
      // 而不是安静地什么都不发生（这台机器上没终端，靠这个定位）。
      try {
        const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'client', 'pet.js'), 'utf8')
        // eslint-disable-next-line no-new-func
        new Function(src)
        console.log('[jingniang-pet] 浏览器端脚本语法检查通过')
      } catch (err) {
        console.warn('[jingniang-pet] 浏览器端脚本语法有问题，页面里不会出现鲸娘：' + String((err && err.message) || err))
      }

      // —— 22 个 GIF，一条一条注册成精确路径（不赌 prefix 路由的语义）
      for (const file of ANIM_FILES) {
        register(API + '/asset/' + file, (req, res) => {
          if (!assetDir) {
            sendBytes(res, 404, Buffer.from('no asset dir', 'utf8'), 'text/plain; charset=utf-8')
            return
          }
          try {
            const full = path.resolve(assetDir, file)
            if (!full.startsWith(assetDir + path.sep)) {
              sendBytes(res, 403, Buffer.from('forbidden', 'utf8'), 'text/plain; charset=utf-8')
              return
            }
            sendBytes(res, 200, readCachedFile(full), 'image/gif')
          } catch (err) {
            sendBytes(res, 404, Buffer.from('not found', 'utf8'), 'text/plain; charset=utf-8')
          }
        })
      }

      // —— 配置
      register(API + '/config', async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, config: readConfig(), assetDir, pluginRoot: PLUGIN_ROOT })
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const raw = await readBody(req)
          const patch = raw ? JSON.parse(raw) : {}
          sendJson(res, 200, { ok: true, config: writeConfig(patch) })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: 'bad json' })
        }
      })

      // —— 当前该播什么（顺带把显示参数带下去）
      register(API + '/phase', (req, res) => {
        try {
          sendJson(res, 200, { ...snapshot(), display: displayConfig() })
        } catch (err) {
          sendJson(res, 200, { phase: 'idle', detail: '', active: 0, tools: 0, at: Date.now() })
        }
      })

      // —— 浏览器端报上来的锚点几何
      register(API + '/geom', async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, geom: lastGeom })
          return
        }
        try {
          const raw = await readBody(req)
          const parsed = raw ? JSON.parse(raw) : null
          if (parsed && typeof parsed === 'object') lastGeom = { ...parsed, at: Date.now() }
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 400, { ok: false })
        }
      })

      // —— 排查用：最近 80 个会话事件 + 每个会话的相位
      register(API + '/debug', (req, res) => {
        try {
          const view = []
          for (const [id, s] of sessions) {
            view.push({
              id,
              phase: s.phase,
              detail: s.detail,
              tools: [...s.tools],
              failed: s.failed,
              ageMs: Date.now() - s.at,
            })
          }
          sendJson(res, 200, {
            ok: true,
            now: Date.now(),
            snapshot: snapshot(),
            display: displayConfig(),
            geom: lastGeom,
            sessions: view,
            events: EVENT_LOG,
          })
        } catch (err) {
          sendJson(res, 500, { ok: false })
        }
      })

      // —— 会话活动 → phase
      ctx.on('session/event', (session, event) => {
        try {
          projectSessionEvent(session, event)
        } catch (err) {}
      })
      ctx.on('agent/assistant-stream', (payload) => {
        try {
          projectStreamFrame(payload && payload.agent, payload && payload.frame)
        } catch (err) {}
      })
      ctx.on('session/disposed', (session) => {
        try {
          sessions.delete(String((session && session.id) || 'main'))
        } catch (err) {}
      })

      // —— 网页端注入
      disposers.push(
        ctx.webServer.tapIndex((html) => {
          try {
            if (typeof html !== 'string') return html
            if (html.indexOf(API + '/pet.js') !== -1) return html
            const tag = '<script defer src="' + API + '/pet.js"></script>'
            if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
            return html + tag
          } catch (err) {
            return html
          }
        }),
      )

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (err) {}
        }
      })

      try {
        console.log('[jingniang-pet] 已挂载。素材目录：' + (assetDir || '(未找到)') + '；配置：' + CONFIG_FILE)
      } catch (err) {}
    })
  },
}
