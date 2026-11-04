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
 * 槽位：conversation.input.model（模型选择器旁，m06074 实测定稿；right 槽已不存在，
 * 活案例 dsh-liangshen）。五档胶囊 + 截图键（规格 §四 / 决策 5）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-toggle',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef } = React

    const MODES = [
      { id: 'off', label: '关' },
      { id: 'silent', label: '静默' },
      { id: 'dynamic', label: '动态' },
      { id: 'ultra', label: '原画' },
      { id: 'auto', label: '自动' },
    ]
    const TITLES = {
      off: '视觉关：采集停止，peek 报 102',
      silent: '静默：常驻采集不主动唤醒，仅模型 peek 时出图（floor 帧底价）',
      dynamic: '动态：自动升降清晰度 + 节奏适配（按屏幕活动计费）',
      ultra: '原画：满幅单帧，每张约 872 token（最贵一档，逐帧唤醒）',
      auto: '自动：拉取模式 + 静止 5 分钟自动降费、15 分钟建议关闭（决策器纯本地）',
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
      // R23 自定义弹窗：text=正文，resolve 由按钮回调完成（Promise 挂在 ref 上）
      const [confirmText, setConfirmText] = useState(null)
      const confirmResolve = useRef(null)
      const modeRef = useRef(mode)
      modeRef.current = mode

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
        } catch (e) {
          setMode(prev); setErr(e.message)
          setTimeout(() => setErr(null), 4000)
        } finally { setBusy(false) }
      }

      const snap = async () => {
        if (busy) return
        setBusy(true); setErr(null)
        try {
          const r = await fetch(API + '/snapshot', { method: 'POST' })
          if (!r.ok) {
            let msg = 'HTTP ' + r.status
            try { const j = await r.json(); if (j && j.error) msg = j.error } catch {}
            throw new Error(msg)
          }
          // 纯内存：PNG 字节 → blob URL → 新页签预览（P3：不落盘）
          const blob = await r.blob()
          const url = URL.createObjectURL(blob)
          const w = window.open(url, '_blank')
          if (!w) { // 弹窗被拦就转下载
            const a = document.createElement('a')
            a.href = url; a.download = 'vision-snap-' + Date.now() + '.png'; a.click()
          }
          setTimeout(() => URL.revokeObjectURL(url), 60000)
        } catch (e) {
          setErr(e.message); setTimeout(() => setErr(null), 4000)
        } finally { setBusy(false) }
      }

      return h('div', { style: rowStyle },
        MODES.map((m) => h('button', {
          key: m.id,
          title: TITLES[m.id],
          onClick: () => pick(m.id),
          disabled: busy,
          style: btnStyle(m.id === mode),
        }, m.label)),
        h('button', {
          title: '截图：绕过档位临时抓一帧（仅关/静默档可用）',
          onClick: snap, disabled: busy,
          style: btnStyle(false),
        }, '📷'),
        err ? h('span', { title: err, style: { fontSize: '11px', color: '#e05252', marginLeft: '2px' } }, '⚠') : null,
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
      ctx.slots.inject('conversation.input.model', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'conversation.input.model',
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
