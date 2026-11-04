/**
 * config.js — 档位持久化（规格 R21 / 工程规范 §二）。
 *
 * 数据目录 ~/.dsh/vision-toggle/（用户目录，防 pnpm 重装丢配置 —— L-239 同型）。
 * 三条冗余（工程规范 §三）：原子写（tmp+rename）/ 写前 .bak 一层 / 401 字段回退。
 * 「进程重启一律回关档」（规格 §四）由 DEFAULT_MODE='off' 兜底；config 只记
 * 「用户上次显式选的档」，供 README/回滚演练对照，不用于自动恢复高档位。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DIR = path.join(os.homedir(), '.dsh', 'vision-toggle');
const FILE = path.join(DIR, 'config.json');

/** 401 字段回退：只认这四个键，多余字段丢弃，类型不对回默认。 */
function sanitize(raw) {
  const out = {};
  const m = raw?.mode;
  // 0.3.0 六档重命名；旧档位静默迁移（silent→low / dynamic→high / auto→high）
  const LEGACY = { silent: 'low', dynamic: 'high', auto: 'high' };
  out.mode = ['off', 'low', 'high', 'max', 'ultra', 'custom'].includes(m)
    ? m
    : (LEGACY[m] ?? 'off');
  const p = raw?.pace;
  out.pace = ['calm', 'normal', 'dense'].includes(p) ? p : 'normal';
  const q = raw?.quality;
  out.quality = ['low', 'standard', 'high', 'ultra'].includes(q) ? q : 'low';
  out.updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0;
  return out;
}

export function loadConfig({ log = () => {} } = {}) {
  for (const f of [FILE, FILE + '.bak']) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cfg = sanitize(raw);
      if (f.endsWith('.bak')) log('config: 主配置损坏，从 .bak 恢复');
      return cfg;
    } catch { /* 下一个 */ }
  }
  return sanitize(null);
}

export function saveConfig(cfg, { log = () => {} } = {}) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const next = sanitize({ ...cfg, updatedAt: Date.now() });
    // 写前 .bak 一层
    try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* 首次没有旧件 */ }
    const tmp = FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE);
    return next;
  } catch (e) {
    log('config 保存失败（不影响运行）：' + (e?.message ?? e));
    return null;
  }
}

export const CONFIG_PATH = FILE;
