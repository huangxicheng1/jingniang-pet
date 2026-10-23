/**
 * 鲸娘 · 浏览器端
 *
 * 贴在输入框的右上角，脚踩框的顶边，半个身子探在框外。输入框长高、窗口缩放、
 * 侧边栏开合都会实时跟着走。没有输入框的页面自动隐藏。
 *
 * 状态由宿主 /jingniang/phase 给（粗粒度 phase），点击 / 睡觉 / 待机随机动作
 * 全部在这一侧算。零依赖，普通 DOM，不碰 React。
 */
;(function () {
  'use strict'
  if (window.__jingniangPetLoaded) return
  window.__jingniangPetLoaded = true

  var API = '/jingniang'
  var ASSET = API + '/asset/'
  var ASPECT = 528 / 552 // 素材是 552×528

  var FILES = {
    idle: '01-idle.gif',
    look: '02-idle-look.gif',
    spout: '03-idle-spout.gif',
    thinking: '04-thinking.gif',
    typing: '05-typing.gif',
    music: '06-music.gif',
    conducting: '07-conducting.gif',
    building: '08-building.gif',
    error: '09-error.gif',
    happy: '10-happy.gif',
    notification: '11-notification.gif',
    compacting: '12-compacting.gif',
    carrying: '13-carrying.gif',
    sleeping: '14-sleeping.gif',
    waking: '15-waking.gif',
    pokeLeft: '16-poke-left.gif',
    pokeRight: '17-poke-right.gif',
    tickle: '18-tickle.gif',
    swim: '20-swim.gif',
    hearts: '21-smile-hearts.gif',
    thumbs: '22-thumbs-up.gif',
  }

  var IDLE_POOL = ['look', 'spout', 'swim', 'hearts', 'thumbs']
  var BONUS_POOL = ['hearts', 'thumbs']

  var cfg = {
    enabled: true,
    size: 138,
    offsetX: 0,
    offsetY: 0,
    randomIdle: true,
    sleepAfterSeconds: 60,
  }

  // ------------------------------------------------------------ 运行时状态

  var phase = 'idle' // 宿主给的粗粒度相位
  var toolSessions = 1 // 同时有几个会话在跑工具（决定 05/06/08）
  var consumedDoneAt = 0 // 这一轮 done 已经播过了
  var transient = null // { anim, until }
  var lastInput = Date.now() // 最后一次人动
  var wakingUntil = 0
  var nextIdleAt = Date.now() + 9000
  var currentNode = null // 当前动画名
  var clickTimes = []
  var node = null // wrapper
  var img = null
  var menuEl = null
  var anchorEl = null
  var showAnchor = false
  var hiddenByUser = false

  // ------------------------------------------------------------ DOM

  function build() {
    node = document.createElement('div')
    node.id = 'jingniang-pet'
    node.setAttribute('aria-hidden', 'true')
    node.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147482000;display:none;' +
      'pointer-events:none;will-change:transform;transition:opacity .18s ease'
    img = document.createElement('img')
    img.alt = ''
    img.draggable = false
    img.style.cssText =
      'display:block;width:100%;height:auto;pointer-events:auto;cursor:pointer;' +
      'image-rendering:pixelated;user-select:none;-webkit-user-drag:none;' +
      'filter:drop-shadow(0 6px 14px rgba(0,0,0,.35))'
    node.appendChild(img)
    document.body.appendChild(node)

    img.addEventListener('click', onPoke)
    img.addEventListener('contextmenu', onMenu)
    img.addEventListener('dragstart', function (e) {
      e.preventDefault()
    })
    updateSize()
  }

  function updateSize() {
    if (node === null) return
    node.style.width = cfg.size + 'px'
    node.style.height = Math.round(cfg.size * ASPECT) + 'px'
  }

  function show(anim) {
    if (anim === currentNode) return
    currentNode = anim
    var url = ASSET + (FILES[anim] || FILES.idle)
    // 同一个动画再播一次要换 URL，否则 GIF 不会重头
    img.src = url + '?v=' + Date.now()
  }

  // ------------------------------------------------------------ 锚点

  /**
   * 输入框的容器。DSH 的输入区是「textarea + 圆角卡片」，从 textarea 往上找
   * 最近的那层「有圆角、有底色」的祖先 —— 那才是卡片本身。光比宽度不行：
   * 卡片外面那层停靠容器只宽 20% 多，一路爬上去就会把鲸娘挂到页面右边去。
   * 找不到这样的祖先时，退回到「紧挨着输入框的那一层」。
   */
  function findComposer() {
    var ta =
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('[role="textbox"]')
    if (ta === null) return null
    var box = ta.getBoundingClientRect()
    if (box.width < 80) return null

    var el = ta.parentElement
    var inner = el
    if (el !== null && el !== document.body) {
      // 兜底只用「紧挨着输入框的那一层」。宁可少爬，也不能爬到外层停靠容器上 ——
      // 那会让她跑到页面右边去，而且偏得很离谱。
      for (var i = 0; i < 8; i += 1) {
        if (el === null || el === document.body || el === document.documentElement) break
        var b = el.getBoundingClientRect()
        if (b.width < box.width * 0.98 || b.width > box.width * 1.35) break
        var cs = window.getComputedStyle(el)
        var radius = parseFloat(cs.borderTopLeftRadius) || 0
        var bg = String(cs.backgroundColor || '')
        var painted = bg !== '' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)'
        if (radius >= 8 && painted) return { el: el, box: b, how: 'card', ta: box }
        box = b
        el = el.parentElement
      }
    }
    if (inner === null || inner === document.body) return { el: ta, box: ta.getBoundingClientRect(), how: 'self', ta: box }
    return { el: inner, box: inner.getBoundingClientRect(), how: 'fallback', ta: box }
  }

  function rectOf(el) {
    if (el === null) return null
    var b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }

  // 把量到的锚点报给宿主，方便用数字调位置而不是靠猜
  var lastReport = ''
  var lastReportAt = 0
  function reportGeom(found, petX, petY) {
    var now = Date.now()
    if (now - lastReportAt < 1500) return
    var payload = JSON.stringify({
      viewport: { w: window.innerWidth, h: window.innerHeight },
      how: found.how,
      anchor: {
        tag: found.el.tagName,
        cls: String(found.el.className || '').slice(0, 90),
        ...rectOf(found.el),
      },
      textarea: found.ta ? { x: Math.round(found.ta.x), y: Math.round(found.ta.y), w: Math.round(found.ta.width), h: Math.round(found.ta.height) } : null,
      pet: { x: petX, y: petY, size: cfg.size },
    })
    if (payload === lastReport) return
    lastReport = payload
    lastReportAt = now
    fetch(API + '/geom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(function () {})
  }

  function reposition() {
    if (node === null) return
    if (hiddenByUser || !cfg.enabled) {
      node.style.display = 'none'
      hideAnchor()
      return
    }
    var found = findComposer()
    if (found === null) {
      node.style.display = 'none'
      hideAnchor()
      return
    }
    var box = found.box
    var h = Math.round(cfg.size * ASPECT)
    var x = Math.round(box.right - cfg.size + 8 + cfg.offsetX)
    var y = Math.round(box.top - h + Math.round(h * 0.16) + cfg.offsetY)
    var maxX = window.innerWidth - cfg.size - 4
    if (x > maxX) x = maxX
    if (x < 4) x = 4
    node.style.display = 'block'
    node.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'
    if (showAnchor) showAnchorBox(box)
    else hideAnchor()
    reportGeom(found, x, y)
  }

  function showAnchorBox(box) {
    if (anchorEl === null) {
      anchorEl = document.createElement('div')
      anchorEl.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147481999;' +
        'border:1px dashed #5ae7c4;border-radius:12px;background:rgba(90,231,196,.06)'
      document.body.appendChild(anchorEl)
    }
    anchorEl.style.display = 'block'
    anchorEl.style.left = box.left + 'px'
    anchorEl.style.top = box.top + 'px'
    anchorEl.style.width = box.width + 'px'
    anchorEl.style.height = box.height + 'px'
  }

  function hideAnchor() {
    if (anchorEl !== null) anchorEl.style.display = 'none'
  }

  // ------------------------------------------------------------ 相位 → 动画

  function phaseAnim() {
    if (phase === 'tool') {
      if (toolSessions >= 3) return 'building'
      if (toolSessions === 2) return 'music'
      return 'typing'
    }
    if (phase === 'waiting' || phase === 'thinking') return 'thinking'
    if (phase === 'review') return 'thinking'
    if (phase === 'failed') return 'error'
    if (phase === 'confirm') return 'notification'
    if (phase === 'compacting') return 'compacting'
    if (phase === 'carrying') return 'carrying'
    return 'idle'
  }

  function asleep() {
    if (cfg.sleepAfterSeconds <= 0) return false
    if (phase !== 'idle') return false
    return Date.now() - lastInput > cfg.sleepAfterSeconds * 1000
  }

  function tick() {
    reposition()
    if (hiddenByUser || !cfg.enabled || node === null) return
    var now = Date.now()

    if (transient !== null) {
      if (now < transient.until) {
        show(transient.anim)
        return
      }
      transient = null
    }

    if (now < wakingUntil) {
      show('waking')
      return
    }

    // 一轮做完：先开心，再随机一个彩蛋，然后回待机
    if (phase === 'done') {
      if (consumedDoneAt === 0) {
        consumedDoneAt = -1
        play('happy', 1800)
        setTimeout(function () {
          if (phase === 'done' && transient === null) play(BONUS_POOL[Math.floor(Math.random() * BONUS_POOL.length)], 1500)
        }, 1900)
        show('happy')
        return
      }
      show('idle')
      return
    }
    consumedDoneAt = 0

    if (asleep()) {
      show('sleeping')
      return
    }

    if (phase !== 'idle') {
      show(phaseAnim())
      return
    }

    // 待机：偶尔自己演一个小动作
    if (cfg.randomIdle && now > nextIdleAt) {
      nextIdleAt = now + 11000 + Math.random() * 13000
      play(IDLE_POOL[Math.floor(Math.random() * IDLE_POOL.length)], 2600)
      return
    }
    show('idle')
  }

  function play(anim, ms) {
    transient = { anim: anim, until: Date.now() + (ms || 1600) }
    currentNode = null // 同一个动作连点两次也要从头播
    show(anim)
  }

  // ------------------------------------------------------------ 互动

  function onPoke(e) {
    e.preventDefault()
    e.stopPropagation()
    var rect = img.getBoundingClientRect()
    var left = e.clientX < rect.left + rect.width / 2
    clickTimes.push(Date.now())
    clickTimes = clickTimes.filter(function (t) {
      return Date.now() - t < 1000
    })
    if (clickTimes.length >= 3) {
      clickTimes = []
      play('tickle', 1700)
      return
    }
    play(left ? 'pokeLeft' : 'pokeRight', 1700)
  }

  function markActive() {
    lastInput = Date.now()
  }

  ;['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, markActive, { passive: true, capture: true })
  })

  // ------------------------------------------------------------ 右键菜单

  function closeMenu() {
    if (menuEl !== null) {
      menuEl.remove()
      menuEl = null
    }
  }

  function menuButton(label, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText =
      'appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);' +
      'color:#e8eaf6;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'padding:5px 9px;border-radius:7px;cursor:pointer'
    b.addEventListener('mouseenter', function () {
      b.style.background = 'rgba(255,255,255,.14)'
    })
    b.addEventListener('mouseleave', function () {
      b.style.background = 'rgba(255,255,255,.06)'
    })
    b.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    })
    return b
  }

  function row(label, buttons) {
    var wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0'
    var text = document.createElement('span')
    text.textContent = label
    text.style.cssText = 'font:11px/1.4 system-ui,sans-serif;color:#9aa3c7;min-width:52px'
    wrap.appendChild(text)
    buttons.forEach(function (b) {
      wrap.appendChild(b)
    })
    return wrap
  }

  function save(patch) {
    Object.keys(patch).forEach(function (k) {
      cfg[k] = patch[k]
    })
    updateSize()
    reposition()
    fetch(API + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(function () {})
  }

  function onMenu(e) {
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
    var rows = []

    rows.push(
      row('大小', [
        menuButton('138', function () {
          save({ size: 138 })
          closeMenu()
        }),
        menuButton('207', function () {
          save({ size: 207 })
          closeMenu()
        }),
        menuButton('276', function () {
          save({ size: 276 })
          closeMenu()
        }),
      ]),
    )

    var nudge = function (dx, dy) {
      return function () {
        save({ offsetX: cfg.offsetX + dx, offsetY: cfg.offsetY + dy })
      }
    }
    rows.push(row('微调', [menuButton('←', nudge(-4, 0)), menuButton('↑', nudge(0, -4)), menuButton('↓', nudge(0, 4)), menuButton('→', nudge(4, 0)), menuButton('归零', function () { save({ offsetX: 0, offsetY: 0 }) })]))

    rows.push(
      row('小动作', [
        menuButton(cfg.randomIdle ? '开' : '关', function () {
          save({ randomIdle: !cfg.randomIdle })
          closeMenu()
          onMenu(e)
        }),
      ]),
    )

    rows.push(
      row('其他', [
        menuButton(showAnchor ? '藏起锚点' : '看锚点', function () {
          showAnchor = !showAnchor
          reposition()
          closeMenu()
        }),
        menuButton('今天先藏', function () {
          hiddenByUser = true
          closeMenu()
          reposition()
        }),
      ]),
    )

    menuEl = document.createElement('div')
    menuEl.style.cssText =
      'position:fixed;z-index:2147482001;min-width:196px;padding:8px 10px;' +
      'border-radius:12px;background:rgba(22,24,38,.97);border:1px solid rgba(255,255,255,.12);' +
      'box-shadow:0 12px 32px rgba(0,0,0,.45);backdrop-filter:blur(8px)'
    rows.forEach(function (r) {
      menuEl.appendChild(r)
    })
    document.body.appendChild(menuEl)

    var w = 216
    var h = menuEl.getBoundingClientRect().height
    var x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w + 40))
    var y = Math.max(8, e.clientY - h - 8)
    menuEl.style.left = x + 'px'
    menuEl.style.top = y + 'px'

    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true)
    }, 0)
  }

  function onDocDown(ev) {
    if (menuEl !== null && !menuEl.contains(ev.target)) {
      closeMenu()
      document.removeEventListener('mousedown', onDocDown, true)
    }
  }

  // ------------------------------------------------------------ 数据

  function loadConfig() {
    fetch(API + '/config', { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        if (data && data.config) {
          Object.keys(cfg).forEach(function (k) {
            if (data.config[k] !== undefined) cfg[k] = data.config[k]
          })
          updateSize()
          reposition()
        }
      })
      .catch(function () {})
  }

  /** 宿主每次轮询都带上当前显示参数，改了 ~\.dsh\jingniang-pet.json 立刻就生效，不用刷新。 */
  function applyDisplay(d) {
    if (!d) return
    var changed = false
    if (typeof d.size === 'number' && d.size !== cfg.size) {
      cfg.size = d.size
      changed = true
    }
    if (typeof d.offsetX === 'number' && d.offsetX !== cfg.offsetX) {
      cfg.offsetX = d.offsetX
      changed = true
    }
    if (typeof d.offsetY === 'number' && d.offsetY !== cfg.offsetY) {
      cfg.offsetY = d.offsetY
      changed = true
    }
    if (typeof d.enabled === 'boolean' && d.enabled !== cfg.enabled) {
      cfg.enabled = d.enabled
      changed = true
    }
    if (typeof d.randomIdle === 'boolean' && d.randomIdle !== cfg.randomIdle) {
      cfg.randomIdle = d.randomIdle
      changed = true
    }
    if (changed) {
      updateSize()
      reposition()
    }
  }

  function poll() {
    fetch(API + '/phase', { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        if (!data) return
        var next = String(data.phase || 'idle')
        if (next !== phase && next !== 'idle' && asleep()) {
          // 睡着的时候她开始干活了：先被吵醒，再切到正经动作
          wakingUntil = Date.now() + 1500
          markActive()
        }
        phase = next
        toolSessions = Math.max(1, Number(data.toolSessions || 0) || 1)
        applyDisplay(data.display)
      })
      .catch(function () {
        phase = 'idle'
      })
  }

  // ------------------------------------------------------------ 启动

  function boot() {
    if (document.body === null) {
      setTimeout(boot, 200)
      return
    }
    build()
    loadConfig()
    poll()
    setInterval(poll, 700)
    setInterval(tick, 140)
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        markActive()
        poll()
        reposition()
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
