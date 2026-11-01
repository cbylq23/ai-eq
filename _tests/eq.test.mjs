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

test('normalizeCurve：限幅、补零、超长拒绝、非数字拒绝', () => {
    const clamped = normalizeCurve([20, 0, 0, 0, 0, 0, -20, 0, 0, 0], { bands: BANDS, minGain: -12, maxGain: 12, maxAbs: 6 });
    assert.deepEqual(clamped.curve.slice(0, 2), [6, 3], '限幅到 ±6，且相邻段被限制到 ≤3 dB');
    assert.equal(clamped.curve[6], -3, '负向同样限幅并限斜率');
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.peak, 6);

    const padded = normalizeCurve([1, 2], { bands: BANDS, maxAbs: 6 });
    assert.equal(padded.curve.length, 10);
    assert.deepEqual(padded.curve.slice(0, 3), [1, 2, 0]);

    assert.match(normalizeCurve(Array.from({ length: 12 }, () => 0), { bands: BANDS }).error, /超过/);
    assert.match(normalizeCurve(['a'], { bands: BANDS }).error, /数字/);
    assert.match(normalizeCurve([], { bands: BANDS }).error, /空/);

    const flat = normalizeCurve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { bands: BANDS });
    assert.equal(flat.noop, true);
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
});

