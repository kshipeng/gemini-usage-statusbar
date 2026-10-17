// ==UserScript==
// @name         Gemini Usage Statusbar HUD
// @namespace    https://gemini.google.com/
// @version      1.0.0
// @description  极简微缩胶囊内嵌至 Gemini 状态栏，支持多账号一键全量并发同步、新登录账号自动探测、AF_initDataCallback 与 batchexecute 跨账号共享自校准。
// @author       kshipeng & Gemini
// @license      MIT
// @match        https://gemini.google.com/*
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = `v${(typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '1.0.0'}`;
    const STORAGE_PREFIX = 'gemini_usage_sync_payload_v38_';
    const REGISTRY_KEY = 'gemini_usage_multi_registry_v38';
    const SSR_PROFILE_KEY = 'gemini_usage_ssr_profile_v38';
    const GLOBAL_RPC_PROFILE_KEY = 'gemini_usage_rpc_profile_global_v38';
    const CFG_STORAGE_KEY = 'gemini_usage_statusbar_cfg_v38';
    const CHANNEL_NAME = 'gemini_usage_broadcast_v38';
    const MAX_PROBE_SLOT = 4; // 全量同步时自动探测 u0 ~ u4 槽位
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

    const isUsagePage = /^(\/u\/\d+)?\/usage(\/|$|\?)/.test(window.location.pathname);
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // =========================================================================
    // 0. WIZ_global_data 真实身份提取（支持 DOM 树与原始 HTML 文本流双模式）
    // =========================================================================
    function unescapeWizString(str) {
        if (!str) return '';
        return str.replace(/\\u0040/gi, '@').replace(/\\"/g, '"').trim();
    }

    function extractWizFromRawHtml(html) {
        const meta = { email: '', gaiaId: '', atToken: '', bl: '', fSid: '' };
        if (!html || typeof html !== 'string') return meta;

        const emailMatch = html.match(/"oPEP7c"\s*:\s*"([^"]+)"/);
        if (emailMatch) meta.email = unescapeWizString(emailMatch[1]).toLowerCase();

        const gaiaMatch = html.match(/"S06Grb"\s*:\s*"([^"]+)"/);
        if (gaiaMatch) meta.gaiaId = unescapeWizString(gaiaMatch[1]);

        const atMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
        if (atMatch) meta.atToken = unescapeWizString(atMatch[1]);

        const blMatch = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
        if (blMatch) meta.bl = unescapeWizString(blMatch[1]);

        const sidMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
        if (sidMatch) meta.fSid = unescapeWizString(sidMatch[1]);

        return meta;
    }

    function extractWizMetadata(doc = document, win = pageWin) {
        const meta = { email: '', gaiaId: '', atToken: '', bl: '', fSid: '' };
        try {
            const wiz = win && win.WIZ_global_data;
            if (wiz && typeof wiz === 'object') {
                meta.email = typeof wiz.oPEP7c === 'string' ? unescapeWizString(wiz.oPEP7c).toLowerCase() : '';
                meta.gaiaId = typeof wiz.S06Grb === 'string' ? unescapeWizString(wiz.S06Grb) : '';
                meta.atToken = typeof wiz.SNlM0e === 'string' ? unescapeWizString(wiz.SNlM0e) : '';
                meta.bl = typeof wiz.cfb2h === 'string' ? unescapeWizString(wiz.cfb2h) : '';
                meta.fSid = typeof wiz.FdrFJe === 'string' ? unescapeWizString(wiz.FdrFJe) : '';
            }
        } catch (_) {}

        if ((!meta.email || !meta.atToken) && doc && doc.querySelectorAll) {
            const scripts = doc.querySelectorAll('script');
            for (let i = 0; i < scripts.length; i++) {
                const txt = scripts[i].textContent || '';
                if (!txt.includes('WIZ_global_data') && !txt.includes('oPEP7c') && !txt.includes('SNlM0e')) continue;
                const parsed = extractWizFromRawHtml(txt);
                if (!meta.email && parsed.email) meta.email = parsed.email;
                if (!meta.gaiaId && parsed.gaiaId) meta.gaiaId = parsed.gaiaId;
                if (!meta.atToken && parsed.atToken) meta.atToken = parsed.atToken;
                if (!meta.bl && parsed.bl) meta.bl = parsed.bl;
                if (!meta.fSid && parsed.fSid) meta.fSid = parsed.fSid;
                if (meta.email && meta.atToken) break;
            }
        }
        return meta;
    }

    function maskEmail(email) {
        if (!email || !email.includes('@')) return '';
        const [local, domain] = email.split('@');
        const prefix = local.length <= 2 ? local[0] : local.slice(0, 2);
        return `${prefix}***@${domain}`;
    }

    function buildContextFromWizAndSlot(wiz, slotIndex) {
        const idx = Number.isInteger(slotIndex) ? slotIndex : (parseInt(slotIndex, 10) || 0);
        const slotTag = `u${idx}`;
        const identityKey = wiz.email || wiz.gaiaId || slotTag;
        const safeKey = identityKey.replace(/[^a-z0-9@._-]/gi, '_');
        const masked = maskEmail(wiz.email);

        return {
            accountId: safeKey,
            slotIndex: idx,
            slotTag,
            email: wiz.email || '',
            gaiaId: wiz.gaiaId || '',
            atToken: wiz.atToken || '',
            bl: wiz.bl || '',
            fSid: wiz.fSid || '',
            displayLabel: masked ? `${slotTag} · ${masked}` : slotTag,
            storageKey: `${STORAGE_PREFIX}${safeKey}`,
            usageUrl: `${window.location.origin}/u/${idx}/usage`,
            appUrl: `${window.location.origin}/u/${idx}/app`
        };
    }

    function resolveAccountContext(doc = document, win = pageWin) {
        let slotIndex = 0;

        const menuAnchor = doc.querySelector(
            'a[data-test-id="mobile-usage-metrics-button"], a[data-test-id*="usage-metrics"], a[href$="/usage"]'
        );
        if (menuAnchor) {
            const rawHref = menuAnchor.getAttribute('href') || '';
            const anchorMatch = rawHref.match(/^\/u\/(\d+)\/usage/);
            if (anchorMatch) {
                slotIndex = parseInt(anchorMatch[1], 10);
            }
        } else {
            const pathMatch = (win.location || window.location).pathname.match(/^\/u\/(\d+)(\/|$)/);
            if (pathMatch) {
                slotIndex = parseInt(pathMatch[1], 10);
            } else {
                const authUser = new URLSearchParams((win.location || window.location).search).get('authuser');
                if (authUser && /^\d+$/.test(authUser)) {
                    slotIndex = parseInt(authUser, 10);
                }
            }
        }

        const wiz = extractWizMetadata(doc, win);
        return buildContextFromWizAndSlot(wiz, slotIndex);
    }

    // =========================================================================
    // 1. 多账号全局注册表（支持跨会话合并与槽位自动刷新）
    // =========================================================================
    function readAccountRegistry() {
        let gmMap = {};
        let lsMap = {};
        try {
            const rawGm = typeof GM_getValue === 'function' ? GM_getValue(REGISTRY_KEY) : null;
            if (rawGm) gmMap = JSON.parse(rawGm) || {};
        } catch (_) {}
        try {
            const rawLs = localStorage.getItem(REGISTRY_KEY);
            if (rawLs) lsMap = JSON.parse(rawLs) || {};
        } catch (_) {}

        const merged = Object.assign({}, lsMap);
        for (const [k, v] of Object.entries(gmMap)) {
            if (!merged[k] || (v && v.timestamp > (merged[k].timestamp || 0))) {
                merged[k] = v;
            }
        }
        return merged;
    }

    function writeAccountRegistry(regMap) {
        const serialized = JSON.stringify(regMap);
        try { if (typeof GM_setValue === 'function') GM_setValue(REGISTRY_KEY, serialized); } catch (_) {}
        try { localStorage.setItem(REGISTRY_KEY, serialized); } catch (_) {}
    }

    function upsertRegistryEntry(payload) {
        if (!payload || !payload.accountId || !payload.current || !payload.weekly) return;
        const reg = readAccountRegistry();
        const prev = reg[payload.accountId] || {};
        const slotIdx = payload.slotIndex ?? prev.slotIndex ?? 0;
        const slotTag = payload.slotTag || prev.slotTag || `u${slotIdx}`;
        const email = payload.email || prev.email || '';
        const masked = maskEmail(email);

        reg[payload.accountId] = {
            accountId: payload.accountId,
            slotIndex: slotIdx,
            slotTag,
            email,
            displayLabel: masked ? `${slotTag} · ${masked}` : (payload.displayLabel || prev.displayLabel || payload.accountId),
            badgeStr: payload.badgeStr || prev.badgeStr || 'PRO',
            usageUrl: payload.usageUrl || `${window.location.origin}/u/${slotIdx}/usage`,
            appUrl: payload.appUrl || `${window.location.origin}/u/${slotIdx}/app`,
            current: payload.current,
            weekly: payload.weekly,
            updatedStr: payload.updatedStr || '刚刚更新',
            timestamp: payload.timestamp || Date.now()
        };
        writeAccountRegistry(reg);
    }

    // =========================================================================
    // 2. 重置时间解析与极简倒计时格式化
    // =========================================================================
    function parseResetToEpoch(resetText, refTimeMs = Date.now()) {
        if (!resetText || typeof resetText !== 'string') return null;
        const ref = new Date(refTimeMs);

        const mdhmMatch = resetText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/);
        if (mdhmMatch) {
            const month = parseInt(mdhmMatch[1], 10);
            const day = parseInt(mdhmMatch[2], 10);
            const hour = parseInt(mdhmMatch[3], 10);
            const minute = parseInt(mdhmMatch[4], 10);

            let year = ref.getFullYear();
            const target = new Date(year, month - 1, day, hour, minute, 0, 0);
            if (target.getTime() < refTimeMs - 86400000 * 30) {
                target.setFullYear(year + 1);
            }
            return target.getTime();
        }

        const hmMatch = resetText.match(/(\d{1,2}):(\d{2})/);
        if (hmMatch) {
            const hour = parseInt(hmMatch[1], 10);
            const minute = parseInt(hmMatch[2], 10);
            const target = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hour, minute, 0, 0);

            if (/明天|明日|tomorrow/i.test(resetText)) {
                target.setDate(target.getDate() + 1);
            } else if (target.getTime() <= refTimeMs - 60000) {
                target.setDate(target.getDate() + 1);
            }
            return target.getTime();
        }

        return null;
    }

    function formatUltraCompactCountdown(targetMs) {
        if (!targetMs) return '';
        const diffSec = Math.floor((targetMs - Date.now()) / 1000);
        if (diffSec <= 0) return '已重置';

        const d = Math.floor(diffSec / 86400);
        const h = Math.floor((diffSec % 86400) / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        const s = diffSec % 60;

        if (d > 0) return `${d}d${h}h`;
        if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
        return `${m}m${String(s).padStart(2, '0')}s`;
    }

    function formatDetailedCountdown(targetMs, rawClockStr) {
        const suffix = rawClockStr ? ` (${rawClockStr} 重置)` : '';
        if (!targetMs) return rawClockStr ? `重置时间：${rawClockStr}` : '重置时间：--';

        const diffSec = Math.floor((targetMs - Date.now()) / 1000);
        if (diffSec <= 0) return `已到达重置时间，即将刷新...${suffix}`;

        const d = Math.floor(diffSec / 86400);
        const h = Math.floor((diffSec % 86400) / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        const s = diffSec % 60;

        if (d > 0) return `剩余 ${d}天 ${h}小时 ${String(m).padStart(2, '0')}分 ${String(s).padStart(2, '0')}秒${suffix}`;
        if (h > 0) return `剩余 ${h}小时 ${String(m).padStart(2, '0')}分 ${String(s).padStart(2, '0')}秒${suffix}`;
        return `剩余 ${m}分 ${String(s).padStart(2, '0')}秒${suffix}`;
    }

    function formatEpochToRawClock(epochMs) {
        if (!epochMs) return '';
        const d = new Date(epochMs);
        const now = new Date();
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        if (d.toDateString() === now.toDateString()) return hm;
        return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    }

    // =========================================================================
    // 3. DOM 提取、AF_initDataCallback 状态机与跨账号共享坐标校准
    // =========================================================================
    function extractMetricsFromDoc(doc, explicitCtx) {
        if (!doc || typeof doc.querySelector !== 'function') return null;
        const curNode = doc.querySelector('[data-testid="current-usage"]');
        const weekNode = doc.querySelector('[data-testid="weekly-usage"]');
        if (!curNode && !weekNode) return null;

        const nowMs = Date.now();

        const parseSection = (rootEl) => {
            if (!rootEl) return { pct: null, resetText: '重置时间：--', rawClock: '', resetAt: null };
            const rawText = rootEl.textContent || '';

            let pct = null;
            const textPctMatch = rawText.match(/(\d+(?:\.\d+)?)\s*%/);
            if (textPctMatch) {
                pct = parseFloat(textPctMatch[1]);
            } else {
                const barEl = rootEl.querySelector('[style*="--x-width"]');
                if (barEl) {
                    const styleAttr = barEl.getAttribute('style') || '';
                    const stylePctMatch = styleAttr.match(/--x-width:\s*(\d+(?:\.\d+)?)%/);
                    if (stylePctMatch) pct = parseFloat(stylePctMatch[1]);
                }
            }

            let resetText = '重置时间：--';
            let rawClock = '';
            const leafNodes = rootEl.querySelectorAll('span, p, div');
            for (let i = 0; i < leafNodes.length; i++) {
                const leaf = leafNodes[i];
                if (leaf.childElementCount === 0) {
                    const t = (leaf.textContent || '').trim();
                    if (/重置时间|Reset/i.test(t)) {
                        resetText = t;
                        const timePart = t.match(/[：:]\s*(.+)$/);
                        if (timePart) rawClock = timePart[1].trim();
                        break;
                    }
                }
            }

            if (resetText === '重置时间：--') {
                const fallbackMatch = rawText.match(/(重置时间\s*[：:]\s*[^\n]+)/);
                if (fallbackMatch) {
                    resetText = fallbackMatch[1].replace(/已使用.*$/, '').trim();
                    const timePart = resetText.match(/[：:]\s*(.+)$/);
                    if (timePart) rawClock = timePart[1].trim();
                }
            }

            const resetAt = parseResetToEpoch(resetText, nowMs);
            return { pct, resetText, rawClock, resetAt };
        };

        const current = parseSection(curNode);
        const weekly = parseSection(weekNode);
        if (current.pct === null && weekly.pct === null) return null;

        const updatedNode = doc.querySelector('[data-testid="usage-updated"]');
        const updatedStr = updatedNode ? updatedNode.textContent.trim() : '刚刚更新';

        let badgeStr = 'PRO';
        const h1 = doc.querySelector('header h1');
        if (h1 && h1.parentElement) {
            const spans = h1.parentElement.querySelectorAll('span');
            for (let i = 0; i < spans.length; i++) {
                if (spans[i].childElementCount === 0) {
                    const txt = spans[i].textContent.trim();
                    if (txt) {
                        badgeStr = txt;
                        break;
                    }
                }
            }
        }

        const detectedCtx = resolveAccountContext(doc, doc.defaultView || pageWin);
        const finalCtx = explicitCtx && typeof explicitCtx === 'object'
            ? Object.assign({}, detectedCtx, explicitCtx)
            : detectedCtx;

        return {
            accountId: finalCtx.accountId,
            slotIndex: finalCtx.slotIndex,
            slotTag: finalCtx.slotTag,
            email: finalCtx.email || detectedCtx.email,
            displayLabel: finalCtx.displayLabel || detectedCtx.displayLabel,
            usageUrl: finalCtx.usageUrl,
            appUrl: finalCtx.appUrl,
            current,
            weekly,
            updatedStr,
            badgeStr,
            timestamp: nowMs
        };
    }

    function parseAfInitDataBlocks(html) {
        const blocks = {};
        if (!html || typeof html !== 'string') return blocks;
        let searchPos = 0;
        const marker = 'AF_initDataCallback(';

        while (true) {
            const idx = html.indexOf(marker, searchPos);
            if (idx === -1) break;
            searchPos = idx + marker.length;

            const headSlice = html.slice(searchPos, searchPos + 220);
            const keyMatch = headSlice.match(/key\s*:\s*['"]([^'"]+)['"]/);
            const dataMatch = headSlice.match(/data\s*:\s*/);
            if (!keyMatch || !dataMatch) continue;

            const dsKey = keyMatch[1];
            const dataStart = searchPos + dataMatch.index + dataMatch[0].length;
            const firstChar = html[dataStart];
            if (firstChar !== '[' && firstChar !== '{') continue;

            let depth = 0;
            let inStr = false;
            let escape = false;
            let endPos = -1;
            const maxScan = Math.min(html.length, dataStart + 300000);

            for (let i = dataStart; i < maxScan; i++) {
                const ch = html[i];
                if (escape) {
                    escape = false;
                    continue;
                }
                if (inStr) {
                    if (ch === '\\') escape = true;
                    else if (ch === '"') inStr = false;
                    continue;
                }
                if (ch === '"') {
                    inStr = true;
                } else if (ch === '[' || ch === '{') {
                    depth++;
                } else if (ch === ']' || ch === '}') {
                    depth--;
                    if (depth === 0) {
                        endPos = i + 1;
                        break;
                    }
                }
            }

            if (endPos !== -1) {
                try {
                    blocks[dsKey] = JSON.parse(html.slice(dataStart, endPos));
                } catch (_) {}
                searchPos = endPos;
            }
        }
        return blocks;
    }

    function unwrapBatchExecutePayloads(rawText) {
        const results = [];
        if (!rawText || typeof rawText !== 'string') return results;
        const lines = rawText.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('[[')) continue;
            try {
                const outer = JSON.parse(line);
                if (!Array.isArray(outer)) continue;
                for (const item of outer) {
                    if (Array.isArray(item) && item[0] === 'wrb.fr' && typeof item[2] === 'string') {
                        results.push({ rpcId: item[1], data: JSON.parse(item[2]) });
                    }
                }
            } catch (_) {}
        }
        return results;
    }

    function getByPath(root, pathArr) {
        let cur = root;
        for (let i = 0; i < pathArr.length; i++) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[pathArr[i]];
        }
        return cur;
    }

    function findCalibrationPaths(jsonTree, domMetrics) {
        const curPct = domMetrics.current && domMetrics.current.pct;
        const weekPct = domMetrics.weekly && domMetrics.weekly.pct;
        const curResetAt = domMetrics.current && domMetrics.current.resetAt;
        const weekResetAt = domMetrics.weekly && domMetrics.weekly.resetAt;

        if (!curPct && !weekPct) return null;

        let curPctPath = null, curPctScale = 1;
        let weekPctPath = null, weekPctScale = 1;
        let curResetPath = null, curResetUnit = 1;
        let weekResetPath = null, weekResetUnit = 1;

        const targetCurSec = curResetAt ? Math.floor(curResetAt / 1000) : null;
        const targetWeekSec = weekResetAt ? Math.floor(weekResetAt / 1000) : null;

        let visited = 0;
        function walk(node, path) {
            if (visited > 5000 || node === null || node === undefined) return;
            visited++;

            if (typeof node === 'number') {
                if (curPct > 0 && !curPctPath) {
                    if (Math.abs(node - curPct) < 0.05) {
                        curPctPath = path;
                        curPctScale = 1;
                    } else if (node > 0 && node <= 1 && Math.abs(node * 100 - curPct) < 0.1) {
                        curPctPath = path;
                        curPctScale = 100;
                    }
                } else if (weekPct > 0 && !weekPctPath) {
                    const isSamePath = curPctPath && path.join('.') === curPctPath.join('.');
                    if (!isSamePath) {
                        if (Math.abs(node - weekPct) < 0.05) {
                            weekPctPath = path;
                            weekPctScale = 1;
                        } else if (node > 0 && node <= 1 && Math.abs(node * 100 - weekPct) < 0.1) {
                            weekPctPath = path;
                            weekPctScale = 100;
                        }
                    }
                }

                if (targetCurSec && !curResetPath) {
                    if (Math.abs(node - targetCurSec) <= 120) {
                        curResetPath = path;
                        curResetUnit = 1000;
                    } else if (Math.abs(node - curResetAt) <= 120000) {
                        curResetPath = path;
                        curResetUnit = 1;
                    }
                }
                if (targetWeekSec && !weekResetPath) {
                    if (Math.abs(node - targetWeekSec) <= 120) {
                        weekResetPath = path;
                        weekResetUnit = 1000;
                    } else if (Math.abs(node - weekResetAt) <= 120000) {
                        weekResetPath = path;
                        weekResetUnit = 1;
                    }
                }
                return;
            }

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) walk(node[i], path.concat(i));
            } else if (typeof node === 'object') {
                const keys = Object.keys(node);
                for (let i = 0; i < keys.length; i++) walk(node[keys[i]], path.concat(keys[i]));
            }
        }

        walk(jsonTree, []);
        if (curPctPath && weekPctPath && curResetPath) {
            return {
                curPctPath, curPctScale,
                weekPctPath, weekPctScale,
                curResetPath, curResetUnit,
                weekResetPath, weekResetUnit
            };
        }
        return null;
    }

    function buildMetricsFromCalibratedTree(tree, coords, ctx, sourceLabel, badgeStr) {
        if (!tree || !coords) return null;
        const rawCurPct = getByPath(tree, coords.curPctPath);
        const rawWeekPct = getByPath(tree, coords.weekPctPath);
        const rawCurReset = getByPath(tree, coords.curResetPath);
        const rawWeekReset = coords.weekResetPath ? getByPath(tree, coords.weekResetPath) : null;

        if (typeof rawCurPct !== 'number' || typeof rawWeekPct !== 'number') return null;
        const curPct = Math.round(rawCurPct * (coords.curPctScale || 1) * 10) / 10;
        const weekPct = Math.round(rawWeekPct * (coords.weekPctScale || 1) * 10) / 10;
        if (curPct < 0 || curPct > 100 || weekPct < 0 || weekPct > 100) return null;

        const curResetAt = typeof rawCurReset === 'number' ? rawCurReset * (coords.curResetUnit || 1) : null;
        const weekResetAt = typeof rawWeekReset === 'number' ? rawWeekReset * (coords.weekResetUnit || 1) : null;
        if (curResetAt && curResetAt < Date.now() - 86400000 * 7) return null;

        const curClock = formatEpochToRawClock(curResetAt);
        const weekClock = formatEpochToRawClock(weekResetAt);

        return {
            accountId: ctx.accountId,
            slotIndex: ctx.slotIndex,
            slotTag: ctx.slotTag,
            email: ctx.email,
            displayLabel: ctx.displayLabel,
            usageUrl: ctx.usageUrl,
            appUrl: ctx.appUrl,
            current: {
                pct: curPct,
                resetText: curClock ? `重置时间：${curClock}` : '重置时间：--',
                rawClock: curClock,
                resetAt: curResetAt
            },
            weekly: {
                pct: weekPct,
                resetText: weekClock ? `重置时间：${weekClock}` : '重置时间：--',
                rawClock: weekClock,
                resetAt: weekResetAt
            },
            updatedStr: sourceLabel,
            badgeStr: badgeStr || 'PRO',
            timestamp: Date.now()
        };
    }

    function tryExtractFromAfInitData(html, ctx) {
        let ssrProfile = null;
        try {
            const raw = (typeof GM_getValue === 'function' && GM_getValue(SSR_PROFILE_KEY)) || localStorage.getItem(SSR_PROFILE_KEY);
            if (raw) ssrProfile = JSON.parse(raw);
        } catch (_) {}
        if (!ssrProfile || !ssrProfile.dsKey || !ssrProfile.coords) return null;
        if (ctx.bl && ssrProfile.bl && ctx.bl !== ssrProfile.bl) return null;

        const blocks = parseAfInitDataBlocks(html);
        const targetTree = blocks[ssrProfile.dsKey];
        if (!targetTree) return null;

        return buildMetricsFromCalibratedTree(targetTree, ssrProfile.coords, ctx, 'SSR直出', ssrProfile.badgeStr);
    }

    function calibrateAfInitDataFromHtml(html, domMetrics, blVersion) {
        if (!html || !domMetrics) return;
        const blocks = parseAfInitDataBlocks(html);
        for (const [dsKey, tree] of Object.entries(blocks)) {
            const coords = findCalibrationPaths(tree, domMetrics);
            if (coords) {
                const profile = {
                    bl: blVersion || '',
                    dsKey,
                    coords,
                    badgeStr: domMetrics.badgeStr || 'PRO',
                    calibratedAt: Date.now()
                };
                const serialized = JSON.stringify(profile);
                try { if (typeof GM_setValue === 'function') GM_setValue(SSR_PROFILE_KEY, serialized); } catch (_) {}
                try { localStorage.setItem(SSR_PROFILE_KEY, serialized); } catch (_) {}
                return;
            }
        }
    }

    function parseMetricsFromRawHtml(html, ctx) {
        if (!html) return null;
        const ssrData = tryExtractFromAfInitData(html, ctx);
        if (ssrData) return ssrData;

        if (!html.includes('current-usage') && !html.includes('weekly-usage')) return null;
        const nowMs = Date.now();

        const extractChunk = (testId, otherTestId) => {
            const idx = html.indexOf(`data-testid="${testId}"`);
            if (idx === -1) return { pct: null, resetText: '重置时间：--', rawClock: '', resetAt: null };

            const otherIdx = otherTestId ? html.indexOf(`data-testid="${otherTestId}"`, idx + 10) : -1;
            const endIdx = otherIdx !== -1 ? Math.min(idx + 8000, otherIdx) : idx + 8000;
            const slice = html.slice(idx, endIdx);
            const plain = slice.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

            let pct = null;
            const pctMatch =
                plain.match(/已使用\s*(\d+(?:\.\d+)?)\s*%/) ||
                slice.match(/--x-width:\s*(\d+(?:\.\d+)?)%/) ||
                plain.match(/(\d+(?:\.\d+)?)\s*%/);
            if (pctMatch) pct = parseFloat(pctMatch[1]);

            let resetText = '重置时间：--';
            let rawClock = '';
            const resetMatch = plain.match(
                /(重置时间\s*[：:]\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*日\s*\d{1,2}:\d{2}|(?:明天|明日|今天|今日|tomorrow|today)?\s*\d{1,2}:\d{2}|\S+))/i
            );
            if (resetMatch) {
                resetText = resetMatch[1].trim();
                const tp = resetText.match(/[：:]\s*(.+)$/);
                if (tp) rawClock = tp[1].trim();
            }
            const resetAt = parseResetToEpoch(resetText, nowMs);
            return { pct, resetText, rawClock, resetAt };
        };

        const current = extractChunk('current-usage', 'weekly-usage');
        const weekly = extractChunk('weekly-usage', 'current-usage');
        if (current.pct === null && weekly.pct === null) return null;

        return {
            accountId: ctx.accountId,
            slotIndex: ctx.slotIndex,
            slotTag: ctx.slotTag,
            email: ctx.email,
            displayLabel: ctx.displayLabel,
            usageUrl: ctx.usageUrl,
            appUrl: ctx.appUrl,
            current,
            weekly,
            updatedStr: 'HTML直出',
            badgeStr: 'PRO',
            timestamp: nowMs
        };
    }

    function publishUsageData(payload) {
        if (!payload || !payload.accountId) return;
        upsertRegistryEntry(payload);
        const storageKey = `${STORAGE_PREFIX}${payload.accountId}`;
        const serialized = JSON.stringify(payload);
        try { if (typeof GM_setValue === 'function') GM_setValue(storageKey, serialized); } catch (_) {}
        try { localStorage.setItem(storageKey, serialized); } catch (_) {}
        if (bc) {
            try { bc.postMessage({ type: 'GEMINI_HUD_DATA', payload }); } catch (_) {}
        }
        if (window.parent && window.parent !== window) {
            try { window.parent.postMessage({ type: 'GEMINI_HUD_DATA', payload }, window.location.origin); } catch (_) {}
        }
    }

    // =========================================================================
    // 模式 A：/usage 子页面 Worker 模式（捕获 RPC + 校准 SSR）
    // =========================================================================
    if (isUsagePage) {
        const params = new URLSearchParams(window.location.search);
        const workerMode = params.get('hud_worker');
        const pageCtx = resolveAccountContext(document, pageWin);
        const explicitAcc = params.get('hud_acc');
        const explicitSlot = params.get('hud_slot');
        if (explicitAcc) pageCtx.accountId = explicitAcc;
        if (explicitSlot && /^\d+$/.test(explicitSlot)) {
            pageCtx.slotIndex = parseInt(explicitSlot, 10);
            pageCtx.slotTag = `u${pageCtx.slotIndex}`;
        }

        const capturedRpcs = [];
        try {
            if (pageWin.XMLHttpRequest && !pageWin.XMLHttpRequest.__hudUsageRpcHooked) {
                const origOpen = pageWin.XMLHttpRequest.prototype.open;
                const origSend = pageWin.XMLHttpRequest.prototype.send;
                pageWin.XMLHttpRequest.prototype.open = function (method, url) {
                    this.__hudUrl = typeof url === 'string' ? url : '';
                    return origOpen.apply(this, arguments);
                };
                pageWin.XMLHttpRequest.prototype.send = function (body) {
                    if (this.__hudUrl && this.__hudUrl.includes('batchexecute') && typeof body === 'string') {
                        const reqUrl = this.__hudUrl;
                        const reqBody = body;
                        this.addEventListener('load', () => {
                            try {
                                capturedRpcs.push({ url: reqUrl, body: reqBody, response: this.responseText });
                            } catch (_) {}
                        });
                    }
                    return origSend.apply(this, arguments);
                };
                pageWin.XMLHttpRequest.__hudUsageRpcHooked = true;
            }
        } catch (_) {}

        if (workerMode === 'tab') document.title = `↻ 同步用量 (${pageCtx.displayLabel})...`;

        let completed = false;
        let obs = null;
        let timer = null;

        const cleanupWorker = () => {
            if (timer) { clearInterval(timer); timer = null; }
            if (obs) { obs.disconnect(); obs = null; }
        };

        const tryExtractAndFinish = () => {
            if (completed) return;
            const data = extractMetricsFromDoc(document, pageCtx);
            if (data) {
                completed = true;
                cleanupWorker();
                try {
                    calibrateAfInitDataFromHtml(document.documentElement.innerHTML, data, pageCtx.bl);
                } catch (_) {}
                publishUsageData(data);
                if (window.parent && window.parent !== window && capturedRpcs.length > 0) {
                    try {
                        window.parent.postMessage({
                            type: 'GEMINI_HUD_RPC_CAPTURE',
                            accountId: data.accountId,
                            bl: pageCtx.bl,
                            rpcs: capturedRpcs,
                            domMetrics: data
                        }, window.location.origin);
                    } catch (_) {}
                }
                if (workerMode === 'tab') setTimeout(() => window.close(), 120);
            }
        };

        obs = new MutationObserver(tryExtractAndFinish);
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        timer = setInterval(tryExtractAndFinish, 150);
        tryExtractAndFinish();

        setTimeout(() => {
            cleanupWorker();
            if (workerMode === 'tab' && !completed) window.close();
        }, 9500);

        return;
    }

    // =========================================================================
    // 模式 B：Gemini 聊天主页面（全量多账号并发同步引擎 + 同屏对比列表）
    // =========================================================================
    if (window.self !== window.top) return;

    let currentCtx = resolveAccountContext(document, pageWin);

    const defaultConfig = {
        intervalSec: 300,
        refreshOnSend: true,
        warnThreshold: 70,
        dangerThreshold: 90
    };

    let config = Object.assign({}, defaultConfig, JSON.parse(localStorage.getItem(CFG_STORAGE_KEY) || '{}'));
    function saveConfig() {
        localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(config));
    }

    function getSeverityLevel(pct) {
        if (pct === null || pct === undefined || isNaN(pct)) return 'normal';
        if (pct >= config.dangerThreshold) return 'danger';
        if (pct >= config.warnThreshold) return 'warn';
        return 'normal';
    }

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'style' && typeof v === 'object') {
                Object.assign(node.style, v);
            } else if (k.startsWith('on') && typeof v === 'function') {
                node.addEventListener(k.slice(2).toLowerCase(), v);
            } else if (k === 'text') {
                node.textContent = v;
            } else {
                node.setAttribute(k, v);
            }
        }
        for (const child of children) {
            if (child) node.appendChild(child);
        }
        return node;
    }

    // -------------------------------------------------------------------------
    // 宿主 1：极简微缩胶囊 (pillHost)
    // -------------------------------------------------------------------------
    const pillHost = el('div', {
        id: 'gemini-usage-pill-host',
        style: {
            display: 'inline-flex',
            alignItems: 'center',
            marginLeft: '4px',
            verticalAlign: 'middle'
        }
    });
    const pillShadow = pillHost.attachShadow({ mode: 'open' });

    const pillStyle = el('style', {
        text: `
            :host {
                font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
                font-size: 11.5px;
                user-select: none;
            }
            .usage-pill {
                position: relative;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                height: 28px;
                padding: 0 9px;
                border-radius: 14px;
                background: rgba(168, 199, 250, 0.06);
                border: 1px solid rgba(168, 199, 250, 0.18);
                color: #c4c7c5;
                cursor: pointer;
                transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
                white-space: nowrap;
                overflow: hidden;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill {
                    background: rgba(11, 87, 208, 0.04);
                    border-color: rgba(11, 87, 208, 0.16);
                    color: #444746;
                }
            }
            .usage-pill:hover {
                background: rgba(168, 199, 250, 0.14);
                border-color: rgba(168, 199, 250, 0.38);
                color: #e3e3e3;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill:hover { color: #1f1f1f; }
            }

            .usage-pill.level-warn {
                background: rgba(251, 188, 4, 0.11);
                border-color: rgba(252, 201, 52, 0.45);
                color: #fde293;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill.level-warn {
                    background: rgba(251, 188, 4, 0.12);
                    border-color: rgba(227, 116, 0, 0.45);
                    color: #b06000;
                }
            }

            .usage-pill.level-danger {
                background: rgba(234, 67, 53, 0.15);
                border-color: rgba(242, 139, 130, 0.7);
                color: #f28b82;
                animation: softPulse 2s infinite ease-in-out;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill.level-danger {
                    background: rgba(234, 67, 53, 0.12);
                    border-color: rgba(197, 34, 31, 0.65);
                    color: #c5221f;
                }
            }
            @keyframes softPulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(242, 139, 130, 0); }
                50% { box-shadow: 0 0 8px 1px rgba(242, 139, 130, 0.35); }
            }

            .sync-dot {
                display: none;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #a8c7fa;
                flex-shrink: 0;
            }
            .sync-dot.loading {
                display: inline-block;
                animation: blink 0.8s infinite ease-in-out;
            }
            @keyframes blink {
                0%, 100% { opacity: 0.25; transform: scale(0.8); }
                50% { opacity: 1; transform: scale(1.15); }
            }

            .metric-group {
                display: inline-flex;
                align-items: baseline;
                gap: 3px;
            }
            .metric-label {
                opacity: 0.65;
                font-size: 10.5px;
            }
            .metric-val {
                font-weight: 600;
                font-variant-numeric: tabular-nums;
                color: #e3e3e3;
                transition: color 0.2s ease;
            }
            @media (prefers-color-scheme: light) {
                .metric-val { color: #1f1f1f; }
            }
            .metric-val.level-warn { color: #fcc934; }
            .metric-val.level-danger { color: #ff6b6b; font-weight: 700; }
            @media (prefers-color-scheme: light) {
                .metric-val.level-warn { color: #c26401; }
                .metric-val.level-danger { color: #c5221f; }
            }

            .countdown-inline {
                opacity: 0.68;
                font-size: 10.5px;
                font-variant-numeric: tabular-nums;
                margin-left: 1px;
            }
            .sep {
                opacity: 0.3;
                font-size: 10px;
                margin: 0 1px;
            }

            .bottom-progress {
                position: absolute;
                left: 0;
                bottom: 0;
                height: 2px;
                background: #6dd58c;
                opacity: 0.75;
                transition: width 0.3s ease, background 0.25s ease;
                pointer-events: none;
            }
            .bottom-progress.level-warn { background: #fcc934; opacity: 0.9; }
            .bottom-progress.level-danger { background: #ff5252; opacity: 1; }
        `
    });

    const syncDot = el('span', { class: 'sync-dot loading' });
    const curValText = el('span', { class: 'metric-val', text: '--%' });
    const curCountdownText = el('span', { class: 'countdown-inline', text: '' });
    const weekValText = el('span', { class: 'metric-val', text: '--%' });
    const bottomProgress = el('div', { class: 'bottom-progress', style: { width: '0%' } });

    const pill = el('div', {
        class: 'usage-pill',
        title: '左键：展开面板 | Alt+左键：刷新当前号 | Ctrl/Cmd+Alt+左键：全量同步所有账号'
    }, [
        syncDot,
        el('div', { class: 'metric-group' }, [
            el('span', { class: 'metric-label', text: '5h' }),
            curValText,
            curCountdownText
        ]),
        el('span', { class: 'sep', text: '·' }),
        el('div', { class: 'metric-group' }, [
            el('span', { class: 'metric-label', text: '周' }),
            weekValText
        ]),
        bottomProgress
    ]);

    pillShadow.appendChild(pillStyle);
    pillShadow.appendChild(pill);

    // -------------------------------------------------------------------------
    // 宿主 2：直接挂载于 document.body 顶层的弹窗宿主（含全量同步与多账号列表）
    // -------------------------------------------------------------------------
    const popoverHost = el('div', {
        id: 'gemini-usage-popover-portal',
        style: {
            position: 'fixed',
            left: '0px',
            top: '0px',
            width: '0px',
            height: '0px',
            overflow: 'visible',
            zIndex: '2147483647',
            pointerEvents: 'none'
        }
    });
    document.body.appendChild(popoverHost);
    const popoverShadow = popoverHost.attachShadow({ mode: 'open' });

    const popoverStyle = el('style', {
        text: `
            :host {
                font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
                font-size: 12px;
                user-select: none;
            }
            .popover {
                position: fixed;
                z-index: 2147483647;
                width: 348px;
                background: #1e1f20;
                color: #e3e3e3;
                border: 1px solid #444746;
                border-radius: 14px;
                box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65);
                padding: 13px;
                display: none;
                flex-direction: column;
                gap: 9px;
                pointer-events: auto;
                box-sizing: border-box;
            }
            .popover.open {
                display: flex;
                animation: popFadeIn 0.15s cubic-bezier(0.2, 0, 0, 1);
            }
            @keyframes popFadeIn {
                from { opacity: 0; transform: translateY(5px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .pop-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #333537;
                padding-bottom: 8px;
            }
            .pop-title {
                display: flex;
                align-items: center;
                gap: 5px;
                font-weight: 600;
                font-size: 12.5px;
                overflow: hidden;
            }
            .badge {
                background: #a8c7fa;
                color: #062e6f;
                font-size: 10px;
                font-weight: 700;
                padding: 1px 5px;
                border-radius: 5px;
                flex-shrink: 0;
            }
            .acc-tag {
                background: #333537;
                color: #c4c7c5;
                font-size: 10px;
                font-weight: 500;
                padding: 1px 5px;
                border-radius: 5px;
                max-width: 125px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .header-actions {
                display: flex;
                align-items: center;
                gap: 7px;
                flex-shrink: 0;
            }
            .refresh-btn, .mini-btn, .sync-all-btn {
                background: #282a2c;
                color: #e3e3e3;
                border: 1px solid #444746;
                border-radius: 6px;
                padding: 2px 7px;
                font-size: 11px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .refresh-btn:hover, .mini-btn:hover { background: #37393b; }
            .mini-btn {
                padding: 1px 6px;
                font-size: 10px;
                color: #9aa0a6;
            }
            .sync-all-btn {
                padding: 1px 7px;
                font-size: 10px;
                color: #a8c7fa;
                background: rgba(168, 199, 250, 0.1);
                border-color: rgba(168, 199, 250, 0.35);
                font-weight: 500;
            }
            .sync-all-btn:hover {
                background: rgba(168, 199, 250, 0.2);
                border-color: rgba(168, 199, 250, 0.55);
            }
            .sync-all-btn.busy {
                opacity: 0.65;
                pointer-events: none;
            }
            .pop-link {
                color: #a8c7fa;
                text-decoration: none;
                font-size: 11px;
            }
            .pop-link:hover { text-decoration: underline; }

            .quota-box {
                background: #282a2c;
                border-radius: 8px;
                padding: 8px 11px;
                display: flex;
                flex-direction: column;
                gap: 5px;
                border-left: 3px solid #6dd58c;
                transition: border-color 0.25s ease;
            }
            .quota-box.level-warn { border-left-color: #fcc934; }
            .quota-box.level-danger { border-left-color: #ff5252; background: rgba(234, 67, 53, 0.08); }

            .quota-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
            }
            .quota-pct {
                font-weight: 600;
                color: #6dd58c;
            }
            .quota-pct.level-warn { color: #fcc934; }
            .quota-pct.level-danger { color: #ff6b6b; }

            .bar-track {
                height: 5px;
                background: #3c4043;
                border-radius: 3px;
                overflow: hidden;
            }
            .bar-fill {
                height: 100%;
                background: linear-gradient(90deg, #a8c7fa, #6dd58c);
                transition: width 0.3s ease, background 0.25s ease;
            }
            .bar-fill.level-warn { background: linear-gradient(90deg, #fde293, #fbbc04); }
            .bar-fill.level-danger { background: linear-gradient(90deg, #f28b82, #ea4335); }

            .quota-reset {
                font-size: 11px;
                color: #c4c7c5;
                font-variant-numeric: tabular-nums;
            }

            .multi-acc-section {
                background: #232426;
                border: 1px solid #333537;
                border-radius: 8px;
                padding: 7px 9px;
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            .multi-acc-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 11px;
                color: #9aa0a6;
                padding-bottom: 4px;
                border-bottom: 1px dashed #333537;
            }
            .multi-acc-actions {
                display: flex;
                align-items: center;
                gap: 5px;
            }
            .multi-acc-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
                max-height: 132px;
                overflow-y: auto;
            }
            .multi-acc-list::-webkit-scrollbar { width: 4px; }
            .multi-acc-list::-webkit-scrollbar-thumb { background: #444746; border-radius: 2px; }

            .acc-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 6px;
                border-radius: 6px;
                background: #1e1f20;
                border: 1px solid transparent;
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
                font-size: 11px;
                font-variant-numeric: tabular-nums;
            }
            .acc-row:hover {
                background: #2c2e30;
                border-color: #444746;
            }
            .acc-row.current {
                background: rgba(168, 199, 250, 0.08);
                border-color: rgba(168, 199, 250, 0.3);
            }
            .acc-row-left {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                flex: 1;
            }
            .acc-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #5e5e5e;
                flex-shrink: 0;
            }
            .acc-row.current .acc-dot {
                background: #6dd58c;
                box-shadow: 0 0 5px rgba(109, 213, 140, 0.7);
            }
            .acc-name {
                color: #e3e3e3;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 126px;
            }
            .acc-row-right {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-shrink: 0;
            }
            .acc-metric {
                display: inline-flex;
                align-items: baseline;
                gap: 2px;
            }
            .acc-k { color: #8e918f; font-size: 10px; }
            .acc-v { font-weight: 600; color: #6dd58c; }
            .acc-v.level-warn { color: #fcc934; }
            .acc-v.level-danger { color: #ff6b6b; }
            .acc-cd { color: #9aa0a6; font-size: 10px; margin-left: 1px; }

            .settings-box {
                background: #232426;
                border-radius: 8px;
                padding: 6px 10px;
                display: flex;
                flex-direction: column;
                gap: 5px;
                font-size: 11px;
                color: #c4c7c5;
            }
            .settings-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .num-input {
                width: 42px;
                background: #1e1f20;
                color: #e3e3e3;
                border: 1px solid #5e5e5e;
                border-radius: 4px;
                padding: 2px 4px;
                font-size: 11px;
                text-align: center;
            }
            .pop-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-top: 1px solid #333537;
                padding-top: 7px;
                font-size: 11px;
                color: #9aa0a6;
            }
            .ctrl-row {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            select, input[type="checkbox"] {
                background: #282a2c;
                color: #e3e3e3;
                border: 1px solid #5e5e5e;
                border-radius: 4px;
                font-size: 11px;
                padding: 2px 4px;
                cursor: pointer;
            }
            .version-tag {
                opacity: 0.5;
                font-size: 10px;
                margin-left: 4px;
                font-family: monospace;
            }
        `
    });

    const planBadge = el('span', { class: 'badge', text: 'PRO' });
    const accountBadge = el('span', {
        class: 'acc-tag',
        title: currentCtx.email || currentCtx.accountId,
        text: currentCtx.displayLabel
    });
    const popRefreshBtn = el('button', {
        class: 'refresh-btn',
        title: '左键：刷新当前账号 | Shift + 左键：强制后台标签页刷新',
        text: '↻ 当前',
        onClick: (e) => triggerUsageSync(!!e.shiftKey)
    });
    const openUsageLink = el('a', {
        class: 'pop-link',
        href: currentCtx.usageUrl,
        target: '_blank',
        text: '原生页 ↗'
    });

    const curQuotaBox = el('div', { class: 'quota-box' });
    const popCurPct = el('span', { class: 'quota-pct', text: '已使用 --%' });
    const popCurBar = el('div', { class: 'bar-fill', style: { width: '0%' } });
    const popCurReset = el('div', { class: 'quota-reset', text: '正在计算倒计时...' });
    curQuotaBox.append(
        el('div', { class: 'quota-row' }, [el('strong', { text: '当前用量 (5h 周期)' }), popCurPct]),
        el('div', { class: 'bar-track' }, [popCurBar]),
        popCurReset
    );

    const weekQuotaBox = el('div', { class: 'quota-box' });
    const popWeekPct = el('span', { class: 'quota-pct', text: '已使用 --%' });
    const popWeekBar = el('div', { class: 'bar-fill', style: { width: '0%' } });
    const popWeekReset = el('div', { class: 'quota-reset', text: '正在计算倒计时...' });
    weekQuotaBox.append(
        el('div', { class: 'quota-row' }, [el('strong', { text: '每周限额' }), popWeekPct]),
        el('div', { class: 'bar-track' }, [popWeekBar]),
        popWeekReset
    );

    // 多账号配额总览头部：新增『↻ 全量同步』按钮
    const multiAccTitleSpan = el('span', { text: '多账号配额总览 (1)' });
    const syncAllAccountsBtn = el('button', {
        class: 'sync-all-btn',
        title: '无需切换页面，并发探测并同步所有已登录 Google 账号 (u0~u4) 的最新配额',
        text: '↻ 全量同步',
        onClick: (e) => {
            e.stopPropagation();
            triggerAllAccountsSync();
        }
    });
    const clearOtherAccBtn = el('button', {
        class: 'mini-btn',
        title: '仅保留当前账号，清理其他历史账号缓存记录',
        text: '清理其他',
        onClick: (e) => {
            e.stopPropagation();
            const reg = readAccountRegistry();
            const keep = {};
            if (reg[currentCtx.accountId]) {
                keep[currentCtx.accountId] = reg[currentCtx.accountId];
            }
            writeAccountRegistry(keep);
            renderMultiAccountList();
        }
    });
    const multiAccListEl = el('div', { class: 'multi-acc-list' });
    const multiAccSection = el('div', { class: 'multi-acc-section' }, [
        el('div', { class: 'multi-acc-header' }, [
            multiAccTitleSpan,
            el('div', { class: 'multi-acc-actions' }, [syncAllAccountsBtn, clearOtherAccBtn])
        ]),
        multiAccListEl
    ]);

    const warnInput = el('input', {
        type: 'number',
        class: 'num-input',
        min: '10',
        max: '95',
        value: String(config.warnThreshold),
        onChange: (e) => {
            config.warnThreshold = Math.max(5, Math.min(95, parseInt(e.target.value, 10) || 70));
            saveConfig();
            if (lastMetricsData) renderMetricsToUI(lastMetricsData);
        }
    });

    const dangerInput = el('input', {
        type: 'number',
        class: 'num-input',
        min: '20',
        max: '99',
        value: String(config.dangerThreshold),
        onChange: (e) => {
            config.dangerThreshold = Math.max(10, Math.min(99, parseInt(e.target.value, 10) || 90));
            saveConfig();
            if (lastMetricsData) renderMetricsToUI(lastMetricsData);
        }
    });

    const settingsBox = el('div', { class: 'settings-box' }, [
        el('div', { class: 'settings-row' }, [
            el('span', { text: '动态变色阈值 (%)' }),
            el('div', { class: 'ctrl-row' }, [
                el('span', { style: { color: '#fcc934' }, text: '预警≥' }),
                warnInput,
                el('span', { style: { color: '#ff6b6b' }, text: '高危≥' }),
                dangerInput
            ])
        ])
    ]);

    const popUpdatedText = el('span', { text: '等待同步...' });

    const intervalSelect = el('select', {
        title: '定时刷新频率',
        onChange: (e) => {
            config.intervalSec = parseInt(e.target.value, 10);
            saveConfig();
            setupAutoRefresh();
        }
    }, [
        el('option', { value: '0', text: '定时: 关' }),
        el('option', { value: '60', text: '1m' }),
        el('option', { value: '300', text: '5m' }),
        el('option', { value: '900', text: '15m' })
    ]);
    intervalSelect.value = String(config.intervalSec);

    const sendTriggerChk = el('input', {
        type: 'checkbox',
        onChange: (e) => {
            config.refreshOnSend = e.target.checked;
            saveConfig();
        }
    });
    sendTriggerChk.checked = !!config.refreshOnSend;

    const popover = el('div', { class: 'popover' }, [
        el('div', { class: 'pop-header' }, [
            el('div', { class: 'pop-title' }, [el('span', { text: '用量监控' }), planBadge, accountBadge]),
            el('div', { class: 'header-actions' }, [popRefreshBtn, openUsageLink])
        ]),
        curQuotaBox,
        weekQuotaBox,
        multiAccSection,
        settingsBox,
        el('div', { class: 'pop-footer' }, [
            popUpdatedText,
            el('div', { class: 'ctrl-row' }, [
                el('label', { style: { display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' } }, [
                    sendTriggerChk,
                    el('span', { text: '提问刷新' })
                ]),
                intervalSelect
            ])
        ])
    ]);

    popoverShadow.appendChild(popoverStyle);
    popoverShadow.appendChild(popover);

    function updatePopoverPosition() {
        const rect = pill.getBoundingClientRect();
        const cardWidth = 348;
        const left = Math.max(12, Math.min(window.innerWidth - cardWidth - 12, rect.left));
        popover.style.left = `${left}px`;

        if (rect.top > 340) {
            popover.style.bottom = `${window.innerHeight - rect.top + 10}px`;
            popover.style.top = 'auto';
        } else {
            popover.style.top = `${rect.bottom + 10}px`;
            popover.style.bottom = 'auto';
        }
    }

    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.altKey && (e.ctrlKey || e.metaKey)) {
            triggerAllAccountsSync();
            return;
        }
        if (e.altKey) {
            triggerUsageSync(!!e.shiftKey);
            return;
        }
        const isOpen = popover.classList.toggle('open');
        if (isOpen) {
            renderMultiAccountList();
            updatePopoverPosition();
            scheduleNextTick(true);
        }
    });

    window.addEventListener('resize', () => {
        if (popover.classList.contains('open')) updatePopoverPosition();
    });

    document.addEventListener('click', (e) => {
        if (!popover.classList.contains('open')) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(pillHost) && !path.includes(popoverHost)) {
            popover.classList.remove('open');
        }
    });

    // =========================================================================
    // 4. 多账号同屏列表渲染与自适应省电倒计时
    // =========================================================================
    let lastMetricsData = null;
    let lastAutoResetSyncAt = 0;
    let countdownTimerId = null;

    function getLevelTag(level) {
        if (level === 'danger') return ' [额度告急]';
        if (level === 'warn') return ' [接近限额]';
        return '';
    }

    function renderMultiAccountList() {
        const reg = readAccountRegistry();
        const entries = Object.values(reg).sort((a, b) => {
            if (a.accountId === currentCtx.accountId) return -1;
            if (b.accountId === currentCtx.accountId) return 1;
            return (a.slotIndex ?? 99) - (b.slotIndex ?? 99);
        });

        multiAccTitleSpan.textContent = `多账号配额总览 (${entries.length})`;
        multiAccListEl.replaceChildren();

        if (entries.length === 0) {
            multiAccListEl.appendChild(
                el('div', { style: { color: '#8e918f', fontSize: '11px', padding: '2px 4px' }, text: '点击右上角「↻ 全量同步」自动探测所有账号' })
            );
            return;
        }

        for (const item of entries) {
            const isCur = item.accountId === currentCtx.accountId;
            const cPct = item.current ? item.current.pct : null;
            const wPct = item.weekly ? item.weekly.pct : null;
            const cLevel = getSeverityLevel(cPct);
            const wLevel = getSeverityLevel(wPct);

            const cResetAt = item.current ? item.current.resetAt : null;
            const cdStr = formatUltraCompactCountdown(cResetAt);

            const cdSpan = el('span', {
                class: 'acc-cd',
                'data-reset-at': cResetAt ? String(cResetAt) : '',
                text: cdStr ? `(${cdStr})` : ''
            });

            const row = el('div', {
                class: `acc-row${isCur ? ' current' : ''}`,
                title: isCur
                    ? `${item.email || item.accountId} (当前账号，点击立即刷新)`
                    : `${item.email || item.accountId} (左键打开该账号对话页 | Alt+左键打开用量页)`,
                onClick: (e) => {
                    e.stopPropagation();
                    if (isCur) {
                        triggerUsageSync(!!e.shiftKey);
                    } else {
                        const dest = e.altKey ? (item.usageUrl || '/usage') : (item.appUrl || '/app');
                        window.open(dest, '_blank');
                    }
                }
            }, [
                el('div', { class: 'acc-row-left' }, [
                    el('span', { class: 'acc-dot' }),
                    el('span', { class: 'acc-name', text: item.displayLabel || item.accountId })
                ]),
                el('div', { class: 'acc-row-right' }, [
                    el('span', { class: 'acc-metric' }, [
                        el('span', { class: 'acc-k', text: '5h' }),
                        el('span', { class: `acc-v level-${cLevel}`, text: cPct !== null ? `${cPct}%` : '--%' }),
                        cdSpan
                    ]),
                    el('span', { class: 'acc-metric' }, [
                        el('span', { class: 'acc-k', text: '周' }),
                        el('span', { class: `acc-v level-${wLevel}`, text: wPct !== null ? `${wPct}%` : '--%' })
                    ])
                ])
            ]);

            multiAccListEl.appendChild(row);
        }
    }

    function resetUIForAccountSwitch() {
        lastMetricsData = null;
        curValText.textContent = '--%';
        curValText.className = 'metric-val';
        curCountdownText.textContent = '';
        weekValText.textContent = '--%';
        weekValText.className = 'metric-val';
        bottomProgress.style.width = '0%';
        bottomProgress.className = 'bottom-progress';
        pill.className = 'usage-pill';
        accountBadge.textContent = currentCtx.displayLabel;
        accountBadge.title = currentCtx.email || currentCtx.accountId;
        openUsageLink.href = currentCtx.usageUrl;
        popUpdatedText.textContent = `切换至 ${currentCtx.displayLabel}，同步中...`;
        renderMultiAccountList();
    }

    function renderMetricsToUI(data) {
        if (!data || !data.current || !data.weekly) return;

        refreshAccountContextIfNeeded();
        upsertRegistryEntry(data);
        if (popover.classList.contains('open')) {
            renderMultiAccountList();
        }

        if (data.accountId && data.accountId !== currentCtx.accountId) return;

        const refTs = data.timestamp || Date.now();
        if (!data.current.resetAt && data.current.resetText) {
            data.current.resetAt = parseResetToEpoch(data.current.resetText, refTs);
        }
        if (!data.weekly.resetAt && data.weekly.resetText) {
            data.weekly.resetAt = parseResetToEpoch(data.weekly.resetText, refTs);
        }

        lastMetricsData = data;

        const curPct = data.current.pct;
        const weekPct = data.weekly.pct;

        const curLevel = getSeverityLevel(curPct);
        const weekLevel = getSeverityLevel(weekPct);
        const overallLevel = getSeverityLevel(Math.max(curPct ?? 0, weekPct ?? 0));

        if (!isSyncing && !isBatchSyncing) {
            syncDot.classList.remove('loading');
        }
        pill.className = `usage-pill level-${overallLevel}`;
        planBadge.textContent = data.badgeStr || 'PRO';
        accountBadge.textContent = currentCtx.displayLabel;
        accountBadge.title = currentCtx.email || currentCtx.accountId;

        if (curPct !== null) {
            curValText.textContent = `${curPct}%`;
            curValText.className = `metric-val level-${curLevel}`;

            bottomProgress.style.width = `${Math.min(100, curPct)}%`;
            bottomProgress.className = `bottom-progress level-${curLevel}`;

            curQuotaBox.className = `quota-box level-${curLevel}`;
            popCurPct.textContent = `已使用 ${curPct}%${getLevelTag(curLevel)}`;
            popCurPct.className = `quota-pct level-${curLevel}`;
            popCurBar.style.width = `${Math.min(100, curPct)}%`;
            popCurBar.className = `bar-fill level-${curLevel}`;
        }

        if (weekPct !== null) {
            weekValText.textContent = `${weekPct}%`;
            weekValText.className = `metric-val level-${weekLevel}`;

            weekQuotaBox.className = `quota-box level-${weekLevel}`;
            popWeekPct.textContent = `已使用 ${weekPct}%${getLevelTag(weekLevel)}`;
            popWeekPct.className = `quota-pct level-${weekLevel}`;
            popWeekBar.style.width = `${Math.min(100, weekPct)}%`;
            popWeekBar.className = `bar-fill level-${weekLevel}`;
        }

        const syncDate = data.timestamp ? new Date(data.timestamp) : new Date();
        const timeStr = syncDate.toTimeString().slice(0, 8);
        if (!isBatchSyncing) {
            popUpdatedText.textContent = `${data.updatedStr ? data.updatedStr + ' · ' : ''}${timeStr} · ${SCRIPT_VERSION}`;
        }

        scheduleNextTick(true);
    }

    function scheduleNextTick(immediate = false) {
        if (countdownTimerId) {
            clearTimeout(countdownTimerId);
            countdownTimerId = null;
        }
        if (document.visibilityState === 'hidden' || !lastMetricsData) return;

        if (immediate) {
            runTickStep();
            return;
        }

        const isPopOpen = popover.classList.contains('open');
        const curResetAt = lastMetricsData.current && lastMetricsData.current.resetAt;
        const remMs = curResetAt ? (curResetAt - Date.now()) : Infinity;

        const nextDelay = (isPopOpen || (remMs > 0 && remMs <= 3600000)) ? 1000 : 15000;
        countdownTimerId = setTimeout(runTickStep, nextDelay);
    }

    function runTickStep() {
        if (!lastMetricsData || document.visibilityState === 'hidden') return;

        const cur = lastMetricsData.current;
        const week = lastMetricsData.weekly;
        const isPopOpen = popover.classList.contains('open');

        if (cur) {
            const nextCompact = formatUltraCompactCountdown(cur.resetAt);
            if (curCountdownText.textContent !== nextCompact) {
                curCountdownText.textContent = nextCompact;
            }
            if (isPopOpen) {
                popCurReset.textContent = formatDetailedCountdown(cur.resetAt, cur.rawClock);
            }
        }

        if (week && isPopOpen) {
            popWeekReset.textContent = formatDetailedCountdown(week.resetAt, week.rawClock);
        }

        if (isPopOpen) {
            const cdNodes = multiAccListEl.querySelectorAll('.acc-cd[data-reset-at]');
            for (let i = 0; i < cdNodes.length; i++) {
                const ts = parseInt(cdNodes[i].getAttribute('data-reset-at'), 10);
                if (ts) {
                    const s = formatUltraCompactCountdown(ts);
                    cdNodes[i].textContent = s ? `(${s})` : '';
                }
            }
        }

        const now = Date.now();
        if (cur && cur.resetAt && now >= cur.resetAt && now - cur.resetAt < 20000) {
            if (now - lastAutoResetSyncAt > 90000) {
                lastAutoResetSyncAt = now;
                triggerUsageSync(false);
            }
        }

        scheduleNextTick(false);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleNextTick(true);
        } else if (countdownTimerId) {
            clearTimeout(countdownTimerId);
            countdownTimerId = null;
        }
    });

    function loadCachedDataForCurrentAccount() {
        try {
            const key = currentCtx.storageKey;
            const raw = (typeof GM_getValue === 'function' && GM_getValue(key)) || localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (!parsed.accountId || parsed.accountId === currentCtx.accountId) {
                    renderMetricsToUI(parsed);
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    function bindAccountStorageListener() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        const targetKey = currentCtx.storageKey;
        GM_addValueChangeListener(targetKey, (name, oldVal, newVal) => {
            if (name === currentCtx.storageKey && newVal) {
                try {
                    const parsed = JSON.parse(newVal);
                    if (parsed.accountId === currentCtx.accountId) {
                        renderMetricsToUI(parsed);
                    }
                } catch (_) {}
            }
        });
        GM_addValueChangeListener(REGISTRY_KEY, () => {
            if (popover.classList.contains('open')) renderMultiAccountList();
        });
    }
    bindAccountStorageListener();

    if (bc) {
        bc.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'GEMINI_HUD_DATA' && e.data.payload) {
                refreshAccountContextIfNeeded();
                upsertRegistryEntry(e.data.payload);
                if (popover.classList.contains('open')) renderMultiAccountList();
                if (e.data.payload.accountId === currentCtx.accountId) {
                    renderMetricsToUI(e.data.payload);
                }
            }
        });
    }

    window.addEventListener('storage', (e) => {
        refreshAccountContextIfNeeded();
        if (e.key === REGISTRY_KEY && popover.classList.contains('open')) {
            renderMultiAccountList();
        }
        if (e.key === currentCtx.storageKey && e.newValue) {
            try {
                const parsed = JSON.parse(e.newValue);
                if (parsed.accountId === currentCtx.accountId) {
                    renderMetricsToUI(parsed);
                }
            } catch (_) {}
        }
    });

    function refreshAccountContextIfNeeded() {
        const nextCtx = resolveAccountContext(document, pageWin);
        if (nextCtx.accountId !== currentCtx.accountId || nextCtx.usageUrl !== currentCtx.usageUrl) {
            const accountChanged = nextCtx.accountId !== currentCtx.accountId;
            currentCtx = nextCtx;
            openUsageLink.href = currentCtx.usageUrl;
            accountBadge.textContent = currentCtx.displayLabel;
            accountBadge.title = currentCtx.email || currentCtx.accountId;

            if (accountChanged) {
                resetUIForAccountSwitch();
                bindAccountStorageListener();
                if (!loadCachedDataForCurrentAccount()) {
                    triggerUsageSync(false);
                }
            }
        }
    }

    // =========================================================================
    // 5. 跨账号共享 RPC 协议重放 + Promise 化单实例微透明 Iframe 水合器
    // =========================================================================
    let isSyncing = false;
    let isBatchSyncing = false;
    let directIframeBlockedByCSP = false;
    let activeFrame = null;

    document.addEventListener('securitypolicyviolation', (e) => {
        if (e.violatedDirective && e.violatedDirective.includes('frame') && e.blockedURI && e.blockedURI.includes('/usage')) {
            directIframeBlockedByCSP = true;
        }
    });

    // 接收子窗口捕获的 batchexecute 载荷并保存为跨账号共享 RPC 模板
    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin || !e.data || e.data.type !== 'GEMINI_HUD_RPC_CAPTURE') return;
        const { bl, rpcs, domMetrics } = e.data;
        if (!Array.isArray(rpcs) || !domMetrics) return;

        for (const item of rpcs) {
            const unwrapped = unwrapBatchExecutePayloads(item.response);
            for (const entry of unwrapped) {
                const coords = findCalibrationPaths(entry.data, domMetrics);
                if (coords) {
                    const fReqMatch = item.body.match(/(?:^|&)f\.req=([^&]+)/);
                    if (fReqMatch) {
                        const profile = {
                            bl: bl || currentCtx.bl,
                            rpcId: entry.rpcId,
                            url: item.url,
                            fReqEncoded: fReqMatch[1],
                            coords,
                            badgeStr: domMetrics.badgeStr || 'PRO'
                        };
                        const serialized = JSON.stringify(profile);
                        try { if (typeof GM_setValue === 'function') GM_setValue(GLOBAL_RPC_PROFILE_KEY, serialized); } catch (_) {}
                        try { localStorage.setItem(GLOBAL_RPC_PROFILE_KEY, serialized); } catch (_) {}
                        return;
                    }
                }
            }
        }
    });

    // 支持任意账号槽位 (u0~u4) 的跨账号 batchexecute 协议重放
    async function tryCalibratedRpcReplay(ctx) {
        if (!ctx || !ctx.atToken) return null;
        let profile = null;
        try {
            const raw = (typeof GM_getValue === 'function' && GM_getValue(GLOBAL_RPC_PROFILE_KEY)) || localStorage.getItem(GLOBAL_RPC_PROFILE_KEY);
            if (raw) profile = JSON.parse(raw);
        } catch (_) {}
        if (!profile || !profile.url || !profile.fReqEncoded || !profile.coords) return null;
        if (ctx.bl && profile.bl && ctx.bl !== profile.bl) return null;

        try {
            const reqUrl = new URL(profile.url, window.location.origin);
            // 动态将请求路径与参数重写为目标账号槽位 /u/{slotIndex}
            reqUrl.pathname = reqUrl.pathname.replace(/^(\/u\/\d+)?\/_\/BardChatUi\//, `/u/${ctx.slotIndex}/_/BardChatUi/`);
            reqUrl.searchParams.set('source-path', `/u/${ctx.slotIndex}/usage`);
            reqUrl.searchParams.set('_reqid', String(Math.floor(100000 + Math.random() * 900000)));
            if (reqUrl.searchParams.has('authuser')) {
                reqUrl.searchParams.set('authuser', String(ctx.slotIndex));
            }

            const bodyStr = `f.req=${profile.fReqEncoded}&at=${encodeURIComponent(ctx.atToken)}&`;
            const resp = await fetch(reqUrl.toString(), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: bodyStr
            });
            if (!resp.ok) return null;
            const text = await resp.text();
            const unwrapped = unwrapBatchExecutePayloads(text);
            const target = unwrapped.find(u => u.rpcId === profile.rpcId);
            if (!target) return null;

            return buildMetricsFromCalibratedTree(target.data, profile.coords, ctx, 'RPC直连', profile.badgeStr);
        } catch (_) {
            return null;
        }
    }

    const IN_VIEWPORT_STEALTH_STYLE = {
        position: 'fixed',
        right: '0px',
        bottom: '0px',
        width: '320px',
        height: '220px',
        opacity: '0.01',
        pointerEvents: 'none',
        zIndex: '-1',
        border: 'none'
    };

    function cleanupActiveFrame() {
        if (!activeFrame) return;
        const frame = activeFrame;
        activeFrame = null;
        try { if (frame.contentWindow) frame.contentWindow.stop(); } catch (_) {}
        try { if (frame.contentDocument) frame.contentDocument.replaceChildren(); } catch (_) {}
        try { frame.src = 'about:blank'; } catch (_) {}
        if (frame.parentNode) frame.parentNode.removeChild(frame);
    }

    function installIdempotentTrustedTypesProxy(win) {
        if (!win || !win.trustedTypes || !win.trustedTypes.createPolicy || win.__hudTTProxied) return null;
        win.__hudTTProxied = true;
        const policyMap = new Map();
        const origCreate = win.trustedTypes.createPolicy.bind(win.trustedTypes);

        win.trustedTypes.createPolicy = function (name, rules) {
            if (policyMap.has(name)) return policyMap.get(name);
            try {
                const created = origCreate(name, rules);
                policyMap.set(name, created);
                return created;
            } catch (err) {
                if (policyMap.has('angular#unsafe-bypass')) return policyMap.get('angular#unsafe-bypass');
                throw err;
            }
        };

        const passThroughRules = {
            createHTML: (s) => s,
            createScript: (s) => s,
            createScriptURL: (s) => s
        };
        const candidates = ['angular#unsafe-bypass', 'default', 'angular', 'polymer-html-literal'];
        for (const name of candidates) {
            try {
                return win.trustedTypes.createPolicy(name, passThroughRules);
            } catch (_) {}
        }
        return null;
    }

    // Promise 化 about:blank 虚拟水合器
    function hydrateViaVirtualBlankAsync(rawHtml, ctx) {
        return new Promise((resolve) => {
            if (!rawHtml) {
                resolve(null);
                return;
            }

            cleanupActiveFrame();
            activeFrame = el('iframe', { style: IN_VIEWPORT_STEALTH_STYLE });
            document.body.appendChild(activeFrame);

            try {
                const win = activeFrame.contentWindow;
                const doc = activeFrame.contentDocument;
                if (!win || !doc) {
                    cleanupActiveFrame();
                    resolve(null);
                    return;
                }

                const hostNonceScript = document.querySelector('script[nonce]');
                const activeNonce = hostNonceScript ? (hostNonceScript.nonce || hostNonceScript.getAttribute('nonce') || '') : '';

                let patchedHtml = rawHtml;
                if (activeNonce) {
                    patchedHtml = patchedHtml.replace(/nonce="[^"]*"/g, `nonce="${activeNonce}"`);
                }

                const bootShimScript = `<script${activeNonce ? ` nonce="${activeNonce}"` : ''}>
                    (function(){
                        try { history.replaceState(null, '', ${JSON.stringify(ctx.usageUrl)}); } catch(e){}
                        if (window.trustedTypes && window.trustedTypes.createPolicy && !window.__hudTT) {
                            window.__hudTT = true;
                            var cache = window.__hudPolicyCache || (window.__hudPolicyCache = {});
                            var orig = window.trustedTypes.createPolicy.bind(window.trustedTypes);
                            window.trustedTypes.createPolicy = function(n, r) {
                                if (cache[n]) return cache[n];
                                try { return (cache[n] = orig(n, r)); } catch(e) { return cache['angular#unsafe-bypass'] || null; }
                            };
                        }
                    })();
                </script>`;

                const baseTag = /<base\s/i.test(patchedHtml) ? '' : `<base href="${window.location.origin}/">`;
                patchedHtml = patchedHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${bootShimScript}`);

                doc.open();
                try { win.history.replaceState(null, '', ctx.usageUrl); } catch (_) {}

                win.__hudPolicyCache = win.__hudPolicyCache || {};
                const ttPolicy = installIdempotentTrustedTypesProxy(win);
                if (ttPolicy) {
                    win.__hudPolicyCache['angular#unsafe-bypass'] = ttPolicy;
                }

                const writePayload = ttPolicy ? ttPolicy.createHTML(patchedHtml) : patchedHtml;
                doc.write(writePayload);
                doc.close();
                try { win.history.replaceState(null, '', ctx.usageUrl); } catch (_) {}

                let settled = false;
                const finish = (data) => {
                    if (settled) return;
                    settled = true;
                    clearInterval(pollTimer);
                    clearTimeout(timeoutTimer);
                    if (data && rawHtml) {
                        try { calibrateAfInitDataFromHtml(rawHtml, data, ctx.bl); } catch (_) {}
                    }
                    cleanupActiveFrame();
                    resolve(data || null);
                };

                const pollTimer = setInterval(() => {
                    if (!activeFrame) {
                        finish(null);
                        return;
                    }
                    const data = extractMetricsFromDoc(activeFrame.contentDocument, ctx);
                    if (data) finish(data);
                }, 150);

                const timeoutTimer = setTimeout(() => {
                    const finalDoc = activeFrame && activeFrame.contentDocument;
                    const finalTry = finalDoc ? extractMetricsFromDoc(finalDoc, ctx) : null;
                    finish(finalTry);
                }, 8000);
            } catch (_) {
                cleanupActiveFrame();
                resolve(null);
            }
        });
    }

    // Promise 化同源微透明 Iframe 水合器（失败时自动降级至 Virtual Blank）
    function hydrateAccountInStealthFrameAsync(ctx, fallbackHtml) {
        if (directIframeBlockedByCSP && fallbackHtml) {
            return hydrateViaVirtualBlankAsync(fallbackHtml, ctx);
        }

        return new Promise((resolve) => {
            cleanupActiveFrame();
            let settled = false;

            const finish = (data, switchVirtual = false) => {
                if (settled) return;
                settled = true;
                clearInterval(pollTimer);
                clearTimeout(timeoutTimer);
                window.removeEventListener('message', onMsg);
                cleanupActiveFrame();

                if (switchVirtual && fallbackHtml) {
                    hydrateViaVirtualBlankAsync(fallbackHtml, ctx).then(resolve);
                    return;
                }
                if (data && fallbackHtml) {
                    try { calibrateAfInitDataFromHtml(fallbackHtml, data, ctx.bl); } catch (_) {}
                }
                resolve(data || null);
            };

            const onMsg = (e) => {
                if (e.origin !== window.location.origin || !e.data) return;
                if (e.data.type === 'GEMINI_HUD_DATA' && e.data.payload) {
                    const p = Object.assign({}, e.data.payload, {
                        accountId: ctx.accountId,
                        slotIndex: ctx.slotIndex,
                        slotTag: ctx.slotTag,
                        email: ctx.email || e.data.payload.email,
                        displayLabel: ctx.displayLabel,
                        usageUrl: ctx.usageUrl,
                        appUrl: ctx.appUrl
                    });
                    finish(p, false);
                }
            };
            window.addEventListener('message', onMsg);

            activeFrame = el('iframe', {
                src: `${ctx.usageUrl}?hud_worker=iframe&hud_acc=${encodeURIComponent(ctx.accountId)}&hud_slot=${ctx.slotIndex}&_t=${Date.now()}`,
                style: IN_VIEWPORT_STEALTH_STYLE
            });
            document.body.appendChild(activeFrame);

            const pollTimer = setInterval(() => {
                if (!activeFrame) {
                    finish(null, false);
                    return;
                }
                if (directIframeBlockedByCSP) {
                    finish(null, true);
                    return;
                }
                try {
                    const doc = activeFrame.contentDocument;
                    if (doc) {
                        const data = extractMetricsFromDoc(doc, ctx);
                        if (data) finish(data, false);
                    }
                } catch (_) {
                    directIframeBlockedByCSP = true;
                    finish(null, true);
                }
            }, 150);

            const timeoutTimer = setTimeout(() => {
                try {
                    const finalDoc = activeFrame && activeFrame.contentDocument;
                    const finalData = finalDoc ? extractMetricsFromDoc(finalDoc, ctx) : null;
                    if (finalData) {
                        finish(finalData, false);
                        return;
                    }
                } catch (_) {}
                finish(null, !!fallbackHtml);
            }, 6000);
        });
    }

    function openManualFallbackTab(ctx) {
        const workerUrl = `${ctx.usageUrl}?hud_worker=tab&hud_acc=${encodeURIComponent(ctx.accountId)}&hud_slot=${ctx.slotIndex}&_t=${Date.now()}`;
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(workerUrl, { active: false, insert: true, setParent: true });
            setTimeout(() => {
                syncDot.classList.remove('loading');
                isSyncing = false;
            }, 6000);
        } else {
            syncDot.classList.remove('loading');
            popUpdatedText.textContent = '未授权 GM_openInTab';
            isSyncing = false;
        }
    }

    // 单账号同步入口
    async function triggerUsageSync(forceBgTab = false) {
        refreshAccountContextIfNeeded();
        if (isSyncing || isBatchSyncing) return;
        isSyncing = true;
        syncDot.classList.add('loading');

        const ctx = currentCtx;
        openUsageLink.href = ctx.usageUrl;
        popUpdatedText.textContent = `正在同步 (${ctx.displayLabel})...`;

        if (forceBgTab) {
            openManualFallbackTab(ctx);
            return;
        }

        try {
            // 1. 优先尝试跨账号共享 RPC 重放 (~80ms)
            const replayData = await tryCalibratedRpcReplay(ctx);
            if (replayData) {
                publishUsageData(replayData);
                renderMetricsToUI(replayData);
                isSyncing = false;
                syncDot.classList.remove('loading');
                return;
            }

            // 2. 拉取 HTML 尝试 AF_initDataCallback 状态机直出 (~110ms)
            let html = '';
            try {
                const resp = await fetch(ctx.usageUrl, { credentials: 'include', cache: 'no-store' });
                if (resp.ok && !resp.url.includes('accounts.google.com')) {
                    html = await resp.text();
                }
            } catch (_) {}

            if (html) {
                const fastData = parseMetricsFromRawHtml(html, ctx);
                if (fastData) {
                    publishUsageData(fastData);
                    renderMetricsToUI(fastData);
                    isSyncing = false;
                    syncDot.classList.remove('loading');
                    return;
                }
            }

            // 3. 降级至视口微透明 Iframe 水合与自动校准
            const hydratedData = await hydrateAccountInStealthFrameAsync(ctx, html);
            if (hydratedData) {
                publishUsageData(hydratedData);
                renderMetricsToUI(hydratedData);
            } else if (!lastMetricsData) {
                popUpdatedText.textContent = '同步超时';
            }
        } finally {
            isSyncing = false;
            if (!isBatchSyncing) syncDot.classList.remove('loading');
        }
    }

    // =========================================================================
    // 6. 全量多账号并发探测与同步引擎 (`triggerAllAccountsSync`)
    // =========================================================================
    async function probeSlotHtmlAndContext(slotIdx) {
        const probeUrl = `${window.location.origin}/u/${slotIdx}/usage`;
        try {
            const resp = await fetch(probeUrl, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok || (resp.url && resp.url.includes('accounts.google.com'))) return null;
            const html = await resp.text();
            if (!html) return null;

            const wiz = extractWizFromRawHtml(html);
            // 若未提取到任何真实邮箱或 Gaia ID，说明该槽位未登录有效 Google 账号
            if (!wiz.email && !wiz.gaiaId) return null;

            const slotCtx = buildContextFromWizAndSlot(wiz, slotIdx);
            return { slotCtx, html };
        } catch (_) {
            return null;
        }
    }

    async function triggerAllAccountsSync() {
        if (isBatchSyncing || isSyncing) return;
        refreshAccountContextIfNeeded();
        isBatchSyncing = true;
        syncDot.classList.add('loading');
        syncAllAccountsBtn.classList.add('busy');
        syncAllAccountsBtn.textContent = '↻ 探测中...';
        popUpdatedText.textContent = '正在并发探测所有登录账号...';

        try {
            // 汇总候选槽位：已知注册表槽位 + 当前槽位 + 0..MAX_PROBE_SLOT
            const reg = readAccountRegistry();
            const candidateSlots = new Set([currentCtx.slotIndex]);
            for (const item of Object.values(reg)) {
                if (Number.isInteger(item.slotIndex)) candidateSlots.add(item.slotIndex);
            }
            for (let i = 0; i <= MAX_PROBE_SLOT; i++) {
                candidateSlots.add(i);
            }
            const sortedSlots = Array.from(candidateSlots).sort((a, b) => a - b);

            // 阶段 1：并发拉取所有候选槽位 HTML 并通过真实邮箱/GaiaID 严格去重
            const probeResults = await Promise.all(sortedSlots.map(s => probeSlotHtmlAndContext(s)));
            const validTargets = [];
            const seenAccountIds = new Set();

            // 优先锁定当前页面所在槽位，防止默认账号回退覆盖当前槽位索引
            for (const res of probeResults) {
                if (res && res.slotCtx.slotIndex === currentCtx.slotIndex) {
                    seenAccountIds.add(res.slotCtx.accountId);
                    validTargets.push(res);
                }
            }
            for (const res of probeResults) {
                if (!res || seenAccountIds.has(res.slotCtx.accountId)) continue;
                seenAccountIds.add(res.slotCtx.accountId);
                validTargets.push(res);
            }

            const total = validTargets.length;
            let completedCount = 0;
            const hydrationQueue = [];

            const updateProgressUI = () => {
                syncAllAccountsBtn.textContent = `↻ 同步 ${completedCount}/${total}`;
                popUpdatedText.textContent = `全量同步进度：${completedCount}/${total} 个账号`;
            };
            updateProgressUI();

            // 阶段 2：并发执行快路径（AF_initDataCallback 状态机直出 + 跨账号 RPC 重放）
            await Promise.all(validTargets.map(async ({ slotCtx, html }) => {
                let data = parseMetricsFromRawHtml(html, slotCtx);
                if (!data && slotCtx.atToken) {
                    data = await tryCalibratedRpcReplay(slotCtx);
                }
                if (data) {
                    completedCount++;
                    publishUsageData(data);
                    renderMetricsToUI(data);
                    updateProgressUI();
                } else {
                    hydrationQueue.push({ slotCtx, html });
                }
            }));

            // 阶段 3：对未命中快路径的账号执行单实例串行 Iframe 水合（第 1 个校准后其余账号直接用 SSR 秒出）
            for (const item of hydrationQueue) {
                // 若前一个账号刚刚在水合中完成了 SSR_PROFILE_KEY 校准，直接复用来解析当前 HTML，省去创建 Iframe
                const newlyCalibratedData = parseMetricsFromRawHtml(item.html, item.slotCtx);
                if (newlyCalibratedData) {
                    completedCount++;
                    publishUsageData(newlyCalibratedData);
                    renderMetricsToUI(newlyCalibratedData);
                    updateProgressUI();
                    continue;
                }

                const hydratedData = await hydrateAccountInStealthFrameAsync(item.slotCtx, item.html);
                completedCount++;
                if (hydratedData) {
                    publishUsageData(hydratedData);
                    renderMetricsToUI(hydratedData);
                }
                updateProgressUI();
            }

            const timeStr = new Date().toTimeString().slice(0, 8);
            popUpdatedText.textContent = `全量同步完成 (${total}个账号) · ${timeStr} · ${SCRIPT_VERSION}`;
            renderMultiAccountList();
        } finally {
            isBatchSyncing = false;
            syncDot.classList.remove('loading');
            syncAllAccountsBtn.classList.remove('busy');
            syncAllAccountsBtn.textContent = '↻ 全量同步';
        }
    }

    // =========================================================================
    // 7. O(1) 短路状态栏挂载与提问发送拦截
    // =========================================================================
    let mountScheduled = false;

    function mountIntoInputBar() {
        mountScheduled = false;
        if (!pillHost.isConnected) {
            // 采用多级候选选择器链，适应 Google 前端 A/B 灰度结构变动
            const leadingWrapper = document.querySelector(
                'fieldset.input-area-fieldset .leading-actions-wrapper, ' +
                '.text-input-field .leading-actions-wrapper, ' +
                'chat-input .input-area-container .leading-actions-wrapper, ' +
                'div[role="textbox"] ~ * .leading-actions-wrapper, ' +
                'footer .input-buttons-wrapper-bottom, ' +
                'fieldset div[class*="leading-actions"]'
            );
            if (leadingWrapper) {
                leadingWrapper.appendChild(pillHost);
            }
        }
        if (!popoverHost.isConnected && document.body) {
            document.body.appendChild(popoverHost);
        }
        refreshAccountContextIfNeeded();
    }

    const domObserver = new MutationObserver(() => {
        if (pillHost.isConnected && popoverHost.isConnected) return;
        if (!mountScheduled) {
            mountScheduled = true;
            requestAnimationFrame(mountIntoInputBar);
        }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    mountIntoInputBar();

    window.addEventListener('click', () => {
        setTimeout(refreshAccountContextIfNeeded, 120);
    }, { passive: true });

    let sendDebounceTimer = null;
    function schedulePostSendRefresh(delayMs = 3500) {
        if (!config.refreshOnSend) return;
        if (sendDebounceTimer) clearTimeout(sendDebounceTimer);
        sendDebounceTimer = setTimeout(() => {
            triggerUsageSync(false);
        }, delayMs);
    }

    window.addEventListener('click', (e) => {
        if (!config.refreshOnSend) return;
        const btn = e.target.closest && e.target.closest('button');
        if (!btn) return;
        const inTrailing = btn.closest('.trailing-actions-wrapper, .input-buttons-wrapper-bottom');
        if (!inTrailing) return;

        const isMic = btn.closest('speech-dictation-mic-button') || btn.querySelector('[data-mat-icon-name="mic"]');
        const isStop = btn.querySelector('[data-mat-icon-name="stop"]');
        if (!isMic && !isStop) {
            schedulePostSendRefresh(4000);
        }
    }, true);

    window.addEventListener('keydown', (e) => {
        if (!config.refreshOnSend) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            const editor = e.target.closest && e.target.closest('.ql-editor, rich-textarea');
            if (editor && editor.textContent.trim().length > 0) {
                schedulePostSendRefresh(4000);
            }
        }
    }, true);

    if (pageWin.XMLHttpRequest && !pageWin.XMLHttpRequest.__geminiHudHooked) {
        const origOpen = pageWin.XMLHttpRequest.prototype.open;
        pageWin.XMLHttpRequest.prototype.open = function (method, url) {
            if (typeof url === 'string' && url.includes('StreamGenerate')) {
                this.addEventListener('loadend', () => {
                    schedulePostSendRefresh(1500);
                });
            }
            return origOpen.apply(this, arguments);
        };
        pageWin.XMLHttpRequest.__geminiHudHooked = true;
    }

    let autoRefreshTimer = null;
    function setupAutoRefresh() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }
        if (config.intervalSec > 0) {
            autoRefreshTimer = setInterval(() => {
                if (document.visibilityState === 'visible') {
                    triggerUsageSync(false);
                }
            }, config.intervalSec * 1000);
        }
    }

    loadCachedDataForCurrentAccount();
    renderMultiAccountList();
    triggerUsageSync(false);
    setupAutoRefresh();
})();
