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

    function Capsule() {
      // undefined=还没探到后端（渲染 null）；null=探过但后端不在（也渲染 null）
      const [mode, setMode] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [hint, setHint] = useState(null) // 截图键轻提示（非错误）
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
      const boxRef = useRef(null)
      useEffect(() => { if (!open) setView('main') }, [open]) // 面板收起复位视图
      useEffect(() => {
        if (!open) return
        const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
      }, [open])

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
          } catch { ok = await askConfirm('原画档：满幅单帧（最贵一档）。确认开启？') }
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
          setQStatus(s.quality ?? null); setPStatus(s.pace ?? null)
          if (id === 'custom') setView('custom') // 自定义挡：停留子面板继续调参
        } catch (e) {
          setMode(prev); setErr(e.message)
          setTimeout(() => setErr(null), 4000)
        } finally { setBusy(false) }
      }

      // ── 页面内截图编辑层（微信式标注：框选/箭头/文字/马赛克/撤销重做/✓/✗重截）──
      // 原 0.6.0 BrowserWindow 版因插件进程拿不到 electron API（/diag 实锤）架构性不可用，
      // 整体移植为 client 页面内全屏覆盖层 —— 本文件就跑在聊天页里，天然同进程。
      const openShotEditor = (b64, { onDone, onResnap }) => {
        const wrap = document.createElement('div')
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#111;overflow:hidden;user-select:none'
        const css = document.createElement('style')
        css.textContent = '.vs-btn{width:36px;height:36px;margin:0 2px;border:none;border-radius:8px;background:rgba(255,255,255,.12);color:#fff;font-size:17px;cursor:pointer;line-height:36px;text-align:center;font-family:inherit}.vs-btn:hover{background:rgba(255,255,255,.24)}.vs-btn.on{background:var(--dsh-primary-color,#4f7cff)}.vs-btn.done{background:#2ea44f}.vs-btn.resnap{background:#d29922}'
        wrap.appendChild(css)
        const bar = document.createElement('div')
        bar.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:2;display:flex;background:rgba(20,20,20,.92);border-radius:12px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,.5)'
        const mk = (id, label, title, cls) => { const b = document.createElement('button'); b.id = id; b.className = 'vs-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.title = title; bar.appendChild(b); return b }
        mk('t-rect', '□', '矩形框选'); mk('t-arr', '↗', '箭头'); mk('t-text', 'T', '文字'); mk('t-mos', '▒', '马赛克')
        mk('c-red', '●', '红色', 'on').style.color = '#ff3b30'
        mk('c-blue', '●', '蓝色').style.color = '#3b82f6'
        mk('c-yel', '●', '黄色').style.color = '#f5c518'
        const uBtn = mk('undo', '↶', '撤销 (Ctrl+Z)'); const rBtn = mk('redo', '↷', '重做 (Ctrl+Y)')
        bar.appendChild(document.createElement('span')).style.cssText = 'width:10px'
        mk('resnap', '✗', '重截（重新抓屏）', 'resnap')
        const okB = mk('done', '✓', '完成，贴进聊天框', 'done')
        wrap.appendChild(bar)
        const cv = document.createElement('canvas')
        cv.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;cursor:crosshair'
        wrap.appendChild(cv)
        const ctx = cv.getContext('2d')
        const txt = document.createElement('input')
        txt.style.cssText = 'position:absolute;display:none;z-index:3;font-size:18px;padding:4px 8px;border:2px solid var(--dsh-primary-color,#4f7cff);border-radius:6px;background:rgba(255,255,255,.95);color:#111'
        wrap.appendChild(txt)
        document.body.appendChild(wrap)

        let base = null, ops = [], redo = []
        let tool = 'rect', color = '#ff3b30', lw = 3, drawing = null
        const scaleX = () => base ? (cv.width / window.innerWidth) : 1
        const scaleY = () => base ? (cv.height / window.innerHeight) : 1

        function drawOp(g, op) {
          g.strokeStyle = op.c; g.fillStyle = op.c; g.lineWidth = op.w; g.lineCap = 'round'; g.lineJoin = 'round'
          if (op.t === 'rect') { const x = Math.min(op.x, op.x2), y = Math.min(op.y, op.y2); g.strokeRect(x, y, Math.abs(op.x2 - op.x), Math.abs(op.y2 - op.y)) }
          else if (op.t === 'arr') {
            const a = Math.atan2(op.y2 - op.y, op.x2 - op.x), h = Math.max(10, op.w * 4)
            g.beginPath(); g.moveTo(op.x, op.y); g.lineTo(op.x2, op.y2)
            g.lineTo(op.x2 - h * Math.cos(a - 0.45), op.y2 - h * Math.sin(a - 0.45))
            g.moveTo(op.x2, op.y2); g.lineTo(op.x2 - h * Math.cos(a + 0.45), op.y2 - h * Math.sin(a + 0.45))
            g.stroke()
          } else if (op.t === 'text') { g.font = (op.w * 6 + 12) + 'px system-ui,sans-serif'; g.fillText(op.s, op.x, op.y) }
          else if (op.t === 'mos') {
            const x0 = Math.max(0, Math.min(op.x, op.x2)), y0 = Math.max(0, Math.min(op.y, op.y2))
            const w = Math.min(cv.width - x0, Math.abs(op.x2 - op.x)), h = Math.min(cv.height - y0, Math.abs(op.y2 - op.y))
            if (w < 1 || h < 1) return
            const t = document.createElement('canvas'); const s = 14
            t.width = Math.ceil(w / s); t.height = Math.ceil(h / s)
            const tg = t.getContext('2d')
            tg.drawImage(base, x0, y0, w, h, 0, 0, t.width, t.height)   // 永远从原图取样
            g.imageSmoothingEnabled = false
            g.drawImage(t, x0, y0, w, h)
            g.imageSmoothingEnabled = true
          }
        }
        function render(extra) {
          ctx.clearRect(0, 0, cv.width, cv.height)
          if (base) ctx.drawImage(base, 0, 0)
          for (const op of ops) drawOp(ctx, op)
          if (extra) drawOp(ctx, extra)
        }
        const img = new Image()
        img.onload = () => { cv.width = img.naturalWidth; cv.height = img.naturalHeight; base = img; render() }
        img.src = 'data:image/png;base64,' + b64

        const pos = (e) => ({ x: e.clientX * scaleX(), y: e.clientY * scaleY() })
        cv.addEventListener('mousedown', (e) => {
          e.preventDefault()
          const p = pos(e)
          if (tool === 'text') return placeText(e.clientX, e.clientY, p)
          drawing = { t: tool, c: color, w: lw, x: p.x, y: p.y, x2: p.x, y2: p.y }
        })
        window.addEventListener('mousemove', mv)
        function mv(e) { if (!drawing) return; const p = pos(e); drawing.x2 = p.x; drawing.y2 = p.y; render(drawing) }
        window.addEventListener('mouseup', up)
        function up() {
          if (!drawing) return
          const d = drawing; drawing = null
          const tiny = Math.abs(d.x2 - d.x) < 3 && Math.abs(d.y2 - d.y) < 3 && d.t !== 'mos'
          if (!tiny) { ops.push(d); redo = []; render() } else render()
        }
        function placeText(cx, cy, pImg) {
          txt.style.display = 'block'; txt.style.left = cx + 'px'; txt.style.top = cy + 'px'
          txt.dataset.px = pImg.x; txt.dataset.py = pImg.y; txt.value = ''
          setTimeout(() => txt.focus(), 0)
        }
        txt.addEventListener('keydown', (e) => {
          e.stopPropagation()
          const box = e.target
          if (e.key === 'Enter' && box.value.trim()) {
            ops.push({ t: 'text', c: color, w: lw, x: +box.dataset.px, y: +box.dataset.py, s: box.value })
            redo = []; box.style.display = 'none'; render()
          } else if (e.key === 'Escape') { box.style.display = 'none' }
        })
        function key(e) {
          if (e.key === 'Escape') { e.stopPropagation(); return destroy() }
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
          else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redoOp() }
        }
        window.addEventListener('keydown', key, true)   // capture：编辑层优先吃键
        function undo() { const op = ops.pop(); if (op) { redo.push(op); render() } }
        function redoOp() { const op = redo.pop(); if (op) { ops.push(op); render() } }
        const TOOLMAP = { 't-rect': 'rect', 't-arr': 'arr', 't-text': 'text', 't-mos': 'mos' }
        bar.addEventListener('click', (e) => {
          const id = e.target?.id; if (!id) return
          if (TOOLMAP[id]) { tool = TOOLMAP[id]; for (const k of ['t-rect', 't-arr', 't-text', 't-mos']) document.getElementById(k).classList.toggle('on', k === id) }
          else if (id === 'c-red' || id === 'c-blue' || id === 'c-yel') {
            color = { 'c-red': '#ff3b30', 'c-blue': '#3b82f6', 'c-yel': '#f5c518' }[id]
            for (const k of ['c-red', 'c-blue', 'c-yel']) document.getElementById(k).classList.toggle('on', k === id)
          }
          else if (id === 'undo') undo()
          else if (id === 'redo') redoOp()
          else if (id === 'resnap') { destroy(); onResnap && onResnap() }
          else if (id === 'done') {
            try {
              cv.toBlob((blob) => {
                const fr = new FileReader()
                fr.onload = () => { destroy(); onDone && onDone(String(fr.result).split(',')[1] || '') }
                fr.readAsDataURL(blob)
              }, 'image/png')
            } catch { destroy() }
          }
        })
        function destroy() {
          window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up)
          window.removeEventListener('keydown', key, true)
          wrap.remove()
        }
      }

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
      const snap = async () => {
        // 截图键 v2（微信式）：服务端只管抓屏（隐藏-恢复宿主窗）→ png 回传 →
        // 页面内编辑层标注 → ✓ 合成 paste 直进聊天框 / ✗ 重截 / Esc 取消。
        if (busy) return
        setBusy(true); setErr(null); setHint(null)
        try {
          const r = await fetch(API + '/screenshot', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const j = await r.json()
          if (!r.ok) throw new Error(j?.error || 'HTTP ' + r.status)
          openShotEditor(j.png, {
            onDone: (b64) => { deliverPng(b64) },
            onResnap: () => { snap() },
          })
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

      const setCustom = async (patch) => { // 自定义挡参数：mode 固定 custom，patch 带 quality/pace（采集重启 ~0.6s）
        if (busy) return
        setBusy(true); setErr(null)
        try {
          const s = await api('/mode', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'custom', ...patch }),
          })
          setQStatus(s.quality ?? null); setPStatus(s.pace ?? null)
        } catch (e) { setErr(e.message); setTimeout(() => setErr(null), 4000) }
        finally { setBusy(false) }
      }
      const togglePanel = () => {
        const next = !open
        setOpen(next)
        if (next) api('/status').then((s) => { setQStatus(s.quality ?? null); setPStatus(s.pace ?? null) }).catch(() => {}) // 打开面板拉最新参数
      }

      return h('div', { ref: boxRef, style: anchorStyle },
        h('button', {
          title: '截图：抓一帧另开预览（全挡可用，不打断采集）',
          onClick: snap, disabled: busy,
          style: { ...btnStyle(false), display: 'inline-flex', alignItems: 'center', padding: '5px 8px' },
        }, snapIcon),
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
                // 延迟 420ms 收面板：滑块动画（.22s）播完再收（m08497「切换没用滑块效果」）
                onClick: () => { pick(m.id); setTimeout(() => setOpen(false), 420) },
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

