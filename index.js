// SillyTavern Bookmark extension
// Drag text in chat -> save as bookmark. Bookmarks live in a separate server file
// (user files: st-bookmarks.json) so they survive chat deletion / regeneration.

const MODULE = 'st_bookmark';
const DATA_FILE = 'st-bookmarks.json';
const LS_MIRROR = 'st_bookmark_mirror';
const BUBBLE_ID = 'llm-pl-bubble'; // LLM Translator "paragraph original" bubble (optional integration)

const defaultSettings = Object.freeze({
    enabled: true,
    entry: 'both',          // 'input' | 'wand' | 'both'
    view: 'thread',         // 'thread' | 'blog'
    font: 'pretendard',
    fontSize: 15,
    lineHeight: 1.75,
    cut: 20,
    cardRatio: '45',        // '45' | '11'
    cardWithPair: true,
    cardReplace: [],        // [{ from, to }] applied only when drawing cards
    cardReplaceOn: true,
    chatGroupOrder: 'new',  // character tab: newest chat first | 'old'
});

const FONTS = {
    pretendard: { label: '프리텐다드', family: '"Pretendard", "Pretendard Variable"', css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css', fallback: 'sans-serif' },
    ridibatang: { label: '리디바탕', family: '"RIDIBatang"', face: '@font-face{font-family:"RIDIBatang";src:url("https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff") format("woff");font-weight:normal;font-style:normal;font-display:swap}', fallback: 'serif' },
    maruburi: { label: '마루부리', family: '"MaruBuri"', css: 'https://hangeul.pstatic.net/hangeul_static/css/maru-buri.css', fallback: 'serif' },
    nanummyeongjo: { label: '나눔명조', family: '"Nanum Myeongjo"', css: 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap', fallback: 'serif' },
    notoserif: { label: '본명조 (Noto Serif KR)', family: '"Noto Serif KR"', css: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600&display=swap', fallback: 'serif' },
    system: { label: '시스템 기본', family: 'system-ui', fallback: 'sans-serif' },
};

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- settings
function S() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = JSON.parse(JSON.stringify(defaultSettings));
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(defaultSettings)) if (!Object.prototype.hasOwnProperty.call(s, k)) s[k] = JSON.parse(JSON.stringify(defaultSettings[k]));
    return s;
}
function saveSettings() { ctx().saveSettingsDebounced(); }

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
    const d = new Date(t);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseSendDate(v) {
    if (!v) return null;
    try {
        const m = ctx().timestampToMoment?.(v);
        if (m && m.isValid && m.isValid()) return m.valueOf();
    } catch { /* ignore */ }
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toast(type, msg) { try { toastr[type](msg, '', { timeOut: 2200 }); } catch { console.log('[Bookmark]', msg); } }
function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
function stamp() { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; }

// ---------------------------------------------------------------- storage
// db = { version, items: Bookmark[], deleted: { [id]: time } }
let db = null;
let loadFailed = false;
let saveChain = Promise.resolve();
let saveTimer = null;

function emptyDb() { return { version: 1, items: [], deleted: {} }; }
function normalizeDb(d) {
    if (!d || typeof d !== 'object') return emptyDb();
    return { version: 1, items: Array.isArray(d.items) ? d.items.filter(x => x && x.id && typeof x.text === 'string') : [], deleted: (d.deleted && typeof d.deleted === 'object') ? d.deleted : {} };
}

async function fetchRemote() {
    const res = await fetch(`/user/files/${DATA_FILE}?t=${Date.now()}`, { cache: 'no-store', headers: ctx().getRequestHeaders?.() ?? {} });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return normalizeDb(await res.json());
}

async function loadDb() {
    if (db) return db;
    try {
        const remote = await fetchRemote();
        if (remote) db = remote;
        else {
            // no server file yet: restore from this browser's mirror if present
            let mirror = null;
            try { mirror = JSON.parse(localStorage.getItem(LS_MIRROR) || 'null'); } catch { /* ignore */ }
            db = normalizeDb(mirror);
            if (db.items.length) scheduleSave(0);
        }
        loadFailed = false;
    } catch (e) {
        console.error('[Bookmark] load failed', e);
        loadFailed = true;
        db = null;
        throw e;
    }
    return db;
}

// Union merge so two devices never wipe each other's bookmarks.
function mergeDb(a, b) {
    const deleted = { ...a.deleted, ...b.deleted };
    const map = new Map();
    for (const it of [...a.items, ...b.items]) {
        if (deleted[it.id]) continue;
        const cur = map.get(it.id);
        if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) map.set(it.id, it);
        if (cur && (cur.gone || it.gone)) map.get(it.id).gone = true;
    }
    return { version: 1, items: [...map.values()], deleted };
}

function scheduleSave(delay = 600) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveChain = saveChain.then(saveNow).catch(e => console.error('[Bookmark] save failed', e)); }, delay);
}

async function saveNow() {
    if (!db || loadFailed) return;
    try {
        const remote = await fetchRemote();
        if (remote) db = mergeDb(remote, db);
    } catch (e) {
        toast('error', '북마크 파일을 읽지 못해 저장을 미뤘어요. 잠시 후 다시 시도합니다.');
        scheduleSave(5000);
        return;
    }
    // prune old tombstones (90 days)
    const cutoff = Date.now() - 90 * 864e5;
    for (const [id, t] of Object.entries(db.deleted)) if (t < cutoff) delete db.deleted[id];
    const json = JSON.stringify(db);
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name: DATA_FILE, data: utf8ToBase64(json) }),
    });
    if (!res.ok) { toast('error', '북마크를 저장하지 못했어요.'); scheduleSave(5000); return; }
    try { localStorage.setItem(LS_MIRROR, json); } catch { /* quota: ignore */ }
    if (panelOpen && !isEditing()) render();
}

function touch(item) { item.updatedAt = Date.now(); scheduleSave(); }

// ---------------------------------------------------------------- chat info
function currentChatInfo() {
    const c = ctx();
    if (c.groupId) {
        const g = (c.groups || []).find(x => x.id === c.groupId);
        if (!g) return null;
        return { ownerKey: 'g:' + g.id, ownerName: g.name, isGroup: true, chatId: g.chat_id ?? c.getCurrentChatId?.() };
    }
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return { ownerKey: 'c:' + ch.avatar, ownerName: ch.name, isGroup: false, chatId: ch.chat ?? c.getCurrentChatId?.() };
}
const curChatId = () => currentChatInfo()?.chatId ?? null;

// Find the message index of a bookmark in the current chat, or -1.
function locate(b) {
    const chat = ctx().chat || [];
    if (b.sendDate) {
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.send_date === b.sendDate) {
                const d = Math.abs(i - (b.mesId ?? i));
                if (d < bestDist) { best = i; bestDist = d; }
            }
        }
        return best;
    }
    return (b.mesId != null && b.mesId < chat.length) ? b.mesId : -1;
}

function isMissing(b) {
    if (b.gone) return true;
    if (b.chatId && b.chatId === curChatId()) return locate(b) < 0;
    return !!b.lost;
}

// Refresh soft "lost" flags for bookmarks of the chat just opened.
function refreshLostFlags() {
    if (!db) return;
    const id = curChatId();
    if (!id) return;
    let changed = false;
    for (const b of db.items) {
        if (b.chatId !== id) continue;
        const lost = locate(b) < 0;
        if (!!b.lost !== lost) { b.lost = lost; changed = true; }
    }
    if (changed) scheduleSave(2000);
}

function markChatGone(chatId) {
    if (!db || !chatId) return;
    const name = String(chatId).replace(/\.jsonl$/, '');
    let changed = false;
    for (const b of db.items) if (b.chatId === name && !b.gone) { b.gone = true; b.updatedAt = Date.now(); changed = true; }
    if (changed) { scheduleSave(); if (panelOpen) render(); }
}

// ---------------------------------------------------------------- selection popup
let selPop = null;
let pending = null;          // { text, source, mesId, offset, para }
let popBusy = false;
let lastTappedMes = null;    // for the translator bubble, which doesn't carry mesid
let lastSavedId = null;      // for "↳ 연결"
let linkTargetId = null;     // link mode from ⋯ menu
let selTimer = null;

function getSelPop() {
    if (selPop) return selPop;
    selPop = document.createElement('div');
    selPop.id = 'stbm-sel';
    selPop.hidden = true;
    selPop.addEventListener('pointerdown', (e) => { popBusy = true; e.preventDefault(); });
    selPop.addEventListener('mousedown', (e) => e.preventDefault());
    selPop.addEventListener('click', onSelPopClick);
    return selPop;
}
function hideSelPop() { if (selPop) selPop.hidden = true; pending = null; popBusy = false; }

function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('#stbm-panel, #stbm-dialog')) return null;

    let container = el.closest('#chat .mes .mes_text');
    let source = 'chat', mesId = null, para = null;
    if (container) {
        mesId = Number(container.closest('.mes')?.getAttribute('mesid'));
    } else {
        container = el.closest(`#${BUBBLE_ID} .llm-pl-body`);
        if (!container) return null;
        source = 'bubble';
        mesId = lastTappedMes;
        const m = document.querySelector(`#${BUBBLE_ID} .llm-pl-title`)?.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) para = Number(m[1]);
    }
    if (mesId == null || isNaN(mesId)) return null;
    let offset = 0;
    try {
        const pre = document.createRange();
        pre.selectNodeContents(container);
        pre.setEnd(range.startContainer, range.startOffset);
        offset = pre.toString().length;
    } catch { /* ignore */ }
    return { text, source, mesId, offset, para, rect: range.getBoundingClientRect(), container };
}

function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
        if (!S().enabled && !linkTargetId) return;
        const info = readSelection();
        if (!info) { if (!popBusy) { selPop && (selPop.hidden = true); } return; }
        showSelPop(info);
    }, 280);
}

function linkCandidate(info) {
    if (linkTargetId) return db?.items.find(x => x.id === linkTargetId) || null;
    if (!lastSavedId || !db) return null;
    const b = db.items.find(x => x.id === lastSavedId);
    if (!b || b.pair || b.chatId !== curChatId() || b.mesId !== info.mesId || b.text === info.text) return null;
    return b;
}

function showSelPop(info) {
    const pop = getSelPop();
    pending = info;
    const cand = linkCandidate(info);
    let html = '';
    if (linkTargetId) html = `<button data-a="link">↳ 연결</button>`;
    else if (info.source === 'bubble') html = `<button data-a="save">＋ 추가</button>${cand ? '<button data-a="link">↳ 연결</button>' : ''}`;
    else html = `<button data-a="save">＋ 저장</button><button data-a="memo">✎ 메모</button>${cand ? '<button data-a="link">↳ 연결</button>' : ''}`;
    pop.innerHTML = html;
    // inside the translator bubble, mount into it so its outside-click handler doesn't close the bubble
    const host = (info.source === 'bubble' && document.getElementById(BUBBLE_ID)) || document.body;
    if (pop.parentElement !== host) host.appendChild(pop);
    pop.hidden = false;
    const touchDev = matchMedia('(pointer: coarse)').matches;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = info.rect.left + info.rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = info.rect.bottom + (touchDev ? 28 : 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, info.rect.top - h - (touchDev ? 28 : 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

async function onSelPopClick(e) {
    const btn = e.target.closest('button[data-a]');
    popBusy = false;
    if (!btn || !pending) return;
    const info = pending;
    const a = btn.dataset.a;
    hideSelPop();
    window.getSelection()?.removeAllRanges();
    try { await loadDb(); } catch { toast('error', '북마크 파일을 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.'); return; }
    if (a === 'link') {
        const target = linkCandidate(info);
        if (!target) return;
        target.pair = {
            text: info.text,
            kind: pairKind(target, info),
            para: info.para ?? null,
            mesId: info.mesId,
        };
        touch(target);
        const wasLinkMode = !!linkTargetId;
        setLinkMode(null);
        toast('success', '연결했어요');
        if (wasLinkMode) openPanel();
        return;
    }
    const b = makeBookmark(info);
    if (!b) { toast('warning', '채팅 정보를 찾지 못했어요.'); return; }
    db.items.push(b);
    delete db.deleted[b.id];
    lastSavedId = b.id;
    touch(b);
    toast('success', '북마크에 저장했어요');
    if (a === 'memo') { ui.editing = b.id; ui.open.add(b.id); if (ui.tab === 'set') ui.tab = 'all'; openPanel(); }
    else if (panelOpen) render();
}

// Which side is the attached text? Bubble = original. Otherwise guess by Hangul ratio.
function hangulRatio(t) {
    const letters = String(t).match(/[\p{L}]/gu) || [];
    if (!letters.length) return 0;
    return letters.filter(ch => /[\uAC00-\uD7A3\u3131-\u318E]/.test(ch)).length / letters.length;
}
function pairKind(target, info) {
    if (info.source === 'bubble') return '원문';
    if (target.source === 'bubble') return '번역';
    const a = hangulRatio(target.text), b = hangulRatio(info.text);
    if (Math.abs(a - b) < 0.2) return '연결';
    return b < a ? '원문' : '번역';
}

function makeBookmark(info) {
    const ci = currentChatInfo();
    if (!ci) return null;
    const c = ctx();
    const msg = c.chat?.[info.mesId];
    const speaker = msg?.name || document.querySelector(`#chat .mes[mesid="${info.mesId}"] .name_text`)?.textContent?.trim() || ci.ownerName;
    const now = Date.now();
    return {
        id: uid(),
        text: info.text,
        note: '',
        pair: null,
        source: info.source,
        para: info.para ?? null,
        speaker,
        ownerKey: ci.ownerKey,
        ownerName: ci.ownerName,
        isGroup: ci.isGroup,
        chatId: ci.chatId,
        chatStart: parseSendDate(c.chat?.[0]?.send_date) ?? now,
        mesId: info.mesId,
        sendDate: msg?.send_date ?? null,
        mesTime: parseSendDate(msg?.send_date),
        offset: info.offset,
        createdAt: now,
        updatedAt: now,
    };
}

// ---------------------------------------------------------------- whole message
const squash = (t) => String(t || '').replace(/[*_~`#>\[\]()\s"“”'‘’]/g, '');

async function saveWholeMessage(mesEl) {
    const mesId = Number(mesEl?.getAttribute('mesid'));
    const msg = ctx().chat?.[mesId];
    if (!msg || isNaN(mesId)) return;
    const shown = (mesEl.querySelector('.mes_text')?.innerText || '').trim();
    const raw = String(msg.mes || '').trim();
    const text = shown || raw;
    if (!text) return;
    try { await loadDb(); } catch { toast('error', '북마크 파일을 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.'); return; }
    const ci = currentChatInfo();
    if (ci && db.items.some(b => b.whole && b.chatId === ci.chatId && b.sendDate && b.sendDate === msg.send_date && b.mesId === mesId)) {
        toast('info', '이미 저장한 메시지예요'); return;
    }
    const b = makeBookmark({ text, source: 'chat', mesId, offset: 0, para: null });
    if (!b) { toast('warning', '채팅 정보를 찾지 못했어요.'); return; }
    b.whole = true;
    // translated message: attach the other side automatically (whole message = exact 1:1)
    const other = shown && raw && squash(shown) !== squash(raw) ? raw : '';
    if (other) {
        const kind = pairKind(b, { text: other, source: 'chat' });
        if (kind !== '연결') b.pair = { text: other, kind, para: null, mesId };
    }
    db.items.push(b);
    lastSavedId = b.id;
    touch(b);
    toast('success', b.pair ? `메시지 전체를 저장했어요 (${b.pair.kind} 포함)` : '메시지 전체를 저장했어요');
    if (panelOpen) render();
}

function mountMessageButton() {
    const html = '<div title="메시지 전체 북마크" class="mes_button stbm-mes-btn fa-regular fa-bookmark"></div>';
    const targets = [document.querySelector('#message_template .extraMesButtons'), ...document.querySelectorAll('#chat .mes .extraMesButtons')];
    for (const t of targets) if (t && !t.querySelector('.stbm-mes-btn')) t.insertAdjacentHTML('afterbegin', html);
}

// ---------------------------------------------------------------- link mode bar
function setLinkMode(id) {
    linkTargetId = id;
    let bar = document.getElementById('stbm-linkbar');
    if (!id) { bar?.remove(); return; }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'stbm-linkbar';
        bar.innerHTML = '<span>연결 중</span><button type="button">취소</button>';
        bar.querySelector('button').addEventListener('click', () => { setLinkMode(null); openPanel(); });
        document.body.appendChild(bar);
    }
}

// ---------------------------------------------------------------- panel
let panelOpen = false;
const ui = { tab: 'all', sort: 'time', owner: null, open: new Set(), editing: null, editText: null, menu: null, pairOpen: new Set(), noteOpen: new Set() };
const isEditing = () => !!(ui.editing || ui.editText);
// collapse runs of blank lines into one, trim trailing spaces
const tidy = (t) => String(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function ensureFont(key) {
    const f = FONTS[key];
    if (!f) return;
    const id = 'stbm-font-' + key;
    if (document.getElementById(id)) return;
    if (f.css) {
        const l = document.createElement('link');
        l.id = id; l.rel = 'stylesheet'; l.href = f.css;
        document.head.appendChild(l);
    } else if (f.face) {
        const st = document.createElement('style');
        st.id = id; st.textContent = f.face;
        document.head.appendChild(st);
    }
}
function fontStack(key = S().font) { const f = FONTS[key] || FONTS.pretendard; return `${f.family}, ${f.fallback}`; }

function applyViewVars(root) {
    const s = S();
    ensureFont(s.font);
    root.style.setProperty('--stbm-read-font', fontStack());
    root.style.setProperty('--stbm-read-size', s.fontSize + 'px');
    root.style.setProperty('--stbm-read-lh', String(s.lineHeight));
}

function getPanel() {
    let p = document.getElementById('stbm-panel');
    if (p) return p;
    const veil = document.createElement('div');
    veil.id = 'stbm-veil';
    veil.addEventListener('click', closePanel);
    document.body.appendChild(veil);
    p = document.createElement('div');
    p.id = 'stbm-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', '북마크');
    p.innerHTML = `
      <div class="stbm-head"><span class="stbm-title">북마크 <span class="stbm-count"></span></span><button type="button" class="stbm-tx" data-a="close">닫기</button></div>
      <div class="stbm-tabs" role="tablist">
        <button type="button" data-tab="all">전체</button><button type="button" data-tab="char">캐릭터</button><button type="button" data-tab="chat">현재 채팅</button><button type="button" data-tab="set">설정</button>
      </div>
      <div class="stbm-body"></div>`;
    p.addEventListener('click', onPanelClick);
    p.addEventListener('change', onPanelChange);
    p.addEventListener('input', onPanelInput);
    document.body.appendChild(p);
    return p;
}

async function openPanel() {
    const p = getPanel();
    hideSelPop();
    panelOpen = true;
    document.body.classList.add('stbm-open');
    applyViewVars(p);
    p.querySelector('.stbm-body').innerHTML = '<div class="stbm-empty">불러오는 중…</div>';
    try {
        const had = !!db;
        await loadDb();
        if (had) { const remote = await fetchRemote().catch(() => null); if (remote) db = mergeDb(remote, db); }
    } catch {
        p.querySelector('.stbm-body').innerHTML = '<div class="stbm-empty">북마크 파일을 불러오지 못했어요. 연결을 확인하고 다시 열어 주세요.</div>';
        return;
    }
    if (!ui.owner) ui.owner = currentChatInfo()?.ownerKey ?? null;
    render();
}
function closePanel() {
    if (closeDialog) closeDialog();
    panelOpen = false;
    ui.menu = null;
    document.body.classList.remove('stbm-open');
}

function sorted(items) {
    const byMsg = ui.tab !== 'all' && ui.sort === 'msg';
    if (!byMsg) return items.sort((a, b) => b.createdAt - a.createdAt);
    const dir = S().chatGroupOrder === 'old' ? 1 : -1;
    return items.sort((a, b) =>
        (a.chatId === b.chatId ? 0 : dir * ((a.chatStart || 0) - (b.chatStart || 0)) || String(a.chatId).localeCompare(String(b.chatId)))
        || ((a.mesTime ?? Infinity) - (b.mesTime ?? Infinity))
        || ((a.mesId ?? 0) - (b.mesId ?? 0))
        || ((a.offset ?? 0) - (b.offset ?? 0)));
}

function render() {
    const p = document.getElementById('stbm-panel');
    if (!p || !db) return;
    const s = S();
    p.querySelector('.stbm-count').textContent = db.items.length;
    p.querySelectorAll('.stbm-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
    const body = p.querySelector('.stbm-body');
    if (ui.tab === 'set') { body.innerHTML = settingsHtml(); return; }

    const ci = currentChatInfo();
    let items = db.items.slice();
    let bar = '';
    if (ui.tab === 'char') {
        const owners = new Map();
        for (const b of db.items) if (!owners.has(b.ownerKey)) owners.set(b.ownerKey, b.ownerName);
        if (ci && !owners.has(ci.ownerKey)) owners.set(ci.ownerKey, ci.ownerName);
        if (!owners.has(ui.owner)) ui.owner = ci?.ownerKey ?? owners.keys().next().value ?? null;
        bar += `<select class="stbm-select" data-k="owner" aria-label="캐릭터">${[...owners].map(([k, n]) => `<option value="${esc(k)}" ${k === ui.owner ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
        items = items.filter(b => b.ownerKey === ui.owner);
    } else if (ui.tab === 'chat') {
        items = ci ? items.filter(b => b.chatId === ci.chatId) : [];
    }
    if (ui.tab !== 'all') bar += seg('sort', [['time', '저장순'], ['msg', '메시지순']], ui.sort);
    bar += '<span class="stbm-sp"></span>' + seg('view', [['thread', '스레드'], ['blog', '블로그']], s.view);

    let html = `<div class="stbm-bar">${bar}</div><div class="stbm-list ${s.view === 'blog' ? 'is-blog' : ''}">`;
    if (!items.length) {
        html += `<div class="stbm-empty">${ui.tab === 'chat' && !ci ? '열려 있는 채팅이 없어요.' : '북마크 없음'}</div>`;
    } else {
        const groupHeads = ui.tab === 'char' && ui.sort === 'msg';
        let lastChat = null;
        for (const b of sorted(items)) {
            if (groupHeads && b.chatId !== lastChat) { html += `<div class="stbm-ghead">${esc(b.chatId)}</div>`; lastChat = b.chatId; }
            html += itemHtml(b, s);
        }
    }
    body.innerHTML = html + '</div>';
    const ta = body.querySelector('.stbm-note-edit, .stbm-text-edit');
    if (ta) ta.focus({ preventScroll: true });
}

function seg(key, opts, cur) {
    return `<span class="stbm-seg">${opts.map(([v, l]) => `<button type="button" data-seg="${key}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</span>`;
}

function itemHtml(b, s) {
    const missing = isMissing(b);
    if (ui.editText === b.id) return editItemHtml(b);
    const full = s.view === 'thread' || ui.open.has(b.id) || b.text.length <= s.cut;
    const quote = full ? esc(b.text) : esc(b.text.slice(0, s.cut)) + '<span class="stbm-more">…</span>';
    const isCur = b.chatId === curChatId();
    let folds = '';
    if (full && (b.pair || b.note) && ui.editing !== b.id) {
        folds = '<div class="stbm-folds">';
        if (b.pair) folds += `<button type="button" class="stbm-fold" data-a="pair" aria-expanded="${ui.pairOpen.has(b.id)}">${esc(b.pair.kind)}${b.pair.para ? ' · 문단 ' + b.pair.para : ''} ${ui.pairOpen.has(b.id) ? '▴' : '▾'}</button>`;
        if (b.note) folds += `<button type="button" class="stbm-fold" data-a="note" aria-expanded="${ui.noteOpen.has(b.id)}">메모 ${ui.noteOpen.has(b.id) ? '▴' : '▾'}</button>`;
        folds += '</div>';
        if (b.pair && ui.pairOpen.has(b.id)) folds += `<div class="stbm-pair">${esc(b.pair.text)}<button type="button" class="stbm-tx stbm-unlink" data-a="unlink">연결 해제</button></div>`;
        if (b.note && ui.noteOpen.has(b.id)) folds += `<div class="stbm-note">${esc(b.note)}</div>`;
    }
    const edit = ui.editing === b.id
        ? `<textarea class="stbm-note-edit" rows="2" placeholder="메모를 남기세요">${esc(b.note)}</textarea><div class="stbm-edit-acts"><button type="button" class="stbm-tx" data-a="memoCancel">취소</button><button type="button" class="stbm-tx is-strong" data-a="memoSave">저장</button></div>`
        : '';
    const menu = ui.menu === b.id
        ? `<span class="stbm-menu"><button type="button" data-a="copy">복사</button><button type="button" data-a="edit">수정</button><button type="button" data-a="memo">메모</button><button type="button" data-a="link">연결</button><button type="button" data-a="card">카드</button></span>`
        : '';
    return `<article class="stbm-item" data-id="${esc(b.id)}">
      <div class="stbm-meta"><span class="stbm-name">${esc(b.speaker || b.ownerName)}</span><span>#${b.mesId ?? '-'}${b.whole ? ' · 전문' : ''}</span><span>${fmtTime(b.createdAt)}</span>${missing ? '<span class="stbm-gone" title="원본 메시지가 없어요">*</span>' : ''}
        <span class="stbm-tools">${missing ? '' : `<button type="button" class="stbm-ic" data-a="go" title="${isCur ? '메시지로 이동' : '채팅 전환'}" aria-label="${isCur ? '메시지로 이동' : '채팅 전환'}">↗</button>`}<button type="button" class="stbm-ic" data-a="menu" aria-label="더보기" aria-expanded="${ui.menu === b.id}">⋯</button><button type="button" class="stbm-ic" data-a="del" aria-label="삭제">×</button>${menu}</span></div>
      <p class="stbm-quote" data-a="toggle">${quote}</p>${folds}${edit}
    </article>`;
}

function editItemHtml(b) {
    const rows = (t) => Math.min(14, Math.max(2, String(t).split('\n').length + 1));
    return `<article class="stbm-item is-editing" data-id="${esc(b.id)}">
      <div class="stbm-meta"><span class="stbm-name">${esc(b.speaker || b.ownerName)}</span><span>#${b.mesId ?? '-'}${b.whole ? ' · 전문' : ''}</span><span>수정 중</span></div>
      <textarea class="stbm-text-edit" data-f="text" rows="${rows(b.text)}" aria-label="저장한 글">${esc(b.text)}</textarea>
      ${b.pair ? `<div class="stbm-edit-label">${esc(b.pair.kind)}</div><textarea class="stbm-text-edit is-pair" data-f="pair" rows="${rows(b.pair.text)}" aria-label="${esc(b.pair.kind)}">${esc(b.pair.text)}</textarea>` : ''}
      <div class="stbm-edit-acts"><button type="button" class="stbm-tx" data-a="tidy">빈 줄 정리</button><span class="stbm-sp"></span><button type="button" class="stbm-tx" data-a="editCancel">취소</button><button type="button" class="stbm-tx is-strong" data-a="editSave">저장</button></div>
    </article>`;
}

function settingsHtml() {
    const s = S();
    const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`;
    return `<div class="stbm-set">
      <h3>기본</h3>
      <div class="stbm-row"><label for="stbm-on">드래그 저장</label><input type="checkbox" class="stbm-chk" id="stbm-on" data-k="enabled" ${s.enabled ? 'checked' : ''}></div>
      <div class="stbm-row"><label for="stbm-entry">버튼 위치</label><select class="stbm-select" id="stbm-entry" data-k="entry">${opt('input', '전송 버튼 옆', s.entry)}${opt('wand', '요술봉 메뉴', s.entry)}${opt('both', '둘 다', s.entry)}</select></div>
      <h3>보기</h3>
      <div class="stbm-row"><label for="stbm-font">글꼴</label><select class="stbm-select" id="stbm-font" data-k="font">${Object.entries(FONTS).map(([k, f]) => opt(k, f.label, s.font)).join('')}</select></div>
      <div class="stbm-row"><label for="stbm-size">글자 크기</label><span class="stbm-rng"><input type="range" id="stbm-size" data-k="fontSize" min="12" max="24" step="1" value="${s.fontSize}"><span class="stbm-v">${s.fontSize}</span></span></div>
      <div class="stbm-row"><label for="stbm-lh">줄간격</label><span class="stbm-rng"><input type="range" id="stbm-lh" data-k="lineHeight" min="1.3" max="2.2" step="0.05" value="${s.lineHeight}"><span class="stbm-v">${Number(s.lineHeight).toFixed(2)}</span></span></div>
      <div class="stbm-row"><label for="stbm-cut">미리보기 글자 수</label><span class="stbm-rng"><input type="range" id="stbm-cut" data-k="cut" min="10" max="80" step="5" value="${s.cut}"><span class="stbm-v">${s.cut}</span></span></div>
      <div class="stbm-row"><label for="stbm-gord">채팅 순서</label><select class="stbm-select" id="stbm-gord" data-k="chatGroupOrder">${opt('new', '최신 채팅 먼저', s.chatGroupOrder)}${opt('old', '오래된 채팅 먼저', s.chatGroupOrder)}</select></div>
      <div class="stbm-sample">돌려줄 핑계가 하나쯤 있어야 다음에 또 볼 수 있을 것 같았거든.</div>
      <h3>발췌 카드</h3>
      <div class="stbm-row"><label for="stbm-ratio">비율</label><select class="stbm-select" id="stbm-ratio" data-k="cardRatio">${opt('45', '세로 4:5', s.cardRatio)}${opt('11', '정사각 1:1', s.cardRatio)}</select></div>
      <div class="stbm-row"><label for="stbm-cpair">원문 포함</label><input type="checkbox" class="stbm-chk" id="stbm-cpair" data-k="cardWithPair" ${s.cardWithPair ? 'checked' : ''}></div>
      <h3>백업</h3>
      <div class="stbm-row"><span>북마크 ${db.items.length}개</span><span class="stbm-acts"><button type="button" class="stbm-tx" data-a="export">내보내기</button><button type="button" class="stbm-tx" data-a="import">불러오기</button></span></div>
    </div>`;
}

function onPanelInput(e) {
    const k = e.target.dataset?.k;
    if (!k || e.target.type !== 'range') return;
    const s = S();
    s[k] = Number(e.target.value);
    const v = e.target.parentElement.querySelector('.stbm-v');
    if (v) v.textContent = k === 'lineHeight' ? s[k].toFixed(2) : s[k];
    applyViewVars(getPanel());
    saveSettings();
}

function onPanelChange(e) {
    const k = e.target.dataset?.k;
    if (!k) return;
    if (k === 'owner') { ui.owner = e.target.value; render(); return; }
    const s = S();
    s[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    saveSettings();
    if (k === 'font') applyViewVars(getPanel());
    if (k === 'entry') mountEntries();
}

async function onPanelClick(e) {
    const tab = e.target.closest('[data-tab]');
    if (tab) { ui.tab = tab.dataset.tab; ui.menu = null; render(); return; }
    const sg = e.target.closest('[data-seg]');
    if (sg) {
        if (sg.dataset.seg === 'view') { S().view = sg.dataset.v; saveSettings(); } else ui.sort = sg.dataset.v;
        render(); return;
    }
    const el = e.target.closest('[data-a]');
    const a = el?.dataset.a;
    if (!a) { if (ui.menu && !e.target.closest('.stbm-tools')) { ui.menu = null; render(); } return; }
    if (a === 'close') return closePanel();
    if (a === 'export') return exportData();
    if (a === 'import') return importData();
    const item = el.closest('.stbm-item');
    const b = item && db.items.find(x => x.id === item.dataset.id);
    if (!b) return;
    if (a === 'menu') { ui.menu = ui.menu === b.id ? null : b.id; render(); return; }
    ui.menu = null;
    switch (a) {
        case 'toggle':
            if (S().view === 'blog') { ui.open.has(b.id) ? ui.open.delete(b.id) : ui.open.add(b.id); render(); }
            return;
        case 'pair': ui.pairOpen.has(b.id) ? ui.pairOpen.delete(b.id) : ui.pairOpen.add(b.id); return render();
        case 'note': ui.noteOpen.has(b.id) ? ui.noteOpen.delete(b.id) : ui.noteOpen.add(b.id); return render();
        case 'memo': ui.editText = null; ui.editing = b.id; ui.open.add(b.id); return render();
        case 'edit': ui.editing = null; ui.editText = b.id; return render();
        case 'tidy': item.querySelectorAll('.stbm-text-edit').forEach(t => { t.value = tidy(t.value); }); return;
        case 'editCancel': ui.editText = null; return render();
        case 'editSave': {
            const text = (item.querySelector('[data-f="text"]')?.value || '').trim();
            if (!text) { toast('warning', '내용이 비어 있어요'); return; }
            b.text = text;
            const pt = item.querySelector('[data-f="pair"]');
            if (pt && b.pair) { const v = pt.value.trim(); if (v) b.pair.text = v; else b.pair = null; }
            ui.editText = null; touch(b); return render();
        }
        case 'memoCancel': ui.editing = null; return render();
        case 'memoSave': {
            b.note = (item.querySelector('.stbm-note-edit')?.value || '').trim();
            ui.editing = null; if (b.note) ui.noteOpen.add(b.id);
            touch(b); return render();
        }
        case 'unlink': b.pair = null; touch(b); return render();
        case 'copy': return copyText(b.pair ? `${b.text}\n\n${b.pair.text}` : b.text);
        case 'link':
            closePanel(); setLinkMode(b.id);
            toast('info', '채팅이나 원문 말풍선에서 연결할 문장을 드래그하세요');
            return;
        case 'card': render(); return showCard(b);
        case 'del': {
            const ok = await confirmDialog('삭제할까요?', '', '삭제');
            if (!ok) return;
            db.items = db.items.filter(x => x.id !== b.id);
            db.deleted[b.id] = Date.now();
            scheduleSave(); return render();
        }
        case 'go': return goTo(b);
    }
}

async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('success', '복사했어요'); }
    catch {
        const ta = document.createElement('textarea');
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('success', '복사했어요'); } catch { toast('error', '복사하지 못했어요'); }
        ta.remove();
    }
}

// ---------------------------------------------------------------- dialog (light, text buttons)
let closeDialog = null;
function dialog(innerHtml) {
    if (closeDialog) closeDialog();
    const wrap = document.createElement('div');
    wrap.id = 'stbm-dialog';
    wrap.innerHTML = `<div class="stbm-dlg">${innerHtml}</div>`;
    const panel = document.getElementById('stbm-panel');
    if (panelOpen && panel) panel.appendChild(wrap);
    else { wrap.classList.add('is-page'); document.body.appendChild(wrap); }
    applyViewVars(wrap);
    closeDialog = () => { wrap.remove(); closeDialog = null; };
    return wrap;
}
function confirmDialog(title, sub, okLabel) {
    return new Promise(resolve => {
        const w = dialog(`<p>${esc(title)}${sub ? `<br><span class="stbm-sub">${esc(sub)}</span>` : ''}</p>
          <div class="stbm-acts is-end"><button type="button" class="stbm-tx" data-r="0">취소</button><button type="button" class="stbm-tx is-strong" data-r="1">${esc(okLabel)}</button></div>`);
        const done = (v) => { if (w.isConnected) w.remove(); closeDialog = null; resolve(v); };
        closeDialog = () => done(false);
        w.addEventListener('click', (e) => {
            const r = e.target.closest('[data-r]');
            if (r || e.target === w) done(r?.dataset.r === '1');
        });
    });
}

// ---------------------------------------------------------------- navigation
async function ensureRendered(id) {
    let mod = null;
    for (let guard = 0; guard < 300; guard++) {
        if (document.querySelector(`#chat .mes[mesid="${id}"]`)) return true;
        const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
        if (!isFinite(first) || first <= id) return false;
        if (!mod) { try { mod = await import('../../../../script.js'); } catch { mod = {}; } }
        if (typeof mod.showMoreMessages === 'function') {
            await mod.showMoreMessages(first - id);
        } else {
            const btn = document.getElementById('show_more_messages');
            if (!btn) return false;
            btn.click();
        }
        await sleep(120);
        const after = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
        if (after === first) { await sleep(400); if (Number(document.querySelector('#chat .mes')?.getAttribute('mesid')) === first) return false; }
    }
    return !!document.querySelector(`#chat .mes[mesid="${id}"]`);
}

async function jumpInCurrent(b) {
    const id = locate(b);
    if (id < 0) { toast('warning', '원본 메시지를 찾지 못했어요'); if (panelOpen) render(); return; }
    if (!(await ensureRendered(id))) { toast('warning', '메시지를 불러오지 못했어요'); return; }
    const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('stbm-flash'); void el.offsetWidth; el.classList.add('stbm-flash');
    setTimeout(() => el.classList.remove('stbm-flash'), 2200);
}

async function goTo(b) {
    if (b.chatId === curChatId()) { closePanel(); return jumpInCurrent(b); }
    const ok = await confirmDialog(`${b.ownerName} 채팅으로 전환할까요?`, '', '전환');
    if (!ok) return;
    const c = ctx();
    try {
        if (b.isGroup) {
            const gid = b.ownerKey.slice(2);
            const g = (c.groups || []).find(x => x.id === gid);
            if (!g || !(g.chats || []).includes(b.chatId)) return markGone(b, '채팅이 삭제되어 전환할 수 없어요');
            closePanel();
            await c.openGroupChat(gid, b.chatId);
        } else {
            const avatar = b.ownerKey.slice(2);
            const idx = (c.characters || []).findIndex(x => x.avatar === avatar);
            if (idx < 0) return markGone(b, '캐릭터를 찾지 못했어요');
            const res = await fetch('/api/characters/chats', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
            const list = res.ok ? Object.values(await res.json() || {}) : [];
            const exists = list.some(x => String(x?.file_name || '').replace(/\.jsonl$/, '') === b.chatId);
            if (res.ok && !exists) return markGone(b, '채팅이 삭제되어 전환할 수 없어요');
            closePanel();
            if (String(c.characterId) !== String(idx) || c.groupId) await c.selectCharacterById(idx);
            if (curChatId() !== b.chatId) await ctx().openCharacterChat(b.chatId);
        }
    } catch (e) {
        console.error('[Bookmark] switch failed', e);
        toast('error', '채팅을 전환하지 못했어요');
        return;
    }
    await sleep(300);
    if (curChatId() === b.chatId) await jumpInCurrent(b);
}

function markGone(b, msg) {
    b.gone = true; touch(b);
    toast('warning', msg);
    if (panelOpen) render();
}

// ---------------------------------------------------------------- excerpt card
// Layout: paragraphs -> lines. Korean-heavy paragraphs are justified, others left-aligned.
const CARD = { W: 1080, M: 120, TOP: 210, FOOT: 190, MAX: 46, MIN: 36 };

function breakWord(g, word, maxW) {
    const out = [];
    let cur = '';
    for (const ch of word) {
        if (cur && g.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

// returns [{ text, last }] per line of one paragraph.
// Korean (justified): break between any characters like book typesetting, so justification only nudges spacing.
// Latin (left aligned): break between words.
function wrapPara(g, para, maxW, byChar) {
    if (byChar) {
        const lines = [];
        let line = '';
        for (const ch of para) {
            if (line && g.measureText(line + ch).width > maxW) {
                // keep closing punctuation on the same line instead of starting a new one with it
                if (/[.,!?。、)\]}"'”’…·:;~]/.test(ch) && g.measureText(line + ch).width <= maxW * 1.02) { line += ch; continue; }
                lines.push(line.replace(/ +$/, ''));
                line = ch === ' ' ? '' : ch;
            } else line += ch;
        }
        lines.push(line);
        return lines.map((t, i) => ({ text: t, last: i === lines.length - 1 }));
    }
    const lines = [];
    let line = '';
    for (const word of para.split(/ +/)) {
        if (!word) continue;
        const test = line ? line + ' ' + word : word;
        if (g.measureText(test).width <= maxW) { line = test; continue; }
        if (line) lines.push(line);
        if (g.measureText(word).width > maxW) {
            const parts = breakWord(g, word, maxW);
            line = parts.pop();
            lines.push(...parts);
        } else line = word;
    }
    lines.push(line);
    return lines.map((t, i) => ({ text: t, last: i === lines.length - 1 }));
}

// Build a flat list of rows: { text, last, justify, size, lh, color, gap } (gap = space before the row)
function layoutCard(g, f, b, size, withPair, breaks = []) {
    const maxW = CARD.W - CARD.M * 2;
    const rows = [];
    const addBlock = (text, sz, color, firstGap, isMain) => {
        g.font = `${sz}px ${f}`;
        const paras = String(text).replace(/\r/g, '').split(/\n\s*\n/);
        paras.forEach((p, pi) => {
            p.split('\n').forEach((ln, li) => {
                const justify = hangulRatio(ln) >= 0.3;
                wrapPara(g, ln.trim(), maxW, justify).forEach((r, ri) => rows.push({
                    ...r, justify, size: sz, lh: sz * 1.7, color, head: ri === 0,
                    gap: ri === 0 && li === 0 ? (pi === 0 ? firstGap : sz * 0.9) : 0,
                    force: isMain && ri === 0 && li === 0 && pi > 0 && breaks.includes(pi),
                    pstart: isMain && ri === 0 && li === 0, pi: isMain ? pi : null,
                }));
            });
        });
    };
    addBlock(b.text, size, '#161616', 0, true);
    if (withPair && b.pair) addBlock(b.pair.text, Math.round(size * 0.72), '#5C5C58', size * 1.6, false);
    return rows;
}

function paginate(rows, H) {
    const avail = H - CARD.TOP - CARD.FOOT - 40;
    const pages = [[]];
    let used = 0;
    rows.forEach((r, idx) => {
        const gap = pages[pages.length - 1].length ? r.gap : 0;
        // don't strand a paragraph's first line alone at the bottom of a page
        const next = rows[idx + 1];
        const need = r.head && next && !next.head ? r.lh + next.lh : r.lh;
        if ((r.force || used + gap + need > avail) && pages[pages.length - 1].length) { pages.push([]); used = 0; }
        const g2 = pages[pages.length - 1].length ? r.gap : 0;
        pages[pages.length - 1].push({ ...r, gap: g2 });
        used += g2 + r.lh;
    });
    return pages.map(p => ({ rows: p, height: p.reduce((s, r) => s + r.gap + r.lh, 0) }));
}

function drawRow(g, r, x, y, maxW) {
    g.font = `${r.size}px ${g.__family}`;
    g.fillStyle = r.color;
    const w = g.measureText(r.text).width;
    const extra = maxW - w;
    if (!r.justify || r.last || extra <= 0 || extra > maxW * 0.25) { g.fillText(r.text, x, y); return; }
    const words = r.text.split(' ');
    if (words.length > 1 && extra / (words.length - 1) < r.size * 0.3) {
        const gap = extra / (words.length - 1) + g.measureText(' ').width;
        let cx = x;
        for (const wd of words) { g.fillText(wd, cx, y); cx += g.measureText(wd).width + gap; }
        return;
    }
    const chars = [...r.text];
    const step = extra / Math.max(1, chars.length - 1);
    let cx = x;
    for (const ch of chars) { g.fillText(ch, cx, y); cx += g.measureText(ch).width + step; }
}

const splitParas = (t) => String(t).replace(/\r/g, '').split(/\n\s*\n/);

function replaceAll(t, rules) {
    let out = String(t ?? '');
    for (const r of rules) out = out.split(r.from).join(r.to);
    return out;
}
// Card-only substitutions (e.g. hide a character name). Longer words first so "Vaeld Lord" beats "Vaeld".
function cardView(b) {
    const s = S();
    const rules = s.cardReplaceOn ? (s.cardReplace || []).filter(r => r && r.from).sort((x, y) => y.from.length - x.from.length) : [];
    if (!rules.length) return b;
    return { ...b, text: replaceAll(b.text, rules), speaker: replaceAll(b.speaker || b.ownerName || '', rules), ownerName: '', pair: b.pair ? { ...b.pair, text: replaceAll(b.pair.text, rules) } : null };
}

async function buildCards(src) {
    const s = S();
    const b = cardView(src);
    const nParas = splitParas(b.text).length;
    const breaks = (src.cardBreaks || []).filter(k => k > 0 && k < nParas);
    const H = s.cardRatio === '11' ? 1080 : 1350;
    const f = fontStack();
    ensureFont(s.font);
    try { await document.fonts.load(`${CARD.MAX}px ${f}`, b.text.slice(0, 200)); } catch { /* fallback font */ }
    const probe = document.createElement('canvas').getContext('2d');
    const withPair = s.cardWithPair && !!b.pair;
    // biggest size where nothing overflows beyond the chosen breaks; else paginate at the minimum size
    let pages;
    for (let size = CARD.MAX; size >= CARD.MIN; size -= 2) {
        pages = paginate(layoutCard(probe, f, b, size, withPair, breaks), H);
        if (pages.length <= breaks.length + 1) break;
    }
    const name = b.speaker ?? '';
    return pages.map((pg, i) => {
        const cv = document.createElement('canvas');
        cv.width = CARD.W; cv.height = H;
        const g = cv.getContext('2d');
        g.__family = f;
        g.fillStyle = '#FCFCFA'; g.fillRect(0, 0, CARD.W, H);
        g.fillStyle = '#161616'; g.fillRect(CARD.M, 120, 48, 3);
        const area = H - CARD.TOP - CARD.FOOT - 40;
        // single short card: center vertically; multi-page: top aligned
        let y = CARD.TOP + (pages.length === 1 ? Math.max(0, (area - pg.height) / 2) : 0);
        for (const r of pg.rows) { y += r.gap; drawRow(g, r, CARD.M, y + r.size, CARD.W - CARD.M * 2); y += r.lh; }
        g.fillStyle = '#E3E3DE'; g.fillRect(CARD.M, H - CARD.FOOT, CARD.W - CARD.M * 2, 1);
        g.fillStyle = '#161616'; g.font = `500 30px ${f}`; g.fillText(name, CARD.M, H - CARD.FOOT + 70);
        if (pages.length > 1) {
            g.fillStyle = '#9A9A94'; g.font = `26px ${f}`;
            const t = `${i + 1} / ${pages.length}`;
            g.fillText(t, CARD.W - CARD.M - g.measureText(t).width, H - CARD.FOOT + 70);
        }
        // which main-text paragraphs start on this card (for moving page boundaries)
        cv.stbm = { starts: pg.rows.filter(r => r.pstart).map(r => r.pi), firstStart: pg.rows[0]?.pstart ? pg.rows[0].pi : null };
        return cv;
    });
}

async function showCard(b) {
    const s = S();
    let cards = await buildCards(b);
    let i = 0;
    let mode = 'view';
    // ↓: push this card's last paragraph to the next card. ↑: pull the next card's first paragraph back.
    const canPush = () => { const m = cards[i]?.stbm; return !!m && m.starts.some(pi => pi > 0 && pi !== m.firstStart); };
    const canPull = () => { const n = cards[i + 1]?.stbm; return !!n && n.firstStart != null && (b.cardBreaks || []).includes(n.firstStart); };
    const setBreaks = async (list) => { b.cardBreaks = [...new Set(list)].filter(k => k > 0).sort((x, y) => x - y); touch(b); cards = await buildCards(b); renderView(); };
    const w = dialog('<div class="stbm-card-body"></div>');
    const body = w.querySelector('.stbm-card-body');
    if (!Array.isArray(s.cardReplace)) s.cardReplace = [];
    const hasRules = () => s.cardReplace.some(r => r && r.from);

    const renderView = () => {
        const multi = cards.length > 1;
        i = Math.min(i, cards.length - 1);
        body.innerHTML = `<div class="stbm-card-wrap"></div>
          <div class="stbm-acts is-end">${multi ? `<button type="button" class="stbm-tx" data-r="prev" aria-label="이전 장">‹</button><span class="stbm-pg">${i + 1} / ${cards.length}</span><button type="button" class="stbm-tx" data-r="next" aria-label="다음 장">›</button>` : ''}
            <span class="stbm-sp"></span>
            ${splitParas(b.text).length > 1 ? `<button type="button" class="stbm-tx" data-r="pull" ${canPull() ? '' : 'disabled'}>↑ 앞으로</button><button type="button" class="stbm-tx" data-r="push" ${canPush() ? '' : 'disabled'}>↓ 뒤로</button>` : ''}
            <button type="button" class="stbm-tx" data-r="repl">치환${hasRules() && s.cardReplaceOn ? ' · ' + s.cardReplace.filter(r => r && r.from).length : ''}</button>
          </div>
          <div class="stbm-acts is-end"><button type="button" class="stbm-tx" data-r="close">닫기</button>${multi ? '<button type="button" class="stbm-tx" data-r="one">이 장 저장</button>' : ''}<button type="button" class="stbm-tx is-strong" data-r="all">${multi ? '전체 저장' : '저장'}</button></div>`;
        body.querySelector('.stbm-card-wrap').appendChild(cards[i]);
    };

    // card-only substitutions, shared by all cards (e.g. hide a character name)
    const renderRepl = () => {
        const rows = s.cardReplace.length ? s.cardReplace : [];
        body.innerHTML = `<div class="stbm-rr-list">${rows.map((r, k) => `<div class="stbm-rr"><input type="text" class="stbm-in" data-rr="${k}" data-rf="from" value="${esc(r.from)}" placeholder="찾을 말" aria-label="찾을 말"><span class="stbm-arrow">→</span><input type="text" class="stbm-in" data-rr="${k}" data-rf="to" value="${esc(r.to)}" placeholder="바꿀 말" aria-label="바꿀 말"><button type="button" class="stbm-tx" data-rdel="${k}" aria-label="삭제">×</button></div>`).join('')}</div>
          <div class="stbm-acts is-end"><button type="button" class="stbm-tx" data-r="rrAdd">＋ 추가</button><button type="button" class="stbm-tx" data-r="rrToggle" aria-pressed="${!!s.cardReplaceOn}">${s.cardReplaceOn ? '켬' : '끔'}</button><span class="stbm-sp"></span><button type="button" class="stbm-tx is-strong" data-r="rrDone">완료</button></div>`;
    };
    w.addEventListener('input', (e) => {
        const k = e.target.dataset?.rr;
        if (k == null) return;
        const r = s.cardReplace[Number(k)];
        if (r) { r[e.target.dataset.rf] = e.target.value; saveSettings(); }
    });

    const rebuild = async () => { cards = await buildCards(b); renderView(); };
    renderView();

    const save = (cv, n, multi) => new Promise(res => cv.toBlob(bl => { if (bl) download(`bookmark-${stamp()}${multi ? '-' + n : ''}.png`, bl); res(); }, 'image/png'));
    w.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-rdel]');
        if (del) { s.cardReplace.splice(Number(del.dataset.rdel), 1); saveSettings(); renderRepl(); return; }
        const r = e.target.closest('[data-r]')?.dataset.r;
        if (r === 'prev' && i > 0) { i--; renderView(); }
        if (r === 'next' && i < cards.length - 1) { i++; renderView(); }
        if (r === 'one') await save(cards[i], i + 1, true);
        if (r === 'all') for (let k = 0; k < cards.length; k++) { await save(cards[k], k + 1, cards.length > 1); await sleep(400); }
        if (r === 'push' && canPush()) {
            const m = cards[i].stbm, n = cards[i + 1]?.stbm;
            const last = m.starts.filter(pi => pi > 0 && pi !== m.firstStart).pop();
            const merged = n && n.firstStart != null ? (b.cardBreaks || []).filter(k => k !== n.firstStart) : (b.cardBreaks || []);
            await setBreaks([...merged, last]);
        }
        if (r === 'pull' && canPull()) {
            const n = cards[i + 1].stbm;
            const rest = n.starts.find(pi => pi > n.firstStart);
            await setBreaks([...(b.cardBreaks || []).filter(k => k !== n.firstStart), ...(rest != null ? [rest] : [])]);
        }
        if (r === 'repl') { mode = 'repl'; if (!s.cardReplace.length) s.cardReplace.push({ from: '', to: '' }); renderRepl(); body.querySelector('.stbm-in')?.focus(); }
        if (r === 'rrAdd') { s.cardReplace.push({ from: '', to: '' }); renderRepl(); [...body.querySelectorAll('[data-rf="from"]')].pop()?.focus(); }
        if (r === 'rrToggle') { s.cardReplaceOn = !s.cardReplaceOn; saveSettings(); renderRepl(); }
        if (r === 'rrDone') { s.cardReplace = s.cardReplace.filter(x => x && x.from); saveSettings(); mode = 'view'; await rebuild(); }
        if (r === 'close' || (e.target === w && mode === 'view')) closeDialog?.();
    });
}

// ---------------------------------------------------------------- backup
function exportData() {
    const json = JSON.stringify({ format: 'st-bookmark', exportedAt: new Date().toISOString(), items: db.items }, null, 1);
    download(`st-bookmarks-backup-${stamp()}.json`, new Blob([json], { type: 'application/json' }));
}
function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
        const file = inp.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = normalizeDb({ items: data.items ?? data, deleted: {} });
            if (!incoming.items.length) { toast('warning', '불러올 북마크가 없어요'); return; }
            const before = db.items.length;
            for (const it of incoming.items) delete db.deleted[it.id];
            db = mergeDb(db, incoming);
            scheduleSave(0);
            toast('success', `${db.items.length - before}개를 새로 불러왔어요`);
            render();
        } catch (e) {
            console.error('[Bookmark] import failed', e);
            toast('error', '백업 파일을 읽지 못했어요');
        }
    });
    inp.click();
}

// ---------------------------------------------------------------- entry points
function mountEntries() {
    const entry = S().entry;
    const wantInput = entry === 'input' || entry === 'both';
    const wantWand = entry === 'wand' || entry === 'both';

    let ib = document.getElementById('stbm-input-btn');
    if (wantInput && !ib) {
        const send = document.getElementById('send_but');
        const host = send?.parentElement || document.getElementById('rightSendForm');
        if (host) {
            ib = document.createElement('div');
            ib.id = 'stbm-input-btn';
            ib.className = 'fa-regular fa-bookmark interactable';
            ib.title = '북마크';
            ib.tabIndex = 0;
            ib.addEventListener('click', openPanel);
            if (send && send.parentElement === host) host.insertBefore(ib, send); else host.appendChild(ib);
        }
    } else if (!wantInput && ib) ib.remove();

    let wb = document.getElementById('stbm-wand-btn');
    if (wantWand && !wb) {
        const menu = document.getElementById('extensionsMenu');
        if (menu) {
            wb = document.createElement('div');
            wb.id = 'stbm-wand-btn';
            wb.className = 'list-group-item flex-container flexGap5 interactable';
            wb.tabIndex = 0;
            wb.innerHTML = '<div class="fa-regular fa-bookmark extensionsMenuExtensionButton"></div><span>북마크</span>';
            wb.addEventListener('click', openPanel);
            menu.appendChild(wb);
        }
    } else if (!wantWand && wb) wb.remove();
}

// ---------------------------------------------------------------- init
(function init() {
    S();
    const { eventSource, event_types } = ctx();

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.stbm-mes-btn');
        if (btn) { e.stopPropagation(); saveWholeMessage(btn.closest('.mes')); }
    }, true);
    document.addEventListener('pointerdown', (e) => {
        const mes = e.target.closest?.('#chat .mes');
        if (mes) lastTappedMes = Number(mes.getAttribute('mesid'));
        if (selPop && !selPop.hidden && !selPop.contains(e.target)) { popBusy = false; }
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (closeDialog) closeDialog();
        else if (panelOpen) closePanel();
        else if (linkTargetId) setLinkMode(null);
    });

    eventSource.on(event_types.APP_READY, () => {
        mountEntries();
        mountMessageButton();
        loadDb().then(refreshLostFlags).catch(() => { /* retried on open */ });
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        hideSelPop();
        mountEntries();
        mountMessageButton();
        if (db) refreshLostFlags();
        if (panelOpen && !isEditing()) render();
    });
    let lostTimer = null;
    const onMessagesChanged = () => { clearTimeout(lostTimer); lostTimer = setTimeout(() => { refreshLostFlags(); if (panelOpen && !isEditing()) render(); }, 500); };
    for (const ev of ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED']) if (event_types[ev]) eventSource.on(event_types[ev], onMessagesChanged);
    eventSource.on(event_types.CHAT_DELETED, markChatGone);
    eventSource.on(event_types.GROUP_CHAT_DELETED, markChatGone);

    // in case APP_READY already fired before this script loaded
    setTimeout(() => { mountEntries(); mountMessageButton(); }, 1500);
})();
