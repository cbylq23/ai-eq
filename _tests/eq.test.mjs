// _tests/eq.test.mjs — eq.mjs 纯逻辑单元测试（node --test _tests/）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PRESETS,
    resolveProvider,
    validateEndpoint,
    frequencyText,
    bandLabel,
    bandTable,
    maxAbsFor,
    buildMessages,
    buildCompactMessages,
    maxOutputTokens,
    OUTPUT_TOKENS_MAX,
    COMPACT_LYRICS_CHAR_LIMIT,
    genreFamilyOf,
    genreChangeNeedsRegenerate,
    extractMessageContent,
    extractUsage,
    parseCurvePayload,
    normalizeCurve,
    formatDb,
    settingsFingerprint,
    cacheKeyFor,
    songIdentity,
    songTitle,
    LYRICS_CHAR_LIMIT,
    buildSearchQuery,
    extractDdgResults,
    normalizeSearchResults,
    webSourceLines,
} from '../_src/eq.mjs';

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency, index, all) => ({
    frequency,
    shape: index === 0 ? 'lowshelf' : index === all.length - 1 ? 'highshelf' : 'peaking',
}));

test('resolveProvider：预设默认值与手填覆盖', () => {
    assert.deepEqual(
        (({ base, model }) => ({ base, model }))(resolveProvider({ provider: 'deepseek' })),
        { base: 'https://api.deepseek.com', model: 'deepseek-chat' },
    );
    assert.equal(resolveProvider({ provider: 'deepseek', model: 'deepseek-reasoner' }).model, 'deepseek-reasoner');
    assert.equal(resolveProvider({ provider: 'custom' }).base, '');
    assert.equal(resolveProvider({ provider: 'ollama' }).base, 'http://localhost:11434/v1');
    assert.ok(PRESETS.custom);
});

test('validateEndpoint：HTTPS / 本机 HTTP / 补全路径 / 拒绝明文 HTTP', () => {
    assert.equal(validateEndpoint('https://api.deepseek.com').url, 'https://api.deepseek.com/chat/completions');
    assert.equal(validateEndpoint('https://api.deepseek.com/').url, 'https://api.deepseek.com/chat/completions');
    assert.equal(validateEndpoint('https://api.example.com/v1').url, 'https://api.example.com/v1/chat/completions');
    assert.equal(validateEndpoint('https://api.example.com/v1/chat/completions').url, 'https://api.example.com/v1/chat/completions');
    assert.equal(validateEndpoint('http://localhost:11434/v1').isLocal, true);
    assert.equal(validateEndpoint('http://127.0.0.1:11434/v1').isLocal, true);
    assert.match(validateEndpoint('http://example.com/v1').error, /HTTPS/);
    assert.match(validateEndpoint('not a url').error, /URL/);
    assert.match(validateEndpoint('').error, /未配置/);
    assert.match(validateEndpoint('https://user:pass@example.com/v1').error, /用户名|密码/);
});

test('频率与听感文案', () => {
    assert.equal(frequencyText(31), '31');
    assert.equal(frequencyText(1000), '1k');
    assert.equal(frequencyText(16000), '16k');
    assert.equal(frequencyText(1500), '1.5k');
    assert.match(bandLabel(60, 'peaking'), /低频/);
    assert.match(bandLabel(1000, 'peaking'), /人声/);
    assert.match(bandLabel(8000, 'peaking'), /齿音|亮度/);
    assert.match(bandLabel(30, 'lowshelf'), /低频/);
    assert.match(bandLabel(16000, 'highshelf'), /空气/);
    assert.equal(bandTable(BANDS).split('\n').length, 10);
});

test('maxAbsFor：强度档位', () => {
    assert.equal(maxAbsFor('gentle'), 3);
    assert.equal(maxAbsFor('standard'), 6);
    assert.equal(maxAbsFor('bold'), 9);
    assert.equal(maxAbsFor('unknown'), 6);
});

test('buildMessages：简报要求、频段表、强度、整首歌词截断', () => {
    const lyrics = Array.from({ length: 200 }, (_, index) => `第${index + 1}句歌词${'很长的歌词内容'.repeat(4)}`).join('\n');
    assert.ok(lyrics.length > LYRICS_CHAR_LIMIT);
    const { system, user } = buildMessages({
        song: { title: '测试歌', artist: '测试歌手', album: '测试专辑' },
        bands: BANDS,
        strength: 'gentle',
        taste: '耳机偏低频',
        lyrics,
    });
    assert.match(system, /正好 10 个数字/);
    assert.match(system, /-3 到 \+3/);
    assert.match(system, /31Hz/);
    assert.match(system, /16kHz/);
    assert.match(system, /禁止输出代码/);
    assert.match(system, /summary/);
    assert.match(system, /emotion/);
    assert.match(system, /imagery/);
    assert.match(system, /energy/);
    assert.match(user, /测试歌/);
    assert.match(user, /测试歌手/);
    assert.match(user, /测试专辑/);
    assert.match(user, /耳机偏低频/);
    assert.ok(user.includes('第1句歌词'), '歌词应整首发送');
    assert.ok(!user.includes('第200句歌词'), '超出上限的歌词应被截断');
    assert.ok(user.length < LYRICS_CHAR_LIMIT + 2000, '提示词不应无限增长');
});

test('buildMessages：没有歌词时用元数据兜底', () => {
    const { user } = buildMessages({ song: { title: 'a', artist: 'b' }, bands: BANDS, strength: 'standard', lyrics: '' });
    assert.match(user, /没有拿到歌词/);
});

test('buildMessages：历史口味（喜欢的标签 / 常切音效 / 相似歌曲反馈）会进提示词', () => {
    const profile = {
        up: [{ tag: '女声', count: 2 }, { tag: 'City Pop', count: 1 }],
        down: [{ tag: '重低音', count: 1 }],
        modes: [{ key: 'preset:bass', count: 3, label: '低音增强' }],
        similar: [{ title: '旧歌', value: 1, tags: ['City Pop', '80s'] }],
    };
    const { user } = buildMessages({
        song: { title: '新歌', artist: '某人' },
        bands: BANDS,
        strength: 'standard',
        profile,
    });
    assert.match(user, /喜欢的标签/);
    assert.match(user, /女声×2/);
    assert.match(user, /不喜欢的标签/);
    assert.match(user, /重低音×1/);
    assert.match(user, /低音增强×3/);
    assert.match(user, /旧歌/);
    assert.match(user, /👍/);
});

test('buildMessages：已知曲风会作为「请沿用」发出去', () => {
    const { user } = buildMessages({
        song: { title: 'a', artist: 'b' },
        bands: BANDS,
        strength: 'standard',
        genre: 'City Pop',
    });
    assert.match(user, /曲风（请沿用，不要改写）：City Pop/);
    /* 归族后要告诉模型按哪类策略定基调 */
    assert.match(user, /City Pop \/ 合成器流行/);
});

test('genreFamilyOf：常见曲风归类', () => {
    assert.equal(genreFamilyOf('City Pop').id, 'citypop');
    assert.equal(genreFamilyOf('citypop').id, 'citypop');
    assert.equal(genreFamilyOf('华语流行').id, 'pop');
    assert.equal(genreFamilyOf('R&B').id, 'soul');
    assert.equal(genreFamilyOf('节奏布鲁斯').id, 'soul');
    assert.equal(genreFamilyOf('Trap').id, 'hiphop');
    assert.equal(genreFamilyOf('说唱').id, 'hiphop');
    assert.equal(genreFamilyOf('后摇').id, 'cinematic');
    assert.equal(genreFamilyOf('Bossa Nova').id, 'jazz');
    assert.equal(genreFamilyOf('Lo-fi').id, 'lofi');
    assert.equal(genreFamilyOf('抒情').id, 'ballad');
    assert.equal(genreFamilyOf('K-Pop').id, 'pop');
    assert.equal(genreFamilyOf('完全说不出的东西'), null);
    assert.equal(genreFamilyOf(''), null);
});

test('genreChangeNeedsRegenerate：换类别才需要重生成', () => {
    assert.equal(genreChangeNeedsRegenerate('City Pop', 'Citypop'), false);
    assert.equal(genreChangeNeedsRegenerate('City Pop', 'Trap'), true);
    assert.equal(genreChangeNeedsRegenerate('', 'Trap'), true);
    assert.equal(genreChangeNeedsRegenerate('Trap', ''), true);
});

test('buildMessages：曲风驱动规则（不是套模板）', () => {
    const { system } = buildMessages({
        song: { title: 'a', artist: 'b' },
        bands: BANDS,
        strength: 'standard',
    });
    assert.match(system, /曲风（genre）是决定 EQ 的核心依据/);
    assert.match(system, /曲风的权重高于历史口味/);
    assert.match(system, /City Pop/);
    assert.match(system, /嘻哈 \/ 说唱/);
    assert.match(system, /电子 \/ 舞曲/);
    assert.match(system, /爵士 \/ 原声/);
    assert.match(system, /如果曲风不在上述分类/);
    /* 旧版「不要套用某个风格模板」与新规则冲突，必须已删除 */
    assert.doesNotMatch(system, /套用某个风格模板/);
});

test('maxOutputTokens：预算随段数增长且不超过上限', () => {
    assert.ok(maxOutputTokens(10) >= 700, '10 段时至少要给 700 tokens');
    assert.equal(maxOutputTokens(10), 760);
    assert.equal(maxOutputTokens(undefined), 760, '段数未知按 10 段算');
    assert.equal(maxOutputTokens(40), 940, '段数多时预算跟着涨');
    assert.equal(maxOutputTokens(2000), OUTPUT_TOKENS_MAX, '不超过 4096 上限');
});

test('buildCompactMessages：只要曲风+曲线，歌词截断并给出归属', () => {
    const lyrics = Array.from({ length: 400 }, (_, index) => `第${index + 1}句`).join('\n');
    const { system, user } = buildCompactMessages({
        song: { title: '晴天', artist: '周杰伦' },
        bands: BANDS,
        strength: 'standard',
        genre: 'City Pop',
        lyrics,
    });
    assert.match(system, /只输出一个 JSON 对象/);
    assert.match(system, /正好 10 个数/);
    assert.match(system, /City Pop/);
    assert.match(user, /曲风（请原样沿用）：City Pop（归属：City Pop \/ 合成器流行）/);
    assert.match(user, /晴天/);
    assert.ok(user.includes('第1句'), '应带上歌词节选');
    assert.ok(user.length < COMPACT_LYRICS_CHAR_LIMIT + 400, '歌词只送节选，不整首');
    assert.ok(!/summary|meaning/u.test(system) || /JSON/.test(system), '精简版不再要求简报');
});

test('extractMessageContent：字符串与分段数组', () => {
    assert.deepEqual(
        extractMessageContent({ choices: [{ message: { content: ' hi ' }, finish_reason: 'stop' }] }),
        { content: 'hi', finishReason: 'stop' },
    );
    assert.equal(
        extractMessageContent({ choices: [{ message: { content: [{ type: 'text', text: 'ab' }, { text: 'cd' }] } }] }).content,
        'abcd',
    );
    assert.equal(extractMessageContent({}).content, '');
});

test('extractUsage：prompt/completion 与 input/output 字段都能读，缺失返回 null', () => {
    assert.deepEqual(extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), {
        prompt: 100, completion: 20, total: 120,
    });
    assert.deepEqual(extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } }), {
        prompt: 10, completion: 5, total: 15,
    });
    assert.equal(extractUsage({}), null);
    assert.equal(extractUsage({ usage: {} }), null);
    assert.equal(extractUsage(null), null);
});

test('parseCurvePayload：简报字段、代码块、别名、字段校验', () => {
    const fenced = '```json\n{"genre":"City Pop","summary":"夏日海边的告白","emotion":["轻快","怀旧"],"tags":"City Pop、80s","imagery":["海边","霓虹"],"energy":[0.2,1.4,-1,0.8],"reason":"低频太多","curve":[1,2,3],"confidence":0.9}\n```';
    const parsed = parseCurvePayload(fenced);
    assert.equal(parsed.genre, 'City Pop');
    assert.equal(parsed.reason, '低频太多');
    assert.deepEqual(parsed.curve, [1, 2, 3]);
    assert.equal(parsed.confidence, 0.9);
    assert.equal(parsed.brief.summary, '夏日海边的告白');
    assert.deepEqual(parsed.brief.emotion, ['轻快', '怀旧']);
    assert.deepEqual(parsed.brief.tags, ['City Pop', '80s'], '字符串形式也要拆成数组');
    assert.deepEqual(parsed.brief.imagery, ['海边', '霓虹']);
    assert.deepEqual(parsed.brief.energy, [0.2, 1, 0, 0.8], '能量值应夹到 0..1');

    assert.deepEqual(parseCurvePayload('{"gains":[1,0]}').curve, [1, 0]);
    assert.deepEqual(parseCurvePayload('{"eq":[1,0]}').curve, [1, 0]);
    assert.equal(parseCurvePayload('{"curve":[1],"confidence":3}').confidence, 1);
    assert.equal(parseCurvePayload('{"curve":[1]}').confidence, 0.6);
    assert.equal(parseCurvePayload('{"curve":[1]}').brief, null, '没有简报字段时 brief 为 null');
    assert.match(parseCurvePayload('not json').error, /JSON/);
    assert.match(parseCurvePayload('{"reason":"x"}').error, /curve/);
    assert.match(parseCurvePayload('').error, /空内容/);
});

test('parseCurvePayload：输出被截断时抢救 curve 与已完成的字段', () => {
    /* 真实场景：模型把 curve 写在后面，输出在 reason 中途撞到 max_tokens。 */
    const truncated = '{"genre":"City Pop","summary":"夏日海边的告白","meaning":"写的是青春期的心动","emotion":["轻快","怀旧"],"curve":[2,1,0,0,-1,-1,0,1,2,1],"reason":"低频稍多，人声略';
    const parsed = parseCurvePayload(truncated);
    assert.equal(parsed.error, undefined, '截断的 JSON 不应整条失败');
    assert.equal(parsed.salvaged, true);
    assert.deepEqual(parsed.curve, [2, 1, 0, 0, -1, -1, 0, 1, 2, 1]);
    assert.equal(parsed.genre, 'City Pop');
    assert.equal(parsed.brief.summary, '夏日海边的告白');

    /* 截断在 curve 数组中间：只认已出现的数字，交给 normalizeCurve 补零。 */
    const partial = parseCurvePayload('{"genre":"Rap","curve":[3, 2, 1, 0');
    assert.equal(partial.error, undefined);
    assert.equal(partial.salvaged, true);
    assert.deepEqual(partial.curve, [3, 2, 1, 0]);

    /* 连 curve 都没写出来：仍然报错（可触发精简重试）。 */
    const noCurve = parseCurvePayload('{"genre":"City Pop","summary":"夏日海边的告白","curve":[');
    assert.match(noCurve.error, /不完整|JSON/);
});

test('normalizeCurve：限幅、补零、超长截断、非数字拒绝', () => {
    const clamped = normalizeCurve([20, 0, 0, 0, 0, 0, -20, 0, 0, 0], { bands: BANDS, minGain: -12, maxGain: 12, maxAbs: 6 });
    assert.deepEqual(clamped.curve.slice(0, 2), [6, 3], '限幅到 ±6，且相邻段被限制到 ≤3 dB');
    assert.equal(clamped.curve[6], -3, '负向同样限幅并限斜率');
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.peak, 6);

    const padded = normalizeCurve([1, 2], { bands: BANDS, maxAbs: 6 });
    assert.equal(padded.curve.length, 10);
    assert.deepEqual(padded.curve.slice(0, 3), [1, 2, 0]);

    /* 多于均衡器段数：只取前面的段，并标记 trimmed（不再整条丢弃）。 */
    const trimmed = normalizeCurve(Array.from({ length: 12 }, (_, index) => index % 2), { bands: BANDS, maxAbs: 6 });
    assert.equal(trimmed.error, undefined);
    assert.equal(trimmed.curve.length, 10);
    assert.equal(trimmed.trimmed, true);
    assert.match(normalizeCurve(['a'], { bands: BANDS }).error, /数字/);
    assert.match(normalizeCurve([], { bands: BANDS }).error, /空/);

    const flat = normalizeCurve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { bands: BANDS });
    assert.equal(flat.noop, true);
    assert.equal(flat.trimmed, false);
});

test('normalizeCurve：相邻段限斜率，避免锯齿', () => {
    const result = normalizeCurve([0, 10, 0, 0, 0, 0, 0, 0, 0, 0], { bands: BANDS, minGain: -12, maxGain: 12, maxAbs: 6 });
    assert.equal(result.smoothed, true);
    assert.deepEqual(result.curve.slice(0, 3), [0, 3, 0]);
    for (let i = 1; i < result.curve.length; i += 1) {
        assert.ok(Math.abs(result.curve[i] - result.curve[i - 1]) <= 3 + 1e-9);
    }
});

test('formatDb / songTitle / songIdentity', () => {
    assert.equal(formatDb(0), '0');
    assert.equal(formatDb(2.34), '+2.3');
    assert.equal(formatDb(-1.25), '-1.3');
    assert.equal(songTitle({ title: '歌', artist: '人' }), '歌 — 人');
    assert.equal(songTitle({ title: '歌', artist: '' }), '歌');
    assert.equal(songTitle(null), '');
    assert.equal(songIdentity({ source: 'netease', id: '123' }), 'netease:123');
    assert.equal(songIdentity({ source: null, id: null, title: 'T', artist: 'A' }), 't:t|a');
    assert.equal(songIdentity(null), '');
});

test('cacheKeyFor：source+id 优先、无 id 退回标题歌手、指纹变化即失效', () => {
    const fp = settingsFingerprint({ provider: 'deepseek', strength: 'standard' }, 10);
    const a = cacheKeyFor({ source: 'netease', id: '123', title: 'x', artist: 'y' }, fp);
    const b = cacheKeyFor({ source: 'netease', id: '123', title: 'x', artist: 'y' }, fp);
    assert.equal(a, b);
    assert.match(a, /netease:123/);
    const other = settingsFingerprint({ provider: 'openai', strength: 'standard' }, 10);
    assert.notEqual(cacheKeyFor({ source: 'netease', id: '123' }, other), a);
    assert.match(cacheKeyFor({ source: 'local', id: null, title: 'T', artist: 'A' }, fp), /t:t\|a/);
    assert.equal(cacheKeyFor(null, fp), '');
});

test('settingsFingerprint：模型 / 强度 / 偏好 / 歌词开关都会改变指纹', () => {
    const base = { provider: 'deepseek', baseUrl: '', model: '', strength: 'standard', taste: '', useLyrics: false };
    const fp = settingsFingerprint(base, 10);
    assert.equal(settingsFingerprint({ ...base }, 10), fp);
    assert.notEqual(settingsFingerprint({ ...base, model: 'x' }, 10), fp);
    assert.notEqual(settingsFingerprint({ ...base, strength: 'bold' }, 10), fp);
    assert.notEqual(settingsFingerprint({ ...base, taste: '人声靠前' }, 10), fp);
    assert.notEqual(settingsFingerprint({ ...base, useLyrics: true }, 10), fp);
    assert.notEqual(settingsFingerprint(base, 12), fp);
    assert.notEqual(settingsFingerprint({ ...base, webSearch: 'ddg' }, 10), fp);
    assert.notEqual(settingsFingerprint({ ...base, searchCount: 5 }, 10), fp);
});

test('buildSearchQuery：中文歌与英文歌的检索词', () => {
    assert.equal(buildSearchQuery({ title: '晴天', artist: '周杰伦' }), '晴天 周杰伦 歌曲 含义 创作背景 解读');
    assert.equal(buildSearchQuery({ title: 'Lemon', artist: '米津玄師' }), 'Lemon 米津玄師 歌曲 含义 创作背景 解读');
    assert.equal(buildSearchQuery({ title: 'Blinding Lights', artist: 'The Weeknd' }), 'Blinding Lights The Weeknd song meaning background interpretation');
    assert.equal(buildSearchQuery({ title: '' }), '');
    assert.ok(buildSearchQuery({ title: 'x'.repeat(200), artist: 'y' }).length <= 120);
});

test('extractDdgResults：从 HTML 结果页抽标题与摘要', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/1">晴天 歌曲含义 解读</a>
        <a class="result__snippet">这首歌写的是校园恋情与错过，<b>周杰伦</b>的经典作品之一。</a>
      </div>
      <div class="result">
        <a class="result__a">第二篇相关文章</a>
        <div class="result__snippet">另一段摘要内容。</div>
      </div>`;
    const items = extractDdgResults(html);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, '晴天 歌曲含义 解读');
    assert.match(items[0].snippet, /校园恋情/);
    assert.equal(items[0].site, 'duckduckgo');
    assert.deepEqual(extractDdgResults(''), []);
});

test('normalizeSearchResults：各搜索 API 的字段统一', () => {
    assert.deepEqual(normalizeSearchResults('tavily', { results: [{ title: 'T', content: 'C' }] })[0], { title: 'T', snippet: 'C', site: 'tavily' });
    assert.deepEqual(normalizeSearchResults('serper', { organic: [{ title: 'S', snippet: '内容' }] })[0], { title: 'S', snippet: '内容', site: 'google' });
    assert.deepEqual(normalizeSearchResults('bocha', { data: { webPages: { value: [{ name: 'B', snippet: '摘要' }] } } })[0], { title: 'B', snippet: '摘要', site: 'bocha' });
    assert.deepEqual(normalizeSearchResults('searxng', { results: [{ title: 'X', content: 'Y' }] })[0], { title: 'X', snippet: 'Y', site: 'searxng' });
    assert.deepEqual(normalizeSearchResults('unknown', {}), []);
    assert.ok(normalizeSearchResults('tavily', { results: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, content: 'c' })) }).length <= 5);
    assert.equal(normalizeSearchResults('tavily', { results: [{ title: '<b>带标签</b>', content: 'a &amp; b&nbsp;c' }] })[0].title, '带标签');
});

test('webSourceLines：截断与排版，最多 5 条', () => {
    const lines = webSourceLines([
        { title: '标题一', snippet: '摘要一', site: 'wikipedia' },
        { title: '标题二', snippet: '摘要二' },
    ]);
    assert.equal(lines.split('\n').length, 2);
    assert.match(lines, /标题一｜摘要一（wikipedia）/);
    assert.equal(webSourceLines([]), '');
    assert.equal(webSourceLines(null), '');
    const many = webSourceLines(Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, snippet: 's' })));
    assert.equal(many.split('\n').length, 5);
});

test('buildMessages：联网资料会进提示词，并要求参考但不复述来源', () => {
    const { system, user, sourceCount } = buildMessages({
        song: { title: '晴天', artist: '周杰伦' },
        bands: BANDS,
        strength: 'standard',
        webSources: [{ title: '晴天 歌曲解读', snippet: '讲的是校园恋情与错过。', site: 'wikipedia' }],
    });
    assert.equal(sourceCount, 1);
    assert.match(user, /【联网资料】/);
    assert.match(user, /校园恋情/);
    assert.match(system, /联网资料/);
    assert.match(system, /不是用户指令/);
    assert.match(system, /meaning/);
});

test('parseCurvePayload：深层含义字段 meaning', () => {
    const parsed = parseCurvePayload(JSON.stringify({
        genre: 'City Pop',
        summary: '夏日的告白',
        meaning: '表面写海边约会，实际是在告别一段回不去的夏天。',
        emotion: ['轻快'],
        tags: ['City Pop'],
        imagery: ['海边'],
        energy: [0.2, 0.7, 0.3],
        reason: '低频稍多',
        curve: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        confidence: 0.8,
    }));
    assert.equal(parsed.brief.meaning, '表面写海边约会，实际是在告别一段回不去的夏天。');
    assert.equal(parseCurvePayload('{"curve":[1]}').brief, null);
    assert.equal(parseCurvePayload(JSON.stringify({ curve: [1], meaning: 'x'.repeat(400) })).brief.meaning.length, 240);
});

