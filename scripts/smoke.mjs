#!/usr/bin/env node
/**
 * smoke.mjs — stub harness 冒烟（E1）：defineTool 直通 + 假 ctx。
 * 目的：不依赖宿主，验证插件 apply() 能在标准 ctx 形状上完成注册。
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src/index.js');
process.env.DSH_TOOLS_PATH = join(root, '.tmp/stub-dsh-tools.mjs');

const registered = { tools: [], slots: [], routes: [], effects: [] };
const toolsApi = { register: (t) => { registered.tools.push(t?.name ?? t?.spec?.name ?? '?'); return { dispose() {} } } };
const sessionController = { on: () => ({ dispose() {} }) };
const attachments = { register: () => ({ dispose() {} }) };
const webServer = { register: (r) => { registered.routes.push(r.path + ':' + r.kind); return { dispose() {} } } };
const slotsApi = {
  inject: (name, fn) => { registered.slots.push(name); fn({ slots: slotsApi }); },
  register: () => ({ unregister() {} }),
};
const ctx = {
  tools: toolsApi,   // 宿主真实形状：ctx.tools 直接挂在 ctx 上（index.js:700）
  logger: { info: (m) => {}, error: (m) => console.log('  [err]', m) },
  service: (name) => ({ sessionController, tools: toolsApi, attachments, webServer }[name]),
  inject: (names, fn) => {
    const scoped = Object.fromEntries(names.map((n) => [n, ctx.service(n)]));
    scoped.effect = (fact, label) => { const d = typeof fact === 'function' ? fact() : null; registered.effects.push(String(label ?? '')); return d; };
    fn(scoped);
  },
  slots: slotsApi,
};

const mod = await import(pathToFileURL(src).href);   // Windows ESM：绝对路径必须 file:// URL
if (typeof mod.apply !== 'function') throw new Error('apply 缺失');
await mod.apply(ctx);

console.log('[smoke] tools:', registered.tools.join(','));
console.log('[smoke] routes:', registered.routes.join(','));
if (!registered.tools.includes('vision')) throw new Error('vision 工具未注册');
if (registered.routes.filter((r) => r.startsWith('/api/vision-toggle')).length < 2) throw new Error('路由注册不足');
console.log('[smoke] PASS');
