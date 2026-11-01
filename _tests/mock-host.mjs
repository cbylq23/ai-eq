// _tests/mock-host.mjs — 用内存对象模拟 Folium 宿主，用来在 Node 里驱动 client.mjs。
// 只实现 AI 智能 EQ 用到的接口，行为按 Folium 规范的语义做最小复刻。

export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency, index, all) => ({
    frequency,
    shape: index === 0 ? 'lowshelf' : index === all.length - 1 ? 'highshelf' : 'peaking',
}));

function defaultValues(schema) {
    const values = {};
    for (const def of schema || []) {
        if (def.type === 'secret') continue;
        values[def.key] = def.defaultValue !== undefined ? def.defaultValue : (def.type === 'boolean' ? false : '');
    }
    return values;
}

export function createHost(options = {}) {
    const handlers = new Map();
    const toasts = [];
    const logs = [];
    const storageMap = new Map();
    const secretsMap = new Map();
    const commandDefs = new Map();
    const progressDefs = new Map();
    const panelTabDefs = new Map();
    const openPanelCalls = [];
    const sectionHandles = new Map();
    const applyCalls = [];
    const applyAttempts = [];
    const releaseCalls = [];
    const fetchCalls = [];
    const disposers = [];
    let sectionDef = null;

    const eq = {
        enabled: options.eqEnabled !== undefined ? options.eqEnabled : true,
        mode: { kind: 'preset', id: 'flat' },
        gains: BANDS.map(() => 0),
        bands: BANDS,
        minGain: -12,
        maxGain: 12,
        hostPlaysAudio: options.hostPlaysAudio !== undefined ? options.hostPlaysAudio : true,
        writable: true,
        refusal: null,
    };

    function snapshot() {
        return {
            enabled: eq.enabled,
            mode: eq.mode,
            gains: eq.gains.slice(),
            bands: eq.bands,
            minGain: eq.minGain,
            maxGain: eq.maxGain,
            hostPlaysAudio: eq.hostPlaysAudio,
            writable: eq.writable,
        };
    }

    const folium = {
        modId: 'ai-eq',
        host: { folia: '0.7.25', folium: { major: 1, minor: options.minor !== undefined ? options.minor : 8 } },
        env: { context: options.context || 'main' },
        log: {
            info: (...args) => logs.push(['info', args.join(' ')]),
            warn: (...args) => logs.push(['warn', args.join(' ')]),
            error: (...args) => logs.push(['error', args.join(' ')]),
        },
        events: {
            on(type, handler) {
                if (!handlers.has(type)) handlers.set(type, new Set());
                handlers.get(type).add(handler);
                return () => handlers.get(type) && handlers.get(type).delete(handler);
            },
        },
        registries: {
            settingsSections: {
                register(def) {
                    sectionDef = def;
                    const values = { ...defaultValues(def.settings), ...(options.settings || {}) };
                    const subscribers = new Set();
                    const handle = {
                        id: `ai-eq:${def.id}`,
                        unregister() {},
                        settings: {
                            schema: def.settings,
                            get: () => ({ ...values }),
                            set: (patch) => {
                                const allowed = new Set((def.settings || []).map((item) => item.key));
                                for (const [key, value] of Object.entries(patch || {})) {
                                    if (allowed.has(key)) values[key] = value;
                                }
                                for (const subscriber of [...subscribers]) subscriber();
                            },
                            reset: () => { Object.assign(values, defaultValues(def.settings)); },
                            onChange: (listener) => {
                                subscribers.add(listener);
                                return () => subscribers.delete(listener);
                            },
                        },
                    };
                    sectionHandles.set(def.id, handle);
                    return handle;
                },
            },
            commands: {
                register(def) {
                    commandDefs.set(def.id, def);
                    return { id: `ai-eq:${def.id}`, unregister: () => commandDefs.delete(def.id) };
                },
            },
            progressButtons: {
                register(def) {
                    progressDefs.set(def.id, def);
                    return { id: `ai-eq:${def.id}`, unregister: () => progressDefs.delete(def.id) };
                },
            },
            playerPanelTabs: {
                register(def) {
                    panelTabDefs.set(def.id, def);
                    return { id: `ai-eq:${def.id}`, unregister: () => panelTabDefs.delete(def.id) };
                },
            },
        },
        equalizer: {
            getState: () => snapshot(),
            applyCurve: (curve) => {
                applyAttempts.push(Array.isArray(curve) ? curve.slice() : curve);
                if (eq.refusal) {
                    const reason = eq.refusal;
                    eq.refusal = null;
                    return { ok: false, reason };
                }
                if (!eq.writable) return { ok: false, reason: 'panel-open' };
                if (!Array.isArray(curve) || !curve.length) return { ok: false, reason: 'unknown-mode' };
                applyCalls.push(curve.slice());
                eq.gains = curve.slice();
                eq.mode = { kind: 'mod', modId: 'ai-eq' };
                return { ok: true, state: snapshot() };
            },
            releaseCurve: () => {
                const was = eq.mode && eq.mode.kind === 'mod' && eq.mode.modId === 'ai-eq';
                releaseCalls.push(was);
                if (was) {
                    eq.mode = { kind: 'preset', id: 'flat' };
                    eq.gains = BANDS.map(() => 0);
                }
                return was;
            },
            setMode: (mode) => {
                const valid = mode && mode.id && ['flat', 'lofi', 'radio', 'hall', 'vocal', 'bass', 'custom1', 'custom2'].includes(mode.id);
                if (!valid) return { ok: false, reason: 'unknown-mode' };
                eq.mode = { ...mode };
                return { ok: true, state: snapshot() };
            },
        },
        playback: {
            getState: () => ({
                song: options.song || null,
                state: 'playing',
                position: 0,
                duration: 0,
                liked: false,
                canLike: true,
            }),
        },
        lyrics: {
            getLines: () => options.lyrics || [],
            getLineRenderEndTime: () => 0,
            segmentWords: () => [],
            parse: async () => ({ lines: [], isWordByWord: false }),
        },
        secrets: {
            get: async (key) => (secretsMap.has(key) ? secretsMap.get(key) : null),
            has: async (key) => secretsMap.has(key),
            set: async (key, value) => {
                if (value === null || value === '') secretsMap.delete(key);
                else secretsMap.set(key, value);
                return undefined;
            },
            subscribe: () => () => {},
        },
        storage: {
            get: async (key) => storageMap.get(key),
            set: async (key, value) => {
                storageMap.set(key, JSON.parse(JSON.stringify(value === undefined ? null : value)));
            },
            has: async (key) => storageMap.has(key),
            delete: async (key) => storageMap.delete(key),
            keys: async () => [...storageMap.keys()],
        },
        net: {
            fetch: async (url, init) => {
                fetchCalls.push({ url, init });
                if (!options.fetchImpl) throw new Error('mock: no fetchImpl');
                return options.fetchImpl(url, init, fetchCalls.length);
            },
        },
        ui: {
            toast: (message, opts) => toasts.push({ message, ...(opts || {}) }),
            icon: async () => options.icon !== undefined ? options.icon : null,
            openPlayerPanel: (tabId) => openPanelCalls.push(tabId === undefined ? null : tabId),
            navigate: () => {},
        },
        rpc: {
            call: async () => {
                throw new Error('mock: rpc 未实现');
            },
            on: () => () => {},
        },
        every: (ms, fn) => {
            const timer = setInterval(fn, ms);
            return () => clearInterval(timer);
        },
        onDispose: (fn) => disposers.push(fn),
        experimental: {},
    };

    async function emit(type, payload) {
        const set = handlers.get(type);
        if (!set) return;
        for (const handler of [...set]) {
            try {
                await handler(payload);
            } catch (error) {
                logs.push(['error', `handler(${type}) 抛出：${String(error && error.message)}`]);
            }
        }
    }

    return {
        folium,
        eq,
        toasts,
        logs,
        storageMap,
        secretsMap,
        commandDefs,
        progressDefs,
        panelTabDefs,
        openPanelCalls,
        sectionHandles,
        applyCalls,
        applyAttempts,
        releaseCalls,
        fetchCalls,
        disposers,
        emit,
        get section() {
            return sectionDef ? sectionHandles.get(sectionDef.id) : null;
        },
        get sectionDef() {
            return sectionDef;
        },
        snapshot,
    };
}

/** 造一个 OpenAI chat/completions 的响应体。 */
export function chatResponse(content, finishReason = 'stop') {
    return JSON.stringify({
        id: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
        usage: { total_tokens: 1 },
    });
}

/** 带 usage 的响应体（用于统计 token / 花费）。 */
export function chatResponseWithUsage(content, usage, finishReason = 'stop') {
    return JSON.stringify({
        id: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
        usage,
    });
}

/** 造一个只输出 curve 的模型回答。 */
export function curveContent(curve, reason = '测试理由', confidence = 0.8) {
    return JSON.stringify({ reason, curve, confidence });
}

/** 返回一个 Ok 响应对象（同步 text/json，和 FoliumFetchResponse 一致）。 */
export function okResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        text: () => body,
        json: () => JSON.parse(body),
    };
}

export function errorResponse(status, body) {
    return {
        ok: false,
        status,
        statusText: 'ERR',
        headers: {},
        text: () => body || '',
        json: () => {
            try { return JSON.parse(body || '{}'); } catch (_) { return {}; }
        },
    };
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeout = 1500, interval = 5) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (predicate()) return true;
        await sleep(interval);
    }
    return false;
}
