// _tools/build-mod.mjs — 把 _src/eq.mjs + _src/client.mjs 打包成单文件 ai-eq/client.mjs。
//
// 为什么要单文件：Folium 只给 client 入口的 URL 加 ?v=<内容指纹>，入口里的相对导入
// （'./eq.mjs'）解析出的 URL 不带指纹，会被浏览器的模块表按 URL 缓存。App 不重启、
// 只「重载」模组时，新版 client 可能配到旧版 eq —— 报 "does not provide an export named …"。
// 打包成一个文件后没有任何相对导入，从根上避免这个问题。
//
// 用法：node _tools/build-mod.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const eqPath = path.join(root, '_src', 'eq.mjs');
const clientPath = path.join(root, '_src', 'client.mjs');
const outPath = path.join(root, 'ai-eq', 'client.mjs');

const eqSource = fs.readFileSync(eqPath, 'utf8');
const clientSource = fs.readFileSync(clientPath, 'utf8');

// eq.mjs 的公开名字在打包后变成同一个模块内的普通声明（测试仍直接 import _src/eq.mjs）。
const eqBody = eqSource
    .replace(/^export\s+(const|function|async function|class)/gm, '$1')
    .trim();

const importPattern = /^import\s+\{[\s\S]*?\}\s+from\s+['"]\.\/eq\.mjs['"];\s*/m;
if (!importPattern.test(clientSource)) {
    console.error('build failed: _src/client.mjs 里找不到对 ./eq.mjs 的 import');
    process.exit(1);
}
const clientBody = clientSource.replace(importPattern, '').trim();

if (/^import\s/m.test(eqBody) || /from\s+['"]\.\//.test(eqBody)) {
    console.error('build failed: eq.mjs 里不应有 import');
    process.exit(1);
}
if (/^import\s/m.test(clientBody)) {
    console.error('build failed: client.mjs 里还有其它 import，单文件打包不支持');
    process.exit(1);
}

const banner = `// client.mjs — AI 智能 EQ（Folium 1.7+）
// 单文件构建产物：由 _tools/build-mod.mjs 从 _src/client.mjs + _src/eq.mjs 生成，请勿直接编辑。
// 单文件是为了避开宿主只给入口 URL 加 ?v= 指纹、相对导入被浏览器按 URL 缓存旧模块的问题。

// ======================================================================
// 纯逻辑（源自 _src/eq.mjs）
// ======================================================================
`;

const header = `
// ======================================================================
// 宿主交互（源自 _src/client.mjs）
// ======================================================================
`;

const output = `${banner}${eqBody}\n${header}${clientBody}\n`;
fs.writeFileSync(outPath, output, 'utf8');
console.log(`built ${path.relative(root, outPath)} (${Buffer.byteLength(output, 'utf8')} bytes, ${output.split('\n').length} lines)`);
