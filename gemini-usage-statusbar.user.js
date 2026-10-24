// ==UserScript==
// @name         Gemini Usage Statusbar HUD
// @namespace    https://gemini.google.com/
// @version      1.0.1
// @description  极简微缩胶囊内嵌至 Gemini 状态栏，支持多账号一键全量并发同步、新登录账号自动探测、AF_initDataCallback 与 batchexecute 跨账号共享自校准。
// @author       kshipeng & Gemini
// @license      MIT
// @match        https://gemini.google.com/*
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        unsafeWindow
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = `v${(typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '1.0.2'}`;
    const STORAGE_PREFIX = 'gemini_usage_sync_payload_v38_';
    const REGISTRY_KEY = 'gemini_usage_multi_registry_v38';
    const SSR_PROFILE_KEY = 'gemini_usage_ssr_profile_v38';
    const GLOBAL_RPC_PROFILE_KEY = 'gemini_usage_rpc_profile_global_v38';
    const CFG_STORAGE_KEY = 'gemini_usage_statusbar_cfg_v38';
    const CHANNEL_NAME = 'gemini_usage_broadcast_v38';
    const MAX_PROBE_SLOT = 4;
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

    const isUsagePage = /^(\/u\/\d+)?\/usage(\/|$|\?)/.test(window.location.pathname);
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // =========================================================================
    // 0. 通用存储封装与 WIZ_global_data 身份提取
    // =========================================================================
    function readStore(key, fallback = null, preferGm = true) {
        try {
            const raw = (preferGm && typeof GM_getValue === 'function' && GM_getValue(key)) || localStorage.getItem(key);
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        return fallback;
    }

    function writeStore(key, value, syncGm = true) {
        const serialized = JSON.stringify(value);
        if (syncGm) {
            try { if (typeof GM_setValue === 'function') GM_setValue(key, serialized); } catch (_) {}
        }
        try { localStorage.setItem(key, serialized); } catch (_) {}
    }

    const WIZ_FIELD_MAP = [
        ['email', 'oPEP7c', true],
        ['gaiaId', 'S06Grb', false],
        ['atToken', 'SNlM0e', false],
        ['bl', 'cfb2h', false],
        ['fSid', 'FdrFJe', false]
    ];

    function unescapeWizString(str) {
        return str ? str.replace(/\\u0040/gi, '@').replace(/\\"/g, '"').trim() : '';
    }

    function extractWizFromRawHtml(html) {
        const meta = { email: '', gaiaId: '', atToken: '', bl: '', fSid: '' };
        if (!html || typeof html !== 'string') return meta;
        for (const [prop, wizKey, lower] of WIZ_FIELD_MAP) {
            const m = html.match(new RegExp(`"${wizKey}"\\s*:\\s*"([^"]+)"`));
            if (m) {
                const val = unescapeWizString(m[1]);
                meta[prop] = lower ? val.toLowerCase() : val;
            }
        }
        return meta;
    }

    function extractWizMetadata(doc = document, win = pageWin) {
        const meta = { email: '', gaiaId: '', atToken: '', bl: '', fSid: '' };
        try {
            const wiz = win && win.WIZ_global_data;
            if (wiz && typeof wiz === 'object') {
                for (const [prop, wizKey, lower] of WIZ_FIELD_MAP) {
                    if (typeof wiz[wizKey] === 'string') {
                        const val = unescapeWizString(wiz[wizKey]);
                        meta[prop] = lower ? val.toLowerCase() : val;
                    }
                }
            }
        } catch (_) {}

        if ((!meta.email || !meta.atToken) && doc && doc.querySelectorAll) {
            for (const s of doc.querySelectorAll('script')) {
                const txt = s.textContent || '';
                if (!txt.includes('WIZ_global_data') && !txt.includes('oPEP7c') && !txt.includes('SNlM0e')) continue;
                const parsed = extractWizFromRawHtml(txt);
                for (const [prop] of WIZ_FIELD_MAP) {
                    if (!meta[prop] && parsed[prop]) meta[prop] = parsed[prop];
                }
                if (meta.email && meta.atToken) break;
            }
        }
        return meta;
    }

    function maskEmail(email) {
        if (!email || !email.includes('@')) return '';
        const [local, domain] = email.split('@');
        return `${local.length <= 2 ? local[0] : local.slice(0, 2)}***@${domain}`;
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
        const anchorMatch = menuAnchor && (menuAnchor.getAttribute('href') || '').match(/^\/u\/(\d+)\/usage/);
        if (anchorMatch) {
            slotIndex = parseInt(anchorMatch[1], 10);
        } else {
            const loc = win.location || window.location;
            const pathMatch = loc.pathname.match(/^\/u\/(\d+)(\/|$)/);
            const authUser = new URLSearchParams(loc.search).get('authuser');
            if (pathMatch) slotIndex = parseInt(pathMatch[1], 10);
            else if (authUser && /^\d+$/.test(authUser)) slotIndex = parseInt(authUser, 10);
        }
        return buildContextFromWizAndSlot(extractWizMetadata(doc, win), slotIndex);
    }

    // =========================================================================
    // 1. 多账号全局注册表（支持跨会话合并与槽位自动刷新）
    // =========================================================================
    function readAccountRegistry() {
        const gmMap = readStore(REGISTRY_KEY, {}, true) || {};
        const lsMap = readStore(REGISTRY_KEY, {}, false) || {};
        const merged = Object.assign({}, lsMap);
        for (const [k, v] of Object.entries(gmMap)) {
            if (!merged[k] || (v && v.timestamp > (merged[k].timestamp || 0))) {
                merged[k] = v;
            }
        }
        return merged;
    }

    function writeAccountRegistry(regMap) {
        writeStore(REGISTRY_KEY, regMap, true);
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
            updatedStr: payload.updatedStr || 'DOM水合',
            timestamp: payload.timestamp || Date.now()
        };
        writeAccountRegistry(reg);
    }

    // =========================================================================
    // 2. 重置时间解析与倒计时格式化
    // =========================================================================
    function parseResetToEpoch(resetText, refTimeMs = Date.now()) {
        if (!resetText || typeof resetText !== 'string') return null;
        const ref = new Date(refTimeMs);

        const mdhmMatch = resetText.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/);
        if (mdhmMatch) {
            const target = new Date(ref.getFullYear(), parseInt(mdhmMatch[1], 10) - 1, parseInt(mdhmMatch[2], 10), parseInt(mdhmMatch[3], 10), parseInt(mdhmMatch[4], 10), 0, 0);
            if (target.getTime() < refTimeMs - 86400000 * 30) target.setFullYear(target.getFullYear() + 1);
            return target.getTime();
        }

        const hmMatch = resetText.match(/(\d{1,2}):(\d{2})/);
        if (hmMatch) {
            const target = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), parseInt(hmMatch[1], 10), parseInt(hmMatch[2], 10), 0, 0);
            if (/明天|明日|tomorrow/i.test(resetText) || target.getTime() <= refTimeMs - 60000) {
                target.setDate(target.getDate() + 1);
            }
            return target.getTime();
        }
        return null;
    }

    function calcRemainingParts(targetMs) {
        if (!targetMs) return null;
        const diffSec = Math.floor((targetMs - Date.now()) / 1000);
        if (diffSec <= 0) return { expired: true };
        return {
            expired: false,
            d: Math.floor(diffSec / 86400),
            h: Math.floor((diffSec % 86400) / 3600),
            m: Math.floor((diffSec % 3600) / 60),
            s: diffSec % 60
        };
    }

    function formatUltraCompactCountdown(targetMs) {
        const p = calcRemainingParts(targetMs);
        if (!p) return '';
        if (p.expired) return '已重置';
        if (p.d > 0) return `${p.d}d${p.h}h`;
        if (p.h > 0) return `${p.h}h${String(p.m).padStart(2, '0')}m`;
        return `${p.m}m${String(p.s).padStart(2, '0')}s`;
    }

    function formatDetailedCountdown(targetMs, rawClockStr) {
        const suffix = rawClockStr ? ` (${rawClockStr} 重置)` : '';
        const p = calcRemainingParts(targetMs);
        if (!p) return rawClockStr ? `重置时间：${rawClockStr}` : '重置时间：--';
        if (p.expired) return `已到达重置时间，即将刷新...${suffix}`;
        const msStr = `${String(p.m).padStart(2, '0')}分 ${String(p.s).padStart(2, '0')}秒${suffix}`;
        if (p.d > 0) return `剩余 ${p.d}天 ${p.h}小时 ${msStr}`;
        if (p.h > 0) return `剩余 ${p.h}小时 ${msStr}`;
        return `剩余 ${p.m}分 ${String(p.s).padStart(2, '0')}秒${suffix}`;
    }

    function formatEpochToRawClock(epochMs) {
        if (!epochMs) return '';
        const d = new Date(epochMs);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    }

    // =========================================================================
    // 3. DOM 提取、AF_initDataCallback 状态机与跨账号共享坐标校准
    // =========================================================================
    function extractMetricsFromDoc(doc, explicitCtx, sourceOverride) {
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
                const stylePctMatch = barEl && (barEl.getAttribute('style') || '').match(/--x-width:\s*(\d+(?:\.\d+)?)%/);
                if (stylePctMatch) pct = parseFloat(stylePctMatch[1]);
            }

            let resetText = '重置时间：--';
            let rawClock = '';
            for (const leaf of rootEl.querySelectorAll('span, p, div')) {
                if (leaf.childElementCount === 0) {
                    const t = (leaf.textContent || '').trim();
                    if (/重置时间|Reset/i.test(t)) {
                        resetText = t;
                        const tp = t.match(/[：:]\s*(.+)$/);
                        if (tp) rawClock = tp[1].trim();
                        break;
                    }
                }
            }
            if (resetText === '重置时间：--') {
                const fallbackMatch = rawText.match(/(重置时间\s*[：:]\s*[^\n]+)/);
                if (fallbackMatch) {
                    resetText = fallbackMatch[1].replace(/已使用.*$/, '').trim();
                    const tp = resetText.match(/[：:]\s*(.+)$/);
                    if (tp) rawClock = tp[1].trim();
                }
            }
            return { pct, resetText, rawClock, resetAt: parseResetToEpoch(resetText, nowMs) };
        };

        const current = parseSection(curNode);
        const weekly = parseSection(weekNode);
        if (current.pct === null && weekly.pct === null) return null;

        const updatedStr = sourceOverride || 'DOM水合';

        let badgeStr = 'PRO';
        const h1 = doc.querySelector('header h1');
        if (h1 && h1.parentElement) {
            for (const sp of h1.parentElement.querySelectorAll('span')) {
                const txt = sp.childElementCount === 0 ? sp.textContent.trim() : '';
                if (txt) { badgeStr = txt; break; }
            }
        }

        const detectedCtx = resolveAccountContext(doc, doc.defaultView || pageWin);
        const finalCtx = explicitCtx && typeof explicitCtx === 'object' ? Object.assign({}, detectedCtx, explicitCtx) : detectedCtx;

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

            const dataStart = searchPos + dataMatch.index + dataMatch[0].length;
            const firstChar = html[dataStart];
            if (firstChar !== '[' && firstChar !== '{') continue;

            let depth = 0, inStr = false, escape = false, endPos = -1;
            const maxScan = Math.min(html.length, dataStart + 300000);

            for (let i = dataStart; i < maxScan; i++) {
                const ch = html[i];
                if (escape) { escape = false; continue; }
                if (inStr) {
                    if (ch === '\\') escape = true;
                    else if (ch === '"') inStr = false;
                    continue;
                }
                if (ch === '"') inStr = true;
                else if (ch === '[' || ch === '{') depth++;
                else if (ch === ']' || ch === '}') {
                    if (--depth === 0) { endPos = i + 1; break; }
                }
            }

            if (endPos !== -1) {
                try { blocks[keyMatch[1]] = JSON.parse(html.slice(dataStart, endPos)); } catch (_) {}
                searchPos = endPos;
            }
        }
        return blocks;
    }

    function unwrapBatchExecutePayloads(rawText) {
        const results = [];
        if (!rawText || typeof rawText !== 'string') return results;
        for (const rawLine of rawText.split('\n')) {
            const line = rawLine.trim();
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
        return pathArr.reduce((acc, k) => (acc != null ? acc[k] : undefined), root);
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
                    if (Math.abs(node - curPct) < 0.05) { curPctPath = path; curPctScale = 1; }
                    else if (node > 0 && node <= 1 && Math.abs(node * 100 - curPct) < 0.1) { curPctPath = path; curPctScale = 100; }
                } else if (weekPct > 0 && !weekPctPath && (!curPctPath || path.join('.') !== curPctPath.join('.'))) {
                    if (Math.abs(node - weekPct) < 0.05) { weekPctPath = path; weekPctScale = 1; }
                    else if (node > 0 && node <= 1 && Math.abs(node * 100 - weekPct) < 0.1) { weekPctPath = path; weekPctScale = 100; }
                }

                if (targetCurSec && !curResetPath) {
                    if (Math.abs(node - targetCurSec) <= 120) { curResetPath = path; curResetUnit = 1000; }
                    else if (Math.abs(node - curResetAt) <= 120000) { curResetPath = path; curResetUnit = 1; }
                }
                if (targetWeekSec && !weekResetPath) {
                    if (Math.abs(node - targetWeekSec) <= 120) { weekResetPath = path; weekResetUnit = 1000; }
                    else if (Math.abs(node - weekResetAt) <= 120000) { weekResetPath = path; weekResetUnit = 1; }
                }
                return;
            }

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) walk(node[i], path.concat(i));
            } else if (typeof node === 'object') {
                for (const k of Object.keys(node)) walk(node[k], path.concat(k));
            }
        }

        walk(jsonTree, []);
        return (curPctPath && weekPctPath && curResetPath)
            ? { curPctPath, curPctScale, weekPctPath, weekPctScale, curResetPath, curResetUnit, weekResetPath, weekResetUnit }
            : null;
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
            current: { pct: curPct, resetText: curClock ? `重置时间：${curClock}` : '重置时间：--', rawClock: curClock, resetAt: curResetAt },
            weekly: { pct: weekPct, resetText: weekClock ? `重置时间：${weekClock}` : '重置时间：--', rawClock: weekClock, resetAt: weekResetAt },
            updatedStr: sourceLabel,
            badgeStr: badgeStr || 'PRO',
            timestamp: Date.now()
        };
    }

    function tryExtractFromAfInitData(html, ctx) {
        const ssrProfile = readStore(SSR_PROFILE_KEY);
        if (!ssrProfile || !ssrProfile.dsKey || !ssrProfile.coords) return null;
        if (ctx.bl && ssrProfile.bl && ctx.bl !== ssrProfile.bl) return null;

        const blocks = parseAfInitDataBlocks(html);
        const targetTree = blocks[ssrProfile.dsKey];
        return targetTree ? buildMetricsFromCalibratedTree(targetTree, ssrProfile.coords, ctx, 'SSR直出', ssrProfile.badgeStr) : null;
    }

    function calibrateAfInitDataFromHtml(html, domMetrics, blVersion) {
        if (!html || !domMetrics) return;
        const blocks = parseAfInitDataBlocks(html);
        for (const [dsKey, tree] of Object.entries(blocks)) {
            const coords = findCalibrationPaths(tree, domMetrics);
            if (coords) {
                writeStore(SSR_PROFILE_KEY, {
                    bl: blVersion || '',
                    dsKey,
                    coords,
                    badgeStr: domMetrics.badgeStr || 'PRO',
                    calibratedAt: Date.now()
                });
                return;
            }
        }
    }

    function parseMetricsFromRawHtml(html, ctx) {
        if (!html) return null;
        const ssrData = tryExtractFromAfInitData(html, ctx);
        if (ssrData) return ssrData;
        if (!html.includes('current-usage') && !html.includes('weekly-usage')) return null;

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return extractMetricsFromDoc(doc, ctx, 'HTML直出');
        } catch (_) {
            return null;
        }
    }

    function publishUsageData(payload) {
        if (!payload || !payload.accountId) return;
        upsertRegistryEntry(payload);
        writeStore(`${STORAGE_PREFIX}${payload.accountId}`, payload, true);
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
                        this.addEventListener('load', () => {
                            try { capturedRpcs.push({ url: reqUrl, body, response: this.responseText }); } catch (_) {}
                        });
                    }
                    return origSend.apply(this, arguments);
                };
                pageWin.XMLHttpRequest.__hudUsageRpcHooked = true;
            }
        } catch (_) {}

        if (workerMode === 'tab') document.title = `↻ 同步用量 (${pageCtx.displayLabel})...`;

        let completed = false, obs = null, timer = null;
        const cleanupWorker = () => {
            if (timer) { clearInterval(timer); timer = null; }
            if (obs) { obs.disconnect(); obs = null; }
        };

        const tryExtractAndFinish = () => {
            if (completed) return;
            const data = extractMetricsFromDoc(document, pageCtx);
            if (!data) return;
            completed = true;
            cleanupWorker();
            try { calibrateAfInitDataFromHtml(document.documentElement.innerHTML, data, pageCtx.bl); } catch (_) {}
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

    const config = Object.assign({}, defaultConfig, readStore(CFG_STORAGE_KEY, {}, false));
    const saveConfig = () => writeStore(CFG_STORAGE_KEY, config, false);

    function getSeverityLevel(pct) {
        if (pct === null || pct === undefined || isNaN(pct)) return 'normal';
        if (pct >= config.dangerThreshold) return 'danger';
        if (pct >= config.warnThreshold) return 'warn';
        return 'normal';
    }

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'text') node.textContent = v;
            else node.setAttribute(k, v);
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
        style: { display: 'inline-flex', alignItems: 'center', marginLeft: '4px', verticalAlign: 'middle' }
    });
    const pillShadow = pillHost.attachShadow({ mode: 'open' });

    const pillStyle = el('style', {
        text: `
            :host { font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 11.5px; user-select: none; }
            .usage-pill {
                position: relative; display: inline-flex; align-items: center; gap: 5px;
                height: 28px; padding: 0 9px; border-radius: 14px;
                background: rgba(168, 199, 250, 0.06); border: 1px solid rgba(168, 199, 250, 0.18);
                color: #c4c7c5; cursor: pointer; transition: background 0.2s, border-color 0.2s, color 0.2s;
                white-space: nowrap; overflow: hidden;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill { background: rgba(11, 87, 208, 0.04); border-color: rgba(11, 87, 208, 0.16); color: #444746; }
            }
            .usage-pill:hover { background: rgba(168, 199, 250, 0.14); border-color: rgba(168, 199, 250, 0.38); color: #e3e3e3; }
            @media (prefers-color-scheme: light) { .usage-pill:hover { color: #1f1f1f; } }
            .usage-pill.level-warn { background: rgba(251, 188, 4, 0.11); border-color: rgba(252, 201, 52, 0.45); color: #fde293; }
            @media (prefers-color-scheme: light) {
                .usage-pill.level-warn { background: rgba(251, 188, 4, 0.12); border-color: rgba(227, 116, 0, 0.45); color: #b06000; }
            }
            .usage-pill.level-danger {
                background: rgba(234, 67, 53, 0.15); border-color: rgba(242, 139, 130, 0.7); color: #f28b82;
                animation: softPulse 2s infinite ease-in-out;
            }
            @media (prefers-color-scheme: light) {
                .usage-pill.level-danger { background: rgba(234, 67, 53, 0.12); border-color: rgba(197, 34, 31, 0.65); color: #c5221f; }
            }
            @keyframes softPulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(242, 139, 130, 0); }
                50% { box-shadow: 0 0 8px 1px rgba(242, 139, 130, 0.35); }
            }
            .sync-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: #a8c7fa; flex-shrink: 0; }
            .sync-dot.loading { display: inline-block; animation: blink 0.8s infinite ease-in-out; }
            @keyframes blink {
                0%, 100% { opacity: 0.25; transform: scale(0.8); }
                50% { opacity: 1; transform: scale(1.15); }
            }
            .metric-group { display: inline-flex; align-items: baseline; gap: 3px; }
            .metric-label { opacity: 0.65; font-size: 10.5px; }
            .metric-val { font-weight: 600; font-variant-numeric: tabular-nums; color: #e3e3e3; transition: color 0.2s; }
            @media (prefers-color-scheme: light) { .metric-val { color: #1f1f1f; } }
            .metric-val.level-warn { color: #fcc934; }
            .metric-val.level-danger { color: #ff6b6b; font-weight: 700; }
            @media (prefers-color-scheme: light) {
                .metric-val.level-warn { color: #c26401; }
                .metric-val.level-danger { color: #c5221f; }
            }
            .countdown-inline { opacity: 0.68; font-size: 10.5px; font-variant-numeric: tabular-nums; margin-left: 1px; }
            .sep { opacity: 0.3; font-size: 10px; margin: 0 1px; }
            .bottom-progress {
                position: absolute; left: 0; bottom: 0; height: 2px; background: #6dd58c;
                opacity: 0.75; transition: width 0.3s, background 0.25s; pointer-events: none;
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
        el('div', { class: 'metric-group' }, [el('span', { class: 'metric-label', text: '5h' }), curValText, curCountdownText]),
        el('span', { class: 'sep', text: '·' }),
        el('div', { class: 'metric-group' }, [el('span', { class: 'metric-label', text: '周' }), weekValText]),
        bottomProgress
    ]);

    pillShadow.append(pillStyle, pill);

    // -------------------------------------------------------------------------
    // 宿主 2：顶层弹窗宿主 (popoverHost)
    // -------------------------------------------------------------------------
    const popoverHost = el('div', {
        id: 'gemini-usage-popover-portal',
        style: { position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', overflow: 'visible', zIndex: '2147483647', pointerEvents: 'none' }
    });
    document.body.appendChild(popoverHost);
    const popoverShadow = popoverHost.attachShadow({ mode: 'open' });

    const popoverStyle = el('style', {
        text: `
            :host { font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; user-select: none; }
            .popover {
                position: fixed; z-index: 2147483647; width: 348px; background: #1e1f20; color: #e3e3e3;
                border: 1px solid #444746; border-radius: 14px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65);
                padding: 13px; display: none; flex-direction: column; gap: 9px; pointer-events: auto; box-sizing: border-box;
            }
            .popover.open { display: flex; animation: popFadeIn 0.15s cubic-bezier(0.2, 0, 0, 1); }
            @keyframes popFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            .pop-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333537; padding-bottom: 8px; }
            .pop-title { display: flex; align-items: center; gap: 5px; font-weight: 600; font-size: 12.5px; overflow: hidden; }
            .badge { background: #a8c7fa; color: #062e6f; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 5px; flex-shrink: 0; }
            .acc-tag {
                background: #333537; color: #c4c7c5; font-size: 10px; font-weight: 500; padding: 1px 5px;
                border-radius: 5px; max-width: 125px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .header-actions { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
            .refresh-btn, .mini-btn, .sync-all-btn {
                background: #282a2c; color: #e3e3e3; border: 1px solid #444746; border-radius: 6px;
                padding: 2px 7px; font-size: 11px; cursor: pointer; transition: all 0.15s;
            }
            .refresh-btn:hover, .mini-btn:hover { background: #37393b; }
            .mini-btn { padding: 1px 6px; font-size: 10px; color: #9aa0a6; }
            .sync-all-btn {
                padding: 1px 7px; font-size: 10px; color: #a8c7fa;
                background: rgba(168, 199, 250, 0.1); border-color: rgba(168, 199, 250, 0.35); font-weight: 500;
            }
            .sync-all-btn:hover { background: rgba(168, 199, 250, 0.2); border-color: rgba(168, 199, 250, 0.55); }
            .sync-all-btn.busy { opacity: 0.65; pointer-events: none; }
            .pop-link { color: #a8c7fa; text-decoration: none; font-size: 11px; }
            .pop-link:hover { text-decoration: underline; }
            .quota-box {
                background: #282a2c; border-radius: 8px; padding: 8px 11px; display: flex;
                flex-direction: column; gap: 5px; border-left: 3px solid #6dd58c; transition: border-color 0.25s;
            }
            .quota-box.level-warn { border-left-color: #fcc934; }
            .quota-box.level-danger { border-left-color: #ff5252; background: rgba(234, 67, 53, 0.08); }
            .quota-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
            .quota-pct { font-weight: 600; color: #6dd58c; }
            .quota-pct.level-warn { color: #fcc934; }
            .quota-pct.level-danger { color: #ff6b6b; }
            .bar-track { height: 5px; background: #3c4043; border-radius: 3px; overflow: hidden; }
            .bar-fill { height: 100%; background: linear-gradient(90deg, #a8c7fa, #6dd58c); transition: width 0.3s, background 0.25s; }
            .bar-fill.level-warn { background: linear-gradient(90deg, #fde293, #fbbc04); }
            .bar-fill.level-danger { background: linear-gradient(90deg, #f28b82, #ea4335); }
            .quota-reset { font-size: 11px; color: #c4c7c5; font-variant-numeric: tabular-nums; }
            .multi-acc-section {
                background: #232426; border: 1px solid #333537; border-radius: 8px;
                padding: 7px 9px; display: flex; flex-direction: column; gap: 5px;
            }
            .multi-acc-header {
                display: flex; justify-content: space-between; align-items: center;
                font-size: 11px; color: #9aa0a6; padding-bottom: 4px; border-bottom: 1px dashed #333537;
            }
            .multi-acc-actions { display: flex; align-items: center; gap: 5px; }
            .multi-acc-list { display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
            .multi-acc-list::-webkit-scrollbar { width: 4px; }
            .multi-acc-list::-webkit-scrollbar-thumb { background: #444746; border-radius: 2px; }
            .acc-row {
                display: flex; justify-content: space-between; align-items: center; padding: 4px 6px;
                border-radius: 6px; background: #1e1f20; border: 1px solid transparent; cursor: pointer;
                transition: background 0.15s, border-color 0.15s; font-size: 11px; font-variant-numeric: tabular-nums;
            }
            .acc-row:hover { background: #2c2e30; border-color: #444746; }
            .acc-row.current { background: rgba(168, 199, 250, 0.08); border-color: rgba(168, 199, 250, 0.3); }
            .acc-row-left { display: flex; align-items: center; gap: 5px; min-width: 0; flex: 1; }
            .acc-dot { width: 6px; height: 6px; border-radius: 50%; background: #5e5e5e; flex-shrink: 0; }
            .acc-row.current .acc-dot { background: #6dd58c; box-shadow: 0 0 5px rgba(109, 213, 140, 0.7); }
            .acc-name { color: #e3e3e3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 126px; }
            .acc-row-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
            .acc-metric { display: inline-flex; align-items: baseline; gap: 2px; }
            .acc-k { color: #8e918f; font-size: 10px; }
            .acc-v { font-weight: 600; color: #6dd58c; }
            .acc-v.level-warn { color: #fcc934; }
            .acc-v.level-danger { color: #ff6b6b; }
            .acc-cd { color: #9aa0a6; font-size: 10px; margin-left: 1px; }
            .settings-box { background: #232426; border-radius: 8px; padding: 6px 10px; display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: #c4c7c5; }
            .settings-row { display: flex; justify-content: space-between; align-items: center; }
            .num-input { width: 42px; background: #1e1f20; color: #e3e3e3; border: 1px solid #5e5e5e; border-radius: 4px; padding: 2px 4px; font-size: 11px; text-align: center; }
            .pop-footer {
                display: flex; justify-content: space-between; align-items: center; gap: 8px;
                border-top: 1px solid #333537; padding-top: 7px; font-size: 11px; color: #9aa0a6;
            }
            .pop-status {
                flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
                text-overflow: ellipsis; font-variant-numeric: tabular-nums;
            }
            .ctrl-row { display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap; }
            select, input[type="checkbox"] { background: #282a2c; color: #e3e3e3; border: 1px solid #5e5e5e; border-radius: 4px; font-size: 11px; padding: 2px 4px; cursor: pointer; }
        `
    });

    function createQuotaCard(titleText) {
        const box = el('div', { class: 'quota-box' });
        const pct = el('span', { class: 'quota-pct', text: '已使用 --%' });
        const bar = el('div', { class: 'bar-fill', style: { width: '0%' } });
        const reset = el('div', { class: 'quota-reset', text: '正在计算倒计时...' });
        box.append(
            el('div', { class: 'quota-row' }, [el('strong', { text: titleText }), pct]),
            el('div', { class: 'bar-track' }, [bar]),
            reset
        );
        return { box, pct, bar, reset };
    }

    const planBadge = el('span', { class: 'badge', text: 'PRO' });
    const accountBadge = el('span', { class: 'acc-tag', title: currentCtx.email || currentCtx.accountId, text: currentCtx.displayLabel });
    const popRefreshBtn = el('button', {
        class: 'refresh-btn',
        title: '左键：刷新当前账号 | Shift + 左键：强制后台标签页刷新',
        text: '↻ 当前',
        onClick: (e) => triggerUsageSync(!!e.shiftKey)
    });
    const openUsageLink = el('a', { class: 'pop-link', href: currentCtx.usageUrl, target: '_blank', text: '原生页 ↗' });

    const curCard = createQuotaCard('当前用量 (5h 周期)');
    const weekCard = createQuotaCard('每周限额');

    const multiAccTitleSpan = el('span', { text: '多账号配额总览 (1)' });
    const syncAllAccountsBtn = el('button', {
        class: 'sync-all-btn',
        title: '无需切换页面，并发探测并同步所有已登录 Google 账号 (u0~u4) 的最新配额',
        text: '↻ 全量同步',
        onClick: (e) => { e.stopPropagation(); triggerAllAccountsSync(); }
    });
    const clearOtherAccBtn = el('button', {
        class: 'mini-btn',
        title: '仅保留当前账号，清理其他历史账号缓存记录',
        text: '清理其他',
        onClick: (e) => {
            e.stopPropagation();
            const reg = readAccountRegistry();
            writeAccountRegistry(reg[currentCtx.accountId] ? { [currentCtx.accountId]: reg[currentCtx.accountId] } : {});
            renderMultiAccountList();
        }
    });
    const multiAccListEl = el('div', { class: 'multi-acc-list' });
    const multiAccSection = el('div', { class: 'multi-acc-section' }, [
        el('div', { class: 'multi-acc-header' }, [multiAccTitleSpan, el('div', { class: 'multi-acc-actions' }, [syncAllAccountsBtn, clearOtherAccBtn])]),
        multiAccListEl
    ]);

    const warnInput = el('input', {
        type: 'number', class: 'num-input', min: '10', max: '95', value: String(config.warnThreshold),
        onChange: (e) => {
            config.warnThreshold = Math.max(5, Math.min(95, parseInt(e.target.value, 10) || 70));
            saveConfig();
            if (lastMetricsData) renderMetricsToUI(lastMetricsData);
        }
    });
    const dangerInput = el('input', {
        type: 'number', class: 'num-input', min: '20', max: '99', value: String(config.dangerThreshold),
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
                el('span', { style: { color: '#fcc934' }, text: '预警≥' }), warnInput,
                el('span', { style: { color: '#ff6b6b' }, text: '高危≥' }), dangerInput
            ])
        ])
    ]);

    const popUpdatedText = el('span', { class: 'pop-status', text: '等待同步...', title: `版本: ${SCRIPT_VERSION}` });
    function setFooterStatus(text, channelStr = '') {
        const display = text.includes(SCRIPT_VERSION) ? text : `${text} · ${SCRIPT_VERSION}`;
        popUpdatedText.textContent = display;
        popUpdatedText.title = channelStr ? `${display} | 通道: ${channelStr}` : display;
    }

    const intervalSelect = el('select', {
        title: '定时刷新频率',
        onChange: (e) => {
            config.intervalSec = parseInt(e.target.value, 10);
            saveConfig();
            setupAutoRefresh();
        }
    }, [
        el('option', { value: '0', text: '定时刷新: 关' }),
        el('option', { value: '60', text: '定时刷新: 1m' }),
        el('option', { value: '300', text: '定时刷新: 5m' }),
        el('option', { value: '900', text: '定时刷新: 15m' })
    ]);
    intervalSelect.value = String(config.intervalSec);

    const sendTriggerChk = el('input', {
        type: 'checkbox',
        onChange: (e) => { config.refreshOnSend = e.target.checked; saveConfig(); }
    });
    sendTriggerChk.checked = !!config.refreshOnSend;

    const popover = el('div', { class: 'popover' }, [
        el('div', { class: 'pop-header' }, [
            el('div', { class: 'pop-title' }, [el('span', { text: '用量监控' }), planBadge, accountBadge]),
            el('div', { class: 'header-actions' }, [popRefreshBtn, openUsageLink])
        ]),
        curCard.box,
        weekCard.box,
        multiAccSection,
        settingsBox,
        el('div', { class: 'pop-footer' }, [
            popUpdatedText,
            el('div', { class: 'ctrl-row' }, [
                el('label', { style: { display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' } }, [sendTriggerChk, el('span', { text: '回答完刷新' })]),
                intervalSelect
            ])
        ])
    ]);

    popoverShadow.append(popoverStyle, popover);

    function updatePopoverPosition() {
        const rect = pill.getBoundingClientRect();
        popover.style.left = `${Math.max(12, Math.min(window.innerWidth - 360, rect.left))}px`;
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
        if (e.altKey && (e.ctrlKey || e.metaKey)) return triggerAllAccountsSync();
        if (e.altKey) return triggerUsageSync(!!e.shiftKey);
        if (popover.classList.toggle('open')) {
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
        if (!path.includes(pillHost) && !path.includes(popoverHost)) popover.classList.remove('open');
    });

    // =========================================================================
    // 4. 多账号同屏列表渲染与自适应省电倒计时
    // =========================================================================
    let lastMetricsData = null;
    let lastAutoResetSyncAt = 0;
    let countdownTimerId = null;

    function getLevelTag(level) {
        return level === 'danger' ? ' [额度告急]' : (level === 'warn' ? ' [接近限额]' : '');
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

            let syncInfo = '尚未同步';
            if (item.timestamp) {
                const timeStr = new Date(item.timestamp).toTimeString().slice(0, 8);
                const diffSec = Math.max(0, Math.floor((Date.now() - item.timestamp) / 1000));
                const ageStr = diffSec < 5
                    ? '刚刚'
                    : (diffSec < 60
                        ? `${diffSec}秒前`
                        : (diffSec < 3600 ? `${Math.floor(diffSec / 60)}分钟前` : `${Math.floor(diffSec / 3600)}小时前`));
                syncInfo = `更新于 ${timeStr} (${ageStr})`;
            }

            multiAccListEl.appendChild(el('div', {
                class: `acc-row${isCur ? ' current' : ''}`,
                title: isCur
                    ? `${item.email || item.accountId} | ${syncInfo}\n(当前账号，点击立即刷新)`
                    : `${item.email || item.accountId} | ${syncInfo}\n(左键打开对话页 | Alt+左键打开用量页)`,
                onClick: (e) => {
                    e.stopPropagation();
                    if (isCur) triggerUsageSync(!!e.shiftKey);
                    else window.open(e.altKey ? (item.usageUrl || '/usage') : (item.appUrl || '/app'), '_blank');
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
                        el('span', { class: 'acc-cd', 'data-reset-at': cResetAt ? String(cResetAt) : '', text: cdStr ? `(${cdStr})` : '' })
                    ]),
                    el('span', { class: 'acc-metric' }, [
                        el('span', { class: 'acc-k', text: '周' }),
                        el('span', { class: `acc-v level-${wLevel}`, text: wPct !== null ? `${wPct}%` : '--%' })
                    ])
                ])
            ]));
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
        setFooterStatus(`切换至 ${currentCtx.slotTag}，同步中...`);
        renderMultiAccountList();
    }

    function applyCardMetrics(card, valTextEl, pct, level) {
        if (pct === null) return;
        valTextEl.textContent = `${pct}%`;
        valTextEl.className = `metric-val level-${level}`;
        card.box.className = `quota-box level-${level}`;
        card.pct.textContent = `已使用 ${pct}%${getLevelTag(level)}`;
        card.pct.className = `quota-pct level-${level}`;
        card.bar.style.width = `${Math.min(100, pct)}%`;
        card.bar.className = `bar-fill level-${level}`;
    }

    function renderMetricsToUI(data) {
        if (!data || !data.current || !data.weekly) return;

        refreshAccountContextIfNeeded();
        upsertRegistryEntry(data);
        if (popover.classList.contains('open')) renderMultiAccountList();
        if (data.accountId && data.accountId !== currentCtx.accountId) return;

        const refTs = data.timestamp || Date.now();
        if (!data.current.resetAt && data.current.resetText) data.current.resetAt = parseResetToEpoch(data.current.resetText, refTs);
        if (!data.weekly.resetAt && data.weekly.resetText) data.weekly.resetAt = parseResetToEpoch(data.weekly.resetText, refTs);

        lastMetricsData = data;
        const curPct = data.current.pct;
        const weekPct = data.weekly.pct;
        const curLevel = getSeverityLevel(curPct);
        const weekLevel = getSeverityLevel(weekPct);
        const overallLevel = getSeverityLevel(Math.max(curPct ?? 0, weekPct ?? 0));

        if (!isSyncing && !isBatchSyncing) syncDot.classList.remove('loading');
        pill.className = `usage-pill level-${overallLevel}`;
        planBadge.textContent = data.badgeStr || 'PRO';
        accountBadge.textContent = currentCtx.displayLabel;
        accountBadge.title = currentCtx.email || currentCtx.accountId;

        if (curPct !== null) {
            bottomProgress.style.width = `${Math.min(100, curPct)}%`;
            bottomProgress.className = `bottom-progress level-${curLevel}`;
        }
        applyCardMetrics(curCard, curValText, curPct, curLevel);
        applyCardMetrics(weekCard, weekValText, weekPct, weekLevel);

        const timeStr = (data.timestamp ? new Date(data.timestamp) : new Date()).toTimeString().slice(0, 8);
        if (!isBatchSyncing) {
            const isValidChannel = data.updatedStr && !/刚刚|just\s*now|updated/i.test(data.updatedStr);
            setFooterStatus(`更新于 ${timeStr}`, isValidChannel ? data.updatedStr : 'DOM水合');
        }
        scheduleNextTick(true);
    }

    function scheduleNextTick(immediate = false) {
        if (countdownTimerId) { clearTimeout(countdownTimerId); countdownTimerId = null; }
        if (document.visibilityState === 'hidden' || !lastMetricsData) return;
        if (immediate) return runTickStep();

        const isPopOpen = popover.classList.contains('open');
        const curResetAt = lastMetricsData.current && lastMetricsData.current.resetAt;
        const remMs = curResetAt ? (curResetAt - Date.now()) : Infinity;
        countdownTimerId = setTimeout(runTickStep, (isPopOpen || (remMs > 0 && remMs <= 3600000)) ? 1000 : 15000);
    }

    function runTickStep() {
        if (!lastMetricsData || document.visibilityState === 'hidden') return;
        const { current: cur, weekly: week } = lastMetricsData;
        const isPopOpen = popover.classList.contains('open');

        if (cur) {
            const nextCompact = formatUltraCompactCountdown(cur.resetAt);
            if (curCountdownText.textContent !== nextCompact) curCountdownText.textContent = nextCompact;
            if (isPopOpen) curCard.reset.textContent = formatDetailedCountdown(cur.resetAt, cur.rawClock);
        }
        if (week && isPopOpen) {
            weekCard.reset.textContent = formatDetailedCountdown(week.resetAt, week.rawClock);
        }
        if (isPopOpen) {
            for (const node of multiAccListEl.querySelectorAll('.acc-cd[data-reset-at]')) {
                const ts = parseInt(node.getAttribute('data-reset-at'), 10);
                if (ts) {
                    const s = formatUltraCompactCountdown(ts);
                    node.textContent = s ? `(${s})` : '';
                }
            }
        }

        const now = Date.now();
        if (cur && cur.resetAt && now >= cur.resetAt && now - cur.resetAt < 20000 && now - lastAutoResetSyncAt > 90000) {
            lastAutoResetSyncAt = now;
            triggerUsageSync(false);
        }
        scheduleNextTick(false);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleNextTick(true);
        else if (countdownTimerId) { clearTimeout(countdownTimerId); countdownTimerId = null; }
    });

    function loadCachedDataForCurrentAccount() {
        const parsed = readStore(currentCtx.storageKey);
        if (parsed && (!parsed.accountId || parsed.accountId === currentCtx.accountId)) {
            renderMetricsToUI(parsed);
            return true;
        }
        return false;
    }

    let gmAccListenerId = null;
    function bindAccountStorageListener() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        if (gmAccListenerId !== null && typeof GM_removeValueChangeListener === 'function') {
            try { GM_removeValueChangeListener(gmAccListenerId); } catch (_) {}
        }
        gmAccListenerId = GM_addValueChangeListener(currentCtx.storageKey, (name, oldVal, newVal) => {
            if (name === currentCtx.storageKey && newVal) {
                try {
                    const parsed = JSON.parse(newVal);
                    if (parsed.accountId === currentCtx.accountId) renderMetricsToUI(parsed);
                } catch (_) {}
            }
        });
    }
    bindAccountStorageListener();

    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(REGISTRY_KEY, () => {
            if (popover.classList.contains('open')) renderMultiAccountList();
        });
    }

    if (bc) {
        bc.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'GEMINI_HUD_DATA' && e.data.payload) {
                refreshAccountContextIfNeeded();
                upsertRegistryEntry(e.data.payload);
                if (popover.classList.contains('open')) renderMultiAccountList();
                if (e.data.payload.accountId === currentCtx.accountId) renderMetricsToUI(e.data.payload);
            }
        });
    }

    window.addEventListener('storage', (e) => {
        refreshAccountContextIfNeeded();
        if (e.key === REGISTRY_KEY && popover.classList.contains('open')) renderMultiAccountList();
        if (e.key === currentCtx.storageKey && e.newValue) {
            try {
                const parsed = JSON.parse(e.newValue);
                if (parsed.accountId === currentCtx.accountId) renderMetricsToUI(parsed);
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
                if (!loadCachedDataForCurrentAccount()) triggerUsageSync(false);
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

    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin || !e.data || e.data.type !== 'GEMINI_HUD_RPC_CAPTURE') return;
        const { bl, rpcs, domMetrics } = e.data;
        if (!Array.isArray(rpcs) || !domMetrics) return;

        for (const item of rpcs) {
            for (const entry of unwrapBatchExecutePayloads(item.response)) {
                const coords = findCalibrationPaths(entry.data, domMetrics);
                const fReqMatch = coords && item.body.match(/(?:^|&)f\.req=([^&]+)/);
                if (fReqMatch) {
                    writeStore(GLOBAL_RPC_PROFILE_KEY, {
                        bl: bl || currentCtx.bl,
                        rpcId: entry.rpcId,
                        url: item.url,
                        fReqEncoded: fReqMatch[1],
                        coords,
                        badgeStr: domMetrics.badgeStr || 'PRO'
                    });
                    return;
                }
            }
        }
    });

    async function tryCalibratedRpcReplay(ctx) {
        if (!ctx || !ctx.atToken) return null;
        const profile = readStore(GLOBAL_RPC_PROFILE_KEY);
        if (!profile || !profile.url || !profile.fReqEncoded || !profile.coords) return null;
        if (ctx.bl && profile.bl && ctx.bl !== profile.bl) return null;

        try {
            const reqUrl = new URL(profile.url, window.location.origin);
            reqUrl.pathname = reqUrl.pathname.replace(/^(\/u\/\d+)?\/_\/BardChatUi\//, `/u/${ctx.slotIndex}/_/BardChatUi/`);
            reqUrl.searchParams.set('source-path', `/u/${ctx.slotIndex}/usage`);
            reqUrl.searchParams.set('_reqid', String(Math.floor(100000 + Math.random() * 900000)));
            if (reqUrl.searchParams.has('authuser')) reqUrl.searchParams.set('authuser', String(ctx.slotIndex));

            const resp = await fetch(reqUrl.toString(), {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: `f.req=${profile.fReqEncoded}&at=${encodeURIComponent(ctx.atToken)}&`
            });
            if (!resp.ok) return null;
            const target = unwrapBatchExecutePayloads(await resp.text()).find(u => u.rpcId === profile.rpcId);
            return target ? buildMetricsFromCalibratedTree(target.data, profile.coords, ctx, 'RPC直连', profile.badgeStr) : null;
        } catch (_) {
            return null;
        }
    }

    const IN_VIEWPORT_STEALTH_STYLE = {
        position: 'fixed', right: '0px', bottom: '0px', width: '320px', height: '220px',
        opacity: '0.01', pointerEvents: 'none', zIndex: '-1', border: 'none'
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

        const passThroughRules = { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s };
        for (const name of ['angular#unsafe-bypass', 'default', 'angular', 'polymer-html-literal']) {
            try { return win.trustedTypes.createPolicy(name, passThroughRules); } catch (_) {}
        }
        return null;
    }

    function hydrateViaVirtualBlankAsync(rawHtml, ctx) {
        return new Promise((resolve) => {
            if (!rawHtml) return resolve(null);

            cleanupActiveFrame();
            activeFrame = el('iframe', { style: IN_VIEWPORT_STEALTH_STYLE });
            document.body.appendChild(activeFrame);

            try {
                const win = activeFrame.contentWindow;
                const doc = activeFrame.contentDocument;
                if (!win || !doc) {
                    cleanupActiveFrame();
                    return resolve(null);
                }

                const hostNonceScript = document.querySelector('script[nonce]');
                const activeNonce = hostNonceScript ? (hostNonceScript.nonce || hostNonceScript.getAttribute('nonce') || '') : '';
                let patchedHtml = activeNonce ? rawHtml.replace(/nonce="[^"]*"/g, `nonce="${activeNonce}"`) : rawHtml;
                const baseTag = /<base\s/i.test(patchedHtml) ? '' : `<base href="${window.location.origin}/">`;
                patchedHtml = patchedHtml.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);

                doc.open();
                try { win.history.replaceState(null, '', ctx.usageUrl); } catch (_) {}
                const ttPolicy = installIdempotentTrustedTypesProxy(win);
                doc.write(ttPolicy ? ttPolicy.createHTML(patchedHtml) : patchedHtml);
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
                    if (!activeFrame) return finish(null);
                    const data = extractMetricsFromDoc(activeFrame.contentDocument, ctx);
                    if (data) finish(data);
                }, 150);

                const timeoutTimer = setTimeout(() => {
                    const finalDoc = activeFrame && activeFrame.contentDocument;
                    finish(finalDoc ? extractMetricsFromDoc(finalDoc, ctx) : null);
                }, 8000);
            } catch (_) {
                cleanupActiveFrame();
                resolve(null);
            }
        });
    }

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
                if (e.origin !== window.location.origin || !e.data || e.data.type !== 'GEMINI_HUD_DATA' || !e.data.payload) return;
                finish(Object.assign({}, e.data.payload, {
                    accountId: ctx.accountId,
                    slotIndex: ctx.slotIndex,
                    slotTag: ctx.slotTag,
                    email: ctx.email || e.data.payload.email,
                    displayLabel: ctx.displayLabel,
                    usageUrl: ctx.usageUrl,
                    appUrl: ctx.appUrl
                }), false);
            };
            window.addEventListener('message', onMsg);

            activeFrame = el('iframe', {
                src: `${ctx.usageUrl}?hud_worker=iframe&hud_acc=${encodeURIComponent(ctx.accountId)}&hud_slot=${ctx.slotIndex}&_t=${Date.now()}`,
                style: IN_VIEWPORT_STEALTH_STYLE
            });
            document.body.appendChild(activeFrame);

            const pollTimer = setInterval(() => {
                if (!activeFrame) return finish(null, false);
                if (directIframeBlockedByCSP) return finish(null, true);
                try {
                    const doc = activeFrame.contentDocument;
                    const data = doc && extractMetricsFromDoc(doc, ctx);
                    if (data) finish(data, false);
                } catch (_) {
                    directIframeBlockedByCSP = true;
                    finish(null, true);
                }
            }, 150);

            const timeoutTimer = setTimeout(() => {
                try {
                    const finalDoc = activeFrame && activeFrame.contentDocument;
                    const finalData = finalDoc ? extractMetricsFromDoc(finalDoc, ctx) : null;
                    if (finalData) return finish(finalData, false);
                } catch (_) {}
                finish(null, !!fallbackHtml);
            }, 6000);
        });
    }

    function openManualFallbackTab(ctx) {
        const workerUrl = `${ctx.usageUrl}?hud_worker=tab&hud_acc=${encodeURIComponent(ctx.accountId)}&hud_slot=${ctx.slotIndex}&_t=${Date.now()}`;
        if (typeof GM_openInTab === 'function') {
            GM_openInTab(workerUrl, { active: false, insert: true, setParent: true });
            setTimeout(() => { syncDot.classList.remove('loading'); isSyncing = false; }, 6000);
        } else {
            syncDot.classList.remove('loading');
            setFooterStatus('未授权 GM_openInTab');
            isSyncing = false;
        }
    }

    async function triggerUsageSync(forceBgTab = false) {
        refreshAccountContextIfNeeded();
        if (isSyncing || isBatchSyncing) return;
        isSyncing = true;
        syncDot.classList.add('loading');

        const ctx = currentCtx;
        openUsageLink.href = ctx.usageUrl;
        setFooterStatus(`同步中 (${ctx.slotTag})...`);

        if (forceBgTab) return openManualFallbackTab(ctx);

        try {
            const replayData = await tryCalibratedRpcReplay(ctx);
            if (replayData) {
                publishUsageData(replayData);
                renderMetricsToUI(replayData);
                return;
            }

            let html = '';
            try {
                const resp = await fetch(ctx.usageUrl, { credentials: 'include', cache: 'no-store' });
                if (resp.ok && !resp.url.includes('accounts.google.com')) html = await resp.text();
            } catch (_) {}

            if (html) {
                const fastData = parseMetricsFromRawHtml(html, ctx);
                if (fastData) {
                    publishUsageData(fastData);
                    renderMetricsToUI(fastData);
                    return;
                }
            }

            const hydratedData = await hydrateAccountInStealthFrameAsync(ctx, html);
            if (hydratedData) {
                publishUsageData(hydratedData);
                renderMetricsToUI(hydratedData);
            } else if (!lastMetricsData) {
                setFooterStatus('同步超时');
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
        try {
            const resp = await fetch(`${window.location.origin}/u/${slotIdx}/usage`, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok || (resp.url && resp.url.includes('accounts.google.com'))) return null;
            const html = await resp.text();
            if (!html) return null;
            const wiz = extractWizFromRawHtml(html);
            if (!wiz.email && !wiz.gaiaId) return null;
            return { slotCtx: buildContextFromWizAndSlot(wiz, slotIdx), html };
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
        setFooterStatus('全量探测账号中...');

        try {
            const reg = readAccountRegistry();
            const candidateSlots = new Set([currentCtx.slotIndex]);
            for (const item of Object.values(reg)) {
                if (Number.isInteger(item.slotIndex)) candidateSlots.add(item.slotIndex);
            }
            for (let i = 0; i <= MAX_PROBE_SLOT; i++) candidateSlots.add(i);

            const probeResults = await Promise.all(Array.from(candidateSlots).sort((a, b) => a - b).map(probeSlotHtmlAndContext));
            const validTargets = [];
            const seenAccountIds = new Set();

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
                setFooterStatus(`全量同步 ${completedCount}/${total}...`);
            };
            updateProgressUI();

            await Promise.all(validTargets.map(async ({ slotCtx, html }) => {
                let data = parseMetricsFromRawHtml(html, slotCtx) || (slotCtx.atToken ? await tryCalibratedRpcReplay(slotCtx) : null);
                if (data) {
                    completedCount++;
                    publishUsageData(data);
                    renderMetricsToUI(data);
                    updateProgressUI();
                } else {
                    hydrationQueue.push({ slotCtx, html });
                }
            }));

            for (const item of hydrationQueue) {
                const newlyCalibrated = parseMetricsFromRawHtml(item.html, item.slotCtx);
                const finalData = newlyCalibrated || await hydrateAccountInStealthFrameAsync(item.slotCtx, item.html);
                completedCount++;
                if (finalData) {
                    publishUsageData(finalData);
                    renderMetricsToUI(finalData);
                }
                updateProgressUI();
            }

            setFooterStatus(`全量更新(${total}) · ${new Date().toTimeString().slice(0, 8)}`, '多账号并发同步');
            renderMultiAccountList();
        } finally {
            isBatchSyncing = false;
            syncDot.classList.remove('loading');
            syncAllAccountsBtn.classList.remove('busy');
            syncAllAccountsBtn.textContent = '↻ 全量同步';
        }
    }

    // =========================================================================
    // 7. O(1) 状态栏挂载与精准提问发送拦截（排除模型切换器）
    // =========================================================================
    let mountScheduled = false;

    function mountIntoInputBar() {
        mountScheduled = false;
        if (!pillHost.isConnected) {
            const leadingWrapper = document.querySelector(
                'fieldset.input-area-fieldset .leading-actions-wrapper, ' +
                '.text-input-field .leading-actions-wrapper, ' +
                'chat-input .input-area-container .leading-actions-wrapper, ' +
                'div[role="textbox"] ~ * .leading-actions-wrapper, ' +
                'footer .input-buttons-wrapper-bottom, ' +
                'fieldset div[class*="leading-actions"]'
            );
            if (leadingWrapper) leadingWrapper.appendChild(pillHost);
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

    let sendDebounceTimer = null;
    function schedulePostSendRefresh(delayMs = 1200) {
        if (!config.refreshOnSend) return;
        if (sendDebounceTimer) clearTimeout(sendDebounceTimer);
        sendDebounceTimer = setTimeout(() => triggerUsageSync(false), delayMs);
    }

    // 监测“停止生成”按钮从出现到消失，精准判定回答输出完毕
    let answerWatchTimer = null;
    function waitForAnswerCompletion() {
        if (!config.refreshOnSend) return;
        if (answerWatchTimer) clearInterval(answerWatchTimer);

        let seenGenerating = false;
        const startAt = Date.now();

        answerWatchTimer = setInterval(() => {
            const elapsed = Date.now() - startAt;
            const isGenerating = !!document.querySelector(
                '[data-mat-icon-name="stop"], button[aria-label*="Stop"], button[aria-label*="停止"], .stop-icon'
            );

            if (isGenerating) {
                seenGenerating = true;
            } else if (seenGenerating) {
                // 生成状态已结束（回答完成或手动中止），触发配额刷新
                clearInterval(answerWatchTimer);
                answerWatchTimer = null;
                schedulePostSendRefresh(1200);
            } else if (elapsed > 10000) {
                // 10秒内未进入生成态（未发出请求或已被 XHR loadend 捕获），结束轮询
                clearInterval(answerWatchTimer);
                answerWatchTimer = null;
            }

            if (elapsed > 300000) {
                clearInterval(answerWatchTimer);
                answerWatchTimer = null;
            }
        }, 300);
    }

    function isSendButtonElement(btn) {
        if (!btn) return false;
        if (
            btn.closest('bard-mode-switcher, [data-test-id*="bard-mode"], [data-test-id*="model"], speech-dictation-mic-button') ||
            btn.hasAttribute('aria-haspopup') ||
            btn.querySelector('[data-mat-icon-name="mic"], [data-mat-icon-name="stop"], [data-mat-icon-name="expand_more"], [data-mat-icon-name="keyboard_arrow_down"]')
        ) {
            return false;
        }
        const aria = (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('mattooltip') || '');
        return (
            btn.classList.contains('send-button') ||
            !!btn.closest('send-button, .send-button-container') ||
            !!btn.querySelector('[data-mat-icon-name="send"], .send-button-icon') ||
            /发送|Send|Submit/i.test(aria)
        );
    }

    window.addEventListener('click', (e) => {
        setTimeout(refreshAccountContextIfNeeded, 120);
        if (!config.refreshOnSend || !e.target || typeof e.target.closest !== 'function') return;
        const btn = e.target.closest('button');
        if (btn && isSendButtonElement(btn)) {
            waitForAnswerCompletion();
        }
    }, true);

    window.addEventListener('keydown', (e) => {
        if (!config.refreshOnSend) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target && typeof e.target.closest === 'function') {
            const editor = e.target.closest('.ql-editor, rich-textarea');
            if (editor && editor.textContent.trim().length > 0) {
                waitForAnswerCompletion();
            }
        }
    }, true);

    if (pageWin.XMLHttpRequest && !pageWin.XMLHttpRequest.__geminiHudHooked) {
        const origOpen = pageWin.XMLHttpRequest.prototype.open;
        pageWin.XMLHttpRequest.prototype.open = function (method, url) {
            if (typeof url === 'string' && url.includes('StreamGenerate')) {
                this.addEventListener('loadend', () => schedulePostSendRefresh(1200));
            }
            return origOpen.apply(this, arguments);
        };
        pageWin.XMLHttpRequest.__geminiHudHooked = true;
    }

    let autoRefreshTimer = null;
    function setupAutoRefresh() {
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
        if (config.intervalSec > 0) {
            autoRefreshTimer = setInterval(() => {
                if (document.visibilityState === 'visible') triggerUsageSync(false);
            }, config.intervalSec * 1000);
        }
    }

    loadCachedDataForCurrentAccount();
    renderMultiAccountList();
    triggerUsageSync(false);
    setupAutoRefresh();
})();