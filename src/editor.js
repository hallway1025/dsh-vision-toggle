/**
 * editor.js — 微信截图式编辑器（0.6.0）。
 *
 * Electron BrowserWindow（frameless 全屏置顶）+ data: URL 内嵌编辑页（零外部文件）。
 * 流程：主进程抓屏 PNG → IPC 发给编辑页 → 用户框选/箭头/文字/马赛克/撤销/重做
 * → ✓ 收编辑后 PNG（IPC 回主进程）→ 关窗 → 由调用方写剪贴板+粘贴；
 * ✗ = 重新抓屏（同一窗口复用）；Esc / 关窗 = 取消整个流程。
 *
 * 前提：与 A 路同源 —— 宿主 main 进程内 require('electron') 可达。
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';

const log = (...a) => console.log('[shot-editor]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 宿主窗口隐藏/恢复（与 screenshot.js 同款；独立实现避免循环依赖）──
const SHOWWIN_PS = `
  param([int]$ProcId, [int]$Cmd)
  Add-Type -Namespace Native -Name W -MemberDefinition '
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);' | Out-Null
  \$p = Get-Process -Id \$ProcId -ErrorAction Stop
  if (\$p.MainWindowHandle -ne [IntPtr]::Zero) {
    [void][Native.W]::ShowWindow(\$p.MainWindowHandle, \$Cmd)
    'OK'
  } else { 'NOWINDOW' }
`;

function runPs(pid, cmd) {
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHOWWIN_PS, String(pid), String(cmd)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve('error'));
    c.on('close', () => resolve(out.includes('OK') ? 'ok' : 'nowindow'));
    setTimeout(() => { try { c.kill(); } catch { /* 已退 */ } resolve('timeout'); }, 8000);
  });
}

function grab(ffmpegPath) {
  const out = join(tmpdir(), `dsh-shot-edit-\${Date.now()}\${process.pid}.png`);
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '2', '-i', 'desktop', '-frames:v', '1', '-y', out], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', async (code) => {
      if (code !== 0) return reject(new Error('gdigrab exit ' + code + ' ' + err.slice(0, 200)));
      try { resolve(await readFile(out)); } catch (e) { reject(e); } finally { unlink(out).catch(() => {}); }
    });
    setTimeout(() => { try { c.kill(); } catch { /* 已退 */ } reject(new Error('gdigrab timeout')); }, 15000);
  });
}

// ── 编辑页（整页 HTML 内嵌为 data URL）──
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#111;cursor:crosshair;user-select:none}
  #cv{position:absolute;inset:0;width:100vw;height:100vh}
  #bar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:4px;
       background:rgba(28,28,32,.92);border-radius:12px;padding:6px;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  .b{width:40px;height:36px;border:0;border-radius:8px;background:transparent;color:#eee;font-size:17px;
     cursor:pointer;line-height:36px;text-align:center;font-family:inherit}
  .b:hover{background:rgba(255,255,255,.12)}
  .b.on{background:#4f7cff;color:#fff}
  .sep{width:1px;background:rgba(255,255,255,.18);margin:4px 3px}
  #ok{background:#34c759;color:#fff}.b#ok:hover{background:#2db14e}
  #no{color:#ff6b6b}
  #txt{position:absolute;display:none;background:transparent;color:#ff3b30;border:1.5px dashed rgba(255,59,48,.7);
       font-size:22px;outline:none;min-width:80px;padding:2px 4px}
</style></head><body>
<canvas id="cv"></canvas>
<div id="bar">
  <button class="b on" id="t-rect" title="矩形框选">□</button>
  <button class="b" id="t-arr" title="箭头">↗</button>
  <button class="b" id="t-text" title="文字">T</button>
  <button class="b" id="t-mos" title="马赛克">▒</button>
  <div class="sep"></div>
  <button class="b" id="c-red"  title="红笔" style="color:#ff3b30;font-size:20px">●</button>
  <button class="b" id="c-blue" title="蓝笔" style="color:#3b82f6;font-size:20px">●</button>
  <button class="b" id="c-yel"  title="黄笔" style="color:#f5c518;font-size:20px">●</button>
  <div class="sep"></div>
  <button class="b" id="undo" title="撤销 (Ctrl+Z)">↶</button>
  <button class="b" id="redo" title="重做 (Ctrl+Y)">↷</button>
  <div class="sep"></div>
  <button class="b" id="ok"  title="确认，贴进聊天框">✓</button>
  <button class="b" id="no"  title="重新截图 (Esc 取消)">✗</button>
</div>
<input id="txt">
<script>
'use strict'
const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
let base = null, ops = [], redo = []
let tool = 'rect', color = '#ff3b30', lw = 3, drawing = null
const scaleX = () => base ? (cv.width / window.innerWidth) : 1
const scaleY = () => base ? (cv.height / window.innerHeight) : 1

function drawOp(g, op) {
  if (op.t === 'rect') { g.strokeStyle = op.c; g.lineWidth = op.w; g.strokeRect(op.x, op.y, op.w2, op.h2) }
  else if (op.t === 'arr') {
    g.strokeStyle = op.c; g.fillStyle = op.c; g.lineWidth = op.w
    const a = Math.atan2(op.y2 - op.y, op.x2 - op.x), L = 10 + op.w * 2.2
    g.beginPath(); g.moveTo(op.x, op.y); g.lineTo(op.x2, op.y2); g.stroke()
    g.beginPath()
    g.moveTo(op.x2, op.y2)
    g.lineTo(op.x2 - L * Math.cos(a - 0.42), op.y2 - L * Math.sin(a - 0.42))
    g.lineTo(op.x2 - L * Math.cos(a + 0.42), op.y2 - L * Math.sin(a + 0.42))
    g.closePath(); g.fill()
  } else if (op.t === 'text') {
    g.fillStyle = op.c; g.font = op.w * 7 + 'px sans-serif'; g.textBaseline = 'top'
    g.fillText(op.s, op.x, op.y)
  } else if (op.t === 'mos') {
    const B = 14
    const x0 = Math.min(op.x, op.x2), y0 = Math.min(op.y, op.y2)
    const w = Math.abs(op.x2 - op.x), h = Math.abs(op.y2 - op.y)
    if (w < 2 || h < 2) return
    const t = document.createElement('canvas'); t.width = w; t.height = h
    const tg = t.getContext('2d')
    tg.drawImage(base, x0, y0, w, h, 0, 0, w, h)   // 永远从原图取样
    const d = tg.getImageData(0, 0, w, h)
    for (let by = 0; by < h; by += B) for (let bx = 0; bx < w; bx += B) {
      let r = 0, gg = 0, b = 0, n = 0
      for (let y = by; y < Math.min(by + B, h); y++) for (let x = bx; x < Math.min(bx + B, w); x++) {
        const i = (y * w + x) * 4; r += d.data[i]; gg += d.data[i + 1]; b += d.data[i + 2]; n++
      }
      r = (r / n) | 0; gg = (gg / n) | 0; b = (b / n) | 0
      for (let y = by; y < Math.min(by + B, h); y++) for (let x = bx; x < Math.min(bx + B, w); x++) {
        const i = (y * w + x) * 4; d.data[i] = r; d.data[i + 1] = gg; d.data[i + 2] = b
      }
    }
    tg.putImageData(d, 0, 0)
    g.drawImage(t, x0, y0)
  }
}
function render(extra) {
  ctx.clearRect(0, 0, cv.width, cv.height)
  if (base) ctx.drawImage(base, 0, 0)
  for (const op of ops) drawOp(ctx, op)
  if (extra) drawOp(ctx, extra)
}
function loadBase(buf) {
  const img = new Image()
  img.onload = () => { cv.width = img.naturalWidth; cv.height = img.naturalHeight; base = img; ops = []; redo = []; render() }
  img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
}

const pos = (e) => ({ x: e.clientX * scaleX(), y: e.clientY * scaleY() })
cv.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !base) return
  const p = pos(e)
  if (tool === 'text') return placeText(e.clientX, e.clientY, p)
  drawing = { t: tool, c: color, w: lw, x: p.x, y: p.y, x2: p.x, y2: p.y }
})
window.addEventListener('mousemove', (e) => {
  if (!drawing) return
  const p = pos(e); drawing.x2 = p.x; drawing.y2 = p.y; render(drawing)
})
window.addEventListener('mouseup', () => {
  if (!drawing) return
  const d = drawing; drawing = null
  const tiny = Math.abs(d.x2 - d.x) < 3 && Math.abs(d.y2 - d.y) < 3 && d.t !== 'mos'
  if (!tiny) { ops.push(d); redo = [] }   // 点错成小点不算一笔
  render()
})
function placeText(cx, cy, pImg) {
  // 输入框定位用 CSS 像素（clientX/Y），落笔坐标用图坐标（pImg）
  const box = document.getElementById('txt')
  box.style.display = 'block'; box.style.left = cx + 'px'; box.style.top = cy + 'px'
  box.style.color = color; box.value = ''
  box.dataset.px = pImg.x; box.dataset.py = pImg.y
  setTimeout(() => box.focus(), 0)
}
document.getElementById('txt').addEventListener('keydown', (e) => {
  const box = e.target
  if (e.key === 'Enter' && box.value.trim()) {
    ops.push({ t: 'text', c: color, w: lw, x: +box.dataset.px, y: +box.dataset.py, s: box.value })
    redo = []; box.style.display = 'none'; render()
  } else if (e.key === 'Escape') { box.style.display = 'none' }
  e.stopPropagation()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.shotBridge.cancel(); return }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redoOp() }
})
function undo() { const op = ops.pop(); if (op) { redo.push(op); render() } }
function redoOp() { const op = redo.pop(); if (op) { ops.push(op); render() } }
function sel(id) {
  tool = { 't-rect': 'rect', 't-arr': 'arr', 't-text': 'text', 't-mos': 'mos' }[id]
  for (const k of ['rect', 'arr', 'text', 'mos']) document.getElementById('t-' + k).classList.toggle('on', k === id.slice(2))
}
for (const id of ['t-rect', 't-arr', 't-text', 't-mos']) document.getElementById(id).onclick = () => sel(id)
const csel = (id, c) => { color = c; for (const k of ['red', 'blue', 'yel']) document.getElementById('c-' + k).classList.toggle('on', k === id) }
document.getElementById('c-red').onclick = () => csel('red', '#ff3b30')
document.getElementById('c-blue').onclick = () => csel('blue', '#3b82f6')
document.getElementById('c-yel').onclick = () => csel('yel', '#f5c518')
document.getElementById('undo').onclick = undo
document.getElementById('redo').onclick = redoOp
document.getElementById('ok').onclick = () => {
  render()  // 落定进行中的预览
  cv.toBlob((b) => { b.arrayBuffer().then((ab) => window.shotBridge.done(ab)) }, 'image/png')
}
document.getElementById('no').onclick = () => window.shotBridge.resnap()
window.shotBridge.onData(loadBase)
render()
</script></body></html>`;

const PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('shotBridge', {
  onData: (cb) => ipcRenderer.on('vision-shot-data', (e, buf) => cb(buf)),
  done: (ab) => ipcRenderer.send('vision-shot-done', Buffer.from(ab)),
  resnap: () => ipcRenderer.send('vision-shot-resnap'),
  cancel: () => ipcRenderer.send('vision-shot-cancel'),
})
`;

function dataUrl(html) {
  return 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64');
}

/**
 * 打开编辑器并等到结果。
 * 返回 { png: Buffer, hidden: 'ok'|'nowindow'|... } —— png=null 表示用户取消。
 * 内部处理 ✗ 重截循环；窗口关闭=取消。IPC 监听器在 finally 里摘除。
 */
export async function editShotFlow({ ffmpegPath, electron }) {
  const { BrowserWindow, ipcMain } = electron;
  const pid = process.pid;
  let win = null;
  let settle = null;
  const result = { png: null, cancelled: false };
  const onDone = (e, buf) => { result.png = Buffer.from(buf); cleanup(); };
  const onResnap = async () => {
    // ✗：重新抓屏。编辑器自己还全屏置顶 —— 不先 hide 就会抓到自己（死循环截图）。
    try {
      if (win && !win.isDestroyed()) win.hide();
      await sleep(150);                       // 等合成器把编辑器从画面里摘掉
      await runPs(pid, 6); await sleep(450);  // 最小化 DSH → 干净桌面
      const png = await grab(ffmpegPath);
      await runPs(pid, 9);                    // 恢复 DSH
      if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('vision-shot-data', png); }
    } catch (err) {
      log('重截失败:', err?.message ?? err);
      if (win && !win.isDestroyed()) { try { win.show(); win.focus(); } catch { /* 已关 */ } }
    }
  };
  const onCancel = () => { result.cancelled = true; cleanup(); };
  const cleanup = () => {
    ipcMain.removeListener('vision-shot-done', onDone);
    ipcMain.removeListener('vision-shot-resnap', onResnap);
    ipcMain.removeListener('vision-shot-cancel', onCancel);
    if (settle) { const s = settle; settle = null; s(); }
  };
  ipcMain.on('vision-shot-done', onDone);
  ipcMain.on('vision-shot-resnap', onResnap);
  ipcMain.on('vision-shot-cancel', onCancel);
  try {
    await runPs(pid, 6); await sleep(450);
    const png0 = await grab(ffmpegPath);
    await runPs(pid, 9); // 先恢复 DSH，编辑器全屏盖在其上
    win = new BrowserWindow({
      fullscreen: true, frame: false, alwaysOnTop: true,
      backgroundColor: '#111111', title: 'vision-shot-editor',
      webPreferences: { preload: dataUrlPreload(), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    win.on('closed', () => { if (settle) { result.cancelled = true; cleanup(); } });
    await win.loadURL(dataUrl(PAGE));
    win.webContents.send('vision-shot-data', png0);
    await new Promise((r) => { settle = r; });
  } finally {
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* 已关 */ } }
    if (ipcMain.listenerCount('vision-shot-done')) ipcMain.removeAllListeners('vision-shot-done');
  }
  return result;
}

// preload 不能用 data: URL —— 写临时文件再引用（Electron 要求 preload 是文件路径）
let preloadPath = null;
async function dataUrlPreload() {
  if (!preloadPath) {
    preloadPath = join(tmpdir(), 'dsh-vision-shot-preload-' + process.pid + '.js');
    await writeFile(preloadPath, PRELOAD, 'utf8');
  }
  return preloadPath;
}
