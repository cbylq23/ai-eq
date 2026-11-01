// _tools/check-mod.mjs — 在不上架、不装 Folia 的前提下，按 Folium 规范做一遍清单与文件自检。
// 用法：node _tools/check-mod.mjs ai-eq
import fs from 'node:fs';
import path from 'node:path';

const KNOWN_PERMISSIONS = new Set([
    'filesystem.data',
    'playback.read',
    'playback.control',
    'playback.queue',
    'equalizer.control',
    'visualizer.renderQuality',
    'visualizer.mode',
    'visualizer.tuning',
    'visualizer.beatEffects',
    'render.export',
    'net.fetch',
    'net.embed',
    'stageLayers',
]);
const KNOWN_EXPERIMENTAL = new Set([
    'omni.providers',
    'omni.hooks',
    'ponder.targets',
    'player.layout',
    'remote.actions',
    'platform.raw',
]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FOLIA_RANGE_RE = /^[<>=^0-9.\s*-]+$/;

const modDir = path.resolve(process.argv[2] || 'ai-eq');
const problems = [];
const notes = [];

function fail(message) {
    problems.push(message);
}

function checkManifest() {
    const manifestPath = path.join(modDir, 'mod.json');
    if (!fs.existsSync(manifestPath)) {
        fail('mod.json 不存在');
        return null;
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        fail('mod.json 不是合法 JSON：' + error.message);
        return null;
    }
    if (manifest.folium !== 1) fail('manifest.folium 必须是 1');
    if (!ID_RE.test(String(manifest.id || ''))) fail('id 必须匹配 ^[a-z0-9][a-z0-9-]*$');
    if (!VERSION_RE.test(String(manifest.version || ''))) fail('version 必须是 MAJOR.MINOR.PATCH');
    if (!manifest.name) fail('缺少 name');
    if (!manifest.client && !manifest.main) fail('client 与 main 至少要有一个');
    for (const key of ['client', 'main', 'preview']) {
        const value = manifest[key];
        if (!value) continue;
        if (path.isAbsolute(value) || value.includes('..')) {
            fail(`${key} 不能是绝对路径或包含 ..`);
            continue;
        }
        const full = path.join(modDir, value);
        if (!fs.existsSync(full)) fail(`${key} 指向的文件不存在：${value}`);
    }
    if (manifest.preview && !/\.(png|jpe?g|webp)$/i.test(manifest.preview)) fail('preview 必须是 png / jpg / webp');
    if (manifest.preview) {
        const full = path.join(modDir, manifest.preview);
        if (fs.existsSync(full)) {
            const size = fs.statSync(full).size;
            if (size > 1024 * 1024) fail('preview 超过 1 MB');
            notes.push(`preview ${manifest.preview}（${Math.round(size / 1024)} KB）`);
        }
    }
    for (const permission of manifest.permissions || []) {
        if (!KNOWN_PERMISSIONS.has(permission) && !permission.startsWith('platform.')) {
            fail(`未知权限：${permission}`);
        }
    }
    for (const name of manifest.experimental || []) {
        if (!KNOWN_EXPERIMENTAL.has(name)) fail(`未知实验接口：${name}`);
    }
    if (manifest.folia && !FOLIA_RANGE_RE.test(String(manifest.folia))) fail('folia 版本范围格式不合法');
    if (!Array.isArray(manifest.permissions)) fail('permissions 必须是数组');
    return manifest;
}

function walk(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) fail(`不能包含符号链接：${path.relative(base, full)}`);
        else if (entry.isDirectory()) walk(full, base, out);
        else out.push(full);
    }
    return out;
}

function checkFiles(manifest) {
    const files = walk(modDir);
    let total = 0;
    for (const file of files) {
        const relative = path.relative(modDir, file).split(path.sep).join('/');
        total += fs.statSync(file).size;
        if (relative.startsWith('.') || relative.split('/').some((part) => part.startsWith('.'))) {
            fail(`不要包含以 . 开头的文件或目录：${relative}`);
        }
        if (relative === 'folium.sig.json') fail('提交仓库里不要包含 folium.sig.json');
        if (relative === 'node_modules' || relative.startsWith('node_modules/')) fail('不要包含 node_modules');
    }
    if (files.length > 300) fail(`文件数超过 300：${files.length}`);
    if (total > 16 * 1024 * 1024) fail('总体积超过 16 MB');
    notes.push(`${files.length} 个文件，共 ${Math.round(total / 1024)} KB`);
    return files;
}

function checkClient(manifest) {
    if (!manifest || !manifest.client) return;
    const source = fs.readFileSync(path.join(modDir, manifest.client), 'utf8');
    if (!/export\s+default\s+/.test(source)) fail('client 入口没有默认导出');
    const importRe = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRe.exec(source))) {
        const spec = match[1];
        if (!spec.startsWith('.')) {
            fail(`client 只能相对导入模组目录内的文件，发现裸模块：${spec}`);
            continue;
        }
        const target = path.resolve(path.dirname(path.join(modDir, manifest.client)), spec);
        if (!fs.existsSync(target)) fail(`client 导入的文件不存在：${spec}`);
    }
    if (/\brequire\s*\(/.test(source)) fail('client 是 ESM，不能使用 require()');
    if (/\bwindow\.location\.href\s*=/.test(source)) fail('client 不应做页面跳转');
}

const manifest = checkManifest();
const files = checkFiles(manifest);
checkClient(manifest);

console.log('模组目录：' + modDir);
console.log('清单：' + JSON.stringify({
    id: manifest && manifest.id,
    version: manifest && manifest.version,
    permissions: manifest && manifest.permissions,
    folia: manifest && manifest.folia,
}));
for (const note of notes) console.log('· ' + note);
for (const file of files) console.log('  - ' + path.relative(modDir, file).split(path.sep).join('/'));
console.log('');
if (problems.length) {
    console.log('✖ 发现 ' + problems.length + ' 个问题：');
    for (const problem of problems) console.log('  - ' + problem);
    process.exitCode = 1;
} else {
    console.log('✔ 清单与文件检查通过');
}
