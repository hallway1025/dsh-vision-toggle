/**
 * dsh-vision-toggle — 浏览器半身（client bundle）。
 *
 * 加载合同（B1 冻结，实证自 ofm 2.8.0 client.js）：
 *   window.__ModuleLoader__.load({ id, factory: require => {...} })
 *   factory 返回 { apply(ctx), inject: ['slots'], name }
 *   apply 里 ctx.slots.inject(槽名, () => ctx.slots.register(描述, 组件))
 *
 * 通信面：GET /api/vision-toggle/status · POST /mode · POST /snapshot
 *         SSE /api/vision-toggle/events（档位变化广播）
 *
 * 槽位：conversation.input.left（0.2.1 起让出 model 槽给原生模型选择器，m08294/m08342）。
 * 五档胶囊 + 截图键 + 自定义清晰度（规格 §四 / 决策 5 / m08444）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-toggle',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef } = React
    // 编辑层 portal 到 body：插件 slot 容器的祖先链可能带 stacking context（transform/contain 等），
    // fixed+zIndex 顶格也盖不过宿主自绘标题栏 → 误点 DSH 的 ✕ 关窗（m10003）。
    // L-247 禁的是命令式孤儿层；portal 由 React 管理，卸载即摘除，不违背。
    let createPortal = null
    try { createPortal = require('react-dom').createPortal } catch {}
    if (!createPortal) createPortal = React.createPortal || null
    const asOverlay = (el) => (createPortal ? createPortal(el, document.body) : el)

    const MODES = [
      { id: 'off', label: 'off' },
      { id: 'low', label: 'low' },
      { id: 'high', label: 'high' },
      { id: 'max', label: 'max' },
      { id: 'ultra', label: 'ultra' },
      { id: 'custom', label: '自定义' },
    ]
    const TITLES = {
      off: 'off：视觉关，采集停止',
      low: 'low：大动作才留帧进池，模型自主 peek（最省）',
      high: 'high：过线帧全进缓存池，模型自主 peek',
      max: 'max：最灵敏持续感知（门槛 7），全进池零打扰',
      ultra: 'ultra：满幅拉满·最高灵敏度（开启有警告）',
      custom: '自定义：清晰度 × 节奏自由组合',
    }
    const API = '/api/vision-toggle'

    async function api(path, opts) {
      const r = await fetch(API + path, opts)
      if (!r.ok) {
        let msg = 'HTTP ' + r.status
        try { const j = await r.json(); if (j && j.error) msg = j.error } catch {}
        const e = new Error(msg); e.status = r.status; throw e
      }
      return r.json()
    }

    const rowStyle = {
      display: 'inline-flex', alignItems: 'center', gap: '3px',
      verticalAlign: 'middle', marginLeft: '6px',
    }
    // R23 弹窗浮层：fixed 覆盖 + 居中小卡（不依赖宿主组件库，主题变量取色）
    const overlayStyle = {
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }
    const dialogStyle = {
      maxWidth: '420px', width: '86%', padding: '16px',
      borderRadius: '10px', background: 'var(--dsh-bg-color, #fff)',
      border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.35))',
      boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
    }
    const dialogTextStyle = { fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: '12px' }
    const dlgBtn = (primary) => ({
      fontSize: '12px', padding: '5px 14px', borderRadius: '6px', cursor: 'pointer',
      border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.35))',
      background: primary ? 'var(--dsh-primary-color, #2563eb)' : 'transparent',
      color: primary ? '#fff' : 'inherit',
    })
    const btnStyle = (active) => ({
      fontSize: '12px', lineHeight: '1', padding: '4px 9px',
      borderRadius: '999px', cursor: 'pointer', border: '1px solid',
      borderColor: active ? 'transparent' : 'var(--dsh-border-color, rgba(127,127,127,0.35))',
      background: active ? 'var(--dsh-primary-color, #4f7cff)' : 'transparent',
      color: active ? '#fff' : 'inherit',
      opacity: active ? 1 : 0.78,
      transition: 'opacity .12s, background .12s',
    })

    // ── 截图编辑层（React 版 v2，0.6.2）──
    // v1（b2dd58e）修孤儿层锁死（m09567）：React 条件渲染 + 四道保底闸（Esc/watchdog/点空白/加载失败）。
    // v2（m09618 主人反馈）：
    //   ①crop 阶段：先拖框选区再标注（微信式）；Enter=全屏；选区亮窗+四周暗化+尺寸标签。
    //   ②性能：底图+已定笔预渲染进离屏 cache 层，拖动帧只做 2 次 drawImage（生涩主因=全画布逐帧重绘）。
    //   ③重截 png 更新自动回 crop 阶段。
    const VTS_COLORS = ['#ff3b30', '#f5c518', '#34c759', '#3b82f6', '#ffffff', '#111111']
    const VTS_WIDTHS = [2, 4, 8]
    const VTS_WDOT = { 2: 6, 4: 10, 8: 14 }
    const VTS_CSS = [
      '.vts-bar{display:flex;align-items:center;background:rgba(20,20,20,.96);border-radius:12px;padding:5px 8px;box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:96vw}',
      '.vts-btn{width:34px;height:34px;margin:0 2px;border:none;border-radius:8px;background:rgba(255,255,255,.12);color:#fff;font-size:17px;cursor:pointer;padding:0;line-height:34px;text-align:center;box-sizing:border-box;transition:background .1s;flex:none}',
      '.vts-btn:hover{background:rgba(255,255,255,.22)}',
      '.vts-btn.vts-on{background:#4f7cff}',
      '.vts-btn.vts-on:hover{background:#5d88ff}',
      '.vts-dot{width:26px;height:26px;margin:0 2px;border:2px solid rgba(255,255,255,.3);border-radius:50%;cursor:pointer;padding:0;box-sizing:border-box;flex:none;transition:transform .1s}',
      '.vts-dot:hover{transform:scale(1.15)}',
      '.vts-dot.vts-on{border-color:#fff;box-shadow:0 0 0 2px rgba(79,124,255,.9)}',
      '.vts-w{width:32px;height:34px;margin:0 2px;border:none;border-radius:8px;background:transparent;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;flex:none;transition:background .1s}',
      '.vts-w:hover{background:rgba(255,255,255,.12)}',
      '.vts-w.vts-on{background:#4f7cff}',
      '.vts-sep{width:1px;height:22px;background:rgba(255,255,255,.18);margin:0 6px;flex:none}',
      '.vts-txt{padding:5px 10px;border-radius:6px;border:none;background:transparent;color:rgba(255,255,255,.85);font-size:12px;cursor:pointer;white-space:nowrap;flex:none;transition:background .1s}',
      '.vts-txt:hover{background:rgba(255,255,255,.12)}',
      '.vts-txt.vts-on{background:#4f7cff;color:#fff}',
    ].join('')

    function ShotEditor({ png, onClose, onDone }) {
      const cvRef = useRef(null)
      const stRef = useRef({ ops: [], redo: [], base: null, cache: null, drawing: null })
            // 全屏隐藏 DSH 原生窗口键（WCO titleBarOverlay 是 OS 层，网页盖不住；全屏时系统自动摘掉）
      const [fsOK, setFsOK] = useState(false)
      useEffect(() => {
        let alive = true
        const root = document.documentElement
        try {
          const p = root.requestFullscreen?.({ navigationUI: 'hide' })
          if (p && p.then) p.then(() => { if (alive) setFsOK(true) }).catch(() => {})
          else if (p) Promise.resolve(p).then(() => { if (alive) setFsOK(true) }).catch(() => {})
        } catch {}
        return () => { alive = false; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}) }
      }, [])
      const [tool, setTool] = useState('rect')
      const [color, setColor] = useState('#ff3b30')
      const [sel, setSel] = useState(null)         // 已定选区（图像坐标）
      const dragRef = useRef(null)
      const [dragTick, setDragTick] = useState(0)  // 拖动帧重渲染信号
      const [txt, setTxt] = useState(null)
      const [txtVal, setTxtVal] = useState('')
      const txtValRef = useRef('')
      const [ready, setReady] = useState(false)
      const st = stRef.current
      const imgRef = useRef(null)
      const selRef = useRef(null); selRef.current = sel
      // 0.7.0：工具状态 ref 直读（消灭闭包陈旧）+ 缩放/平移
      const toolRef = useRef('rect'); const colorRef = useRef('#ff3b30'); const widthRef = useRef(4)
      const [width, setWidth] = useState(4)
      const [zoom, setZoom] = useState(null)          // null=适合窗口（auto fit）；数字=显式缩放
      const zoomRef = useRef(null)
      const [space, setSpace] = useState(false)       // Space 按住=平移模式
      const spaceRef = useRef(false)
      const panRef = useRef(null)                     // {sx,sy,sl,st} 平移起点
      const wrapRef = useRef(null)                    // edit 阶段滚动容器
      const txtRef = useRef(false)

      // 原图加载；png 变化（重截）自动回 crop
      useEffect(() => {
        const img = new Image()
        img.onload = () => { imgRef.current = img; setSel(null); dragRef.current = null; setReady(true) }
        img.onerror = () => onClose()
        img.src = 'data:image/png;base64,' + png
      }, [png])

      // Esc 分层：edit+txt 开=只关输入框 / crop+有选区=清选区 / 其他=关；Enter(crop)=确认选区（无选区=全屏）；
      // Ctrl+Z/Y(edit)=撤销重做；Space(edit)=平移模式；输入框聚焦时按键不进编辑器热键；
      // watchdog 180s 硬关（保底闸②）；React 卸载必然 cleanup
      useEffect(() => {
        const key = (e) => {
          const tag = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)
          if (e.code === 'Space' && !tag) {
            e.preventDefault()
            if (!spaceRef.current) { spaceRef.current = true; setSpace(true) }
            return
          }
          if (tag) return
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (txtRef.current) { txtValRef.current = ''; setTxtVal(''); setTxt(null); return }
            if (toolRef.current === 'crop') { toolRef.current = 'rect'; setTool('rect'); setSel(null); dragRef.current = null }
            else onClose()
          } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
            e.preventDefault(); undo()
          } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
            e.preventDefault(); redoOp()
          }
        }
        const kup = (e) => { if (e.code === 'Space' && spaceRef.current) { spaceRef.current = false; setSpace(false) } }
        window.addEventListener('keydown', key, true)
        window.addEventListener('keyup', kup)
        const guard = setTimeout(() => { try { onClose() } catch {} }, 180000)
        return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', kup); clearTimeout(guard) }
      }, [])

      // 滚轮缩放（edit 阶段；fit 态以当前实际显示比例为基准；以鼠标为锚点补偿滚动）
      useEffect(() => {
        if (!ready) return
        const wrap = wrapRef.current
        if (!wrap) return
        const onWheel = (e) => {
          e.preventDefault()
          const cv = cvRef.current
          if (!cv || !cv.width) return
          const rect = cv.getBoundingClientRect()
          if (!rect.width) return
          const oldZ = zoomRef.current == null ? (rect.width / cv.width) : zoomRef.current
          const nz = Math.min(4, Math.max(0.25, oldZ * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
          const ix = (e.clientX - rect.left) / oldZ
          const iy = (e.clientY - rect.top) / oldZ
          zoomRef.current = nz
          setZoom(nz)
          requestAnimationFrame(() => {
            const r2 = cv.getBoundingClientRect()
            const wr = wrap.getBoundingClientRect()
            wrap.scrollLeft = ix * nz - (e.clientX - wr.left)
            wrap.scrollTop = iy * nz - (e.clientY - wr.top)
          })
        }
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => wrap.removeEventListener('wheel', onWheel)
      }, [ready])

      function drawOp(g, op) {
        g.strokeStyle = op.c; g.fillStyle = op.c; g.lineWidth = op.w
        g.lineCap = 'round'; g.lineJoin = 'round'
        if (op.t === 'rect') {
          g.strokeRect(Math.min(op.x, op.x2), Math.min(op.y, op.y2), Math.abs(op.x2 - op.x), Math.abs(op.y2 - op.y))
        } else if (op.t === 'arr') {
          const a = Math.atan2(op.y2 - op.y, op.x2 - op.x), hLen = Math.max(10, op.w * 4)
          g.beginPath(); g.moveTo(op.x, op.y); g.lineTo(op.x2, op.y2)
          g.lineTo(op.x2 - hLen * Math.cos(a - 0.45), op.y2 - hLen * Math.sin(a - 0.45))
          g.moveTo(op.x2, op.y2); g.lineTo(op.x2 - hLen * Math.cos(a + 0.45), op.y2 - hLen * Math.sin(a + 0.45))
          g.stroke()
        } else if (op.t === 'text') {
          g.font = (op.w * 6 + 12) + 'px system-ui,sans-serif'; g.fillText(op.s, op.x, op.y)
        } else if (op.t === 'mos') {
          const cv = cvRef.current
          const x0 = Math.max(0, Math.min(op.x, op.x2)), y0 = Math.max(0, Math.min(op.y, op.y2))
          const w = Math.min(cv.width - x0, Math.abs(op.x2 - op.x)), hgt = Math.min(cv.height - y0, Math.abs(op.y2 - op.y))
          if (w < 1 || hgt < 1) return
          const t = document.createElement('canvas'); const sz = 14
          t.width = Math.ceil(w / sz); t.height = Math.ceil(hgt / sz)
          t.getContext('2d').drawImage(st.base, x0, y0, w, hgt, 0, 0, t.width, t.height) // 永远原图取样
          g.imageSmoothingEnabled = false
          g.drawImage(t, x0, y0, w, hgt)
          g.imageSmoothingEnabled = true
        }
      }
      // 性能主修复：底图+已定笔 → 离屏 cache 层（只随 ops 变化重画）
      function redrawStatic() {
        const cv = cvRef.current; if (!cv) return
        if (!st.cache || st.cache.width !== cv.width || st.cache.height !== cv.height) {
          st.cache = document.createElement('canvas')
          st.cache.width = cv.width; st.cache.height = cv.height
        }
        const g = st.cache.getContext('2d')
        g.clearRect(0, 0, st.cache.width, st.cache.height)
        if (st.base) g.drawImage(st.base, 0, 0)
        for (const op of st.ops) drawOp(g, op)
      }
      // 拖动帧：cache 一贴 + 当前笔一画（共 2 次 drawImage 级别，替代全画布重绘）
      function redraw(extra) {
        const cv = cvRef.current; if (!cv) return
        const g = cv.getContext('2d')
        g.clearRect(0, 0, cv.width, cv.height)
        if (!st.cache) redrawStatic()
        if (st.cache) g.drawImage(st.cache, 0, 0)
        if (extra) drawOp(g, extra)
      }
      const toImg = (e) => {
        const cv = cvRef.current; const r = cv.getBoundingClientRect()
        return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }
      }
      // 拖动跟随挂 window（React 卸载 cleanup）
      useEffect(() => {
        const mv = (e) => {
          if (panRef.current) {
            const wrap = wrapRef.current
            if (wrap) { wrap.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.sx); wrap.scrollTop = panRef.current.st - (e.clientY - panRef.current.sy) }
            return
          }
          if (!dragRef.current && !st.drawing) return
          if (toolRef.current === 'crop' && dragRef.current) {
            const p = toImgCrop(e)
            dragRef.current = { ...dragRef.current, x2: p.x, y2: p.y }
            setDragTick((t) => t + 1)
          } else if (toolRef.current !== 'crop' && st.drawing) {
            const p = toImg(e); st.drawing.x2 = p.x; st.drawing.y2 = p.y; redraw(st.drawing)
          }
        }
        const up = () => {
          if (panRef.current) { panRef.current = null; return }
          if (toolRef.current === 'crop' && dragRef.current) {
            const r = dragRef.current; dragRef.current = null
            if (Math.abs(r.x2 - r.x) >= 5 && Math.abs(r.y2 - r.y) >= 5) { setSel(r); confirmRect(r) }
            else setDragTick((t) => t + 1)
            return
          }
          if (toolRef.current !== 'crop' && st.drawing) {
            const d = st.drawing; st.drawing = null
            const tiny = Math.abs(d.x2 - d.x) < 3 && Math.abs(d.y2 - d.y) < 3 && d.t !== 'mos'
            if (!tiny) { st.ops.push(d); st.redo = []; redrawStatic() }
            redraw()
          }
        }
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
        return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
      }, [])

      // ---- crop 阶段 ----
      const toImgCrop = (e) => {
        const cv = cvRef.current; if (!cv || !st.base) return { x: 0, y: 0 }
        const r = cv.getBoundingClientRect()
        return { x: (e.clientX - r.left) * st.base.width / r.width, y: (e.clientY - r.top) * st.base.height / r.height }
      }
      const cropStart = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p = toImgCrop(e)
        dragRef.current = { x: p.x, y: p.y, x2: p.x, y2: p.y }
        setSel(null)
      }
      function confirmRect(r) {
        const b = st.base
        if (!b) return
        let sx = 0, sy = 0, sw = b.width, sh = b.height
        if (r) {
          sx = Math.max(0, Math.min(r.x, r.x2)); sy = Math.max(0, Math.min(r.y, r.y2))
          sw = Math.abs(r.x2 - r.x); sh = Math.abs(r.y2 - r.y)
          if (sw < 5 || sh < 5) { setSel(null); return }
        }
        const c = document.createElement('canvas')
        c.width = sw; c.height = sh
        c.getContext('2d').drawImage(b, sx, sy, sw, sh, 0, 0, sw, sh)
        st.base = c; st.ops = []; st.redo = []; st.cache = null
        setSel(null)
        zoomRef.current = null; setZoom(null)
        toolRef.current = 'rect'; setTool('rect')
        const cv = cvRef.current
        if (cv) { cv.width = sw; cv.height = sh }
        redrawStatic(); redraw()
      }
      // edit 阶段画布初始化（base=整图；裁剪=工具，见 confirmRect）
      useEffect(() => {
        const cv = cvRef.current; if (!cv || !st.base) return
        cv.width = st.base.width; cv.height = st.base.height
        redrawStatic(); redraw()
      }, [ready])

      // ---- edit 阶段交互 ----
      const start = (e) => {
        e.preventDefault()
        if (e.button === 1 || spaceRef.current) {        // 中键 / Space+左键 = 平移
          const wrap = wrapRef.current
          if (wrap) panRef.current = { sx: e.clientX, sy: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop }
          return
        }
        if (e.button !== 0) return
        if (toolRef.current === 'crop') { const p = toImgCrop(e); dragRef.current = { x: p.x, y: p.y, x2: p.x, y2: p.y }; setSel(null); return }
        if (toolRef.current === 'text') { const p = toImg(e); setTxt({ cx: e.clientX, cy: e.clientY, px: p.x, py: p.y }); setTxtVal(''); txtValRef.current = ''; return }
        const p = toImg(e)
        st.drawing = { t: toolRef.current, c: colorRef.current, w: widthRef.current, x: p.x, y: p.y, x2: p.x, y2: p.y }
      }
      const undo = () => { const op = st.ops.pop(); if (op) st.redo.push(op); redrawStatic(); redraw() }
      const redoOp = () => { const op = st.redo.pop(); if (op) st.ops.push(op); redrawStatic(); redraw() }
      const commitText = () => {
        const v = txtValRef.current
        txtValRef.current = ''
        setTxtVal('')
        if (txt && v.trim()) { st.ops.push({ t: 'text', c: colorRef.current, w: widthRef.current, x: txt.px, y: txt.py, s: v }); st.redo = []; redrawStatic() }
        setTxt(null)
        redraw()
      }
      const finish = () => {
        try {
          const cv = cvRef.current
          cv.toBlob((blob) => {
            const fr = new FileReader()
            fr.onload = () => onDone(String(fr.result).split(',')[1] || '')
            fr.onerror = () => onClose()
            fr.readAsDataURL(blob)
          }, 'image/png')
        } catch { onClose() }
      }
      const sep = (k) => h('span', { key: k, className: 'vts-sep' })
      const toolBtn = (id, label, title) => h('button', {
        key: id, type: 'button', title, className: 'vts-btn' + (tool === id ? ' vts-on' : ''),
        onClick: () => { toolRef.current = id; setTool(id) },
      }, label)
      const colorBtn = (c) => h('button', {
        key: c, type: 'button', title: '颜色 ' + c, className: 'vts-dot' + (color === c ? ' vts-on' : ''),
        style: { background: c }, onClick: () => { colorRef.current = c; setColor(c) },
      })
      const widthBtn = (w) => h('button', {
        key: 'w' + w, type: 'button', title: '线条粗细 ' + w, className: 'vts-w' + (width === w ? ' vts-on' : ''),
        onClick: () => { widthRef.current = w; setWidth(w) },
      }, h('span', { style: { display: 'block', width: VTS_WDOT[w] + 'px', height: VTS_WDOT[w] + 'px', borderRadius: '50%', background: color } }))
      const barBtn = (label, title, onClick, bg) => h('button', {
        key: title, type: 'button', title, className: 'vts-btn', style: bg ? { background: bg } : null, onClick,
      }, label)

      if (!ready) {
        return asOverlay(h('div', { style: { position: 'fixed', inset: 0, zIndex: 2147483646, background: 'rgba(17,17,17,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h('div', { style: { color: '#99a', fontSize: '13px' } }, '截图加载中…')))
      }
      const img = imgRef.current
      const liveSel = dragRef.current ?? sel
      txtRef.current = !!txt
      const box = (r) => ({
        left: (Math.min(r.x, r.x2) / cvsW * 100) + '%',
        top: (Math.min(r.y, r.y2) / cvsH * 100) + '%',
        width: (Math.abs(r.x2 - r.x) / cvsW * 100) + '%',
        height: (Math.abs(r.y2 - r.y) / cvsH * 100) + '%',
      })
      // 缩放渲染：null=适合（max 约束）；数字=显式宽高
      const cvsW = st.base ? st.base.width : 0
      const cvsH = st.base ? st.base.height : 0
      const cvsStyle = zoom == null
        ? { maxWidth: '94vw', maxHeight: '76vh', cursor: space ? 'grab' : 'crosshair', boxShadow: '0 6px 30px rgba(0,0,0,.6)', background: '#000' }
        : { width: Math.round(cvsW * zoom) + 'px', height: Math.round(cvsH * zoom) + 'px', maxWidth: 'none', maxHeight: 'none', cursor: space ? 'grab' : 'crosshair', boxShadow: '0 6px 30px rgba(0,0,0,.6)', background: '#000' }
      const zoomLabel = zoom == null ? '适合' : Math.round(zoom * 100) + '%'
      return asOverlay(h('div', {
        style: { position: 'fixed', inset: 0, zIndex: 2147483646, background: 'rgba(17,17,17,.92)', overflow: 'hidden', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
        onContextMenu: (e) => e.preventDefault(),
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() }, // 保底闸③
      },
        h('style', null, VTS_CSS),
        h('button', { type: 'button', title: '退出截图（不贴图）', onClick: onClose, style: { position: 'absolute', top: (fsOK ? '12px' : '48px'), right: '14px', width: '34px', height: '34px', borderRadius: '8px', border: 'none', background: 'rgba(255,255,255,.14)', color: '#fff', fontSize: '15px', cursor: 'pointer', zIndex: 3 } }, '✕'),
        // 主体（上图下条，QQ 同款：工具条贴图下方）；框选不再是独立阶段，裁剪=工具条上的 ⛶ 工具
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' } },
              h('div', { ref: wrapRef, style: { overflow: 'auto', maxWidth: '94vw', maxHeight: '76vh', lineHeight: 0 } },
                h('div', { style: { position: 'relative', display: 'inline-block', lineHeight: 0 } },
                  h('canvas', { ref: cvRef, onMouseDown: start, style: cvsStyle }),
                  liveSel ? h('div', { style: { position: 'absolute', ...box(liveSel), boxShadow: '0 0 0 9999px rgba(0,0,0,.55)', border: '1px solid #4f7cff', cursor: 'crosshair', pointerEvents: 'none' } },
                    h('span', { style: { position: 'absolute', right: 0, bottom: '-24px', color: '#fff', fontSize: '12px', background: 'rgba(0,0,0,.65)', padding: '1px 8px', borderRadius: '4px', whiteSpace: 'nowrap' } },
                      Math.round(Math.abs(liveSel.x2 - liveSel.x)) + ' × ' + Math.round(Math.abs(liveSel.y2 - liveSel.y))),
                  ) : null,
                ),
              ),
              h('div', { className: 'vts-bar' },
                toolBtn('crop', '⛶', '裁剪：拖选区域，松手裁剪（Esc 退出裁剪）'), toolBtn('rect', '□', '矩形框选'), toolBtn('arr', '↗', '箭头'), toolBtn('text', 'T', '文字'), toolBtn('mos', '▒', '马赛克'),
                sep('s1'),
                VTS_COLORS.map((c) => colorBtn(c)),
                sep('s2'),
                VTS_WIDTHS.map((w) => widthBtn(w)),
                sep('s3'),
                barBtn('↶', '撤销 (Ctrl+Z)', undo), barBtn('↷', '重做 (Ctrl+Y)', redoOp),
                sep('s4'),
                h('button', { key: 'fit', type: 'button', title: '适合窗口 · 滚轮缩放（25%~400%）· Space 或中键拖动平移', className: 'vts-txt' + (zoom == null ? ' vts-on' : ''), onClick: () => { zoomRef.current = null; setZoom(null) } }, '适合'),
                h('button', { key: 'z100', type: 'button', title: '原始大小 1:1', className: 'vts-txt' + (zoom === 1 ? ' vts-on' : ''), onClick: () => { zoomRef.current = 1; setZoom(1) } }, '1:1'),
                h('span', { key: 'zl', style: { color: 'rgba(255,255,255,.6)', fontSize: '12px', minWidth: '44px', textAlign: 'center' } }, zoomLabel),
                sep('s5'),
                barBtn('✓', '完成，贴进聊天框', finish, '#2ea44f'),
              ),
            ),
        // 文字输入（edit 阶段）
        txt ? h('input', {
          autoFocus: true, value: txtVal,
          onChange: (e) => { txtValRef.current = e.target.value; setTxtVal(e.target.value) },
          onKeyDown: (e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitText()
            else if (e.key === 'Escape') { e.stopPropagation(); txtValRef.current = ''; setTxtVal(''); setTxt(null) }
          },
          onBlur: commitText,
          style: { position: 'fixed', left: txt.cx + 'px', top: txt.cy + 'px', zIndex: 4, fontSize: '18px', padding: '4px 8px', borderRadius: '6px', border: '2px solid #4f7cff', background: 'rgba(255,255,255,.95)', color: '#111' },
        }) : null,
      ))
    }

    function Capsule() {
      // undefined=还没探到后端（渲染 null）；null=探过但后端不在（也渲染 null）
      const [mode, setMode] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [hint, setHint] = useState(null) // 截图键轻提示（非错误）
      const [shot, setShot] = useState(null) // 截图编辑层：null=关 / {png}=开（React 条件渲染）
      // R23 自定义弹窗：text=正文，resolve 由按钮回调完成（Promise 挂在 ref 上）
      const [confirmText, setConfirmText] = useState(null)
      const confirmResolve = useRef(null)
      const modeRef = useRef(mode)
      modeRef.current = mode
      // 2 键 UI（m08294 两键 / m08444 线条图标 + GPT 式档位菜单 + 自定义清晰度）
      const [open, setOpen] = useState(false)
      const [view, setView] = useState('main') // 面板视图：main=档位列表 / custom=清晰度
      const [qStatus, setQStatus] = useState(null) // 当前生效清晰度（/status 回显）
      const [pStatus, setPStatus] = useState(null) // 当前生效节奏（/status 回显）
      const [sSpeed, setSSpeed] = useState(null) // 当前读取速度（/status 回显，0.8.0 正交开关）
      const boxRef = useRef(null)
      const [snapOpen, setSnapOpen] = useState(false) // 截图键小箭头的微菜单
      useEffect(() => { if (!open) setView('main') }, [open]) // 面板收起复位视图
      useEffect(() => {
        if (!open && !snapOpen) return
        const away = (e) => {
          if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setSnapOpen(false) }
        }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
      }, [open, snapOpen])

      const askConfirm = (text) => new Promise((resolve) => {
        confirmResolve.current = resolve
        setConfirmText(String(text || '').replaceAll('\\n', '\n'))
      })
      const settleConfirm = (ok) => {
        setConfirmText(null)
        const r = confirmResolve.current; confirmResolve.current = null
        try { r && r(ok) } catch {}
      }

      useEffect(() => {
        let alive = true
        // SSE：后端档位一变就跟着变（含其他窗口/模型侧改动）
        const es = new EventSource(API + '/events')
        es.onmessage = (e) => {
          try { const d = JSON.parse(e.data); if (alive && d && d.mode) setMode(d.mode) } catch {}
        }
        es.onerror = () => {} // EventSource 自带重连
        const probe = () => {
          api('/status').then((s) => { if (alive) setMode(s.mode ?? 'off') }).catch(() => { if (alive) setMode(null) })
        }
        probe()
        // 页签从后台回前台时重探一次（SSE 断线重连间隙兜底）
        const onVis = () => { if (document.visibilityState === 'visible') probe() }
        document.addEventListener('visibilitychange', onVis)
        return () => { alive = false; es.close(); document.removeEventListener('visibilitychange', onVis) }
      }, [])

      if (mode === undefined || mode === null) return null

      const pick = async (id) => {
        if (busy) return
        // 原画成本警告（规格 §四：每次开启弹窗警告确认）
        // R23：不用浏览器原生 confirm 弹窗（宿主页面禁用）——文案由 GET /dialog 下发
        //（token 数集中在服务端 dialog.js 估算，client 永不复算）
        if (id === 'ultra' && modeRef.current !== 'ultra') {
          let ok = false
          try {
            const d = await api('/dialog')
            ok = await askConfirm(d.text || '原画档成本较高，确认开启？')
          } catch { ok = await askConfirm('ultra：满载 ≈26,160 token/分钟（每次观看 ≈872，不看不耗）。确认开启？') }
          if (!ok) return
        }
        const prev = modeRef.current
        setBusy(true); setErr(null); setMode(id) // 乐观更新，失败回滚
        try {
          const s = await api('/mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: id, confirmed: true }),
          })
          setMode(s.mode ?? id)
          setQStatus(s.quality ?? null); setPStatus(s.pace ?? null); setSSpeed(s.speed ?? null)
          if (id === 'custom') setView('custom') // 自定义挡：停留子面板继续调参
        } catch (e) {
          setMode(prev); setErr(e.message)
          setTimeout(() => setErr(null), 4000)
        } finally { setBusy(false) }
      }

      // （旧 openShotEditor 命令式孤儿层已删——React 版 ShotEditor 在模块级）

      const pasteIntoEditor = (b64) => {
        // 微信式同进程直插：本函数就跑在聊天页进程里，构造 File 派发 paste 事件给
        // Lexical 编辑器 —— 宿主 PASTE_COMMAND 读 clipboardData.items→intakeFiles
        // →附件入库，与用户 Ctrl+V 粘贴图片文件完全同链路（不经剪贴板/不模拟按键）。
        try {
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const file = new File([bytes], 'screenshot-' + Date.now() + '.png', { type: 'image/png' })
          const dt = new DataTransfer(); dt.items.add(file)
          const target = document.querySelector('[contenteditable="true"]')
          if (!target) return false
          target.focus()
          target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
          return true
        } catch { return false }
      }
      const deliverPng = async (b64) => {
        // 微信式直插：client 在聊天页进程内合成 paste 事件喂 Lexical（宿主粘贴链原生
        // 接住 File → intakeFiles → 附件入库）；失败兜底=页面剪贴板→下载。
        if (b64 && pasteIntoEditor(b64)) {
          setHint('截图已进聊天框'); setTimeout(() => setHint(null), 2600)
          return
        }
        if (b64) {
          try {
            const bin = atob(b64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
            setHint('截图已复制剪贴板，聊天框 Ctrl+V 粘贴'); setTimeout(() => setHint(null), 5000)
            return
          } catch { return downloadBase64Png(b64) }
        }
        setHint('截图完成，但未收到图像数据'); setTimeout(() => setHint(null), 4000)
      }
      const snap = async (hideWin) => {
        // 截图键 v2（微信式）：服务端只管抓屏（hideWin=true 时先最小化宿主窗再抓）→ png 回传 →
        // setShot 打开 React 编辑层（绝无孤儿层）→ ✓ 合成 paste 直进聊天框 / ✗ 重截 / Esc 关。
        if (busy) return
        setBusy(true); setErr(null); setHint(null)
        try {
          const r = await fetch(API + '/screenshot', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hide: hideWin === true }),
          })
          const j = await r.json()
          if (!r.ok) throw new Error(j?.error || 'HTTP ' + r.status)
          if (!j.png) throw new Error('服务端未返回图像数据')
          setShot({ png: j.png })
        } catch (e) {
          setErr(e.message); setTimeout(() => setErr(null), 4000)
        } finally { setBusy(false) }
      }
      const downloadBase64Png = (b64) => {
        const bin = atob(b64); const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        const a = document.createElement('a')
        a.href = url; a.download = 'vision-snap-' + Date.now() + '.png'; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      }

      // —— 2 键 UI v3（m08444：线条截图图标 + GPT 思考深度式档位菜单 + 自定义清晰度入口）——
      const ITEM_H = 34        // 档位行高（单行，m08497 去短描述）
      const ITEM_H_Q = 46      // 清晰度行高（两行带尺寸）
      const DEFQ = { low: 'low', high: 'standard', max: 'standard', custom: 'standard' } // 档位默认清晰度（runner.js 映射镜像）
      const PACES = [
        { id: 'calm', label: '省静', desc: '门槛 20 · 大动作才算变' },
        { id: 'normal', label: '日常', desc: '门槛 12 · 默认节奏' },
        { id: 'dense', label: '灵敏', desc: '门槛 7 · 每一刀都留' },
      ]
      const SPEEDS = [
        { id: 'default', label: '默认', desc: '延迟 ~0.5 分钟 · 省资源' },
        { id: 'realtime', label: '实时', desc: '延迟 ~1 秒 · 每次观看 ≈388 token，满载 ≈11,640/分钟' },
      ]
      const QUALITIES = [
        { id: 'low', label: '省流', desc: '800×450' },
        { id: 'standard', label: '标准', desc: '1066×600' },
        { id: 'high', label: '高清', desc: '1280×720' },
        { id: 'ultra', label: '满幅', desc: '1600×900' },
      ]
      // 简约线条截图图标：取景框四角 + 中心点（stroke=currentColor 跟随主题）
      const snapIcon = h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M5.5 2.5H4A1.5 1.5 0 0 0 2.5 4v1.5' }),
        h('path', { d: 'M10.5 2.5H12A1.5 1.5 0 0 1 13.5 4v1.5' }),
        h('path', { d: 'M13.5 10.5V12a1.5 1.5 0 0 1-1.5 1.5h-1.5' }),
        h('path', { d: 'M2.5 10.5V12A1.5 1.5 0 0 0 4 13.5h1.5' }),
        h('circle', { cx: 8, cy: 8, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      )
      const curIdx = Math.max(0, MODES.findIndex((m) => m.id === mode))
      const curLabel = MODES[curIdx]?.label ?? String(mode)
      // 自定义=独立挡位（m08539/m08564）：任何档都能切，子面板两组参数（清晰度×节奏）
      const effQ = qStatus ?? DEFQ[mode] ?? null
      const qIdx = Math.max(0, QUALITIES.findIndex((q) => q.id === effQ))
      const thumbIdx = view === 'custom' ? qIdx : curIdx
      const anchorStyle = { ...rowStyle, position: 'relative' }
      const panelStyle = {
        position: 'absolute', bottom: 'calc(100% + 8px)', left: 0,
        minWidth: '224px', padding: '4px',
        background: 'var(--dsh-bg-color, #fff)',
        border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.35))',
        borderRadius: '10px', boxShadow: '0 6px 20px rgba(0,0,0,0.16)',
        zIndex: 999,
      }
      const thumbStyle = {
        position: 'absolute', top: '4px', left: '4px',
        width: 'calc(100% - 8px)', height: (view === 'custom' ? ITEM_H_Q : ITEM_H) + 'px', borderRadius: '8px',
        background: 'var(--dsh-primary-color, #4f7cff)', opacity: 0.14,
        transform: 'translateY(' + thumbIdx * (view === 'custom' ? ITEM_H_Q : ITEM_H) + 'px)',
        transition: 'transform .22s cubic-bezier(.4, 0, .2, 1)',
      }
      const itemStyle = (rowH) => ({
        display: 'block', width: '100%', textAlign: 'left',
        height: rowH + 'px', padding: '0 10px', borderRadius: '8px',
        cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit',
      })
      const rowFlex = (active) => ({
        height: '100%', display: 'flex', alignItems: 'center', gap: '8px',
        color: active ? 'var(--dsh-primary-color, #2563eb)' : 'inherit',
      })
      const nameStyle = (active) => ({ fontSize: '12.5px', fontWeight: active ? 600 : 400, lineHeight: 1.3 })
      const descStyle = { fontSize: '10.5px', opacity: 0.62, lineHeight: 1.3 }
      const check = h('span', { style: { fontSize: '12px', fontWeight: 700 } }, '✓')
      const footBtn = (label, onClick, title) => h('button', {
        style: { display: 'block', width: '100%', textAlign: 'left', fontSize: '11.5px',
          padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', border: 'none',
          background: 'transparent', color: 'inherit', opacity: 0.75,
          borderTop: '1px solid var(--dsh-border-color, rgba(127,127,127,0.25))', marginTop: '4px' },
        onClick, disabled: busy, title,
      }, label)

      const setCustom = async (patch) => { // 自定义挡参数：mode 固定 custom，patch 带 quality/pace/speed（采集重启 ~0.6s）
        if (busy) return
        setBusy(true); setErr(null)
        try {
          const s = await api('/mode', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'custom', ...patch }),
          })
          setQStatus(s.quality ?? null); setPStatus(s.pace ?? null); setSSpeed(s.speed ?? null)
        } catch (e) { setErr(e.message); setTimeout(() => setErr(null), 4000) }
        finally { setBusy(false) }
      }
      const togglePanel = () => {
        const next = !open
        setOpen(next)
        if (next) api('/status').then((s) => { setQStatus(s.quality ?? null); setPStatus(s.pace ?? null); setSSpeed(s.speed ?? null) }).catch(() => {}) // 打开面板拉最新参数
      }

      return h('div', { ref: boxRef, style: anchorStyle },
        h('button', {
          title: '截图（带 DSH 窗口）',
          onClick: () => snap(false), disabled: busy,
          style: { ...btnStyle(false), display: 'inline-flex', alignItems: 'center', padding: '5px 8px' },
        }, snapIcon),
        h('button', {
          title: '截图选项',
          onClick: () => { setSnapOpen(!snapOpen) }, disabled: busy,
          style: { ...btnStyle(false), display: 'inline-flex', alignItems: 'center', padding: '5px 3px', marginLeft: '1px', fontSize: '9px', lineHeight: '1' },
        }, '▾'),
        snapOpen ? h('div', { style: { position: 'absolute', bottom: '100%', left: 0, marginBottom: '6px', minWidth: '150px', padding: '4px', borderRadius: '10px', border: '1px solid var(--dsh-border-color, rgba(127,127,127,0.25))', background: 'var(--dsh-bg-color, #1f1f24)', boxShadow: '0 4px 16px rgba(0,0,0,0.35)', zIndex: 40 } },
          h('button', {
            style: { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', fontSize: '12px', borderRadius: '7px', border: 'none', background: 'transparent', color: 'var(--dsh-text-color, #eee)', cursor: 'pointer' },
            onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsh-hover-bg, rgba(255,255,255,0.08))' },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            onClick: () => { setSnapOpen(false); snap(true) },
          }, '隐藏窗口截图'),
        ) : null,
        h('button', {
          title: '视觉挡位：' + (TITLES[mode] ?? ''),
          onClick: togglePanel, disabled: busy,
          style: { ...btnStyle(false), minWidth: '52px' },
        }, curLabel + (open ? ' ▾' : ' ▴')),
        open ? h('div', { style: panelStyle, role: 'listbox' },
          view === 'main' ? h('div', null,
            h('div', { style: { position: 'relative' } },
              h('div', { style: thumbStyle }),
              MODES.map((m) => h('button', {
                key: m.id,
                title: TITLES[m.id],
                // 延迟 420ms 收面板：滑块动画（.22s）播完再收（m08497「切换没用滑块效果」）；
                // custom 挡例外：面板保持开、pick 成功后切参数子面板（收起会被复位 effect 弹回主菜单）
                onClick: () => { pick(m.id); if (m.id !== 'custom') setTimeout(() => setOpen(false), 420) },
                disabled: busy,
                style: itemStyle(ITEM_H),
              },
                h('div', { style: rowFlex(m.id === mode) },
                  h('div', { style: { ...nameStyle(m.id === mode), flex: 1 } }, m.label),
                  m.id === mode ? check : null,
                ),
              )),
            ),
          ) : h('div', null,
            h('div', { style: { fontSize: '11px', opacity: 0.65, padding: '3px 10px 7px' } },
              '自定义挡参数（改动即生效，采集重启约 0.6 秒）'),
            h('div', { style: { fontSize: '10.5px', opacity: 0.5, padding: '0 10px 3px' } }, '清晰度'),
            h('div', { style: { position: 'relative' } },
              h('div', { style: thumbStyle }),
              QUALITIES.map((q) => h('button', {
                key: q.id,
                title: '切到 ' + q.label + '（' + q.desc + '）',
                onClick: () => setCustom({ quality: q.id }), disabled: busy,
                style: itemStyle(ITEM_H_Q),
              },
                h('div', { style: rowFlex(q.id === effQ) },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: nameStyle(q.id === effQ) }, q.label),
                    h('div', { style: descStyle }, q.desc),
                  ),
                  q.id === effQ ? check : null,
                ),
              )),
            ),
            h('div', { style: { fontSize: '10.5px', opacity: 0.5, padding: '6px 10px 3px' } }, '读取速度（正交开关）'),
            SPEEDS.map((sp) => h('button', {
              key: sp.id,
              title: '切到 ' + sp.label + '（' + sp.desc + '）',
              onClick: () => setCustom({ speed: sp.id }), disabled: busy,
              style: itemStyle(ITEM_H),
            },
              h('div', { style: rowFlex(sp.id === sSpeed) },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: nameStyle(sp.id === sSpeed) }, sp.label),
                  h('div', { style: descStyle }, sp.desc),
                ),
                sp.id === sSpeed ? check : null,
              ),
            )),
            h('div', { style: { fontSize: '10.5px', opacity: 0.5, padding: '6px 10px 3px' } }, '节奏（换画面的门槛）'),
            PACES.map((p) => h('button', {
              key: p.id,
              title: '切到 ' + p.label + '（' + p.desc + '）',
              onClick: () => setCustom({ pace: p.id }), disabled: busy,
              style: itemStyle(ITEM_H),
            },
              h('div', { style: rowFlex(p.id === pStatus) },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: nameStyle(p.id === pStatus) }, p.label),
                  h('div', { style: descStyle }, p.desc),
                ),
                p.id === pStatus ? check : null,
              ),
            )),
            footBtn('← 返回挡位', () => setView('main')),
          ),
        ) : null,
        err ? h('span', { title: err, style: { fontSize: '11px', color: '#e05252', marginLeft: '2px' } }, '⚠') : null,
        hint ? h('span', { title: hint, style: { fontSize: '11px', color: 'var(--dsh-primary-color, #4f7cff)', marginLeft: '2px', cursor: 'default' } }, hint.length > 14 ? '✓' : '✓ ' + hint) : null,
        confirmText ? h('div', { style: overlayStyle },
          h('div', { style: dialogStyle },
            h('div', { style: dialogTextStyle }, confirmText),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { style: dlgBtn(false), onClick: () => settleConfirm(false) }, '取消'),
              h('button', { style: dlgBtn(true), onClick: () => settleConfirm(true) }, '确认开启'),
            ),
          ),
        ) : null,
        shot ? h(ShotEditor, {
          png: shot.png,
          onClose: () => setShot(null),
          onDone: (b64) => { setShot(null); deliverPng(b64) },
        }) : null,
      )
    }

    function apply(ctx) {
      // 槽位缺失 / 宿主形态变化 → 优雅降级为不渲染（R-宽容策略第 3 层）
      ctx.slots.inject('conversation.input.left', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'conversation.input.left',
            id: 'vision-toggle-capsule',
            order: 15,
          }, Capsule)
          return () => { try { unregister() } catch {} }
        } catch { return () => {} }
      })
    }

    module.exports.apply = apply
    module.exports.inject = ['slots'] // 只用 slots，不绑 locale（文案硬编码中文）
    module.exports.name = 'dsh-vision-toggle'
    return module.exports
  },
})

