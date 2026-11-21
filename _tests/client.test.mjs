// _tests/client.test.mjs — 用 mock 宿主驱动 client.mjs 的关键场景（node --test _tests/）
import test from 'node:test';
import assert from 'node:assert/strict';

import activate, { TUNING } from '../ai-eq/client.mjs';
import { cacheKeyFor, settingsFingerprint, songIdentity } from '../_src/eq.mjs';
import {
    createHost,
    chatResponse,
    chatResponseWithUsage,
    curveContent,
    okResponse,
    errorResponse,
    sleep,
    waitFor,
} from './mock-host.mjs';

// 测试里把所有等待压到毫秒级。
TUNING.requestGap = 5;
TUNING.writeGap = 5;
TUNING.saveDebounce = 10;
TUNING.bootDelay = 10;
TUNING.generateDelay = 5;

const SONG_A = { id: '1001', title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', ref: 'r1' };
const SONG_B = { id: '2002', title: 'Lemon', artist: '米津玄師', album: 'STRAY SHEEP', source: 'netease', ref: 'r2' };

const DEFAULTS = {
    provider: 'deepseek', baseUrl: '', model: '', strength: 'standard', taste: '', useLyrics: true,
    /* v2.2.0 起配置指纹还包含联网资料三项，必须与设置默认值一致，否则算出来的缓存键对不上。 */
    webSearch: 'off', searchBaseUrl: '', searchCount: 3,
};

/** 一条带完整简报的模型回答。 */
function briefContent(overrides = {}) {
    return JSON.stringify({
        genre: 'City Pop',
        summary: '夏日海边的告白',
        emotion: ['轻快', '怀旧'],
        tags: ['City Pop', '80s'],
        imagery: ['海边', '霓虹'],
        energy: [0.2, 0.5, 0.9, 0.4],
        reason: '低频稍多，人声略靠后',
        curve: [0, -1, 0, 0, 0, 1, 1, 0, 0, 0],
        confidence: 0.82,
        ...overrides,
    });
}

function songKey(song, overrides) {
    return cacheKeyFor(song, settingsFingerprint({ ...DEFAULTS, ...(overrides || {}) }, 10));
}

function cachePayload(entries) {
    return { v: 1, entries };
}

function bodyOf(call) {
    return JSON.parse(call.init.body);
}

function start(host) {
    const dispose = activate(host.folium);
    return { dispose, ready: sleep(25) };
}

test('activate 注册设置分区与 7 条命令', async () => {
    const host = createHost({});
    const { dispose } = start(host);
    assert.ok(host.section, '应该注册设置分区');
    assert.deepEqual([...host.commandDefs.keys()].sort(), [
        'clear-cache', 'generate', 'release', 'reset-stats', 'reset-taste', 'test', 'toggle-ab',
    ]);
    dispose();
});

test('Folium 1.6 及更早：直接退出，不注册任何东西', async () => {
    const host = createHost({ minor: 6 });
    const returned = activate(host.folium);
    assert.equal(returned, undefined);
    assert.equal(host.commandDefs.size, 0);
    assert.equal(host.section, null);
});

test('导出窗口里不激活', async () => {
    const host = createHost({ context: 'export' });
    const returned = activate(host.folium);
    assert.equal(returned, undefined);
    assert.equal(host.commandDefs.size, 0);
});

test('换歌命中缓存：立即施加，不发请求', async () => {
    const curve = [1, 0, 0, -1, 0, 0, 1, 0, 0, 0];
    const host = createHost({
        fetchImpl: async () => {
            throw new Error('命中缓存时不应发请求');
        },
    });
    host.storageMap.set('aieq-cache-v1', cachePayload({
        [songKey(SONG_A)]: { curve, reason: '缓存理由', confidence: 0.9, model: 'm', at: Date.now() },
    }));
    host.secretsMap.set('apiKey', 'sk-test');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    assert.deepEqual(host.applyCalls[0], curve);
    assert.equal(host.fetchCalls.length, 0);
    dispose();
});

test('启动时对当前歌曲施加缓存曲线', async () => {
    const curve = [0, 0, 1, 1, 0, 0, 0, 0, 0, 0];
    const host = createHost({ song: SONG_A });
    host.storageMap.set('aieq-cache-v1', cachePayload({
        [songKey(SONG_A)]: { curve, reason: '启动缓存', confidence: 0.9, model: 'm', at: Date.now() },
    }));
    const { dispose } = start(host);
    assert.ok(await waitFor(() => host.applyCalls.length === 1, 800));
    assert.deepEqual(host.applyCalls[0], curve);
    assert.equal(host.fetchCalls.length, 0);
    dispose();
});

test('未命中缓存：请求大模型、校验后施加并写入缓存', async () => {
    const curve = [2, 1, 0, 0, -1, -1, 0, 1, 2, 2];
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(curveContent(curve, '人声靠前一点', 0.8))),
    });
    host.secretsMap.set('apiKey', 'sk-test');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '应该施加曲线');
    assert.deepEqual(host.applyCalls[0], curve);

    assert.equal(host.fetchCalls.length, 1);
    const call = host.fetchCalls[0];
    assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(call.init.method, 'POST');
    const body = bodyOf(call);
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    assert.match(body.messages[0].content, /制作人|调音/);
    assert.match(body.messages[0].content, /31Hz/);
    assert.match(body.messages[1].content, /晴天/);
    assert.match(body.messages[1].content, /请先理解这首歌的深层含义并写简报/);
    assert.equal(call.init.headers.Authorization, 'Bearer sk-test');

    await sleep(40);
    const saved = host.storageMap.get('aieq-cache-v1');
    assert.ok(saved && saved.entries[songKey(SONG_A)], '应该写入缓存');
    assert.deepEqual(saved.entries[songKey(SONG_A)].curve, curve);
    assert.equal(saved.entries[songKey(SONG_A)].reason, '人声靠前一点');
    dispose();
});

test('默认发送整首歌词；关闭 useLyrics 后只用元数据', async () => {
    const lyrics = Array.from({ length: 40 }, (_, index) => ({ fullText: `第${index + 1}句歌词` }));
    const host = createHost({
        lyrics,
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;

    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.fetchCalls.length === 1));
    const firstUser = bodyOf(host.fetchCalls[0]).messages[1].content;
    assert.match(firstUser, /第1句歌词/, '默认应发送整首歌词');
    assert.match(firstUser, /第40句歌词/, '整首而不是前几句');

    host.section.settings.set({ useLyrics: false, taste: '耳机偏低频' });
    await host.emit('playback.songChanged', { song: SONG_B });
    assert.ok(await waitFor(() => host.fetchCalls.length === 2));
    const secondUser = bodyOf(host.fetchCalls[1]).messages[1].content;
    assert.ok(!secondUser.includes('第1句歌词'), '关闭后不应发送歌词');
    assert.match(secondUser, /没有拿到歌词/);
    assert.match(secondUser, /耳机偏低频/);
    dispose();
});

test('接口 401：命令返回可读失败，不施加', async () => {
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => errorResponse(401, '{"error":"invalid api key"}'),
    });
    host.secretsMap.set('apiKey', 'bad');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const message = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /失败/);
    assert.match(message, /401/);
    assert.equal(host.applyCalls.length, 0);
    dispose();
});

test('接口 400 且不支持 response_format：自动回退重试一次', async () => {
    let calls = 0;
    const host = createHost({
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return errorResponse(400, '{"error":"response_format is not supported"}');
            return okResponse(chatResponse(curveContent([0, 0, 0, 0, 0, 0, 0, 0, 1, 1])));
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    assert.equal(host.fetchCalls.length, 2);
    assert.equal(bodyOf(host.fetchCalls[0]).response_format.type, 'json_object');
    assert.equal(bodyOf(host.fetchCalls[1]).response_format, undefined);
    dispose();
});

test('服务商不接受 temperature：去掉后重试一次', async () => {
    let calls = 0;
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return errorResponse(400, '{"error":{"message":"Unsupported value: temperature"}}');
            return okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const message = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /已生成/);
    assert.equal(host.fetchCalls.length, 2);
    assert.equal(bodyOf(host.fetchCalls[0]).temperature, 0.4);
    assert.equal(bodyOf(host.fetchCalls[1]).temperature, undefined);
    assert.ok(host.applyCalls.length >= 1);
    dispose();
});

test('关闭 JSON 模式：请求不带 response_format', async () => {    const host = createHost({
        settings: { jsonMode: false },
        fetchImpl: async () => okResponse(chatResponse(curveContent([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.fetchCalls.length === 1));
    assert.equal(bodyOf(host.fetchCalls[0]).response_format, undefined);
    dispose();
});

test('模型输出不合规：超长 curve 截断后仍可施加 / 低置信度不施加', async () => {
    /* 12 段 curve：只取前 10 段并标记 trimmed（不再整条丢弃）。 */
    const tooLong = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => okResponse(chatResponse(curveContent(Array.from({ length: 12 }, () => 1)))),
    });
    tooLong.secretsMap.set('apiKey', 'k');
    const first = start(tooLong);
    await first.ready;
    await tooLong.emit('playback.songChanged', { song: SONG_A });
    const message = await tooLong.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /已生成并施加/, '超长 curve 应截取前 10 段后生效');
    assert.equal(tooLong.applyCalls.length, 1);
    assert.equal(tooLong.applyCalls[0].length, 10);
    first.dispose();

    const lowConfidence = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], '不确定', 0.2))),
    });
    lowConfidence.secretsMap.set('apiKey', 'k');
    const second = start(lowConfidence);
    await second.ready;
    await lowConfidence.emit('playback.songChanged', { song: SONG_A });
    const message2 = await lowConfidence.commandDefs.get('generate').run({ values: {} });
    assert.match(message2, /置信度/);
    assert.equal(lowConfidence.applyCalls.length, 0);
    second.dispose();
});

test('超范围曲线会被限幅后施加（±6 dB，标准强度）', async () => {
    const host = createHost({
        song: SONG_A,
        fetchImpl: async () => okResponse(chatResponse(curveContent([99, -99, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length >= 1));
    const applied = host.applyCalls[host.applyCalls.length - 1];
    assert.equal(applied[0], 6);
    assert.ok(applied.every((value) => Math.abs(value) <= 6), '每段都应在 ±6 dB 内');
    for (let i = 1; i < applied.length; i += 1) {
        assert.ok(Math.abs(applied[i] - applied[i - 1]) <= 3, '相邻段差值不应超过 3 dB');
    }
    dispose();
});

test('没有 API 密钥：不发送请求，返回可读提示', async () => {
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const message = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /密钥/);
    assert.equal(host.fetchCalls.length, 0);
    dispose();
});

test('远程 HTTP 接口被拒绝：不发请求、不泄露密钥', async () => {
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false, baseUrl: 'http://example.com/v1' },
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const message = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /HTTPS/);
    assert.equal(host.fetchCalls.length, 0);
    dispose();
});

test('用户改音效后让位：自动施加关闭、不再请求', async () => {
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    host.eq.mode = { kind: 'preset', id: 'bass' };
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'user', modId: null } });
    assert.equal(host.section.settings.get().autoApply, false, '应该自动关闭自动施加');
    await host.emit('playback.songChanged', { song: SONG_B });
    await sleep(80);
    assert.equal(host.fetchCalls.length, 0);
    assert.equal(host.applyCalls.length, 0);
    dispose();
});

test('panel-open：先暂存，窗口关闭（writable）后补写', async () => {
    const curve = [1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(curveContent(curve))),
    });
    host.secretsMap.set('apiKey', 'k');
    host.eq.refusal = 'panel-open';
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyAttempts.length === 1), '应该尝试写入并被拒绝');
    assert.equal(host.applyCalls.length, 0);

    host.eq.writable = true;
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'host', modId: null } });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '窗口关闭后应该补写');
    assert.deepEqual(host.applyCalls[0], curve);
    dispose();
});

test('模型给出全 0 曲线：视为不需要调整，不写均衡器', async () => {
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false },
        fetchImpl: async () => okResponse(chatResponse(curveContent([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], '这首歌不需要调整', 0.9))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const message = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(message, /不需要调整/);
    assert.equal(host.applyCalls.length, 0);
    dispose();
});

test('A/B 命令：在 AI 曲线和用户音效之间切换', async () => {
    const curve = [0, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    const host = createHost({ fetchImpl: async () => okResponse(chatResponse(curveContent(curve))) });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));

    const first = await host.commandDefs.get('toggle-ab').run({ values: {} });
    assert.match(first, /切回你的音效/);
    assert.deepEqual(host.releaseCalls, [true]);

    await sleep(10);
    const second = await host.commandDefs.get('toggle-ab').run({ values: {} });
    assert.match(second, /AI 曲线/);
    assert.ok(await waitFor(() => host.applyCalls.length === 2));
    dispose();
});

test('清除缓存命令会清空存储里的曲线', async () => {
    const curve = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const host = createHost({ fetchImpl: async () => okResponse(chatResponse(curveContent(curve))) });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    await sleep(40);
    assert.ok(host.storageMap.get('aieq-cache-v1').entries[songKey(SONG_A)]);

    const message = await host.commandDefs.get('clear-cache').run({ values: {} });
    assert.match(message, /1 首/);
    const saved = host.storageMap.get('aieq-cache-v1');
    assert.deepEqual(saved.entries, {});
    dispose();
});

test('测试连接命令：成功时报告模型与耗时', async () => {
    const host = createHost({ fetchImpl: async () => okResponse(chatResponse('pong')) });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    const message = await host.commandDefs.get('test').run({ values: {} });
    assert.match(message, /连接成功/);
    assert.match(message, /deepseek-chat/);
    dispose();
});

test('快速切歌：上一首的迟到结果不会串到当前歌曲', async () => {
    const curveA = [3, 3, 2, 1, 0, 0, 0, 0, 0, 0];
    const curveB = [0, 0, 0, 0, 0, 0, 0, 2, 3, 3];
    const host = createHost({
        fetchImpl: async (url, init) => {
            const user = JSON.parse(init.body).messages[1].content;
            if (user.includes('晴天')) {
                await sleep(80);
                return okResponse(chatResponse(curveContent(curveA)));
            }
            await sleep(5);
            return okResponse(chatResponse(curveContent(curveB)));
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    await sleep(20);
    await host.emit('playback.songChanged', { song: SONG_B });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '应该只施加 B 的曲线');
    await sleep(120);
    assert.equal(host.applyCalls.length, 1, 'A 的迟到结果不应被施加');
    assert.deepEqual(host.applyCalls[0], curveB);
    dispose();
});

test('外部 Stage 播放（hostPlaysAudio=false）：不写均衡器但保留错误提示', async () => {
    const host = createHost({
        hostPlaysAudio: false,
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    await sleep(60);
    assert.equal(host.applyCalls.length, 0);
    dispose();
});

test('简报、曲风与 usage 会写进记忆，并按单价算出花费', async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponseWithUsage(briefContent(), usage)),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    await sleep(40);

    const entry = host.storageMap.get('aieq-cache-v1').entries[songKey(SONG_A)];
    assert.ok(entry, '应该写入记忆');
    assert.equal(entry.genre, 'City Pop');
    assert.equal(entry.brief.summary, '夏日海边的告白');
    assert.deepEqual(entry.brief.tags, ['City Pop', '80s']);
    assert.deepEqual(entry.brief.energy, [0.2, 0.5, 0.9, 0.4]);
    assert.equal(entry.usage.prompt, 1000);
    assert.equal(entry.usage.completion, 200);
    // 默认单价 输入 2 元 / 输出 8 元（每百万 tokens）
    assert.ok(Math.abs(entry.usage.cost - (1000 / 1e6 * 2 + 200 / 1e6 * 8)) < 1e-12);
    dispose();
});

test('听过的歌直接套用记忆：不再请求、不计调用', async () => {
    const host = createHost({
        fetchImpl: async () => {
            throw new Error('命中记忆时不应发请求');
        },
    });
    host.storageMap.set('aieq-cache-v1', {
        v: 2,
        entries: {
            [songKey(SONG_A)]: {
                curve: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                reason: '记忆里的曲线',
                confidence: 0.9,
                model: 'm',
                genre: 'City Pop',
                brief: { summary: '记忆里的简报', emotion: ['轻快'], tags: ['City Pop'], imagery: ['海边'], energy: [0.2, 0.6, 0.3] },
                usage: { prompt: 100, completion: 20, total: 120, cost: 0.001 },
                at: Date.now(),
            },
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    assert.equal(host.fetchCalls.length, 0);
    const message = await host.commandDefs.get('reset-stats').run({ values: {} });
    assert.match(message, /原 0 次调用/);
    dispose();
});

test('调用统计累计次数与 token（按设置里的单价算花费）', async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    const host = createHost({
        song: SONG_A,
        settings: { autoApply: false, priceIn: 1, priceOut: 2 },
        fetchImpl: async () => okResponse(chatResponseWithUsage(briefContent(), usage)),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    const first = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(first, /已生成/);
    const second = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(second, /已生成/);
    const message = await host.commandDefs.get('reset-stats').run({ values: {} });
    assert.match(message, /原 2 次调用/);
    dispose();
});

test('手动切换音效会记入口味，并出现在之后的请求提示词里', async () => {
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(briefContent())),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;

    host.eq.mode = { kind: 'preset', id: 'bass' };
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'user', modId: null } });
    await host.emit('playback.songChanged', { song: SONG_A });
    const result = await host.commandDefs.get('generate').run({ values: {} });
    assert.match(result, /已生成/);
    assert.equal(host.fetchCalls.length, 1);
    const user = bodyOf(host.fetchCalls[0]).messages[1].content;
    assert.match(user, /常手动切到/);
    assert.match(user, /低音增强/);

    const reset = await host.commandDefs.get('reset-taste').run({ values: {} });
    assert.match(reset, /1 次手动切换/);
    dispose();
});

test('清除记忆不会清掉口味与统计', async () => {
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(briefContent())),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    await sleep(40);
    const cleared = await host.commandDefs.get('clear-cache').run({ values: {} });
    assert.match(cleared, /记忆/);
    assert.match(cleared, /口味与统计保留/);
    const stats = await host.commandDefs.get('reset-stats').run({ values: {} });
    assert.match(stats, /原 1 次调用/);
    dispose();
});


test('已知曲风：提示词要求按归类后的曲风策略定基调', async () => {
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))),
    });
    host.storageMap.set('aieq-genres-v1', { v: 1, entries: { [songIdentity(SONG_A)]: 'City Pop' } });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.fetchCalls.length === 1));
    const system = bodyOf(host.fetchCalls[0]).messages[0].content;
    const user = bodyOf(host.fetchCalls[0]).messages[1].content;
    assert.match(system, /曲风驱动 EQ/);
    assert.match(system, /曲风的权重高于历史口味/);
    assert.match(user, /曲风（请沿用，不要改写）：City Pop/);
    assert.match(user, /City Pop \/ 合成器流行/, '应告诉模型按哪一类策略定基调');
    dispose();
});

test('曲风被改成另一类时：旧曲线作废并重新生成', async () => {
    const oldCurve = [3, 3, 3, 0, 0, 0, 0, 0, 0, 0];
    const newCurve = [0, 0, 0, 1, 1, 1, 0, 0, 0, 0];
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(curveContent(newCurve, '说唱按 808 调', 0.8))),
    });
    host.storageMap.set('aieq-cache-v1', cachePayload({
        [songKey(SONG_A)]: { curve: oldCurve, genre: 'City Pop', reason: '旧曲线', confidence: 0.9, model: 'm', at: Date.now() },
    }));
    host.storageMap.set('aieq-genres-v1', { v: 1, entries: { [songIdentity(SONG_A)]: 'Trap' } });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '应重新生成并施加新曲线');
    assert.deepEqual(host.applyCalls[0], newCurve, '旧的 City Pop 曲线不能再用');
    assert.equal(host.fetchCalls.length, 1);
    dispose();
});

test('联网资料：先搜歌名+歌手，再把摘要放进提示词（只为理解含义）', async () => {
    const searchHtml = '<div class="result"><a class="result__a" href="#">晴天 创作背景解读</a><a class="result__snippet">这首歌写于一个夏天。</a></div>';
    const host = createHost({
        settings: { webSearch: 'ddg' },
        fetchImpl: async (url) => (String(url).includes('duckduckgo')
            ? okResponse(searchHtml)
            : okResponse(chatResponse(curveContent([1, 0, 0, 0, 0, 0, 0, 0, 0, 1])))),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.fetchCalls.length >= 2), '应先搜索再请求模型');
    assert.match(host.fetchCalls[0].url, /duckduckgo/);
    assert.match(host.fetchCalls[0].url, new RegExp(encodeURIComponent('晴天')));
    const chat = host.fetchCalls[1];
    const user = bodyOf(chat).messages[1].content;
    assert.match(user, /【联网资料】/);
    assert.match(user, /创作背景解读/);
    dispose();
});

test('输出被截断：自动改用精简提示词重试并施加曲线', async () => {
    const curve = [2, 1, 0, 0, -1, -1, 0, 1, 2, 1];
    let call = 0;
    const host = createHost({
        fetchImpl: async () => {
            call += 1;
            if (call === 1) {
                /* 第一次：完整提示词，简报写太长，curve 之前就被截断 */
                return okResponse(chatResponse('{"genre":"City Pop","summary":"夏日海边的告白","meaning":"写的是青春期的', 'length'));
            }
            return okResponse(chatResponse(JSON.stringify({ genre: 'City Pop', reason: '低频稍多', curve, confidence: 0.85 })));
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '重试后应成功施加曲线');
    assert.deepEqual(host.applyCalls[0], curve);
    assert.equal(host.fetchCalls.length, 2, '应发起第二次请求');
    const second = bodyOf(host.fetchCalls[1]);
    assert.match(second.messages[0].content, /只输出一个 JSON 对象/, '第二次应是精简提示词');
    assert.ok(!/深层含义/.test(second.messages[0].content), '精简版不再要求简报');
    assert.ok(second.max_tokens >= 700, '预算按段数给足');
    /* 第一次请求的 max_tokens 不再是 900 的死值 */
    assert.ok(bodyOf(host.fetchCalls[0]).max_tokens >= 700);
    dispose();
});

test('截断但 curve 已写出来：直接抢救成功，不重试', async () => {
    const curve = [1, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const host = createHost({
        fetchImpl: async () => okResponse(chatResponse(`{"genre":"Rap","curve":${JSON.stringify(curve)},"reason":"低频优先","confidence":0.8`, 'length')),
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1));
    assert.deepEqual(host.applyCalls[0], curve);
    dispose();
});

test('服务商拒绝 max_tokens：改用 max_completion_tokens 重试', async () => {
    let call = 0;
    const host = createHost({
        fetchImpl: async () => {
            call += 1;
            if (call === 1) return errorResponse(400, '{"error":"Unsupported parameter: max_tokens"}');
            return okResponse(chatResponse(curveContent([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])));
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const { dispose, ready } = start(host);
    await ready;
    await host.emit('playback.songChanged', { song: SONG_A });
    assert.ok(await waitFor(() => host.applyCalls.length === 1), '应回退成功后施加');
    const second = bodyOf(host.fetchCalls[1]);
    assert.ok(second.max_completion_tokens >= 700);
    assert.equal(second.max_tokens, undefined);
    dispose();
});
