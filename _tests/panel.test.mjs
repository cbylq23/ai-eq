// _tests/panel.test.mjs — 用极简 DOM stub 冒烟测试设置面板：挂载、渲染、按钮、卸载。
import test from 'node:test';
import assert from 'node:assert/strict';

import activate, { TUNING } from '../ai-eq/client.mjs';
import { cacheKeyFor, settingsFingerprint } from '../_src/eq.mjs';
import { createHost, chatResponse, chatResponseWithUsage, curveContent, okResponse, sleep, waitFor } from './mock-host.mjs';

TUNING.requestGap = 5;
TUNING.writeGap = 5;
TUNING.saveDebounce = 10;
TUNING.bootDelay = 10;
TUNING.generateDelay = 5;

function createElement(tag) {
    return {
        tagName: String(tag).toUpperCase(),
        children: [],
        style: {},
        className: '',
        textContent: '',
        title: '',
        type: '',
        value: '',
        checked: false,
        disabled: false,
        placeholder: '',
        autocomplete: '',
        spellcheck: false,
        handlers: {},
        removed: false,
        append(...nodes) {
            this.children.push(...nodes);
        },
        replaceChildren(...nodes) {
            this.children = [...nodes];
        },
        addEventListener(type, handler) {
            this.handlers[type] = handler;
        },
        setAttribute() {},
        remove() {
            this.removed = true;
        },
    };
}

globalThis.document = { createElement, activeElement: null };

const SONG = { id: '1001', title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', ref: 'r1' };

const DEFAULT_CFG = {
    provider: 'deepseek', baseUrl: '', model: '', strength: 'standard', taste: '', useLyrics: true,
    /* v2.2.0 起配置指纹还包含联网资料三项，必须与设置默认值一致。 */
    webSearch: 'off', searchBaseUrl: '', searchCount: 3,
};

function songKey(song) {
    return cacheKeyFor(song, settingsFingerprint(DEFAULT_CFG, 10));
}

function walk(element, out = []) {
    out.push(element);
    for (const child of element.children || []) walk(child, out);
    return out;
}

function textOf(container) {
    return walk(container)
        .map((node) => (typeof node.textContent === 'string' ? node.textContent : ''))
        .join('\n');
}

test('设置面板：能挂载、渲染、点按生成按钮、卸载', async () => {
    const host = createHost({
        song: SONG,
        fetchImpl: async () => okResponse(chatResponse(curveContent([1, 0, 0, 0, -1, 0, 0, 0, 0, 0]))),
    });
    host.secretsMap.set('apiKey', 'sk-test');

    const dispose = activate(host.folium);
    assert.ok(host.sectionDef && typeof host.sectionDef.settingsPanel === 'function', '应该提供 settingsPanel');

    const container = createElement('div');
    const ctx = {
        locale: 'zh-CN',
        settings: host.section.settings,
        onChange: () => () => {},
    };
    const unmount = host.sectionDef.settingsPanel(container, ctx);
    assert.equal(typeof unmount, 'function');
    assert.equal(container.children.length, 2, '应该挂载 style + root');

    const texts = textOf(container);
    assert.match(texts, /AI 智能 EQ/);
    assert.match(texts, /当前均衡器/);
    assert.match(texts, /为当前歌曲生成/);
    assert.match(texts, /测试连接/);
    assert.match(texts, /API 密钥/);
    assert.match(texts, /当前接口/);
    assert.match(texts, /deepseek/);

    // 换歌 / 均衡器事件触发的重绘不应抛错
    await host.emit('playback.songChanged', { song: { ...SONG, id: '2002', title: 'Lemon' } });
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'host', modId: null } });

    // 找到「为当前歌曲生成」按钮并点击
    const button = walk(container).find((node) => node.tagName === 'BUTTON' && node.textContent === '为当前歌曲生成');
    assert.ok(button, '应该渲染出生成按钮');
    button.handlers.click();
    assert.ok(await waitFor(() => host.fetchCalls.length === 1, 1000), '点击后应该发起请求');
    assert.ok(await waitFor(() => host.applyCalls.length >= 1, 1000), '请求结果应该施加');

    await sleep(30);
    unmount();
    dispose();
});

test('设置面板：英文面板也能渲染，且在音效被用户改动后显示提示', async () => {
    const host = createHost({ song: SONG, eqEnabled: false });
    host.secretsMap.set('apiKey', 'sk-test');
    const dispose = activate(host.folium);
    await sleep(25);

    const container = createElement('div');
    const ctx = { locale: 'en-US', settings: host.section.settings, onChange: () => () => {} };
    const unmount = host.sectionDef.settingsPanel(container, ctx);
    const texts = textOf(container);
    assert.match(texts, /AI EQ/);
    assert.match(texts, /Generate for this song/);
    assert.match(texts, /Connection/);
    assert.match(texts, /Processing: off/);
    assert.match(texts, /equalizer master switch/i);

    host.eq.mode = { kind: 'preset', id: 'hall' };
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'user', modId: null } });
    await sleep(10);
    const after = textOf(container);
    assert.match(after, /audio effects|paused|manual/i);

    unmount();
    dispose();
});

test('设置面板：简报、调用花费、👍 反馈与口味联动', async () => {
    const content = JSON.stringify({
        genre: 'City Pop',
        summary: '夏日海边的告白',
        emotion: ['轻快'],
        tags: ['City Pop', '80s'],
        imagery: ['海边'],
        energy: [0.2, 0.6, 0.9, 0.4],
        reason: '低频稍多',
        curve: [0, -1, 0, 0, 0, 1, 1, 0, 0, 0],
        confidence: 0.8,
    });
    const usage = { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 };
    const host = createHost({
        song: SONG,
        settings: { autoApply: false, priceIn: 2, priceOut: 8 },
        fetchImpl: async () => okResponse(chatResponseWithUsage(content, usage)),
    });
    host.secretsMap.set('apiKey', 'k');
    const dispose = activate(host.folium);
    await sleep(25);

    const container = createElement('div');
    const ctx = { locale: 'zh-CN', settings: host.section.settings, onChange: () => () => {} };
    const unmount = host.sectionDef.settingsPanel(container, ctx);

    const generateButton = walk(container).find((node) => node.tagName === 'BUTTON' && node.textContent === '为当前歌曲生成');
    assert.ok(generateButton, '应该有生成按钮');
    generateButton.handlers.click();
    assert.ok(await waitFor(() => host.applyCalls.length === 1, 1000));
    await sleep(40);

    let texts = textOf(container);
    assert.match(texts, /歌曲简报/);
    assert.match(texts, /夏日海边的告白/);
    assert.match(texts, /City Pop/);
    assert.match(texts, /风格标签/);
    assert.match(texts, /能量起伏/);
    assert.match(texts, /调用与花费/);
    assert.match(texts, /本曲/);
    assert.match(texts, /累计/);
    assert.match(texts, /tokens/);
    assert.match(texts, /¥0\.0018/, '500 输入 + 100 输出，按 2/8 元每百万估算');

    const upButton = walk(container).find((node) => node.tagName === 'BUTTON' && String(node.textContent).includes('👍'));
    assert.ok(upButton, '应该有 👍 按钮');
    upButton.handlers.click();
    await sleep(20);
    texts = textOf(container);
    assert.match(texts, /评价：👍 1/);
    assert.match(texts, /你喜欢的标签/);
    const taste = host.storageMap.get('aieq-taste-v1');
    assert.ok(taste && taste.ratings['netease:1001'], '评价应该持久化到口味记录');

    // 再生成一次：这次已知简报，提示词里应带上「气质相近歌曲的反馈」
    await host.commandDefs.get('generate').run({ values: {} });
    assert.ok(await waitFor(() => host.fetchCalls.length === 2, 1000));
    const prompt = JSON.parse(host.fetchCalls[1].init.body).messages[1].content;
    assert.match(prompt, /气质相近歌曲的反馈/);
    assert.match(prompt, /《晴天》/);
    assert.match(prompt, /👍/);
    texts = textOf(container);
    assert.match(texts, /2 次/);

    unmount();
    dispose();
});

test('播放页入口：进度条按钮 + AI EQ 面板已注册', async () => {
    const host = createHost({});
    const dispose = activate(host.folium);
    const progress = host.progressDefs.get('open-panel');
    assert.ok(progress, '应该注册进度条按钮');
    assert.equal(progress.slot, 'progress.trailing', '应该挂在进度条右侧');
    assert.equal(typeof progress.mount, 'function');
    const tab = host.panelTabDefs.get('eq');
    assert.ok(tab, '应该注册播放器面板标签页');
    assert.equal(typeof tab.mount, 'function');
    dispose();
});

test('进度条按钮：点击打开 AI EQ 面板，本模组曲线时高亮', async () => {
    const host = createHost({ song: SONG });
    host.secretsMap.set('apiKey', 'k');
    const dispose = activate(host.folium);
    await sleep(25);

    const progress = host.progressDefs.get('open-panel');
    const container = createElement('div');
    const disposeFns = [];
    const ctx = {
        getColors: () => ({ fill: '#fff', track: '#000', text: '#fff' }),
        onChange: () => () => {},
        onDispose: (fn) => disposeFns.push(fn),
    };
    const unmount = progress.mount(container, ctx);
    const button = walk(container).find((node) => node.tagName === 'BUTTON');
    assert.ok(button, '应该渲染出按钮');
    assert.match(String(button.title), /AI 智能 EQ/);
    assert.ok(!String(button.className).includes('active'), '默认不是本模组曲线');

    button.handlers.click();
    assert.deepEqual(host.openPanelCalls, ['eq'], '点击应打开 AI EQ 标签页');

    host.eq.mode = { kind: 'mod', modId: 'ai-eq' };
    host.eq.gains = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await host.emit('equalizer.changed', { state: host.snapshot(), origin: { kind: 'mod', modId: 'ai-eq' } });
    assert.ok(String(button.className).includes('active'), '本模组曲线在位的按钮应高亮');

    assert.ok(disposeFns.length >= 1, '应该登记清理函数');
    if (typeof unmount === 'function') unmount();
    dispose();
});

test('AI EQ 面板：当前 EQ、歌曲标签、喜欢状态与评价联动', async () => {
    const brief = {
        summary: '夏日海边的告白',
        emotion: ['轻快'],
        tags: ['City Pop', '80s'],
        imagery: ['海边'],
        energy: [0.2, 0.6, 0.9, 0.4],
    };
    const host = createHost({
        song: SONG,
        fetchImpl: async () => {
            throw new Error('命中记忆时不应请求');
        },
    });
    host.storageMap.set('aieq-cache-v1', {
        v: 2,
        entries: {
            [songKey(SONG)]: {
                curve: [0, -1, 0, 0, 0, 1, 1, 0, 0, 0],
                reason: '低频稍多',
                confidence: 0.8,
                model: 'm',
                genre: 'City Pop',
                brief,
                usage: { prompt: 500, completion: 100, total: 600, cost: 0.0018 },
                at: Date.now(),
            },
        },
    });
    host.secretsMap.set('apiKey', 'k');
    const dispose = activate(host.folium);
    await sleep(30);
    assert.ok(await waitFor(() => host.applyCalls.length === 1, 800), '记忆里的曲线应该被套用');

    const tab = host.panelTabDefs.get('eq');
    const container = createElement('div');
    const ctx = { locale: 'zh-CN', onChange: () => () => {}, onDispose: () => {} };
    const unmount = tab.mount(container, ctx);

    let texts = textOf(container);
    assert.match(texts, /AI 智能 EQ/);
    assert.match(texts, /当前 EQ/);
    assert.match(texts, /本模组的曲线/);
    assert.match(texts, /歌曲标签/);
    assert.match(texts, /City Pop/);
    assert.match(texts, /轻快/);
    assert.match(texts, /海边/);
    assert.match(texts, /我的评价/);
    assert.match(texts, /还没评价/);
    assert.match(texts, /本曲 0 次/, '缓存命中不计调用');

    const upButton = walk(container).find((node) => node.tagName === 'BUTTON' && String(node.textContent).includes('👍'));
    assert.ok(upButton, '应该有 👍 按钮');
    upButton.handlers.click();
    await sleep(20);
    texts = textOf(container);
    assert.match(texts, /你喜欢这种调音/);
    const taste = host.storageMap.get('aieq-taste-v1');
    assert.ok(taste && taste.ratings['netease:1001'], '评价应该写入口味记录');

    unmount();
    dispose();
});
