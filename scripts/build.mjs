#!/usr/bin/env node
/**
 * build.mjs — esbuild 双入口打包（工程规范 v1.2）
 *   src/index.js  → dist/server.js（宿主半身）
 *   src/client.js → dist/client.js（浏览器半身）
 * package.json 的 exports 在「正门安装」形态下应指向 dist；live-link 开发形态直接跑 src。
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'dist'), { recursive: true });

const common = { bundle: true, format: 'esm', platform: 'node', target: 'node20', minify: false, sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: [join(root, 'src/index.js')], outfile: join(root, 'dist/server.js'), external: ['@deepseek-ai/dsh-tools', 'react'] });
await build({ ...common, entryPoints: [join(root, 'src/client.js')], outfile: join(root, 'dist/client.js'), platform: 'browser', external: ['react'] });
console.log('[vision-toggle] build 完成 → dist/');
