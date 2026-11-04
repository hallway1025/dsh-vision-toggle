/**
 * screenshot.js — 截图键 v2：gdigrab 全屏原生分辨率 + 隐藏-恢复宿主窗口 + A 路进聊天框。
 *
 * 与缓冲池完全正交：不走 vision 管线（那里面是缩放过的历史帧），
 * 每次都是 ffmpeg gdigrab 现场抓当前桌面物理像素。
 *
 * Electron 写入（A 路）在宿主 main 进程内完成：
 *   clipboard.writeImage(nativeImage) → webContents.paste()
 * Lexical 输入框的 PASTE_COMMAND 原生接住 clipboardData 里的图片 → 附件入库。
 * electron 不可达时返回 { delivered: 'unavailable' }，调用方降级（写剪贴板由前端兜底）。
 */

import { spawn } from 'node:child_process';

const log = (...a) => console.log('[screenshot]', ...a);

/** spawn 收集式一次调用（截图流程是低频一次性操作，收集完再解析） */
function spawnFile(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    let done = false;
    const finish = (e) => { if (!done) { done = true; e ? reject(e) : resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); } };
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', finish);
    child.on('close', () => finish());
    setTimeout(() => { if (!done) { try { child.kill(); } catch { /* 已退出 */ } finish(new Error('timeout ' + timeout + 'ms')); } }, timeout);
  });
}

// ── 宿主窗口隐藏/恢复（PowerShell + user32 ShowWindow）──
// SW_MINIMIZE=6, SW_RESTORE=9。窗口句柄取进程 MainWindowHandle（DSH 主窗）。
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

async function setHostWindow(pid, cmd) {
  try {
    const r = await spawnFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SHOWWIN_PS, String(pid), String(cmd)], { timeout: 8000 });
    return String(r.stdout || '').includes('OK') ? 'ok' : 'nowindow';
  } catch (e) {
    log('ShowWindow 失败:', e?.message ?? e);
    return 'error';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── gdigrab 全屏单帧（原生分辨率）──
export async function grabFullScreen(ffmpegPath) {
  // 写临时文件比 stdout 稳（Windows 下 ffmpeg 图片管道偶有 -f image2pipe 边界问题）
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');
  const out = path.join(os.tmpdir(), `dsh-shot-\${Date.now()}\${process.pid}.png`);
  try {
    await spawnFile(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '2',
      '-i', 'desktop',
      '-frames:v', '1',
      '-y', out,
    ], { timeout: 15000 });
    const buf = await fsp.readFile(out);
    if (!buf.length || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('输出不是 PNG');
    return buf;
  } finally {
    fsp.unlink(out).catch(() => {});
  }
}

// ── Electron 可达性（A 路前提）：先试内建 import，再退 createRequire ──
export async function getElectron() {
  let electron = null;
  try { electron = await import('electron'); } catch { /* 下一路 */ }
  if (!electron) {
    try {
      const { createRequire } = await import('node:module');
      electron = createRequire(import.meta.url)('electron');
    } catch { return null; }
  }
  const mod = electron?.default ?? electron;
  return (mod && mod.clipboard && mod.nativeImage) ? mod : null;
}

// ── Electron A 路：写剪贴板 + 对聊天窗口模拟粘贴 ──
async function deliverViaElectron(pngBuf, electron) {
  const mod = electron ?? (await getElectron());
  if (!mod) return { delivered: 'unavailable' };
  const { clipboard, nativeImage } = mod;
  const img = nativeImage.createFromBuffer(pngBuf);
  if (img.isEmpty()) return { delivered: 'unavailable' };
  clipboard.writeImage(img);
  try {
    const { BrowserWindow } = mod;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
    if (!win) return { delivered: 'clipboard-only' };
    const wc = win.webContents;
    wc.focus();
    // paste 前再补一次 focus（输入框由页面自身的焦点状态决定）
    wc.paste();
    return { delivered: 'pasted' };
  } catch (e) {
    log('paste 失败（图已在剪贴板）:', e?.message ?? e);
    return { delivered: 'clipboard-only' };
  }
}

/**
 * 一条龙：隐藏宿主窗 → gdigrab 抓屏 → Electron 写剪贴板+粘贴 → 恢复宿主窗。
 * hide=false 时跳过隐藏/恢复（抓到画面里会有 DSH 自己）。
 */
export async function screenshotFlow({ ffmpegPath, hide = true, edit = false, electron = null }) {
  // 编辑流程（0.6.0）：编辑器自己管 隐藏-抓屏-恢复 + ✗ 重截，这里只管结果投递
  if (edit) {
    const { editShotFlow } = await import('./editor.js');
    const r = await editShotFlow({ ffmpegPath, electron });
    if (r.cancelled || !r.png) return { png: null, cancelled: true, hidden: 'skipped' };
    const delivered = await deliverViaElectron(r.png, electron);
    return { png: r.png, delivered, hidden: 'ok' };
  }
  const pid = process.pid; // 插件 server 跑在宿主 main 进程内
  let hidden = 'skipped';
  if (hide) {
    hidden = await setHostWindow(pid, 6);
    if (hidden !== 'ok') log('最小化未确认（继续抓屏）:', hidden);
    await sleep(450); // 等窗口动画+合成器刷完
  }
  let png = null;
  try {
    png = await grabFullScreen(ffmpegPath);
  } finally {
    if (hide && hidden === 'ok') {
      await setHostWindow(pid, 9); // 无条件恢复
    }
  }
  const delivered = await deliverViaElectron(png, electron);
  return { png, delivered, hidden };
}
