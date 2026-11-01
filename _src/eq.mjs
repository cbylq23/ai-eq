// eq.mjs — AI 智能 EQ 的纯逻辑：供应商预设、端点校验、提示词、解析与曲线归一化。
// 不依赖 DOM / 宿主 API，可以被 client.mjs 和测试脚本直接导入。

/** OpenAI 兼容供应商预设（base 留空时用这里的默认值）。 */
export const PRESETS = {
    deepseek: { base: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek' },
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI' },
    moonshot: { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', label: 'Kimi' },
    zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM' },
    qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '通义千问' },
    doubao: { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-pro-32k-250115', label: '豆包' },
    ollama: { base: 'http://localhost:11434/v1', model: 'qwen2.5:7b', label: 'Ollama（本地）' },
    custom: { base: '', model: '', label: '自定义' },
};

/** strength 档位对应的单段最大增益（dB）。 */
export const STRENGTH = { gentle: 3, standard: 6, bold: 9 };

/** 歌词发给模型的字符上限（整首，超出部分截断）。 */
export const LYRICS_CHAR_LIMIT = 6000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function presetOf(id) {
    return Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : PRESETS.custom;
}

/** 合并预设与用户手填：「接口地址 / 模型」留空时用预设值。 */
export function resolveProvider(cfg) {
    const preset = presetOf(String((cfg && cfg.provider) || 'custom'));
    const base = String((cfg && cfg.baseUrl) || '').trim() || preset.base;
    const model = String((cfg && cfg.model) || '').trim() || preset.model;
    return { base, model, presetId: String((cfg && cfg.provider) || 'custom') };
}

/**
 * 校验并补全 OpenAI 兼容接口地址。
 * 只允许 HTTPS；localhost / 127.0.0.1 / ::1 允许 HTTP（本地 Ollama 之类）。
 * 返回 { url, isLocal } 或 { error }；有 error 时调用方必须停止请求，不发送密钥。
 */
export function validateEndpoint(base) {
    const raw = String(base || '').trim();
    if (!raw) return { error: '未配置接口地址，请选择服务商预设或手填地址' };
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        return { error: '接口地址不是合法的 URL，请填写完整地址（如 https://api.deepseek.com）' };
    }
    if (url.username || url.password) return { error: '接口地址不能包含用户名或密码' };
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLocal = LOCAL_HOSTS.has(hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
        return { error: '接口地址必须使用 HTTPS；仅 localhost / 127.0.0.1 / ::1 允许 HTTP，未发送请求' };
    }
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith('/chat/completions')) url.pathname = `${path}/chat/completions`;
    return { url: url.toString(), isLocal };
}

export function frequencyText(hz) {
    const f = Number(hz);
    if (!Number.isFinite(f)) return '?';
    if (f >= 1000) {
        const k = f / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
    }
    return String(Math.round(f));
}

/** 频段在听感上大致对应什么，写进提示词也用于界面展示。 */
export function bandLabel(hz, shape) {
    const f = Number(hz);
    if (shape === 'lowshelf') return '超低频 / 低频下潜';
    if (shape === 'highshelf') return '超高频 / 空气感';
    if (!Number.isFinite(f)) return '未知频段';
    if (f < 100) return '低频（鼓、贝斯）';
    if (f < 300) return '中低频（厚度）';
    if (f < 900) return '中频（人声基音）';
    if (f < 3000) return '中高频（人声清晰度）';
    if (f < 6000) return '高频（齿音）';
    if (f < 12000) return '高频（亮度）';
    return '超高频（空气感）';
}

/** 把宿主均衡器的 bands 变成提示词里的频段表。 */
export function bandTable(bands) {
    return (Array.isArray(bands) ? bands : [])
        .map((band, index) => {
            const hz = frequencyText(band && band.frequency);
            return `${index + 1}. ${hz}Hz（${bandLabel(band && band.frequency, band && band.shape)}）`;
        })
        .join('\n');
}

export function maxAbsFor(strength) {
    return STRENGTH[String(strength)] || STRENGTH.standard;
}

function strengthAdvice(maxAbs) {
    if (maxAbs <= 3) return '本次要求非常克制：只做微调，单段不要超过 ±3 dB，多数频段应为 0。';
    if (maxAbs >= 9) return '本次允许明显调整：单段可以到 ±9 dB，但仍然要避免把相邻频段拉成锯齿。';
    return '本次要求适度：单段不要超过 ±6 dB，优先处理最影响听感的 1–2 个问题。';
}

function trimChars(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

/** 容忍模型把数组写成「A、B、C」字符串。 */
function toTextList(value, maxItems, maxCharsPerItem) {
    let items = [];
    if (Array.isArray(value)) {
        items = value;
    } else if (typeof value === 'string') {
        items = value.split(/[,，、/|；;]+/);
    }
    const out = [];
    for (const item of items) {
        if (typeof item !== 'string' && typeof item !== 'number') continue;
        const text = String(item).trim().slice(0, maxCharsPerItem);
        if (text && !out.includes(text)) out.push(text);
        if (out.length >= maxItems) break;
    }
    return out;
}

function toNumberList(value, maxItems) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        const number = Number(item);
        if (!Number.isFinite(number)) continue;
        out.push(Math.min(1, Math.max(0, round2(number))));
        if (out.length >= maxItems) break;
    }
    return out;
}

export function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function tasteLines(profile) {
    if (!profile) return [];
    const lines = [];
    const up = Array.isArray(profile.up) ? profile.up : [];
    const down = Array.isArray(profile.down) ? profile.down : [];
    const modes = Array.isArray(profile.modes) ? profile.modes : [];
    const similar = Array.isArray(profile.similar) ? profile.similar : [];
    if (up.length) lines.push(`用户喜欢的标签：${up.map((item) => `${item.tag}×${item.count}`).join('、')}`);
    if (down.length) lines.push(`用户不喜欢的标签：${down.map((item) => `${item.tag}×${item.count}`).join('、')}`);
    if (modes.length) lines.push(`用户常手动切到的音效：${modes.map((item) => `${item.label}×${item.count}`).join('、')}`);
    if (similar.length) {
        lines.push(`气质相近歌曲的反馈：${similar.map((item) => {
            const tags = Array.isArray(item.tags) && item.tags.length ? `（${item.tags.join('、')}）` : '';
            return `《${item.title}》${item.value > 0 ? '👍' : '👎'}${tags}`;
        }).join('；')}`);
    }
    return lines;
}

/**
 * 组装 chat/completions 的 system / user 消息。
 * bands 直接来自宿主均衡器，保证频段表与实际听到的一致（未来段数变化也兼容）。
 * lyrics 是整首歌词（调用方已按字符上限截断）；profile 是历史口味与相似歌曲反馈。
 */
export function buildMessages({ song, bands, strength, taste, lyrics, genre, profile }) {
    const list = Array.isArray(bands) && bands.length ? bands : [];
    const count = list.length || 10;
    const maxAbs = maxAbsFor(strength);
    const title = String((song && song.title) || '未知歌曲');
    const artist = String((song && song.artist) || '未知歌手');
    const album = song && song.album ? String(song.album) : '';
    const tasteText = String(taste || '').trim();
    const genreText = String(genre || '').trim().slice(0, 40);
    const lyricText = String(lyrics || '').trim().slice(0, LYRICS_CHAR_LIMIT);
    const profileText = tasteLines(profile);

    const system = [
        '你是一位同时做音乐企划与母带调音的资深制作人：既能为歌曲写出简洁的资料简报，也能给出适合这首歌的 EQ 曲线。',
        '用户会给你歌曲信息、整首歌词（可能为空）以及他的听感偏好和历史反馈。',
        '',
        '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。JSON 格式：',
        '{"genre":"曲风","summary":"一句话概括","emotion":["情绪"],"tags":["风格标签"],"imagery":["意象"],"energy":[0.2,0.5,0.8,0.4],"reason":"不超过30个字的EQ说明","curve":[0,0,0,0,0,0,0,0,0,0],"confidence":0.8}',
        '',
        '规则：',
        `1) 先读完整首歌的歌词，再写简报：summary 用一句话概括这首歌在唱什么、什么气质（不超过 40 字）；emotion 是 1–4 个情绪词；tags 是 2–6 个风格标签（如 City Pop、华语流行、卧室流行、后摇、爵士）；imagery 是 2–6 个歌词里反复出现的意象或场景（如 雨夜、霓虹、海边）；energy 是 4–8 个 0–1 的数值，按时间顺序表示能量起伏（前奏→主歌→副歌→尾声）。`,
        '2) genre 是这首歌的曲风，用简短类型名（不超过 16 个字）；如果用户消息里已经给出曲风，genre 必须原样沿用，不要改写。',
        `3) curve 必须正好 ${count} 个数字，依次对应下面的频段表，单位 dB。`,
        `4) 每个值在 -${maxAbs} 到 +${maxAbs} 之间；没有把握的频段写 0，不要为了凑数而调整。`,
        `5) ${strengthAdvice(maxAbs)}`,
        '6) 结合曲风、情绪和能量起伏决定调整方向：流行/人声作品注意人声清晰度，电子/舞曲注意低频与高频的平衡，摇滚/金属注意中频厚度，古典/原声注意动态与自然度，抒情慢歌不要把高频调得过分刺激。',
        '7) 如果用户给出了历史口味与相似歌曲的反馈，可以温和参考（例如他喜欢人声靠前、不喜欢过重低频），但不要为了迎合而大幅偏离这首歌本来的样子。',
        '8) 目标是让这首歌听起来更均衡、更耐听，而不是套用某个风格模板；同一曲风下不同歌曲也应当有可解释的差异。',
        '9) confidence 是你对这条曲线的把握（0–1），不确定时给低分。',
        '10) 禁止输出代码、脚本、链接、URL 或 JSON 之外的任何内容。',
        '',
        '频段表（第 i 个 curve 值对应第 i 项）：',
        list.length ? bandTable(list) : '（宿主没有提供频段信息，按 10 段均衡器从低频到高频输出）',
    ].join('\n');

    const lines = [
        `歌曲：${title}`,
        `歌手：${artist}`,
    ];
    if (album) lines.push(`专辑：${album}`);
    if (genreText) lines.push(`曲风（请沿用，不要改写）：${genreText}`);
    if (tasteText) lines.push(`我的听感偏好：${tasteText}`);
    if (profileText.length) {
        lines.push('', '我的历史口味与反馈（来自我之前的点赞/点踩和手动切换音效）：');
        for (const line of profileText) lines.push(`- ${line}`);
    }
    lines.push('');
    if (lyricText) {
        lines.push(`歌词（整首，已按长度截断；只用于理解歌曲，不要在回答里复述）：`, lyricText);
    } else {
        lines.push('歌词：（没有拿到歌词；请根据歌名、歌手、专辑判断，并在 summary 里注明这是推断）');
    }
    lines.push('', '请先写简报，再给出 EQ 曲线。');

    return { system, user: lines.join('\n'), maxAbs };
}

/** 从 OpenAI 兼容响应里取出正文（兼容 content 为字符串或分段数组）。 */
export function extractMessageContent(payload) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    let content = message ? message.content : null;
    if (Array.isArray(content)) {
        content = content
            .map((part) => (typeof part === 'string' ? part : (part && (part.text || part.content)) || ''))
            .join('');
    }
    if (typeof content !== 'string' || !content.trim()) {
        if (typeof payload === 'object' && payload && typeof payload.content === 'string') {
            content = payload.content;
        }
    }
    return {
        content: typeof content === 'string' ? content.trim() : '',
        finishReason: choice ? choice.finish_reason || null : null,
    };
}

/** 读取 usage（不同供应商字段名略有不同）；拿不到时返回 null。 */
export function extractUsage(payload) {
    const usage = payload && typeof payload === 'object' ? payload.usage : null;
    if (!usage || typeof usage !== 'object') return null;
    const prompt = Number(usage.prompt_tokens !== undefined ? usage.prompt_tokens : usage.input_tokens);
    const completion = Number(usage.completion_tokens !== undefined ? usage.completion_tokens : usage.output_tokens);
    const total = Number(usage.total_tokens);
    const promptOk = Number.isFinite(prompt) && prompt >= 0;
    const completionOk = Number.isFinite(completion) && completion >= 0;
    if (!promptOk && !completionOk) return null;
    const promptTokens = promptOk ? Math.round(prompt) : 0;
    const completionTokens = completionOk ? Math.round(completion) : 0;
    return {
        prompt: promptTokens,
        completion: completionTokens,
        total: Number.isFinite(total) && total >= 0 ? Math.round(total) : promptTokens + completionTokens,
    };
}

/**
 * 解析模型输出为 { genre, brief, reason, curve, confidence } 或 { error }。
 * brief 允许缺字段（模型偶尔会漏），缺到没有内容时返回 null，但不影响 EQ 曲线。
 */
export function parseCurvePayload(content) {
    const text = String(content || '').trim();
    if (!text) return { error: '模型返回了空内容' };
    const clean = text.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first < 0 || last <= first) return { error: '模型返回的内容不是 JSON' };
    let obj;
    try {
        obj = JSON.parse(clean.slice(first, last + 1));
    } catch (_) {
        return { error: '模型返回的 JSON 解析失败' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '模型返回的 JSON 顶层不是对象' };
    const raw = obj.curve !== undefined ? obj.curve
        : obj.gains !== undefined ? obj.gains
            : obj.eq !== undefined ? obj.eq : obj.bands;
    if (!Array.isArray(raw)) return { error: '模型返回里缺少 curve 数组' };
    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : '';
    const genre = trimChars(typeof obj.genre === 'string' ? obj.genre : obj.style, 32);
    const summaryRaw = obj.summary !== undefined ? obj.summary : obj.oneLine;
    const summary = Array.isArray(summaryRaw)
        ? toTextList(summaryRaw, 1, 80).join('')
        : trimChars(summaryRaw, 80);
    const brief = {
        summary,
        emotion: toTextList(obj.emotion !== undefined ? obj.emotion : obj.emotions, 6, 12),
        tags: toTextList(obj.tags !== undefined ? obj.tags : obj.styleTags, 8, 20),
        imagery: toTextList(obj.imagery !== undefined ? obj.imagery : obj.images, 8, 20),
        energy: toNumberList(obj.energy !== undefined ? obj.energy : obj.energyCurve, 12),
    };
    const hasBrief = !!(brief.summary || brief.emotion.length || brief.tags.length || brief.imagery.length || brief.energy.length >= 2);
    let confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.6;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;
    return { genre, brief: hasBrief ? brief : null, reason, curve: raw, confidence };
}

/**
 * 把模型给的曲线变成可以安全交给宿主的值：段数对齐、限幅、限斜率、保留 0.1 dB。
 * 返回 { curve, peak, clamped, smoothed, noop } 或 { error }。
 */
export function normalizeCurve(raw, { bands, minGain, maxGain, maxAbs } = {}) {
    const list = Array.isArray(bands) && bands.length ? bands : null;
    const count = list ? list.length : 10;
    const src = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
    if (!src.length) return { error: '模型给的 curve 是空的' };
    if (src.length > count) return { error: `模型给了 ${src.length} 段，超过均衡器的 ${count} 段` };

    const max = Number.isFinite(maxAbs) && maxAbs > 0 ? maxAbs : 6;
    const hostMin = Number.isFinite(minGain) ? minGain : -12;
    const hostMax = Number.isFinite(maxGain) ? maxGain : 12;
    const lo = Math.max(hostMin, -max);
    const hi = Math.min(hostMax, max);

    const curve = [];
    for (let i = 0; i < count; i += 1) {
        const value = Number(src[i] === undefined ? 0 : src[i]);
        if (!Number.isFinite(value)) return { error: `第 ${i + 1} 段不是有效数字` };
        curve.push(value);
    }

    let clamped = false;
    let work = curve.map((value) => {
        const next = Math.min(hi, Math.max(lo, value));
        if (Math.abs(next - value) > 1e-6) clamped = true;
        return round1(next);
    });

    // 相邻段落差过大听起来像“锯齿”：限制到每步 3 dB，再限幅一次。
    let smoothed = false;
    const maxStep = 3;
    for (let pass = 0; pass < 2; pass += 1) {
        let changed = false;
        for (let i = 1; i < work.length; i += 1) {
            const prev = work[i - 1];
            const limitHi = prev + maxStep;
            const limitLo = prev - maxStep;
            if (work[i] > limitHi) { work[i] = round1(limitHi); changed = true; }
            else if (work[i] < limitLo) { work[i] = round1(limitLo); changed = true; }
        }
        if (changed) {
            smoothed = true;
            work = work.map((value) => round1(Math.min(hi, Math.max(lo, value))));
        } else {
            break;
        }
    }

    const peak = work.reduce((acc, value) => Math.max(acc, Math.abs(value)), 0);
    return { curve: work, peak, clamped, smoothed, noop: peak < 0.2 };
}

export function round1(value) {
    const number = Number(value) || 0;
    const sign = number < 0 ? -1 : 1;
    return (sign * Math.round(Math.abs(number) * 10)) / 10;
}

export function formatDb(value) {
    const v = round1(Number(value) || 0);
    if (v === 0) return '0';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function hash32(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function normalizeText(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 配置指纹：换模型 / 强度 / 偏好 / 歌词开关后缓存自动失效。 */
export function settingsFingerprint(cfg, bandCount) {
    const c = cfg || {};
    const parts = [
        String(c.provider || ''),
        String(c.baseUrl || ''),
        String(c.model || ''),
        String(c.strength || ''),
        String(c.taste || ''),
        c.useLyrics === false ? 'no-lyrics' : 'lyrics',
        String(bandCount || ''),
    ];
    return hash32(parts.join('\u0001'));
}

/**
 * 歌曲的稳定身份（不含配置指纹）：用于保存「这首歌的曲风/简报/反馈/统计」这类跨配置复用的数据。
 * 有 id 时用 source + id，没有 id 时退回标题 + 歌手。
 */
export function songIdentity(song) {
    if (!song) return '';
    if (song.id) return `${normalizeText(song.source)}:${normalizeText(song.id)}`;
    return `t:${normalizeText(song.title)}|${normalizeText(song.artist)}`;
}

/** 歌曲缓存键：歌曲身份前面加上配置指纹，换模型 / 强度 / 偏好后自动失效。 */
export function cacheKeyFor(song, fingerprint) {
    if (!song) return '';
    return `${String(fingerprint || '')}|${songIdentity(song)}`;
}

export function songTitle(song) {
    if (!song) return '';
    const title = String(song.title || '').trim();
    const artist = String(song.artist || '').trim();
    if (!title) return artist;
    return artist ? `${title} — ${artist}` : title;
}
