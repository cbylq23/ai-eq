// _tools/validate-with-host.mjs — 用已安装 Folia 的 modSystem/manifest.cjs 真实校验清单。
// 用法：node _tools/validate-with-host.mjs ai-eq <其他模组目录>...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hostManifest = require('../_ref/asar/electron/modSystem/manifest.cjs');

console.log('宿主 Folium 版本：', hostManifest.FOLIUM_VERSION);
console.log('已知权限：', [...hostManifest.KNOWN_PERMISSIONS].join(', '));
console.log('');

let failed = 0;
for (const dir of process.argv.slice(2)) {
    const target = path.resolve(dir);
    const manifestPath = path.join(target, 'mod.json');
    if (!fs.existsSync(manifestPath)) {
        console.log(`✖ ${target}: 没有 mod.json`);
        failed += 1;
        continue;
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = hostManifest.validateManifest(raw);
    if (result.ok) {
        console.log(`✔ ${path.basename(target)}: 清单通过（id=${result.value.id}，version=${result.value.version}）`);
    } else {
        failed += 1;
        console.log(`✖ ${path.basename(target)}: ${result.errors.length} 个错误`);
        for (const error of result.errors) console.log('   - ' + error);
    }
}

process.exitCode = failed ? 1 : 0;
