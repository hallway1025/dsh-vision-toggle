/**
 * screenshot.js — 截图键 v2（服务端只管抓屏）：gdigrab 全屏原生分辨率 + 隐藏-恢复宿主窗口。
 *
 * 与缓冲池完全正交：不走 vision 管线（那里面是缩放过的历史帧），
 * 每次都是 ffmpeg gdigrab 现场抓当前桌面物理像素。
 *
 * 投递（微信式同进程直插）不在这里做：png 返回给端点 → client 在聊天页进程内
 * 合成 paste 事件喂 Lexical（服务端剪贴板/模拟按键两路实测均不可靠，已弃）。
 * 标注编辑器同样在 client 页面内（BrowserWindow 版因插件进程拿不到 electron API 而废）。
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
  \$h = \$p.MainWindowHandle
  # 本进程无窗口时沿父进程链向上找（插件 server=宿主 fork 的无窗口子进程，L-245）
  \$cur = \$p
  for (\$i = 0; \$i -lt 4 -and \$h -eq [IntPtr]::Zero; \$i++) {
    \$par = (Get-CimInstance Win32_Process -Filter "ProcessId=\$(\$cur.Id)" -ErrorAction Stop).ParentProcessId
    if (-not \$par) { break }
    \$cur = Get-Process -Id \$par -ErrorAction Stop
    \$h = \$cur.MainWindowHandle
  }
  if (\$h -ne [IntPtr]::Zero) {
    [void][Native.W]::ShowWindow(\$h, \$Cmd)
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
  // 黑斑修复：gdigrab 抓 Chromium/Electron 的 GPU 合成层会随机出黑块（显存未同步），
  // 首选 ddagrab（Desktop Duplication API，D3D11 表面完美抓取，ffmpeg>=6）；不可用则 gdigrab 连抓 5 帧取最后（GPU 层随时间稳定）。
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');
  const tmp = path.join(os.tmpdir(), 'dsh-shot-' + Date.now() + '-' + process.pid);
  const isPng = (b) => b && b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
  // 黑帧检测：ddagrab 在 GPU 驱动重置/独占全屏等状态下会“成功”输出全黑帧（魔数合法、不报错），
  // isPng 拦不住（主人 11-06 01:47 黑屏实测）。缩成 4x4 灰度求均值：<8 判黑。
  // 误判代价=白跑一次 gdigrab（正常截图平均亮度不可能 <8）。
  const looksBlack = async (file) => {
    try {
      const r = await spawnFile(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', file,
        '-vf', 'scale=4:4', '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
      ], { timeout: 10000 });
      if (!r.stdout.length) return false; // 读不到统计=不判黑（保守）
      let sum = 0;
      for (const b of r.stdout) sum += b;
      return sum / r.stdout.length < 8;
    } catch { return false; }
  };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await spawnFile(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error',
          '-filter_complex', 'ddagrab=draw_mouse=0,hwdownload,format=bgra',
          '-frames:v', '1',
          '-y', tmp + '-dda.png',
        ], { timeout: 15000 });
        const buf = await fsp.readFile(tmp + '-dda.png').catch(() => null);
        if (isPng(buf)) {
          if (await looksBlack(tmp + '-dda.png')) {
            log('ddagrab 黑帧（第 ' + attempt + ' 次）' + (attempt < 2 ? '，重试' : '，回退 gdigrab 多帧'));
            continue;
          }
          return buf;
        }
        log('ddagrab 输出无效');
      } catch (e) {
        log('ddagrab 不可用:', e && e.message);
        break;
      }
    }
    log('回退 gdigrab 多帧');
    await spawnFile(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '30',
      '-i', 'desktop',
      '-frames:v', '5',
      '-y', tmp + '-%d.png',
    ], { timeout: 15000 });
    let last = null;
    for (let n = 1; n <= 9; n++) {
      const b = await fsp.readFile(tmp + '-' + n + '.png').catch(() => null);
      if (!isPng(b)) continue;
      last = b;
      if (!(await looksBlack(tmp + '-' + n + '.png'))) return b; // 第一个非黑帧即用
    }
    if (!last) throw new Error('输出不是 PNG');
    log('gdigrab 全黑帧（桌面可能真的暗）');
    return last;
  } finally {
    fsp.unlink(tmp + '-dda.png').catch(() => {});
    for (let n = 1; n <= 9; n++) fsp.unlink(tmp + '-' + n + '.png').catch(() => {});
  }
}

export async function screenshotFlow({ ffmpegPath, hide = true }) {
  const pid = process.ppid; // 插件 server=宿主 fork 的子进程（L-245）；宿主 main=父进程；PS 端再兜底爬祖先
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
  return { png, hidden };
}
