// L1J 網頁客戶端:透過 gateway 的 WebSocket 收發 JSON 事件,用 canvas 畫斜角地圖與佔位圖形。
'use strict';

const $ = (s) => document.querySelector(s);
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];
// 長按不要跳出瀏覽器的複製 / 存圖選單(輸入框除外)
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
// 有些手機瀏覽器不理 CSS 的 user-select,長按還是會選字:擋掉輸入框以外的選取
document.addEventListener('selectstart', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });

const TW = 48; // 斜角 tile 寬
const TH = 24; // 斜角 tile 高
const WALK_HINT = false; // 10/30 使用者「效果沒有很好」先關;總開關:關閉時不建立提示暫存、不改地面畫法
const WALK_HINT_FILL = 'fill'; // 半透明暗色菱形
const WALK_HINT_HATCH = 'hatch'; // 半透明斜線紋
const WALK_HINT_STYLE = WALK_HINT_FILL; // 截圖比較時改成 WALK_HINT_HATCH
// 原版速度(SprTable):走路約 640ms / 格、攻擊 800ms 起跳,依外型與武器而定;速度表載入前先用預設值
const WALK_MS = 640;
const ATTACK_MS = 800;

const CLASSES = [
  // name, base [str,dex,con,wis,cha,int], 可分配點數(對照 C_CreateChar.ORIGINAL_*)
  { name: '王族', base: [13, 10, 10, 11, 13, 10], bonus: 8 },
  { name: '騎士', base: [16, 12, 14, 9, 12, 8], bonus: 4 },
  { name: '妖精', base: [11, 12, 12, 12, 9, 12], bonus: 7 },
  { name: '法師', base: [8, 7, 12, 12, 8, 12], bonus: 16 },
  { name: '黑暗妖精', base: [12, 15, 8, 10, 9, 11], bonus: 10 },
  { name: '龍騎士', base: [13, 11, 14, 12, 8, 11], bonus: 6 },
  { name: '幻術師', base: [11, 10, 12, 12, 8, 12], bonus: 10 },
];
const STAT_KEYS = ['str', 'dex', 'con', 'wis', 'cha', 'int'];
// 原版:創角時每項能力最高 18,騎士的力量可以到 20(伺服器 C_CreateChar 也檢查)
const statMax = (type, i) => (type === 1 && i === 0 ? 20 : 18);
const STAT_NAMES = ['力量', '敏捷', '體質', '精神', '魅力', '智力'];
const OUTDOOR_MAPS = new Set([0, 4, 2005]); // 說話之島、本土、新手村
const KIND_COLOR = { pc: '#5aa0ff', monster: '#e0574a', npc: '#62c46b', guard: '#c9c9c9', door: '#8a6a3a', item: '#ffd36b' };

// ---------------- 狀態 ----------------
const st = {
  equipSets: null, // 裝備組:null = 這個站沒開(伺服器沒送);[{slot, items:[{id,itemId,name}]}](PACKETBOX 0xEE equipsets 事件)
  locks: new Set(), // 上鎖的道具編號(伺服器 PACKETBOX 0xEF:locks / lock 事件)
  ws: null,
  account: '',
  chars: [],
  maxChars: 0,
  inGame: false,
  selfId: 0,
  me: null, // 狀態封包內容
  mapId: -1,
  map: null, // { x0, x1, y0, y1, w, h, tiles }
  objects: new Map(),
  inv: new Map(),
  skills: new Set(), // 已學會的魔法 skill_id
  path: [],
  nextStepAt: 0,
  target: null, // { id, mode: 'attack' | 'pickup' | 'talk' }
  picked: null, // 只選取、不追擊的目標 { id };由裝置設定 clickSelect 啟用
  nextAttackAt: 0,
  floaters: [],
  cam: { x: 0, y: 0 },
};

// ---------------- 連線 ----------------

// Render metrics: no samples, wrappers or observer until policy AND ?rm=1.
const RM = {
  clock: window.__rmMeasureNow || performance.now.bind(performance),
  allowed: false, active: false, data: null, observer: null, restore: [],
  add(k, v) { this.data.samples[k].push(v); },
  summary(a) {
    const s = a.slice().sort((a, b) => a - b), p = n => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * n))] : null;
    return { count: a.length, total: a.reduce((a, b) => a + b, 0), p50: p(.5), p95: p(.95), p99: p(.99), max: s.length ? s[s.length - 1] : null, raw: a.slice() };
  },
  start() {
    if (typeof updateHud !== 'function') return false;
    if (!this.allowed || new URLSearchParams(location.search).get('rm') !== '1') return false;
    if (this.active) return true;
    this.data = { start: this.clock(), end: null, raf: 0, renders: 0, lastRender: null, visible: null,
      frames: 0, events: 0, bytes: 0, draws: 0, texts: 0, seconds: {},
      samples: Object.fromEntries(['interval', 'step', 'anims', 'scene', 'submit', 'hud', 'minimap', 'parse', 'handle', 'longtask', 'drawImage', 'fillText', 'webglDrawCalls', 'webglTextureBytes'].map(k => [k, []])) };
    const originalHandle = handle, originalHud = updateHud;
    handle = function () { const t = RM.clock(); RM.data.events++; RM.bucket().events++; try { return originalHandle.apply(this, arguments); } finally { RM.add('handle', RM.clock() - t); } };
    updateHud = function () { const t = RM.clock(); try { return originalHud.apply(this, arguments); } finally { RM.add('hud', RM.clock() - t); } };
    this.restore.push(() => { handle = originalHandle; updateHud = originalHud; });
    for (const name of ['drawImage', 'fillText']) {
      const own = Object.getOwnPropertyDescriptor(ctx, name), original = ctx[name];
      ctx[name] = function () { if (name === 'drawImage') RM.data.draws++; else RM.data.texts++; return original.apply(this, arguments); };
      this.restore.push(() => { if (own) Object.defineProperty(ctx, name, own); else delete ctx[name]; });
    }
    this.active = true;
    try { this.observer = new PerformanceObserver(list => { for (const e of list.getEntries()) this.add('longtask', e.duration); }); this.observer.observe({ type: 'longtask', buffered: false }); } catch (_) { this.observer = null; }
    return true;
  },
  bucket() { const second = Math.floor((this.clock() - this.data.start) / 1000); return this.data.seconds[second] ||= { frames: 0, events: 0, bytes: 0 }; },
  stop() {
    if (!this.active) return;
    if (this.observer) { for (const e of this.observer.takeRecords()) this.add('longtask', e.duration); this.observer.disconnect(); this.observer = null; }
    for (const restore of this.restore.splice(0).reverse()) restore();
    this.data.end = this.clock(); this.active = false;
  },
  receive(ws, raw, ready) {
    const d = this.data, b = this.bucket(); d.frames++; b.frames++;
    const bytes = new TextEncoder().encode(raw).byteLength; d.bytes += bytes; b.bytes += bytes;
    let parsed; const t = this.clock(); try { parsed = JSON.parse(raw); } finally { this.add('parse', this.clock() - t); }
    return receiveSocket(ws, parsed, ready, raw.length * 3);
  },
  snapshot() {
    const d = this.data; if (!d) return { schema: 1, active: false, backend: worldBackendStats(), samples: null };
    const seconds = Math.max(.001, ((d.end ?? this.clock()) - d.start) / 1000), a = d.samples.interval;
    return { schema: 1, active: this.active, versionHash: window.AV?.build || window.__rmSourceHash || null, seconds,
      settings: { DPR, devicePixelRatio, quality: PERF.mode, level: PERF.level, flow: typeof L1S !== 'undefined' && L1S.flow ? L1S.flow() : null, ZOOM, viewport: { width: innerWidth, height: innerHeight, canvasWidth: canvas.width, canvasHeight: canvas.height } },
      objects: { visible: d.visible, total: st.objects.size, visibleDefinition: 'object anchor inside world viewport; not pixel occlusion' },
      raf: d.raf, worldRenders: d.renders, worldFps: d.renders / seconds,
      intervals: { over16_7: a.length ? a.filter(x => x > 16.7).length / a.length : null, over33_3: a.length ? a.filter(x => x > 33.3).length / a.length : null, pausesOver500: a.filter(x => x > 500) },
      network: { frames: d.frames, events: d.events, bytes: d.bytes, framesPerSecond: d.frames / seconds, eventsPerSecond: d.events / seconds, bytesPerSecond: d.bytes / seconds, buckets: Object.entries(d.seconds).map(([second, value]) => ({ second: +second, ...value })) },
      backend: worldBackendStats(), worldCanvas: { drawImage: d.draws, fillText: d.texts }, longtaskSupported: typeof PerformanceObserver !== 'undefined' && !!PerformanceObserver.supportedEntryTypes?.includes('longtask'),
      heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null,
      samples: Object.fromEntries(Object.entries(d.samples).map(([k, a]) => [k, this.summary(a)])) };
  }
};
window.__rm = { start: () => RM.start(), stop: () => RM.stop(), snapshot: () => RM.snapshot() };

function connect(onReady) {
  openSocket(null, onReady);
  if (!connect.ka) connect.ka = setInterval(() => send({ t: 'keepalive' }), 20000);
}
// 斷線重連:手機切到別的 App 時瀏覽器會關掉連線,gateway 會把遊戲連線保留 5 分鐘;回來就用 token 接回去
const resume = { token: null, tries: 0, timer: null, deadline: 0, sequenced: false, last: 0, acked: 0, ackFrames: 0, ackBytes: 0 };
// 遊戲連線的主機:config.json 的 wsHost(台北轉送,比較不延遲);轉送連不上就退回跟網頁同一個主機,這一頁之後都不再試
const relay = { bad: false };
function wsHost() { return (!relay.bad && st.wsHost) || location.host; }
// 向 gateway 宣告「我看得懂合併框」(ws 網址 bt=1)。預設開(WSBATCH_DEFAULT);伺服器端 altsettings WsBatchEnabled = False 可不重開 gateway 熱關(新連線忽略 bt=1);玩家 / 測試可用 localStorage 'l1j.wsbatch' = '1' / '0' 覆蓋。
const WSBATCH_DEFAULT = true;
const WSBATCH = (() => { try { const v = localStorage.getItem('l1j.wsbatch'); return v === '1' ? true : v === '0' ? false : WSBATCH_DEFAULT; } catch (e) { return WSBATCH_DEFAULT; } })();
// ---------------- 機器人跡象紀錄(使用者 10/24:只觀察、不處罰;gateway BotSignalEnabled 沒開就不記) ----------------
// 自動化瀏覽器的常見特徵(看得出來才報;背景分頁開 AUTO 是合法的,所以不看在線時間)
function botEnv() {
  const f = [];
  try {
    const n = navigator;
    if (n.webdriver === true) f.push('webdriver');
    if (/HeadlessChrome|PhantomJS|Puppeteer|Playwright/i.test(n.userAgent || '')) f.push('headlessua');
    if (window.callPhantom || window._phantom) f.push('phantom');
    if (window.__nightmare) f.push('nightmare');
    if (window.domAutomation || window.domAutomationController) f.push('domauto');
    if (window.__selenium_unwrapped || window.__webdriver_evaluate || window.__driver_evaluate || window._Selenium_IDE_Recorder || document.__selenium_unwrapped) f.push('selenium');
    if (Object.keys(document).some((k) => /^\$?cdc_|^\$wdc_/.test(k))) f.push('cdc');
    if (window.__playwright || window.__pwInitScripts || window.__playwright__binding__) f.push('playwright');
    if (!(n.languages && n.languages.length)) f.push('nolang');
  } catch (e) { /* 讀不到就不報 */ }
  return f;
}
function botHello() {
  return { t: 'hello', v: 1, b: window.AV?.build || '', env: botEnv(), sw: screen.width | 0, sh: screen.height | 0, tp: navigator.maxTouchPoints | 0, lg: (navigator.languages || []).length, pl: (navigator.plugins || []).length };
}
// 假點擊統計:event.isTrusted === false 的遊戲操作事件(真人 / 瀏覽器自己產生的都是 true)
// 10/30:自己程式產生的(快捷鍵 6 按回城鈕、desk.html 外框轉送按鍵)先設 window.__selfEvt = true 再觸發,不算假點擊
const BOTSIG = { n: 0, by: {}, since: Date.now() };
for (const type of ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown']) {
  window.addEventListener(type, (e) => { if (e.isTrusted === false && !window.__selfEvt) { BOTSIG.n++; BOTSIG.by[type] = (BOTSIG.by[type] || 0) + 1; } }, true);
}
setInterval(() => { // 每 5 分鐘:有就回報一次(人還沒進遊戲 / 連線不通就留著,下次再報)
  if (!BOTSIG.n || !st.inGame || !st.ws || st.ws.readyState !== 1) return;
  try { st.ws.send(JSON.stringify({ t: 'botsig', k: 'untrusted', n: BOTSIG.n, by: BOTSIG.by, s: Math.round((Date.now() - BOTSIG.since) / 1000) })); } catch (e) { return; }
  BOTSIG.n = 0; BOTSIG.by = {}; BOTSIG.since = Date.now();
}, 300000);
// ---- BEHAV CORE BEGIN:512 samples; O(1) recording, sorting only when reporting ----
function createClickBehav(now = () => performance.now()) {
  const cap = 512, rows = new Array(cap);
  let head = 0, size = 0, n = 0, since = now(), last = null, runStart = 0, longest = 0;
  let clockAt = since, autoMs = 0, autoOn = false, active = false, mixed = false;
  const round = (v) => Math.round(v * 10000) / 10000;
  function state(inGame, on, at = now()) {
    if (active && autoOn) autoMs += Math.max(0, at - clockAt);
    clockAt = at; active = inGame; autoOn = on;
    if (!inGame) last = null;
  }
  function record(input) {
    const at = input.at;
    if (last === null || at - last >= 60000) runStart = at;
    longest = Math.max(longest, at - runStart); last = at;
    rows[head] = input; head = (head + 1) % cap;
    size = Math.min(cap, size + 1); n = Math.min(1000000, n + 1);
  }
  function summary(at = now()) {
    state(active, autoOn, at);
    if (!n) return null;
    const sample = Array.from({ length: size }, (_, i) => rows[(head - size + i + cap) % cap]);
    const ivs = [], buckets = new Map(), positions = new Set();
    const ptr = { mouse: 0, touch: 0, pen: 0, key: 0 };
    let pairs = 0, same = 0, pn = 0, move0 = 0, prev = null;
    const contact = [];
    for (let i = 0; i < sample.length; i++) {
      const r = sample[i]; ptr[r.kind]++;
      if (i) ivs.push(Math.max(0, r.at - sample[i - 1].at));
      if (r.kind !== 'key') {
        pn++; move0 += r.move0 ? 1 : 0;
        const pos = `${r.x},${r.y}`; positions.add(pos);
        if (prev && prev.kind !== 'key') { pairs++; if (prev.x === r.x && prev.y === r.y) same++; }
        if ([r.pressure, r.width, r.height].every(Number.isFinite)) contact.push(r);
      }
      prev = r;
    }
    const avg = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0;
    const sd = ivs.length ? Math.sqrt(ivs.reduce((a, b) => a + (b - avg) ** 2, 0) / ivs.length) : 0;
    let mode = 0, count = 0;
    for (const v of ivs) { const b = Math.round(v / 10) * 10, c = (buckets.get(b) || 0) + 1; buckets.set(b, c); }
    for (const [b, c] of buckets) if (c > count || (c === count && b < mode)) { mode = b; count = c; }
    ivs.sort((a, b) => a - b);
    const mid = Math.floor(ivs.length / 2), med = !ivs.length ? 0 : ivs.length % 2 ? ivs[mid] : (ivs[mid - 1] + ivs[mid]) / 2;
    const fixed = (key) => contact.length >= 2 && contact.every((r) => r.kind === contact[0].kind && r[key] === contact[0][key]);
    const prs = { n: contact.length, fixed: fixed('pressure'), val: null, wfixed: fixed('width'), w: null, hfixed: fixed('height'), h: null };
    if (prs.fixed) prs.val = contact[0].pressure;
    if (prs.wfixed) prs.w = contact[0].width;
    if (prs.hfixed) prs.h = contact[0].height;
    for (const key of Object.keys(ptr)) ptr[key] = round(ptr[key] / size);
    return { t: 'botsig', k: 'behav', v: 1, mixed, s: round((at - since) / 1000), n, m: size,
      iv: { n: ivs.length, med: round(med), avg: round(avg), sd: round(sd), cv: round(avg ? sd / avg : 0), mode, modeShare: round(ivs.length ? count / ivs.length : 0) },
      pn, same: round(pairs ? same / pairs : 0), uniq: positions.size, move0: round(pn ? move0 / pn : 0), ptr, prs,
      run: round(longest / 60000), auto: round(at > since ? autoMs / (at - since) : 0) };
  }
  function clear(at = now()) {
    head = size = n = 0; since = clockAt = at; autoMs = 0; mixed = false;
  }
  return { state, record, summary, clear, identity: () => { if (n) mixed = true; else clear(); last = null; } };
}
// ---- BEHAV CORE END ----
const CLICKBEHAV = createClickBehav();
const BEHAV_ACTIONS = new Set(['move', 'attack', 'pickup', 'useskill', 'useitem', 'paidpotion', 'door', 'giveitem', 'home', 'restart']);
let behavInput = null, behavDown = null, behavMoveAt = -Infinity;
let behavOwner = '', behavName = '';
function behavState() {
  if (!st.inGame) resetBoxBatch(); // BEGIN BOXBATCH / END BOXBATCH
  CLICKBEHAV.state(st.inGame, typeof auto !== 'undefined' && auto.on);
}
function behavContext() {
  // eventPhase is zero after dispatch: AUTO and timers cannot reuse a stale input.
  return behavInput && behavInput.event.eventPhase !== 0 ? behavInput : null;
}
function behavAccept(context = behavContext(), action = 'attack') {
  if (!context || context.used || !st.inGame || !st.ws || st.ws.readyState !== 1) return;
  const ps = st.para ? paraState() : null;
  if (ps === 'full' || (ps === 'move' && action === 'move')) return;
  context.used = true;
  CLICKBEHAV.record(context.sample);
}
function behavCapture(e) {
  behavInput = null;
  if (e.type === 'pointerdown') behavDown = null;
  if (!st.inGame || e.button > 0 || e.repeat || e.isComposing) return;
  const target = e.target;
  // Gameplay controls only; inventory, settings, dialogs and chat are excluded.
  if (!target || target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  const control = target.closest?.('#world, #hotbar .slot, #btn-restart, #capture-btn, #enemy-box');
  const key = e.type === 'keydown' || (e.type === 'click' && e.detail === 0 && !e.pointerType);
  if (e.type === 'keydown' ? !/^[1-5]$/.test(e.key) : !control) return;
  const at = performance.now();
  const kind = key ? 'key' : ['touch', 'pen'].includes(e.pointerType) ? e.pointerType : 'mouse';
  // Use pointerdown contact values; click/up pressure is normally already zero.
  const down = behavDown;
  if (e.type === 'click' && !key && down && down.control === control && at - down.sample.at < 2000
      && (!Number.isFinite(e.pointerId) || e.pointerId === down.id)) {
    if (!down.used) down.sample = { ...down.sample, at, move0: at - behavMoveAt > 300 };
    down.event = e; behavInput = down; behavDown = null; return;
  }
  const context = { event: e, control, id: e.pointerId, used: false, sample: {
    at, kind, x: key ? null : Math.round(e.clientX), y: key ? null : Math.round(e.clientY),
    move0: at - behavMoveAt > 300,
    pressure: e.type === 'pointerdown' ? e.pressure : null,
    width: e.type === 'pointerdown' ? e.width : null, height: e.type === 'pointerdown' ? e.height : null,
  } };
  behavInput = context;
  if (e.type === 'pointerdown') behavDown = context;
}
for (const type of ['pointerdown', 'click', 'keydown']) window.addEventListener(type, behavCapture, true);
for (const type of ['pointermove', 'mousemove']) window.addEventListener(type, () => { behavMoveAt = performance.now(); }, { capture: true, passive: true });
window.addEventListener('pointercancel', () => { behavDown = null; }, true);
// hud.js loads after app.js. Preserve the original arguments and return values.
// Count accepted queued casts/targets once; subsequent game ticks are not inputs.
document.addEventListener('DOMContentLoaded', () => {
  if (typeof castSkill === 'function') {
    const original = castSkill;
    castSkill = function (...args) {
      const context = behavContext(), before = st.target;
      const result = original.apply(this, args);
      if (result === true && (st.pendingCast === args[0] || (st.target !== before && st.target?.castOnce === args[0]))) behavAccept(context);
      return result;
    };
  }
  if (typeof useSlot === 'function') {
    const original = useSlot;
    useSlot = function (...args) {
      const context = behavContext(), before = slotTap;
      const result = original.apply(this, args);
      if (slotTap && slotTap !== before && self() && !self().dead && st.skills.has(slotTap.sid)) behavAccept(context);
      return result;
    };
  }
}, { once: true });
function behavReport() {
  behavState();
  if (!st.inGame || !st.ws || st.ws.readyState !== 1) return;
  const at = performance.now(), payload = CLICKBEHAV.summary(at);
  if (!payload) { CLICKBEHAV.clear(at); return; }
  try { st.ws.send(JSON.stringify(payload)); } catch { return; } // Keep counters/samples on failure; retry in the next interval.
  CLICKBEHAV.clear(at);
}
setInterval(behavReport, 300000);
function behavCharacter(name) {
  if (behavOwner === st.account && behavName === name) return;
  CLICKBEHAV.identity(); // Keep failed reports across identity changes; mixed windows receive score 0.
  behavOwner = st.account; behavName = name;
  behavInput = behavDown = null; behavMoveAt = -Infinity;
}
// 序號只涵蓋資料框;以下為當次連線通知,沿用原本的順序與語意。
const RESUME_CONTROLS = new Set(['resumed', 'resumefail', 'gm', 'pong', 'bglogout', 'banned', 'kicked', 'idle']);
function receiveSocket(ws, d, onReady, bytes = 0) {
  if (st.ws !== ws) return; // 已被新連線取代的排隊訊息不能再碰畫面 / 序號
  const dispatch = (ev) => {
    try { if (++catchUp.n > CATCHUP_PER_FRAME) catchUp.on = true; handle(ev, onReady); return true; }
    catch (e) { console.error('事件處理失敗,略過同框剩餘事件', e); return false; }
  }; // 只隔離事件處理;序號 / 資料 / rb 驗證例外仍交給 onmessage 要求重新登入
  if (d && d.t === 'seq') {
    if (!Number.isSafeInteger(d.n) || d.n <= 0) throw new Error('無效的接回序號');
    resume.sequenced = true;
    if (d.n <= resume.last) return; // ACK 遺失 / 補送重疊:整框不再處理
    if (d.n !== resume.last + 1) throw new Error('接回資料有缺口');
    const events = Array.isArray(d.d) ? d.d : [d.d];
    if (!events.length || events.some(ev => !ev || typeof ev.t !== 'string')) throw new Error('無效的接回資料');
    for (const ev of events) {
      const ok = dispatch(ev);
      if (st.ws !== ws) return;
      if (!ok) break; // 舊版 handle 例外會中止同框剩餘事件,下一框仍繼續
    }
    resume.last = d.n; // 事件例外也視為本框已處理,避免重播部分副作用;ACK 照常
    resume.ackFrames++;
    // 上限只需保守計算:非 ASCII 至多 3 個 UTF-8 bytes / UTF-16 code unit,不配置每框 Buffer。
    resume.ackBytes += bytes;
  } else {
    const events = Array.isArray(d) ? d : [d];
    for (const ev of events) {
      if (resume.sequenced && (!RESUME_CONTROLS.has(ev?.t) || (ev.t === 'resumed' && ev.rs !== 1))) throw new Error('接回協定不一致');
      if (ev?.t === 'resumed' && ev.rb !== undefined) {
        if (!resume.sequenced || ev.rs !== 1 || !Number.isSafeInteger(ev.rb) || ev.rb < resume.last) throw new Error('無效的接回退化水位');
        console.warn('接回保留區已退化,此區段使用舊版接回能力', ev.rb);
        resume.last = ev.rb; // 主導授權的舊版退化,只略過已被在線額度淘汰的前綴
      }
      const ok = dispatch(ev);
      if (st.ws !== ws) return;
      if (!ok) break; // 舊協定物件 / 陣列同樣只略過當框剩餘事件
    }
  }
}
function acknowledgeResume() {
  const ws = st.ws;
  if (!resume.sequenced || resume.last <= resume.acked || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ t: 'ack', n: resume.last })); resume.acked = resume.last; resume.ackFrames = 0; resume.ackBytes = 0; } catch { /* 下次再送,接回網址也帶最後水位 */ }
}
setInterval(acknowledgeResume, 1000); // 不經遊戲 send 的麻痺 / 行為統計,onmessage 的門檻 ACK 不依賴背景計時器
function openSocket(token, onReady) {
  if (!token) { resume.sequenced = false; resume.last = 0; resume.acked = 0; resume.ackFrames = 0; resume.ackBytes = 0; }
  const viaRelay = wsHost() !== location.host;
  // b = 這一頁的程式版本:gateway 用來發現「還在跑舊版程式的網頁」(R2-01 / R1-17)
  const ws = window.NATISHA_OFFLINE && window.NatishaLocalSocket ? new window.NatishaLocalSocket() : new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${wsHost()}/ws?b=${encodeURIComponent(window.AV?.build || '')}${token ? `&resume=${token}` : ''}${WSBATCH ? '&bt=1' : ''}${!token || resume.sequenced ? `&rs=1${token ? `&ra=${resume.last}` : ''}` : ''}`);
  st.ws = ws;
  ws.addEventListener('open', () => { try { ws.send(JSON.stringify(botHello())); } catch (e) { /* 送不出去就算了 */ } }); // 機器人跡象紀錄:版本 + 瀏覽器環境(gateway 沒開就不記)
  // 合併框:gateway 對宣告 bt=1 的連線可能把 100 ms 內的事件合成一個 JSON 陣列框;單筆事件仍是物件。catchUp 以事件數計。
  ws.onmessage = (m) => {
    if (st.ws !== ws) return;
    conn.lastMsg = Date.now();
    try {
      if (RM.active) RM.receive(ws, m.data, onReady);
      else receiveSocket(ws, JSON.parse(m.data), onReady, m.data.length * 3);
      if (st.ws === ws && (resume.ackFrames >= 64 || resume.ackBytes >= 32 * 1024)) acknowledgeResume();
    }
    catch (e) { console.error('接回協定錯誤,必須重新登入', e); resumeFailed(); }
  };
  ws.addEventListener('open', () => { if (typeof conn !== 'undefined') conn.lastPong = Date.now(); }); // 新連線:重新計時
  let opened = false;
  ws.addEventListener('open', () => { opened = true; });
  if (viaRelay) setTimeout(() => { if (!opened && st.ws === ws) ws.close(); }, 4000); // 轉送 4 秒連不上就放棄
  ws.onclose = () => {
    if (st.ws !== ws) return;
    clearEventHuntTimer();
    if (typeof dutchDisconnect === 'function') dutchDisconnect();
    if (typeof marketDisconnect === 'function') marketDisconnect();
    if (viaRelay && !opened) { relay.bad = true; openSocket(token, onReady); return; } // 轉送連不上:改走原本的連法
    if (st.inGame && resume.token) { startResume(); return; }
    if (st.inGame) log('與伺服器的連線已中斷,請重新整理。', 'err');
    else if (!$('#login-msg').textContent) $('#login-msg').textContent = '連線已關閉'; // 已經有錯誤訊息(例如同帳號在線已滿)就留著
    st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
    document.body.classList.remove('in-game');
  };
}
function setReconnecting(on) {
  let b = document.getElementById('reconnect');
  if (!b) { b = el('div', 'hidden', '連線中斷,重新連線中…'); b.id = 'reconnect'; document.body.appendChild(b); }
  b.classList.toggle('hidden', !on);
}
function startResume() {
  // 背景限制有開且曾收到確認:手機凍結超過重連期限,仍向 gateway 查一次真正的登出原因。
  if (webBgLimited && document.visibilityState === 'visible') { resume.deadline = 0; webBgLimited = false; }
  if (!resume.deadline) resume.deadline = Date.now() + 9.5 * 60 * 1000;
  setReconnecting(true);
  clearTimeout(resume.timer);
  if (webBgLimited && document.visibilityState === 'hidden') return;
  if (Date.now() > resume.deadline) { resumeFailed(); return; }
  if (document.visibilityState === 'hidden') return; // 在背景先不試,回到前景(visibilitychange)再接
  resume.timer = setTimeout(() => openSocket(resume.token), Math.min(5000, 500 + resume.tries++ * 1000));
}
function backgroundLogout(ev) {
  clearTimeout(resume.timer);
  resume.token = null; resume.deadline = 0; resume.tries = 0;
  webBgLimited = false;
  st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
  setReconnecting(false);
  const ws = st.ws; st.ws = null;
  if (ws && ws.readyState <= 1) ws.close();
  document.body.classList.remove('in-game');
  document.getElementById('conn-lost')?.remove();
  showScreen('login');
  $('#login-msg').textContent = ev.msg || '網頁在背景過久,已自動登出';
}
function resumeFailed() {
  clearTimeout(resume.timer);
  const ws = st.ws; st.ws = null;
  if (ws && ws.readyState <= 1) ws.close();
  setReconnecting(false);
  resume.token = null;
  st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
  log('與伺服器的連線已中斷(離開太久),請重新整理再登入。', 'err');
  document.body.classList.remove('in-game');
  toast('連線已中斷,請重新整理');
  // 擋住整個畫面:不然看起來還在玩(能走路、開對話框),其實伺服器已經收不到
  let box = document.getElementById('conn-lost');
  if (!box) {
    box = el('div', '');
    box.id = 'conn-lost';
    box.innerHTML = '<div class="cl-box"><b>連線已中斷</b><p>離開太久,角色已經下線(個人獵場裡開著 AUTO 的話仍在離線掛機)。</p><button type="button">重新登入</button></div>';
    box.querySelector('button').onclick = () => location.reload();
    document.body.appendChild(box);
  }
}
// 連線健康檢查:手機從背景回來時,連線常常已經斷了、瀏覽器卻還以為連著(畫面照常,但送出去的都沒有到)。
// 定期 ping gateway,太久沒有 pong 就當作斷線,走重新連線 / 重新登入的流程
const conn = { lastPong: Date.now(), lastMsg: Date.now(), probe: 0 };
function connDead() {
  clearEventHuntTimer();
  const dead = st.ws;
  st.ws = null; // 舊連線的 onclose 不再處理
  if (typeof dutchDisconnect === 'function') dutchDisconnect();
  try { dead && dead.close(); } catch { /* 已經關了 */ }
  if (st.inGame && resume.token) startResume();
  else if (st.inGame) resumeFailed();
}
const connUp = () => st.ws && st.ws.readyState === 1 && st.inGame;
// 每 10 秒 ping 一次;最後一次 pong 超過 25 秒前就當作斷線
// 計時器晚到 = 網頁自己太忙(不是斷線):這次不判斷。有在收訊息就算活著(pong 會排在大量事件後面)
let pingTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - pingTickAt - 10000;
  pingTickAt = now;
  if (document.visibilityState !== 'visible' || !connUp() || conn.probe || late > 250) return;
  if (now - Math.max(conn.lastPong, conn.lastMsg) > 25000) { connDead(); return; }
  send({ t: 'ping' });
}, 10000);
// 回到前景:馬上 ping,5 秒內沒有回應就當作斷線(背景期間計時器停了,不能只靠上面那個)。
// 還在收訊息(背景排隊的事件湧進來)或計時器晚到(網頁卡住)就再等 5 秒,最多 30 秒
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !connUp()) return;
  const at = Date.now();
  conn.probe = at;
  send({ t: 'ping' });
  const check = (due) => setTimeout(() => {
    if (conn.probe !== at) return;
    const now = Date.now();
    if (!connUp() || conn.lastPong >= at) { conn.probe = 0; return; }
    if ((now - conn.lastMsg < 5000 || now - due > 250) && now - at < 30000) { check(now + 5000); return; }
    conn.probe = 0;
    connDead();
  }, Math.max(0, due - Date.now()));
  check(at + 5000);
});
// 手機切到背景時網頁會被凍結、連線卻不一定馬上斷:一進背景就請伺服器代打(個人獵場開著 AUTO 才會接手),回到前景再交還
let webAway = false;
function setWebAway(away) {
  if (away === webAway || !st.inGame) return;
  if (away && !(typeof auto !== 'undefined' && auto.on)) return;
  webAway = away;
  if (away && typeof syncAutoHunt === 'function') syncAutoHunt(); // 先補送 AUTO 設定:按 AUTO 那次可能剛好斷線沒送到,伺服器要先知道 AUTO 開著才會接手
  send({ t: away ? 'webdetach' : 'webattach' });
}
// 所有遊戲角色都回報背景;保留 setWebAway 原本只替 AUTO 交接 Bot 的語意。
let webBgLimited = false;
function reportWebBackground(on) { if (st.inGame) send({ t: 'webbg', on }); }
window.addEventListener('pagehide', () => { reportWebBackground(true); setWebAway(true); });
window.addEventListener('pageshow', () => reportWebBackground(document.visibilityState === 'hidden'));
// 選角畫面閒置斷線(gateway,3 分鐘):畫面上有操作(點、按鍵)就通知 gateway 人還在,最多 15 秒送一次;只在登入後、還沒進遊戲、停在選角畫面時送
let aliveAt = 0;
for (const evn of ['pointerdown', 'keydown']) {
  document.addEventListener(evn, () => {
    if (st.inGame || !st.ws || st.ws.readyState !== 1 || $('#screen-chars').classList.contains('hidden')) return;
    const n = Date.now();
    if (n - aliveAt < 15000) return;
    aliveAt = n;
    send({ t: 'alive' });
  }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { startCatchUp(); onNetBack(); } // 背景凍住時排隊的訊息馬上會湧進來
  reportWebBackground(document.visibilityState === 'hidden');
  setWebAway(document.visibilityState === 'hidden');
  if (document.visibilityState === 'visible' && st.inGame && resume.token && (!st.ws || st.ws.readyState > 1)) {
    resume.tries = 0;
    startResume();
  }
});
window.addEventListener('online', () => { onNetBack(); if (st.inGame && resume.token && (!st.ws || st.ws.readyState > 1)) startResume(); });
// 網路恢復 / 回到前景 / 重新連上:之前抓失敗的地圖、縮小版、通行資料馬上重抓(不用等退避時間)
function onNetBack() {
  if (typeof L1MAP !== 'undefined' && L1MAP.retryFailed) L1MAP.retryFailed();
  ovRetry();
  if (st.inGame && !st.map && st.mapKey != null) mapRetry.kick();
}
// 伺服器上的程式已經更新、這一頁還是舊版:登入 / 選角畫面直接重新整理;遊戲中只由明確的按鈕重新整理
function checkBuild(b) {
  const mine = window.AV?.build;
  if (!b || !mine || b === mine) return;
  checkBuild.pending = b; // 收起後仍記住最新版,本次頁面不再自動展開
  if (checkBuild.done) return;
  checkBuild.done = true;
  let again = false;
  try { again = sessionStorage.getItem('reloadFor') === b; sessionStorage.setItem('reloadFor', b); } catch { /* 無痕模式 */ }
  if (!st.inGame && !again) { location.reload(); return; }
  // 直式放在聊天 / 快捷欄上方;橫式在聊天區上方,展開聊天時跟著上移。fixed 以 desk 的 iframe 為準。
  const css = el('style', '', `
    #update-bar { left:calc(10px + var(--tabcol-w,34px) + var(--sal)); bottom:calc(var(--sab) + var(--exp-h) + var(--nav-h) + var(--tabrow-h) + var(--form-h) + var(--log-h) + var(--dragon-h) + var(--hot-h) + 19px); }
    html.land #update-bar { left:calc(44px + var(--sal)); bottom:calc(82px + var(--sab)); }
    html.land.land-chat #update-bar { left:calc(6px + var(--sal)); bottom:calc(164px + var(--sab)); }
    #update-bar button { pointer-events:auto; flex:none; min-height:24px; padding:0 6px; font-size:11px; line-height:22px; border-radius:4px; }
  `);
  document.head.appendChild(css);
  const bar = el('div', '');
  bar.id = 'update-bar';
  bar.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:flex;align-items:center;gap:12px;padding:2px 4px;border-radius:6px;background:#3a2a10;color:#ffe08a;border:1px solid #d8b46a;font-size:11px;white-space:nowrap';
  const refresh = el('button', '', '重新整理');
  const later = el('button', 'secondary', '×');
  const hint = el('button', 'secondary', '● 更新');
  refresh.type = later.type = hint.type = 'button';
  later.setAttribute('aria-label', '稍後');
  hint.setAttribute('aria-label', '遊戲已更新,查看重新整理提示');
  hint.title = '遊戲已更新';
  let timer;
  const shrink = () => {
    clearTimeout(timer);
    bar.replaceChildren(hint);
    bar.style.padding = '0'; bar.style.border = '0'; bar.style.background = 'none';
  };
  refresh.onclick = () => location.reload();
  later.onclick = shrink;
  hint.onclick = () => {
    if (!st.inGame) { // 登入 / 選角的 #hud 隱藏中,在原提示確認,不開看不到的對話框
      bar.replaceChildren(el('span', '', '要重新整理嗎?'), refresh, later);
      timer = setTimeout(shrink, 8000);
      return;
    }
    if (!$('#dialog').classList.contains('hidden')) return; // 不取代交易 / 邀請等正在處理的對話
    showDialog('遊戲已更新', '重新整理後需要重新登入,要現在重新整理嗎?');
    dlg.mode = 'update';
    const row = el('div', 'yn-row');
    const no = el('button', 'yn-no', '稍後');
    const yes = el('button', 'yn-yes', '重新整理');
    no.type = yes.type = 'button';
    no.onclick = closeDialog;
    yes.onclick = () => location.reload();
    row.append(no, yes);
    $('#dlg-body').appendChild(row);
  };
  bar.append(el('span', '', '遊戲已更新'), refresh, later);
  document.body.appendChild(bar);
  timer = setTimeout(shrink, 8000);
}
// 網頁版:麻痺類狀態(伺服器 S_Paralysis → protocol.js paralysis;使用者 10/19「麻痺不能喝水」)
// 全鎖(麻痺、睡眠、冰凍、昏迷)不能走 / 打 / 用道具 / 施法 / 撿 / 開門 / 跟 NPC 說話,束縛只是不能走;伺服器 L1ActionLock 也擋
const PARA_FULL_BLOCK = new Set(['move', 'attack', 'useitem', 'useskill', 'pickup', 'npctalk', 'door', 'paidpotion', 'giveitem']);
const PARA_MAX_MS = 30000; // 沒收到解除最多鎖 30 秒(跟伺服器一樣)
const PARA_LABEL = { para: '麻痺', sleep: '睡眠', freeze: '冰凍', stun: '昏迷', bind: '束縛' };
function paraState(now = performance.now()) { // 'full' | 'move' | null
  const p = st.para;
  if (!p) return null;
  let move = false;
  for (const k of Object.keys(p)) {
    if (p[k] <= now) { delete p[k]; continue; }
    if (k !== 'bind') return 'full';
    move = true;
  }
  return move ? 'move' : null;
}
// 全鎖中按道具 / 魔法:提示(2 秒一次,AUTO 一直試也不會洗畫面)
function paraBlocked(msg) {
  if (!st.para || paraState() !== 'full') return false;
  const n = performance.now();
  if (n >= (st.paraToastAt || 0)) { toast(msg); st.paraToastAt = n + 2000; }
  return true;
}
// 傳送類(以前沒擋,麻痺中回城 / 地監記憶書 / 獵場傳送照樣送出):全鎖狀態一律擋下並提示

// 只有伺服器宣告版本後才協商；未收到能力宣告時維持舊路。
const unifiedControl = { phase: 'legacy', cap: null, serial: 0, prefix: Date.now().toString(36) + Math.random().toString(36).slice(2, 10), sentAt: new Map(), localOn: null, lastState: -1, pending: new Map(), dirty: false };
function unifiedPassive() { return ['claiming', 'owner'].includes(unifiedControl.phase); }
function unifiedCheckpoint() {
  const n = performance.now(), wait = {}, autoWait = {}, lastCastAges = {};
  for (const k of ['nextAttackAt', 'nextStepAt', 'castLockUntil', 'autoSpellAt']) wait[k] = Math.min(65535, Math.max(0, (st[k] || 0) - n));
  for (const k of ['nextPotion', 'nextEscape', 'nextBuff', 'nextHeal', 'nextArrow', 'nextCure', 'nextPoly', 'nextWhet', 'nextCm', 'nextWash', 'tpSkillFailUntil']) autoWait[k] = Math.min(65535, Math.max(0, (auto[k] || 0) - n));
  for (const [id, at] of Object.entries(lastCast)) lastCastAges[id] = Math.min(86400000, Math.max(0, n - at));
  const mainJob = typeof tickJobHandles !== 'undefined' ? tickJobHandles.get('autoMain') : null;
  const mainWait = mainJob ? { mainSupplyWait: Math.min(300, Math.max(0, mainJob.next - n)) } : {};
  return { ...mainWait, wait, autoWait, lastCastAges, anchor: auto.anchor, supportWait: Math.max(0, nextSupportCast - n), scrollWait: Math.max(0, nextAutoScroll - n), lastMobAge: Math.min(86400000, Math.max(0, n - (auto.lastMobAt || n))) };
}
function unifiedBaseline() {
  const keys = ['id', 'x', 'y', 'gfx', 'status', 'heading', 'speed', 'brave', 'weapon', 'hpRatio', 'dead', 'buried', 'kind', 'name', 'master', 'impl', 'pcFlag'];
  return [...(st.objects?.values() || [])].filter(o => o.id !== st.selfId).map(o => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, typeof o[k] === 'string' ? o[k].slice(0, 128) : o[k]])));
}
function unifiedClaimNext() {
  const batch = unifiedControl.baseline;
  if (batch && !unifiedControl.baselineSent) {
    const pending = batch.slice(); let parts = 0;
    do { const objects = pending.splice(0, 64); while (objects.length > 1 && JSON.stringify(objects).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).length > 24000) pending.unshift(objects.pop()); parts++; } while (pending.length);
    unifiedControl.baselineExpected = parts;
  }
  if (batch && (batch.length || !unifiedControl.baselineSent)) { const objects = batch.splice(0, 64); while (objects.length > 1 && JSON.stringify(objects).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).length > 24000) batch.unshift(objects.pop()); unifiedControl.baselineSent = true; unifiedRequest('baseline', { part: unifiedControl.baselinePart++, parts: unifiedControl.baselineExpected, objects, last: batch.length === 0 }); }
  else { unifiedControl.baseline = null; if (unifiedControl.phase === 'shadowing') { unifiedControl.phase = 'legacy'; unifiedControl.shadowPrepared = true; if (unifiedControl.dirty) { unifiedControl.dirty = false; unifiedSync(); } return; } unifiedRequest('claim', { settings, on: !!auto.on, checkpoint: unifiedCheckpoint() }); }
}
function unifiedViewport() {
  if (typeof canvas === 'undefined' || !st.cam) return null;
  const width = canvas.width / (DPR * ZOOM), height = canvas.height / (DPR * ZOOM);
  return { width, height, centerY: camCY(height), camX: st.cam.x, camY: st.cam.y };
}
function unifiedRequest(op, extra = {}) {
  const cap = unifiedControl.cap;
  if (!cap || cap.v !== 1) return false;
  if (op === 'resume' && st.map && st.mapKey != null) { unifiedControl.resumeMapKey = st.mapKey; unifiedControl.resumeMapInstance = !!st.inInstance; unifiedControl.resumeMapAt = performance.now(); }
  const requestId = unifiedControl.prefix + '-' + (++unifiedControl.serial);
  const request = { t: 'autohuntcontrol', v: 1, op, requestId, generation: cap.generation, epoch: cap.epoch, settingsRev: cap.settingsRev, viewport: unifiedViewport(), gatewayExportId: cap.gatewayExportId, ...(op === 'resume' ? { on: !!auto.on } : {}), ...extra };
  if (op !== 'view') { unifiedControl.pending.set(requestId, request);
  unifiedControl.sentAt.set(requestId, performance.now()); }
  send(request);
  return true;
}
function unifiedSync() {
  unifiedControl.localOn = !!auto.on;
  if (!unifiedControl.cap) return false;
  if (['preparing', 'claiming', 'shadowing'].includes(unifiedControl.phase)) { unifiedControl.dirty = true; return unifiedPassive(); }
  if (unifiedControl.phase === 'owner') {
    if ([...unifiedControl.pending.values()].some(r => r.op === 'settings')) { unifiedControl.dirty = true; return true; }
    unifiedRequest('settings', { settings, on: !!auto.on });
    return true;
  }
  if (unifiedControl.shadowPrepared && unifiedControl.cap.shadow && !unifiedControl.cap.available) { unifiedRequest('shadowSettings', { settings, on: !!auto.on }); return false; }
  if (unifiedControl.cap.available || unifiedControl.cap.shadow) {
    unifiedControl.phase = 'preparing';
    unifiedRequest('prepare', { settings, on: !!auto.on, checkpoint: unifiedCheckpoint() });
  }
  return false;
}
function unifiedAutoEvent(ev) {
  if (ev.v !== 1 || ev.engine !== 1) return;
  const current = unifiedControl.cap;
  const preparedProof = ev.kind === 'prepared' && unifiedControl.pending.get(ev.requestId)?.op === 'prepare';
  const proof = ev.kind === 'legacy' && ev.noOwner === true && unifiedControl.pending.has(ev.requestId);
  if (current && ev.generation !== current.generation && ev.kind !== 'hello' && !proof && !preparedProof) return;
  if (current && ev.generation === current.generation && ev.epoch < current.epoch) return;
  if ((ev.kind === 'hello' || preparedProof) && (!current || current.generation !== ev.generation)) { unifiedControl.lastState = -1; unifiedControl.shadowPrepared = false; }
  if (ev.kind === 'state' && ev.stateSeq <= unifiedControl.lastState) return;
  unifiedControl.cap = { ...current, ...ev };
  const pending = unifiedControl.pending.get(ev.requestId);
  let handbackIntent; if (ev.kind === 'legacy') for (const request of unifiedControl.pending.values()) { if (['settings', 'claim'].includes(request.op) && typeof request.on === 'boolean') handbackIntent = request.on; if (request.op === 'stop') handbackIntent = false; }
  if (ev.kind === 'pending') return;
  if (ev.requestId) { unifiedControl.pending.delete(ev.requestId); unifiedControl.sentAt.delete(ev.requestId); }
  for (const [id, request] of unifiedControl.pending) if (request.generation !== ev.generation || request.epoch < ev.epoch) { unifiedControl.pending.delete(id); unifiedControl.sentAt.delete(id); }
  if (ev.kind === 'hello') { if (unifiedControl.shadowPrepared && !ev.available) return; if (![...unifiedControl.pending.values()].some(r => ['resume', 'prepare', 'baseline', 'claim'].includes(r.op))) unifiedRequest('resume'); return; }
  if (ev.kind === 'prepared') {
    if (!ev.available) { unifiedControl.shadowPrepared = !ev.baselineChunks && (!!ev.shadow || !!unifiedControl.cap.shadow); unifiedControl.phase = 'legacy'; if ((ev.shadow || unifiedControl.cap.shadow) && ev.baselineChunks) { unifiedControl.phase = 'shadowing'; unifiedControl.baseline = unifiedBaseline(); unifiedControl.baselinePart = 0; unifiedControl.baselineSent = false; unifiedClaimNext(); } return; }
    unifiedControl.phase = 'claiming';
    st.target = null; st.path = []; st.pendingCast = null; st.pendingCastHeal = null;
    auto.wander = false; auto.homing = false;
    unifiedControl.baseline = ev.baselineChunks ? unifiedBaseline() : null; unifiedControl.baselinePart = 0; unifiedControl.baselineSent = false; unifiedClaimNext();
    return;
  }
  if (ev.kind === 'baseline') { if (['claiming', 'shadowing'].includes(unifiedControl.phase)) unifiedClaimNext(); return; }
  if (ev.kind === 'owner') {
    unifiedControl.phase = 'owner'; auto.on = unifiedControl.dirty && unifiedControl.localOn !== null ? unifiedControl.localOn : !!ev.on;
    if (ev.state?.auto?.anchor) auto.anchor = { ...ev.state.auto.anchor };
    st.target = null; st.path = [];
    $('#btn-auto').classList.toggle('on', auto.on); $('#btn-auto').setAttribute('aria-pressed', auto.on);
  } else if (ev.kind === 'state') {
    unifiedControl.lastState = ev.stateSeq;
    if (unifiedControl.phase !== 'owner') return;
    const me = self();
    // 11/05 主導:AUTO 關著(on:false)時伺服器 state 的 self 落後一步,照蓋會把手動走路拉回一格(一頓一頓);差 2 格以內不蓋,差太多才校正
    const lagOnly = me && ev.self && Math.max(Math.abs(me.x - ev.self.x), Math.abs(me.y - ev.self.y)) <= (ev.on ? 4 : 2); // 11/05:AUTO 開著時自己的步伐排隊播放,落後 4 格內不硬蓋
    if (me && ev.self && !lagOnly && (me.x !== ev.self.x || me.y !== ev.self.y)) {
      if (me.stepQ) me.stepQ.length = 0;
      me.x = ev.self.x; me.y = ev.self.y;
      if (!me.anim) { me.px = me.x; me.py = me.y; }
    }
    unifiedControl.target = ev.target || null; if (!unifiedControl.dirty) auto.on = !!ev.on;
  } else if (ev.kind === 'stopped') {
    auto.on = false;
    $('#btn-auto').classList.remove('on'); $('#btn-auto').setAttribute('aria-pressed', false);
  } else if (ev.kind === 'legacy') {
    if (unifiedControl.phase === 'legacy' && ev.canPrepare === false) { auto.on = !!ev.on; $('#btn-auto').classList.toggle('on', auto.on); $('#btn-auto').setAttribute('aria-pressed', auto.on); return; }
    if (proof && pending?.op === 'resume' && unifiedControl.phase === 'legacy' && ev.canPrepare) { if (ev.available || ev.shadow) { unifiedControl.phase = 'preparing'; unifiedRequest('prepare', { settings, on: !!auto.on, checkpoint: unifiedCheckpoint() }); } return; }
    const n = performance.now(), at = Number(ev.at) || 0, q = ev.state || {};
    for (const k of ['nextAttackAt', 'nextStepAt', 'castLockUntil', 'autoSpellAt']) if (Number.isFinite(q[k])) st[k] = Math.max(st[k] || 0, n + Math.max(0, q[k] - at));
    for (const k of ['nextPotion', 'nextEscape', 'nextBuff', 'nextHeal', 'nextArrow', 'nextCure', 'nextPoly', 'nextWhet', 'nextCm', 'nextWash']) if (Number.isFinite(q.auto?.[k])) auto[k] = Math.max(auto[k] || 0, n + Math.max(0, q.auto[k] - at));
    if (Number.isFinite(q.nextAutoScroll)) nextAutoScroll = Math.max(nextAutoScroll, n + Math.max(0, q.nextAutoScroll - at));
    if (Number.isFinite(q.nextSupportCast)) nextSupportCast = Math.max(nextSupportCast, n + Math.max(0, q.nextSupportCast - at));
    const mainJob = typeof tickJobHandles !== 'undefined' ? tickJobHandles.get('autoMain') : null;
    if (Number.isFinite(q.mainSupplyNext) && mainJob) mainJob.next = n + Math.max(0, q.mainSupplyNext - at);
    if (q.auto?.anchor) auto.anchor = { ...q.auto.anchor };
    for (const [id, time] of Object.entries(q.lastCast || {})) lastCast[id] = n - Math.max(0, at - time);
    st.target = null; st.path = []; st.pendingCast = null;
    unifiedControl.pending.clear(); unifiedControl.sentAt.clear(); auto.on = handbackIntent === undefined ? !!ev.on : handbackIntent; unifiedControl.phase = 'legacy'; unifiedControl.cap.available = false;
    $('#btn-auto').classList.toggle('on', auto.on); $('#btn-auto').setAttribute('aria-pressed', auto.on);
    syncAutoHunt();
  } else if (ev.kind === 'error') {
    if (pending?.op === 'resume' && unifiedControl.phase === 'legacy') {
      if (unifiedControl.cap.available || unifiedControl.cap.shadow) { unifiedControl.phase = 'preparing'; unifiedRequest('prepare', { settings, on: !!auto.on, checkpoint: unifiedCheckpoint() }); }
    } else if (unifiedControl.phase === 'claiming' || unifiedControl.phase === 'owner') {
      // An error never grants a writer. Resolve the outstanding ownership with resume.
      unifiedControl.dirty = false;
      if (pending?.op !== 'resume') unifiedRequest('resume');
    } else if (unifiedControl.phase === 'preparing') unifiedControl.phase = 'legacy';
  }
  if (['owner', 'settings'].includes(ev.kind) && unifiedControl.dirty) { unifiedControl.dirty = false; unifiedSync(); }
}

// 換圖後備援：等地圖可用，僅未協商legacy每張圖一次，跨圖至少間隔一秒。
function unifiedMapResume(now) {
  if (!unifiedControl.cap || unifiedControl.phase !== 'legacy' || unifiedControl.shadowPrepared || !st.map || st.mapKey == null) return;
  if ((unifiedControl.resumeMapKey === st.mapKey && unifiedControl.resumeMapInstance === !!st.inInstance) || now - (unifiedControl.resumeMapAt ?? -Infinity) < 1000) return;
  if ([...unifiedControl.pending.values()].some(r => ['resume', 'prepare', 'claim'].includes(r.op))) return;
  if (unifiedRequest('resume')) { unifiedControl.resumeMapKey = st.mapKey; unifiedControl.resumeMapInstance = !!st.inInstance; unifiedControl.resumeMapAt = now; }
}
function unifiedRetry(now) {
  if (!unifiedControl.cap || !st.ws || st.ws.readyState !== 1) return;
  unifiedMapResume(now);
  if (unifiedControl.phase === 'owner' && now - (unifiedControl.viewAt || 0) >= 300 && ![...unifiedControl.pending.values()].some(r => r.op === 'view')) {
    const viewport = unifiedViewport(), encoded = JSON.stringify(viewport);
    if (viewport && encoded !== unifiedControl.lastView) { unifiedControl.viewAt = now; unifiedControl.lastView = encoded; unifiedRequest('view'); }
  }
  for (const [id, request] of unifiedControl.pending) {
    if (now - (unifiedControl.sentAt.get(id) || 0) < 2000) continue;
    unifiedControl.sentAt.set(id, now);
    send(request); // 沿用相同 requestId 重送，由伺服器回覆已完成的 ACK。
  }
}
// ---- TPSRC BEGIN(11/17 使用者「我就是要判定 到底是不是用按鍵精靈」):瞬移指令順便帶上 來源 / 觸發的輸入 / 被打反應 / 延遲 / 焦點
// config.json tpSrc(gateway:BotSignalTpSourceEnabled)開著才帶;不多送任何封包。src:tpTag 標的程式路徑,沒有標 = 'key'(1 秒內按鍵)/ 'ui'(1 秒內點擊)/ 'timer'(沒有輸入)
const TPSIG = { tag: '', tagAt: -1e9, last: null, holds: [], hits: [], moveAt: -1e9, pingAt: 0, rtt: -1 };
function tpTag(tag) { TPSIG.tag = tag; TPSIG.tagAt = performance.now(); }
(() => {
  const down = (e) => {
    if (e.type === 'keydown' && e.repeat) return;
    const at = performance.now(), key = e.type === 'keydown', t = e.target;
    const el = t && t.closest ? t.closest('[id],button,.slot,li') : null;
    TPSIG.last = { type: e.type, trusted: e.isTrusted !== false && !window.__selfEvt, at,
      key: key ? String(e.code || e.key || '').replace(/[^\w]/g, '').slice(0, 16) : '', ptr: key ? '' : String(e.pointerType || '').replace(/[^\w]/g, '').slice(0, 8),
      x: key ? -1 : Math.round(e.clientX || 0), y: key ? -1 : Math.round(e.clientY || 0),
      el: el ? String(el.id || (typeof el.className === 'string' ? el.className : '') || el.tagName || '').replace(/[^\w\- ]/g, '').slice(0, 24) : '',
      mv: Math.min(60000, Math.round(at - TPSIG.moveAt)), up: 0 };
  };
  const up = (e) => {
    const l = TPSIG.last;
    if (!l || l.up || (e.type === 'keyup') !== (l.type === 'keydown')) return;
    l.up = performance.now(); TPSIG.holds.push(Math.min(5000, Math.round(l.up - l.at))); if (TPSIG.holds.length > 5) TPSIG.holds.shift();
  };
  for (const ty of ['keydown', 'pointerdown']) window.addEventListener(ty, down, true);
  for (const ty of ['keyup', 'pointerup']) window.addEventListener(ty, up, true);
  window.addEventListener('pointermove', () => { TPSIG.moveAt = performance.now(); }, { capture: true, passive: true });
})();
function tpHit() { const at = performance.now(), h = TPSIG.hits; h.push(at); while (h.length && (at - h[0] > 3000 || h.length > 40)) h.shift(); }
function tpIsTeleport(a) {
  if (a.t === 'home') return true;
  if (a.t === 'useskill') return a.skill === 5 || a.skill === 69;
  if (a.t === 'useitem') { const it = st.inv.get(a.id); return !!it && /(?:瞬間移動|傳送)卷軸/.test(String(it.name || '')); }
  return false;
}
function tpSource() {
  const at = performance.now(), l = TPSIG.last, h = TPSIG.hits.filter(x => at - x <= 3000);
  const tag = at - TPSIG.tagAt < 80 ? TPSIG.tag : '';
  const age = l ? Math.min(60000, Math.round(at - l.at)) : -1;
  const last = h.length ? h[h.length - 1] : 0;
  return { src: tag || (l && age < 1000 ? (l.type === 'keydown' ? 'key' : 'ui') : 'timer'), cauto: typeof auto !== 'undefined' && auto.on ? 1 : 0,
    in: l ? { ty: l.type, tr: l.trusted ? 1 : 0, k: l.key, p: l.ptr, x: l.x, y: l.y, el: l.el, mv: l.mv, age, hold: l.up ? Math.round(l.up - l.at) : -1 } : null,
    ph: TPSIG.holds.slice(-3), hit: last ? Math.round(at - last) : -1, hit0: h.length ? Math.round(at - h[0]) : -1, hn: h.length,
    hin: last && l && l.at >= last ? Math.round(l.at - last) : -1, rtt: TPSIG.rtt, foc: document.hasFocus() ? 1 : 0, vis: document.visibilityState === 'visible' ? 1 : 0 };
}
// ---- TPSRC END ----
const PARA_TELE_BLOCK = (a) => a.t === 'home' || a.t === 'dbookgo' || a.t === 'hbookgo' || a.t === 'npcaction'; // npcaction 全擋(傳送類字串太多,伺服器也全擋;原版客戶端麻痺時整個對話框鎖住)
const send = (a) => {
  if (a.t === 'autohunt') CLICKBEHAV.state(st.inGame, a.on === true);
  const ps = st.para ? paraState() : null;
  if (ps === 'full' && PARA_TELE_BLOCK(a)) { paraBlocked(a.t === 'npcaction' ? '麻痺中無法操作對話' : '麻痺中無法傳送'); return false; }
  if (ps && (a.t === 'move' || (ps === 'full' && PARA_FULL_BLOCK.has(a.t)))) return false;
  if (!st.ws || st.ws.readyState !== 1) return st.ws && false;
  if (a.t === 'useitem') { const gi = st.inv.get(a.id); if (gi && typeof isGear === 'function' && isGear(gi)) st.gearUseAt = performance.now(); } // #43:剛穿 / 脫裝備,堆疊拆合不算獲得
  if (a.t === 'ping') TPSIG.pingAt = performance.now();
  if (st.tpSrc && tpIsTeleport(a)) a = { ...a, tps: tpSource() }; // 11/17 tpsource
  const result = st.ws.send(JSON.stringify(a));
  if (a.t === 'useskill') hotbarCooldownSent(a.skill);
  const input = behavContext();
  if (input && BEHAV_ACTIONS.has(a.t) && !(a.t === 'useitem' && typeof isGear === 'function' && isGear(st.inv.get(a.id) || {}))) behavAccept(input, a.t);
  if ((a.t === 'mail' && (a.op === 2 || a.op === 3)) || (a.t === 'auction' && a.op >= 2 && a.op <= 4)) setTimeout(() => invResync(true), 800); // 領信件附件、拍賣上架 / 下架 / 購買後對一次背包
  return result;
};
// 10/28 背包重新同步:網頁背包和伺服器對不上時(漏收新增 / 數量通知,以前要重新整理才出現),請伺服器重送整個背包(C_WebMail op 6,伺服器每隻角色 3 秒最多一次)
let invSyncAt = -Infinity;
function invResync(force = false) {
  const now = performance.now();
  if (!st.inGame || now - invSyncAt < (force ? 3000 : 10000)) return;
  invSyncAt = now;
  send({ t: 'mail', op: 6, id: 0, text: '' });
}
const login = { last: null, retried: false }; // 最近一次送出的登入(被「已在線上」擋下時自動再試一次用)

// 切回網頁時(斷線補送 / 背景凍住時排隊的訊息)一次湧進大量事件:直接跳到最後的狀態,
// 不重播走路、攻擊、特效(不然畫面會像快轉一樣跑一大段)。一個畫面內收到超過 CATCHUP_PER_FRAME 筆就算在補
const CATCHUP_PER_FRAME = 20;
const CATCHUP_SKIP = new Set(['effect', 'effectat', 'rangeskill', 'rangedmg', 'attack']);
const catchUp = { n: 0, on: false, until: 0 };
function startCatchUp() { catchUp.on = true; catchUp.until = performance.now() + 500; }

function handle(ev, onReady) {
  if (ev.t === 'attack') noteAttackReceived(ev); // 10/26:補送(catchUp)略過攻擊動畫時,也要記「伺服器有回」,不然 AUTO 誤判沒回、自己放慢出手
  if (typeof statsEvent === 'function') { try { statsEvent(ev); } catch (e) { console.warn('掛機統計', e); } } // 掛機統計(hud.js);10/28:統計出錯不能擋住後面的戰鬥事件
  if (catchUp.on && CATCHUP_SKIP.has(ev.t)) return; // 補送中:過去的攻擊 / 特效不播
  switch (ev.t) {
    case 'error': $('#login-msg').textContent = ev.msg; log(ev.msg, 'err'); break;
    case 'session': resume.token = ev.token; checkBuild(ev.b); break;
    case 'gaccount': // Google 登入對應到的遊戲帳號(每個帳號的快捷欄等設定用這個分開存);信箱記下來,下次「進入遊戲」自動帶入
      st.account = ev.account;
      if (ev.email) setGoogleAccount(ev.email);
      break;
    case 'highpet': openHighPet(ev); break;
    case 'bosshunt': openBossHunt(ev); break;
    case 'hbook': openHuntPassBook(ev); break;
    case 'dbook': openDungeonBook(ev); break; // 地監記憶書:目的地清單(伺服器點書時送來)
    case 'shana': st.shana = ev.time > 0; setBuff('shana', '夏娜的變形卷軸', ev.time); break; // 伺服器 L1Shana:攻擊 / 施法 / 硬直照 SHANA_PER_MIN
    case 'atkrate': st.atkRate = ev.rate; break; // 變速變身卷軸:伺服器 AcceleratorChecker 也乘這個
    case 'remember': setRemember(ev.token); break;
    case 'banned': // 被管理員封鎖:斷線、回登入畫面,不要自動重連
      resume.token = null;
      setReconnecting(false);
      st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
      document.body.classList.remove('in-game');
      showScreen('login');
      $('#login-msg').textContent = ev.msg || '你已被封鎖';
      break;
    case 'rememberfail': setRemember(null); $('#login-msg').textContent = '自動登入已失效,請用 Google 登入'; break;
    case 'pong': conn.lastPong = Date.now(); if (TPSIG.pingAt) { TPSIG.rtt = Math.min(60000, Math.round(performance.now() - TPSIG.pingAt)); TPSIG.pingAt = 0; } checkBuild(ev.b); break;
    case 'build': checkBuild(ev.b); break;
    case 'resumed': if (typeof marketResume === 'function') marketResume(); if (typeof dutchResume === 'function') dutchResume(); if (unifiedControl.cap) { unifiedControl.dirty = true; unifiedRequest('resume'); } reportWebBackground(document.visibilityState === 'hidden'); startCatchUp(); resume.tries = 0; resume.deadline = 0; setReconnecting(false); toast('已重新連線'); onNetBack(); checkBuild(ev.b);
      if (typeof syncAutoHunt === 'function') syncAutoHunt(); // 斷線那幾秒按的 AUTO 沒送到(send 直接丟掉):接回後再同步一次,不然伺服器以為 AUTO 關、離開網頁不會離線掛機
      break;
    case 'webbg': webBgLimited = ev.limited === true; break;
    case 'bglogout': backgroundLogout(ev); break;
    case 'resumefail':
      if (ev.reason === 'background_timeout') backgroundLogout(ev);
      else resumeFailed();
      break;
    case 'kicked': // 同一個帳號在別的分頁 / 裝置登入了:這邊斷線,不要再自動重連(會把對方踢掉)
      resume.token = null;
      setReconnecting(false);
      st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
      document.body.classList.remove('in-game');
      log('此帳號已在其他地方登入,這裡已斷線。', 'err');
      toast('此帳號已在其他地方登入');
      showScreen('login');
      $('#login-msg').textContent = '此帳號已在其他地方登入';
      break;
    case 'idlewarn': toast(`停在選角畫面太久,${ev.sec} 秒後會自動斷線(點一下畫面可繼續)`); break; // gateway:選角畫面閒置 3 分鐘斷線的預告
    case 'idle': // 選角畫面閒置太久被 gateway 斷線:和 kicked 一樣不要自動重連,回到登入畫面
      resume.token = null;
      setReconnecting(false);
      st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
      document.body.classList.remove('in-game');
      showScreen('login');
      $('#login-msg').textContent = '停在選角畫面太久,已自動斷線,請重新登入';
      break;
    case 'serverversion': onReady && onReady(); break;
    case 'loginresult':
      if (ev.reason === 0) { login.retried = false; showScreen('chars'); }
      // 剛把同帳號的舊連線踢掉,伺服器可能還在登出存檔:「已在線上 / 使用中」就 2 秒後自動再試一次
      else if ((ev.reason === 7 || ev.reason === 22) && login.last && !login.retried) {
        login.retried = true;
        $('#login-msg').textContent = '正在中斷其他地方的登入…';
        setTimeout(() => send(login.last), 2000);
      } else $('#login-msg').textContent = { 7: '此帳號已在線上', 8: '帳號或密碼錯誤', 22: '此帳號使用中' }[ev.reason] || `登入失敗 (${ev.reason})`;
      break;
    case 'charamount': delete unifiedControl.resumeMapKey; delete unifiedControl.resumeMapInstance; delete unifiedControl.resumeMapAt; unifiedControl.phase = 'legacy'; unifiedControl.cap = null; unifiedControl.pending.clear(); unifiedControl.sentAt.clear(); unifiedControl.lastState = -1; st.chars = []; st.selling = new Set(); st.roster = null; st.maxChars = ev.max; clearTimeout(refreshSelling.t); refreshSelling.t = setTimeout(refreshSelling, 300); renderChars(); gmGiveOff(); break;
    case 'gm': if (ev.give) gmGiveOn(); break; // 只有 GM 角色進遊戲時,伺服器(gateway)才會送這個(altsettings GmGiveItemEnabled)
    case 'charlist':
      st.chars.push(ev.char); renderChars();
      clearTimeout(refreshSelling.t); refreshSelling.t = setTimeout(refreshSelling, 300);
      break;
    case 'charroster': onCharRoster(ev); break;
    case 'selling': {
      if (st.inGame || $('#screen-chars').classList.contains('hidden')) break;
      if (ev.roster || st.rosterError || st.roster) onCharRoster({ roster: ev.roster || null });
      const next = new Set(Array.isArray(ev.names) ? ev.names : []);
      const same = st.selling && next.size === st.selling.size && [...next].every((n) => st.selling.has(n));
      st.selling = next;
      if (!same) renderChars();
      break;
    }
    case 'deletecharok':
      if (rosterActive()) { st.roster = null; refreshSelling(); }
      if (ev.later) { $('#chars-msg').textContent = '這個角色要 7 天後才會刪除'; break; }
      st.chars = st.chars.filter((c) => c.name !== st.deleted); st.selChar = null; renderChars(); break;
    case 'newcharstatus':
      if (ev.reason !== 2) $('#nc-msg').textContent = { 6: '名稱已存在', 9: '名稱不合法', 21: '能力值或角色數量不正確' }[ev.reason] || `建立失敗 (${ev.reason})`;
      break;
    case 'newchar': {
      if (rosterActive()) { st.roster = null; refreshSelling(); }
      if (Number.isInteger(st.newSlot) && st.newSlot >= 0) { const m = slotMap(); m[ev.char.name] = st.newSlot; saveSlotMap(m); } // 建在點的那一格
      st.newSlot = null;
      st.chars.push(ev.char); renderChars(); $('#newchar-form').classList.add('hidden'); break;
    }
    case 'logintogame': enterGame(); break;
    case 'status':
      if (typeof appearanceLevelChanged === 'function') appearanceLevelChanged(st.me?.level, ev.level);
      st.selfId = ev.id; st.me = { ...st.me, ...ev }; updateHud(); break;
    case 'hp': if (st.me) { st.me.hp = ev.hp; st.me.maxHp = ev.maxHp; updateHud(); } break;
    case 'attrdef': // 11/06:四屬性抗性(伺服器 S_OwnCharAttrDef);人物面板顯示，開著的話立刻重畫
      st.me = { ...st.me, fire: ev.fire, water: ev.water, wind: ev.wind, earth: ev.earth };
      if (typeof panel !== 'undefined' && panel.name === 'char' && typeof renderPanelSoon === 'function') renderPanelSoon();
      break;
    case 'mp': if (st.me) { st.me.mp = ev.mp; st.me.maxMp = ev.maxMp; updateHud(); } break;
    case 'mapid': if (st.para && ev.map !== st.mapId) { st.para = null; setBuff('para', '', 0); } // 換地圖清掉麻痺類的鎖(伺服器也清)
      if (ev.map !== st.mapId) clearEventHuntTimer();
      st.portals = ev.portals || []; st.mapVer = ev.mapVer || ''; st.cave = !!ev.cave; st.blocked = ev.blocked || []; loadMap(ev.map, ev.name, ev.instance, ev.box); break;
    case 'gametime': st.gameTimeOff = ev.time - serverGameSec(Date.now()); break; // 只記手機時鐘和伺服器的差(通常 0)
    case 'effect': {
      // 瞬間移動的特效(L1Teleport.EFFECT_SPR):按下去就在原地播,不等施法動作出手、也不跟著人走
      // (伺服器送完特效約 0.2 秒就傳送,等出手 / 跟著人的話會變成到了目的地才播)
      const o = st.objects.get(ev.id);
      if (otherPc(ev.id) && (MINE_ONLY_FX || otherFxFull())) break; // 其他玩家身上的特效(加速、補血、傳送…):顯示,但同時最多 MAX_OTHER_FX 個(人多時手機不卡)
      if (TELEPORT_FX.has(ev.gfx)) { if (o) addEffect({ gfx: ev.gfx, x: o.px, y: o.py, map: st.mapId }); break; }
      later(castDelay(o), () => addEffect({ gfx: ev.gfx, follow: ev.id }));
      break;
    }
    case 'effectat': later(castDelay(), () => addEffect({ gfx: ev.gfx, x: ev.x, y: ev.y })); break;
    case 'rangeskill': onRangeSkill(ev); break;
    case 'rangedmg': // 範圍攻擊魔法的傷害數字(伺服器 S_WebRangeDamage,緊接在 rangeskill 後面):等特效打到再跳
      if (MINE_ONLY && ev.caster !== st.selfId) break; // 只顯示自己打出去的
      for (const h of ev.hits) {
        const t = st.objects.get(h.id);
        if (!t || t.kind === 'item') continue;
        later(impactWait(t), () => st.floaters.push({ x: t.x, y: t.y, text: h.dmg > 0 ? String(h.dmg) : 'MISS',
          kind: h.dmg > 0 ? (h.id === st.selfId ? 'hurt' : 'hit') : h.id === st.selfId ? 'missme' : 'miss', dmg: h.dmg,
          dx: (Math.random() - 0.5) * 18, born: performance.now() }));
      }
      break;
    case 'object': upsertObject(ev); break;
    case 'skin': { // Ordered after CHARPACK/POLY; never create an object from a cosmetic event.
      const o = st.objects.get(ev.id);
      if (o && o.kind === 'pc' && (o.skinRev == null || ((ev.rev - o.skinRev) >>> 0) < 0x80000000)) {
        o.skin = ev.gfx; o.skinRev = ev.rev;
      }
      break;
    }
    case 'move': moveObject(ev); break;
    case 'heading': { const o = st.objects.get(ev.id); if (o) o.heading = ev.heading; break; }
    case 'remove':
      st.objects.delete(ev.id);
      if (st.clickSelect && st.picked?.id === ev.id) clearPicked();
      // 目標不見了(思克巴這類會順移的怪:伺服器先移除、之後在新位置重新出現):追牠的路也不要走了,AUTO 才會馬上重新找怪
      if (st.target && st.target.id === ev.id) { st.target = null; st.path = []; }
      break;
    case 'pink': (st.pink ??= new Map()).set(ev.id, ev.sec > 0 ? performance.now() + ev.sec * 1000 : 0); break; // 10/31 先動手粉紅名(伺服器 S_PinkName,180 秒)
    case 'hpmeter': { const o = st.objects.get(ev.id); if (o) later(impactWait(o), () => { o.hpRatio = ev.ratio > 100 ? -1 : ev.ratio; }); break; } // 0xFF(255)= 隱藏血條(離開 / 解散隊伍 L1Party 送),不是 255%
    case 'yesno': openYesNo(ev); break;
    case 'trade': openTrade(ev.name); break;
    case 'tradeadd': addTradeItem(ev); break;
    case 'tradestatus': endTrade(ev.done); break;
    case 'tradepartnerok': trade.partnerOk = true; renderTrade(); toast(`${trade.partner} 已確定交易`); break;
    case 'party': updateParty(ev.members, ev.partyType, ev.clanParty); break;
    case 'crit': (st.crits ??= new Map()).set(ev.target, performance.now()); break; // 下一個打這個目標的數字是暴擊
    case 'liquor': { // 三段加速(種類 8):走路、攻擊再快 1.15 倍(伺服器 AcceleratorChecker 一樣 × 0.87)
      const o = st.objects.get(ev.id); if (o) o.third = ev.level === 8;
      if (ev.id === st.selfId) setBuff('third', '三段加速', ev.level === 8 ? -1 : 0);
      break;
    }
    case 'light': { const o = st.objects.get(ev.id); if (o) o.light = ev.size; break; } // 日光術 / 燈:光圈大小
    case 'bookmarks': st.bookmarks = ev.list; break; // 記憶座標(登入時整份)
    case 'bookmark': // 新增一筆記憶座標
      st.bookmarks = [...(st.bookmarks || []).filter((b) => b.name !== ev.name), ev];
      toast(`已記憶「${ev.name}」(${ev.mapName || ''} ${ev.x}, ${ev.y})`);
      if (dlg.mode === 'teleport') openTeleportSheet(dlg.scroll, dlg.skill, dlg.listOnly);
      break;
    case 'mail': // 信箱(伺服器 C_WebMail / L1Mail):只有 unread = 紅點更新;有 mails = 整份資料
      setMailBadge(ev.unread);
      if (ev.mails) st.mail = ev;
      if (ev.msg) { toast(ev.msg); log(ev.msg, 'sys'); }
      if (panel.name === 'mail') renderPanel();
      break;
    case 'renameresult': if (typeof renameResult === 'function') renameResult(ev); break; // 改名卡結果(hud.js;事件名不用 rename:S.CHANGENAME 物件改名已經是 t:'rename')
    case 'dutch': if (typeof onDutch === 'function') onDutch(ev); break;
    case 'eva': if (typeof evaEvent === 'function') evaEvent(ev); break; // 伊娃的寶藏(eva.js;伺服器 C_WebEva)
    case 'charmarket': onCharMarket(ev); break;
    case 'auction': // 拍賣行(伺服器 C_WebAuction / L1Auction):tab = browse / detail(一種道具的各單價)/ mine / buy(購買結果只有 msg)
      if (ev.tab === 'browse') au.browse = ev;
      if (ev.tab === 'detail' && ev.key === au.detailKey) au.detail = ev;
      if (ev.tab === 'mine') { au.mine = ev; au.mineAsked = false; }
      if (ev.tab === 'sales') { au.sales = ev; au.salesAsked = false; if (ev.page != null) au.salesPage = ev.page; } // 販售紀錄(hud.js renderAuctionSales)
      if (ev.msg) { toast(ev.msg); log(ev.msg, 'sys'); }
      if (ev.tab === 'buy' && panel.name === 'auction') {
        au.browse = null; auctionBrowse();
        if (au.detailKey) { au.detail = null; auctionDetail(au.detailKey); } // 在明細頁買的:重抓這種道具的各單價
      }
      auctionEvent(ev);
      if (panel.name === 'auction') renderPanel();
      break;
    case 'clan': // 血盟面板資料(伺服器 C_WebClan)
      st.clan = ev;
      if (ev.msg) { toast(ev.msg); log(ev.msg, 'sys'); }
      if (panel.name === 'clan') renderPanel();
      break;
    case 'pkrank': { const o = st.objects.get(ev.id); if (o) o.pkRank = ev.rank; break; }
    case 'pkrankself': st.pkRankSelf = { rank: ev.rank, kills: ev.kills }; if (typeof renderBuffs === 'function') renderBuffs(); break;
    case 'title': { const o = st.objects.get(ev.id); if (o) o.title = ev.title; break; }
    case 'rename': { const o = st.objects.get(ev.id); if (o) o.name = ev.name; if (dlg.mode === 'pet' && dlg.npc === ev.id) $('#dlg-title').textContent = ev.name; break; }
    case 'attack': if (ev.target && ev.target === st.selfId && ev.attacker !== st.selfId) tpHit(); onAttack(ev); break;
    case 'action': onAction(ev); break;
    case 'poly': { const o = st.objects.get(ev.id); if (o) o.gfx = ev.gfx; break; }
    case 'weapon': { const o = st.objects.get(ev.id); if (o) { o.weapon = ev.weapon; if (o.kind === 'monster') o.buried = sunkStatus(ev.weapon, o.name); } break; } // 怪鑽出土(appearOnGround)也會送這個
    case 'haste': {
      const o = st.objects.get(ev.id); if (o) o.speed = ev.level;
      if (ev.id === st.selfId) setBuff('haste', ev.level === 2 ? '緩速術' : '加速', ev.level ? ev.time : 0);
      break;
    }
    case 'brave': {
      const o = st.objects.get(ev.id); if (o) o.brave = ev.level;
      // 二段加速種類對照 AcceleratorChecker:1 勇水、3 精靈餅乾、4 神疾 / 風之疾走、5 超級加速、6 血之渴望
      if (ev.id === st.selfId) {
        let label = { 1: '勇敢藥水', 3: '精靈餅乾', 4: '神聖疾走', 5: '超級加速', 6: '血之渴望' }[ev.level] || '勇敢';
        // 神聖疾走和風之疾走伺服器送的都是 4:看剛才放的是哪一個;登入時補回的沿用上次記的(存在瀏覽器)
        if (ev.level === 4 && st.myType === 2) label = '風之疾走'; // 妖精的 4 一定是風之疾走(重新登入補回時才不會顯示成神聖疾走)
        else if (ev.level === 4) {
          const bKey = `brave4:${st.myName || st.selChar?.name || '_'}`;
          const t52 = lastCast[52] ?? -1; const t150 = lastCast[150] ?? -1;
          if (Math.max(t52, t150) > performance.now() - 5000) { label = t150 > t52 ? '風之疾走' : '神聖疾走'; store.set(bKey, label); }
          else label = st.buffs.get('brave')?.label === '風之疾走' ? '風之疾走' : store.get(bKey, '神聖疾走');
        }
        setBuff('brave', label, ev.level ? ev.time : 0);
      }
      break;
    }
    case 'buff': if (isEventHuntCountdown(ev.key)) { setEventHuntTimer(ev.key, ev.time); break; }
      setBuff(ev.key, ev.label || (ev.skill === 10100 ? '戰鬥強化卷軸' : st.game.skills?.[ev.skill]?.name) || '', ev.time); break; // 自訂 buff 用魔法名稱(圖示用魔法本身的圖)
    case 'poison': if (ev.id === st.selfId) setBuff('poison', ev.poison === 'paralyze' ? '麻痺毒' : '中毒', ev.poison ? -1 : 0); break;
    case 'paralysis': { // 麻痺類狀態開始 / 解除:開始時清掉排好的路線和待放的魔法,解鎖那一刻不會一口氣衝出去
      st.para ??= {};
      if (ev.on) { st.para[ev.kind] = performance.now() + PARA_MAX_MS; st.path = []; st.pendingCast = null; } else delete st.para[ev.kind];
      const left = paraState() ? Object.keys(st.para) : [];
      setBuff('para', left.length ? PARA_LABEL[left[0]] || '麻痺' : '', left.length ? -1 : 0);
      if (!left.length) st.para = null;
      break;
    }
    case 'lawful':
      if (ev.id === st.selfId && st.me) { st.me.lawful = ev.lawful; updateHud(); }
      { const o = st.objects.get(ev.id); if (o) o.lawful = ev.lawful; }
      break;
    case 'spmr': if (st.me) { st.me.sp = ev.sp; st.me.mrBonus = ev.mr; updateHud(); } break;
    case 'addskill': ev.ids.filter((id) => st.game?.skills?.[id]?.name !== 'none').forEach((id) => st.skills.add(id)); renderSkills(); renderLearn(); break; // none:沒有這個魔法的空位(例如 3 階第 8 格)
    case 'delskill': ev.ids.forEach((id) => st.skills.delete(id)); renderSkills(); break;
    case 'chat':
      if (!st.inGame && ev.kind === 9 && Date.now() - (st.deleteAt || 0) < 10000) { $('#chars-msg').textContent = ev.text; break; } // 刪角色被拒的系統訊息(選角畫面沒有聊天框,顯示在選角訊息列)
      onChat(ev); break;
    case 'excludes': case 'exclude': onExclude(ev); break;
    case 'offlinereport': if (!ev.huntDuplicate) showOfflineReport(ev.report); break;
    case 'huntledger': break; // statsEvent consumes the server-confirmed cumulative snapshot
    case 'huntstats': if (typeof huntApiResult === 'function') huntApiResult(ev); break;
    case 'otpneed':
      if (/^拍賣(上架|購買)$/.test(ev.what)) auctionOtpNeed();
      if (ev.what === '鑽石拍賣' && typeof dutchOtpNeed === 'function') dutchOtpNeed(); openOtp(ev.what); break; // 交易前要先驗證手機
    case 'otp': otpResult(ev); break;
    case 'deadpets': showResTargets(ev.ids); break; // 復活卷軸:死掉的寵物(項圈)
    case 'deathlog': st.deathLog = ev.list; if (typeof panel !== 'undefined' && panel.name === 'deathlog') renderPanel(); break; // 死亡紀錄(gateway 查 DB)
    case 'ranking': if (typeof ev.pkEnabled === 'boolean') st.pkRank = ev.pkEnabled; st.rankingData = ev; if (typeof panel !== 'undefined' && panel.name === 'char' && panel.tab === 'rank') renderPanel(); break; // 排行榜(gateway 查 DB)
    case 'elfattrfail': // 艾利溫選屬性失敗(gateway 查 DB 先擋下):不是妖精 / 已經有屬性
      toast(ev.elf ? `你已經有${ELF_ATTR_NAME[ev.attr] || ''}屬性了,要換屬性請先「精靈魔法刪除」。` : '只有妖精可以選擇屬性。');
      break;
    case 'elfattr': { // 艾利溫選屬性成功
      log(`忽然全身充滿了${['', '火', '水', '風', '地'][ev.attr] || ''}的靈力。`, 'sys');
      closeDialog();
      break;
    }
    case 'servermsg': diagRing('msgLog', { t: performance.now(), id: ev.id }, 10); if (ev.id === 263 || ev.id === 82) st.bagFullAt = performance.now(); if (ev.id === 110) onOverweightAttack(); if (whisperServerError(ev)) break; if (typeof msgSeen === 'function') msgSeen(ev); if (typeof msgHidden === 'function' && msgHidden(ev)) break; try { if (gainMsgHold(ev)) break; } catch (err) { console.warn('gainMsgHold hook', err); } log(ev.id === 81 ? `目前線上人數:${ev.args[0]} 人(含離線掛機)` : serverMsg(ev), 'sys'); break; // 81:/who 的回覆(S_WhoAmount)
    case 'inventory': collectionInventoryChanged(); st.inv.clear(); ev.items.forEach((i) => st.inv.set(i.id, i)); renderInv(); break;
    case 'additem': collectionInventoryChanged(); { const prevItem = st.inv.get(ev.item.id); st.inv.set(ev.item.id, ev.item); renderInv(); try { itemGainNotice(prevItem ? { count: prevItem.count } : null, ev.item); } catch (err) { console.warn('itemGainNotice hook', err); } break; } // 同編號重送(穿脫 / 鑑定 / 狀態更新)用前後數量比,不算獲得
    case 'itemupdate': collectionInventoryChanged(); { const i = st.inv.get(ev.item.id); if (i) { const oldCount = i.count; const stripN = (n) => String(n || '').replace(/ \(\d+\)$/, ''); const countOnly = stripN(i.name) === stripN(ev.item.name) && (!('wdmg' in ev.item) || ev.item.wdmg === (i.wdmg ?? 0)); i.name = ev.item.name; i.count = ev.item.count; if ('wdmg' in ev.item) i.wdmg = ev.item.wdmg; renderInv(i.id, countOnly); try { itemGainNotice({ count: oldCount }, i); } catch (err) { console.warn('itemGainNotice hook', err); } } break; } // 10/29:只有數量變(射箭、喝水)走增量更新,不整排重建快捷欄(弓箭角色每 0.65 秒一箭,整排 canvas 重建讓內顯筆電掉幀)
    case 'itemname': collectionInventoryChanged(); { const i = st.inv.get(ev.id); if (i) { i.name = ev.name; renderInv(i.id); } break; }
    case 'delitem': collectionInventoryChanged(); st.inv.delete(ev.id); st.locks.delete(ev.id); renderInv(); break;
    case 'locks': collectionInventoryChanged(); st.locks = new Set(ev.ids || []); st.itemLock = true; renderInv(); break; // 進遊戲、背包送完之後送一次:所有上鎖的道具(開關關著伺服器不送 = 沒有上鎖功能)
    case 'settings': if (typeof srvSetOnEvent === 'function') srvSetOnEvent(ev); break; // AUTO 設定存伺服器:進遊戲後的伺服器版本 / 存檔衝突時的最新版(hud.js)
    case 'settingsack': if (typeof srvSetAck === 'function') srvSetAck(ev); break; // 設定存檔成功(新版本)/ 放棄
    case 'unifiedhunt': unifiedAutoEvent(ev); break;
    case 'orengate': if (typeof orenGateEvent === 'function') orenGateEvent(ev); break; // ORENGATE_1119
    case 'autosupply': if (typeof srvSupplyEvent === 'function') srvSupplyEvent(ev); break; // 伺服器補給開關(登入一次、切換時廣播)
    case 'autospent': if (typeof srvSpentEvent === 'function') srvSpentEvent(ev); break; // 伺服器替你付費喝 / 買的金幣
    case 'pk': st.pkCount = ev.n; if (typeof panel !== 'undefined' && panel.name === 'char' && typeof renderPanel === 'function') renderPanel(); break; // 11/03 目前 PK 次數(伺服器登入時 / 變動時送;贖罪卷軸視窗用)
    case 'dailyquest': dailyQuestEvent(ev); break;
    case 'collection': collectionEvent(ev); break;
    case 'appearance': appearanceEvent(ev); break;
    case 'equipsets': st.equipSets = ev.sets || []; if (typeof syncEquipQuick === 'function') syncEquipQuick(); if (typeof panel !== 'undefined' && panel.name === 'char') renderPanelSoon(); break; // 進遊戲 / 查詢 / 存 / 清除之後的整份裝備組;開關關著伺服器不送 = 不顯示
    case 'equipapplied': equipSetApplied(ev); break; // 套用結果:換了幾件、沒換成功的件名和原因
    case 'emblem': onEmblemEvent(ev); break; // S_CharReset 0x3c:某個角色(盟員)的盟徽換了 / 被刪
    case 'lock': collectionInventoryChanged(); if (ev.locked) st.locks.add(ev.id); else st.locks.delete(ev.id); renderInv(ev.id); break; // 上鎖 / 解鎖成功
    case 'html':
      // 空白頁 = 原版的「關閉對話」(例如製作完 C_Amount 回的 HTML_CLOSE,而且帶的是 NPC 樣板編號不是物件編號):
      // 不開新視窗,不然會變成找不到 NPC 的預設對話「你好,冒險者」;製作畫面由 craftRecipe 自己刷新
      if (!ev.page) break;
      if (ev.page === 'sealcraft') { confirmSealedCraft(ev); break; }
      if (ev.page === 'RaiseAttr') { st.raisePending = true; openRaiseAttr(); break; } // 51 級起升級:能力值加點(hud.js)
      if (ev.page === 'anicom') { openPetMenu(ev); break; } // 點自己的寵物:寵物選單
      // 11/10 玩家「買角色後點亞丁回收商沒有反應」:身上沒有回收商收購的道具(例如只剩刻印道具)時伺服器回 nosell 頁,
      // 原本被當成「選單已開」略過、畫面沒反應 → 照樣開販賣視窗,顯示「身上沒有這位商人收購的道具。」
      if (ev.page === 'nosell') { openShopSell({ npc: ev.id, items: [] }); break; }
      if (ev.page === 'moncom') { openSummonMenu(ev); break; } // 點自己的召喚獸:召喚獸選單
      if (dlg.mode === 'craft' && dlg.npc === ev.id) break; // 製作完伺服器回的對話(關閉 / 結果):留在製作視窗,清單由 openCraft 自己刷新
      {
        const pend = npcPageArrived(ev.id); // 點 NPC 後在等的就是這一頁
        // 11/13 使用者「娜魯帕 改成對話就顯示製作清單」:選單標了 craftDirect 的 NPC 一對話就開製作清單(不先顯示原版對話)
        { const cm = st.objects.get(ev.id)?.menu; if (cm?.craftDirect && cm.craft?.some(craftEnabled)) { openCraft(ev.id, st.objects.get(ev.id)?.name, cm.craft, cm.craftLabel); break; } }
        if (ev.page && openDialogPage(ev.id, ev.page.toLowerCase())) break; // 有原版對話文字的頁面(dialogs.json)
        if (pend) { openNpcDialog(pend); break; } // 沒有原版文字的頁面:開暫代對話(帶 NPC 的選單按鈕)
      }
      // 點 NPC 時已先開好對話框,伺服器回來的同一位 NPC 就不重開
      if (dlg.mode !== 'menu' || dlg.npc !== ev.id) openNpcDialog(ev);
      break;
    case 'retrievelist': if (ev.kind === 12) openPetWithdraw(ev); break; // 寵物管理員:領出寵物
    case 'shopbuy': openShopBuy(ev); break;
    case 'shopsell': openShopSell(ev); break;
    case 'skillbuylist': openSkillBuy(ev); break;
    case 'disconnect': clearEventHuntTimer(); log('伺服器要求中斷連線', 'err'); break;
  }
}

// 系統訊息原文在客戶端 string 檔裡,這裡只翻常用的幾則
const MSG = {
  143: '{0} 給你 {1}。',
  263: '背包已滿,無法再攜帶更多道具。',
  82: '此物品太重了,所以你無法攜帶。',
  276: '在此無法使用傳送。',
  403: '獲得 {0}。',
  77: '你覺得舒服多了。',
  698: '喉嚨灼熱,無法喝東西。',
  210: '{0} 無法丟棄或交給他人。',
  189: '金幣不足。',
  337: '{0} 不足。', // 例如打芮克妮時她身上沒有安特之樹枝、NPC 製作缺材料
  79: '沒有任何事情發生。',
};
// 訊息 110「道具太重了,無法戰鬥」(伺服器 C_Attack:weight242 >= 197):之後所有攻擊都被丟掉。AUTO 直接停手並提示,不再一直出手
let overweightAt = 0;
function onOverweightAttack() {
  silentHit.n = 0; // 伺服器有回(這則訊息),不算「沒有回應」
  const now = performance.now();
  if (auto.on) {
    stopAuto('負重太重'); st.target = null; st.path = [];
    log('AUTO:負重太重,無法攻擊,已停止自動打怪;請先丟棄或賣掉一些東西。', 'sys');
    toast('負重太重,無法攻擊');
  } else if (now - overweightAt > 3000) toast('負重太重,無法攻擊');
  overweightAt = now;
}
function serverMsg(ev) {
  const tpl = MSG[ev.id];
  if (tpl) return tpl.replace(/\{(\d)\}/g, (m, i) => ev.args[i] ?? '');
  if (ev.text) return ev.text; // gateway 從客戶端字串表(string-c.tbl)翻好的
  return `系統訊息 #${ev.id}${ev.args.length ? ':' + ev.args.join(' / ') : ''}`;
}

// ---------------- 登入 / 選角 ----------------
function showScreen(name) {
  if (name !== 'game') updateParty([]); // 登出 / 換角不沿用上一個隊伍的類型
  for (const s of ['login', 'chars']) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
  $('#hud').classList.toggle('hidden', name !== 'game');
  if (name === 'chars') popChangelog();
}

// Google 登入:
//   第一次(這台瀏覽器沒用過)顯示 Google 的按鈕;選過帳號之後改顯示我們自己的帳號列(信箱 + 切換帳號),
//   因為 Google 的按鈕永遠顯示 Google 自己認定的預設帳號,不一定是玩家選的那個。
//   「進入遊戲」:有剛選好的憑證就用;沒有就開 Google 小視窗(帶入記住的信箱,通常一閃就自己關掉)拿 access token,交給 gateway 驗證
// (Brave 等瀏覽器會擋 Google 的自動登入提示,所以不靠 id.prompt())
const lastGoogle = () => { try { return localStorage.getItem('l1j.gLast') || ''; } catch { return ''; } };
// 裝置 ID:第一次打開網頁時產生、存在這台裝置的瀏覽器,登入時帶給 gateway(防多開:一台裝置同時只能登入一個帳號、封鎖用)
// ---- Device Token storage:僅正常 first-party storage,不利用 cache/ETag/HSTS 復活 ----
const DEVICE_STORAGE_KEY = 'l1j.deviceToken';
const DEVICE_JS_COOKIE = '__Host-l1j_device_js';
function deviceIdb(value) {
  return new Promise((resolve) => {
    let done = false, database = null, tx = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (database) database.close(); resolve(v); };
    const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(null); }, 1200);
    try {
      const request = indexedDB.open('l1j-device', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('token')) request.result.createObjectStore('token'); };
      request.onerror = () => finish(null);
      request.onsuccess = () => {
        database = request.result;
        if (done) { database.close(); return; }
        tx = database.transaction('token', value === undefined ? 'readonly' : 'readwrite');
        const store = tx.objectStore('token');
        const op = value === undefined ? store.get('current') : store.put(value, 'current');
        let result = null;
        op.onsuccess = () => { result = value === undefined ? op.result ?? null : value; };
        tx.oncomplete = () => finish(result); tx.onerror = tx.onabort = () => finish(null);
      };
    } catch { finish(null); }
  });
}
async function deviceStorageRead() {
  let local = null, cookie = null;
  try { local = localStorage.getItem(DEVICE_STORAGE_KEY); } catch {}
  try {
    const cookies = document.cookie.split(';').map((v) => v.trim()).filter((v) => v.startsWith(DEVICE_JS_COOKIE + '='));
    cookie = cookies.length > 1 ? 'duplicate-cookie' : cookies[0]?.slice(DEVICE_JS_COOKIE.length + 1) || null;
  } catch {}
  return { idb: await deviceIdb(), local, cookie };
}
async function deviceReconcileStorage() {
  const run = async (retry = true) => {
    const before = await deviceStorageRead();
    const r = await fetch('/api/device-token', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': '1' }, body: JSON.stringify(before), signal: AbortSignal.timeout(6000) });
    const result = await r.json();
    if (!r.ok) throw new Error('裝置識別暫時無法記錄');
    if (result.state === 'conflict' || result.state === 'disabled') return result;
    if (!/^[0-9a-f]{64}$/.test(result.token || '')) throw new Error('裝置識別回應錯誤');
    // 等待期間另一個分頁改了 storage,不把它靜默蓋掉;下一次校對會記衝突。
    const current = await deviceStorageRead();
    if (Object.values(current).some((v) => v && v !== result.token)) {
      if (retry) return run(false); // 再送當前四份值,由 server 留下衝突事件。
      return { state: 'conflict' };
    }
    if (!current.idb) await deviceIdb(result.token);
    try { if (!current.local) localStorage.setItem(DEVICE_STORAGE_KEY, result.token); } catch {}
    try { if (!current.cookie) document.cookie = `${DEVICE_JS_COOKIE}=${result.token}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`; } catch {}
    return result;
  };
  return navigator.locks?.request ? navigator.locks.request('l1j-device-token', () => run()) : run();
}
// 進站即申請;登入前再讀四份。失敗不改既有 devid 政策,server enforce 仍會拒絕缺少有效收據。
const deviceTokenReady = deviceReconcileStorage().then(() => {}, () => {});
// ---- Device Token storage end ----
function devId() {
  try {
    let d = localStorage.getItem('l1j.devid');
    if (!d) { d = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; localStorage.setItem('l1j.devid', d); }
    return d;
  } catch { return ''; } // 無痕模式等存不了:不帶
}
// 硬體特徵:換瀏覽器也大致不變的值(作業系統、螢幕大小、色深、時區、觸控點數),gateway 跟 IP 一起比對「同一台裝置」
// (只用各瀏覽器都一樣、防指紋模式以外不會被打亂的項目;單獨不準,要配上同一個網路才算同一台)
function hwFp() {
  try {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac' : 'other';
    const txt = [os, Math.max(screen.width, screen.height), Math.min(screen.width, screen.height), screen.colorDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '', navigator.maxTouchPoints || 0].join('|');
    let h1 = 0x811c9dc5, h2 = 0x1505;
    for (let i = 0; i < txt.length; i++) { const c = txt.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = (Math.imul(h2, 33) + c) >>> 0; }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  } catch { return ''; }
}
// 顯示卡名稱(WebGL renderer):只寫進登入紀錄,管理網頁用來看出雲端主機 / 虛擬機(SwiftShader、llvmpipe、VMware…),不擋人
function gpuName() {
  if (gpuName.v !== undefined) return gpuName.v;
  gpuName.v = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName.v = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '').slice(0, 128);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* 沒有 WebGL */ }
  return gpuName.v;
}
// ---- fp2 v1: only hashes leave the browser; D = cross-browser candidates, B = browser-specific.
// D is best effort, not a hardware identity: drivers, browser privacy controls and OS updates can change it.
const FP2_DEVICE_KEYS = ['dc', 'df', 'dg', 'dm', 'dp', 'ds', 'dt', 'dx'];
const FP2_REQUIRED_KEYS = ['dc', 'df', 'dg', 'dp', 'ds', 'dt', 'dx'];
const FP2_FONTS = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Arial Unicode MS', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS',
  'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact',
  'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Emoji',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Roboto', 'Ubuntu',
  'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif', 'Noto Sans', 'Noto Serif', 'Cantarell',
  'Droid Sans', 'Droid Serif', 'Menlo', 'Monaco', 'San Francisco', 'Avenir', 'Avenir Next', 'Futura',
  'Gill Sans', 'Optima', 'Baskerville', 'American Typewriter', 'Apple Color Emoji', 'Noto Color Emoji',
  'Microsoft JhengHei', 'Microsoft JhengHei UI', 'Microsoft YaHei', 'Microsoft YaHei UI', 'MingLiU', 'PMingLiU',
  'MingLiU-ExtB', 'DFKai-SB', 'SimSun', 'NSimSun', 'SimHei', 'FangSong', 'KaiTi', 'PingFang TC', 'PingFang SC',
  'Heiti TC', 'Heiti SC', 'Songti TC', 'Songti SC', 'STHeiti', 'STSong', 'LiHei Pro', 'LiSong Pro',
  'Noto Sans CJK TC', 'Noto Sans CJK SC', 'Noto Serif CJK TC', 'Source Han Sans TC', 'Source Han Serif TC',
  'MS Gothic', 'MS PGothic', 'MS Mincho', 'Meiryo', 'Yu Gothic', 'Yu Mincho', 'Hiragino Kaku Gothic ProN',
  'Hiragino Mincho ProN', 'Noto Sans CJK JP', 'Malgun Gothic', 'Gulim', 'Dotum', 'Batang',
  'Apple SD Gothic Neo', 'Nanum Gothic', 'Noto Sans CJK KR', 'Noto Serif CJK KR',
];
function collectFp2(budgetMs = 1500) {
  const empty = () => ({ d: '', b: '', c: {} });
  return new Promise((resolve) => {
    const now = () => performance.now();
    const deadline = now() + budgetMs;
    const c = {}, cleanup = [];
    let stopped = false, finishing = false, workTimer, hardTimer;
    const alive = () => !stopped && !finishing && now() < deadline - 100;
    const pause = () => new Promise((r) => setTimeout(r, 0));
    const digest = async (value) => {
      const data = new TextEncoder().encode(JSON.stringify(value));
      const buf = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf), (n) => n.toString(16).padStart(2, '0')).join('');
    };
    const put = async (key, value) => {
      if (!alive() || value === undefined || value === null) return;
      try { const h = await digest(value); if (alive()) c[key] = h; } catch { /* unavailable or denied */ }
    };
    const end = (result) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(workTimer); clearTimeout(hardTimer);
      for (const f of cleanup) { try { f(); } catch { /* best effort */ } }
      resolve(result);
    };
    const finish = async () => {
      if (stopped || finishing) return;
      finishing = true;
      const parts = Object.fromEntries(Object.keys(c).sort().map((k) => [k, c[k]]));
      try {
        const entries = Object.entries(parts);
        const [d, b] = await Promise.all([
          FP2_REQUIRED_KEYS.every((k) => parts[k])
            ? digest(['fp2:1:device', entries.filter(([k]) => FP2_DEVICE_KEYS.includes(k))]) : '',
          entries.length ? digest(['fp2:1:browser', entries]) : '',
        ]);
        end({ d, b, c: parts });
      } catch { end(empty()); }
    };
    // Reserve 100 ms for aggregate hashes. A stuck browser API/digest never holds login open.
    hardTimer = setTimeout(() => end(empty()), budgetMs);
    workTimer = setTimeout(() => { void finish(); }, Math.max(0, budgetMs - 100));
    const job = (run) => pause().then(() => alive() ? run() : undefined).catch(() => {});
    const jobs = [
      job(async () => { // D: normalized platform, CPU, optional RAM, screen, timezone, Math.
        const n = navigator, s = screen, ua = n.userAgent || '';
        const os = /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(n.platform || ua) && n.maxTouchPoints > 1)
          ? 'ios' : /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac' : /Linux/.test(ua) ? 'linux' : 'other';
        await put('dp', os);
        if (n.hardwareConcurrency > 0) await put('dc', n.hardwareConcurrency);
        if (n.deviceMemory > 0) await put('dm', n.deviceMemory);
        if (s.width > 0 && s.height > 0) await put('ds', [Math.min(s.width, s.height), Math.max(s.width, s.height), s.colorDepth]);
        await put('dt', Intl.DateTimeFormat().resolvedOptions().timeZone);
        await put('dx', [Math.sin(1e100), Math.sin(Math.PI), Math.tan(-1e100), Math.cos(1e20), Math.exp(1),
          Math.expm1(1e-10), Math.log1p(1e-10), Math.log(10), Math.pow(Math.PI, -100), Math.atan2(1e-300, -1e-300),
          Math.sinh(1), Math.cosh(1), Math.tanh(1), Math.acos(0.123456789)].map(String));
      }),
      job(async () => { // B: navigator, screen details and user preferences.
        const n = navigator, s = screen;
        await put('nv', [n.hardwareConcurrency, n.deviceMemory, n.platform, Array.from(n.languages || []),
          n.maxTouchPoints, n.pdfViewerEnabled, n.webdriver, n.userAgent]);
        await put('sc', [s.width, s.height, s.availWidth, s.availHeight, s.colorDepth, s.pixelDepth,
          window.devicePixelRatio, s.orientation?.type, s.orientation?.angle]);
        const media = ['color-gamut: srgb', 'color-gamut: p3', 'color-gamut: rec2020', 'dynamic-range: high',
          'video-dynamic-range: high', 'prefers-color-scheme: dark', 'prefers-color-scheme: light',
          'prefers-reduced-motion: reduce', 'prefers-contrast: more', 'prefers-contrast: less',
          'prefers-reduced-transparency: reduce', 'prefers-reduced-data: reduce', 'forced-colors: active',
          'hover: hover', 'any-hover: hover', 'pointer: fine', 'pointer: coarse', 'pointer: none',
          'any-pointer: fine', 'any-pointer: coarse'];
        await put('mq', media.map((q) => [q, matchMedia('(' + q + ')').matches]));
        await put('il', [Intl.DateTimeFormat().resolvedOptions(), Intl.NumberFormat().resolvedOptions()]);
      }),
      job(async () => { // B: permission-free high entropy client hints.
        if (navigator.userAgentData?.getHighEntropyValues) await put('ua', await navigator.userAgentData.getHighEntropyValues(
          ['platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']));
      }),
      job(async () => { // B: fixed canvas text/emoji/gradient/blending.
        const cv = document.createElement('canvas'); cv.width = 280; cv.height = 80;
        const x = cv.getContext('2d'); if (!x) return;
        const g = x.createLinearGradient(0, 0, 280, 80);
        g.addColorStop(0, '#19a8c7'); g.addColorStop(0.5, '#ed7510'); g.addColorStop(1, '#674eaa');
        x.fillStyle = g; x.fillRect(0, 0, 280, 80);
        x.font = '18px Arial'; x.fillStyle = '#174';
        x.fillText('L1J fp2 漢字 あいう 한글 \u{1f600}\u{1f30f}', 3, 25);
        x.globalCompositeOperation = 'multiply'; x.fillStyle = 'rgba(210,40,180,.7)';
        x.beginPath(); x.arc(90, 43, 30, 0, Math.PI * 2); x.fill();
        x.globalCompositeOperation = 'screen'; x.fillStyle = '#1278af'; x.fillRect(60, 30, 120, 37);
        await put('ca', Array.from(x.getImageData(0, 0, cv.width, cv.height).data));
      }),
      job(async () => { // D: font presence; B: exact text widths (engine dependent).
        const x = document.createElement('canvas').getContext('2d'); if (!x) return;
        const sample = 'mmmmmmmmWWii0123456789漢字かなカナ한글';
        const bases = ['monospace', 'sans-serif', 'serif'];
        const measure = (font) => { x.font = '72px ' + font; return x.measureText(sample).width; };
        const baseline = bases.map(measure), widths = [], found = [];
        for (let i = 0; i < FP2_FONTS.length; i++) {
          if (!alive()) return; // incomplete font scans never become device hashes
          const font = FP2_FONTS[i], w = bases.map((b) => measure('"' + font + '",' + b));
          widths.push([font, ...w]);
          if (w.some((v, j) => Math.abs(v - baseline[j]) > 0.01)) found.push(font);
          if (i % 8 === 7) await pause();
        }
        if (found.length) await put('df', found.sort());
        await put('fw', widths);
      }),
      job(async () => {
        const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
        // WebGL1 for the D component; WebGL2-only capability sets vary across browsers.
        const gl = cv.getContext('webgl', { antialias: false, preserveDrawingBuffer: true }); if (!gl) return;
        cleanup.push(() => gl.getExtension('WEBGL_lose_context')?.loseContext());
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
        const vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || '');
        const readMax = (ctx) => {
          const names = new Set();
          for (let p = ctx; p; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (/^MAX_/.test(k)) names.add(k);
          const values = {};
          for (const k of [...names].sort()) {
            try { const v = ctx.getParameter(ctx[k]); if (v !== null) values[k] = ArrayBuffer.isView(v) ? Array.from(v) : v; } catch { /* unsupported enum */ }
          }
          return values;
        };
        const precision = (ctx) => {
          const rows = [];
          for (const s of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) for (const t of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) {
            const p = ctx.getShaderPrecisionFormat(ctx[s], ctx[t]);
            if (p) rows.push([s, t, p.rangeMin, p.rangeMax, p.precision]);
          }
          return rows;
        };
        const limits = readMax(gl);
        // ANGLE wrappers/backends differ; retain the underlying name where it is exposed.
        const model = renderer.replace(/^ANGLE \([^,]*,\s*/i, '').replace(/,\s*(?:D3D|OpenGL|Vulkan|Metal).*$/i, '')
          .replace(/\s*(?:Direct3D|vs_\d|ps_\d).*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (ext && model && Object.keys(limits).length) await put('dg', [model, limits]);
        await put('gl', [renderer, vendor, limits, (gl.getSupportedExtensions() || []).sort(), precision(gl)]);
        if (!alive()) return;
        const shaders = [], program = gl.createProgram(); if (!program) return;
        try {
          for (const [type, src] of [[gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 v; void main(){v=p;gl_Position=vec4(p,0.,1.);}'],
            [gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v; void main(){gl_FragColor=vec4(sin(v.x*7.)*.5+.5,cos(v.y*5.)*.5+.5,v.x*v.y*.5+.5,1.);}']]) {
            const sh = gl.createShader(type); if (!sh) return;
            shaders.push(sh); gl.shaderSource(sh, src); gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return;
            gl.attachShader(program, sh);
          }
          gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
          gl.useProgram(program);
          const buffer = gl.createBuffer(); if (!buffer) return;
          try {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), gl.STATIC_DRAW);
            const p = gl.getAttribLocation(program, 'p'); if (p < 0) return;
            gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
            gl.viewport(0, 0, 32, 32); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const pixels = new Uint8Array(32 * 32 * 4); gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            await put('px', Array.from(pixels)); // B: driver + shader compiler dependent
          } finally { gl.deleteBuffer(buffer); }
        } finally { shaders.forEach((s) => gl.deleteShader(s)); gl.deleteProgram(program); }
        if (!alive()) return;
        const gl2 = document.createElement('canvas').getContext('webgl2');
        if (gl2) {
          cleanup.push(() => gl2.getExtension('WEBGL_lose_context')?.loseContext());
          await put('g2', [readMax(gl2), (gl2.getSupportedExtensions() || []).sort(), precision(gl2)]);
        }
      }),
      job(async () => { // B: WebGPU adapter info, no device request.
        if (!navigator.gpu?.requestAdapter) return;
        const adapter = await navigator.gpu.requestAdapter(); if (!adapter || !alive()) return;
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        if (info) await put('gp', [info.vendor, info.architecture, info.device, info.description, info.subgroupMinSize, info.subgroupMaxSize]);
      }),
      job(async () => { // B: offline only; no speakers, microphone or user permission.
        const Audio = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!Audio) return;
        const ctx = new Audio(1, 4096, 44100), osc = ctx.createOscillator(), compressor = ctx.createDynamicsCompressor();
        cleanup.push(() => { try { osc.stop(); } catch {} osc.disconnect(); compressor.disconnect(); });
        osc.type = 'triangle'; osc.frequency.value = 10000;
        compressor.threshold.value = -50; compressor.knee.value = 40; compressor.ratio.value = 12;
        compressor.attack.value = 0; compressor.release.value = 0.25;
        osc.connect(compressor); compressor.connect(ctx.destination); osc.start(0);
        const buffer = await new Promise((r, reject) => {
          ctx.oncomplete = (e) => r(e.renderedBuffer);
          const p = ctx.startRendering(); if (p?.then) p.then(r, reject);
        });
        await put('au', Array.from(buffer.getChannelData(0), (v) => v.toPrecision(9)));
      }),
      job(async () => { // B: voice list only; never speak and never overwrite onvoiceschanged.
        const synth = window.speechSynthesis; if (!synth) return;
        const voices = await new Promise((r) => {
          const read = () => {
            try {
              const v = synth.getVoices();
              if (v.length) { synth.removeEventListener('voiceschanged', read); r(v); }
            } catch { synth.removeEventListener('voiceschanged', read); r([]); }
          };
          synth.addEventListener('voiceschanged', read);
          cleanup.push(() => { synth.removeEventListener('voiceschanged', read); r([]); });
          read();
        });
        if (voices.length) await put('vo', voices.map((v) => [v.name, v.lang, v.localService, v.default]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      }),
      job(async () => { // B: quota bucket only, no usage or persisted() request.
        if (!navigator.storage?.estimate) return;
        const { quota } = await navigator.storage.estimate();
        if (quota > 0) await put('sq', Math.floor(Math.log2(quota / (1024 * 1024))));
      }),
      job(async () => { // B: counts only; no labels, IDs or getUserMedia.
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const counts = { audioinput: 0, audiooutput: 0, videoinput: 0 };
        for (const d of devices) if (Object.hasOwn(counts, d.kind)) counts[d.kind]++;
        await put('md', counts);
      }),
    ];
    Promise.allSettled(jobs).then(finish).catch(() => end(empty()));
  }).catch(() => ({ d: '', b: '', c: {} }));
}
// Start while the login page is displayed, share the result across retries.
const fp2Ready = collectFp2();
// ---- end fp2 ----
// 「記住我」:Google 登入成功後 gateway 發的憑證(30 天),存在這台裝置,下次打開直接登入、不用再經過 Google
const getRemember = () => { try { return localStorage.getItem('l1j.remember') || ''; } catch { return ''; } };
function setRemember(token) { try { if (token) localStorage.setItem('l1j.remember', token); else localStorage.removeItem('l1j.remember'); } catch { /* 無痕模式 */ } }
// 「進入遊戲」按鈕上寫出要用哪個信箱進入(共用手機的人一眼看到是誰的帳號;preload.js 下載完素材才把按鈕設成這個字)
(() => { // 「以 信箱 進入」可能很長:不要換行,放不下就省略號(完整信箱在上面的帳號列)
  const st0 = document.createElement('style');
  st0.textContent = '#login-form button[type=submit] { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; letter-spacing: .04em; }';
  document.head.appendChild(st0);
})();
window.enterLabel = () => {
  const e = $('#g-current .g-email').textContent;
  return e && !$('#g-current').classList.contains('hidden') ? `以 ${e} 進入` : '進入遊戲';
};
function setGoogleAccount(email) {
  try { if (email) localStorage.setItem('l1j.gLast', email); } catch { /* 無痕模式 */ }
  $('#g-current .g-email').textContent = email;
  $('#g-current .g-email').style.cssText = 'font-size:16px;font-weight:600;color:#fff'; // 放大:登入前一眼看出是哪個 Google 帳號
  $('#g-current').classList.toggle('hidden', !email);
  $('#g-signin').classList.toggle('hidden', !!email);
  const eb = $('#login-form button[type=submit]');
  if (eb && !eb.disabled) eb.textContent = window.enterLabel();
}
function googleToken(prompt, then) {
  if (!st.gTokenClient) { $('#login-msg').textContent = 'Google 登入還在載入,請稍候再按'; return; }
  st.gTokenClient.callback = (r) => {
    if (r && r.access_token) then(r.access_token);
    else $('#login-msg').textContent = 'Google 登入已取消';
  };
  // 切換帳號(select_account)不帶 login_hint:帶了 Google 只會列出那一個帳號,要按「使用其他帳戶」再返回才看得到全部
  st.gTokenClient.requestAccessToken({ prompt, login_hint: prompt === 'select_account' ? undefined : lastGoogle() || undefined });
}
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (window.NATISHA_OFFLINE) {
    const localLogin = () => {
      $('#login-msg').textContent = '';
      login.retried = false;
      login.last = { t: 'localLogin' };
      send(login.last);
    };
    if (st.ws && st.ws.readyState === 1) localLogin();
    else connect(localLogin);
    return;
  }
  const go = async (msg) => {
    await deviceTokenReady;
    let device = null;
    try { device = await deviceReconcileStorage(); }
    catch { console.warn('裝置識別暫時無法記錄'); }
    if (device?.state === 'conflict') console.warn('裝置識別資料衝突,已保留原值供調查');
    msg = { ...msg, devid: devId(), hw: hwFp(), gpu: gpuName(), brave: !!navigator.brave, fp2: await fp2Ready, deviceReceipt: device?.receipt || '' };
    $('#login-msg').textContent = '連線中…';
    const doLogin = () => { $('#login-msg').textContent = ''; login.retried = false; login.last = msg; send(login.last); };
    if (st.ws && st.ws.readyState === 1) doLogin();
    else connect(doLogin);
  };
  const fresh = (t) => t && Date.now() - t < 50 * 60000;
  if (getRemember()) { go({ t: 'rlogin', token: getRemember() }); return; } // 這台裝置記住了帳號:按「進入遊戲」直接登入,不經過 Google
  if (st.gcred && fresh(st.gcredAt)) { go({ t: 'glogin', credential: st.gcred }); return; }
  if (st.gToken && fresh(st.gTokenAt)) { go({ t: 'glogin', accessToken: st.gToken }); return; }
  googleToken('', (tok) => go({ t: 'glogin', accessToken: tok }));
});
// 切換帳號:開 Google 的選帳號視窗,選好就換成那個帳號(憑證先存著,按進入遊戲用)
$('#g-current .g-switch').onclick = () => {
  st.gcred = null;
  setRemember(null); // 換帳號:這台裝置不再自動登入舊帳號
  googleToken('select_account', (tok) => {
    st.gToken = tok; st.gTokenAt = Date.now();
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tok}` } })
      .then((r) => r.json()).then((u) => setGoogleAccount(u.email || lastGoogle())).catch(() => {});
  });
};

function setupGoogleLogin(clientId) {
  document.body.classList.add('login-google');
  setGoogleAccount(lastGoogle());
  // 第一次在 Google 按鈕選了帳號:記著(ID token 約 1 小時有效),換成帳號列,按「進入遊戲」用這個帳號
  const onCredential = (resp) => {
    st.gcred = resp.credential;
    st.gcredAt = Date.now();
    let email = '';
    try { email = JSON.parse(atob(resp.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch { /* 只是顯示用 */ }
    setGoogleAccount(email);
    $('#login-form button[type=submit]').focus();
  };
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: clientId, callback: onCredential, ux_mode: 'popup' });
    google.accounts.id.renderButton($('#g-signin'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh-TW', width: 260 });
    st.gTokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: 'openid email', callback: () => {} });
  };
  s.onerror = () => { $('#login-msg').textContent = '無法載入 Google 登入,請檢查網路後重新整理'; };
  document.head.appendChild(s);
}

// 職業外型編號 [男, 女](L1PcInstance classId),選角畫面畫原版的站立動畫
const CLASS_GFX = [[0, 1], [61, 48], [138, 37], [734, 1186], [2786, 2796], [6658, 6661], [6671, 6650]];
const STAT_LABELS = [['str', '力量'], ['dex', '敏捷'], ['con', '體質'], ['int', '智力'], ['wis', '精神'], ['cha', '魅力']];

// BEGIN T5 ROSTER UI
function rosterActive() { return !!(st.charRosterEnabled || st.roster || st.rosterError); }
function rosterChar(id) { return st.roster?.characters.find(c => c.id === id); }
function rosterReason(c) {
  return ({ REVIEW: '交易待查核', SETTLING: '交割處理中', DELETING: '待刪除', LISTED: '上架中',
    LOCKED: st.roster?.replacement === false ? '替換功能暫停；角色仍保留，騰出位置後自動恢復' : '鎖定中：等你上架另一隻角色', PLAYABLE: '可使用' })[c.reasonCode] || '角色狀態待查核';
}
function rosterTime(value) {
  return value ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).replace(/\s+/g, ' ') + '（台北時間）' : '';
}
function onCharRoster(ev) {
  if (ev.err) { st.rosterError = true; st.roster = null; }
  else { st.rosterError = false; st.roster = ev.roster; }
  if (st.roster) st.charMarketRecovery = st.roster.pending || st.roster.characters.some(c => c.state === 'L' || c.locked || c.orderState);
  if (st.rosterDeletePending && st.roster) {
    const pending = st.rosterDeletePending, c = rosterChar(pending.id);
    if (pending.account !== st.account || !c || c.epoch !== pending.epoch) st.rosterDeletePending = null;
  }
  if (typeof marketRosterStatus === 'function') {
    if (ev.detail) cm.orderMode = ev.detail;
    marketRosterStatus(ev.status);
    if (st.inGame && cm.detail && cm.orderMode?.id !== cm.detail.id && !ev.err) setTimeout(marketRosterRead, 100);
  }
  if (!st.inGame) renderChars();
  else if (typeof panel !== 'undefined' && panel.name === 'charmarket') renderPanel();
}
function rosterDelete(c) { st.selChar = c; $('#btn-del-char').onclick(); }
function rosterMarketEntry(c, cancel = false) {
  st.marketTarget = { id: c.id, cancel };
  $('#chars-msg').textContent = `請先登入另一隻可用角色，再開啟角色市場${cancel ? '停止出售' : '上架「' + c.name + '」'}。`;
}
function renderRosterOthers() {
  const box = $('#char-others');
  if (!box) return;
  box.replaceChildren(); box.classList.toggle('hidden', !rosterActive());
  if (!rosterActive()) return;
  const r = st.roster;
  if (!r) box.append(el('p', 'roster-notice', st.rosterError ? '角色狀態暫時無法確認，請重新整理清單' : '正在確認角色狀態…'));
  else {
    box.append(el('p', 'roster-count', `可玩位置 ${r.playable} / ${r.capacity} · 持有角色 ${r.total} / ${r.capacity + 1}`));
    const other = r.characters.filter(c => !c.canEnter);
    if (other.length) box.append(el('h3', '', '其他角色'));
    for (const c of other) {
      const card = el('article', 'roster-card');
      card.append(el('b', '', c.name), el('small', '', `Lv${c.level} ${CLASSES[c.type]?.name || ''}`), el('p', 'roster-reason', rosterReason(c)));
      if (c.deleteAt) card.append(el('small', '', `預定刪除：${rosterTime(c.deleteAt)}`));
      if (c.nextListAt && !c.canList) card.append(el('small', '', `可再上架時間：${rosterTime(c.nextListAt)}`));
      const actions = el('div', 'roster-actions');
      const button = (text, fn, disabled) => { const b = el('button', 'secondary', text); b.type = 'button'; b.onclick = fn; b.disabled = disabled; actions.append(b); };
      if (c.reasonCode === 'LISTED') button('停止出售', () => rosterMarketEntry(c, true), false);
      if (c.state === 'K' && c.reasonCode === 'LOCKED') {
        button('上架', () => rosterMarketEntry(c), !c.canList);
        button('刪除', () => rosterDelete(c), !c.canDelete);
      } else if (c.deleting && c.canDelete) button('取消待刪除', () => rosterDelete(c), false);
      card.append(actions); box.append(card);
    }
  }
  const refresh = el('button', 'secondary', '重新整理清單'); refresh.onclick = refreshSelling; box.append(refresh);
}
function renderRosterChars() {
  const r = st.roster, all = st.chars, selection = st.selChar;
  st.chars = r ? r.characters.filter(c => c.canEnter).map(c => ({ ...all.find(x => x.name === c.name), ...c })) : [];
  st.selChar = st.chars.find(c => c.id === selection?.id) || st.chars[0] || null;
  renderCharsLegacy();
  st.chars = all;
  $('#btn-enter').classList.toggle('hidden', !st.selChar);
  $('#btn-del-char').classList.toggle('hidden', !st.selChar || !rosterChar(st.selChar.id)?.canDelete);
  renderRosterOthers();
}
// END T5 ROSTER UI

function enterChar(c) {
  if (!c) return;
  if (rosterActive() && (!st.roster || st.rosterError || !rosterChar(c.id)?.canEnter)) { toast(rosterChar(c.id) ? rosterReason(rosterChar(c.id)) : '請重新整理角色清單'); return; }
  if (!rosterActive() && st.selling?.has(c.name)) { toast('這隻角色在角色市場出售中，成交或下架前不能登入'); return; } // 11/08
  gmGiveOff(); // GM 給予按鈕只給這次進遊戲的角色(換角色要等伺服器重新告知)
  behavCharacter(c.name);
  updateParty([]); // 重新登入的隊伍沒有類型封包,等新的邀請紀錄再確認
  st.myName = c.name; st.myType = c.type;
  resetWhisper(); // 新角色物件:清除上一隻的回覆對象與名單,登入封包若有名單再加入
  st.para = null; st.buffs?.delete('para'); // 換角 / 重登:伺服器是新的角色物件,不會鎖(d3 10/19 建議)
  clearEventHuntTimer(); // 等下一次獵場 tick 補回目前角色的倒數
  send({ t: 'enter', name: c.name, ...(rosterActive() ? { rosterId:c.id, rosterEpoch:c.epoch } : {}) });
}

const CF_W = 96; // 選角立繪大小(和 style.css #char-list canvas.cfig 一致)
const CF_H = 132;
// 選角畫面:問 gateway 哪些角色在離線掛機,有變動就重畫
let huntingAsk = 0;
// 11/06 使用者:選角顯示這次離線掛機已經進行多久(gateway /hunting 的 min;每 10 秒問一次,只改字不重畫)
function huntMinText(m) {
  if (!(typeof m === 'number' && m >= 0)) return '';
  return m < 60 ? `已進行 ${m} 分鐘` : `已進行 ${Math.floor(m / 60)} 小時 ${m % 60} 分`;
}
function refreshHunting() {
  const names = st.chars.map((c) => c.name);
  if (!names.length || $('#screen-chars').classList.contains('hidden')) return;
  const ask = ++huntingAsk;
  fetch(`/hunting?v=2&c=${encodeURIComponent(names.join(','))}`).then((r) => r.json()).then((list) => {
    if (ask !== huntingAsk) return;
    const next = new Map(list.map((x) => (typeof x === 'string' ? [x, ''] : [x.n, x.place || '']))); // 名字 → 掛機地點(11/05)
    const same = st.hunting && next.size === st.hunting.size && [...next].every(([n, p]) => st.hunting.has(n) && st.hunting.get(n) === p);
    st.hunting = next;
    st.huntMin = new Map(list.filter((x) => x && typeof x === 'object').map((x) => [x.n, x.min]));
    if (!same) renderChars();
    else for (const e of document.querySelectorAll('#char-list em.huntmin')) e.textContent = huntMinText(st.huntMin.get(e.dataset.name));
  }).catch(() => {});

}
function refreshSelling() {
  if (st.inGame || $('#screen-chars').classList.contains('hidden') || !st.ws || st.ws.readyState !== 1) return;
  send({ t: 'sellinglist' });
}
setInterval(refreshSelling, 10000);
setInterval(refreshHunting, 10000);
function renderChars() {
  if (rosterActive()) return renderRosterChars();
  renderRosterOthers();
  return renderCharsLegacy();
}
function renderCharsLegacy() {
  if (typeof renameApplyPending === 'function') renameApplyPending(); // 改名成功事件沒收到時,補搬這台裝置的角色設定(hud.js)
  clearTimeout(renderChars.t);
  renderChars.t = setTimeout(refreshHunting, 300); // 角色列表一筆一筆進來,停下來再問
  const ul = $('#char-list');
  ul.innerHTML = '';
  if (!st.chars.includes(st.selChar)) st.selChar = st.chars[0] || null;
  // 固定的角色格(帳號的角色上限,通常 3 格):有角色的照記住的格子放,空格是「建立角色」
  const slots = charSlots();
  slots.forEach((c, i) => {
    if (!c) {
      if (rosterActive() && !st.roster?.canCreate) ul.appendChild(el('li', 'empty', '目前無可用角色'));
      else ul.appendChild(newSlotItem(i));
      return;
    }
    const li = document.createElement('li');
    li.classList.toggle('sel', c === st.selChar);
    const cv = document.createElement('canvas');
    cv.className = 'cfig';
    cv.width = CF_W * DPR; cv.height = CF_H * DPR;
    cv.fig = { gfx: CLASS_GFX[c.type]?.[c.sex ? 1 : 0] ?? 61, kind: 'pc', heading: 5, id: i * 131 };
    cv.portrait = `${c.type}_${c.sex ? 1 : 0}`;
    li.appendChild(cv);
    const info = document.createElement('div');
    info.className = 'cinfo';
    info.innerHTML = '<b></b><span></span>';
    info.querySelector('b').textContent = c.name;
    info.querySelector('span').textContent = `Lv${c.level}  ${CLASSES[c.type]?.name ?? ''}`;
    if (!rosterActive() && st.selling?.has(c.name)) { // 11/08 角色市場上架中:不能登入
      const sell = el('em', 'selling', '角色市場出售中');
      sell.style.cssText = 'display:block;font-style:normal;font-size:12px;font-weight:700;color:#ffb35c;white-space:nowrap;margin-top:1px';
      info.appendChild(sell);
    }
    if (st.hunting?.has(c.name)) {
      info.appendChild(el('em', 'hunting', '離線掛機中'));
      const hm = el('em', 'huntmin', huntMinText(st.huntMin?.get(c.name))); // 已進行多久(11/06)
      hm.dataset.name = c.name;
      hm.style.cssText = 'display:block;font-style:normal;font-size:12px;color:#cfe9d2;white-space:nowrap;margin-top:-2px;padding-left:14px';
      info.appendChild(hm);
      const place = st.hunting.get(c.name);
      if (place) { const p = el('em', 'huntplace', place); p.style.cssText = 'font-style:normal;font-size:12px;color:#cfe9d2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:-2px;padding-left:14px'; info.appendChild(p); } // 掛機地點(獵場名稱;對齊綠點後的文字)
    }
    li.appendChild(info);
    const stats = document.createElement('div');
    stats.className = 'cstats';
    for (const [k, label] of STAT_LABELS) {
      const d = document.createElement('span');
      d.innerHTML = `${label} <b></b>`;
      d.querySelector('b').textContent = c[k];
      stats.appendChild(d);
    }
    li.appendChild(stats);
    li.onclick = () => { st.selChar = c; renderChars(); };
    li.ondblclick = () => enterChar(c);
    ul.appendChild(li);
  });
  $('#btn-enter').classList.toggle('hidden', !st.chars.length);
  $('#btn-del-char').classList.toggle('hidden', !st.chars.length);
  requestAnimationFrame(animateChars);
  $('#btn-new-char').classList.add('hidden'); // 改成點空的角色格建立
}

// 角色在第幾格:伺服器不分格子,記在這台瀏覽器(每個帳號一份);沒記過的放進第一個空格
const slotKey = () => `l1j.slots.${st.account || ''}`;
function slotMap() { try { return JSON.parse(localStorage.getItem(slotKey()) || '{}'); } catch { return {}; } }
function saveSlotMap(m) { try { localStorage.setItem(slotKey(), JSON.stringify(m)); } catch { /* 無痕模式 */ } }
function charSlots() {
  const n = rosterActive() ? Math.max(st.roster?.capacity || st.maxChars || 3, st.chars.length) : Math.max(st.maxChars || 3, st.chars.length);
  const slots = new Array(n).fill(null);
  const map = slotMap();
  const rest = [];
  for (const c of st.chars) {
    const i = map[c.name];
    if (Number.isInteger(i) && i >= 0 && i < n && !slots[i]) slots[i] = c; else rest.push(c);
  }
  for (const c of rest) { const i = slots.indexOf(null); if (i >= 0) slots[i] = c; }
  return slots;
}
function newSlotItem(i) {
  const li = document.createElement('li');
  li.className = 'newslot';
  li.innerHTML = '<div class="ns-art"><i class="ns-anim"></i></div><div class="cinfo"><b>建立角色</b><span>空的角色欄位</span></div>'; // 原版選角的 New Character 光柱(assets/ui182/newchar.webp)
  li.onclick = () => openNewChar(i);
  return li;
}

const CHARSEL = { index: null, imgs: {} };
const nc = { type: 1, sex: 0, stats: [] };
// 職業符號只顯示伺服器允許的(仿 1.82 只有王族 / 騎士 / 妖精 / 法師,畫面上也只有這四個符號)
function renderClassOptions(allowed) {
  const syms = [...document.querySelectorAll('#newchar-form .sym[data-type]')];
  const ok = syms.map((b) => +b.dataset.type).filter((i) => allowed.includes(i));
  if (ok.length && !ok.includes(nc.type)) nc.type = ok[0];
  for (const b of syms) b.classList.toggle('hidden', !ok.includes(+b.dataset.type));
  renderNcPick();
}
// 選到的職業 / 性別符號發光,中間換成那個角色的選角動畫
function renderNcPick() {
  for (const b of document.querySelectorAll('#newchar-form .sym')) {
    b.classList.toggle('on', b.dataset.type != null ? +b.dataset.type === nc.type : +b.dataset.sex === nc.sex);
  }
  const key = `${nc.type}_${nc.sex}`;
  const n = CHARSEL.index?.[key] || 60;
  const fig = $('#newchar-form .fig');
  fig.style.backgroundImage = `url("${charselUrl(key, 'webp')}")`;
  fig.style.backgroundSize = `${n * 100}% 100%`;
  fig.style.animationDuration = `${n / 10}s`; // 約 10 張 / 秒
  fig.style.animationTimingFunction = `steps(${n - 1})`;
}
for (const b of document.querySelectorAll('#newchar-form .sym')) {
  b.onclick = () => {
    if (b.dataset.type != null) resetStats(+b.dataset.type);
    else nc.sex = +b.dataset.sex;
    renderNcPick();
  };
}
renderClassOptions(CLASSES.map((_, i) => i));
// game.json / speeds.json 共用重試與提示;兩份都恢復才顯示載入成功。
const gameDataLoad = { pending: 0, warned: false };
const isGameDataTable = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
function loadGameData(url, valid, apply) {
  gameDataLoad.pending++;
  let tries = 0, timer = null, busy = false, done = false;
  const started = Date.now();
  const warn = () => {
    if (!done && !gameDataLoad.warned && Date.now() - started >= 30000 && document.visibilityState !== 'hidden' && typeof toast === 'function') {
      gameDataLoad.warned = true;
      toast('遊戲資料載入失敗,正在重試…若持續出現請重新整理頁面');
    }
  };
  const warningTimer = setTimeout(warn, 30000);
  const retry = async () => {
    if (done) return;
    warn();
    if (busy) return; // 回前景和恢復連線可能一起觸發,同一份資料只抓一次
    clearTimeout(timer);
    if (navigator.onLine === false || document.visibilityState === 'hidden') return;
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 連線卡住也要能重試,包含讀取 JSON
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!valid(data)) throw new Error('遊戲資料不完整');
      apply(data);
      done = true;
      clearTimeout(warningTimer);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      if (--gameDataLoad.pending === 0 && gameDataLoad.warned) {
        gameDataLoad.warned = false;
        toast('遊戲資料已載入');
      }
    } catch {
      // 每次失敗後等 2、5、10、20 秒,之後每 30 秒;背景 / 離線就等事件喚醒。
      timer = setTimeout(retry, [2000, 5000, 10000, 20000, 30000][Math.min(tries++, 4)]);
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  };
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', retry);
  retry();
}
loadGameData('/speeds.json', (t) => isGameDataTable(t) && Object.values(t).some((row) =>
  row && typeof row === 'object' && Object.values(row).some((ms) => Number.isFinite(ms) && ms > 0)), (t) => { st.speeds = t; });
// 改版資訊(選角畫面):最新一筆展開,舊的收起來
fetch('/changelog.json', { cache: 'no-store' }).then((r) => r.json()).then((list) => {
  const box = $('#changelog');
  if (!box || !Array.isArray(list) || !list.length) return;
  box.appendChild(el('h3', '', '改版資訊'));
  list.slice(0, 10).forEach((v, i) => {
    const d = el('details');
    d.open = i === 0;
    d.appendChild(el('summary', '', v.date));
    const ul = el('ul');
    for (const t of v.items || []) ul.appendChild(el('li', '', t));
    d.appendChild(ul);
    box.appendChild(d);
  });
  box.classList.remove('hidden');
  changelogTop = list[0];
  if (!$('#screen-chars').classList.contains('hidden')) popChangelog();
}).catch(() => {});
// 交易手機驗證(OTP):要交易 / 拍賣上架 / 購買時 gateway 回 otpneed,跳出輸入門號 → 收簡訊 → 輸入驗證碼的視窗
function openOtp(what) {
  if ($('#otp-pop')) return;
  const wrap = el('div', 'changelog-pop');
  wrap.id = 'otp-pop';
  const card = el('div', 'changelog changelog-card otp-card');
  card.appendChild(el('h3', '', '手機驗證'));
  card.appendChild(el('p', 'hint', `${what || '交易'}前需要先驗證手機(只需一次)。一個門號只能驗證一個帳號,驗證完成前不能交易、拍賣上架或購買。`));
  const phone = el('input'); phone.type = 'tel'; phone.placeholder = '手機號碼 09xxxxxxxx'; phone.maxLength = 13; phone.autocomplete = 'tel';
  const sendBtn = el('button', 'secondary', '發送驗證碼');
  const code = el('input'); code.type = 'text'; code.inputMode = 'numeric'; code.placeholder = '6 位數驗證碼'; code.maxLength = 6; code.autocomplete = 'one-time-code';
  const ok = el('button', 'gold-btn', '驗證');
  const msg = el('p', 'msg');
  msg.id = 'otp-msg';
  const close = el('button', 'secondary otp-close', '取消');
  sendBtn.id = 'otp-send';
  sendBtn.onclick = () => { msg.textContent = '發送中…'; sendBtn.disabled = true; setTimeout(() => { sendBtn.disabled = false; }, 60000); send({ t: 'otpsend', phone: phone.value }); };
  ok.onclick = () => { msg.textContent = '驗證中…'; send({ t: 'otpverify', code: code.value }); };
  close.onclick = () => wrap.remove();
  const row1 = el('div', 'otp-row'); row1.append(phone, sendBtn);
  const row2 = el('div', 'otp-row'); row2.append(code, ok);
  card.append(row1, row2, msg, close);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  phone.focus();
}
function otpResult(ev) {
  const m = $('#otp-msg');
  if (ev.op === 'otpsend' && !ev.ok && $('#otp-send')) $('#otp-send').disabled = false;
  if (m) m.textContent = ev.msg || '';
  if (ev.op === 'otpverify' && ev.ok) { log(ev.msg, 'sys'); setTimeout(() => { const w = $('#otp-pop'); if (w) w.remove(); }, 1200); }
}
// 有新的改版資訊時,進選角畫面跳出視窗(每台瀏覽器同一版只跳一次;選角畫面下方仍可看全部)
var changelogTop = null; // var:showScreen 可能比這行先跑
function popChangelog() {
  const v = changelogTop;
  if (!v || $('#changelog-pop')) return;
  const key = `${v.date}|${(v.items || []).length}`;
  try { if (localStorage.getItem('l1j.changelogSeen') === key) return; } catch { /* 無痕模式:照樣跳 */ }
  const wrap = el('div', 'changelog-pop');
  wrap.id = 'changelog-pop';
  const card = el('div', 'changelog changelog-card');
  card.appendChild(el('h3', '', `改版資訊 ${v.date}`));
  const ul = el('ul');
  for (const t of v.items || []) ul.appendChild(el('li', '', t));
  card.appendChild(ul);
  const ok = el('button', 'gold-btn', '知道了');
  ok.onclick = () => { try { localStorage.setItem('l1j.changelogSeen', key); } catch { /* 無痕模式 */ } wrap.remove(); };
  card.appendChild(ok);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
}
fetch('/config.json').then((r) => r.json()).then((cfg) => {
  RM.allowed = cfg.renderMetrics === true;
  initWorldBackend(cfg);
  if (RM.allowed) {
    if (document.readyState === 'complete') RM.start();
    else window.addEventListener('load', () => RM.start(), { once: true });
  }
  if (cfg.googleClientId) setupGoogleLogin(cfg.googleClientId);
  renderClassOptions(cfg.allowedClasses);
  st.weaponRanges = cfg.weaponRanges || {};
  st.inventoryMax = cfg.inventoryMax || 180;
  st.charMarket = !!cfg.charMarket;
  st.charRosterEnabled = !!cfg.charRoster;
  st.dutchAuction = cfg.dutchAuction === true;
  if (typeof dutchConfigChanged === 'function') dutchConfigChanged();
  st.highPet = !!cfg.highPet; // 這個站有高寵模式
  st.partyInviteByName = !!cfg.partyInviteByName;
  st.partyLeaderLoot = cfg.partyLeaderLoot === true;
  st.partyLeaderLootAdena = cfg.partyLeaderLootAdena !== false;
  { const on = !!cfg.whisperAllTabs; if (st.whisperAllTabs !== on) { st.whisperAllTabs = on; if (st.inGame && typeof renderChat === 'function') renderChat(true); } } // 11/18 whisperall
  st.dollSynth = cfg.dollSynth || null;
  if (!st.dollSynth) { closeDollSynth(); document.querySelectorAll('.dollsynth-open').forEach(b => b.remove()); }
  st.tishaDiamond = cfg.tishaDiamond === true;
  st.clanLoot = cfg.clanLoot === true; // ClanLootWebEnabled
  st.tpSrc = cfg.tpSrc === true; // 11/17 tpsource
  st.eventHunt = cfg.eventHunt && cfg.eventHunt.ground > 0 ? cfg.eventHunt : null; // 11/05 活動獵場進場確認
  st.craftFeatures = Array.isArray(cfg.craftFeatures) ? cfg.craftFeatures.filter((key) => typeof key === 'string') : [];
  st.itemLock = !!cfg.itemLock; // 道具上鎖(altsettings ItemLockEnabled):背包道具選單才有「上鎖 / 解鎖」
  st.royalSword = cfg.royalSword || null;
  if (typeof syncRoyalSwordData === 'function') syncRoyalSwordData();
  st.shockStunPvpOnly = !!cfg.shockStunPvpOnly; // 11/06 衝擊之暈只對 PvP 玩家與 BOSS(altsettings ShockStunPvpOnlyEnabled)
  st.stunBossNames = new Set(cfg.stunBossNames || []); // BOSS 名單(固定 BOSS + 活動王)
  st.magicDoll = cfg.magicDoll || { enabled: false };
  st.charSettingsServer = cfg.charSettingsServer !== false;
  if (typeof syncDollSettings === 'function') syncDollSettings();
  st.windWalkAuto = !!cfg.windWalkAuto; // 風之疾走線上 AUTO(altsettings WindWalkAutoEnabled):妖精獨立勾選風之疾走,或拿不到精靈餅乾時的備案
  st.emblem = !!cfg.emblem; // 盟徽(altsettings EmblemEnabled):關著完全不畫、不抓、不顯示上傳入口
  st.ranking = !!cfg.ranking; st.pkRank = !!cfg.pkRank; // 人物頁的排行榜分頁(altsettings RankingEnabled)
  st.autoMissGiveUp = cfg.autoMissGiveUp | 0; // AUTO 連續幾下沒傷害就換怪(altsettings AutoMissGiveUp;0 = 關)
  st.wsHost = cfg.wsHost || ''; // 遊戲連線走台北轉送(沒設 = 原本的連法)
  st.paidBuy = new Set(cfg.paidBuyIds || []); // 可以付費買進背包的道具(伺服器 altsettings PaidArrowItemIds):自動變身要有列才顯示
  st.waffleMoveRate = cfg.waffleMoveRate || WAFFLE_RATE; // 精靈餅乾走路倍率(伺服器 altsettings WaffleMoveRate)
  st.waffleAttackRate = cfg.waffleAttackRate || WAFFLE_RATE; // 精靈餅乾攻擊 / 施法倍率(伺服器 altsettings WaffleAttackRate)
  st.webHotkeyCooldownEnabled = !!cfg.webHotkeyCooldownEnabled;
  st.skillDelayAfterAnim = !!cfg.skillDelayAfterAnim; // 魔法冷卻在施法動作播完後才開始算
  st.playerStun = !!cfg.playerStun; // 玩家職業的硬直照參考表(l1spr.js damageMs)
  renderInv();
}).catch(() => {});
$('#btn-enter').onclick = () => enterChar(st.selChar);
{ const v = $('#app-version'); if (v && window.AV?.build) v.textContent += ` · ${window.AV.build.slice(0, 6)}`; } // 手機上看得到自己跑的是哪一版

// 刪除角色:先跳確認視窗(畫面上方),按「確定刪除」後才倒數 10 秒,期間可以取消
let delTimer = null, delChar = null;
function cancelDelete() {
  clearInterval(delTimer); delTimer = null; delChar = null;
  $('#del-confirm').classList.add('hidden');
}
$('#btn-del-char').onclick = () => {
  const c = st.selChar;
  if (!c || delChar) return;
  if (rosterActive() && st.rosterDeletePending) { toast('刪除結果尚未確認，請重新整理清單；請勿重複送出。'); refreshSelling(); return; }
  if (rosterActive() && (!rosterChar(c.id)?.canDelete || st.rosterError)) { toast('角色狀態已變動，請重新整理清單'); return; }
  if ($('#del-roster-note')) $('#del-roster-note').textContent = '';
  if (rosterActive()) {
    const note = $('#del-roster-note'); if (note) note.textContent = c.deleting ? '這次操作會取消待刪除；角色仍依目前名額決定可用狀態。' : '待刪除期間仍占位置；真正刪除前不會釋放名額。';
  }
  delChar = c;
  document.querySelectorAll('#del-confirm .del-name').forEach((b) => { b.textContent = c.name; });
  $('#del-ask').classList.remove('hidden');
  $('#del-count').classList.add('hidden');
  $('#del-ok').classList.remove('hidden');
  $('#del-confirm').classList.remove('hidden');
};
$('#del-ok').onclick = () => {
  const c = delChar;
  if (!c || delTimer) return;
  let left = 10;
  $('#del-left').textContent = left;
  $('#del-ask').classList.add('hidden');
  $('#del-ok').classList.add('hidden');
  $('#del-count').classList.remove('hidden');
  delTimer = setInterval(() => {
    left--;
    $('#del-left').textContent = left;
    if (left > 0) return;
    cancelDelete();
    if (rosterActive() && (!rosterChar(c.id)?.canDelete || rosterChar(c.id)?.epoch !== c.epoch || st.rosterError)) { toast('角色狀態已變動，請重新整理清單'); return; }
    st.deleted = c.name; st.deleteAt = Date.now();
    if (rosterActive()) st.rosterDeletePending = { account: st.account, id: c.id, epoch: c.epoch };
    send({ t: 'deletechar', name: c.name, ...(rosterActive() ? { rosterId:c.id, rosterEpoch:c.epoch } : {}) });
    if (rosterActive()) { st.roster = null; refreshSelling(); }
  }, 1000);
};
$('#del-cancel').onclick = cancelDelete;

// 選角立繪(tools/build_charselect.py:經典版選角畫面,角色站在火圈上);沒有的職業畫遊戲裡的小人
fetch(charselUrl('index', 'json')).then((r) => r.json()).then((j) => { CHARSEL.index = j; renderNcPick(); }).catch(() => {});
function charselStrip(key) {
  if (!CHARSEL.index?.[key]) return null;
  if (!CHARSEL.imgs[key]) { const img = new Image(); img.src = charselUrl(key, 'webp'); CHARSEL.imgs[key] = img; }
  const img = CHARSEL.imgs[key];
  return img.complete && img.naturalWidth ? { img, n: CHARSEL.index[key] } : null;
}

// 選角畫面的角色動畫(畫面開著才畫)
let charAnim = 0;
function animateChars(now) {
  if ($('#screen-chars').classList.contains('hidden') || now === charAnim) return;
  charAnim = now;
  for (const cv of document.querySelectorAll('#char-list canvas.cfig')) {
    const strip = charselStrip(cv.portrait);
    const fk = strip ? `s${Math.floor(now / 100) % strip.n}` : `c${Math.floor(now / 40)}`; // 圖沒換就不重畫(高更新率螢幕上每秒 120 次 → 10 次)
    if (cv.drawnKey === fk) continue;
    cv.drawnKey = fk;
    const g = cv.getContext('2d');
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, CF_W, CF_H);
    if (strip) {
      const f = Math.floor(now / 100) % strip.n; // 約 10 張 / 秒
      const w = (160 / 270) * CF_H;
      g.drawImage(strip.img, f * 160, 0, 160, 270, (CF_W - w) / 2, 0, w, CF_H);
    } else L1S.drawCreature(g, cv.fig, CF_W / 2, CF_H - 14, now);
  }
  requestAnimationFrame(animateChars);
}

function openNewChar(slot) {
  if (rosterActive() && (!st.roster?.canCreate || st.rosterError)) { toast('全部持有角色已達可建立上限，或交易處理中；上架、鎖定與待刪除都會計入。'); return; }
  st.newSlot = slot;
  $('#newchar-form').classList.remove('hidden'); $('#nc-msg').textContent = ''; resetStats(nc.type); renderNcPick();
}
$('#btn-new-char').onclick = () => openNewChar(charSlots().indexOf(null));
$('#nc-cancel').onclick = () => $('#newchar-form').classList.add('hidden');
function resetStats(type) { nc.type = type; nc.stats = [...CLASSES[type].base]; renderStats(); }
function statsLeft() { return 75 - nc.stats.reduce((a, b) => a + b, 0); }
function renderStats() {
  const cls = CLASSES[nc.type];
  const box = $('#nc-stats');
  box.innerHTML = '';
  nc.stats.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'stat';
    row.innerHTML = `<span>${STAT_NAMES[i]}</span><div class="ctl"><button type="button">−</button><b>${v}</b><button type="button">+</button></div>`;
    const [minus, plus] = row.querySelectorAll('button');
    minus.onclick = () => { if (nc.stats[i] > cls.base[i]) { nc.stats[i]--; renderStats(); } };
    plus.onclick = () => { if (statsLeft() > 0 && nc.stats[i] < Math.min(statMax(nc.type, i), cls.base[i] + cls.bonus)) { nc.stats[i]++; renderStats(); } };
    box.appendChild(row);
  });
  $('#nc-left').innerHTML = `屬性分配點數 <b>${statsLeft()}</b>`;
}
$('#newchar-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#nc-msg').textContent = '';
  if (statsLeft() !== 0) { $('#nc-msg').textContent = '請把點數分配完'; return; }
  const f = new FormData(e.target);
  // 角色名稱:不分中英最多 12 字(伺服器 C_CreateChar 同規則)
  const nm = f.get('name').trim();
  if (!/^[\p{L}\p{N}]+$/u.test(nm)) { $('#nc-msg').textContent = '名稱只能用中文、英文或數字'; return; }
  if ([...nm].length > 12) { $('#nc-msg').textContent = '名稱太長:最多 12 字'; return; }
  const s = Object.fromEntries(STAT_KEYS.map((k, i) => [k, nc.stats[i]]));
  send({ t: 'newchar', name: f.get('name').trim(), type: nc.type, sex: nc.sex, ...s });
});

// ---------------- 進入遊戲 ----------------
// 登出:角色下線(伺服器存檔)、回到選角畫面,帳號保持登入
function logoutToSelect() {
  if (!st.inGame) return;
  gmGiveOff();
  if (st.clickSelect) clearPicked();
  if (typeof stopAuto === 'function') stopAuto('登出 / 換角色');
  if (st.charMarket || st.charMarketRecovery) { st.chars = []; st.selChar = null; }
  send({ t: 'changechar' });
  webBgLimited = false;
  resetWhisper();
  st.inGame = false; clearEventHuntTimer(); behavState(); if (typeof dutchReset === 'function') dutchReset();
  st.selfId = 0;
  st.arenaAlias = null;
  st.pkRankSelf = null; st.rankingData = null;
  window.__orenGate = null; st.shana = false; st.atkRate = 1; st.equipSets = null; if (typeof appearanceReset === 'function') appearanceReset(); if (typeof collectionReset === 'function') collectionReset(); if (typeof dailyQuestReset === 'function') dailyQuestReset(); if (typeof syncEquipQuick === 'function') syncEquipQuick();
  st.skills.clear(); // 10/18 換角色後上一隻學過的魔法還留著 → 吉倫「目前沒有可以學習的魔法」(伺服器 addskill 只會加不會清)
  st.objects.clear();
  st.target = null;
  st.path = [];
  closeDialog();
  if (typeof closePanel === 'function') closePanel();
  document.body.classList.remove('in-game');
  showScreen('chars');
  renderChars();
}
function enterGame() {
  if (st.clickSelect) clearPicked();
  st.inGame = true; behavState();
  // 11/10 藍色雨天(騎士)自動喝水 / 狀態欄出現妖精、法師的魔法:斷線、被踢、離線掛機後重新登入再選角不經過 logoutToSelect,上一隻的魔法 / 狀態圖示留著。
  // 伺服器先送 S_LoginGame(這裡)才送這隻的 addskill / buff,所以在這裡清不會清到新角色的;有 who 的(提沙守護、高寵、經驗加倍)自己會核對角色,留著。
  st.skills.clear(); if (typeof st.buffs?.forEach === 'function') for (const [k, b] of st.buffs) if (!b.who) st.buffs.delete(k);
  if (typeof dutchEnter === 'function') dutchEnter();
  webBgLimited = false;
  reportWebBackground(document.visibilityState === 'hidden');
  st.clan = null; // 換角不能沿用上一角色的敵對血盟
  send({ t: 'clan', op: 0 });
  if (!enterGame.swClean) { enterGame.swClean = true; setTimeout(cleanAssetCache, 60000); }
  conn.lastPong = conn.lastMsg = Date.now(); // 在選角畫面待很久再進遊戲:不要第一次檢查就判定斷線
  loadCharPrefs(); // 這個角色自己的設定與快捷欄(hud.js)
  st.chatLog.length = 0; // 換角色 / 重新進入:上一隻角色的聊天、系統訊息不留著
  if (typeof renderChat === 'function') renderChat(true); // 換角進遊戲:暫停中也要清掉上一隻的聊天(d3)
  document.body.classList.add('in-game');
  showScreen('game');
  $('#hud-name').textContent = st.myName || '';
  log('歡迎進入娜緹夏世界。', 'sys');
  if (typeof syncAutoHunt === 'function') syncAutoHunt();
}

// 離線快取:刪掉舊版本的地圖地磚檔(每次地圖重建約 80 MB,以前從來不刪,R1-31)
async function cleanAssetCache() {
  try {
    if (!window.AV?.tmap || !('caches' in window)) return;
    const c = await caches.open('l1-assets-v2');
    for (const req of await c.keys()) { const u = new URL(req.url); if (u.pathname.startsWith('/assets/tmap/')) { const want = L1MAP.tmapVerOf(u.pathname); if (want !== null && u.searchParams.get('v') !== want) await c.delete(req); } } // 逐檔版本:只刪「版本不是該檔現在版本」的舊快取(索引 / 圖集各自有版本,seg 用基準 + g1)
  } catch { /* 沒有 Cache Storage(無痕等) */ }
}

// instance:個人獵場的副本地圖編號(地形用原地圖 id,但物件要清掉、名稱要換)
// box:個人獵場只開放的範圍 [x1, y1, x2, y2](外面是牆,也不畫)
// 通行資料(/map/<id>)抓不到時一直重試(1、2、4…最多 10 秒一次);同一張地圖又收到 mapid、網路恢復、回到前景時馬上再試
const mapRetry = { timer: 0, kick: () => {} };
let walkRequest = 0, walkVersion = null;
function loadMap(id, name, instance, box) {
  if (st.clickSelect) clearPicked(); // 同圖瞬移也會清掉畫面物件
  const key = instance ?? id;
  const version = st.mapVer || '';
  if (key === st.mapKey && version === walkVersion) {
    if (!st.map) mapRetry.kick();
    // 同一張地圖內傳送(瞬移 / 沒怪瞬移 / 同圖重生):伺服器把它記得的物件全清掉、只重送新位置畫面內的,舊的不會送 remove
    // → 這邊也要清,不然會留「殘影」(怪早就不在那裡了,AUTO 一直打;10/18 騎洞 4F 回報)。gateway 的 seen 每次 mapid 也都清
    for (const [oid] of st.objects) if (oid !== st.selfId) st.objects.delete(oid);
    st.target = null;
    st.path = [];
    return;
  }
  const request = ++walkRequest;
  walkVersion = version;
  clearTimeout(mapRetry.timer);
  mapRetry.kick = () => {};
  st.mapKey = key;
  st.inInstance = instance != null; // 個人獵場副本
  // r17備援由unifiedRetry於新地圖載入完成後檢查mapKey，避免在此清物件期間搶跑baseline。
  st.mapId = id;
  if (id !== BLOOD_ARENA_MAP) st.arenaAlias = null;
  loadCurrentOpenArea(id, key); // 遮罩獨立載入,不拖住通行資料 / 尋路
  arenaPvp(id);
  st.mapName = name || '';
  st.map = null;
  st.path = [];
  st.target = null;
  for (const [oid] of st.objects) if (oid !== st.selfId) st.objects.delete(oid);
  $('#hud-map').textContent = name || `地圖 ${id}`;
  fitMapName();
  mini.base = null;
  L1MAP.ready(id); // 地圖區塊表、縮小版和通行資料一起開始抓,不用等 /map 下載完(R1-33)
  ovMeta(id);

  if (window.NATISHA_OFFLINE && window.NatishaOfflineAPI) {
    applyWalk(id, key, window.NatishaOfflineAPI.createWalkMapBuffer(), box);
    return;
  }
  // 網址帶通行資料的內容雜湊(gateway 給):資料一改網址就變,不會用到手機上的舊資料
  const url = st.mapVer ? `/map/${id}?v=${st.mapVer}` : `/map/${id}`;
  let tries = 0;
  const attempt = () => {
    clearTimeout(mapRetry.timer);
    mapRetry.kick = () => {};
    let timer;
    const stall = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 30000); });
    Promise.race([fetch(url).then(async (res) => {
      if (res.status === 404) return 404;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer(); // 下載到一半斷掉也會丟錯 → 重試
      if (buf.byteLength < 16) throw new Error('short');
      return buf;
    }), stall]).then((buf) => {
      clearTimeout(timer);
      if (request !== walkRequest || st.mapKey !== key) return; // 已經換地圖(含個人獵場 / 本體同一張底圖的情況)
      if (buf === 404) { log(`地圖 ${id} 沒有通行資料`, 'err'); toast('這張地圖沒有通行資料'); return; }
      applyWalk(id, key, buf, box);
    }).catch(() => {
      clearTimeout(timer);
      if (request !== walkRequest || st.mapKey !== key || st.map) return;
      mapRetry.kick = attempt;
      mapRetry.timer = setTimeout(attempt, Math.min(10000, 1000 * 2 ** tries++));
    });
  };
  attempt();
}
let instBlockedSet = null, instBlockedSrc = null; // 個人獵場擋住的格子(x * 65536 + y)
const instBlocked = () => { if (instBlockedSrc !== st.blocked) { instBlockedSrc = st.blocked; instBlockedSet = new Set((st.blocked || []).map(([x, y]) => x * 65536 + y)); } return instBlockedSet; };
const seaCache = new Map(); // 地圖 -> 海的範圍(每次回到大陸不用再整張重算)
function applyWalk(id, key, buf, box) {
  const hdr = new Int32Array(buf, 0, 4);
  const [x0, x1, y0, y1] = hdr;
  st.map = { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, tiles: new Uint8Array(buf, 16), box: box || null };
  // 個人獵場:整塊完全空曠,範圍內全部能走、箭都能飛(和伺服器 L1V1Map.openArea 一致)
  if (box) for (let y = Math.max(box[1], y0); y <= Math.min(box[3], y1); y++) for (let x = Math.max(box[0], x0); x <= Math.min(box[2], x1); x++) st.map.tiles[(y - y0) * st.map.w + (x - x0)] |= 0x0f;
  // 個人獵場:畫出來的樹那幾格不能走(和伺服器副本地圖一致)
  if (box) for (const [bx, by] of st.blocked || []) if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) st.map.tiles[(by - y0) * st.map.w + (bx - x0)] = 0;
  if (OUTDOOR_MAPS.has(id)) {
    const sk = `${key}:${walkVersion || ''}`;
    if (!seaCache.has(sk)) seaCache.set(sk, findSea(st.map));
    st.map.sea = seaCache.get(sk);
  }
}

// 伺服器地圖只記錄「能不能走」,沒有海或建築的資訊。
// 推算:從地圖邊緣連出去的不可走區域當成海,內陸的不可走小塊當成樹林 / 岩石。
function findSea(m) {
  const sea = new Uint8Array(m.w * m.h);
  const queue = new Int32Array(m.w * m.h);
  let head = 0;
  let tail = 0;
  // 安全區(村莊)的不可走格是房子 / 圍牆,不算海
  const push = (i) => { if (!sea[i] && !(m.tiles[i] & 3) && (m.tiles[i] & 0x30) !== 0x10) { sea[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < m.w; x++) { push(x); push((m.h - 1) * m.w + x); }
  for (let y = 0; y < m.h; y++) { push(y * m.w); push(y * m.w + m.w - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % m.w;
    if (x > 0) push(i - 1);
    if (x < m.w - 1) push(i + 1);
    if (i >= m.w) push(i - m.w);
    if (i < (m.h - 1) * m.w) push(i + m.w);
  }
  return sea;
}

function isSea(x, y) {
  const m = st.map;
  if (!m || !m.sea) return false;
  if (x < m.x0 || x > m.x1 || y < m.y0 || y > m.y1) return true;
  return m.sea[(y - m.y0) * m.w + (x - m.x0)] === 1;
}

function tile(x, y) {
  const m = st.map;
  if (!m || x < m.x0 || x > m.x1 || y < m.y0 || y > m.y1) return 0;
  if (m.box && (x < m.box[0] || y < m.box[1] || x > m.box[2] || y > m.box[3])) return 0;
  return m.tiles[(y - m.y0) * m.w + (x - m.x0)];
}

// tile() 對尚無資料的位置也回 0;提示必須先排除未知地形與副本裁切外的格子。
function walkHintBlocked(x, y) {
  const m = st.map;
  if (!m || x < m.x0 || x > m.x1 || y < m.y0 || y > m.y1) return false;
  if (m.box && (x < m.box[0] || y < m.box[1] || x > m.box[2] || y > m.box[3])) return false;
  if (m.tiles[(y - m.y0) * m.w + (x - m.x0)] === undefined) return false;
  return !(tile(x, y) & 3) || isClosedArea(x, y);
}

function drawWalkHintFloor(view) {
  if (!WALK_HINT) return;
  const mask = activeOpenArea();
  L1MAP.drawWalkHint(ctx, st.mapId, view, settings.walkHint ? {
    source: st.map, tiles: st.map.tiles, key: st.mapKey, mask: mask?.open,
    style: WALK_HINT_STYLE, blocked: walkHintBlocked,
  } : null);
}

// 11/23 魔法娃娃不擋路(伺服器同日也不再讓娃娃佔格):kind 'doll' 或外型是娃娃(npc impl L1Doll 的全部 gfx;gateway 名單不齊的娃娃會被當成 pet)
const DOLL_GFX = new Set([5919,5933,6096,6100,6443,6449,6452,6477,6480,6483,7047,7050,7053,7257,7516,7659,7660,7661,7662,8479,8539,8542,8543,8544,8545,8546,8549,8650,8653,8656,8694,8695,8696,8741,8743,8744,8748,8749,8750,8751,9377,9381,9385,9388,9391,9395,9398,9401,9404,9407,9411,9414,9635,9638,9684,9685,9690,9691,9692,9693,9694,9695,9696,9697,9698,9699,9700,9701,9702,9703,9704,9705,9706,9707,9708,9709,9710,10256,10266,12574,12641,13420,13577]);
const isDollObj = (o) => o.kind === 'doll' || (o.kind === 'pet' && DOLL_GFX.has(+o.gfx));
function occupied(x, y) {
  for (const o of st.objects.values()) {
    if (o.kind === 'door' && o.status !== 29) continue; // 門只有關著(29 ACTION_Close)才擋路;開著的門可以走過去(例:燃柳村萊拉之屋)
    if (o.id !== st.selfId && o.kind !== 'item' && !isDollObj(o) && !o.dead && o.x === x && o.y === y && !(o.kind === 'pc' && passThroughPc()) && !isHiddenPet(o)) return true;
  }
  return false;
}

// 斜走:伺服器規則只看目的格,會從斜向柵欄的縫鑽過去;
// 這裡另外要求「先橫再直」或「先直再橫」至少一條走得通(不能切牆角)
// ---- 開放區域(大陸 4):assets/map/open4.png 每格 1 像素,透明 = 開放、半透明黑 = 封鎖(伺服器 L1OpenArea 同一份資料)----
const OPEN4 = { x0: 32448, y0: 32064, w: 1856, h: 1536, img: null, open: null };
{
  let tries = 0;
  const load = () => {
    const img = new Image();
    let done = false;
    const retry = () => { if (done) return; done = true; setTimeout(load, Math.min(30000, 2000 * 2 ** tries++)); }; // 抓不到 / 太久沒回應:稍後重抓(以前一次失敗整個 session 都沒有遮罩)
    const stall = setTimeout(retry, 20000);
    img.onload = () => {
      clearTimeout(stall);
      if (done) return;
      try {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const open = new Uint8Array(c.width * c.height);
        for (let i = 0; i < open.length; i++) open[i] = d[i * 4 + 3] === 0 ? 1 : 0;
        done = true;
        OPEN4.open = open; OPEN4.w = c.width; OPEN4.h = c.height; OPEN4.img = img;
        try { if (typeof renderHomeBtn === 'function') renderHomeBtn(); } catch { /* HUD 還沒準備好:之後進遊戲會再畫 */ } // 回城選單裡的村莊(例如奇岩)要看遮罩
      } catch { retry(); }
    };
    img.onerror = () => { clearTimeout(stall); retry(); };
    img.src = `open4.png?v=${window.AV?.open4 ?? 1}`; // gateway 回這個站自己的遮罩(L1J config/open4.png)
  };
  load();
}
const onMainland = () => st.mapId === 4 && !st.inInstance;
// bin:4 個 big-endian int(x0,y0,w,h),每列補齊 byte,最高位元是該 byte 的第一格。
// 純解析函式,不碰 DOM / 遊戲狀態,離線測試直接取用這段。
function parseOpenArea(buf) {
  if (buf.byteLength < 16 || buf.byteLength > 65536) throw new Error('invalid openarea size');
  const hdr = new DataView(buf);
  const x0 = hdr.getInt32(0), y0 = hdr.getInt32(4), w = hdr.getInt32(8), h = hdr.getInt32(12);
  const stride = Math.ceil(w / 8);
  if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || buf.byteLength !== 16 + stride * h) throw new Error('invalid openarea header');
  const bits = new Uint8Array(buf, 16), open = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) open[y * w + x] = (bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
  return { x0, y0, w, h, open };
}
let currentOpenArea = null, openAreaRequest = 0;
function loadCurrentOpenArea(id, key) {
  const request = ++openAreaRequest;
  currentOpenArea = null; // 換圖先當整張開放,不能沿用上一張地監的遮罩
  if (id === 4 || st.inInstance) return;
  const version = st.mapVer || window.AV?.build || 1;
  fetch('/openarea/' + id + '.bin?v=' + encodeURIComponent(version)).then(async (res) => {
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseOpenArea(await res.arrayBuffer());
  }).then((mask) => {
    // A → B → A 也要擋掉第一個 A 的舊回應;副本與本體共用底圖但不能共用遮罩
    if (request === openAreaRequest && st.mapKey === key && !st.inInstance) currentOpenArea = mask;
  }).catch(() => { /* 下載 / 解析失敗:維持整張開放,下次換圖再抓,伺服器仍會擋封鎖格 */ });
}
function activeOpenArea() {
  if (st.inInstance) return null;
  return onMainland() ? OPEN4 : currentOpenArea;
}
function isClosedArea(x, y) {
  const mask = activeOpenArea();
  if (!mask || !mask.open) return false;
  const i = x - mask.x0, j = y - mask.y0;
  if (i < 0 || j < 0 || i >= mask.w || j >= mask.h) return true;
  return !mask.open[j * mask.w + i];
}
// 小地圖 / 大地圖:封鎖區塗暗(在斜角變換下呼叫,單位是格,原點是自己)
function drawClosedOverlay(g, me) {
  const mask = activeOpenArea();
  if (!mask || !mask.open) return;
  if (!mask.img) {
    // 地監只在第一次畫時把格子轉成透明 / 半透明黑,之後大小地圖共用這張 canvas
    const c = document.createElement('canvas');
    c.width = mask.w; c.height = mask.h;
    const ctx = c.getContext('2d'), pixels = ctx.createImageData(mask.w, mask.h);
    for (let i = 0; i < mask.open.length; i++) pixels.data[i * 4 + 3] = mask.open[i] ? 0 : 160;
    ctx.putImageData(pixels, 0, 0);
    mask.img = c;
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(mask.img, mask.x0 - me.px - 0.5, mask.y0 - me.py - 0.5);
}

// ORENGATE_FOLLOWUP1: exact server ABC bit mask, decoded once, no network.
let orenGateBits = null;
function orenGateContains(map, x, y) {
  if (map >= 72 && map <= 82) return true;
  if (map !== 4) return false;
  const dx = x - 33856, dy = y - 32149;
  if (dx < 0 || dx >= 432 || dy < 0 || dy >= 590) return false;
  if (!orenGateBits) orenGateBits = Uint8Array.from(atob("AAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8AAAAAAHAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH+AABgAAPAfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/AAHgAAfA/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/wAPgAA/B/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/8AfwAB/H54AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//g/4Af/H/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//x/8P//H/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH////////H//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//5/+f//H//ABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//5/+f//H//ADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAH//5/+f//H////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAH//5/+f//H////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAH////////H/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAD///////+H/j//+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAB///////8H/j//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAA///////4H/j//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAf/+98//wf////gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAA98AAAf//n/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAB98AAAf//H/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAB54AAAf/+H/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAB54AAA//+P/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAD74AAB/4///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAADzwAAD/4///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAHzwAAH/////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB3gAAH3wAB//////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABn4AAH3wAD//////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB////Pvv/////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD////////////////gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH////////////////wAAAAAAAAAAAAAAAACAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////z////////////wAAAABgAAAAEAABB/AAAAEAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////8//////////4AAD/wAAAH+gAD/DgAAAOAeAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAf//////////n///////8AQH/4AAA//wAH+RwAAAPAeED8AAAAAAAAAAAAAAAAAAAAAAAAAAAD//////////w/////D/+A///8AAH//4B/85wABkfA/f/8AAAAAAAAAAAAAAAAAAAAAAAAAAAD//////////3///n/D//B///8AEP//+H/45wAD///nP/8AAAAAAAAAAAAAAAAAAAAAAAAAAAD//////////////x/n////H/8AP4f///4B8wABf//nMf8AAAAAAAAAAAAAAAAAAAAAAAAAAAH//////////////3//////D/f//wf///wB8/wHP///IX8AQAAAAAAAAAAAAAAAAAAAAAAAAAP/////////////////////D/P//4f///AP+fwD////Yf8P4AAAAAAAAAAAAAAAAAAAAAAAAAP/////////////////////H+P//////+AHmYgD3//8f///wAAAAAAAAAAAAAAAAAAAAAAAAAf//////////////////////+P////5/4Af+AgPv//49///wAAAAAAAAAAAAAAAAAAAAAAAAA///////////////////////9/////4PwAf+Agfn//x////gAAAAAAAAAAAAAAAAAAAAAAAAB////4//////////7///////5/////4fgD//Pgf///j//n/gAAAAAAAAAAAAAAAAAAAAAAAAD////4//////////5/P/////h//8///+P///PgP///j//+/gAAAAAAAAAAAAAAAAAAAAAAAAD////5///////+f/x/9/////z///3//4N///fAA///j//+fgAAAAAAAAAAAAAAAAAAAAAAAAH////////////+P/x/8/////////3//gb///fAAf//z///3gAAAAAAAAAAAAAAAAAAAAAAAAH////////////+f////v//+H///////AP///PAAf//5/j/vwAAAAAAAAAAAAAAAAAAAAAAAAP/////4///////P//P/f//4D//+/9//Ad7//AAB///5+B/f4AAAAAAAAAAAAAAAAAAAAAAAAP////84/////////8D+///wB//wP7/+A3P//AAD/7/58A/P4AAAAAAAAAAAAAAAAAAAAAAAAP///44Y/////////4B+f//gA//gH5/+B////4AD+//74A//4AAAAAAAAAAAAAAAAAAAAAAAB////44f/////////wB////AAf/AH//+B/+//8AAO/7zwAf/8AAAAAAAAAAAAAAAAAAAAAAAA////44////////f/gA////AAf+AD//+A//////////z0AB/+AAAAAAAAAAAAAAAAAAAAAAAA////////////////gAP///wAf+ABf/+Af/////////x+AA/7AAAAAAAAAAAAAAAAAAAAAAAA////////////////4AD///4B//gAP/4Af///8AAP//4fAA/zAAAAAAAAAAAAAAAAAAAAAAAA////////////////8AB///8H//wAH/wAP///8AB///4AAB//AAAAAAAAAAAAAAAAAAAAAAAB/////+f/////////+AA///8P//4AH/wAP///8AAf///AAD//AAAAAAAAAAAAAAAAAAAAAAAB/////+f////////n+AA9//8H//4AD3wAf///4AAf/t/4AH9+AAAAAAAAAAAAAAAAAAAAAAAD/////////////////AA7//wNv/8ADvwH////wAAf/5/4AAd4AAAAAAAAAAAAAAAAAAAAAAAH/////////////////gB///gH//8AH/4Hf///jAA7h//////wAAAOAn4GYAAAAAAAAAAAAAAP/////////////////wH///AD///Af/4Cf///nAD/h//////wAAAPY8cP8AAAAAAAAAAAAAAf/////////////////4D//8AD///gP/wP////nAH/n//4AAfwAAAf/4f/wnAAAAAAAAAAAAA//////////////////4B//8AA///gH/AH/v//n8Pzz//4AD/4AAA//4f/5/gAGAAAAAAAAAA//////////////////4A+/8AAf//gD+AD////nwH////8AB/8AAAf/8f///wAHAAAAAAAAAB/////8////////////wA8+8AAf//AD+AB/n//3wA////wAA/8AAAf//////wB9gAAAAAAAAP//////////////////wAcc8AA///AB+AB/h//zgAf///gAA/+AAA///////4Hz4AAAAAAAAf//////////////////wAcw+AB//3ABeADfh//zAA////AAB/eAAB////////////AAAAAAA///////////////////4A/5/AB3/ngH/AO/j//3AAP///BgH/cAAB//n//////7/5AAAAAMB///////////gA//////4H///gDn+Hgf/AP/jj3nAAH///PgP/4AAB//n/////////gAAAAf////////////f4f/////8P///wP//Pw//gN//D/PAAP///PwfnwAAD//3/////////wAAAB////////////w98P/////8/P//4f/v/w8/gP/+AsPAAf///P4P/wAAH/3/////P/////AAAD//9/////////v/+H/////wf///wefP/g//gH/+A4PgAe///PwD/wAAD///////j////nAAAH////////////f//D/////gH///gf/H+AP/APv8AAf8Af///HAB/wAAD/n/////v////nwAAB///////////+/9/h/////AD///AP/P8AH+AfH8AA/+B////mAAf4AAH/////////////wAAD///////////9///wA///+AA//8AP//4AD+A+D4AB/+H9///mAAP8AAP////////////PwAAn/////3/////7/8AP4f//8AA//8AD//wADuAcBgAB//P////OAAP8AAH/////////////4AA//5/9/n/////3/4QPsP//8AAf/8AD//wABnAAAAAD/+H///+OAAP4AACP////////////8EB//8P////////v/5eP+H/58AAd/8AB//wABHAAAAAD/4H///8eAAfwAACP4////////////////9/////w///dh5fP/D/4cAA7/+AB//wADGAAAAAD/wD5//4/AA9wAAGOY//////////////////////w//+8Bx/P/h/4fAB7//AD//4AH8AAAYEH/gD5z+x/wA/wAAP//////////////7/////////5//98D3/vfw/4/gB///Af///AH8AAAcP//AB///j/8D/wAAH//////////////z///////////+D8/UBP/8f4/wD///A////gP8AAA////AA//8H8+B7wAAH//////////////D///////P///9B8/0fPwOP//4f3//h/j//x/8BgB////AAf/4P+MB/wAAP/v////////////n/////////v/7h/9X/vgOH//w////B/j//z/+DwD////AAf/4P+4H/4AAf/////////////////f//////P/3//7XAPiPD//Af//8Av///h//H4P////gA/74e/wH/8AAP////////////////////////H/v//73f//Pz/+Af/x4Af///B/////////gH//4//AH//AAf////////////////////////P/v/8////sP7/4AP/w4APz/8A3////+H//gP//4f+AD/ngA///////////////////////////v/+P///gP7/wAP/w4AP4/4Az////4D//wD//4/+AD//wA////////////////f//////////v/+////8f7/wAP/w4AP7/wAf/x//wB//wT//4/+ADn/wAf//////////////////////////v////////7/4AD//4Af//wAP/hf/gA+/gf/78/+ADn/gA///////////////////////////uP///////7/8AD//zAf8/wAH/h//gA//APf/58+AD//IB////////////v//////////////uP4f/////7/+AD//Hw/gDwAH/f//AAf+AGf/z/+AD/3ID///////////////////////////uP4P/////7/+AH/+D5/AB4AP4f//wAf8AD//nrnAH//oB//////////////3////////////v/8//////5//A//4H/+AB4B/+b//4B/8ADsfPDnAP/34B///////////////////////////v/9//////4//A//wD/8AB8D//f//8P/4AHAAfCfgEf/wD///////////////////////////v///8Af//4f/hv/AB/9gD+G/////8H/4AEAA/CfgEf/wH///////////////////////////Z///5+f//8P+Bv+AAf/3/+G3////4f/4AAAB///Ac//gD//////////////////////////+x///5/AB/+H8B/+AAP/v/8Dn////wNv4AAAB//+AP//AH//////////////////////////9////5j/5//D4Af+AAP/P/wB//7//gH/8AAAD//sAH/+AP//////////////////////////7////5j/9//zwAf+AAP+P/gA8///+AD/+AAAH//4AD/8AP//////////////////////////3////5gAB//jgAP+AAf4P/AAc///8AB/8AAAP//wAB/gAH//////////////////////////v+9//5gAB//jgAH+AA/wH+AAf///8AA/4AAAf//wAB/AAP/////////////9////////////v////5wAB//jwAD/gAzgP+AAP///8AAf4AAA///wAB2AAf//////////////////////////v////54AB//jwAD/wBhgP+AAP///8AAf4AEB///4AB+AAf//////////////////////////v/wB/4YPx/vzwAD/4P/hn/AAP///8AB/8A//////AD+AAP//////////////////////////f/gB/44PJ//7+AH/8f/j//wA////+AB/+B//////gH+AAH/////////////////////////+//JB//4eJ//7/AP/8f/n//4A/////AD3///6f///gH/AAP/////////////////////////x//Px//5+J/f7/gP/4P/H//8A/////gHn////////wH/AAf/3///////////////////////jgfN5/+Y+J//3/gP/gP8H//+A/////w//////////gAfgAf/+///////////////////////fgfN5/8YiJ/Hv/AD/AH4H//eAH/+f/4///////7//AAfgAP/9//////////////////////+/gfN5/+YiJ/Hv/AA8AB4H//4AD////w+f///////zAA/wAf///z////////////////////+/mfN9/+f55/Hv/AB8AB4///4AH7///gf////////zAA/wA//5/z////////////////////+/sfJh/+f85//v/AB8ABx//v4AHz///AP/v///////AAf4A/////////////////////////+/sfZ5/+HP5//v/AA+ABj//94ADx//8AP8D///////AAP4A////3j///////////////////+/k/5B//OAB//v/AAfADDt/58ABz//cAP4B///////gAP4A////3j4v/////////////////+////D///AD//v/gAfAOBn//+AB///8AD4B////+//wAH4A//////4f/////////////////+///AH///+H//v/gAPgYAf//+AA///8ADwB///////+AD+A/////+f//////////////////+///A////+Hv/u/8AHwAAf///8AY//8ADgA/+P///+/gD/A/////+l//////////////////+////////+P//v//AHgAAH///+AP//+AH8AfwH///gBwB5g/////////////////////////+///////////fv//gHAAAD/3/+AP//3Af+AfgD///jhwB5g//////v//////////////////+/8AP///////Bn//wGAAAD//f/AP/7/g/+APAB////wAD5A//////f//////////////////+d7+H//////+Bj//wEAAAP////gf//9wfjAOAB////4AD8A//////f//////////////////+P3/Df/////+Hh/44EAAAP///jw////B/jAeAA/////wH8A/////////////////////////+Pu/j/////P//w/AcMAIAP/88B4//++Bv/A/wA8H//94PwA//////////////////////////Aefz////7j/A4+AOeAMA///4A5///8Af/A/4B/H///cfwA///////////////////////////8f7////7v+A88AH/weD/3/wAf///4Af/A/4P7////+QQA///////////////////////////8f7//////+I+4AH/4fD///gAf///4Af/A/4f7/////8YA/////////////////////////////7///////8+4AD/8/D///gAP///4Af4B/wP6/////+MA///////////////////////////8fv/////f+w++AD//+D///4AP///8Afx//gb+////8DMA///////////////////////////8f7//////+A+/AH//4B///8Af////g/AP/AP////ouDsA///////////////////////////8/////////h+/h///wB///eH/////w8AP8AH7////vDuA//////////////////////////////////////+/j3//gB////P/////x4P/4AB7j///vS8A////7/////////////////////////////////+/D///AAe/3uP/////7gH/4AB7j//+P64A////7/5//////////////////////7////////++B///AAP//8O3/////AA/4AA6i/8D/qYA//////////////////////////////////////+8A///AAP9/4D/////+AAf4AA7j/8B/+IA/////////////////////////////////////3+4Af//AAf//gB/////8AAf4AB7z/8B/+IA/////////////////f///////////r///////++wAP//gH///AA/////8AAf8AD7//+D//IA////////////////+f///////////5////////+wAH/5gH//+AAf////8AAP+AHDf//D//8A////////////////+P//n////////4+//vAD/gGwAD/4wP/9+AAP////4AAP/AOD///D//+A////v///////////+f///////////4c//8AD/ACwAD/54P//+AAf////5AAH/gf4/v/D39+A////////////+////////////////8P//4QD/ACwAH/8wN//eAA///x/zgAD/w/8///D38MA////////////+////////////////+H//4fj/ACwAP//gD///AA/////jIAD/g88///nzwIA////////////w/////////////////D//4fz/AC4AO//AD///gAz//++D4AB/A/8///3/4YA////////////5/////////////////jv/5Rj/AC8Ac//AD/fzwBh//+4P+AB+Af8///3/4wA///////////////v//////////////zH/55j/AG+B///AB///4H///+w//AA4Af8/////zwA//////////////////////////////7P/4dj/wd/D///gA///8P////h8/gAYAP8/////zwA/////////////v////////////////7m/49j/4b+Dz//4A/9/8P///vB//gAIAH//////34A////////////////////v/////////58///j//38D///8Af/7wP///gB//gAIAD+////f38A/////////////////7//P/////////4w//Zj//v4B///8Ab//gH///wB//wAAAD+f////z8A///////////////////8P/////////4Z/8Zz//vwB///8A///AH8//wB//wAAAH///8f/x8A///////////////////+f/////////8P/+Yz//vgAf//8D//+AD8//wA//wAAA///////54A//////////////////////////////+H/+fz//vAAf//8D//+AB///wAf/wAAD/+P///f5wA/////////////////////////+P////D/+dj//vAAP//4D//2AA///wAf74AAD/+f////DgA/////////////////////////8B////j/+DnzfvAAP//4D//nAA//zwB//8AAD/+P///nDgA//////////////v//////////8B////z//jO4/fgAf//4B///AB///z///8AAAf/f+f//fgA///////////////n/////////4B////7/83f7+/wD///4A///gf///j///+AAA/+f/8f/ZgA///////////////j///////+MAB////7/////9/4H///4A//vgf//+H///+AAA/9/////7gA///////////////n///////8AAB////7////57/wP8f/8Af//w///8D///+AAAed///f/XgA///////////////z///////8AAA////3////4b/wP8f/8Af//g///gH///8AAAed///f//AA///////////////////////4AAA////v////4b/wF///+A///A3//AM///4AAAP/n////8AA///////////////////////gAAA////v////47/AD////g//+AP//Ac/n/wAAAP/n////4AA///////////////////////AAAAf///v////47/AB////x//8AH//AefvnwAAAH8n///9wAA///////////z////9//////AAAAf///v/////7/AB////z//8AH//Af/H/wAAAH8n///zAAA///////////zv/////////+AAAAH///v/////7/AB//////98AH//AP+D/wAAAP8////GAAA/////////////////////+IAAAAD///v/////7/wD////////AP/+AHcB/wAAA/8fj/+OAAA/////////////////////8AAAAAB///v/////3/8D9///////wf/+AB4A/4AAA/+Pj/4eAAA////////////////3////8AAAAAB///v/////s/+H5///////4e/cAAAA/4AGA/+Hi7z8wAA///////7////////j////4AAAAAAf//f/////cf+H4///3/w/8//4AAAAf8AeA//Dn7H5wAA///////3////////n////gAAAAAAP/+/////+8///5///j/gP///4AAAAf4A+Af/gAQPxkAA///////H////9///z////gAAAAAAP/+/////9+f//////A/AH/5/4AAAB/wA+AP/wA//B8AA/////////////////////AAAAAAAP/+f///+7/////z/+AOAH///4AAQP/gA+AH////+D+AA///////////n////////+AAAAAAAP/+P////3///////4AAAH///8AA4f/gA+AH///38f/AA//z////////h////////8AAAAAAAf/+H////v//A///3AAAAD///+AB4f/gD+AH//4T4+fgA///////////h////////8AAAAAAAP//A///wf/8Af//+AAAAAH/3/ABwf/gH+AP//5xg//wA//////////3j////////8AAAAAAAP//8f//v//4AI/+cAADgAD//38DAH/wP/wP////A//wA//////////nj////////+AAAAAAAP//+P//f//wAAH+YAAHwAA////+AD/4H/4f///8A//4A//////////j//////9//+AAAAAAAP//+H7u///gAAD/4HAHwAAD///8AD/4D74f///4A//4A//////////n//////5//4AAAAAAAf///Avn///gAAB///wP4AAB///8AA/wBx/////4Af/4A////////////////94//wAAAAAAAf/////////8AAA//7//8AAB//f8AAfgAA/////4AP/4A//+P/////////////5//wAAAAAAAf//////////AAAf/z//8AAB+/++AA/AAA/////4AP98A//+P9///////////////wAAAAAAAf//////////gAAf/////4AA//3mAB/AAA/////4Af/+A///////////z////////gAAAAAAAf//////////gAAf/////8AAH//mAB/AAA/4///4////A////i//////x////////gAAAAAAA/////////CD8AAb///z/+AAB//+AD/AAA/43//x////g////h//////z////////gAAAAAAB////////+/h/gAP//+B//wAA7//wH/AAAH5h//g////g///////////5////////AAAAAAAD////////9/w/4AA//8Af/4AAf//4/+AAAB/5/+B////A////////////////////AAAAAAAB////////7/4f8AAH/4AP/4AAf//w/8AAAB/8/4B///+A////////////////////AAAAAAAB////////388P+AAB/wAP/8AAf//gf8AAAB/8fwH///4A////////////////////gAAAAAAA////////v/+H8AAA/wAH/8AA/++Af8AAAD/+fgP///wA//////////////n/////AAAAAAAA////////f//H8AAA/8AH/8AP//4AP8AAAG//fgPv/zwA//////////////n/////AAAAAAAB/+/////+///H4AAA/+Af//wf//4AP8AAAM//fgP/j/wA////////////////////gAAAAAAB/8/////9//+X4AAA//D//Pwe/+4AH+AAAP///wH/B/4A////////////////9///wAAAAAAD/w///5/77//34AAA//D//jgP//4AD+AAAP///gDuA/4A////////////////////wAAAAAAH/5//////7//34AAA/+H//vAP//4AB8AAAH///AAcAf8A////////////////////8AAAAAAP//////3/D///8AAA/8Hb/8Af//8AD4AAAH//+AAAAf8A////////////////////+AAAAAH/////////n///+AAAf4D//8A//+8ADQAAAP//+AAAAP+A////////////////////+AAAAAH//////////////gcAPwA//8B///8A/wAAB///+AAAAP8A/////////////////////AAAAAH////////////3//+APgA//8B37/+A/wAAB///+AAAAf4A/////////////////////AAAAAH////////////3//+AHAAP/8A/x/+B/wAAD///+AAYH/wA/////////////////////AAAAAH/+f/////////3//+APAAH/4A/g/+B/wAYD5//+AA8H/wA////////////////2H///AAAA///8f/////////3///AfAAP/4APAd8B/wAf/////AA+P/wA////////////////2H///AAAB/////////////33///A/AAf/wAAAZ4Af4Af/////gB4P/4A///////////////5/H///wAAD/////////////n3//zA/gAf/wAAAf4AP8AP/////8DgDf8A///////////////4f////4AeH////////////7/3///B/wA9/wAAAO4AH8AP9//////AB/+A///////////////4f////4A////////////////////B/4B5/wAAAH4AH4AD4/////+AAf8A///////////////4/////8B////////////////////D/8H//wAAAD4AD4ADwf////+AAPwA///////////////4zf///8D////////////////////D/+H//wAAAD4AD4ABAH////+AAPgA////////////////x7//////////////////////////f8Hn/4AIAP+AD4AAAH/////AAPgA////////////////z/////////////////7/////////f4D///gcAf/gD4AAAH/////gAfgA/////3//////////5/////////////////7//////////wD///8+Af/wD4AAAP/fz//gA/gA/////v////////////////////////////7//////////gD//+//AP/4D4AAALePz//wA/wA////7v////////////////////////////7/////9////AD//wH/AH/8D8AAADcP///8B/gA////3/////////////////////////////7//////////AA//gD/AH/8H/AAADIH///8P/AA////v//////////////f//////////////73/////////AAf/AAfAD/8H/gAADAAf//4P+AA////+////////////r//////+/////////7/////z////AA/+AAPAB38P/wAADAAP//gP+AA/////////////////jf/////8///////////////x////AB/+AAHgB/8f/8AADAAP//AP+AA////5////////9+//x//////8f//////////////z////gP//gAHgB/////gADAAP/8AH+AA/////////////////z//////8///////////////5////wP//wAfwAf///+wADAAP/cAH+AA////////////////f////+f///////////////f////3/wf//4Af8Af///8gADAAP/8AB+AA//////////////////////7/z////////////////////wf/z+A/+D////vwADAAP/8AA/AA////////////////////////4///////////////+////gb/4/A//D///7/4ADAAD/8AA+AA////////////////////////7////////////////////AH/7/Af/D/////wADGAD+2AA+AA////////////////////////////////////////////+AH//+AOP//////wADHgD/+ABoAA/////////////////7//////////+f//////////////+AH//4AAH///////4DHwH/+AP4AA////////////////////////////////////////////+AH//4AAH///////4DAYH/nAf4AA///////////////////7/////////////////////////gH//4AAH////j//4DQcH/ngP4AA/////////////7////////////////////////9////f/4H//4AAH////j//8P+MP//g/4AA//////////////+//////////////////////////////8P//8AAH3///z//8PnMf//AP8AA////////////////////////////z//f////////8/7//+f//+AAA///j5/+AfnOf/+AH8AA////////////////////////////z///////X///8////+f//nAAAf///o/8j/9G//8AD+AA/////////////5///////////////////3//P///+f///////AAAAP///s/5//5n//sAD+AA/////////////8f/////////n////////////////P//////6AAAAf/////x//5n//MAD8AA/////n///////9/////////////////v///////////7////4AAAA////3/h//xP//8AB8AA///////////////f///7////+///////////////////////8AAAB3////+B///P//+AB8AA////////////v////5///73/6f////////////////5//////gAABn///v8B///D///gB8AA////////////n//3/4/////////////////////////////3/wAAB////v4D///D///4B8AA/////////////////5///////////////////7/////3///n/wAAB////vgD///h///8B+AA/////////////////8/9////////////+/P//5///////////gAAA+P///gB///x///+B+AA///////////////////o////////////9zP//////////////gAAA+P/+vgA///5////B+AA////////////////+f/5//v/////////////////////z///7AAAB+P/+vgA///4////D/gA//////////////////////P////////+//////////7/47/8+AAAP+P//vAB9//M////D/wA///////////////////////////////+f///////z/5/7//8eAAAH///iPAP///8//7/H/4A////////////7/////8P///////////////////8z/x////8+ACAH/7///Af+//9////P/8A////////////5/////8O///////////////////4//h////+eADAP/5///A/8//9///////w/////+//////5///+n+f///////////////////4//h/////+AB///////gfw9/8///////4//////////+/4////+/////////////////////x/////////AD///////AB5//8//////zw////////////5//////////////////////////v/////v///gB//////8AA///8//////x4////////////////////n//////////////////v/////////gB/v///54AAf//8f////9zw///7//////////////+fx////n///////////////////////AA/H////4AAf//+D/////+g///wX/////////////+N3////n//x////////////////////AAeD5///4AA+f/+D/////+A///0P///////////9/+f////////x////////////////////AAMB5///4AD//v/z/////+A//////////////3/5//P////////x//////////3/h//////8AAAA////4AD////5/////+A////////////////h+/////////////////////w/g//////8AAAA////4AB////5//////4////////////////z/////+/////8P/////////w/w///////AAAA+e//8AA////4//////8////////////7/////////8/////4f////////4x/////////gAAAcP///gA////8/////nw////////////7///////////////4P////////4/////5////gAAAAP///wAf//+c/////xw////////////z/////////P/////4/////////4/////5////wAAAAH+/PgA//7sZ/////3A///////////////8P//9/////////////////////////////4AAAAHj/hgB////z/////+A////7//////////8P7/////////v/////3///////////+f//8AAAADB/vgH////j////5+A////7/////////++f//////////f/////n///////////2f//+BgAAAB//gO////H//97//4//////////v///////v///////+f/////v///////////z/////AAAAA//wE////P//////8////////////////////////////////////////////f/////3AAAAAf/gf////P/9////8////////////////v////+/////////////////////+fn////nAAAAAf+AP////P////+/8/////////////////////+////f////////////////+fj/v/9+AAAAAP8AH9///P////+/8///////////////////35/3////////////////////Zfn////+AAAAAP8AH////v/////+8//////////////7/////5/////////////////////////////+AAAAAP8AH////n///v//8////////////////////x/////////////////////////////+ADAcAf8AH/+//n//////c////v///////////////h/////v////////////////////////8Pg+B/8Ad////v//////w////f///////////////h///////////v/////////////////////+Bn+Af//Hvv//////4///+3//////////7////////////////////////////8f/////////Bj/Ab/+D/f///7/v8////////////////////////////////////////////8f////////+Dn/AZ/8BYf////394////////////////////////////////////////////8f////////8Dz+AP/8Bwf//////4///////////////+P/////////////////////////////////////8H/+APf4AA//f///9Y///////////////8P/////////7///////////////////////////+H/8AeP4AB/+f//9/Y///////////////8P/////////3///////////////////////////+P/8A8HwAB///////8//////////////////////////3///8ff////////////////////////8A4DAAD//v////o////////////+///f/////////////8f/////////////9///////////8AAAAAD/////734//////////////z///////////////n//////////////////////////8AAAAAH////7//o//////////////////////+///////v//////////+///////////////8AAAQAH//////74//////////////////////+H/////E/+////v////9/////9///3/////4AAA4AP//f////8////////////m/////////+H/////h///////////9///////////////wAAB4P////////U///////////3n/n///////+P/////////////////////9///////////wAAB/////+////8//////5////8Df////////D///////////////////////////+f/////wBAD//////////0//////7////sDf////////BN///////////////////////7//+P/////8DgH////////7/8///////////8zP////////hP/////////////////////f////+f/////+Hwf//////99//0//////5/////7///////////////////////////////+f/////P/////////////9///+/8////////////P///////////////////////9/z///////////////////////////////7s//////////////////////////+P///////+//z/////////////////////5///+//////8//////////////////////////+P+f///////////////////////v//////8f/////////s////8//////+v/////////////+P+f////////h/////////P///////////9//////////4//////////////////////////////////////D/////f///P//////////////////////4///////////////////////////////////j//B////+f/////////339///////////3/v8////////////////////P////////////z/j//H//H/+f////////////////////3//+//4////////////////////////////////+D/j/////H///////////////////f/////3///o////////////////////////////////+D////////////////////////+////////////4/////////9///////////////////////n/4//////////////+//////////////+///e/o///////////////////////////////////w//////////////f////////////3///////4///////////////////////////////////w///v////3v/+f+f///////////////////e4////////////////////9//////////////////////////+////////////////f//3//38////////////////////8///////////////////////////////v////////7/////+//98////////////////5/////////////////////////////n/////+////z/////////////0////////////////7////n/////////////////////////////////////7///////////8///////////////////f/n///////////////8T////8//////////9/////////v/f////4////////////////////////////////////8eH///////////////////3////////+/v6w////////////////+f//////////////////4H/////////z///////////////////////g/////////////////+//////////////////wHs////////z///n//n7///////7///v///4////////////////////9//////////////5wH9/////////////+////////33/7//////8/////////////////////5/////////////7wH////////+P///////////3/////5v/ff/8///////////////////////////////////xwP/f//////+P//////7///9//////5/////Y/////////////////////P///////+/////x//4P//////+P//////p//////////////9vw////////////c////////P/////////////x//4P/////////////////////////n/////w////////////f////////////5////////////+f///////////////3//v///f////////Y////////////f////////////5/////////7///////////////////+//f////////////8///////////////v/v///////5//9//////4f///////////+H73//7/7/P7////////t7/0////v/////////vP/+//////8P/////////4f///////////+D7///////+///u/e/////v8////n///////////////////8H/////////4/////////////D///////f///////7/////8///+n//////////5//P/////+H/////////////////5f//////3/////////v////7////8///9n///////////////////////////8P/v////////9///////+/9///////////////3Y///9///////v///////7////////////8H/k////////////////n//////3v/+/3/+7///4///////////L/f//////////////////+H/wP////////8//////n//////////////////g/////////////////////////v/////////wP////////////////7/v7//////v///+///4///////////j///////////////////////wP/////////////////////v/3f/////////4///f///////D///////////////////////wf//////////////////+/7//9///v///7v3g///////////D////////////////////P/////////////////3/////7///7////f/////g////////////////////////////////P//////////8//////n////////3+7/////////w///////////P////////+//////////////////////8f////+////////7////////3/v/4///////////P/f//////9////////////////////////////8/+f/////////3////////Y////////////+f//////9////////////////////////////8/m/////9//////////9/f4////////////4f//7v//////////////////////////////8y/n/////////v9///////34///i////////8/////////////8/////////j//////////9/////+/////f///13vv3///4///h//////////////////////8h///////5D/////+f///////////vv//1///////////4///////////////////////////g///////5D/////+f95v///////3////z/////////f/U///////////////h///////////w///////5///////H///////////79//////////3//38///Z//v////////h///////////P////////+//3//+H//f////5//////////f////////8//+7//////////+H///////////f///////////v//+H//f/////v///////+//////////4//9//////////+ef///////////////////////v///////////////+f/////+//f/7/394/////////////+fP////////////////////////////////////9//++//9/f/////////w///////////////////////////////////////////////f///9///+///////////////w///z//////////////////////////////////////////+f///0f/////7/////////3//4/////////////////////5/////////////////////n/f+f/////9//fe/m/////////9/s////////////////////////////////////////////+a////////9////v/7////////vk//////////////////+///////////////////////////////////////////7/+79////8//////////5////////+////////////////////////////////////f//////////////8//////////8f/7/////6//////+////////////////////////////////////////////s//////////9////////5w/////////////////////////////////////+/v//7///fvf/4///////////3////////w//////3////////////////////////v/v/3v/3v//////7/+/4////P///////////////5//////////////////////v/////////////////l//19///7v4//////////////////////////////////////////////////////9///////3////////o///////////////////////////////////////////////////////v/97/9///+///93/8////////+v/f3////////////////////////////////////////////f//3/9///////74////////+P////////////////////n////////////////////////////////v///////o/////////O////////////////////n////////////////////////+///////9///////8////////8v////////////////////n//////////////////////z///////7/////////s/////////////////////////////////////////3///////v///v/////////////7/v/4//////////////////////////////////////9////////3/////////33//f/+/3////74////f//////////////////////////////////////////x////////////+b/////////w///////////////////////////////////////////8///7/8P////39//vef7///////+w///////////////////////P///////////////////8///+P8H///3//3/7/f//////57/4//////////////////////////////////////7////////8P+H/+/////vf///3f/vu5//s////////////////////////////////////+f/////////8P//////////3//7/////8//4///////////////////////f////////////+f/////////////////////1/3//+//////4//////////////////////9P//////////////////////Em//////3///////////+f//f8////////////////////f/////////////H////////3//gF//////z/f////+////+f///s//////////////9/////7/////////////H////////k///F/////////v//3/////////74////////////////////f/////////////H////////wf//P//////9//////vv/////+//g///////////////////+f//////////////////////5////////////v///////7/+////g///////////////////+P/P/////////////////8///3//////8/n///v/////v/7/////g///////////////////+f/j///+f////////////8//////////4/n////v/tvv////////g//////////////////////v///8f///////////////////////4//f//7///////////9/4///////////////j//////////8f///////////////////////5///////f//377/7////Y///////////////D//////////8/////////////////////////////////7/+////f9//4///////////////Df/////////////////////////////////////vf///9///////////4///////////////+f/////////////////+/////////////////////////////f////9/4///////////////+f//////////////z////////////////////////v/////////////9Y///////////////8f//////////////j///////////////////7//////9/73/////3/f/4///////////////////////////////jv////////////5///////3///7/3/z//9/7////c///////////////3//////////////8n/////////////////////T+////+/y///+///9/8///////////////z//////////////8/+//////////v////////9//////////////////0//////////////7///////////////8///////////////////////////v//3///f///f/8//////////////z////3//////////////////////////++f/////////////f////vff94//////////////x////v//////////////////////7///+f////////f/////////9//7/4//////////////z//P/v//////////kf///P//////69//////+f///////9//97//9/9/+4///5/////f///////L//9/////9P//gH///f//////+f//////+//////////////9///+/g///5/////////////P////////7P//gH//////////6f/////////5///fd//////f/////g///4//////////////////////7///wH//////////4H//v/////+///v//////+//////vw///8//////////+///////////////wH///////////P//O///////////////v///+////4//////////////////////////////wP///////////P//8///////3/////7//f///37f+s/////+/7////////x/////////////v///////////////s//////////7///f////3////8///////5////////h/////////////////////////////i/////////3//b///////////8///////3////////h//////////////////////////////////////////////////////s///////3////////z//////////////////////////+///z//////////f+/+93////+9/4////////////////D////////////////////z5////////z///9////+//+f//////9//Pg///+H////////5/Pz////////////////////z7/////P////////////v///////3////Pg///+H/////////vj7////////////////////z//////P//4//59///f///////77//////g/////////////9/v//////////////////////////7////w//5//f//3//7//v////7//3g////////////////////////////////////////////9//w///////6//////////7//+/w/////////////////////////////////////////////////////7/+P7//3v/////+///w//////////////////////////////////////////////////////////f///b/9v/////w///////////////////////////////////////////////////////ff///////////v/vg/////v////////////H/////////////////////+f/////+f//////P///f//+9//////7g////8f///////////8H//////////////////////////////////7//3/////7//7//7//4////8f///////////9H/////////////////////////////////////////v////f/////8//////////z//////////////////////////////////3//////3////7//9/f/9////e/4//////////z//////////////////////8///////////////////////+/3////89/f///4/////////////////////////////////8///////f//////////////7///////8/////98//////////8//////////////////////8/////////////+/////+////3///3////3/+/0///////////////////////////////////////////////////////////+///7///////8//////////////////////////////////7///////////////////3///////7/////9//8////7z///////+////////////////////4f//////////////////+//7/////////////8///////////////3//1///////////////4f////v///P//////f/////+///////////f/Y////////////////f/8/////5/////////gR////n///f//////P///fv////v//f//7///w////////////////f/////////////////vx/////3/////////////+//b//93///////fw///////////////////////8//////////j///////5////////v///+////v//////////4////////////////nP////+///////////j///////////////+//9//////////99///f/0////////////////nH////////////////j///////////////////9///////////v///d8/////////////////P///9////////////n////////+////////3/////7/9/+//v/////8//////////////////////f////////////////////+f//z///f/+/////////////////0//////////////////4f/+f////////////////////////j////////7v+//t/////3//+8//////////////////w////////////////////+///////if/////37///////////////8//////////////////wf///////////////////////////m///z///////////7//v////s////////////////j/h///////////////////////P/////////v////v/v////////7//8////////////////j/v//////////////////z////P/////////n///////fv9////7///8////////////////i///+//f//////z//////z////8f8f///3/////////7+/////u/+/f85///////////////////8H///f////3///////////8D4fP//////+/3f///6d/7+//////cx///////////////////8H///////////////5////8B4f/////j+////3//////v/8///v8x///////////////z///8H/////8+f////////////5zv//////D/6///+//5//////////8h///////////////z/////////////////////////7/n//////D/5//v///////////e//oA///////////////////////////////////7///////+/3//////5/////////3///////4AB//////////////////+//////////////+X/////////z//////////////+/////f///8AB/////////////////////8////////////H/+f//////////+/////8////////////d/4AB//////////////////////////////////n////////////////9///+////f///////74AB//////////////////////////////////3///////////////v///9v/////73//////gAB//////////////////////3f//////////////////////////////v//////////v/9/gAA///////////////////////7///////////////////////////+7+//7/////////9/7wAAB////////////////////5/z//3////v//////////////////8//u///97///9//+///4AAB//////////////////////D//j////mf/////////v///v//////////f+/3///////+4AAB/wf///////////////////L/9///////////////7////f///////v7/////3/fv///78AAB/gf//////////////////f//////9///+////////////f///////////////////775UAAB/gP//////////////////P////////f/////////////////////////+//3////////8AAA/AAf//////////////////////v//+f//8/+//////////////3v////////////////8AAAAAAf////v////////////////////2f/+t/+z/////v///8f//////////////f/////8AAAAAAP/////////////////////////lf///////////////8f////+/v///f//3/3/7//4AAAAAAAf///////////////vv7///////////3///////////8f/////v//////9///v///4AAAAAAAf///////////////O////////7///z////////3/8/+P//f/fv////////////368AAAAAAAf/////////f/////+v/f//////f///////v9//f////P/4f///////e9//3/////sAAAAAAAf//////////////////////////////7//////P////P/+f//f7/7/////f//79/8AAAAAAAf////////////////8///9f////f///5/////f///h////X////9////////////0AAAAAAAf///////////////////7n////////+P///59////h///////////v/////+////wAAAAAAAP/////////////////////3f/9////8P7////////n//+/////////+/////////4AAAAAAAAP//4P////f///////////9///////8L/////////P//+f/f/v7///f3//9/3/+/4AAAAAAAAP//4P////9////z//////9////rv9////////9////////7/////////////f/74AAAAAAAAP//+P////////////9////7///v////////////////+////7//////////////4AAAAAAAAP/////////+/////+9f//9////////////////////////z///////////f////4AAAAAAAAP////////////////////////9//z//+///3////////9/z//+v///3//////794AAAAAAAAP////////////f////////////////f+f///3/3///////////t7z//////////8AAAAAAAA//////////////99/+/+////93v///+//////////////7//7///+//////9v/f4AAAAAAAB///P/////3/f///8//////+///n/////3//////////////3////2f/v7///9//4AAAAAAAB///P///////////v//+/////////9/////3/////////9//f/////////+/7///8AAAAAAAB//////////+///f////+/3//////83//////////////P/////7//fv//v/3/f98AAAAAAAB////////v/8///P///9/////7////////7///////////////+/////////D/3f8AAAAAAAB///////////6////f////////f///////////////////7//v//////73//H///cAAAAAAAA///////////L////7////////////3//b//f/f///////5/////////////////4AAAAAAAAP//////9////////////////////////P////////////3//9//////////7//74AAAAAAAAP///////7//9/9/f/////f////////3//+////f//////93f/////////e9/v/+gAAAAAAAAP////////f///////7///////9/////f//z/////z///3////99/+/5///////+AAAAAAAAAP///////////v/////vf//+f/f//v3//8/z///v/z/////////////j/f/z///fAAAAAAAAAP/////9//ff7//////////87////////f//9/fn83//////+//////j///3///7AAAAAAAAAH///////////////v/////8P/////////v/f///5//////+/////////9///3v+AAAAAAAAAB///////////v/////////+//7/f3///////f/v5//////////////////+///+AAAAAAAAAB////////////b/f////7//////9///v///////5/5/////////////v/////98AAAAAAAAAA///////+8///////////v/v7//////9////+////////9//////////83/v//wAAAAAAAAAAH/v////+8////f//////9////v///7/////////9//////////f//////////AAAAAAAAAAAGMn////+f//P///7/+////9///////z////////9//5///v///////////39+AAAAAAAAAAAEI//+/v//7/h////9/////////////x////////////////v//////2/9///+AAAAAAAAAAAEL9////////v///+//+f//////////////8e///////////////9//////+/+AAAAAAAAAAAH799//////////////8f/z//////f/////8P///////3//H//////v///3//+AAAAAAAAAAAH/97///3/////7//8/8f/z///v//////v////////////+H///////z//z/+2AAAAAAAAAAAD//n////////////+H87///////////v/3//////v5//////f////xz//j//+AAAAAAAAAAAA///////////f///+////////9///////////////5/++///////fh/f/m//+AAAAAAAAAAAA//////////v///////////v/////////////////////////9//////////2AAAAAAAAAAAA/////////////////////////3////////9/////////////////////////AAAAAAAAAAAA//9/////////7///3/+//f/////////////////3//////////f//////7//4AAAAAAAAAAA//9/+///7///////////f///////7//v///9/v/////////f/+f////////74AAAAAAAAAAAf/7///v///////////////////7//////////////////////+f//9///+//4AAAAAAAAAAAH/////////////////////////////////////////////////////3/////4AAAAAAAAAAAH/////////v//33///////7////uf///9///f///////+/////////////v/8AAAAAAAAAAAH/////9/////v/////P/////////D3///////9//+///////////////v//38AAAAAAAAAAAH/+/////////////+/h////9/f//f/////////////v///////7/f//f9/3/8AAAAAAAAAAAH/M///////////////v////////////////v///7///////////////////9+AAAAAAAAAAAH/M////////////8///+///////////3///H//////v/////f///////////sAAAAAAAAAAAP//////////z///8///////8//+////////H//////Pf/f3///////////3f+AAAAAAAAAAA////////7/7z/////f//7//+H///////9//ff/////P//////////////////AAAAAAAAAAB//////////////9////////+/3///+///9/////n//////+f/////////////AAAAAAAAAAB//////8f/////////x//////////H////////+/H//////+f/f/////////37AAAAAAAAAAA//////4f///+/////hv///f////+H/////5////Hf////////////v//d////AAAAAAAAAAAP////+///7////////////////////+///5////P/7/////H//////7//+/7+gAAAAAAAAAAP/////////////3/f////////f/////////9///////3//2P///////f/////wAAAAAAAAAAf/////////////////////////////////////////////+P//////+f/////wAAAAAAAAAf///////+//v//f////7//////////v/7///////+//v///////f///+f//3/9wAAAAAAAAA///////9///////////////////////////////////////////////5//////oAAAAAAAAA/////////////////f/////v///9//////////3//////f///+//3//57/7/+/4AAAAAAAAAf/////////f/9////7//9///9///v//3///v//+///f//////////9//////f/0AAAAAAAAAH///////+//f///7///7/9////v///v/3+//+///+//f//////////7///////8AAAAAAAAAH//////////7//////////v/////////+//////////7/+///////////////v0AAAAAAAAAP/////////////////f////3////9/+////////3//////////////////////wAAAAAAAAA//////////v/////////+/////////8f//////////v/////f/////////9///wAAAAAAAAB//////////////f///////////////8f///////////////////////z7////3gAAAAAAAAD////////////+///f/////////9///8//////3/////////////////B////v/wAAAAAAAAD/////////v/////////+/////////////////////v/////////////B//////4AAAAAAAAD///////////////f7///////89/v////////3+///////////7///4fD/f////4AAAAAAAAB//////////////////+/////8///////////////v///f////////8///////f4AAAAAAAAB/////////////////+//+/39////7//////////v//v/////////3///f/9/v/8AAAAAAAAB//////////////////////////f//v//////9//////////////f///8P9///twAAAAAAAAAP/////////9////////9//////////////9//////f/////////////8P/////wAAAAAAAAAP////////////////////f////////////////////3///97///////+P/////4AAAAAAAAAD//////////////////f////////v/////////+/3////v/////////8P/////8AAAAAAAAAD////////////////////////////////////////////////////////////98AAAAAAAAAH/////////////////////////7//////////v//////////+//////////9/f6AAAAAAAAAP/////////+////////////////f/////////9///////////////+////v///+AAAAAAAAAf/////////////////////v7//////////////////+//+////9//////////92AAAAAAAAAf/////////////////////////////////////9//////+f///////////////8AAAAAAAAAP////////////////////////////////////////////8f////////9//////8AAAAAAAAAP////////////////////////////////////////////8f//v////////////+AAAAAAAAAO/////////////////////////////////////////////+////9//3///////8AAAAAAAAAAf/////////////////////////////////////////////////////////+//+AAAAAAAAAA////////////////////////////////////////////////////////////t9AAAAAAAAAA//////////////////////////////////////////////////////7///////AAAAAAAAAA7///////////////////////////////////////////////////////7/////AAAAAAAAAAB///////////////////////////////////////////////9////////3////AAAAAAAAAAB////////////////////////////////////////////////////////////9AAAAAAAAAAD//////////////////////////////////////////////////////f/////vAAAAAAAAAAH/////////////////////////////////////////////////3///////9///AAAAAAAAAAf/////////////////////////////////////////////////////////////AAAAAAAAAA///////////////////////////////////////////////////////////9/7AAAAAAAAAA///////////////////////////////////////////////////3/////////+AAAAAAAAAA////////////////////////////////////////////////////f////////+AAAAAAAAAA//////////////////////////////////////////////////////////////AAAAAAAAAA///////////////////////////////////////////////////////////+//AAAAAAAAAA/////////////////////////////////////////////////////////////7AAAAAAAAAD//////////////////////////////////////////////////////////////AAAAAAAAAH//////////////////////////////////////////////////////////////AAAAAAAAAH/////////////////////////////////////////////////////////////xAAAAAAAAAP/////////////////////////////////////////////////////////////xAAAAAAAAP//////////////////////////////////////////////////////////////xAAAAAAAAf///////////////////////////////////////////////////////////////AAAAAAAAf///////////////////////////////////////////////////////////////AAAAAAAAf///////////////////////////////////////////////////////////////AAAAAAAAf//////////////////////////////////////////////////////////////eAAAAAAAAf//////////////////////////////////////////////////////////////GAAAAAAAAf//////////////////////////////////////////////////////////////CAAAAAAAA///////////////////////////////////////////////////////////////AAAAAAAAB///////////////////////////////////////////////////////////////gAAAAAAAH///////////////////////////////////////////////////////////////kAAAAAAAH///ur//////////////////////////////////////////////////////////8AAAAAAAH//+AB//////////////////////////////////////////////////////////8AAAAAAAH//8AD//////////////////////////////////////////////////////////8AAAAAAAH//8AD//////////////////////////////////////////////////////////+AAAAAAAH//4ADv//////////////////////////////////////////////////////////AAAAAAAD//gAAH//////////////////////////////////////////////////////////AAAAAAAAD/AAAP/////////////////////////////////////////////////////////+AAAAAAAAD/AAAP/////v///////////////////////////////////////////////////+AAAAAAAAB+AAAD/////m/8/////////////////////H///////////////////////////+AAAAAAAAAAAAAD////+Af4f///////////////////+H////////////////////////////AAAAAAAAAAAAAP////8A/w////////////////////8P////////////////////////////AAAAAAAAAAAAAO////4A/w///////////////////+AP////////////////////////////AAAAAAAAAAAAAOan//4A6gf//////////////////8AD////////////////////////////AAAAAAAAAAAAAAAH//8AAAP//////////////////8AH////////////////////////////AAAAAAAAAAAAAAAP//8AAA///////////////////4AP////////////////////////////AAAAAAAAAAAAAAAP//8AAA/////////////v/////4AP////////////////////////////AAAAAAAAAAAAAAAO//4AAA7//+r/7//////mr////wAO///q/+/////////////////////+AAAAAAAAAAAAAAAAf/gAAAB//4B/h/////+AB////gAAf/+Af4f////////////////////+AAAAAAAAAAAAAAAA//AAAAD//wD/D/////8AB//z/AAA//8A/w/////////////////////+AAAAAAAAAAAAAAAA7/AAAAD//wDvDv////8AD//zbAAA//8A7w7////////////////////+AAAAAAAAAAAAAAAA5qAAAAH//gDmDmp//+oAH//jaAAB//4A5g5q///////////////////+AAAAAAAAAAAAAAAAAAAAAAf/+AAAAAB//4AAf8+AYAAH//gAAAAAf//////////////////+AAAAAAAAAAAAAAAAAAAAAA//8AAAAAD//wAA/4cAYAAP//AAAAAA////////////3//////8AAAAAAAAAAAAAAAAAAAAAA//8AAAAAD//gAA748AYAAP//AAAAAA////////////zf////8AAAAAAAAAAAAAAAAAAAAAAB//4AAAAADv/gAA5w8AYAAf/+AAAAAA7///////////AP////4AAAAAAAAAAAAAAAAAAAAAAH/4AAAAAAAH/wAAAAYAYAB/+AAAAAAAB//////////+Af////4AAAAAAAAAAAAAAAAAAAAAAP/wAAAAAAAP/wAAAAAAYAD/8AAAAAAAD//////////+Af////wAAAAAAAAAAAAAAAAAAAAAAP/wAAAAAAAP/wAAAAACaAD/8AAAAAAAD////V///9/8Ad///+AAAAAAAAAAAAAAAAAAAAAAAOv4AAAAAAAH/gAAAAAHbABr/AAAAAAAA///8A///w/wAA///8AAAAAAAAAAAAAAAAAAAAAAAAH8AAAAAAAD+AAAAAAH/AAB/gAAAAAAB///4B///h2gAB///8AAAAAAAAAAAAAAAAAAAAAAAAD+AAAAAAAP8AAAAAAP/AAB/gAAAAAAD///4B///h2gAB3//4AAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAf8AAAAAD//AAA/AAAAAAAH///wB1f/B2AABzV/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf8AAAHgH//AAAAAAAAAAAH//wAAAP8AGAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf+AAAPwH//AAAAAAAAAAAH//gAAAf4AGAAAAB/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAPwP//wAAAAAAAAAAD//gAAAd4AGAAAAB/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAf////4AAAAAAAAAAD//AAAAcwAGAAAAB/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOoAAf/////4AAAAAAAAAAD/8AAAAAAAGAAAAAPAAA"), c => c.charCodeAt(0));
  return !!(orenGateBits[dy * 54 + (dx >> 3)] & (128 >> (dx & 7)));
}
function orenGateClosed(x, y) {
  const g = window.__orenGate;
  return !!(g && g.enabled && !g.allowed && orenGateContains(st.mapId, x, y));
}

function passable(x, y, h) {
  // 傳點(洞窟入口等):旁邊能站的格子都可以踏進去(入口常卡在牆和單向格中間;伺服器不檢查玩家走法)
  // 先於開放區域判斷:洞口那格本身不能站、可能不在遮罩裡,開不開放交給伺服器(開放範圍會補上傳點格)
  const tx = x + DX[h], ty = y + DY[h];
  if (orenGateClosed(tx, ty)) return false;
  if (portalSet().has(tx * 65536 + ty)) return (tile(x, y) & 3) !== 0;
  if (isClosedArea(tx, ty)) return false; // 未開放區域:走不進去(伺服器也會擋)
  if (!(h & 1)) return passable1(x, y, h);
  const hx = DX[h] > 0 ? 2 : 6;
  const hy = DY[h] > 0 ? 4 : 0;
  return passable1(x, y, h) && ((passable1(x, y, hx) && passable1(x + DX[h], y, hy)) || (passable1(x, y, hy) && passable1(x, y + DY[h], hx)));
}

// 傳點座標的 Set(每次換地圖 st.portals 換一個新陣列時重建;尋路每一步都要查,不能每次掃整個陣列)
let portalCache = { src: null, set: new Set() };
function portalSet() {
  if (portalCache.src !== st.portals) portalCache = { src: st.portals, set: new Set((st.portals || []).map(([px, py]) => px * 65536 + py)) };
  return portalCache.set;
}

// 對照 L1V1Map.isPassable(x, y, heading)
function passable1(x, y, h) {
  const t1 = tile(x, y);
  const t2 = tile(x + DX[h], y + DY[h]);
  if (!(t2 & 3)) return false;
  switch (h) {
    case 0: return (t1 & 2) !== 0;
    case 1: return (tile(x, y - 1) & 1) !== 0 || (tile(x + 1, y) & 2) !== 0;
    case 2: return (t1 & 1) !== 0;
    case 3: return (tile(x, y + 1) & 1) !== 0;
    case 4: return (t2 & 2) !== 0;
    case 5: return (t2 & 3) !== 0;
    case 6: return (t2 & 1) !== 0;
    case 7: return (tile(x - 1, y) & 2) !== 0;
  }
  return false;
}

// A*(8 方向);goalAdjacent=true 時走到目標旁邊即可
// 每步時間相同,步數一樣的路線很多;每轉一次方向加一點成本,才不會走成之字形、一路左右扭
const TURN_COST = 0.01;
function findPath(sx, sy, tx, ty, goalAdjacent, patrolBounds = null) {
  const key = (x, y) => x * 65536 + y;
  // goalAdjacent:true = 目標旁邊一格;數字 n(2 以上)= 離目標 n 格內、而且中間沒擋(近戰擠不進去時退一步停在 2 格內出手)
  const gr = goalAdjacent === true ? 1 : goalAdjacent | 0;
  const isGoal = (x, y) => (gr ? Math.max(Math.abs(x - tx), Math.abs(y - ty)) <= gr && (gr <= 1 || clearLine(x, y, tx, ty)) : x === tx && y === ty);
  if (isGoal(sx, sy)) return [];
  const hfn = (x, y) => Math.max(0, Math.max(Math.abs(x - tx), Math.abs(y - ty)) - gr);
  const open = [{ x: sx, y: sy, g: 0, f: hfn(sx, sy), h: -1 }];
  const came = new Map();
  const gScore = new Map([[key(sx, sy), 0]]);
  // 有人站的格子先收成一個 Set(以前每一步的 8 個方向都掃一次全部物件,怪越多越慢)
  const occ = new Set();
  const passPc = passThroughPc();
  for (const o of st.objects.values()) {
    if (o.kind === 'door' && o.status !== 29) continue; // 門只有關著才擋路(同 occupied())
    if (o.id !== st.selfId && o.kind !== 'item' && !isDollObj(o) && !o.dead && !(passPc && o.kind === 'pc') && !isHiddenPet(o)) occ.add(key(o.x, o.y));
  }
  // 傳點格(樓梯、洞口):只有它本身就是終點(點傳點走進去)才能踏上去;其他路徑不能經過,
  // 不然 AUTO 追怪 / 走回巡邏中心時會踩到傳點被傳出地監(使用者 10/16)
  const portals = portalSet();
  const portalOk = (x, y) => !goalAdjacent && x === tx && y === ty;
  let iter = 0;
  while (open.length && iter++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (isGoal(cur.x, cur.y)) {
      const out = [];
      let k = key(cur.x, cur.y);
      while (came.has(k)) { const p = came.get(k); out.unshift(k); k = p; }
      return out.map((k2) => ({ x: Math.floor(k2 / 65536), y: k2 % 65536 }));
    }
    for (let h = 0; h < 8; h++) {
      const nx = cur.x + DX[h];
      const ny = cur.y + DY[h];
      if (patrolBounds && !autoPatrolStep(patrolBounds, cur.x, cur.y, nx, ny)) continue;
      if (!passable(cur.x, cur.y, h)) continue;
      const nk = key(nx, ny);
      if (portals.has(nk) && !portalOk(nx, ny)) continue;
      if (occ.has(nk) && !(nx === tx && ny === ty && !goalAdjacent)) continue;
      const g = cur.g + 1 + (cur.h >= 0 && h !== cur.h ? TURN_COST : 0);
      if (g >= (gScore.get(nk) ?? Infinity)) continue;
      gScore.set(nk, g);
      came.set(nk, key(cur.x, cur.y));
      open.push({ x: nx, y: ny, g, f: g + hfn(nx, ny), h });
    }
  }
  return null;
}

// ---------------- 物件 ----------------
// 鑽在土裡的怪(打不到,要有人走到旁邊才出來):史巴托 / 曼陀羅草狀態 11;石頭高崙出生時 1/3 機率沉在地下,狀態 4(妖精遠遠射會一直空射)
const sunkStatus = (status, name) => status === 11 || (status === 4 && /石頭高崙/.test(name || ''));
// 玩家角色名和 npc 表同名(ops 10/22:死亡騎士、黑暗精靊、賽尼斯、哥布林、怪手、安塔瑞斯、蘇菲亞、歐若拉、愛麗絲、阿霖):gateway 名稱退回查表會把玩家標成 monster / npc,
// 別人的 AUTO 就把他當怪打。玩家封包 exp 固定寫 1、外型是職業原型(怪物 / NPC 不會長這樣)→ 改回 pc。清單先放這裡,10/23 起由 gateway 修正(根治)。
const PC_NAME_CLASH = new Set(['哥布林', '安塔瑞斯', '怪手', '愛麗絲', '木頭人', '歐若拉', '死亡騎士', '法利昂', '法利昂的信奉者', '蘇菲亞', '蝴蝶', '賽尼斯', '阿霖', '黑暗精靈']);
const PC_CLASS_GFX = new Set(CLASS_GFX.flat());
function upsertObject(ev) {
  if ((ev.kind === 'monster' || ev.kind === 'npc') && ev.exp === 1 && PC_NAME_CLASH.has(ev.name) && PC_CLASS_GFX.has(ev.gfx)) ev = { ...ev, kind: 'pc' };
  if (ev.id === silentHit.id) silentHit.n = 0; // 伺服器重送了:不是殘影
  const prev = st.objects.get(ev.id);
  const restoreEmblem = ev.pcFlag && ev.clan && prev?.clan === '';
  const o = Object.assign(prev || {}, ev, { px: ev.x, py: ev.y, anim: null, skin: prev?.skin || 0 });
  // 空血盟不畫盟徽;離開匿名場恢復血盟時解除匿名更新的 noEmblem。
  // 同血盟重送不能清除真正刪盟徽的標記。
  if (restoreEmblem) o.noEmblem = false;
  o.dead = ev.kind !== 'item' && ev.status === 8;
  if (st.clickSelect && o.dead && (st.picked?.id === o.id || o.id === st.selfId)) clearPicked();
  if (ev.kind === 'pc' && !o.dead) o.weapon = ev.status;
  // 出生就鑽在土裡的怪(史巴托、曼陀羅草,伺服器 initHide;status 11):人走到 2 格內才出來,在那之前伺服器不理攻擊(遠程會一直打空氣)
  if (ev.kind === 'monster') o.buried = sunkStatus(ev.status, ev.name);
  if (o.hpRatio === undefined) o.hpRatio = -1;
  if (ev.hpPct != null) o.hpRatio = ev.hpPct; // 自己的寵物:封包帶血量百分比
  st.objects.set(ev.id, o);
  if (ev.id === st.selfId || (!st.selfId && ev.name === st.myName)) {
    st.selfId = ev.id;
    o.kind = 'pc'; // 自己一定是玩家(角色名和怪物同名時 gateway 可能標成 monster)
    st.path = [];
    st.cam.x = ev.x; st.cam.y = ev.y;
  }
}

// 動作間隔(毫秒),對照伺服器 AcceleratorChecker
const HASTE_RATE = 0.75;
const WAFFLE_RATE = 0.87;
const SPELL_SLOW = 1; // 原本 1.4(對照錄影放慢);使用者要求先恢復原速
const TALK_REACH = 3; // 和 NPC 對話的距離:伺服器 C_NPCTalk / C_NPCAction 允許 5 格,但客戶端位置可能比伺服器多走一兩格(站在剛好 5 格時按鈕會被伺服器默默忽略),留餘裕
function actionMs(o, type) {
  const weapon = o.kind === 'pc' ? o.weapon || 0 : 0;
  const table = st.speeds?.[o.gfx];
  // 施法(18 有向 / 19 無向)照速度表 × SPELL_SLOW;使用者 2026-10-10:加速 / 勇水也會讓施法變快(和伺服器 AcceleratorChecker 一樣)
  let ms = type === 'spell18' || type === 'spell19' ? (table?.[type === 'spell18' ? 18 : 19] ?? table?.[19] ?? 1200) * SPELL_SLOW
    : type === 'walk'
    ? table?.[weapon] ?? table?.[0] ?? WALK_MS
    : table?.[weapon === 0 ? 1 : weapon + 1] ?? table?.[1] ?? ATTACK_MS;
  if (st.shana && o.id === st.selfId) { // 夏娜的變形卷軸:Lv45 參考表(每分鐘幾下),和伺服器 L1Shana 同一份;空手照原本
    const n = type === 'spell18' ? 75 : type === 'spell19' ? 68 : type === 'attack' ? SHANA_PER_MIN[weapon] : 0;
    if (n) ms = Math.round(60000 / n);
  }
  if (o.speed === 1) ms *= HASTE_RATE; // 加速術 / 綠水
  else if (o.speed === 2) ms /= HASTE_RATE; // 緩速術
  switch (o.brave) {
    case 1: ms *= HASTE_RATE; break; // 勇水
    case 3: ms *= type === 'walk' ? (st.waffleMoveRate || WAFFLE_RATE) : weapon === 20 ? WAFFLE_RATE : (st.waffleAttackRate || WAFFLE_RATE); break; // 精餅:走路 / 攻擊都照伺服器設定(config.json);拿弓、十字弓(武器動作 20)攻擊 / 施法維持 0.87(伺服器 AcceleratorChecker 同一條件)
    case 4: if (type === 'walk') ms *= HASTE_RATE; break; // 神疾、風走
    case 5: ms *= 0.375; break; // 超級加速
    case 6: if (type === 'attack') ms *= HASTE_RATE; break; // 血之渴望
    default: break;
  }
  if (o.third) ms *= THIRD_RATE; // 三段加速
  if (type === 'attack' && o.id === st.selfId && st.atkRate) ms *= st.atkRate; // 自己的攻擊間隔倍率(伺服器 S_WebAtkRate)
  if (type === 'attack' && o.id === st.selfId && performance.now() < (st.slowUntil || 0)) ms *= st.slowRate; // 伺服器連續不回應攻擊後暫時放慢(noteSilentGiveup)
  return ms;
}
const THIRD_RATE = 0.87;
const FADE_MS = 150; // 擋住人物的地圖物件變淡 / 恢復的時間
const FADE_ALPHA = 0.35; // 變淡後的透明度
st.fades = new Map(); // 物件 -> 目前透明度(< 1 的才記)
// draw() 每格畫面重複使用的陣列(森林一畫面上千個物件,不要每格都配置新的)
const LAY = [], LAYK = [], LAY_CR = [], LAY_BEHIND = [], LAY_KEPT = [];
let LAY_N = 0; // 上一格 LAY 用到的長度
let fadeFrame = 0; // 畫面編號:地圖物件 fon 等於它就是這一格要變淡
const AUTO_SPELL_GAP = 1000; // 自動魔法攻擊每次之間多等的毫秒(使用者 2026-10-10)
// 夏娜的變形卷軸攻擊速度(每分鐘):近戰特化,弓 / 鋼鐵手套用遠攻特化
const SHANA_PER_MIN = { 4: 84, 11: 75, 20: 68, 24: 80, 40: 84, 46: 90, 50: 75, 54: 84, 58: 84, 62: 68 };

function moveObject(ev) {
  if (ev.id === silentHit.id) silentHit.n = 0; // 有在動:不是殘影
  const o = st.objects.get(ev.id);
  if (!o) return;
  // 11/05 使用者「還是 lag,不能跟網頁一樣順嗎」:統一 AUTO 由伺服器走路時,自己的步伐先排隊、一步完整播完才接下一步(不從半路重來),
  // 播放速度跟著伺服器實際步伐(排隊 ≥1 步稍快、沒排隊稍慢,隊伍維持約 1 步吸收網路誤差);落後超過 3 步就直接跳到最新位置。
  if (ev.id === st.selfId && typeof unifiedControl !== 'undefined' && unifiedControl.phase === 'owner' && auto.on && !catchUp.on) {
    const now = performance.now(), base = actionMs(o, 'walk'), gap = now - (st.selfMoveAt || 0);
    st.selfMoveAt = now;
    if (gap >= base * 0.8 && gap < base * 1.3) st.selfWalkMs = st.selfWalkMs ? st.selfWalkMs * 0.7 + gap * 0.3 : gap;
    const q = (o.stepQ ||= []);
    q.push({ x: ev.x, y: ev.y, heading: ev.heading });
    if (q.length > 3) { const last = q[q.length - 1]; q.length = 0; o.anim = null; o.x = last.x; o.y = last.y; o.heading = last.heading; o.px = o.x; o.py = o.y; return; }
    if (!o.anim) startSelfStep(o, now);
    return;
  }
  if (o.stepQ) o.stepQ.length = 0; // 不走排隊播放時,殘留的佇列丟掉(避免之後被拉回舊格)
  o.anim = { fx: o.px, fy: o.py, start: performance.now(), dur: actionMs(o, 'walk') };
  o.lunge = 0; // 開始走路就中斷攻擊動作,不然會邊走邊揮
  o.x = ev.x; o.y = ev.y; o.heading = ev.heading;
  if (catchUp.on) o.anim = null; // 補送中:直接站到最後的位置
}

function self() { return st.objects.get(st.selfId); }
// 11/05:自己排隊的下一步(統一 AUTO owner);from = 上一步結束的時間點,接得無縫
function startSelfStep(o, from) {
  const s = o.stepQ && o.stepQ.shift();
  if (!s) return false;
  const base = actionMs(o, 'walk');
  const cadence = Math.min(base * 1.3, Math.max(base, st.selfWalkMs || base));
  o.anim = { fx: o.px, fy: o.py, start: from, dur: o.stepQ.length >= 1 ? cadence * 0.93 : cadence * 1.04 };
  o.lunge = 0;
  o.x = s.x; o.y = s.y; o.heading = s.heading;
  return true;
}

// ---- 特效 ----
// { gfx, follow(物件 id)或 x / y, start, 飛行的另外有 from / to / dur };畫在人物上面(draw 裡)
st.effects = [];
function addEffect(e) {
 if (RoyalFX.active(e.gfx)) {
  const o=e.follow != null ? st.objects.get(e.follow) : null;
  e={...e,royalFollow:e.follow,royalVariant:RoyalFX.variant(),...(o ? {x:o.px,y:o.py} : {}),follow:null,map:st.mapId};
 }
 st.effects.push({start:performance.now(),...e});
}
// 10/31 使用者「隱藏其他玩家的特效和傷害數字 但是不讓玩家可以選 … 被打也不要寫」(活動人多手機畫太多會卡):
// 傷害數字只顯示自己打出去的(含 MISS;被打、別人 / 寵物打的都不顯示);其他玩家的技能 / 箭 / 魔法特效不畫(怪物、BOSS、自己的照畫)
// 11/02 #45:使用者「只要隱藏傷害數字,其他不用隱藏」:傷害數字照舊只顯示自己打出去的;其他玩家的特效 / 箭 / 魔法飛行恢復顯示
const MINE_ONLY = true; // 傷害數字
const MINE_ONLY_FX = false; // 其他玩家的特效(false = 顯示)
const MAX_OTHER_FX = 6; // 同時播放中、跟著其他玩家的特效上限(10/31 隱藏的原因是活動人多手機會卡;超過的新特效先不畫)
const otherFxFull = () => { let n = 0; for (const e of st.effects) if ((e.follow ?? e.royalFollow) != null && otherPc(e.follow ?? e.royalFollow) && ++n >= MAX_OTHER_FX) return true; return false; };
const otherPc = (id) => { if (id == null || id === st.selfId) return false; const o = st.objects.get(id); return !!o && o.kind === 'pc'; };
const TELEPORT_FX = new Set([169, 2235, 2236, 2281]); // 瞬間移動特效(伺服器 L1Teleport.EFFECT_SPR)
// 延遲 ms 後執行(0 就馬上)
function later(ms, fn) { if (ms > 0) setTimeout(fn, ms); else fn(); }
// 出手時間:攻擊 / 施法動作播到 list.spr 標 ! 的那一幀(手往前推、箭離弦)還要多久
function hitDelay(o, now = performance.now()) {
  if (!o || !o.lunge || now - o.lunge >= (o.lungeMs || 0)) return 0;
  return Math.max(0, o.lunge + L1S.hitFrac(o) * o.lungeMs - now);
}
const casting = (o, now) => o && (o.lungeAct === 18 || o.lungeAct === 19) && o.lunge && now - o.lunge < (o.lungeMs || 0);
// 沒有標施法者的特效(對自己 / 地面):目標自己在施法就等它出手,不然看自己是不是正在施法
function castDelay(o) {
  const now = performance.now();
  const c = casting(o, now) ? o : casting(self(), now) ? self() : null;
  return c ? hitDelay(c, now) : 0;
}
// 還有箭 / 魔法在飛向它:受傷數字、血條、死亡都等打到才顯示
function impactWait(o) { return Math.max(0, (o.hitAt || 0) - performance.now()); }
// 飛行特效(光箭、箭…):從施放者飛到目標,約每格 100ms;到了接著播命中特效
// 特效種類(list.spr 第 0 個動作):fly = 從施法者飛到目標;8 方向的 lightning(極光雷電)= 從施法者朝目標射出;其他 = 出現在目標身上
// 沒有資料的(箭等)照舊當飛行
const effectKind = (gfx) => RoyalFX.active(gfx) ? ['fire', 0] : st.game.effectKinds?.[gfx] || ['fly', 1];
const headingTo = (sx, sy, tx, ty) => { const h = DX.findIndex((dx, i) => dx === Math.sign(tx - sx) && DY[i] === Math.sign(ty - sy)); return h < 0 ? 5 : h; };
// 遠距離攻擊的特效:依種類決定怎麼畫;回傳飛行時間(打中要再等多久)
function spellFx(gfx, from, to, targetId, casterId) {
  const [kind, dirs] = effectKind(gfx);
  if (kind === 'fly') { addMissile(gfx, from.x, from.y, to.x, to.y); return; }
  const heading = dirs ? headingTo(from.x, from.y, to.x, to.y) : 5;
  if (kind === 'lightning' && dirs) addEffect({ gfx, follow: casterId, x: from.x, y: from.y, heading });
  else addEffect({ gfx, follow: targetId, x: to.x, y: to.y, heading });
}
// 打中要再等多久:飛行類 = 飛行時間;其他 = 特效播到 list.spr 標 ! 的那一格(例:究極光裂術的光矛落地)
const flyMs = (gfx, from, to) => {
  if (effectKind(gfx)[0] === 'fly') return Math.max(300, Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 100);
  const info = L1S.effectInfo(gfx);
  return info ? Math.min(info.hit || 0, 2500) : 0;
};
function addMissile(gfx, sx, sy, tx, ty) {
  const dist = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));
  const h = DX.findIndex((dx, i) => dx === Math.sign(tx - sx) && DY[i] === Math.sign(ty - sy));
  addEffect({ gfx, from: { x: sx, y: sy }, to: { x: tx, y: ty }, dur: Math.max(300, dist * 100), heading: h < 0 ? 5 : h, missile: true });
}
function onRangeSkill(ev) {
  const caster = st.objects.get(ev.caster);
  if (caster && ev.caster !== st.selfId) { caster.lunge = performance.now(); caster.lungeMs = actionMs(caster, ev.action === 18 ? 'spell18' : 'spell19'); caster.lungeAct = ev.action; caster.heading = ev.heading; }
  const wait = hitDelay(caster);
  const from = { x: ev.x, y: ev.y };
  const main = st.objects.get(ev.targets[0]);
  const [kind] = effectKind(ev.gfx);
  // 種類 8(有目標的範圍魔法,例:燃燒的火球):飛行類飛到主目標、在那裡爆炸;其他出現在每個目標身上
  // 種類 0(以自己為中心,例:龍捲風、冰雪暴):出現在施法者身上
  const fly = kind === 'fly' ? (ev.kind !== 0 && main ? flyMs(ev.gfx, from, main) : 0) : flyMs(ev.gfx, from, from);
  for (const id of ev.targets) { const t = st.objects.get(id); if (t) t.hitAt = Math.max(t.hitAt || 0, performance.now() + wait + fly); }
  if (MINE_ONLY_FX && otherPc(ev.caster)) return; // 其他玩家的範圍魔法:施法動作照播,特效不畫
  later(wait, () => {
    if (ev.kind === 0 || !ev.targets.length) addEffect({ gfx: ev.gfx, follow: ev.caster, x: ev.x, y: ev.y });
    else if (kind === 'fly') {
      if (main) spellFx(ev.gfx, from, { x: main.x, y: main.y }, main.id, ev.caster);
      // 範圍內其他被打中的目標:火球到達主目標時,在它們身上也播命中爆炸(主目標的爆炸由飛行特效自己接)
      const impact = L1S.effectInfo(ev.gfx)?.impact;
      if (impact && ev.targets.length > 1) {
        later(fly, () => {
          for (const id of ev.targets.slice(1)) { const t = st.objects.get(id); if (t) addEffect({ gfx: impact, follow: id, x: t.x, y: t.y }); }
        });
      }
    }
    else for (const id of ev.targets) { const t = st.objects.get(id); if (t) spellFx(ev.gfx, from, { x: t.x, y: t.y }, id, ev.caster); }
  });
}
// 每一幀畫特效,播完的移除
// 已學會魔法的特效圖先載好(第一次放時才知道命中格的時間、不會晚一拍才出現)
setInterval(() => {
  if (!st.inGame || !st.game.skills) return;
  for (const id of st.skills) {
    const g = st.game.skills[id]?.gfx;
    const info = g && L1S.effectInfo(g);
    if (info?.impact) L1S.effectInfo(info.impact);
  }
}, 3000);
function drawEffects(now) {
  const impacts = []; // 飛行特效到達後接著播的(不能在 filter 裡直接 push,會被 filter 的結果蓋掉)
  st.effects = st.effects.filter((e) => {
    const info = L1S.effectInfo(e.gfx);
    if (info === false) return false; // 沒有這個特效的圖
    const t = now - e.start;
    if (info === null) return t < 3000; // 還在載入
    let x;
    let y;
    if (e.missile) {
      const k = Math.min(1, t / e.dur);
      if (k >= 1) {
        if (info.impact) impacts.push({ start: now, gfx: info.impact, x: e.to.x, y: e.to.y });
        return false;
      }
      x = e.from.x + (e.to.x - e.from.x) * k;
      y = e.from.y + (e.to.y - e.from.y) * k;
    } else {
      if (t > info.dur) return false;
      if (e.map != null && e.map !== st.mapId) return false; // 換地圖了:原地圖的特效不畫
      const o = e.follow != null ? st.objects.get(e.follow) : null;
      x = o ? o.px : e.x;
      y = o ? o.py : e.y;
      if (x == null) return false;
    }
    const p = toScreen(x, y);
    L1S.drawEffect(ctx, e.gfx, p.x, p.y, t, e.heading ?? 5, !!e.missile, e);
    return true;
  });
  st.effects.push(...impacts);
}

// AUTO 殘影保險(10/18 騎洞 4F):普攻送出去伺服器一定會回一個自己的攻擊封包(打中 / 沒打中 / 打空氣都會);
// 怪其實離 20 格以上或已經不在這張地圖時伺服器什麼都不回。連續 SILENT_HIT_GIVEUP 下沒回、這隻也沒任何動靜(移動 / 出手 / 重送)
// 就當成殘影跳過 15 秒(不從畫面拿掉:遁地的怪伺服器也不回,拿掉的話牠鑽出來會看不到)
const SILENT_HIT_GIVEUP = 5;
const silentHit = { id: 0, n: 0 };
const silentGiveups = [];
// 診斷用環形紀錄(只記資料):最近的普通攻擊送出、伺服器回自己攻擊的時間、伺服器系統訊息編號
const diagRing = (key, item, max) => { const a = (st[key] ||= []); a.push(item); if (a.length > max) a.shift(); };
function noteAttackSent(tgt) { const now = performance.now(); const last = (st.atkLog || [])[(st.atkLog || []).length - 1]; diagRing('atkLog', { t: now, dt: last ? Math.round(now - last.t) : 0, id: tgt.id }, 12); }
function noteSilentGiveup(now, me, tgt) {
  silentGiveups.push(now);
  while (silentGiveups.length && now - silentGiveups[0] > 40000) silentGiveups.shift();
  const diag = `speed=${me.speed} brave=${me.brave} third=${me.third ? 1 : 0} weapon=${me.weapon} atkRate=${st.atkRate ?? 1} intervalMs=${Math.round(actionMs(me, 'attack'))} slow=${now < (st.slowUntil || 0) ? st.slowRate : 1} gfx=${me.gfx} weight=${st.me?.weight ?? '?'} para=${st.para ? 1 : 0} hp=${st.me?.hp ?? '?'} baseMs=${Math.round(actionMs(me, 'attack') / (now < (st.slowUntil || 0) ? st.slowRate : 1))}`; // baseMs = 放慢前的出手間隔(伺服器要求下限約 0.8 × 它算的 right);gfx = 自己目前的外型(變身後的)
  const detail = `${diag} 目標=${tgt ? `${tgt.name}#${tgt.id}(gfx ${tgt.gfx}、${tgt.kind}、impl ${tgt.impl || '-'}、狀態 ${tgt.status ?? '-'}${tgt.buried ? '、鑽地' : ''})距離=${Math.max(Math.abs(tgt.x - me.x), Math.abs(tgt.y - me.y))}` : '?'} 地圖=${st.mapId}`;
  console.warn(`[silent-hit] 第 ${silentGiveups.length} 次放棄目標 ${detail}`);
  const sl = (st.silentLog ||= []); sl.push(`${new Date().toLocaleTimeString()} 第 ${silentGiveups.length} 次放棄 ${detail}`); if (sl.length > 20) sl.shift(); // 效能診斷文字用
  if (silentGiveups.length < 3) return;
  silentGiveups.length = 0;
  st.slowRate = Math.min(1.6, (now < (st.slowUntil || 0) ? st.slowRate : 1) + 0.25);
  st.slowUntil = now + 60000;
  sl.push(`${new Date().toLocaleTimeString()} 放慢出手速度 ×${st.slowRate} 一分鐘`);
  log(`AUTO:有幾下攻擊伺服器沒有接受,先把出手速度放慢約 ${Math.round((st.slowRate - 1) * 100)}% 一分鐘;若一直這樣,請到「設定 → 效能診斷」按「診斷」複製資料給管理員。`, 'sys');
}

// 三重矢:伺服器一次送來同一個攻擊者連續好幾下弓箭攻擊。先收集 40ms 內的,再依序播:
// 拉弓動作加速成 1/n,一下接一下射出(單發弓箭只多 40ms)
const arrowBursts = new Map();
function noteAttackReceived(ev) {
  if (ev.attacker === st.selfId) diagRing('ackLog', performance.now(), 8); // 診斷:伺服器回了自己的攻擊封包
  if (ev.attacker === st.selfId || ev.attacker === silentHit.id || ev.target === silentHit.id) silentHit.n = 0; // 伺服器有回 / 這隻有動靜
}

// 暴擊標記在攻擊事件到達時就綁在事件上(伺服器 S_WebCrit 緊接在那一下攻擊前面送)。11/06:三重矢三箭會先收起來再依序播,
// 等播的時候才查 st.crits(每個目標只有一格)的話,第一箭用掉標記,第二、三箭的兩倍傷害會顯示成白字
function bindCrit(ev) {
  if (ev._crit !== undefined) return ev._crit;
  const critAt = ev.attacker === st.selfId && ev.dmg > 0 ? st.crits?.get(ev.target) : null;
  ev._crit = critAt != null && performance.now() - critAt < 2000;
  if (ev._crit) st.crits.delete(ev.target);
  return ev._crit;
}

function onAttack(ev) {
  bindCrit(ev);
  if (!ev.gfx || ev.action === 18 || ev.action === 19) { attackNow(ev); return; }
  let q = arrowBursts.get(ev.attacker);
  if (!q) {
    q = [];
    arrowBursts.set(ev.attacker, q);
    setTimeout(() => {
      arrowBursts.delete(ev.attacker);
      if (q.length === 1) { attackNow(q[0]); return; }
      const atk = st.objects.get(ev.attacker);
      const seg = atk ? actionMs(atk, 'attack') / q.length : 200;
      const local = ev.attacker === st.selfId && st.tripleLocal && performance.now() < st.tripleLocal.until; // 10/28:自己的三重矢送出時已在本機播 3 下拉弓(hud.js startCast)
      if (local) st.tripleLocal = null;
      else if (ev.attacker === st.selfId) st.nextAttackAt = Math.max(st.nextAttackAt || 0, performance.now() + q.length * seg); // 沒有本機預播(例如手動放的舊路徑):三箭播完才接普攻
      for (const tid of new Set(q.map((e) => e.target))) { // 最後一箭打到之前血條、死亡先不變
        const tgt = st.objects.get(tid);
        if (tgt) tgt.hitAt = Math.max(tgt.hitAt || 0, performance.now() + q.length * seg);
      }
      q.forEach((e, i) => { e._burstIdx = i; e._burstN = q.length; e._burst = q; }); // 11/06:連射數字錯開(attackNow 用)
      q.forEach((e, i) => later(i * seg, () => attackNow(e, seg, local)));
    }, 40);
  }
  q.push(ev);
}

// forceMs:三重矢的每一下(動作長度固定、一定重播)
function attackNow(ev, forceMs, noAnim = false) { // noAnim:自己的三重矢已在本機預播,只放箭 / 傷害
  if (ev.attacker === st.selfId || ev.target === st.selfId) st.lastCombat = performance.now(); // 戰鬥音樂(sound.js)
  const atk = st.objects.get(ev.attacker);
  const tgt = st.objects.get(ev.target);
  // AUTO 普攻同一隻怪連續 N 下沒傷害(懸崖下、牆後面打不到)就放棄,跳過 15 秒(altsettings AutoMissGiveUp;伺服器離線掛機同規則)
  if (st.autoMissGiveUp > 0 && ev.attacker === st.selfId && ev.action !== 18 && ev.action !== 19 && auto.on && st.target && st.target.mode === 'attack' && st.target.id === ev.target) {
    if (auto.missId !== ev.target) { auto.missId = ev.target; auto.missN = 0; }
    if (ev.dmg > 0) auto.missN = 0;
    else if (++auto.missN >= st.autoMissGiveUp) { auto.unreach.set(ev.target, performance.now() + 15000); st.target = null; st.path = []; auto.missN = 0; }
  }
  // 揮擊動畫拉長到實際攻擊間隔(和原版一樣,一次攻擊的動作就佔滿整個間隔)
  if (atk && forceMs) {
    if (!noAnim) { atk.lunge = performance.now(); atk.lungeMs = forceMs; atk.lungeAct = null; }
  } else if (atk) {
    const t = performance.now();
    // 自己的攻擊在送出時就開始播了,伺服器回應晚到時不要從頭重播
    // 11/04:只有網頁自己剛送出(已先播)才不重播;統一 AUTO 由伺服器出手,網頁沒先播,三重矢後的普攻原本會被這條吃掉動作
    if (!(ev.attacker === st.selfId && atk.lunge && t - atk.lunge < 400 && t - (st.attackSentAt || 0) < 1500)) {
      const spell = ev.action === 18 || ev.action === 19; // 攻擊魔法:播施法動作、照施法速度
      atk.lunge = t; atk.lungeMs = actionMs(atk, spell ? `spell${ev.action}` : 'attack'); atk.lungeAct = spell ? ev.action : null;
    }
    atk.heading = ev.heading;
  }
  // 動作播到出手幀才射出 / 打中;遠距離再加上飛行時間。打到之前目標的血條、死亡都先不變
  const wait = hitDelay(atk);
  let fly = 0;
  const from = atk ? { x: atk.x, y: atk.y } : { x: ev.sx, y: ev.sy };
  const to = tgt ? { x: tgt.x, y: tgt.y } : { x: ev.tx, y: ev.ty };
  if (ev.gfx) fly = flyMs(ev.gfx, from, to); // 飛行類才有飛行時間(和 addMissile 一樣)
  if (tgt) tgt.hitAt = Math.max(tgt.hitAt || 0, performance.now() + wait + fly);
  if (ev.gfx && !(MINE_ONLY_FX && otherPc(ev.attacker))) later(wait, () => spellFx(ev.gfx, from, to, ev.target, ev.attacker)); // 遠距離:箭 / 攻擊魔法的特效(其他玩家的不畫)
  // 打中:受傷動作(硬直);同一個目標上一次硬直結束 400ms 內不再觸發,被圍毆時才有空檔可以動
  if (tgt && tgt.kind !== 'item' && ev.dmg > 0) {
    later(wait + fly, () => {
      const t = performance.now();
      if (tgt.dead || tgt.dying || (tgt.hurt && t < tgt.hurt + (tgt.hurtMs || 0) + 400)) return;
      const ms = L1S.damageMs(tgt);
      if (ms) { tgt.hurt = t; tgt.hurtMs = ms; }
    });
  }
  // 11/09 使用者「把寵物傷害 自己看的到 打開」:自己的寵物 / 召喚獸打出去的傷害數字也顯示(別人的寵物照舊不顯示)
  const byMyPet = ev.attacker !== st.selfId && (() => { const a = st.objects.get(ev.attacker); return !!a && isMyPet(a); })();
  if (tgt && tgt.kind !== 'item' && (!MINE_ONLY || ev.attacker === st.selfId || byMyPet)) {
    // 暴擊(伺服器 S_WebCrit 先送來):自己打的、2 秒內同一個目標 → 紅色大字
    const crit = bindCrit(ev); // 到達時已綁定(見 bindCrit)
    // 11/06 使用者「三重矢錯開」:連射的箭左 / 中 / 右排開，同一輪只在第一個暴擊上寫 CRITICAL!
    const burst = ev._burstN > 1;
    const dx = burst ? (ev._burstIdx - (ev._burstN - 1) / 2) * (crit ? 50 : 30) : (Math.random() - 0.5) * 18;
    const noLabel = crit && burst && !!ev._burst._critLabel;
    if (crit && burst) ev._burst._critLabel = true;
    later(wait + fly, () => st.floaters.push({ x: tgt.x, y: tgt.y, text: ev.dmg > 0 ? String(ev.dmg) : 'MISS',
      kind: crit ? 'crit' : ev.dmg > 0 ? (ev.target === st.selfId ? 'hurt' : 'hit') : ev.target === st.selfId ? 'missme' : 'miss', dmg: ev.dmg,
      dx, noLabel, born: performance.now() }));
  }
}

function onAction(ev) {
  const o = st.objects.get(ev.id);
  if (!o) return;
  if (o.kind === 'door' && (ev.action === 28 || ev.action === 29)) { o.status = ev.action; o.statusAt = performance.now(); closedDoorCache.at = -Infinity; return; } // 門開 / 關
  // 受傷動作:由 onAttack 在打到的那一刻播(箭 / 魔法飛到才算),這裡不重複播,也不要當成攻擊動作
  if ([0, 4, 11, 20, 24, 40, 46, 50, 54, 58, 62, 83].some((b) => b + 2 === ev.action)) return; // 各武器的受傷動作 = 走路 + 2
  // 自己的攻擊 / 施法在送出時就開始播了,伺服器回應晚到時不要從頭重播
  // 10/29 使用者:伺服器補給放的魔法(心靈轉換 / 補血…)也要像自己放的一樣停一拍,不然邊揮刀邊放沒停頓感。
  // 自己的施法動作(18 / 19)而且不是網頁自己剛送出的那次(lungeAct 不同)→ 當成新的施法動作播,下一下攻擊往後推一個施法動作的時間(同 startCast)
  if ((ev.action === 18 || ev.action === 19) && ev.id === st.selfId && !(o.lungeAct === ev.action && o.lunge && performance.now() - o.lunge < 400)) {
    const now = performance.now();
    o.lunge = now; o.lungeMs = actionMs(o, `spell${ev.action}`); o.lungeAct = ev.action;
    st.nextAttackAt = Math.max(st.nextAttackAt || 0, now + o.lungeMs);
    return;
  }
  if (ev.action !== 8 && ev.id === st.selfId && o.lunge && performance.now() - o.lunge < 400) return;
  if (ev.action === 8) { // ACTION_Die
    if (st.clickSelect && (st.picked?.id === ev.id || ev.id === st.selfId)) clearPicked(); // 等死亡動畫前就取消選取及排隊魔法
    const wait = impactWait(o);
    if (wait > 0) { o.dying = true; setTimeout(() => onAction(ev), wait + 1); return; } // 箭 / 魔法還沒打到
    o.dying = false;
    o.dead = true;
    o.deadAt = performance.now();
    st.opened?.delete(o.id); // L1Spawn 重生沿用物件編號:死掉就不算「已經出過手」,重生後開怪技能照用
    if (ev.id === st.selfId) {
      $('#dead').classList.remove('hidden'); st.path = []; st.target = null;
      // 死亡時伺服器會解除變身(L1PcInstance.death 的相消術),但不會送變身圖示結束:自己清掉,不然自動變身以為還在變身中
      if (st.buffs.has('poly')) setBuff('poly', '變身', 0);
      // 死了就關掉自動狩獵:以前不關,按「重新開始」回城後 AUTO 自己繼續打(10/24)
      if (typeof auto !== 'undefined' && auto.on && typeof stopAuto === 'function') { stopAuto('角色死亡'); }
    }
    if (st.target && st.target.id === ev.id) st.target = null;
  } else { o.lunge = performance.now(); o.lungeMs = actionMs(o, 'attack'); o.lungeAct = ev.action; }
}

$('#btn-restart').onclick = () => { send({ t: 'restart' }); $('#dead').classList.add('hidden'); };

// ---------------- NPC 對話 / 商店 ----------------
// 原版對話文字在客戶端檔案裡;這裡用伺服器資料組出的功能按鈕(買賣、傳送)代替
const dlg = { npc: 0, mode: null, rows: [] };
const fmt = (n) => n.toLocaleString('zh-TW');

function showDialog(title, note) {
  dlg.sealcraft = false;
  $('#dlg-title').textContent = title;
  $('#dlg-note').textContent = note || '';
  $('#dlg-note').classList.toggle('hidden', !note);
  $('#dlg-body').innerHTML = '';
  $('#dlg-foot').classList.add('hidden');
  $('#dlg-foot').querySelectorAll('.bm-add').forEach((e) => e.remove()); // 記憶座標視窗的輸入列
  $('#dialog').classList.remove('shop', 'tp', 'mini');
  toggleInv(false);
  $('#dialog').classList.remove('hidden');
}
// 高寵契約證(伺服器 L1HighPet):綁定(第一次,選同帳號的法師隊友)、啟用(每次;要同隊、3 格內)
function openHighPet(ev) {
  if (ev.cfg) { // 設定面板「高寵」分頁的資料
    st.highPetCfg = ev.cfg;
    if (typeof panel !== 'undefined' && panel.name === 'settings' && panel.tab === 'highpet') renderPanel();
    return;
  }
  if (ev.close) { if (dlg.mode === 'highpet') closeDialog(); if (ev.msg) toast(ev.msg); return; }
  const act = (op, arg = '') => send({ t: 'highpet', cert: ev.cert, op, arg });
  const STATUS = { active: '啟用中:跟隨你並幫你補血', standby: '待命中(5 分鐘內到牠身邊重新啟用)', idle: '未啟用' };
  showDialog('高寵契約證', `${ev.remain ? ev.remain.replace(/^\[|\]$/g, '') : ''}${ev.msg ? `
${ev.msg}` : ''}`);
  dlg.mode = 'highpet';
  const body = $('#dlg-body');
  if (ev.pet) {
    body.appendChild(el('p', 'hint', `綁定的高寵:${ev.pet}(${ev.online ? '在線上' : '不在線上'})`));
    body.appendChild(el('p', 'hint', `狀態:${STATUS[ev.status] || ev.status}`));
    if (ev.status !== 'active') menuButton('啟用', '要同一隊、站在你身邊 3 格內', () => act(2));
    body.appendChild(el('p', 'hint', '啟用後可以關掉法師的網頁,由伺服器代管。高寵死亡會回村莊待命,5 分鐘內沒去重新啟用就會下線。'));
  } else {
    body.appendChild(el('p', 'hint', '選一隻同帳號、已經和你組隊的法師綁定(綁定後 7 天內不能換)。'));
    if (!ev.candidates?.length) body.appendChild(el('p', 'hint', '隊伍裡沒有可以綁定的法師。'));
    for (const name of ev.candidates || []) menuButton(`綁定 ${name}`, '要站在你身邊 3 格內', () => act(1, name));
  }
  if (ev.msg) toast(ev.msg);
}
// BOSS 獵場(伺服器 L1BossHunt):點管理員送來今天每一檔的 BOSS(3 選 1),每個帳號每天一次
function openBossHunt(ev) {
  if (ev.close) { if (dlg.mode === 'bosshunt') closeDialog(); return; }
  npcPageArrived(ev.npc); // 不要再開暫代的對話框
  const reset = `${String(ev.reset || 0).padStart(2, '0')}:00`;
  showDialog('BOSS 獵場', ev.used ? `這個帳號今天已經挑戰過了(${ev.used.char} · ${ev.used.boss}),${reset} 後重置。`
    : ev.daily === false ? `單人挑戰,限時 ${ev.limit} 分鐘。(測試中:不限次數)`
    : `每個帳號每天只能挑戰一次(${reset} 重置),進去就算次數。單人挑戰,限時 ${ev.limit} 分鐘。`);
  dlg.mode = 'bosshunt';
  dlg.npc = ev.npc;
  const body = $('#dlg-body');
  if (ev.msg) { body.appendChild(el('p', 'hint warn', ev.msg)); toast(ev.msg); }
  const lv = st.me?.level || 0;
  for (const t of ev.tiers || []) {
    body.appendChild(el('p', 'hint', t.min > 0 ? `${t.name}(${t.min} 級以上)${lv < t.min ? ' · 等級不足' : ''}` : t.name));
    for (const b of t.bosses) {
      const can = !ev.used && lv >= t.min;
      menuButton(b.name, `Lv${b.lvl} · HP ${fmt(b.hp)}`, () => {
        if (!can) { toast(ev.used ? '今天已經挑戰過了' : `${t.name}要 ${t.min} 級以上`); return; }
        send({ t: 'npcaction', id: ev.npc, action: `bhunt ${t.i} ${b.id}` });
      });
      if (!can) body.lastChild.classList.add('disabled');
    }
  }
}
// 地監記憶書:伺服器送來已開放的地監清單(目的地編號、名稱)、單價、免費傳送券張數;選一個就送出,成功就是直接傳送(沒有讀秒)
function openDungeonBook(ev) {
  const dests = Array.isArray(ev.dests) ? ev.dests : [];
  const tickets = Math.max(0, ev.tickets | 0), price = Math.max(0, ev.price | 0);
  const perm = ev.perm === true; // 11/07 刻印不消耗的地監免費傳送券(99254):不扣券、不扣金幣;文字不寫「永久」(使用者 22:3x)
  const free = perm || tickets > 0, poor = !free && adena() < price;
  showDialog('地監記憶書', perm ? '傳送不扣券也不扣金幣。' : free ? `有 ${fmt(tickets)} 張地監免費傳送券,傳送會先扣 1 張券。` : `傳送一次 ${fmt(price)} 金幣(目前有 ${fmt(adena())})。`);
  dlg.mode = 'dungeonbook';
  const body = $('#dlg-body');
  if (!dests.length) body.appendChild(el('p', 'hint', '目前沒有開放的地監。'));
  for (const d of dests) {
    menuButton(String(d.name || `地監 ${d.id}`), perm ? '免費' : free ? '扣 1 張地監免費傳送券' : `${fmt(price)} 金幣`, () => {
      if (poor) { toast(`金幣不足(要 ${fmt(price)})`); return; }
      send({ t: 'dbookgo', book: ev.book, dest: d.id });
      closeDialog();
    });
    if (poor) body.lastChild.classList.add('disabled');
  }
}
// 通行證清單和限制由伺服器決定;點選後伺服器再驗有效通行證與准入條件。
function openHuntPassBook(ev) {
  const dests = Array.isArray(ev.dests) ? ev.dests : [];
  const until = Number(ev.expires);
  const expires = Number.isFinite(until) && until > 0
    ? ` · 到期:${new Date(until).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}` : '';
  showDialog('獵場通行證', `${String(ev.status || '通行證狀態不明')}${expires}`);
  dlg.mode = 'huntpassbook';
  const body = $('#dlg-body');
  if (!dests.length) body.appendChild(el('p', 'hint', '目前沒有開放的獵場。'));
  for (const d of dests) {
    const reason = String(d.reason || '');
    menuButton(String(d.name || `獵場 ${d.id}`), reason || '進入獵場', () => {
      if (reason) { toast(reason); return; }
      // hud.js 現有回城設定/開放村莊過濾,不改設定也不新增設定 UI。
      send({ t: 'hbookgo', book: ev.book, dest: d.id, town: homeTown() });
      closeDialog();
    });
    if (reason) { body.lastChild.classList.add('disabled'); body.lastChild.setAttribute('aria-disabled', 'true'); }
  }
}
function closeDialog() {
  dlg.sealcraft = false;
  if (dlg.mode === 'trade' && trade.open) { trade.open = false; send({ t: 'tradecancel' }); }
  $('#dialog').classList.add('hidden'); dlg.mode = null;
}
$('#dlg-close').onclick = closeDialog;
// 點對話框外面(地圖、按鈕列…)就關閉,這一下不會讓角色走過去;交易中不關(關掉會取消交易)
document.addEventListener('pointerdown', (e) => {
  const box = $('#dialog');
  if (box.classList.contains('hidden') || box.contains(e.target) || dlg.mode === 'trade' || e.target.closest?.('#auction-desc')) return; // 10/28:點商品說明視窗(含關閉鈕)不關商店
  closeDialog();
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---- 離線收益(重新登入時伺服器送來;有好幾筆時一筆一筆看)----
const offlineReports = [];
function showOfflineReport(r) {
  // 切到背景又回來(代打一小段):不跳視窗,日誌留一行就好(掛機統計會併進去)
  if (r.reason === '回到網頁') {
    log(`背景代打 ${Math.max(1, Math.round((r.end - r.start) / 1000))} 秒:擊殺 ${fmt(r.kills)}、金幣 ${(r.gold1 - r.gold0 >= 0 ? '+' : '') + fmt(r.gold1 - r.gold0)}`, 'sys');
    return;
  }
  offlineReports.push(r);
  if (offlineReports.length === 1) renderOfflineReport();
}
function renderOfflineReport() {
  const x = offlineReports[0];
  if (!x) { $('#offline-report').classList.add('hidden'); return; }
  const dur = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`;
  };
  const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  // 經驗換算成「幾 % 的等級」(跨等級時累加)
  const levelPos = (lv, exp) => {
    const t = st.game.expTable;
    const cur = t[lv - 1] ?? 0;
    const next = t[lv] ?? cur;
    return lv + (next > cur ? (exp - cur) / (next - cur) : 0);
  };
  const expPct = (levelPos(x.level1, x.exp1) - levelPos(x.level0, x.exp0)) * 100;
  const net = x.gold1 - x.gold0;
  const rows = [
    ['角色', x.name],
    ['時間', dur(x.end - x.start)],
    ['等級', `Lv${x.level0} → Lv${x.level1}`],
    ['經驗', `${expPct >= 0 ? '' : '−'}${Math.abs(expPct).toFixed(4)}%`, expPct < 0 ? 'loss' : ''],
    ['金幣', fmt(x.goldEarned)],
    ['支出', fmt(x.goldSpent), 'loss'],
    ['總收益', sign(net), net < 0 ? 'loss' : ''],
    ['擊殺', fmt(x.kills)],
    ['結束', x.reason, x.reason === '重新登入' ? '' : 'warn'],
  ];
  const box = $('#offline-report');
  box.querySelector('.or-sub').textContent =
    `${x.ground || '個人獵場'} · 下線至今 ${dur(Date.now() - x.start)}${offlineReports.length > 1 ? ` · 還有 ${offlineReports.length - 1} 筆` : ''}`;
  const list = box.querySelector('.or-rows');
  list.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const row = document.createElement('div');
    row.className = 'or-row';
    const b = document.createElement('b'); b.textContent = k;
    const span = document.createElement('span'); span.textContent = v; if (cls) span.className = cls;
    row.append(b, span);
    list.appendChild(row);
  }
  const items = box.querySelector('.or-items');
  items.innerHTML = '';
  for (const it of x.items || []) {
    const cell = document.createElement('div');
    cell.className = 'or-item';
    cell.appendChild(iconCanvas({ name: it.n }, 30));
    const label = document.createElement('span');
    label.textContent = it.c > 1 ? `${it.n} ×${fmt(it.c)}` : it.n;
    cell.appendChild(label);
    items.appendChild(cell);
  }
  items.classList.toggle('hidden', !(x.items || []).length);
  box.querySelector('.or-body').scrollTop = 0;
  box.classList.remove('hidden');
}
$('#offline-report .or-close').onclick = () => { offlineReports.shift(); renderOfflineReport(); };

function menuButton(text, sub, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-btn';
  b.innerHTML = '<span></span><small></small>';
  b.querySelector('span').textContent = text;
  b.querySelector('small').textContent = sub || '';
  b.onclick = onClick;
  $('#dlg-body').appendChild(b);
}

// 原版劇情對話在客戶端檔案裡拿不到,先用暫代的身分與招呼語
const NPC_ROLES = {
  L1Merchant: ['商人', ['歡迎光臨,需要點什麼嗎?', '今天的貨都是新進的喔。', '冒險前別忘了準備藥水。']],
  L1Teleporter: ['傳送師', ['想去哪裡呢?我可以送你一程。', '旅途小心,外面的怪物可不好惹。']],
  L1Guard: ['警衛', ['這裡由我們守護,請安心。', '別在村子裡惹事。']],
  L1Board: ['佈告欄', ['上面貼著幾張褪色的告示。']],
};
const NPC_DEFAULT = ['居民', ['你好,冒險者。', '今天天氣真好呢。', '說話之島是許多冒險者的起點。']];

// 只買或只賣的商人回傳 'buy' / 'sell',其他 null
function shopOnly(m) {
  if (!m?.shop || m.teach || m.hunts?.length || m.teleports?.length || m.craft?.some(craftEnabled) || m.shop.buy === m.shop.sell) return null;
  return m.shop.buy ? 'buy' : 'sell';
}

// 點 NPC:先等伺服器回原版對話頁,不要馬上開暫代對話框(以前會先閃一下暫代的舊樣式對話框,才換成原版的)。
// 0.4 秒沒回(警衛、傳送師等不會回對話封包的 NPC)才開暫代的,而且依 NPC 名字記在這台裝置,下次(重新整理後也是)點牠就直接開
const npcWait = { ev: null, timer: 0 };
const NPC_NO_PAGE_KEY = 'l1j.npcNoPage';
const npcNoPage = new Set((() => { try { return JSON.parse(localStorage.getItem(NPC_NO_PAGE_KEY)) || []; } catch { return []; } })());
const saveNpcNoPage = () => { try { localStorage.setItem(NPC_NO_PAGE_KEY, JSON.stringify([...npcNoPage])); } catch { /* 無痕模式等 */ } };
function waitNpcPage(ev) {
  clearTimeout(npcWait.timer);
  npcWait.ev = null;
  if (npcNoPage.has(ev.name)) { openNpcDialog(ev); return; }
  npcWait.ev = ev;
  npcWait.timer = setTimeout(() => { npcWait.ev = null; npcNoPage.add(ev.name); saveNpcNoPage(); openNpcDialog(ev); }, 400);
}
function npcPageArrived(id) {
  const name = st.objects.get(id)?.name;
  if (name && npcNoPage.delete(name)) saveNpcNoPage(); // 很慢才回的也算有對話頁
  const ev = npcWait.ev && npcWait.ev.id === id ? npcWait.ev : null;
  if (ev) { clearTimeout(npcWait.timer); npcWait.ev = null; }
  return ev;
}

// 要付錢的傳送(說話之島傳送師):點地點先問一次,顯示地點、費用和身上金幣,按「確定」才送出,「取消」回到清單(使用者 10/16)
function confirmTeleport(ev, tp) {
  const body = $('#dlg-body');
  const list = [...body.children];
  list.forEach((c) => c.classList.add('hidden'));
  const box = el('div', 'tp-confirm');
  box.append(el('p', 'tp-q', `確定要傳送到「${tp.label}」嗎?`), el('p', 'tp-cost', `費用 ${fmt(tp.price)} 金幣(身上 ${fmt(adena())})`));
  const poor = tp.price > adena();
  if (poor) box.append(el('p', 'tp-poor', '金幣不足'));
  const row = el('div', 'tp-row');
  const yes = el('button', 'menu-btn tp-yes', '確定');
  const no = el('button', 'menu-btn tp-no', '取消');
  yes.type = 'button';
  no.type = 'button';
  yes.disabled = poor;
  yes.onclick = () => { send({ t: 'npcaction', id: ev.id, action: tp.action }); closeDialog(); };
  no.onclick = () => { box.remove(); list.forEach((c) => c.classList.remove('hidden')); };
  row.append(yes, no);
  box.append(row);
  body.append(box);
}

// 11/05 使用者:活動獵場進場確認(費用來自 altsettings EventHuntFeePerHour,gateway config.json eventHunt.fee)
// 11/10 使用者「把實用商人裡面的東西 購買時 多一個確認按鈕」:和傳送 / 活動獵場確認同一種框;取消回到商品列表
function confirmShopBuy(r, ok) {
  const body = $('#dlg-body');
  const list = [...body.children];
  list.forEach((c) => c.classList.add('hidden'));
  const box = el('div', 'tp-confirm');
  box.append(el('p', 'tp-q', `確定購買「${r.name}」× ${fmt(r.n)} 嗎?`), el('p', 'tp-cost', `共 ${fmt(r.n * r.price)} 金幣(身上 ${fmt(adena())})`));
  const row = el('div', 'tp-row');
  const yes = el('button', 'menu-btn tp-yes', '確定購買');
  const no = el('button', 'menu-btn tp-no', '取消');
  yes.type = 'button';
  no.type = 'button';
  const back = () => { box.remove(); list.forEach((c) => c.classList.remove('hidden')); };
  yes.onclick = () => { back(); ok(); };
  no.onclick = back;
  row.append(yes, no);
  box.append(row);
  body.append(box);
}

function confirmEventHunt(ev, h) {
  const fee = st.eventHunt.fee;
  const body = $('#dlg-body');
  const list = [...body.children];
  list.forEach((c) => c.classList.add('hidden'));
  const box = el('div', 'tp-confirm');
  box.append(el('p', 'tp-q', `此地圖每小時會扣 ${fmt(fee)} 金幣,是否確定進入「${h.name}」?`), el('p', 'tp-cost', `進場先扣 ${fmt(fee)} 金幣,之後每滿 1 小時再扣一次(身上 ${fmt(adena())})`));
  const poor = fee > adena();
  if (poor) box.append(el('p', 'tp-poor', '金幣不足'));
  if (Number.isFinite(st.eventHunt.bonus)) box.append(el('p', 'hint', `經驗 +${st.eventHunt.bonus}%`));
  if (st.eventHunt.catchup) { const cu = el('button', 'menu-btn', '追趕加成'); cu.type = 'button'; cu.onclick = openCatchup; box.append(cu); }
  const row = el('div', 'tp-row');
  const yes = el('button', 'menu-btn tp-yes', '確定');
  const no = el('button', 'menu-btn tp-no', '取消');
  yes.type = 'button';
  no.type = 'button';
  yes.disabled = poor;
  yes.onclick = () => { send({ t: 'npcaction', id: ev.id, action: h.action }); closeDialog(); };
  no.onclick = () => { box.remove(); list.forEach((c) => c.classList.remove('hidden')); };
  row.append(yes, no);
  box.append(row);
  body.append(box);
}

function openNpcDialog(ev) {
  dlg.npc = ev.id;
  dlg.mode = 'menu';
  const m = ev.menu;
  // 只有買或只有賣的商人(潘朵拉 / 亞丁回收商):直接開購買 / 販賣清單,不先跳選單
  // 只教魔法的 NPC(吉倫):直接開學習魔法
  if (m?.teach && !m.shop && !m.hunts?.length && !m.teleports?.length) {
    send({ t: 'skillbuy', npc: ev.id });
    return;
  }
  const only = shopOnly(m);
  if (only) {
    send({ t: 'npcaction', id: ev.id, action: only });
    return;
  }
  const [, lines] = m?.teach ? ['魔法導師', ['想學習魔法嗎?讓我看看你的資質。']]
    : m?.hunts ? ['個人獵場', ['要去哪個獵場?']]
    : NPC_ROLES[ev.impl] || NPC_DEFAULT;
  showDialog(`${ev.name || 'NPC'}`, `「${lines[ev.id % lines.length]}」`);
  // 教魔法的 NPC(吉倫):伺服器會檢查角色是否在他 5 格內
  if (m?.teach) menuButton('學習魔法', '', () => send({ t: 'skillbuy', npc: ev.id }));
  if (m?.pet) { // 寵物管理員
    menuButton('領出寵物', '', () => send({ t: 'npcaction', id: ev.id, action: 'withdrawnpc' }));
    menuButton('寄放寵物', '', () => { send({ t: 'npcaction', id: ev.id, action: 'depositnpc' }); closeDialog(); toast('寵物已寄放'); });
  }
  if (m?.craft?.length) craftButton(ev.id, ev.name, m);
  if (m?.shop?.buy) menuButton('購買道具', '', () => send({ t: 'npcaction', id: ev.id, action: 'buy' }));
  if (m?.shop?.sell) menuButton('販賣道具', '', () => send({ t: 'npcaction', id: ev.id, action: 'sell' }));
  // 個人獵場:只能去這個地區的獵場,每人一份地圖
  for (const h of m?.hunts || []) {
    menuButton(`進入${h.name}`, '', () => {
      // 11/05 使用者:活動獵場每小時扣錢,進去前多一個確認
      if (st.eventHunt && h.action === `phunt ${st.eventHunt.ground}`) { confirmEventHunt(ev, h); return; }
      send({ t: 'npcaction', id: ev.id, action: h.action });
      closeDialog();
    });
  }
  for (const tp of m?.teleports || []) {
    menuButton(tp.label, tp.price ? `${fmt(tp.price)} 金幣` : '', () => {
      if (tp.price > 0) { confirmTeleport(ev, tp); return; } // 要錢的先確認;免費的(活動傳送員)照舊直接送
      send({ t: 'npcaction', id: ev.id, action: tp.action });
      closeDialog();
    });
  }
}

// 商店(參考網頁版):每個道具一張卡片 —— 圖示、名稱(賣的話顯示身上數量)、價格、− 數量 +、自己的購買 / 賣出鈕
// 按了馬上交易這一列,視窗不關,可以一直買 / 賣;上方顯示商人名稱和身上金幣
let shopGoldTimer = 0;
let tishaShop = null; // TishaDiamond: scoped to the currently displayed NPC shop.
function shopCards(ev, rows, kind) {
  const tishaRows = [];
  if (tishaShop) { for (const x of tishaShops) { clearTimeout(x.timer); clearTimeout(x.timeout); } tishaShops = []; tishaShop = null; }
  const buy = kind === 'buy';
  const npc = st.objects.get(ev.npc);
  showDialog(buy ? '商店' : '亞丁商團', '');
  $('#dialog').classList.add('shop');
  const body = $('#dlg-body');
  const head = el('div', 'shop-head');
  head.append(el('span', 'who', npc?.name || ''), el('span', 'gold', ''));
  body.appendChild(head);
  const gold = () => { head.querySelector('.gold').textContent = fmt(adena()); };
  gold();
  clearInterval(shopGoldTimer);
  shopGoldTimer = setInterval(() => { if ($('#dialog').classList.contains('hidden')) clearInterval(shopGoldTimer); else gold(); }, 500);
  const list = el('div', 'shop-list');
  body.appendChild(list);
  if (!rows.length) list.appendChild(el('p', 'empty', buy ? '沒有可以買的東西。' : '身上沒有這位商人收購的道具。'));
  for (const r of rows) {
    r.n = 1;
    const card = el('div', 'shop-card');
    const ic = iconCanvas(r.icon || { name: r.name }, 40);
    card.appendChild(ic);
    const info = el('div', 'info');
    const nm = el('span', 'nm', r.name);
    // 裝備:點圖示或名稱看素質
    if (itemStatsBlock({ name: r.name })) {
      card.classList.add('has-stats');
      nm.appendChild(el('i', 'stat-hint', 'ⓘ'));
      ic.onclick = info.onclick = () => openStatsPopup(r.name, r.icon);
    } else if (typeof itemHasDesc === 'function' && itemHasDesc({ name: r.name, gfx: r.icon?.gfx })) { // 10/28 使用者:商店道具點了看說明(實用商人等)
      card.classList.add('has-stats');
      nm.appendChild(el('i', 'stat-hint', 'ⓘ'));
      ic.onclick = info.onclick = () => openAuctionDescription({ name: r.name, gfx: r.icon?.gfx, count: 1 }, ic);
    }
    const cnt = el('small', 'cnt', '');
    const showCount = () => { cnt.textContent = buy ? '' : `× ${r.max}`; };
    showCount();
    nm.appendChild(cnt);
    info.append(nm, el('span', 'pr', fmt(r.price)));
    card.appendChild(info);
    const qty = el('span', 'qty');
    qty.innerHTML = '<button type="button" aria-label="減少">−</button><b>1</b><button type="button" aria-label="增加">+</button>';
    const [minus, plus] = qty.querySelectorAll('button');
    const set = (v) => { r.n = Math.max(1, Math.min(r.max, v)); qty.querySelector('b').textContent = r.n; };
    minus.onclick = () => set(r.n <= 1 ? r.max : r.n - 1); // 已經是 1 再按:跳到最大(賣出 = 身上的數量、買入 = 999)
    plus.onclick = () => set(r.n + 1);
    // 點數量:跳出數字鍵盤(最大 = 買得起 / 身上有的數量)
    const most = () => Math.max(1, buy ? Math.min(r.max, Math.floor(adena() / Math.max(1, r.price))) : r.max);
    qty.querySelector('b').onclick = () => openNumpad(r.n, most(), set);
    const ctl = el('div', 'ctl'); // 右邊一欄:上面數量、下面按鈕(名稱才有整行可以放,不用換行)
    ctl.appendChild(qty);
    card.appendChild(ctl);
    const go = el('button', 'deal', buy ? '購買' : '賣出');
    go.type = 'button';
    go.onclick = () => {
      if (buy) {
        if (r.n * r.price > adena()) { toast('金幣不足'); return; }
        if (npc?.name === '實用商人' && !go.confirmed) { confirmShopBuy(r, () => { go.confirmed = true; go.onclick(); go.confirmed = false; }); return; } // 11/10 使用者:實用商人買東西多一個確認
        send({ t: 'result', npc: ev.npc, type: 0, lines: [[r.key, r.n]] });
        toast(`購買 ${r.name} × ${r.n}`);
      } else {
        send({ t: 'result', npc: ev.npc, type: 1, lines: [[r.key, r.n]] });
        toast(`賣出 ${r.name} × ${r.n}`);
        r.max -= r.n; // 賣完的那一列拿掉,沒賣完的更新數量
        if (r.max <= 0) card.remove();
        else { showCount(); set(r.n); }
      }
      setTimeout(gold, 400);
    };
    ctl.appendChild(go);
    list.appendChild(card);
    if (buy && st.tishaDiamond) tishaRows.push({ key: r.key, card });
  }
  if (buy && st.tishaDiamond) openTishaShop(ev.npc, tishaRows);
}


// TishaDiamond: server identifies the product by shop order; never match a translated item name.
// 使用者 11/17:「回憶蠟燭也能使用刻印的鑽石兌換」→ 兩項各自一組狀態;op 0 / 1 = 緹夏的守護、2 / 3 = 回憶蠟燭(伺服器 L1TishaDiamond.PRODUCTS 同順序)
const TISHA_PRODUCTS = [{ id: 99244, name: '緹夏的守護(30日)' }, { id: 49142, name: '回憶蠟燭' }];
let tishaShops = [];
function openTishaShop(npc, rows) {
  tishaShops.forEach(t => clearTimeout(t.timer));
  tishaShops = TISHA_PRODUCTS.map((p, slot) => ({ npc, rows, id: st.selfId, busy: false, quote: null, note: '', slot, product: p.id, pname: p.name }));
  tishaShop = tishaShops[0];
  for (const t of tishaShops) {
    const poll = () => {
      if (!tishaShopActive(t)) return;
      send({ t: 'tishadiamond', op: t.slot * 2, npc });
      t.timer = setTimeout(poll, 1500);
    };
    setTimeout(poll, t.slot * 600); // 伺服器每項 500 ms 內只收一次查詢
  }
}
function tishaShopActive(t) {
  return t && tishaShops.includes(t) && st.inGame && st.tishaDiamond && t.id === st.selfId
    && !$('#dialog').classList.contains('hidden') && t.rows.some(r => r.card.isConnected);
}
function onTishaDiamond(j) {
  const t = tishaShops.find(x => x.product === (j?.product ?? 99244));
  if (!tishaShopActive(t) || !j || j.id !== t.id || j.npc !== t.npc) return;
  if (!Number.isInteger(j.token) || j.token <= 0 || !Number.isInteger(j.count) || j.count < 1
      || !Number.isSafeInteger(j.items) || j.items < 0 || !Number.isSafeInteger(j.ordinary) || j.ordinary < 0) return;
  const messages = { ok: `兌換成功，已獲得${t.pname} ×1`, insufficient: '刻印的品質鑽石不足', ordinary: '只能用刻印的品質鑽石',
    state: '請結束死亡、交易、商店或無法行動狀態後再兌換', npc: '請站在實用商人旁邊再兌換', capacity: '背包空間或負重不足',
    cooldown: '請稍候兩秒再兌換', stale: '這次確認已失效或已處理，請查看背包與最新數量', config: '兌換設定已變更，請重新確認',
    product: '守護道具狀態異常，請聯絡管理員', refunded: '兌換未完成，已補回刻印鑽石', review: '兌換未完成，請聯絡管理員核對，請勿重試' };
  if (j.result) {
    t.busy = false; clearTimeout(t.timeout); t.note = messages[j.result] || '兌換未完成，請稍後再試';
    toast(t.note);
    if (j.result === 'ok' || j.result === 'refunded' || j.result === 'review') invResync(true);
    if (j.result === 'ok' || j.result === 'cooldown') t.coolUntil = performance.now() + 2100;
  }
  t.quote = j;
  if (j.enabled !== true) clearTimeout(t.timer); // unrelated NPC, moved away, or disabled: reopen the shop to query again
  renderTishaDiamond(t);
}
function renderTishaDiamond(t) {
  const j = t.quote;
  if (!j || !tishaShopActive(t)) return;
  const r = t.rows.find(r => r.key === j.order);
  if (!r || j.enabled !== true) {
    if (t.box && t.note) { t.button.disabled = true; t.hint.textContent = t.note; t.confirm?.remove(); t.confirm = null; }
    else { t.box?.remove(); t.box = null; }
    return;
  }
  if (!t.box) {
    t.box = el('div', 'tisha-diamond');
    // 11/16 使用者:「做得不太明顯 用戶不知道換什麼」→ 做成第二種付款方式:標題 + 鑽石圖示 + 價格 + 兌換按鈕
    t.title = el('div', 'tisha-title');
    const pay = el('div', 'tisha-pay');
    const ic = iconCanvas({ name: '品質鑽石' }, 32);
    const info = el('div', 'tisha-info');
    t.price = el('span', 'tisha-price');
    t.balance = el('small', 'tisha-balance');
    info.append(t.price, t.balance);
    t.button = el('button', 'deal tisha-exchange', '兌換'); t.button.type = 'button';
    pay.append(ic, info, t.button);
    t.hint = el('small', 'tisha-hint'); t.hint.setAttribute('role', 'status');
    t.box.append(t.title, pay, t.hint); r.card.append(t.box);
    t.button.onclick = () => confirmTishaDiamond(t);
  }
  t.title.textContent = '不用金幣，也可以用「刻印的品質鑽石」兌換這個道具';
  t.price.textContent = `刻印品質鑽石 ×${fmt(j.count)}`;
  t.balance.textContent = `身上有 ${fmt(j.items)} 顆`;
  const poor = j.items < j.count;
  const reason = poor ? (j.items === 0 && j.ordinary > 0 ? '身上只有沒刻印的品質鑽石，只能用刻印的兌換' : '刻印的品質鑽石不足(每日任務可以領)') : '';
  t.button.disabled = poor || t.busy || !!t.confirm || performance.now() < (t.coolUntil || 0);
  t.button.title = reason;
  t.balance.classList.toggle('poor', poor);
  t.hint.textContent = t.busy ? '兌換處理中…' : reason || t.note || '';
  t.hint.hidden = !t.hint.textContent;
}
function confirmTishaDiamond(t) {
  const j = t.quote;
  if (!tishaShopActive(t) || t.busy || t.confirm || !j?.enabled || j.items < j.count) return;
  const box = t.confirm = el('div', 'tisha-confirm');
  box.append(el('p', '', `使用刻印品質鑽石 ×${fmt(j.count)}，兌換${t.pname} ×1？`));
  const yes = el('button', 'deal', '確認兌換'), no = el('button', 'deal', '取消');
  yes.type = no.type = 'button';
  const close = () => { box.remove(); t.confirm = null; renderTishaDiamond(t); };
  no.onclick = close;
  yes.onclick = () => {
    if (!tishaShopActive(t) || t.busy) return;
    if (t.quote.token !== j.token || t.quote.count !== j.count || t.quote.items < j.count || !t.quote.enabled) {
      t.note = '數量或設定已變更，請重新確認'; close(); return;
    }
    t.busy = true; close();
    send({ t: 'tishadiamond', op: t.slot * 2 + 1, npc: t.npc, token: j.token });
    t.timeout = setTimeout(() => {
      if (!tishaShopActive(t) || !t.busy) return;
      t.busy = false; t.note = '未收到兌換結果，請先確認背包；不會自動重送';
      invResync(true); send({ t: 'tishadiamond', op: t.slot * 2, npc: t.npc }); renderTishaDiamond(t);
    }, 8000);
  };
  box.append(yes, no); t.box.append(box); renderTishaDiamond(t); no.focus();
}

// 商店裡看裝備素質:疊在商店對話框上面
function openStatsPopup(name, icon) {
  document.getElementById('stats-pop')?.remove();
  const pop = el('div', '');
  pop.id = 'stats-pop';
  const box = el('div', 'sp-box');
  const head = el('div', 'is-head');
  head.append(iconCanvas(icon || { name }, 40), el('span', '', name));
  const close = el('button', 'x-btn', '✕');
  close.type = 'button';
  close.onclick = () => pop.remove();
  box.append(close, head, itemStatsBlock({ name }));
  pop.appendChild(box);
  pop.onclick = (e) => { if (e.target === pop) pop.remove(); };
  $('#dialog').appendChild(pop);
}

// ---------------- 玩家選單 / 確認視窗 / 交易 / 組隊 ----------------
const PARTY_SPLIT_NOTE = '僅金幣';
// PartyLeaderLoot: 2 is the UI mode; wire 2 remains legacy chat-party.
const partyTypeLabel = (type) => type === 0 ? '一般' : type === 1 ? '自動分配' : type === 2 ? '隊長統一' : '未知';
const partyTypeName = () => partyTypeLabel(st.partyType);
const partyLeaderNote = () => st.partyLeaderLootAdena !== false ? '掉落與金幣全歸隊長' : '物品歸隊長，金幣照一般';
const partyTypes = () => st.partyLeaderLoot ? [0, 1, 2] : [0, 1];
function inviteParty(o, type) {
  // 選單開著時隊伍也可能變動,送出前重新確認隊長與類型,避免中途換類型。
  if (st.party?.some((m) => m.id === o.id)) return;
  if (st.party?.length) {
    if (st.party.find((m) => m.leader)?.id !== st.selfId) return;
    if (partyTypes().includes(st.partyType)) type = st.partyType; // 知道類型就沿用;重新連線後不知道 → 用隊長這次選的(10/27 使用者:未知時不能擋邀請)
  }
  if (!partyTypes().includes(type)) { toast('請選擇組隊類型再邀請。'); return; }
  if (!connUp()) { toast('連線中斷，請恢復連線後再邀請。'); return; }
  send({ t: 'partyinvite', target: o.id, type });
  if (!st.party?.length) st.partyOffer = { type, target: o.id }; // 先記邀請,成隊時核對名單才顯示
  else if (st.partyType == null) { st.partyType = type; renderParty(); } // 類型未知時隊長選了一種 → 之後的邀請沿用
  closeDialog();
  toast(`已邀請 ${o.name} 組隊(${partyTypeLabel(type)})`);
}
// 純規則：選單開啟與送出時重新檢查同一份隊伍狀態。
function chatPartyTypes(name, selfName, selfId, party, partyType, enabled, leaderLoot = false) {
  const types = leaderLoot ? [0, 1, 2] : [0, 1];
  if (!enabled || !name || name === selfName || party?.some((m) => m.name === name)) return [];
  if (!party?.length) return types;
  if (party.find((m) => m.leader)?.id !== selfId) return [];
  return types.includes(partyType) ? [partyType] : types;
}
function invitePartyByName(name, type) {
  if (!st.partyInviteByName) { toast('目前無法用名字邀請組隊'); return; }
  const types = chatPartyTypes(name, st.myName, st.selfId, st.party, st.partyType, true, st.partyLeaderLoot);
  if (!types.length) return;
  if (types.length === 1) type = types[0];
  if (!types.includes(type)) return;
  if (!connUp()) { toast('連線中斷，請恢復連線後再邀請。'); return; }
  send({ t: 'partyinvite', name, type });
  if (!st.party?.length) st.partyOffer = { type, name };
  else if (st.partyType == null) { st.partyType = type; renderParty(); }
  closeDialog();
  toast(`已邀請 ${name} 組隊(${partyTypeLabel(type)})`);
}
function openChatPlayerMenu(name) {
  if (!name || name === st.myName) return;
  showDialog(name, '');
  $('#dialog').classList.add('mini'); // 11/05 小選單:橫式不縮聊天框(land.css)
  dlg.mode = 'player';
  menuButton('密語', '填入對方名字', () => { closeDialog(); beginWhisper(name); });
  const types = chatPartyTypes(name, st.myName, st.selfId, st.party, st.partyType, st.partyInviteByName, st.partyLeaderLoot);
  for (const type of types) {
    menuButton(type === 2 ? '邀請組隊(隊長統一)' : type === 1 ? '邀請組隊(自動分配)' : '邀請組隊',
      st.party?.length && types.length === 1 ? `目前：${partyTypeName()}，沿用此類型` : type === 2 ? partyLeaderNote() : type === 1 ? PARTY_SPLIT_NOTE : '一般：掉落依傷害比例抽取',
      () => invitePartyByName(name, type));
  }
  for (const b of document.querySelectorAll('#dlg-body .menu-btn')) b.style.minHeight = '44px';
}
function openPlayerMenu(o) {
  showDialog(o.name, '');
  $('#dialog').classList.add('mini'); // 11/05 小選單:橫式不縮聊天框(land.css)
  dlg.mode = 'player';
  menuButton('密語', '填入對方名字', () => { closeDialog(); beginWhisper(o.name); });
  menuButton('交易', '走到旁邊後發起', () => { closeDialog(); st.target = { id: o.id, mode: 'trade' }; st.path = []; });
  const inParty = st.party?.length;
  const leader = st.party?.find((m) => m.leader)?.id === st.selfId;
  const member = st.party?.some((m) => m.id === o.id);
  if (!member && !inParty) {
    menuButton('邀請組隊', '一般：掉落依傷害比例抽取', () => inviteParty(o, 0));
    menuButton('邀請組隊(自動分配)', PARTY_SPLIT_NOTE, () => inviteParty(o, 1));
    if (st.partyLeaderLoot) menuButton('邀請組隊(隊長統一)', partyLeaderNote(), () => inviteParty(o, 2));
  } else if (!member && leader) {
    if (st.partyType == null) { // 重新連線 / 重新整理後網頁不知道隊伍類型:讓隊長自己選(選了之後就沿用)
      menuButton('邀請組隊', '一般：掉落依傷害比例抽取', () => inviteParty(o, 0));
      menuButton('邀請組隊(自動分配)', PARTY_SPLIT_NOTE, () => inviteParty(o, 1));
      if (st.partyLeaderLoot) menuButton('邀請組隊(隊長統一)', partyLeaderNote(), () => inviteParty(o, 2));
    } else {
      menuButton('邀請組隊', `目前：${partyTypeName()}，沿用此類型`, () => inviteParty(o, st.partyType));
    }
  }
  if (member && leader) menuButton('踢出隊伍', '', () => { send({ t: 'partykick', name: o.name }); closeDialog(); });
}
// 伺服器的是 / 否確認(交易邀請 252、組隊邀請 953 / 954、復活 321…)
const YN_TEXT = {
  252: (a) => `${a[0]} 想要和你交易,願意嗎?`,
  953: (a) => `${a[0]} 邀請你加入隊伍,願意嗎?`,
  954: (a) => `${a[0]} 邀請你加入自動分配隊伍(${PARTY_SPLIT_NOTE}),願意嗎?`,
  32513: (a) => `${a[0]} 邀請你加入隊長統一隊伍：${a[1] === '0' ? '所有掉落物品都歸隊長，金幣照一般分配' : '所有掉落物品與金幣都歸隊長'}，同意才加入，願意嗎?`,
  321: () => '要接受復活嗎?',
  322: () => '要接受復活嗎?',
  738: (a) => `恢復經驗值需要 ${Number(a[0] || 0).toLocaleString()} 金幣,要恢復經驗值嗎?`, // 聖使阿卡塔(C_NPCAction "exp")
};
const YN_TIMEOUT = { 252: 15, 953: 15, 954: 15, 32513: 15 }; // 交易 / 組隊邀請:15 秒沒回應就自動拒絕
let ynTimer = null;
function openYesNo(ev) {
  // PartyHandoff: old Java sent this AFTER appointing, with no C_Attr handler.
  if (st.partyLeaderLoot && ev.type === 1703) return;
  clearInterval(ynTimer);
  showDialog('確認', '');
  dlg.mode = 'yesno';
  $('#dlg-body').appendChild(el('p', 'yn-text', (YN_TEXT[ev.type] || (() => `確認(${ev.type})${ev.args.join(' ')}`))(ev.args)));
  let done = false;
  const answer = (yes) => {
    if (done) return;
    done = true;
    clearInterval(ynTimer);
    send({ t: 'yesno', seq: ev.seq, type: ev.type, yes });
    if (yes && (ev.type === 953 || ev.type === 954 || ev.type === 32513) && !st.party?.length && connUp()) {
      st.partyOffer = { type: ev.type === 32513 ? 2 : ev.type === 954 ? 1 : 0, inviter: ev.args[0] }; // 只在同意時記下,等隊伍名單確認
    }
    if (dlg.mode === 'yesno') { dlg.mode = null; closeDialog(); }
  };
  const row = el('div', 'yn-row');
  const no = el('button', 'yn-no', '拒絕');
  const ok = el('button', 'yn-yes', '同意');
  no.type = ok.type = 'button';
  no.onclick = () => answer(false);
  ok.onclick = () => answer(true);
  row.append(no, ok);
  $('#dlg-body').appendChild(row);
  let left = YN_TIMEOUT[ev.type];
  if (left) {
    no.textContent = `拒絕(${left})`;
    ynTimer = setInterval(() => {
      if (dlg.mode !== 'yesno') { answer(false); return; } // 視窗被關掉也算拒絕
      left--;
      no.textContent = `拒絕(${left})`;
      if (left <= 0) answer(false);
    }, 1000);
  }
}

const trade = { open: false, partner: '', mine: [], theirs: [], ok: false };
const TRADE_MAX = 6; // 一次最多交易 6 樣
function openTrade(name) {
  Object.assign(trade, { open: true, partner: name, mine: [], theirs: [], ok: false, partnerOk: false, tab: 'all', pick: null });
  renderTrade();
}
function addTradeItem(ev) {
  (ev.side === 0 ? trade.mine : trade.theirs).push({ gfx: ev.gfx, name: ev.name, bless: ev.bless });
  if (ev.side === 1) trade.partnerOk = false; // 對方又放東西:提醒重新確認內容
  renderTrade();
}
function endTrade(done) {
  if (!trade.open) return;
  trade.open = false;
  if (dlg.mode === 'trade') { dlg.mode = null; closeDialog(); }
  toast(done ? '交易完成' : '交易取消');
}
// 交易時祝福 / 詛咒 / 未鑑定要一眼看得出來(使用者 10/19:避免拿普通的冒充祝福的詐騙):格子角標 + 雙方完整名稱上色
const tradeBless = (it) => (it.bless == null ? 1 : it.bless & 127); // 刻印不能交易,保險起見去掉
const tradeLabel = (it) => (tradeBless(it) === 3 ? `${it.name}(未鑑定)` : itemLabel({ ...it, bless: tradeBless(it) }));
function tradeBadge(cell, it) {
  const b = tradeBless(it);
  if (b === 0 || b === 2 || b === 3) cell.appendChild(el('b', `tb b${b}`, b === 0 ? '祝' : b === 2 ? '咒' : '?'));
}
function renderTrade() {
  if (!trade.open) return;
  showDialog(`與 ${trade.partner} 交易`, '');
  dlg.mode = 'trade';
  const body = $('#dlg-body');
  // 每邊一排 6 格(一次最多交易 6 樣),放了的格子顯示圖示和數量,點一下看名稱
  const list = (title, items) => {
    const sec = el('div', 'trade-sec');
    sec.appendChild(el('h4', '', `${title}  ${items.length} / ${TRADE_MAX}`));
    const slots = el('div', 'trade-slots');
    for (let i = 0; i < TRADE_MAX; i++) {
      const it = items[i];
      const c = el('div', 'trade-cell');
      if (it) {
        const m = it.name.match(/\((\d+)\)$/);
        c.appendChild(iconCanvas({ name: it.name.replace(/\s*\(\d+\)$/, ''), gfx: it.gfx, bless: tradeBless(it) }, 30));
        tradeBadge(c, it);
        if (m) c.appendChild(el('i', 'cnt', fmt(+m[1]))); // 10/27 使用者:交易數量不要用 k,完整顯示 1,000,000
        c.title = tradeLabel(it);
        c.onclick = () => toast(tradeLabel(it));
      }
      slots.appendChild(c);
    }
    sec.appendChild(slots);
    if (items.length) { // 完整名稱(祝福金色、詛咒紅色、未鑑定灰色),不用一格一格點
      const ul = el('ul', 'trade-names');
      for (const it of items) ul.appendChild(el('li', `b${tradeBless(it)}`, tradeLabel(it)));
      sec.appendChild(ul);
    }
    return sec;
  };
  body.append(list(`${trade.partner}${trade.partnerOk ? '(已確定)' : ''}`, trade.theirs), list(`我${trade.ok ? '(已確定)' : ''}`, trade.mine));
  // 下方直接是背包:點道具放入(有數量的跳數字鍵盤);金幣另外一列
  if (!trade.ok) body.appendChild(tradeBag());
  const foot = el('div', 'trade-foot');
  const ok = el('button', 'yn-yes', trade.ok ? '已確定,等待對方' : '確定交易');
  const cancel = el('button', 'yn-no', '取消');
  ok.type = cancel.type = 'button';
  ok.disabled = trade.ok;
  ok.onclick = () => { trade.ok = true; send({ t: 'tradeok' }); renderTrade(); };
  cancel.onclick = () => closeDialog();
  foot.append(ok, cancel);
  body.appendChild(foot);
}
// 背包有變(放進交易視窗後伺服器會把道具移走):交易視窗跟著刷新
function tradeInvChanged() {
  if (!trade.open || dlg.mode !== 'trade' || document.getElementById('numpad')) return;
  clearTimeout(trade.redraw);
  trade.redraw = setTimeout(renderTrade, 150);
}
const tradeable = (it) => !/\((揮舞|穿戴)\)/.test(it.name) && !(it.bless >= 128) && !st.locks?.has(it.id); // 裝備中、刻印的不能交易
function tradeBag() {
  const box = el('div', 'trade-bag');
  const gold = [...st.inv.values()].find((it) => /^金幣/.test(it.name));
  const grow = el('div', 'trade-gold');
  grow.append(iconCanvas({ name: '金幣' }, 28), el('span', '', `金幣 ${fmt(gold?.count || 0)}`));
  const gbtn = el('button', '', '放入金幣');
  gbtn.type = 'button';
  gbtn.disabled = !gold?.count;
  const full = () => { if (trade.mine.length < TRADE_MAX) return false; toast(`一次最多交易 ${TRADE_MAX} 樣`); return true; };
  gbtn.onclick = () => { if (!full()) openNumpad(0, gold.count, (n) => { if (n > 0) send({ t: 'tradeadd', item: gold.id, count: n }); }); };
  grow.appendChild(gbtn);
  box.appendChild(grow);
  // 分頁(全部 / 裝備 / 道具,排序同背包)+ 點一下選取、下方顯示名稱,按「放入」才放(東西多時不會點錯)
  const tabs = el('div', 'trade-tabs');
  for (const [k, label] of [['all', '全部'], ['gear', '裝備'], ['item', '道具']]) {
    const t = el('button', `trade-tab${trade.tab === k ? ' on' : ''}`, label);
    t.type = 'button';
    t.onclick = () => { trade.tab = k; trade.pick = null; renderTrade(); };
    tabs.appendChild(t);
  }
  box.appendChild(tabs);
  const grid = el('div', 'trade-grid');
  let items = [...st.inv.values()].filter((it) => tradeable(it) && !/^金幣/.test(it.name)
    && (trade.tab === 'all' || (trade.tab === 'gear') === isGear(it)));
  items = sortInv(items);
  if (!items.length) grid.appendChild(el('p', 'empty', '沒有可以交易的道具'));
  const pickRow = el('div', 'trade-pickrow');
  const showPick = () => {
    pickRow.innerHTML = '';
    const it = trade.pick && st.inv.get(trade.pick);
    if (!it) { pickRow.appendChild(el('span', 'hint', '點道具選取,再按「放入」')); return; }
    pickRow.appendChild(el('span', 'nm', itemLabel(it)));
    const put = el('button', 'yn-yes', '放入');
    put.type = 'button';
    put.onclick = () => {
      if (full()) return;
      const send1 = (n) => { if (n > 0) { trade.pick = null; send({ t: 'tradeadd', item: it.id, count: n }); } };
      if (it.count > 1) openNumpad(it.count, it.count, send1); else send1(1);
    };
    pickRow.appendChild(put);
  };
  for (const it of items) {
    const b = el('div', `trade-cell${trade.pick === it.id ? ' sel' : ''}`); // 11/04 改 div:iOS Safari 的 <button> 不吃 aspect-ratio,格子會壓扁成一條(上方交易格本來就是 div,正常)
    b.setAttribute('role', 'button');
    b.title = itemLabel(it);
    b.appendChild(iconCanvas(it, 36));
    tradeBadge(b, it);
    if (it.count > 1) b.appendChild(el('i', 'cnt', fmt(it.count))); // 10/27 使用者:不要用 k
    b.onclick = () => {
      trade.pick = it.id;
      grid.querySelectorAll('.trade-cell.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      showPick();
    };
    grid.appendChild(b);
  }
  box.appendChild(grid);
  showPick();
  box.appendChild(pickRow);
  return box;
}
// 從背包選要放的道具(裝備中的不能交易);有數量的跳數字鍵盤
function openTradePicker() {
  const body = $('#dlg-body');
  body.innerHTML = '';
  body.appendChild(el('p', 'hint', '點要放入交易的道具:'));
  const grid = el('div', 'trade-pick');
  for (const it of st.inv.values()) {
    if (/\((揮舞|穿戴)\)/.test(it.name) || it.bless >= 128 || st.locks?.has(it.id)) continue; // 裝備中、刻印、上鎖的不能交易
    const b = el('button', 'trade-row');
    b.type = 'button';
    b.append(iconCanvas(it, 28), el('span', '', itemLabel(it)));
    b.onclick = () => {
      const put = (n) => { send({ t: 'tradeadd', item: it.id, count: n }); renderTrade(); };
      if (it.count > 1) openNumpad(it.count, it.count, put); else put(1);
    };
    grid.appendChild(b);
  }
  body.appendChild(grid);
  const back = el('button', '', '返回');
  back.type = 'button';
  back.onclick = () => renderTrade();
  body.appendChild(back);
}

// 隊伍面板(左側狀態列下方):名稱、HP / MP 條;隊長有皇冠
st.party = [];
st.partyType = null; // 0 一般 / 1 自動分配 / null 未知;只保留在這次登入的網頁記憶體
st.partyOffer = null;
function updateParty(members, serverType, clanParty) {
  st.clanParty = members.length && clanParty ? clanParty : null; // Server snapshot only, including F5/reconnect/off.
  if (!members.length) { st.partyType = null; st.partyOffer = null; }
  else if (!st.party.length) {
    const offer = st.partyOffer;
    const leader = members.find((m) => m.leader);
    // 名單沒有分配類型;只信這次送出 / 同意的邀請,不能用舊邀請推測別的隊伍。
    const matched = offer && (offer.target != null
      ? leader?.id === st.selfId && members.some((m) => m.id === offer.target)
      : offer.name != null ? leader?.id === st.selfId && members.some((m) => m.name === offer.name)
      : leader?.name === offer.inviter);
    st.partyType = matched ? offer.type : null;
    st.partyOffer = null;
  }
  if (members.length && (serverType === 0 || serverType === 1 || (st.partyLeaderLoot && serverType === 2))) {
    st.partyType = serverType; st.partyOffer = null; // Authoritative state survives refresh/reconnect.
  }
  st.party = members;
  renderParty();
}
const partyBox = document.createElement('div');
partyBox.id = 'party-box';
partyBox.className = 'hidden';
document.getElementById('hud').appendChild(partyBox);
partyBox.addEventListener('pointerdown', (e) => e.stopPropagation());
// 收合(只剩細血條,不擋畫面;使用者 10/19:整體不能佔太大):記在這台裝置
let partyMini = (() => { try { return localStorage.getItem('l1j.partyMini') === '1'; } catch { return false; } })();
// PartyHandoff: confirmation belongs to a specific member and expires after 3 seconds.
let partyHandoffId = null, partyHandoffUntil = 0, partyHandoffTimer = null;
function clearPartyHandoff() {
  clearTimeout(partyHandoffTimer);
  partyHandoffId = null; partyHandoffUntil = 0;
}
function renderParty() {
  const list = st.party || [];
  partyBox.classList.toggle('hidden', !list.length);
  partyBox.classList.toggle('mini', partyMini);
  partyBox.classList.toggle('leader-loot', st.partyType === 2);
  partyBox.innerHTML = '';
  const canHandoff = st.partyLeaderLoot && !partyMini && list.some((m) => m.id === st.selfId && m.leader);
  partyBox.classList.toggle('has-handoff', canHandoff);
  if (!canHandoff || !list.some((m) => m.id === partyHandoffId && m.id !== st.selfId) || performance.now() >= partyHandoffUntil) clearPartyHandoff();
  // 選定的隊友離隊了就取消選取
  if (st.allyTarget && !list.some((m) => m.id === st.allyTarget)) st.allyTarget = null;
  if (!list.length) return;
  const head = el('div', 'pm-head', `隊伍 ${list.length} · ${partyTypeName()} ${partyMini ? '▸' : '▾'}`);
  if (st.partyType === 1) head.title = PARTY_SPLIT_NOTE;
  if (st.partyType === 2) head.title = partyLeaderNote();
  head.onclick = () => {
    partyMini = !partyMini;
    try { localStorage.setItem('l1j.partyMini', partyMini ? '1' : '0'); } catch { /* 無痕模式 */ }
    renderParty();
  };
  partyBox.appendChild(head);
  if (st.clanParty) {
    const on = st.clanParty.on === true;
    const note = el('div', `pm-clan-note${on ? ' on' : ''}`,
      on ? (partyMini ? '血盟組隊' : '血盟組隊 · 野外 BOSS 掉落進血盟寶庫') : (partyMini ? '普通隊伍' : '普通組隊 · 掉落照原規則'));
    note.title = on ? '只有血盟組隊打的野外 BOSS 掉落與金幣進寶庫；附近本盟隊員與仍在隊上的傷害隊員列入參與者。' : '未開啟血盟組隊，掉落照原規則分配。';
    partyBox.appendChild(note);
    if (!partyMini && (st.clanParty.leaderHasClan || on) && list.some((m) => m.id === st.selfId && m.leader)) {
      const toggle = el('button', 'pm-clan-toggle', `血盟組隊：${on ? '開' : '關'}`);
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(on));
      toggle.title = on ? '切回普通組隊' : '開啟血盟組隊（全隊須為本盟成員，且寶庫已啟用）';
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (!st.clanParty || !st.party.some((m) => m.id === st.selfId && m.leader)) return;
        send({ t: 'partyclan', enabled: !st.clanParty.on });
      };
      partyBox.appendChild(toggle);
    }
  }
  for (const m of list) {
    const row = el('div', `pm${m.id === st.selfId ? ' me' : ''}${m.id === st.allyTarget ? ' sel' : ''}`);
    // 點隊友:選定為輔助魔法的對象(快捷欄的治癒術、加速術…放在他身上);再點一次 / 點自己取消
    row.onclick = () => {
      st.allyTarget = m.id === st.selfId || m.id === st.allyTarget ? null : m.id;
      toast(st.allyTarget ? `輔助魔法對象:${m.name}` : '輔助魔法對象:自己');
      renderParty();
    };
    row.appendChild(el('div', 'pm-name', `${m.leader ? '♛ ' : ''}${m.name}`));
    const hp = el('div', 'pm-bar hp'); hp.appendChild(el('i')); hp.firstChild.style.width = `${m.hp}%`;
    const mp = el('div', 'pm-bar mp'); mp.appendChild(el('i')); mp.firstChild.style.width = `${m.mp}%`;
    row.append(hp, mp);
    if (canHandoff && m.id !== st.selfId) {
      row.classList.add('pm-can-kick');
      const actions = canHandoff ? el('div', 'pm-actions') : row;
      if (canHandoff) row.classList.add('pm-can-handoff');
      if (canHandoff) {
        const handoff = el('button', 'pm-handoff', partyHandoffId === m.id ? '確定?' : '交接');
        handoff.type = 'button';
        handoff.title = `交接隊長給:${m.name}（同畫面、7格內）`;
        handoff.onclick = (e) => {
          e.stopPropagation();
          if (!st.partyLeaderLoot || partyMini || !st.party.some((v) => v.id === st.selfId && v.leader)
            || !st.party.some((v) => v.id === m.id && v.name === m.name && v.id !== st.selfId)) return;
          if (partyHandoffId === m.id && performance.now() < partyHandoffUntil) {
            clearPartyHandoff();
            send({ t: 'partyhandoff', target: m.id });
          } else {
            clearPartyHandoff();
            partyHandoffId = m.id; partyHandoffUntil = performance.now() + 3000;
            partyHandoffTimer = setTimeout(() => { clearPartyHandoff(); renderParty(); }, 3000);
          }
          renderParty();
        };
        actions.appendChild(handoff);
        row.appendChild(actions);
      }
    }
    partyBox.appendChild(row);
  }
  if (partyMini) return;
  const leave = el('button', 'pm-leave', '離開隊伍');
  leave.type = 'button';
  leave.onclick = () => send({ t: 'partyleave' });
  partyBox.appendChild(leave);
}

// 敵人清單(只有開啟強制攻擊 / PvP 才出現,在隊伍面板下面):周圍非隊友、非同血盟的玩家,由近到遠;點一下就鎖定攻擊
// 自己在安全區時整個隱藏;站在安全區裡的玩家也不列(打不到)
const enemyBox = document.createElement('div');
enemyBox.id = 'enemy-box';
enemyBox.className = 'hidden';
document.getElementById('hud').appendChild(enemyBox);
enemyBox.addEventListener('pointerdown', (e) => e.stopPropagation());
const inSafeZone = (x, y) => (tile(x, y) & 0x30) === 0x10;
function isWarEnemy(o) {
  return o?.kind === 'pc' && !!o.clan && st.clan?.mode === 'clan'
    && st.clan.wars?.some((w) => w.name === o.clan) && !inSafeZone(o.x, o.y);
}
function renderEnemies() {
  const me = self();
  const arena = inArenaEvent();
  const partyIds = new Set((st.party || []).map((m) => m.id));
  const list = !st.inGame || !me || inSafeZone(me.x, me.y) ? []
    : [...st.objects.values()]
      .filter((o) => o.kind === 'pc' && o.id !== st.selfId && !o.dead && (isWarEnemy(o) || (st.forceAttack && !partyIds.has(o.id)))
        && !(me.clan && o.clan === me.clan && !arena) && !inSafeZone(o.x, o.y)) // 血流成河:同血盟也是敵人
      .map((o) => ({ o, d: Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) }))
      .sort((a, b) => Number(isWarEnemy(b.o)) - Number(isWarEnemy(a.o)) || a.d - b.d);
  // 血流成河:積分王排在宣戰盟之後、其他玩家之前(名字前加 ★);不在視野裡也列出來,距離照伺服器送的位置
  const king = arena && st.arenaKing && performance.now() - st.arenaKing.at < 3000 && st.arenaKing.name !== me?.name ? st.arenaKing : null;
  if (king && st.inGame && me && !inSafeZone(me.x, me.y)) {
    const i = list.findIndex(({ o }) => o.name === king.name);
    const k = i >= 0 ? list[i] : { o: { id: 0, name: king.name, lawful: 0 }, d: Math.max(Math.abs(king.x - me.x), Math.abs(king.y - me.y)) };
    k.king = true;
    if (!isWarEnemy(k.o)) {
      if (i >= 0) list.splice(i, 1);
      const firstOther = list.findIndex(({ o }) => !isWarEnemy(o));
      list.splice(firstOther < 0 ? list.length : firstOther, 0, k);
    }
  }
  enemyBox.classList.toggle('hidden', !list.length);
  enemyBox.style.top = partyBox.classList.contains('hidden') ? '' : `${partyBox.offsetTop + partyBox.offsetHeight + 6}px`;
  const badgeKey = String(st.emblem) + list.map(({ o }) => String(st.clanEmblems?.[o.clan])).join(',');
  const key = badgeKey + list.map(({ o, d, king: kg }) => `${kg ? '★' : ''}${o.id}:${d}:${o.lawful}:${isPink(o.id) ? 1 : 0}:${o.name}`).join('|') + `|${st.target?.id}`;
  if (enemyBox.dataset.key === key) return; // 沒變就不重畫
  enemyBox.dataset.key = key;
  enemyBox.innerHTML = '';
  if (!list.length) return;
  enemyBox.appendChild(el('div', 'en-title', '周圍敵人'));
  for (const { o, d, king: kg } of list.slice(0, 8)) {
    const row = el('div', `en${o.id && st.target?.id === o.id ? ' sel' : ''}`);
    const nm = el('span', 'en-name', kg ? `★${o.name}` : o.name);
    nm.style.color = kg ? '#ffd700' : isPink(o.id) ? PINK_NAME : lawfulColor(o.lawful);
    if (st.emblem) {
      const id = Number(st.clanEmblems?.[o.clan]);
      if (Number.isSafeInteger(id) && id > 0) {
        const im = el('img'); im.alt = '';
        im.style.cssText = 'flex:0 0 16px;width:16px;height:12px;align-self:center;image-rendering:auto';
        im.onload = () => { if (im.naturalWidth <= 16) im.style.imageRendering = 'pixelated'; };
        im.onerror = () => im.remove(); im.src = emblemImg(id).src; row.appendChild(im);
      }
    }
    row.append(nm, el('span', 'en-dist', `${d}格`));
    row.onclick = () => {
      if (!o.id) { toast(`積分王 ${o.name} 在 ${d} 格外,看小地圖上的閃爍方塊`); return; }
      const current = st.objects.get(o.id), meNow = self();
      if (!current || current.dead || !meNow || inSafeZone(meNow.x, meNow.y) || inSafeZone(current.x, current.y)
          || (!st.forceAttack && !isWarEnemy(current))) return;
      st.target = { id: o.id, mode: 'attack' }; st.path = []; behavAccept(); toast(`鎖定攻擊:${o.name}`); renderEnemies();
    };
    enemyBox.appendChild(row);
  }
}
setInterval(renderEnemies, 400);

// 數字鍵盤(商店數量):1~9、最大、0、← ,取消 / 確定
function openNumpad(value, max, onOk) {
  document.getElementById('numpad')?.remove();
  const pad = el('div', '');
  pad.id = 'numpad';
  const box = el('div', 'np-box');
  const disp = el('div', 'np-disp', String(value));
  let text = String(value);
  let fresh = true; // 第一次按數字時取代原本的值
  const show = () => { disp.textContent = text || '0'; };
  const keys = el('div', 'np-keys');
  const key = (label, fn, cls = '') => { const b = el('button', `np-key ${cls}`, label); b.type = 'button'; b.onclick = fn; keys.appendChild(b); };
  const digit = (d) => () => {
    text = fresh ? String(d) : (text + d).replace(/^0+(?=\d)/, '');
    fresh = false;
    if (+text > max) text = String(max);
    show();
  };
  for (let d = 1; d <= 9; d++) key(String(d), digit(d));
  key('最大', () => { text = String(max); fresh = false; show(); });
  key('0', digit(0));
  key('←', () => { text = fresh ? '' : text.slice(0, -1); fresh = false; show(); });
  const foot = el('div', 'np-foot');
  const cancel = el('button', 'np-cancel', '取消');
  const ok = el('button', 'np-ok', '確定');
  cancel.type = ok.type = 'button';
  cancel.onclick = () => pad.remove();
  ok.onclick = () => { onOk(Math.max(1, Math.min(max, +text || 1))); pad.remove(); };
  foot.append(cancel, ok);
  box.append(disp, keys, foot);
  pad.appendChild(box);
  pad.onclick = (e) => { if (e.target === pad) pad.remove(); };
  $('#dialog').appendChild(pad);
}

// ---------------- 寵物 ----------------
// 寵物選單(S_PetMenuPacket anicom):參數 = 狀態、HP、最大 HP、MP、最大 MP、等級、名稱、飽食度、經驗 %、正義值
const PET_STATUS = { $469: '攻擊', $470: '防禦', $471: '休息', $472: '警戒' };
const PET_CMDS = [['aggressive', '攻擊'], ['defensive', '防禦'], ['stay', '休息'], ['extend', '散開'], ['alert', '警戒']];
// 寵物外型 → 種類(pettypes 的原形與進化形),顯示「名字(種類)」
const PET_SPECIES = { 96: '狼', 929: '聖伯納犬', 931: '杜賓狗', 934: '柯利', 936: '牧羊犬', 938: '小獵犬', 1540: '狐狸', 1642: '熊', 2145: '哈士奇', 3107: '高等哈士奇', 3132: '高等杜賓狗', 3134: '貓', 3143: '高等小獵犬', 3154: '高等暴走兔', 3156: '高等狐狸', 3178: '高等貓', 3182: '高等聖伯納犬', 3184: '高等牧羊犬', 3188: '高等熊', 3199: '高等狼', 3211: '高等柯利', 3783: '暴走兔', 4038: '浣熊', 4133: '高等浣熊', 4542: '老虎', 4582: '高麗犬', 5065: '高麗幼犬', 5089: '真．虎男', 6396: '黃金龍', 7365: '頑皮龍', 7369: '淘氣龍', 7604: '高等淘氣龍', 7609: '高等頑皮龍' };
function openPetMenu(ev) {
  const pet = st.objects.get(ev.id);
  const [status, hp, maxHp, mp, maxMp, lv, , , exp] = ev.args || [];
  const cur = PET_STATUS[status] || '休息';
  showDialog('寵物', '');
  dlg.npc = ev.id;
  dlg.mode = 'pet';
  const body = $('#dlg-body');
  const card = el('div', 'pet-card');
  const species = PET_SPECIES[pet?.gfx] || pet?.name || '寵物';
  card.append(
    el('div', 'pet-title', `${pet?.name || species}(${species}) Lv.${lv ?? '?'}  ${cur}`),
    el('div', 'pet-stat', `HP ${hp ?? '?'}/${maxHp ?? '?'}  MP ${mp ?? '?'}/${maxMp ?? '?'}  經驗 ${Math.max(0, Math.min(100, Number(exp) || 0))}%`),
  );
  const row = el('div', 'pet-cmds');
  for (const [action, label] of PET_CMDS) {
    const b = el('button', `pet-btn${cur === label ? ' on' : ''}`, label);
    b.type = 'button';
    b.onclick = () => { send({ t: 'npcaction', id: ev.id, action }); closeDialog(); toast(`寵物:${label}`); };
    row.appendChild(b);
  }
  // 存放寵物:直接收回項圈(伺服器 C_NPCAction depositself)
  const keep = el('button', 'pet-btn small', '存放寵物');
  keep.type = 'button';
  keep.onclick = () => { send({ t: 'npcaction', id: ev.id, action: 'depositself' }); closeDialog(); toast('寵物已存放回項圈'); };
  row.appendChild(keep);
  card.appendChild(row);
  // 改名(伺服器規則:每隻只能取一次名字、不能和別的寵物同名)
  const nameRow = el('div', 'pet-rename');
  const input = el('input');
  input.maxLength = 12;
  input.placeholder = '新名字 1~12 字';
  const go = el('button', 'pet-btn', '改名');
  go.type = 'button';
  go.onclick = () => {
    const n = input.value.trim();
    if (!n || n.length > 12 || /\s/.test(n)) { toast('名字 1~12 字,不能有空白'); return; }
    send({ t: 'npcaction', id: ev.id, action: `rename ${n}` });
    input.value = '';
  };
  nameRow.append(input, go);
  card.appendChild(nameRow);
  body.appendChild(card);
}
// 召喚獸選單(S_PetMenuPacket moncom):參數 = 狀態、HP、最大 HP、MP、最大 MP、等級;指令和寵物一樣,另有解散
function openSummonMenu(ev) {
  const mon = st.objects.get(ev.id);
  const [status, hp, maxHp, mp, maxMp, lv] = ev.args || [];
  const cur = PET_STATUS[status] || '休息';
  showDialog('召喚獸', '');
  dlg.npc = ev.id;
  dlg.mode = 'pet';
  const body = $('#dlg-body');
  const card = el('div', 'pet-card');
  card.append(
    el('div', 'pet-title', `${mon?.name || '召喚獸'} Lv.${lv ?? '?'}  ${cur}`),
    el('div', 'pet-stat', `HP ${hp ?? '?'}/${maxHp ?? '?'}  MP ${mp ?? '?'}/${maxMp ?? '?'}`),
  );
  const row = el('div', 'pet-cmds');
  for (const [action, label] of PET_CMDS) {
    const b = el('button', `pet-btn${cur === label ? ' on' : ''}`, label);
    b.type = 'button';
    b.onclick = () => { send({ t: 'npcaction', id: ev.id, action }); closeDialog(); toast(`召喚獸:${label}`); };
    row.appendChild(b);
  }
  // 解散:召喚獸直接消失(伺服器 L1SummonInstance dismiss)
  const bye = el('button', 'pet-btn small', '解散');
  bye.type = 'button';
  bye.onclick = () => { send({ t: 'npcaction', id: ev.id, action: 'dismiss' }); closeDialog(); toast('召喚獸已解散'); };
  row.appendChild(bye);
  card.appendChild(row);
  body.appendChild(card);
}
// ---------------- 製作(娜魯帕等,配方 = npcmenus.json craft,來自 ItemMaking.xml) ----------------
// 材料照名稱數身上的(裝備中的不算,和伺服器 checkItemNotEquipped 一樣);選好數量直接送 C_Amount,
// 伺服器 executeWithAmount 會再檢查材料、背包格數與重量,做好的東西直接進背包
function craftEnabled(r) {
  return !r.feature || st.craftFeatures?.includes(r.feature) === true;
}
function craftHave(material) {
  const m = typeof material === 'string' ? { name: material } : material;
  let n = 0;
  const key = nameKey(m.name);
  for (const it of st.inv.values()) {
    if (isEquipped(it)) continue;
    if (m.unsealedOnly && (it.bless == null || it.bless >= 128 || st.locks?.has(it.id))) continue;
    if (st.craftFeatures?.includes('SealedCraftEnabled') && st.locks?.has(it.id)) continue;
    if (m.enchant != null) {
      // Inventory IDs are object IDs. Use the displayed exact enchant and normal bless,
      // with itemId when supplied. Candidate L1ItemInstance.isIdentified() always returns true.
      if (st.locks?.has(it.id) || it.bless == null || (it.bless & 127) !== 1) continue;
      if (it.itemId != null && it.itemId !== m.itemId) continue;
      const match = String(it.name || '').match(/(?:^|\s)([+-]\d+)\s+(.+?)(?:\s*\(\d+\))?$/);
      if (!match || Number(match[1]) !== m.enchant
        || match[2].replace(/\s/g, '') !== m.baseName.replace(/\s/g, '')) continue;
    } else if (nameKey(it.name) !== key) continue;
    n += Math.max(1, it.count || 1);
  }
  return n;
}
// Server-issued preview: use the same in-game confirmation style as crafting and teleporting.
function confirmSealedCraft(ev) {
  const [action, text] = (ev.args || []).filter(Boolean); // 主導 11/14:S_NPCTalkReturn 解出來的 args 最前面有一個空字串
  if (!/^sealcraft [0-9a-f-]{36}$/.test(action || '') || !text) return;
  const refresh = dlg.mode === 'craft' && dlg.npc === ev.id ? dlg.craftRefresh : null;
  dlg.sealcraft = true;
  const body = $('#dlg-body'), list = [...body.children];
  list.forEach((c) => c.classList.add('hidden'));
  $('#dialog').classList.remove('hidden');
  const box = el('div', 'tp-confirm');
  box.append(el('p', 'tp-q', text));
  const row = el('div', 'tp-row');
  const yes = el('button', 'menu-btn tp-yes', '確認刻印製作');
  const no = el('button', 'menu-btn tp-no', '取消');
  yes.type = no.type = 'button';
  const restore = () => { dlg.sealcraft = false; box.remove(); list.forEach((c) => c.classList.remove('hidden')); };
  yes.onclick = () => {
    yes.disabled = true;
    send({ t: 'amount', id: ev.id, amount: 1, action });
    restore();
    if (refresh) setTimeout(refresh, 600);
  };
  no.onclick = restore;
  row.append(yes, no); box.append(row); body.append(box);
}
function conditionalCraft(r) {
  return r.single === true || r.mats.some((m) => m.enchant != null);
}
function confirmCraft(r, make) {
  const body = $('#dlg-body');
  const list = [...body.children];
  list.forEach((c) => c.classList.add('hidden'));
  const box = el('div', 'tp-confirm');
  const materials = r.mats.filter((m) => m.enchant != null);
  const text = r.single === true && typeof r.confirmText === 'string' ? r.confirmText : materials.length === 1 && materials[0].itemId === 41 && materials[0].enchant === 9 && materials[0].n === 1
    ? '會用掉一把 +9 武士刀(屬性強化不保留),確定製作?'
    : `會消耗 ${materials.map((m) => `+${m.enchant} ${m.baseName || m.name} ×${fmt(m.n)}`).join('、')}；成品為 +0，原物品的強化 / 屬性不保留。確定製作?`;
  box.append(el('p', 'tp-q', text));
  const row = el('div', 'tp-row');
  const yes = el('button', 'menu-btn tp-yes', '確定製作');
  const no = el('button', 'menu-btn tp-no', '取消');
  yes.type = no.type = 'button';
  const restore = () => { box.remove(); list.forEach((c) => c.classList.remove('hidden')); };
  yes.onclick = () => { yes.disabled = true; restore(); make(); };
  no.onclick = restore;
  row.append(yes, no);
  box.append(row);
  body.append(box);
}
// 做一種東西:材料不夠就提示差多少;夠做好幾份先選數量,再送 C_Amount;after = 做完 0.6 秒後刷新畫面
function craftRecipe(npcId, r, after, confirmed = false) {
  if (!craftEnabled(r)) return;
  const sets = Math.min(...r.mats.map((m) => Math.floor(craftHave(m) / m.n)));
  if (sets <= 0) {
    const lack = r.mats.filter((m) => craftHave(m) < m.n).map((m) => `${m.name} 差 ${fmt(m.n - craftHave(m))}`);
    toast(`材料不夠:${lack.join('、')}`);
    return;
  }
  if (conditionalCraft(r) && !confirmed) {
    confirmCraft(r, () => craftRecipe(npcId, r, after, true));
    return;
  }
  const make = (n) => { if (!craftEnabled(r)) return; send({ t: 'amount', id: npcId, amount: n, action: r.action }); if (after) setTimeout(after, 600); };
  if (sets === 1 || conditionalCraft(r)) make(1); else openNumpad(1, sets, make);
}
// 所有製作入口共用清單與詳情，對話本身仍沿用原樣式。
function craftButton(npcId, npcName, menu) {
  const recipes = menu.craft.filter(craftEnabled);
  if (!recipes.length) return;
  menuButton(menu.craftLabel || '製作清單', `${recipes.length} 種`,
    () => openCraft(npcId, npcName, menu.craft, menu.craftLabel));
}
function craftLink(npcId, r, label) {
  const a = el('a', 'npc-act', label);
  a.href = '#';
  a.onclick = (e) => {
    e.preventDefault();
    const o = st.objects.get(npcId);
    openCraft(npcId, o?.name, o?.menu?.craft || [r], o?.menu?.craftLabel, { selected: r });
  };
  return a;
}
function craftSets(r) {
  return Math.min(...r.mats.map((m) => Math.floor(craftHave(m) / m.n)));
}
function craftInfo(r) {
  if (r.fullName) return { name: r.item.name, desc: r.desc || '' }; // 11/23 使用者:王者之劍兌換要顯示完整書名
  const parts = r.item.name.match(/^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/);
  return { name: parts ? parts[1] : r.item.name, desc: r.desc || (parts ? parts[2] : '') };
}
function craftIcon(item) {
  const wrap = el('span', 'craft2-icon');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', item.name);
  wrap.append(iconCanvas(item, 26)); // 11/08 使用者:圖示中間有東西擋住 = 墊底的 ◆ 替代字透出來,拿掉(iconCanvas 自己有替代圖)
  return wrap;
}
function craftDetail(npcId, r, after, back) {
  const sec = el('section', 'craft2-detail');
  const ret = el('button', 'craft2-back', '← 返回清單');
  ret.type = 'button'; ret.onclick = back;
  const info = craftInfo(r);
  const heading = el('h3', 'craft2-heading', info.name);
  heading.prepend(craftIcon({ ...r.item, name: info.name }));
  const content = el('div', 'craft2-detail-scroll');
  content.append(ret, heading);
  if (info.desc) content.append(el('p', 'craft2-description', info.desc));
  const table = el('table', 'craft2-table');
  const head = el('thead'); const titles = el('tr');
  for (const title of ['材料', '需要', '身上']) {
    const th = el('th', '', title); th.scope = 'col'; titles.append(th);
  }
  head.append(titles);
  const body = el('tbody');
  for (const m of r.mats) {
    const have = craftHave(m), enough = have >= m.n;
    const row = el('tr');
    const name = el('td');
    const label = el('span', 'craft2-material', m.name + (m.unsealedOnly ? '（未刻印）' : ''));
    label.prepend(craftIcon({ name: m.baseName || m.name, gfx: m.gfx })); // 11/08 配方資料帶 gfx(invgfx)就用它,名稱對錯圖
    name.append(label);
    const owned = el('td', enough ? 'craft2-enough' : 'craft2-lack', `${enough ? '✓ ' : ''}${fmt(have)}`);
    row.append(name, el('td', '', fmt(m.n)), owned); body.append(row);
  }
  table.append(head, body);
  const sets = craftSets(r);
  const limit = conditionalCraft(r) ? Math.min(1, sets) : sets;
  const status = el('p', limit > 0 ? 'craft2-enough' : 'craft2-muted', limit > 0 ? ((r.item.n || 1) > 1 ? `每次產出 ${fmt(r.item.n)} 個` : '') : '材料不足'); // 11/13 使用者:不顯示「可製作 N 次」
  if (!status.textContent) status.hidden = true;
  const make = el('button', 'craft2-make', limit <= 0 ? '材料不足' : limit > 1 ? '選擇數量並製作' : '製作');
  make.type = 'button';
  make.onclick = () => craftRecipe(npcId, r, after);
  content.append(table);
  const actions = el('div', 'craft2-actions');
  if (limit > 0) actions.append(status); // 11/08:材料不足時只留按鈕,不重複寫兩次
  actions.append(make);
  sec.append(content, actions);
  return sec;
}
function openCraft(npcId, npcName, recipes, craftLabel, state = {}) {
  const enabled = recipes.filter(craftEnabled);
  if (!enabled.includes(state.selected)) state.selected = null;
  showDialog(recipes.find((x) => x.title)?.title || npcName || 'NPC', ''); // 11/23 使用者:王族魔法書商人的兌換標題要叫「製作魔法」
  dlg.npc = npcId; dlg.mode = 'craft';
  const box = el('div', 'craft2-shell');
  box.append(el('p', 'craft2-greeting', craftLabel || '帶齊材料，請選擇要製作的成品。'));
  const layout = el('div', 'craft2-layout');
  const left = el('section', 'craft2-list-pane');
  const list = el('div', 'craft2-list');
  const right = el('div', 'craft2-detail-pane');
  const refresh = () => {
    if (!dlg.sealcraft && dlg.mode === 'craft' && dlg.npc === npcId && box.isConnected) {
      state.scroll = list.scrollTop;
      openCraft(npcId, npcName, recipes, craftLabel, state);
    }
  };
  dlg.craftRefresh = refresh;
  const select = (r) => {
    state.selected = r;
    box.classList.toggle('craft2-has-detail', !!r);
    right.replaceChildren(r ? craftDetail(npcId, r, refresh, () => select(null)) : el('p', 'craft2-placeholder', '請從清單選擇成品查看材料。'));
    for (const b of list.children) b.setAttribute('aria-pressed', String(b.recipe === r));
  };
  const renderList = () => {
    list.replaceChildren();
    const query = (state.query || '').trim().toLocaleLowerCase();
    for (const r of enabled) {
      const sets = craftSets(r);
      if ((state.only && sets <= 0) || !r.item.name.toLocaleLowerCase().includes(query)) continue;
      const info = craftInfo(r);
      const card = el('button', 'craft2-card'); card.type = 'button'; card.recipe = r;
      card.setAttribute('aria-pressed', String(state.selected === r));
      const text = el('span', 'craft2-card-text');
      const limit = conditionalCraft(r) ? Math.min(1, sets) : sets;
      // 11/08 使用者:卡片不顯示「N 種材料」「材料不足」;有說明才顯示說明,夠做才顯示可製作次數
      text.append(el('strong', 'craft2-name', `${info.name}${r.item.n > 1 ? ` × ${fmt(r.item.n)}` : ''}`));
      // 11/08 使用者:「保持乾淨」,卡片只放名稱(和夠做時的次數),說明只在詳情頁
      // 11/13 使用者:卡片也不顯示「可製作 N 次」
      card.append(craftIcon({ ...r.item, name: info.name }), text);
      card.onclick = () => select(r); list.append(card);
    }
    if (!list.children.length) list.append(el('p', 'craft2-empty', '沒有符合條件的配方。'));
  };
  if (enabled.length >= 6) {
    const tools = el('div', 'craft2-tools');
    const search = el('input', 'craft2-search'); search.type = 'search'; search.placeholder = '搜尋成品名稱';
    search.setAttribute('aria-label', '搜尋成品名稱'); search.value = state.query || '';
    search.oninput = () => { state.query = search.value; state.scroll = 0; renderList(); };
    const label = el('label', 'craft2-filter');
    const check = el('input'); check.type = 'checkbox'; check.checked = !!state.only;
    check.onchange = () => { state.only = check.checked; state.scroll = 0; renderList(); };
    label.append(check, el('span', '', '只看可製作')); tools.append(search, label); left.append(tools);
  }
  left.append(list); layout.append(left, right); box.append(layout);
  $('#dlg-body').append(box);
  renderList(); select(state.selected); list.scrollTop = state.scroll || 0;
}
const ELF_ATTR_NAME = { 1: '地', 2: '火', 4: '水', 8: '風' }; // characters.ElfAttr
// ---------------- 原版對話頁(1.82 客戶端文字,tools/build_dialogs.py → dialogs.json) ----------------
// 伺服器 S_NPCTalkReturn 送頁面代碼(例如 fairye1),這裡照原版顯示文字;
// 藍字 = 換頁(只在網頁換,不用問伺服器),金字 = 動作(製作的走 craftRecipe 選數量,其他照原樣送給伺服器)
const DIALOG_VER = 7; // 重跑 build_dialogs.py 之後加 1
let dialogPages = {};
fetch(`dialogs.json?v=${DIALOG_VER}`).then((r) => (r.ok ? r.json() : {})).then((d) => { dialogPages = d || {}; }).catch(() => {});
function openDialogPage(npcId, pageId) {
  const lines = dialogPages[pageId];
  if (!lines) return false;
  const o = st.objects.get(npcId);
  showDialog(o?.name || 'NPC', '');
  dlg.npc = npcId;
  dlg.mode = 'menu';
  dlg.page = pageId;
  const box = el('div', 'npc-page');
  for (const line of lines) {
    const p = el('p', line.length ? 'npc-line' : 'npc-gap');
    for (const part of line) {
      if (typeof part === 'string') { p.appendChild(document.createTextNode(part)); continue; }
      const recipe = o?.menu?.craft?.find((r) => r.action.toLowerCase() === part.a?.toLowerCase() || r.action.toLowerCase() === part.a?.toLowerCase().replace(/\d+$/, ''));
      if (recipe && !craftEnabled(recipe)) continue;
      const a = el('a', part.a ? 'npc-act' : 'npc-link', part.t);
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); dialogAction(npcId, part, o?.menu); };
      p.appendChild(a);
    }
    box.appendChild(p);
  }
  // 原版對話裡已經有連結的配方不再另外列(精靈們都有);只補原版沒有的(例如安特的「給予蘑菇汁」),
  // 而且排成原版的樣子:接在對話文字後面的金字連結
  const extra = (o?.menu?.craft || []).filter((r) => craftEnabled(r) && !dialogHasAction(r.action));
  const refresh = () => { if (dlg.npc === npcId && dlg.mode === 'menu') openDialogPage(npcId, pageId); };
  // 有開關的追加配方共用同一份製作清單。
  if (extra.some((r) => r.feature)) {
    const line = el('p', 'npc-line');
    const link = el('a', 'npc-act', o.menu.craftLabel || '製作清單');
    link.href = '#';
    link.onclick = (e) => { e.preventDefault(); openCraft(npcId, o.name, o.menu.craft, o.menu.craftLabel); };
    line.appendChild(link);
    box.append(el('p', 'npc-gap'), line);
    extra.length = 0;
  }
  for (const r of extra) {
    const line = el('p', 'npc-line');
    line.appendChild(craftLink(npcId, r, extra.length === 1 && o.menu.craftLabel ? o.menu.craftLabel : `製造${r.item.name}`, refresh));
    box.append(el('p', 'npc-gap'), line);
  }
  $('#dlg-body').appendChild(box);
  return true;
}
// 這個動作有沒有出現在任何原版對話頁的連結裡(比對時忽略大小寫與結尾數字,同 dialogAction)
let dialogActs = null;
function dialogHasAction(action) {
  if (!dialogActs) {
    dialogActs = new Set();
    for (const lines of Object.values(dialogPages)) for (const line of lines) for (const p of line) if (p?.a) dialogActs.add(p.a.toLowerCase().replace(/\d+$/, ''));
  }
  return dialogActs.has(action.toLowerCase().replace(/\d+$/, ''));
}
function dialogAction(npcId, part, menu) {
  if (part.l) { if (!openDialogPage(npcId, part.l)) toast('這一頁沒有內容'); return; }
  const act = part.a.toLowerCase();
  // 客戶端的動作名稱偶爾和伺服器配方差一個數字尾巴(例如 request mithril arrow2)
  const r = menu?.craft?.find((c) => c.action.toLowerCase() === act || c.action.toLowerCase() === act.replace(/\d+$/, ''));
  if (r && !craftEnabled(r)) return;
  if (r) { openCraft(npcId, st.objects.get(npcId)?.name, menu.craft, menu.craftLabel, { selected: r }); return; }
  send({ t: 'npcaction', id: npcId, action: part.a });
}
// 寵物管理員:領出寵物(S_PetList,清單是身上的寵物項圈;網頁版不收錢)
// 清單不關:一次點完要領的寵物(帶不了那麼多時伺服器會回「你無法一次控制那麼多寵物」)
function openPetWithdraw(ev) {
  showDialog('領出寵物', '');
  const body = $('#dlg-body');
  if (!ev.items.length) body.appendChild(el('p', 'empty', '沒有可以領出的寵物。'));
  for (const it of ev.items) {
    const b = el('button', 'menu-btn', '');
    b.type = 'button';
    const tag = el('small', '', '領出');
    b.append(el('span', '', itemLabel(it)), tag);
    b.onclick = () => {
      if (b.disabled) return;
      send({ t: 'result', npc: ev.npc, type: 12, lines: [[it.id, 1]] });
      b.disabled = true; b.classList.add('done'); tag.textContent = '已領出';
    };
    body.appendChild(b);
  }
}
// 捕捉:正在攻擊的對象是可以馴服的狗時,牠頭上出現圓形「捕捉」;按下去 = 把一塊漂浮之眼肉給牠(伺服器判定:牠的血要低於 1/3)
const TAMABLE = new Set(['杜賓狗', '狼', '小獵犬', '牧羊犬']);
const TAME_FOOD = '漂浮之眼肉';
const captureBtn = document.createElement('button');
captureBtn.id = 'capture-btn';
captureBtn.type = 'button';
captureBtn.className = 'hidden';
captureBtn.innerHTML = '<span class="cap-ico"></span><span class="cap-txt">捕捉</span>';
let captureIcon = false;
document.getElementById('hud').appendChild(captureBtn);
let captureTarget = null;
captureBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
captureBtn.onclick = () => {
  const o = captureTarget && st.objects.get(captureTarget);
  if (!o) return;
  const meat = [...st.inv.values()].find((i) => i.name.replace(/\s*\(\d+\)$/, '').replace(/\s/g, '') === TAME_FOOD); // 道具名稱是「漂浮之眼 肉」(中間有空格)
  if (!meat) { toast(`身上沒有${TAME_FOOD}`); return; }
  // 要站在牠旁邊一格才能給(伺服器也會擋);不在旁邊就先走過去,到了再給(app.js 追目標的 'tame')
  st.target = { id: o.id, mode: 'tame', item: meat.id };
  st.path = [];
  behavAccept();
};
function giveMeat(o, itemId) {
  send({ t: 'giveitem', target: o.id, x: o.x, y: o.y, item: itemId, count: 1 });
  toast(o.hpRatio >= 0 && o.hpRatio < 33 ? `給了${o.name}一塊肉…` : `給了${o.name}一塊肉(血量要低於 1/3 才能馴服)`);
}
// GM 給予(11/01):只有 GM 收到 {t:'gm'} 才建立按鈕和視窗(一般玩家的畫面上沒有這些元素);伺服器也只讓 GM 給怪物任意道具
// 按「給予」→ 點一隻怪 → 從背包選道具給牠;怪物死掉時照一般掉落分給打死的人。15 格內都能給,不用走過去
const gmGive = { btn: null, box: null, picking: false, target: null };
function gmGiveOn() {
  if (gmGive.btn) return;
  const b = document.createElement('button');
  b.id = 'gm-give-btn';
  b.type = 'button';
  b.textContent = '給予';
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.onclick = () => {
    gmGive.picking = !gmGive.picking;
    b.classList.toggle('on', gmGive.picking);
    toast(gmGive.picking ? 'GM 給予:點一隻怪物' : '已取消給予');
  };
  document.getElementById('hud').appendChild(b);
  gmGive.btn = b;
}
function gmGiveOff() {
  gmGive.btn?.remove(); gmGive.box?.remove();
  gmGive.btn = gmGive.box = null; gmGive.picking = false; gmGive.target = null;
}
function gmGivePick(o) {
  gmGive.picking = false;
  gmGive.btn?.classList.remove('on');
  gmGive.target = o.id;
  if (!gmGive.box) {
    const sec = document.createElement('section');
    sec.id = 'gm-give';
    sec.setAttribute('role', 'dialog');
    sec.innerHTML = '<div class="learn-box"><h3 class="plank">GM 給予</h3><button type="button" class="x-btn" aria-label="關閉">✕</button>'
      + '<div class="learn-head"><span class="gm-give-who"></span></div><div class="gm-give-list"></div></div>';
    sec.querySelector('.x-btn').onclick = () => { sec.classList.add('hidden'); gmGive.target = null; };
    document.getElementById('hud').appendChild(sec);
    gmGive.box = sec;
  }
  gmGive.box.classList.remove('hidden');
  gmGiveRender();
}
function gmGiveRender() {
  const box = gmGive.box;
  if (!box || box.classList.contains('hidden')) return;
  const o = st.objects.get(gmGive.target);
  box.querySelector('.gm-give-who').textContent = o && !o.dead ? `給 ${o.name}(打死牠的人拿走)` : '這隻怪物已經不在了';
  const list = box.querySelector('.gm-give-list');
  list.innerHTML = '';
  const items = [...st.inv.values()].filter((it) => !isEquipped(it) && !st.locks?.has(it.id) && it.name);
  if (!items.length) { list.appendChild(el('p', 'learn-empty', '背包裡沒有可以給的道具。')); return; }
  for (const it of items) {
    const row = el('div', 'learn-row');
    row.appendChild(iconCanvas(it, 48));
    row.appendChild(el('div', 'learn-info', '')).appendChild(el('b', '', itemLabel(it)));
    const go = el('button', 'learn-btn', '給予');
    go.type = 'button';
    go.onclick = () => {
      const m = st.objects.get(gmGive.target), me = self();
      if (!m || m.dead || m.dying) { toast('這隻怪物已經不在了'); return; }
      if (!me || Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) > 15) { toast('太遠了(15 格內才能給)'); return; }
      const give = (n) => { if (n > 0) { send({ t: 'giveitem', target: m.id, x: m.x, y: m.y, item: it.id, count: n }); toast(`給了 ${m.name}:${it.name.replace(/\s*\(\d+\)$/, '')}${n > 1 ? ` ×${n}` : ''}`); setTimeout(gmGiveRender, 600); } };
      if (it.count > 1) openNumpad(it.count, it.count, give); else give(1);
    };
    row.appendChild(go);
    list.appendChild(row);
  }
}
function updateCaptureBtn() {
  const me = self();
  let best = null;
  if (me && st.inGame && !me.dead) {
    // 目前選定的攻擊目標(正在走過去 / 正在打)
    const id = st.target?.mode === 'attack' ? st.target.id : null;
    const o = id != null && st.objects.get(id);
    if (o && o.kind === 'monster' && !o.dead && !o.dying && TAMABLE.has(o.name)) best = o;
  }
  if (best && !captureIcon && typeof iconCanvas === 'function') { // 圖示:漂浮之眼肉
    captureIcon = true;
    const meat = [...st.inv.values()].find((i) => i.name.replace(/\s/g, '').startsWith(TAME_FOOD));
    captureBtn.querySelector('.cap-ico').appendChild(iconCanvas(meat || { name: '漂浮之眼 肉' }, 26));
  }
  captureTarget = best?.id ?? null;
  captureBtn.classList.toggle('hidden', !best);
  if (best) {
    const p = toScreen(best.px, best.py);
    captureBtn.style.left = `${p.x * ZOOM}px`;
    captureBtn.style.top = `${(p.y - 56) * ZOOM}px`;
  }
}

function openShopBuy(ev) {
  shopCards(ev, ev.items.map((i) => ({ key: i.order, name: i.name, icon: { name: i.name, gfx: i.gfx }, price: i.price, max: 999 })), 'buy'); // 圖示用商店給的圖片編號(新道具的名稱不在圖示表裡)
}

function openShopSell(ev) {
  if (ev.items.some((i) => !st.inv.has(i.id))) invResync(true); // 賣出清單有網頁背包沒有的道具(「道具 #編號」):背包對一次
  const rows = ev.items.filter((i) => !st.locks?.has(i.id)).map((i) => { // 鎖住的不列在販售清單
    const it = st.inv.get(i.id);
    return { key: i.id, name: it ? itemLabel(it).replace(/\s*\(\d+\)$/, '') : `道具 #${i.id}`, icon: it, price: i.price, max: it ? Math.max(1, it.count) : 1 };
  });
  shopCards(ev, rows, 'sell');
}

// 學習魔法(S_SkillBuy / C_SkillBuyOK):1~3 階一般魔法,價格 100 / 400 / 900;職業與等級限制由伺服器檢查
const SPELL_PRICE = { 1: 100, 2: 400, 3: 900 };
// 學習魔法:商店樣式,每個魔法一列,按「學習」就學那一個;學會的會從清單消失
const learn = { ids: [], npcName: '' };
function openSkillBuy(ev) {
  closeDialog();
  learn.ids = ev.ids;
  learn.npcName = st.objects.get(dlg.npc)?.name || '';
  $('#learn').classList.remove('hidden');
  renderLearn();
}
function renderLearn() {
  if ($('#learn').classList.contains('hidden')) return;
  const skills = st.game?.skills || {};
  const ids = learn.ids.filter((id) => skills[id] && SPELL_PRICE[skills[id].level] && !st.skills.has(id));
  $('#learn-npc').textContent = learn.npcName ? `${learn.npcName}(魔法傳授者)` : '魔法傳授者';
  $('#learn-gold').textContent = fmt(adena());
  const list = $('#learn-list');
  list.innerHTML = '';
  if (!ids.length) { list.appendChild(Object.assign(document.createElement('p'), { className: 'learn-empty', textContent: '目前沒有可以學習的魔法。' })); return; }
  for (const id of ids) {
    const sk = skills[id];
    const price = SPELL_PRICE[sk.level];
    const row = document.createElement('div');
    row.className = 'learn-row';
    const c = document.createElement('canvas');
    c.width = c.height = 48 * DPR;
    const draw = () => {
      const g = c.getContext('2d');
      if (!GDX.drawNamed(g, `魔法書(${sk.name})`, 0, 0, c.width) && !GDX.drawNamed(g, sk.name, 0, 0, c.width)) setTimeout(draw, 500);
    };
    draw();
    row.appendChild(c);
    const info = document.createElement('div');
    info.className = 'learn-info';
    info.innerHTML = '<b></b><span class="gold"></span>';
    info.querySelector('b').textContent = sk.name;
    info.querySelector('.gold').textContent = fmt(price);
    row.appendChild(info);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'learn-btn';
    btn.textContent = '學習';
    btn.onclick = () => {
      if (price > adena()) { toast('金幣不足'); return; }
      btn.disabled = true;
      btn.textContent = '…';
      send({ t: 'skillbuyok', ids: [id] }); // 學會後伺服器送 addskill,這一列就會消失
      setTimeout(() => { if (!st.skills.has(id)) { btn.disabled = false; btn.textContent = '學習'; } }, 3000);
    };
    row.appendChild(btn);
    list.appendChild(row);
  }
}
$('#learn-close').onclick = () => $('#learn').classList.add('hidden');


function adena() {
  for (const it of st.inv.values()) if (/^金幣/.test(it.name)) return it.count;
  return 0;
}

// 聊天、背包、HUD 與各面板在 hud.js

// ---------------- 輸入 ----------------
const canvas = $('#world');
const canvasCtx = canvas.getContext('2d');
let ctx = canvasCtx;


// WebGL records overlay commands plus direct retained-world descriptions.
// Selection/SFX/fades happen once; failed submits replay the same data on Canvas.
const WORLD = { renderer: null, reason: '', loading: false, layer: 'floor', recording: null };
const WORLD_PROPS = ['direction', 'fillStyle', 'filter', 'font', 'fontKerning', 'fontStretch', 'fontVariantCaps',
  'globalAlpha', 'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality',
  'letterSpacing', 'lineCap', 'lineDashOffset', 'lineJoin', 'lineWidth', 'miterLimit',
  'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'strokeStyle', 'textAlign',
  'textBaseline', 'textRendering', 'wordSpacing'];
const WORLD_PAINT = new Set(['drawImage', 'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'putImageData']);
let worldMeasureContext = null;
function worldLayer(layer) { const previous = WORLD.layer; WORLD.layer = layer; return previous; }
function worldBackendStats() {
  return { name: WORLD.renderer ? 'WebGL' : 'Canvas', reason: WORLD.reason || (WORLD.loading ? 'Initializing WebGL' : ''),
    ...(WORLD.renderer ? WORLD.renderer.stats() : { drawCalls: 0, textures: 0, estimatedVRAMBytes: 0 }) };
}
function worldFallback(error) {
  WORLD.reason = String(error?.message || error);
  const renderer = WORLD.renderer; WORLD.renderer = null;
  try { renderer?.destroy(); } catch { /* Keep the Canvas escape path usable. */ }
  document.getElementById('world-gl')?.remove();
}
function worldScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = src;
    script.onload = resolve; script.onerror = () => reject(Error('Cannot load ' + src));
    document.head.appendChild(script);
  });
}
async function initWorldBackend(cfg) {
  if (cfg.webglProto !== true || new URLSearchParams(location.search).get('gl') !== '1') return;
  WORLD.loading = true;
  try {
    await worldScript('vendor/pixi-8.6.6.min.js');
    await worldScript('webgl.js');
    WORLD.renderer = await window.createWorldWebGL(canvas, worldFallback);
  } catch (error) { worldFallback(error); }
  finally { WORLD.loading = false; }
}
function buildScene(now, produce = buildWorldScene) {
  // The tiny context provides native text metrics, gradients and transform/state
  // tracking, but executes no paint. It never allocates a world-sized bitmap.
  worldMeasureContext ||= document.createElement('canvas').getContext('2d');
  const measure = worldMeasureContext, commands = [], initial = [];
  measure.canvas.width = 1; measure.canvas.height = 1;
  for (const key of WORLD_PROPS) if (key in canvasCtx) {
    measure[key] = canvasCtx[key]; initial.push({ key, value: canvasCtx[key] });
  }
  const transform = canvasCtx.getTransform();
  measure.setTransform(transform); measure.setLineDash(canvasCtx.getLineDash());
  initial.push({ name: 'setTransform', args: [transform] }, { name: 'setLineDash', args: [canvasCtx.getLineDash()] });
  const stack = []; let clipped = false, pathEmpty = true, ellipse = null;
  const recorder = new Proxy(measure, {
    get(target, key) {
      if (key === 'canvas') return canvas;
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        // Return values are resolved during production only (not during submit).
        if (/^(create|measure|get|is)/.test(key)) return value.apply(target, args);
        const paint = WORLD_PAINT.has(key);
        const command = { name: key, args, layer: WORLD.layer, paint, clipped, order: WORLD.rankCursor ?? 0 };
        if (paint) {
          const m = target.getTransform(); command.matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
          command.alpha = target.globalAlpha; command.blend = target.globalCompositeOperation;
          command.smooth = target.imageSmoothingEnabled;
          command.fill = target.fillStyle;
          if (key === 'fill' && ellipse && (!args.length || args[0] === 'nonzero')) {
            command.ellipse = ellipse.args; command.matrix = ellipse.matrix;
          }
        }
        commands.push(command);
        if (key === 'beginPath') { pathEmpty = true; ellipse = null; }
        else if (key === 'ellipse' && pathEmpty && args[4] === 0 && args[5] === 0 && args[6] === Math.PI * 2) {
          const m = target.getTransform(); ellipse = { args: args.slice(0, 4), matrix: [m.a, m.b, m.c, m.d, m.e, m.f] }; pathEmpty = false;
        } else if (['arc', 'arcTo', 'ellipse', 'lineTo', 'moveTo', 'rect', 'roundRect', 'bezierCurveTo', 'quadraticCurveTo'].includes(key)) {
          pathEmpty = false; ellipse = null;
        }
        if (key === 'save') stack.push(clipped);
        if (key === 'restore') clipped = stack.pop() ?? false;
        if (key === 'clip') clipped = true;
        if (!paint) return value.apply(target, args);
      };
    },
    set(target, key, value) {
      target[key] = value; commands.push({ key, value }); return true;
    }
  });
  WORLD.layer = 'floor'; WORLD.recording = commands; WORLD.rankCursor = 0;
  ctx = recorder;
  try { produce(now); }
  finally { ctx = canvasCtx; WORLD.recording = null; }
  return { commands, initial, width: canvas.width, height: canvas.height, retained: commands.retained };
}
function paintWorldImages(context, images, scene, clip) {
  context.save();
  try {
    if (clip) { context.beginPath(); clip.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath(); context.clip(); }
    if (images.shadow) {
      context.fillStyle = 'rgba(0,0,0,.28)';
      context.beginPath(); context.ellipse(...images.shadow, 0, 0, Math.PI * 2); context.fill();
    }
    for (const d of images) {
      context.save();
      context.imageSmoothingEnabled = d.smooth ?? true;
      context.globalAlpha *= d.alpha ?? 1;
      context.globalCompositeOperation = d.blend || 'source-over';
      const [sx, sy, w, h] = d.cell;
      const dx = d.dx + (d.world ? scene.retained.cameraX : 0), dy = d.dy + (d.world ? scene.retained.cameraY : 0);
      context.drawImage(d.img, sx, sy, w, h, dx, dy, d.width ?? w * d.scale[0], d.height ?? h * d.scale[1]);
      context.restore();
    }
  } finally { context.restore(); }
}
function submitCanvasScene(scene) {
  for (const command of scene.commands) {
    if (command.mapObject) {
      const e = command.mapObject;
      canvasCtx.save(); canvasCtx.imageSmoothingEnabled = false; canvasCtx.globalAlpha = command.alpha;
      canvasCtx.drawImage(e.img, ...e.c, e.left, e.top, e.c[2], e.c[3]); canvasCtx.restore();
    } else if (command.images) paintWorldImages(canvasCtx, command.images, scene, command.clip);
    else if (command.key) canvasCtx[command.key] = command.value;
    else canvasCtx[command.name](...command.args);
  }
}
function draw(now) {
  RM.sceneMs = 0;
  const sceneStart = RM.active ? RM.clock() : 0;
  // 11/10 主導:沒有啟用 WebGL(一般玩家 / 開關關)時直接畫在原畫布,不錄製 / 重播
  //(錄製每幀上千筆指令會多配置物件、多讀矩陣,Canvas 會比原本慢;開關關 = 行為與成本都不變)
  if (!WORLD.renderer) {
    WORLD.layer = 'floor';
    buildWorldScene(now);
    if (RM.active) { RM.sceneMs = RM.clock() - sceneStart; RM.add('scene', RM.sceneMs); }
    return;
  }
  let scene;
  try { scene = buildScene(now, buildRetainedWorldScene); }
  catch (error) { worldFallback(error); return; } // Next frame uses Canvas; never rerun partial animation/SFX.
  if (RM.active) { RM.sceneMs = RM.clock() - sceneStart; RM.add('scene', RM.sceneMs); }
  if (WORLD.renderer && st.inGame && st.map) {
    try {
      WORLD.renderer.render(scene, canvasCtx);
      if (RM.active) { const stats = WORLD.renderer.stats(); RM.add('webglDrawCalls', stats.drawCalls); RM.add('webglTextureBytes', stats.textureBytes); }
      return;
    }
    catch (error) { worldFallback(error); }
  }
  // A failed WebGL submit consumes this very scene: never pick frames or play
  // sounds a second time. Background fill from the list covers the old overlay.
  submitCanvasScene(scene);
}

// 鏡頭中心的畫面高度:手機直式下方被聊天 / 快捷欄蓋住,人物往上放一點
let camCYcache = { at: 0, css: 0 };
function camCY(H) {
  const now = performance.now();
  if (now - camCYcache.at > 500) {
    const hb = st.inGame && $('#hotbar').getBoundingClientRect();
    const full = canvas.height / DPR;
    // 快捷欄上緣以上才是看得到的地圖;橫式 / 大螢幕底部佔比小,照舊用畫面正中
    // 直式手機:人物放在畫面約 43% 高(參考網頁版的比例,上方不會太窄、下方仍有地圖可點)
    camCYcache = { at: now, css: hb && hb.top > full * 0.4 && hb.top < full * 0.85 ? full * 0.43 : full / 2 };
  }
  return Math.min(H / 2, camCYcache.css / ZOOM);
}

// 參數是畫面座標(CSS px),先換回放大前的世界座標
function screenToTile(mx, my) {
  mx /= ZOOM; my /= ZOOM;
  const W = canvas.width / (DPR * ZOOM);
  const H = canvas.height / (DPR * ZOOM);
  const ox = W / 2 - (st.cam.x + st.cam.y) * (TW / 2);
  const oy = camCY(H) - (st.cam.y - st.cam.x) * (TH / 2);
  const a = (mx - ox) / (TW / 2); // = x + y
  const b = (my - oy) / (TH / 2); // = y - x
  return { x: Math.round((a - b) / 2), y: Math.round((a + b) / 2) };
}

// 點關著的門:站在 2 格內送開門請求(伺服器檢查鑰匙:銀鑰匙 / 黃金鑰匙),太遠就提示
function clickDoor(mx, my) {
  mx /= ZOOM; my /= ZOOM;
  const me = self();
  let best = null, bestD = 34;
  for (const o of st.objects.values()) {
    if (o.kind !== 'door' || o.status !== 29) continue;
    const p = toScreen(o.px, o.py);
    const d = Math.hypot(mx - p.x, my - (p.y - 8));
    if (d < bestD) { best = o; bestD = d; }
  }
  if (!best || !me) return false;
  if (Math.max(Math.abs(me.x - best.x), Math.abs(me.y - best.y)) > 2) { toast('靠近一點才能開門'); return true; }
  send({ t: 'door', id: best.id });
  return true;
}
// 右上地圖名稱:框寬固定,名稱太長就先縮字(最小 9px),還是塞不下就換成兩行(再多的才截掉)
function fitMapName() {
  const el = $('#hud-map');
  if (!el) return;
  el.style.fontSize = '';
  el.style.maxHeight = '';
  const base = parseFloat(getComputedStyle(el).fontSize) || 14;
  const lineH = () => (parseFloat(getComputedStyle(el).lineHeight) || base * 1.15);
  // 先試單行:字越縮越小,到 11px 還是塞不下就換兩行
  el.style.whiteSpace = 'nowrap';
  let size = base;
  while (size > 11 && el.scrollWidth > el.clientWidth + 1) { size -= 1; el.style.fontSize = size + 'px'; }
  if (el.scrollWidth <= el.clientWidth + 1) return;
  // 兩行:允許換行,字從 12px 往下縮到 9px,塞進兩行高
  el.style.whiteSpace = 'normal';
  size = Math.min(base, 12);
  el.style.fontSize = size + 'px';
  while (size > 9 && el.scrollHeight > lineH() * 2 + 1) { size -= 1; el.style.fontSize = size + 'px'; }
  el.style.maxHeight = (lineH() * 2 + 1) + 'px';
}
window.addEventListener('resize', () => { if (st.inGame) fitMapName(); });
function myDollAt(mx, my) {
  return null; // 11/23 使用者:娃娃不能點擊(走路連點會誤收回 → 像重新召喚);收回改從背包使用
  const me = self(); if (!me) return null;
  mx /= ZOOM; my /= ZOOM;
  let best = null, bestD = 30;
  for (const o of st.objects.values()) {
    if (o.kind !== 'doll' || o.master !== me.name) continue;
    const p = objScreen(o), d = Math.hypot(mx - p.x, my - (p.y - 18));
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}
function recallMyDoll(o) { // 伺服器規則:使用同一種娃娃道具 = 收回,所以送背包裡同名的那一隻
  const norm = v => String(v || '').replace(/^[+-]\d+\s*/, '').replace(/:/g, '：').replace(/\s+/g, '');
  const it = [...st.inv.values()].find(i => i.count > 0 && norm(i.name) === norm(o.name));
  if (!it) return false;
  st.path = []; send({ t: 'useitem', id: it.id }); return true;
}
function objectAt(mx, my) {
  mx /= ZOOM; my /= ZOOM;
  // 以畫面上的人物身形判定(比 tile 判定好點)
  let best = null;
  let bestD = 34; // 手指比滑鼠粗,判定範圍放大
  for (const o of st.objects.values()) {
    if (o.id === st.selfId || o.kind === 'door' || isDollObj(o)) continue; // 門、火把不能點;11/23 娃娃點擊穿透
    if (isHiddenPet(o)) continue; // 隱藏的他人寵物不能點
    const p = objScreen(o);
    const cy = o.kind === 'item' ? p.y - 8 : p.y - 22;
    const d = Math.hypot(mx - p.x, my - cy);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}

// 點選規則:怪物 = 攻擊、NPC / 警衛 = 對話、其他玩家 = 走到旁邊;
// 開啟「強制攻擊」(PvP) 時,玩家與 NPC 也會被攻擊
st.forceAttack = false;
// 血流成河(伺服器 L1BloodArena,奇岩競技場):場內點玩家直接攻擊,不開交易 / 組隊選單(伺服器也擋交易、組隊)
const BLOOD_ARENA_MAP = 88;
// map 88 也拿來辦 BOSS 戰(L1RaidBoss):進場時伺服器送 ##EVENT##arena / ##EVENT##raid(hud.js onChat),只有血流成河才套用 PvP 規則
const inArenaEvent = () => st.mapId === BLOOD_ARENA_MAP && st.eventMode === 'arena';
// BOSS 戰(L1RaidBoss):其他玩家互穿(尋路 / 走一步 / AUTO 隨機走都不把玩家當障礙,怪物照擋);同格的玩家畫面上錯開(crowdShift)
const passThroughPc = () => st.mapId === BLOOD_ARENA_MAP && st.eventMode === 'raid';
// 週六 BOSS(安塔瑞斯 gfx 7558):進場 / 公告時背景預先下載素材(手機 0.5 倍圖約 10 MB、電腦重切版約 31 MB;只下載不解碼,存進瀏覽器 / Service Worker 快取),並提示畫質調「中」
const RAID_BOSS_GFX = [7558]; // 數字(L1S.urls 的外型清單是數字)
let raidPreAt = -Infinity, raidHintAt = -Infinity;
function preloadRaidBoss() {
  if (navigator.connection?.saveData) return; // 省流量模式不抓
  const now = performance.now();
  if (now - raidPreAt < 600000) return; // 10 分鐘內只做一次
  raidPreAt = now;
  try { PRELOAD.boss(RAID_BOSS_GFX); } catch (e) { /* 沒有預先下載就算了,到時候照原本的方式載入 */ }
}
function raidEnter() { // 進 BOSS 戰(伺服器 ##EVENT##raid)
  preloadRaidBoss();
  const now = performance.now();
  if (typeof PERF !== 'undefined' && (PERF.mode === 'auto' || PERF.mode === 'high') && now - raidHintAt > 600000) {
    raidHintAt = now;
    log('BOSS 戰人多又有大型怪物,如果畫面卡,可以到「設定 → 畫質」改成「中」。', 'sys');
    toast('人多畫面卡?設定 → 畫質 可以改「中」');
  }
}
const CROWD_OFFS = [[0, 0], [-11, 5], [11, 5], [-11, -5], [11, -5], [0, 10], [0, -10], [-20, 0], [20, 0]];
let crowdCache = { at: -Infinity, map: new Map() };
function crowdShift(o) {
  if (o.kind !== 'pc' || !passThroughPc()) return CROWD_OFFS[0];
  const now = performance.now();
  if (now - crowdCache.at > 100) {
    const cells = new Map();
    for (const q of st.objects.values()) if (q.kind === 'pc' && !q.dead) { const k = q.x * 65536 + q.y; (cells.get(k) || cells.set(k, []).get(k)).push(q); }
    const map = new Map();
    for (const arr of cells.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => (a.id === st.selfId ? -1 : b.id === st.selfId ? 1 : a.id - b.id)); // 自己固定在原位
      arr.forEach((q, i) => map.set(q.id, CROWD_OFFS[i % CROWD_OFFS.length]));
    }
    crowdCache = { at: now, map };
  }
  return crowdCache.map.get(o.id) || CROWD_OFFS[0];
}
function objScreen(o) { const p = toScreen(o.px, o.py); const s = crowdShift(o); return s[0] || s[1] ? { x: p.x + s[0], y: p.y + s[1] } : p; }
const isMyPet = (o) => o.kind === 'pet' && o.master
  && (o.master === self()?.name || (inArenaEvent() && o.master === st.arenaAlias));
function isHiddenPet(o) { // 設定「隱藏他人寵物」開著、而且自己和那隻寵物都站在安全區(村莊)時,才把別人的寵物 / 召喚當成隱藏(自己的不算);出了安全區自動全部顯示
  if (st.hideOthersPets !== true || o.kind !== 'pet' || isMyPet(o)) return false;
  const me = self(); // 只在安全區生效:自己不在安全區(戰鬥、PvP、血流成河)一律顯示;寵物自己站在安全區邊界外也顯示(兩個條件都要成立才藏,不會漏掉戰鬥)
  return !!me && inSafeZone(me.x, me.y) && inSafeZone(o.x, o.y);
}
function tapMode(o) {
  if (isDollObj(o)) return 'none';
  if (o.kind === 'item') return 'pickup';
  // 寵物 / 召喚獸:PvP(強制攻擊)開著就打(自己的也能打);關著時自己的開選單,別人的跟著走
  if (o.kind === 'pet') return st.forceAttack ? 'attack' : isMyPet(o) ? 'talk' : 'follow';
  if (o.kind === 'monster' || st.forceAttack) return 'attack';
  if (o.kind === 'pc') return inArenaEvent() ? 'attack' : 'follow'; // 血流成河:點玩家直接打
  return 'talk';
}
// 選取與追擊分開:不讓第一下點擊建立 attack 目標,既有的移動路徑保留。
function clearPicked() {
  st.picked = null;
  if (st.pendingPickedCast) { st.pendingCast = null; st.pendingPickedCast = false; }
}
function canPickTarget(o) {
  return o && !o.dead && !o.dying && o.id !== st.selfId
    && (o.kind === 'monster' || (o.kind === 'pc' && tapMode(o) === 'attack'));
}
function pickedTarget() {
  if (!st.clickSelect || auto.on || !st.picked) return null;
  const o = st.objects.get(st.picked.id);
  if (!canPickTarget(o)) { clearPicked(); return null; }
  return o;
}
function setForceAttack(on, quiet) {
  st.forceAttack = on;
  if (st.clickSelect) pickedTarget(); // 非敵對玩家不能保留為施法選取目標
  $('#btn-pvp').classList.toggle('on', st.forceAttack);
  $('#btn-pvp').setAttribute('aria-pressed', st.forceAttack);
  if (!quiet) toast(st.forceAttack ? '強制攻擊:開啟' : '強制攻擊:關閉');
  // 關掉 PvP:取消對玩家的鎖定攻擊
  if (!st.forceAttack && st.target?.mode === 'attack' && st.objects.get(st.target.id)?.kind === 'pc' && !isWarEnemy(st.objects.get(st.target.id))) st.target = null;
  renderEnemies();
}
$('#btn-pvp').onclick = () => setForceAttack(!st.forceAttack);
// 血流成河:進場自動開強制攻擊,離場換回進場前的狀態(使用者 10/16)
let arenaPvpPrev = null;
function arenaPvp(mapId) {
  if (mapId === BLOOD_ARENA_MAP && st.eventMode === 'arena' && arenaPvpPrev === null) { arenaPvpPrev = st.forceAttack; if (!st.forceAttack) setForceAttack(true); stopAuto('進血流成河場'); } // 場內禁止自動狩獵(hud.js)
  else if (mapId !== BLOOD_ARENA_MAP && arenaPvpPrev !== null) { if (st.forceAttack !== arenaPvpPrev) setForceAttack(arenaPvpPrev); arenaPvpPrev = null; }
  if (mapId !== BLOOD_ARENA_MAP) st.eventMode = null; // 離開活動地圖
}

// 點哪走到哪:點怪物 = 攻擊、點道具 = 撿取、點 NPC = 對話、點地面 = 移動;按住拖曳會持續更新目的地
let press = null;
function walkTo(mx, my) {
  const me = self();
  let t = screenToTile(mx, my);
  // 點到洞口 / 門口附近的牆(畫出來的洞口常比傳點格高一點):改成走進最近的傳點
  if (!(tile(t.x, t.y) & 3)) {
    let best = null;
    for (const [px, py] of st.portals || []) {
      const d = Math.max(Math.abs(px - t.x), Math.abs(py - t.y));
      if (d <= 3 && (!best || d < best.d)) best = { x: px, y: py, d };
    }
    if (best) t = best;
  }
  if (t.x === me.x && t.y === me.y) return true;
  // 按住不放時同一格剛剛才找不到路(人也沒動):不要每 300ms 再算一次
  const f = walkTo.fail;
  if (f && f.x === t.x && f.y === t.y && f.mx === me.x && f.my === me.y && performance.now() - f.at < 2000) return false;
  // 點到牆壁等不可走的格子時,走到它旁邊(不可走又不是傳點的格子不可能「走到上面」,不用先找一次)
  const exact = (tile(t.x, t.y) & 3) || portalSet().has(t.x * 65536 + t.y);
  const p = (exact ? findPath(me.x, me.y, t.x, t.y, false) : null) ?? findPath(me.x, me.y, t.x, t.y, true);
  if (p === null) { walkTo.fail = { x: t.x, y: t.y, mx: me.x, my: me.y, at: performance.now() }; return false; }
  st.path = p;
  st.tap = { x: t.x, y: t.y, at: performance.now() };
  return true;
}
// 點到別的玩家、但同格或相鄰 1 格內有可對話的 NPC(商人 / 傳送師 / 總管…)時,優先選 NPC(使用者 10/25:人疊在獵場總管旁邊,點不到總管)
function npcNearPc(pc, mx, my) {
  mx /= ZOOM; my /= ZOOM;
  const pp = objScreen(pc); const dPc = Math.hypot(mx - pp.x, my - (pp.y - 22)); // 點擊離這個玩家的距離
  let best = null, bestD = Math.min(60, dPc + 24); // NPC 要比玩家近、或只差 24 px 以內(正中玩家身體時不搶)
  for (const o of st.objects.values()) {
    if (o.dead || o.id === st.selfId || o.kind === 'pc' || o.kind === 'monster' || o.kind === 'item' || o.kind === 'pet' || o.kind === 'doll' || o.kind === 'door' || o.impl === 'L1Deco') continue;
    if (Math.max(Math.abs(o.x - pc.x), Math.abs(o.y - pc.y)) > 1) continue;
    const p = objScreen(o);
    const d = Math.hypot(mx - p.x, my - (p.y - 22));
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}
canvas.addEventListener('pointerdown', (e) => {
  if (!st.inGame || e.button > 0 || !self() || self().dead) return;
  $('#chat-input').blur();
  if (clickDoor(e.clientX, e.clientY)) return;
  { // 使用者 11/16:召喚中的魔法娃娃點兩下 = 收回(娃娃平常不能點,這裡只認自己的娃娃、400ms 內連點兩下)
    const d = myDollAt(e.clientX, e.clientY), now = performance.now(), last = st.dollTap;
    st.dollTap = d ? { id: d.id, at: now } : null;
    if (d && last && last.id === d.id && now - last.at < 400) { st.dollTap = null; if (recallMyDoll(d)) return; }
  }
  let o = objectAt(e.clientX, e.clientY);
  if (o && !o.dead && o.kind === 'pc' && o.id !== st.selfId && !st.forceAttack && !inArenaEvent()) { const n = npcNearPc(o, e.clientX, e.clientY); if (n) o = n; } // NPC 優先(玩家疊在 NPC 旁邊時)
  if (o && !o.dead && o.kind === 'pc' && o.id !== st.selfId) st.nameShow = { id: o.id, until: performance.now() + 8000 }; // 10/28 試做:其他玩家名字預設不顯示,點到才顯示 8 秒
  if (o && !o.dead) {
    // 其他玩家:連點兩下(同一人 400ms 內)才開交易 / 組隊選單;點一下當作點地板走過去(使用者 10/17:人多的地方點一下就跳選單很煩)
    if (o.kind === 'pc' && o.id !== st.selfId && !st.forceAttack && !inArenaEvent()) {
      const now = performance.now(), last = st.pcTap;
      st.pcTap = { id: o.id, at: now };
      if (last && last.id === o.id && now - last.at < 400) { st.pcTap = null; st.path = []; openPlayerMenu(o); return; }
      o = null;
    }
  }
  if (o && !o.dead && o.impl === 'L1Deco') return; // 裝飾(海音 4F 的魚):點了不走、不開視窗、不攻擊
  if (gmGive.picking) { // GM 給予:這一下是選怪,不攻擊、不走路
    if (o && !o.dead && o.kind === 'monster') gmGivePick(o);
    else { gmGive.picking = false; gmGive.btn?.classList.remove('on'); toast('已取消給予(要點怪物)'); }
    return;
  }
  if (o && !o.dead) {
    if (st.clickSelect && !auto.on && canPickTarget(o)) {
      const picked = pickedTarget();
      if (!picked || picked.id !== o.id) {
        clearPicked();
        if (st.pendingCast && st.game.skills[st.pendingCast]?.hostile) st.pendingCast = null; // 舊的排隊攻擊魔法不能轉打新選取目標
        st.picked = { id: o.id };
        st.target = null; // 停止舊目標的追擊 / 攻擊,不清掉正在走的路
        return;
      }
    }
    st.target = { id: o.id, mode: tapMode(o) };
    st.path = [];
    if (st.target.mode === 'attack' || st.target.mode === 'pickup') behavAccept();
    return;
  }
  st.target = null;
  stopAuto('自己點地板走路'); // 自己點地板走路:關掉自動狩獵
  canvas.setPointerCapture(e.pointerId);
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, last: performance.now() };
  if (!walkTo(e.clientX, e.clientY)) toast('無法到達');
  else if (st.path.length) behavAccept(behavContext(), 'move');
});
canvas.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  press.x = e.clientX; press.y = e.clientY;
});
const endPress = (e) => { if (press && e.pointerId === press.id) press = null; };
canvas.addEventListener('pointerup', endPress);
canvas.addEventListener('pointercancel', endPress);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// 防「穿透點擊」:點 NPC 是在手指按下時就處理,伺服器回得快的話對話框會在手指放開前跳出來,
// 放開時瀏覽器補發的 click 會落在對話框剛好在手指下的按鈕(買東西、傳送)。按下時在地圖上的,放開後的 click 一律不算
let downOnMap = false;
document.addEventListener('pointerdown', (e) => { downOnMap = e.target === canvas; }, true);
document.addEventListener('click', (e) => {
  if (downOnMap && e.target !== canvas) { e.stopPropagation(); e.preventDefault(); }
  downOnMap = false;
}, true);

// ---------------- 遊戲迴圈 ----------------
const AUTO_RANGED_PATH = true; // AUTO 遠程尋路到有視線的射程內,不必擠到怪旁邊
const AUTO_SPELL_WAIT = true; // 魔法間隔只在普攻打不到、原地可等下一發時停步
function autoWaitForSpell(me, o, now) {
  if (!AUTO_SPELL_WAIT || !auto.on || !st.target?.auto || st.target.mode !== 'attack' || st.target.castOnce || now >= (st.autoSpellAt || 0)) return false;
  const spell = autoAttackSkill(true);
  return !!spell && autoCanHitAt(me, o, skillReach(spell));
}
function step(now) {
  if (st.clickSelect && st.picked) pickedTarget(); // 物件狀態改變時也清掉選取與排隊施法
  const me = self();
  if (!me || me.dead || !st.map) { if (me?.dead && st.para) { st.para = null; setBuff('para', '', 0); } return; }
  // 麻痺類狀態:全鎖什麼都不做(不追目標、不打、不撿、不走,AUTO 也停),束縛只是不能走(下面走路那段擋);時間到沒收到解除就自己解
  const para = st.para ? paraState(now) : null;
  if (st.para && !para) { st.para = null; setBuff('para', '', 0); }
  if (para === 'full') { st.path = []; return; }
  if (press && now - press.last > 300) { press.last = now; walkTo(press.x, press.y); }
  const hurt = me.hurt && now < me.hurt + (me.hurtMs || 0); // 被打硬直中:不能出手、不能起步
  autoLoot(now);

  // 動作中按的魔法:動作結束、站定後先放(要在繼續普攻之前,不然普攻一結束馬上接下一下,魔法永遠輪不到)
  if (st.pendingCast && !me.anim && !(me.lunge && now < me.lunge + (me.lungeMs || 0)) && now >= (st.castLockUntil || 0)) {
    const id = st.pendingCast, heal = st.pendingCastHeal, windWalk = st.pendingCastWindWalk;
    const automaticSupply = st.pendingCastSupply; st.pendingCastSupply = false;
    st.pendingCast = null; st.pendingCastHeal = null; st.pendingCastWindWalk = false;
    castSkill(id, st.pendingCastSelf, heal, windWalk, automaticSupply); return;
  }
  // 追目標:必要時重新尋路到旁邊
  if (st.target) {
    const o = st.objects.get(st.target.id);
    if (!o && st.target.goal && st.path.length && now < st.target.goalUntil) { /* 擴大搜尋:怪暫時出畫面(伺服器曼哈頓 > 18 移出),照記住的路走;走完還看不到就在 hud 主迴圈放掉 */ }
    else if (!o || o.dead || o.dying || (auto.on && st.target.auto && !st.target.castOnce && !autoPatrolTarget(me, o))) { st.target = null; st.path = []; }
    else {
      const dist = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
      const range = weaponRange();
      // 自動魔法攻擊:MP 夠就用魔法打,射程照魔法(hud.js autoAttackSkill)
      // 快捷欄按的攻擊魔法(castOnce):走到射程內放一次;其餘照自動魔法
      // 開怪技能(hud.js autoOpenSkill):AUTO 打新的怪時第一下用
      const spell = st.target.mode === 'attack' ? (st.target.castOnce || autoSpellFor(o.id)) : null;
      const reach = st.target.mode === 'pickup' ? 0
        : st.target.mode === 'attack' ? (spell ? skillReach(spell) : range === -1 ? RANGED_REACH : st.target.crowd ? Math.max(range, 2) : range)
          : st.target.mode === 'talk' ? TALK_REACH : st.target.mode === 'ally' ? ALLY_REACH : 1;
      // 2 格以上的武器中間不能有障礙物(對照伺服器 glanceCheck)
      const canHit = st.target.mode !== 'attack' || reach <= 1 || clearLine(me.x, me.y, o.x, o.y);
      if ((dist <= reach && canHit) || (st.target.mode === 'pickup' && dist <= 1)) {
        st.path = [];
        if (hurt || (me.anim && st.target.mode !== 'talk')) {
          // 這一步還沒走完(畫面上還沒到)或硬直中,等一下才出手 / 撿;對話不用等走完(伺服器那邊位置已經更新,等的話要慢 0.6 秒)
        } else if (st.target.mode === 'attack') {
          if (spell) {
            // 自動魔法攻擊:每次放完(動作播完 / 冷卻結束)再等 AUTO_SPELL_GAP 才放下一次,等的時候普攻(hud.js autoAttackSkill 回 null)
            const autoAtk = !st.target.castOnce && spell === settings.atkSkill?.id && spell === autoAttackSkill();
            if (now >= st.nextAttackAt) {
              castSkill(spell); // 對目前的目標放(施法動作與間隔在 castSkill 裡)
              markOpened(o.id);
              if (autoAtk) st.autoSpellAt = Math.max(st.nextAttackAt || 0, st.castLockUntil || 0, now) + AUTO_SPELL_GAP;
            }
          } else if (now >= st.nextAttackAt && L1S.hasAction(me.gfx, 1) === false && ![...st.inv.values()].some((it) => equipSlot(it) === 'weapon' && isEquipped(it))) {
            // 變身成沒有空手攻擊動作的外型(例如黑暗精靈變身):要裝備武器才能攻擊(伺服器也會擋)
            if (now > (st.bareWarnAt || 0)) { toast('此變身需要裝備武器才能攻擊'); st.bareWarnAt = now + 3000; }
            st.nextAttackAt = now + 1000;
          } else if (now >= st.nextAttackAt && auto.on && silentHit.id === o.id && silentHit.n >= SILENT_HIT_GIVEUP) {
            // AUTO:連續幾下伺服器完全沒回(沒有自己的攻擊封包、這隻也沒任何動靜)= 畫面上的這隻其實不在這裡(殘影),先跳過 15 秒
            auto.unreach.set(o.id, now + 15000);
            st.target = null;
            silentHit.n = 0;
            noteSilentGiveup(now, me, o);
          } else if (now >= st.nextAttackAt) {
            if (silentHit.id !== o.id) { silentHit.id = o.id; silentHit.n = 0; }
            silentHit.n++;
            markOpened(o.id); // 第一下是普通攻擊(MP 不夠等)也算開過了
            faceTo(me, o.x, o.y);
            send({ t: 'attack', target: o.id, x: o.x, y: o.y, ranged: range === -1 });
            st.attackSentAt = now; // 11/04:網頁自己送的攻擊(已在本機先播動作);伺服器代打(統一 AUTO)不會設
            noteAttackSent(o);
            st.nextAttackAt = now + actionMs(me, 'attack');
            // 出手就開始播攻擊動作,整段播完前不能走(不能用走路取消攻擊)
            me.lunge = now; me.lungeMs = actionMs(me, 'attack'); me.lungeAct = null;
          }
        } else if (st.target.mode === 'ally') {
          // 走到選定隊友的施法距離內了:放快捷欄按的那個輔助魔法(hud.js castSkill)
          const id = st.target.castOnce;
          st.target = null;
          castSkill(id);
        } else if (st.target.mode === 'trade') {
          faceTo(me, o.x, o.y);
          send({ t: 'trade', target: o.id });
          toast(`已向 ${o.name} 提出交易`);
          st.target = null;
        } else if (st.target.mode === 'tame') {
          // 捕捉:走到旁邊一格了,把肉給牠;給完繼續打牠
          faceTo(me, o.x, o.y);
          giveMeat(o, st.target.item);
          st.target = { id: o.id, mode: 'attack' };
        } else if (st.target.mode === 'follow') {
          faceTo(me, o.x, o.y);
          st.target = null;
        } else if (st.target.mode === 'pickup') {
          send({ t: 'pickup', id: o.id, x: o.x, y: o.y, count: o.exp || 1 });
          st.target = null;
        } else {
          faceTo(me, o.x, o.y);
          // 只買 / 只賣的商人不送對話封包,直接要清單(先送對話的話,亞丁回收商的販賣清單伺服器不會回)
          if (o.kind === 'pet') send({ t: 'npctalk', id: o.id }); // 寵物:伺服器回寵物選單(anicom)
          else {
            const ev = { id: o.id, name: o.name, menu: o.menu, impl: o.impl };
            if (!shopOnly(o.menu) && !o.menu?.teach) {
              send({ t: 'npctalk', id: o.id });
              waitNpcPage(ev);
            } else openNpcDialog(ev);
          }
          st.target = null;
        }
      } else if (!spell && autoWaitForSpell(me, o, now)) {
        st.path = []; // 魔力仍夠且原地可射才等;近身仍照常穿插普攻
      } else if ((!st.path.length || st.target.lastX !== o.x || st.target.lastY !== o.y)
        // 剛剛才找不到路、目標和自己都沒動:1 秒內不要再算(以前每一格畫面都重跑 4000 步的尋路)
        && !(st.target.failAt && now - st.target.failAt < 1000 && st.target.lastX === o.x && st.target.lastY === o.y && st.target.failMx === me.x && st.target.failMy === me.y)) {
        st.target.lastX = o.x; st.target.lastY = o.y;
        const goalReach = AUTO_RANGED_PATH && auto.on && st.target.auto && st.target.mode === 'attack' && reach > 1 ? reach : true;
        const patrolBounds = auto.on && st.target.auto && !st.target.castOnce ? autoPatrolBounds() : null;
        let p = patrolBounds && autoPatrolDistance(patrolBounds, me.x, me.y) > patrolBounds.range ? null
          : findPath(me.x, me.y, o.x, o.y, goalReach, patrolBounds);
        st.target.crowd = false;
        // 近戰:貼身的格子都被占滿(BOSS 周圍擠人)→ 退一步,找離牠 2 格內最近的格子停下來出手(伺服器接受 2 格;reach 見上面 st.target.crowd;只限 BOSS 戰 passThroughPc,使用者 10/22)
        if (!p && st.target.mode === 'attack' && !st.target.castOnce && reach <= 1 && passThroughPc()
          && !(patrolBounds && autoPatrolDistance(patrolBounds, me.x, me.y) > patrolBounds.range)) { p = findPath(me.x, me.y, o.x, o.y, 2, patrolBounds); if (p) st.target.crowd = true; }
        const stuck = p && !p.length; // 已經走到旁邊了還是射不到(格子邊緣擋箭):當成走不到,不要站著一直重算
        st.path = p || [];
        if (p && !stuck) { st.target.failAt = 0; st.target.fails = 0; }
        // AUTO:走不到的怪(牆後面、地監另一條通道)先跳過 15 秒,換別隻 / 繼續找,不要站著發呆
        else if (auto.on && st.target.mode === 'attack' && !st.target.castOnce) { auto.unreach.set(o.id, now + 15000); st.target = null; }
        else {
          Object.assign(st.target, { failAt: now, failMx: me.x, failMy: me.y, fails: (st.target.fails || 0) + 1 });
          // 自己點的目標 / 快捷欄魔法:連續 3 次走不到就放棄(AUTO 開著的話這隻先跳過,AUTO 接手找下一隻)
          if (st.target.fails >= 3) {
            if (auto.on && st.target.mode === 'attack') auto.unreach.set(o.id, now + 15000);
            st.target = null;
            toast('無法到達');
          }
        }
      }
    }
  }

  const attacking = me.lunge && now < me.lunge + (me.lungeMs || 0);
  if (st.path.length && now >= st.nextStepAt && !me.anim && !attacking && !hurt && para !== 'move') {
    const next = st.path[0];
    const patrolBounds = auto.on && (st.target ? st.target.auto && !st.target.castOnce : auto.wander || auto.homing) ? autoPatrolBounds() : null;
    if (patrolBounds && (!autoPatrolStep(patrolBounds, me.x, me.y, next.x, next.y)
      || (st.target && autoPatrolDistance(patrolBounds, me.x, me.y) > patrolBounds.range))) { st.path = []; return; }
    const h = DX.findIndex((dx, i) => dx === next.x - me.x && DY[i] === next.y - me.y);
    if (h < 0 || !passable(me.x, me.y, h) || occupied(next.x, next.y)) { st.path = []; return; }
    st.path.shift();
    send({ t: 'move', x: me.x, y: me.y, heading: h });
    const walkMs = actionMs(me, 'walk');
    if (me.stepQ) me.stepQ.length = 0; // 11/05:手動走路接手,丟掉伺服器步伐佇列
    me.anim = { fx: me.px, fy: me.py, start: now, dur: walkMs };
    me.x = next.x; me.y = next.y; me.heading = h;
    st.nextStepAt = now + walkMs;
  }
}

// 自動拾取:伺服器允許 3 格內撿取(C_PickUpItem getTileLineDistance <= 3),
// 所以範圍內的道具直接送拾取封包,不必走過去。別人的道具會被伺服器拒絕,冷卻後再試。
const LOOT_RANGE = 3;
const lootTried = new Map();
function autoLoot(now) {
  if (unifiedPassive()) return;
  const me = self();
  for (const o of st.objects.values()) {
    if (o.kind !== 'item') continue;
    if (Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) > LOOT_RANGE) continue;
    if (now - (lootTried.get(o.id) || 0) < 1500) continue;
    lootTried.set(o.id, now);
    send({ t: 'pickup', id: o.id, x: o.x, y: o.y, count: o.exp || 1 });
  }
  if (lootTried.size > 200) for (const id of lootTried.keys()) if (!st.objects.has(id)) lootTried.delete(id);
}

// ---- 武器射程 ----
// 伺服器規則(L1Attack):射程 -1 的遠程武器在畫面內都打得到,其他照武器射程(矛 2、一般 1)
const RANGED_REACH = 7; // 手機畫面較窄,遠程武器在 7 格內就射
// 技能射程(10/30):三重矢(132)伺服器 skills.ranged = -1 代表略過技能距離檢查,不是一般性的「照武器射程」。網頁資料 range 0 原本當 10 格,
// 但網頁弓的普攻只射 RANGED_REACH 7 格 → 8~10 格的怪一直放三重矢、不接普攻(使用者 10/30)。這類技能改用和普攻一樣的射程
const WEAPON_RANGE_SKILLS = new Set([132]);
function skillReach(id) {
  if (WEAPON_RANGE_SKILLS.has(id)) { const r = weaponRange(); return r === -1 ? RANGED_REACH : Math.max(1, r); }
  return st.game.skills[id]?.range || 10;
}
let wrCache = { t: -1e9, v: 1 }; // weaponRange 每幀被叫好幾次、每次掃背包 + regex:快取 250ms
function weaponRange() {
  const wn = performance.now();
  if (wn - wrCache.t < 250) return wrCache.v;
  wrCache = { t: wn, v: weaponRangeRaw() };
  return wrCache.v;
}
function weaponRangeRaw() {
  for (const it of st.inv.values()) {
    if (!/\(揮舞\)/.test(it.name)) continue;
    const base = it.name.replace(/^[+-]\d+\s*/, '').replace(/\s*\(.*$/, '').trim();
    return st.weaponRanges?.[base] ?? 1;
  }
  return 1;
}

// 兩點之間的格子都要能走(粗略對照伺服器的 glanceCheck)
// 箭 / 魔法能不能從 (x0, y0) 飛到 (x1, y1):和伺服器 L1Character.glanceCheck / L1V1Map.isArrowPassable 一模一樣
// (以前只看中間格子能不能走;有些格子能走但地圖標成擋箭,伺服器一直判 MISS,AUTO 卻站在原地一直射)
const HEADING_OF = [[7, 6, 5], [0, -1, 4], [1, 2, 3]]; // [dx + 1][dy + 1]
// 關著的門座標 Set(clearLine 每一步都要查;AUTO 選怪一輪會跑幾百次 clearLine,不能每一步都掃全部物件)
// 最多 0.1 秒重建一次;門開 / 關(onAction)會馬上作廢
let closedDoorCache = { at: -Infinity, set: new Set() };
function closedDoors() {
  const now = performance.now();
  if (now - closedDoorCache.at > 100) {
    const set = new Set();
    for (const o of st.objects.values()) if (o.kind === 'door' && o.status === 29) set.add(o.x * 65536 + o.y);
    closedDoorCache = { at: now, set };
  }
  return closedDoorCache.set;
}
function arrowPassable(x, y, h) {
  const nx = x + DX[h];
  const ny = y + DY[h];
  if (closedDoors().has(nx * 65536 + ny)) return false; // 關著的門
  switch (h) {
    case 0: return (tile(x, y) & 8) !== 0;
    case 1: return (tile(x, y - 1) & 4) !== 0 || (tile(x + 1, y) & 8) !== 0;
    case 2: return (tile(x, y) & 4) !== 0;
    case 3: return (tile(x, y + 1) & 4) !== 0;
    case 4: return (tile(nx, ny) & 8) !== 0;
    case 5: return (tile(nx, ny) & 12) !== 0;
    case 6: return (tile(nx, ny) & 4) !== 0;
    case 7: return (tile(x - 1, y) & 4) !== 0 || (tile(x, y - 1) & 8) !== 0;
    default: return false;
  }
}
function arrowStep(x, y, dx, dy) {
  if (dx && dy) {
    return (arrowPassable(x, y, HEADING_OF[dx + 1][1]) && arrowPassable(x + dx, y, HEADING_OF[1][dy + 1]))
      || (arrowPassable(x, y, HEADING_OF[1][dy + 1]) && arrowPassable(x, y + dy, HEADING_OF[dx + 1][1]));
  }
  return arrowPassable(x, y, HEADING_OF[dx + 1][dy + 1]);
}
function clearLine(x0, y0, x1, y1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (n > 20) return false;
  let cx = x0;
  let cy = y0;
  for (let i = 1; i <= n; i++) {
    // 伺服器用 Math.round((float) …):負數的 .5 往正的方向進位,和 JS Math.round 一樣
    const x = x0 + Math.round(((x1 - x0) * i) / n);
    const y = y0 + Math.round(((y1 - y0) * i) / n);
    if (!arrowStep(cx, cy, x - cx, y - cy)) return false;
    cx = x;
    cy = y;
  }
  return true;
}

function faceTo(me, x, y) {
  const h = DX.findIndex((dx, i) => dx === Math.sign(x - me.x) && DY[i] === Math.sign(y - me.y));
  if (h >= 0 && h !== me.heading) { me.heading = h; send({ t: 'heading', heading: h }); }
}

// 沙漠(地圖 4)螞蟻洞入口的傳點格(dungeon 表 砂漠 -> 蟻ケイブB1-1 ~ B1-6)
const ANT_HOLES = [[32755, 33208], [32914, 33220], [32789, 33255], [32848, 33294], [32839, 33172], [32788, 33149]];
// 洞口周圍 3×3 格的地圖物件(沙丘、碎石)不畫,不然會蓋住半個洞
const ANT_HOLE_NEAR = new Set(ANT_HOLES.flatMap(([x, y]) => [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => (x + dx) * 65536 + y + dy))));
// 沙坑洞口:外圈下陷的陰影 + 中間黑洞 + 下緣受光的沙唇(斜角視角,圓壓扁成 2:1)
function drawSandHole(px, py) {
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(1, 0.5);
  const r = TW * 1.25;
  let g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, 'rgba(70,48,24,.45)');
  g.addColorStop(0.6, 'rgba(90,64,34,.25)');
  g.addColorStop(1, 'rgba(90,64,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  const h = TW * 0.68;
  g = ctx.createRadialGradient(0, -h * 0.15, 0, 0, 0, h);
  g.addColorStop(0, 'rgba(8,5,2,.95)');
  g.addColorStop(0.55, 'rgba(25,16,8,.85)');
  g.addColorStop(1, 'rgba(60,40,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, h, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(232,206,150,.55)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, h * 0.95, Math.PI * 0.12, Math.PI * 0.88); ctx.stroke();
  ctx.restore();
}

// 回傳放大前的世界座標(畫的時候整個世界乘上 ZOOM)
function toScreen(x, y) {
  const W = canvas.width / (DPR * ZOOM);
  const H = canvas.height / (DPR * ZOOM);
  return {
    // 天堂客戶端的斜角方向(l1j-client map_coord::get_screen):x 往右上、y 往右下
    x: W / 2 + ((x + y) - (st.cam.x + st.cam.y)) * (TW / 2),
    y: camCY(H) + ((y - x) - (st.cam.y - st.cam.x)) * (TH / 2),
  };
}

// 手機 DPR 常是 3,全畫面重繪太吃效能,上限 2
let DPR = Math.min(2, devicePixelRatio || 1);
// 世界畫面放大倍率:手機版天堂一格約 56px 寬(我們的格子 48px),手機直式剛好約 1.17 倍
// 直式畫面(手機、電腦版的手機框)固定視野:最多看到 352×762(= 412×892 手機看到的範圍),畫面大只會放大、不會看得比較遠
const VIEW_W = 352, VIEW_H = 762;
let ZOOM = 1;
// 電腦版:遊戲在 desk.html 的 iframe 裡被整個等比放大(window.deskScale 倍),畫布解析度也要乘上去才不會糊
function deskScale() {
  try { return (window.top !== window && parent.deskScale) || 1; } catch (e) { return 1; }
}
const inDesk = (() => { try { return window.top !== window && !!parent.deskScale; } catch (e) { return false; } })();
let PERF_CAP = Infinity; // 效能自動調整給的解析度上限(PERF.level 2 = 1.5、3 = 1)
function resize() {
  // 橫式縮放框補足解析度;直式一律沿用手機上限 2,再補外框縮放倍率。
  const scaledDesk = inDesk && document.documentElement.classList.contains('land');
  DPR = (scaledDesk ? (devicePixelRatio || 1) : Math.min(2, devicePixelRatio || 1)) * deskScale();
  DPR = Math.min(DPR, PERF_CAP);
  let viewWidth = 640, viewHeight = 480;
  if (document.documentElement.classList.contains('land') && !matchMedia('(pointer: coarse)').matches) {
    try {
      if (inDesk && parent.deskMode === 'land') {
        const res = parent.deskRes;
        if (res === '800x600') { viewWidth = 800; viewHeight = 600; }
        else if (res === '1024x768') { viewWidth = 1024; viewHeight = 768; }
      }
    } catch (e) { /* 無同源外框時維持 640×480 */ }
  }
  ZOOM = innerWidth <= innerHeight
    ? Math.max(1, innerWidth / VIEW_W, innerHeight / VIEW_H)
    : Math.max(1, innerWidth / viewWidth, innerHeight / viewHeight); // 電腦橫式跟隨外框解析度;觸控維持原版視野
  canvas.width = Math.round(innerWidth * DPR); // 不要被小數截掉一列(893.9999 → 893)
  canvas.height = Math.round(innerHeight * DPR);
  // 電腦版的框被整個縮放(不是整數倍):瀏覽器合成時用最近像素,不要再把整個畫面平滑一次
  canvas.style.imageRendering = scaledDesk ? 'pixelated' : '';
}
addEventListener('resize', resize);
// 11/04 iOS 27.2 回報最下面一排被切掉:可視區(visualViewport)比版面(innerHeight)短時,差額加到底部安全距離 --vvb;鍵盤開著(輸入框焦點)時不動,交給聊天列處理
// 11/07 三星 A56 回報「打完字之後下面那個就不見了」:收鍵盤那一刻輸入框還有焦點 → 這裡跳過,之後沒有事件再觸發 → 失焦後 300 / 800 ms 補量;縮放時(scale ≠ 1)可視區本來就比較小,不量
// 11/08 三星瀏覽器(使用者 S24 / 三星 A56 實測,gateway [畫面] 紀錄):正常 innerHeight 686;開鍵盤時底部工具列收起,收鍵盤後回報變 734、可視區也 734,
//   但工具列其實又蓋回網頁最下面 48px(功能列 / 聊天列被蓋住)。瀏覽器數字自己一致,量差額抓不到 → 記住「沒在打字時」的正常高度(同寬度下最小值),
//   收鍵盤後如果版面比它高 1~120px,就把差額加到底部安全距離。轉向(寬度變)重記。
// 11/08 03:5x 再修:三星一旦變成 734 就連重新整理都維持 734(量不到 686)→ 正常高度存在 localStorage(依螢幕尺寸 + 寬度記最小值);
//   三星瀏覽器沒記到時,網頁高度離螢幕高度不到 70px = 工具列被當成收起,直接預留 48px(實測 734 − 686)。
// 11/08 23:0x 使用者轉玩家截圖(S26 Ultra):沒打字畫面底部也多一截空白 → 上面兩條補正(記住的高度差 / 三星 48px)改成「這次開過鍵盤之後」才套用;
//   沒用過鍵盤就只留 iOS 那條(可視區比版面短的差額)。
const IS_SAMSUNG = /SamsungBrowser/.test(navigator.userAgent);
let vvBase = 0, vvBaseW = 0, vvPad = 0, vvKbUsed = false;
const vvKey = () => `l1j.vvBase.${screen.width}x${screen.height}.${innerWidth}`;
function syncVvb() {
  const vv = window.visualViewport; if (!vv) return;
  if (Math.abs((vv.scale || 1) - 1) > 0.01) return;
  const a = document.activeElement; const typing = a && /^(INPUT|TEXTAREA)$/.test(a.tagName);
  if (typing && vv.height < innerHeight * 0.75) vvKbUsed = true; // 鍵盤真的打開過
  if (innerWidth !== vvBaseW) { vvBaseW = innerWidth; vvBase = 0; try { vvBase = +localStorage.getItem(vvKey()) || 0; } catch { /* 無痕 */ } }
  if (!typing && vv.height >= innerHeight - 1 && innerHeight >= screen.height * 0.7 && (!vvBase || innerHeight < vvBase)) {
    vvBase = innerHeight; try { localStorage.setItem(vvKey(), String(vvBase)); } catch { /* 無痕 */ }
  }
  if (typing) return;
  const gap = Math.round(innerHeight - vv.height - vv.offsetTop);
  let grow = vvKbUsed && vvBase ? innerHeight - vvBase : 0;
  if (vvKbUsed && IS_SAMSUNG && grow <= 0 && screen.height - innerHeight < 70) grow = 48;
  vvPad = Math.max(gap > 0 && gap < 200 ? gap : 0, grow > 0 && grow <= 120 ? grow : 0);
  document.documentElement.style.setProperty('--vvb', `${vvPad}px`);
}
addEventListener('resize', syncVvb); window.visualViewport?.addEventListener('resize', syncVvb); syncVvb();
document.addEventListener('focusout', () => { setTimeout(syncVvb, 300); setTimeout(syncVvb, 800); });
function safeAreaText() {
  const p = document.createElement('div'); p.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(p); const cs = getComputedStyle(p), t = `上 ${cs.paddingTop} 下 ${cs.paddingBottom}`; p.remove(); return t;
}
resize();

// ---------------- 小地圖 ----------------
// 以玩家為中心取一塊地圖畫成像素圖(走遠了才重畫),再用和主畫面相同的斜角方向貼到右上角
const mini = { base: null, cx: 0, cy: 0, R: 60, last: 0, big: false };
const mmCanvas = $('#minimap');
const mm = mmCanvas.getContext('2d');
$('#minimap-box').onclick = () => openWorldMap();

// ---- 世界地圖(點小地圖打開):照伺服器通行資料畫的示意圖 ----
// 能走 = 淺色、大片不能走(海 / 房子)= 深色、零星障礙(樹 / 柵欄)= 黑點、NPC = 黃點、傳點 = 紅點、自己 = 紅色箭頭
const WM_R = 80; // 底圖半徑(格)
const WM_SUB = 3; // 每格在底圖上的像素(零星障礙只畫中間一點)
const wm = { open: false, base: null, cx: 0, cy: 0, timer: 0 };
const wmBox = document.createElement('div');
wmBox.id = 'worldmap';
wmBox.className = 'hidden';
wmBox.innerHTML = '<div class="wm-ring"><canvas></canvas></div><button type="button" class="x-btn wm-close" aria-label="關閉">✕</button>';
document.getElementById('hud').appendChild(wmBox);
const wmCanvas = wmBox.querySelector('canvas');
// 大地圖開著也能玩:地圖本身不吃點擊(點下去等於點遊戲畫面 = 走路),快捷欄的瞬移 / 卷軸照用;只有按 ✕ 才關
const wmClose = wmBox.querySelector('.wm-close');
wmClose.addEventListener('pointerdown', (e) => e.stopPropagation());
wmClose.onclick = (e) => { e.stopPropagation(); closeWorldMap(); };
function openWorldMap() {
  const me = self();
  if (!st.inGame || !st.map || !me) return;
  wm.open = true;
  wm.base = null;
  wmBox.classList.remove('hidden');
  drawWorldMap();
  clearInterval(wm.timer);
  wm.timer = setInterval(drawWorldMap, 250);
}
function closeWorldMap() {
  wm.open = false;
  clearInterval(wm.timer);
  wmBox.classList.add('hidden');
}
function buildWorldBase(cx, cy) {
  const n = WM_R * 2 + 1;
  const size = n * WM_SUB;
  const off = document.createElement('canvas');
  off.width = off.height = size;
  const g = off.getContext('2d');
  const blocked = (x, y) => !(tile(x, y) & 3);
  g.fillStyle = '#d6bd8c';
  g.fillRect(0, 0, size, size);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tx = cx - WM_R + x;
      const ty = cy - WM_R + y;
      const t = tile(tx, ty);
      const px = x * WM_SUB;
      const py = y * WM_SUB;
      if (!(t & 3)) {
        let around = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (blocked(tx + i, ty + j)) around++;
        if (around >= 7) { g.fillStyle = '#4b3826'; g.fillRect(px, py, WM_SUB, WM_SUB); continue; } // 大片:海 / 房子
        g.fillStyle = '#2a1d10'; g.fillRect(px + 1, py + 1, 1, 1); // 零星障礙:黑點
      } else if ((t & 3) !== 3) {
        g.fillStyle = '#2a1d10'; g.fillRect(px + 1, py + 1, 1, 1); // 單向通行(柵欄、牆邊)
      }
    }
  }
  return off;
}
function drawWorldMap() {
  const me = self();
  if (!wm.open || !me || !st.map) { if (wm.open && !st.inGame) closeWorldMap(); return; }
  if (!wm.base || Math.abs(me.x - wm.cx) > WM_R / 4 || Math.abs(me.y - wm.cy) > WM_R / 4 || wm.map !== st.mapId) {
    wm.cx = me.x; wm.cy = me.y; wm.map = st.mapId;
    wm.base = buildWorldBase(me.x, me.y);
  }
  const css = wmCanvas.clientWidth;
  const px = Math.round(css * DPR);
  if (wmCanvas.width !== px) wmCanvas.width = wmCanvas.height = px;
  const g = wmCanvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  const view = 58; // 圓形裡看得到的半徑(格)
  const s = (px / 2) / view; // 每格斜角半寬(像素)
  const ox = px / 2;
  const oy = px / 2;
  // 有縮小版的真實地圖就畫它;沒有才畫舊的示意圖
  g.fillStyle = ovMeta(st.mapId) ? '#0b0a08' : '#d6bd8c';
  g.fillRect(0, 0, px, px);
  const realOv = drawOverview(g, st.mapId, me.px, me.py, ox, oy, s, px, px);
  if (realOv) darkenOutsideBox(g, me, ox, oy, s, px, px);
  // 斜角變換:x 往右上、y 往右下(和主畫面一致)
  g.setTransform(s, -s / 2, s, s / 2, ox, oy);
  g.imageSmoothingEnabled = false;
  const k = 1 / WM_SUB;
  if (!realOv) g.drawImage(wm.base, wm.cx - WM_R - me.px - 0.5, wm.cy - WM_R - me.py - 0.5, wm.base.width * k, wm.base.height * k);
  drawClosedOverlay(g, me);
  // NPC:黃點(整張地圖的 NPC 位置,export-data.js npcSpots;再加上畫面附近看得到的)
  g.fillStyle = '#f2c230';
  const dot = (x, y) => {
    const dx = x - me.px;
    const dy = y - me.py;
    if (Math.abs(dx) <= WM_R && Math.abs(dy) <= WM_R) g.fillRect(dx - 0.6, dy - 0.6, 1.2, 1.2);
  };
  for (const [x, y] of st.game.npcSpots?.[st.mapId] || []) dot(x, y);
  for (const o of st.objects.values()) if (!o.dead && o.kind === 'npc') dot(o.px, o.py);
  // 傳點(洞窟入口、船…):紅點
  g.fillStyle = '#d8241a';
  for (const [x, y] of st.portals || []) dot(x, y);
  // 自己:紅色箭頭(照面向)
  g.setTransform(1, 0, 0, 1, 0, 0);
  const h = me.heading || 0;
  const vx = (DX[h] + DY[h]) * s; // 螢幕上的方向
  const vy = (DY[h] - DX[h]) * s / 2;
  const len = Math.hypot(vx, vy) || 1;
  const ux = vx / len;
  const uy = vy / len;
  const L = 9 * DPR;
  g.fillStyle = '#e8261c';
  g.strokeStyle = '#5a0a06';
  g.lineWidth = DPR;
  g.beginPath();
  g.moveTo(ox + ux * L, oy + uy * L);
  g.lineTo(ox - ux * L * 0.7 - uy * L * 0.6, oy - uy * L * 0.7 + ux * L * 0.6);
  g.lineTo(ox - ux * L * 0.3, oy - uy * L * 0.3);
  g.lineTo(ox - ux * L * 0.7 + uy * L * 0.6, oy - uy * L * 0.7 - ux * L * 0.6);
  g.closePath();
  g.fill(); g.stroke();
}

// ---- 縮小版地圖(tools/build_overview.py):跟遊戲畫面同樣斜角的真實地圖,小地圖 / 大地圖都用它 ----
// assets/map/ov/<id>.json + <id>/<cx>_<cy>.webp;還沒載入好時先用舊的示意圖
const OV_VER = 'o1';
const ov = { meta: {}, imgs: {}, fail: {}, tileFail: {} };
const ovBackoff = (n) => Math.min(30000, 1000 * 2 ** Math.min(n - 1, 5));
function ovMeta(id) {
  const f = ov.fail[id];
  if (f && f.at && performance.now() >= f.at) { f.at = 0; delete ov.meta[id]; } // 上次暫時失敗:時間到再抓
  if (!(id in ov.meta)) {
    ov.meta[id] = undefined;
    const v = window.AV?.ov?.[id] ?? (window.AV?.map?.[id] ? `${window.AV.map[id]}${OV_VER}` : OV_VER);
    fetch(`assets/map/ov/${id}.json?v=${v}`).then((r) => {
      if (r.status === 404) return null; // 這張地圖本來就沒有縮小版
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((m) => {
      ov.meta[id] = m ? { ...m, have: new Set(m.tiles), v } : null;
      delete ov.fail[id];
    }).catch(() => { const g = ov.fail[id] || (ov.fail[id] = { n: 0, at: 0 }); g.n++; g.at = performance.now() + ovBackoff(g.n); }); // 暫時失敗:維持「還不知道」,稍後重抓
  }
  return ov.meta[id];
}
function ovTile(id, m, key) {
  const k = `${id}/${key}`;
  let img = ov.imgs[k];
  const now = performance.now();
  // 上次抓失敗(或 30 秒都沒載好):時間到換一個新的 Image 重抓
  if (img && ((img.retryAt && now >= img.retryAt) || (!img.complete && now - img.t0 > 30000))) img = null;
  if (!img) {
    img = new Image();
    img.t0 = now;
    img.onload = () => { delete ov.tileFail[k]; };
    img.onerror = () => { const t = (ov.tileFail[k] = (ov.tileFail[k] || 0) + 1); img.retryAt = performance.now() + ovBackoff(t); };
    img.src = `assets/map/ov/${id}/${key}.webp?v=${m.v}`;
    ov.imgs[k] = img;
  }
  return img.complete && img.naturalWidth ? img : null;
}
function ovRetry() { // onNetBack():失敗的縮小版馬上重抓
  for (const id in ov.fail) if (ov.fail[id].at) ov.fail[id].at = 1;
  for (const k in ov.imgs) if (ov.imgs[k].retryAt) ov.imgs[k].retryAt = 1;
}
// 以 (px, py)(物件位置,格)為中心畫在 g 上:中心在畫布 (cx, cy),s = 每 1 個 (x+y) 單位的橫向像素(和斜角變換一致)
// 回傳 false = 這張地圖還沒有縮小版(呼叫端改畫示意圖)
function drawOverview(g, id, px, py, cx, cy, s, w, h) {
  const m = ovMeta(id);
  if (!m) return false;
  const k = (s / 24) * m.div; // 畫布像素 / 縮圖像素
  const ox = (((px + py) * 24 - m.ox) / m.div);
  const oy = (((py - px) * 12 - m.oy) / m.div);
  const x0 = ox - cx / k, y0 = oy - cy / k; // 畫布左上角對應的縮圖座標
  const x1 = x0 + w / k, y1 = y0 + h / k;
  const sm = g.imageSmoothingEnabled, q = g.imageSmoothingQuality; // 畫完還原:不要讓後面畫的東西都變成平滑 + high
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  let drew = false;
  for (let ty = Math.max(0, Math.floor(y0 / m.chunk)); ty <= Math.floor(y1 / m.chunk); ty++) {
    for (let tx = Math.max(0, Math.floor(x0 / m.chunk)); tx <= Math.floor(x1 / m.chunk); tx++) {
      const key = `${tx}_${ty}`;
      if (!m.have.has(key)) continue;
      const img = ovTile(id, m, key);
      if (!img) continue;
      // 對齊整數像素、每塊多畫 1px,相鄰兩塊之間才不會露出細縫
      const dx = Math.floor((tx * m.chunk - x0) * k);
      const dy = Math.floor((ty * m.chunk - y0) * k);
      g.drawImage(img, dx, dy, Math.ceil(m.chunk * k) + 1, Math.ceil(m.chunk * k) + 1);
      drew = true;
    }
  }
  g.imageSmoothingEnabled = sm;
  g.imageSmoothingQuality = q;
  return drew;
}
// 個人獵場:範圍外塗黑(斜角的菱形外面)
function darkenOutsideBox(g, me, cx, cy, s, w, h) {
  const b = st.map?.box;
  if (!b) return;
  const at = (x, y) => [cx + ((x - me.px) + (y - me.py)) * s, cy + ((y - me.py) - (x - me.px)) * s / 2];
  const [x0, y0, x1, y1] = [b[0] - 0.5, b[1] - 0.5, b[2] + 0.5, b[3] + 0.5];
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  const pts = [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
  g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.closePath();
  g.fillStyle = '#0b0a08';
  g.fill('evenodd');
  g.restore();
}

function buildMiniBase(cx, cy, R) {
  const size = R * 2 + 1;
  // 有原版地圖的俯視圖就直接裁一塊
  const real = ovMeta(st.mapId) === null ? L1MAP.mini(st.mapId) : null; // 有縮小版(ov)的地圖用不到這張(大陸那張 3.4 MB)
  mini.real = !!real;
  if (real) {
    const off = document.createElement('canvas');
    off.width = off.height = size;
    const g = off.getContext('2d');
    g.drawImage(real, cx - R - st.map.x0, cy - R - st.map.y0, size, size, 0, 0, size, size);
    const b = st.map.box;
    if (b) { // 個人獵場:範圍外塗黑
      const [bx0, by0, bx1, by1] = [b[0] - (cx - R), b[1] - (cy - R), b[2] - (cx - R) + 1, b[3] - (cy - R) + 1];
      g.fillStyle = '#0b0a08';
      g.fillRect(0, 0, size, by0); g.fillRect(0, by1, size, size - by1);
      g.fillRect(0, by0, bx0, by1 - by0); g.fillRect(bx1, by0, size - bx1, by1 - by0);
    }
    return off;
  }
  const img = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = tile(cx - R + x, cy - R + y);
      const i = (y * size + x) * 4;
      let c;
      if (!(t & 3)) c = isSea(cx - R + x, cy - R + y) ? [47, 111, 163, 255] : st.map.sea ? [52, 90, 45, 255] : [20, 18, 12, 255];
      else if ((t & 0x30) === 0x10) c = [150, 170, 95, 255];
      else if ((t & 0x30) === 0x20) c = [140, 80, 60, 255];
      else c = [95, 135, 70, 255];
      img.data.set(c, i);
    }
  }
  const off = document.createElement('canvas');
  off.width = off.height = size;
  off.getContext('2d').putImageData(img, 0, 0);
  return off;
}

function drawMinimap(now) {
  const me = self();
  if (!st.inGame || !st.map || !me || now - mini.last < 120) return;
  mini.last = now;
  // 遊戲時間(右上):☀ / ☾ + 時:分
  const hr = gameHour(now);
  const isNight = hr >= 18 || hr < 6;
  const clock = isNight ? '☾' : '☀'; // 只顯示太陽 / 月亮,不顯示時間
  const dn = $('#daynight');
  if (dn.textContent !== clock) { dn.textContent = clock; dn.title = `遊戲時間(${isNight ? '夜晚' : '白天'})`; }
  const R = mini.R;
  if (!mini.base || (!mini.real && ovMeta(st.mapId) === null && L1MAP.mini(st.mapId)) || Math.abs(me.x - mini.cx) > R / 3 || Math.abs(me.y - mini.cy) > R / 3) {
    mini.cx = me.x; mini.cy = me.y;
    mini.base = buildMiniBase(me.x, me.y, R);
  }
  const css = mmCanvas.clientWidth;
  const px = Math.round(css * DPR);
  if (mmCanvas.width !== px) { mmCanvas.width = mmCanvas.height = px; }
  const view = mini.big ? 56 : 34; // 顯示半徑(格)
  const k = css / (view * 2) / 1; // 每格像素(斜角寬)
  mm.setTransform(1, 0, 0, 1, 0, 0);
  mm.clearRect(0, 0, px, px);
  mm.fillStyle = '#0b0a08';
  mm.fillRect(0, 0, px, px);
  // 斜角變換:x 軸往右下、y 軸往左下,與主畫面一致
  const s = DPR * k;
  const ox = px / 2;
  const oy = px / 2;
  // 有縮小版的真實地圖就畫它(和遊戲畫面一樣);沒有才用舊的示意圖
  const realOv = drawOverview(mm, st.mapId, me.px, me.py, ox, oy, s, px, px);
  if (realOv) darkenOutsideBox(mm, me, ox, oy, s, px, px);
  mm.setTransform(s, -s / 2, s, s / 2, ox, oy);
  mm.imageSmoothingEnabled = false;
  if (!realOv) mm.drawImage(mini.base, mini.cx - R - me.px, mini.cy - R - me.py);
  drawClosedOverlay(mm, me);
  // 物件點
  for (const o of st.objects.values()) {
    if (o.dead || o.dying || o.kind === 'item' || o.kind === 'door' || isHiddenPet(o)) continue;
    const dx = o.px - me.px;
    const dy = o.py - me.py;
    if (Math.abs(dx) > view || Math.abs(dy) > view) continue;
    mm.fillStyle = o.id === st.selfId ? '#ffffff' : o.kind === 'monster' ? '#ff5b4b' : o.kind === 'pc' ? '#5aa0ff' : '#ffd36b';
    const r = o.id === st.selfId ? 1.6 : 1.1;
    mm.fillRect(dx - r / 2 + 0.5, dy - r / 2 + 0.5, r, r);
  }
  // 血流成河:積分王(伺服器每秒送位置,hud.js onChat);不在小地圖範圍內就貼在邊緣指方向
  const king = st.arenaKing;
  if (king && inArenaEvent() && now - king.at < 3000) {
    let dx = king.x - me.px, dy = king.y - me.py;
    const f = Math.max(Math.abs(dx), Math.abs(dy)) / (view - 2);
    if (f > 1) { dx /= f; dy /= f; }
    const blink = Math.floor(now / 300) % 2 === 0;
    mm.fillStyle = blink ? '#ffd700' : '#ff3b30';
    mm.fillRect(dx - 1.5, dy - 1.5, 4, 4);
  }
  mm.setTransform(1, 0, 0, 1, 0, 0);
  // 自己:白點外框
  mm.strokeStyle = '#ffffff';
  mm.lineWidth = DPR;
  mm.beginPath(); mm.arc(ox + s, oy, 3.5 * DPR, 0, Math.PI * 2); mm.stroke();
}

// 走路動畫:位置內插(畫面和背景分頁的遊戲邏輯共用)
function updateAnims(now) {
  for (const o of st.objects.values()) {
    if (o.anim) {
      const t = Math.min(1, (now - o.anim.start) / o.anim.dur);
      // 原版走路是一格格踩的:位置跟著走路圖的張數跳(沒有原版圖的才平滑移動)
      const k = t >= 1 ? 1 : L1S.walkProgress(o, now) ?? t;
      o.px = o.anim.fx + (o.x - o.anim.fx) * k;
      o.py = o.anim.fy + (o.y - o.anim.fy) * k;
      if (t >= 1) { const end = o.anim.start + o.anim.dur; o.anim = null; if (o.stepQ && o.stepQ.length) { startSelfStep(o, Math.max(end, now - 50)); } }
    } else { o.px = o.x; o.py = o.y; }
  }
}

// ---- 背景分頁繼續跑(電腦版開多個分頁掛機):瀏覽器對看不到的分頁會停掉 requestAnimationFrame、
// 把計時器降到最慢一分鐘一次,AUTO 就停了。改用 Web Worker 的計時器(不會被降速)每 50ms 推一次遊戲邏輯(不畫畫面)。
// 個人獵場由伺服器代打(webAway)時網頁不插手。hud.js 的 AUTO / 自動喝水 / 輔助魔法也用 tickEvery 掛在這個計時器上
const serverHunting = () => webAway && st.inInstance;
const tickJobs = [];
const tickJobHandles = new Map();
function tickEvery(fn, ms, name) { const job = { fn, ms, next: 0 }; tickJobs.push(job); if (name) tickJobHandles.set(name, job); return job; }
function runTick() {
  const now = performance.now();
  if (typeof unifiedRetry === 'function') unifiedRetry(now);
  for (const j of tickJobs) {
    if (now < j.next) continue;
    j.next = now + j.ms;
    try { j.fn(); } catch (e) { console.error(e); }
  }
  if (document.visibilityState === 'hidden' && st.inGame && !serverHunting()) { step(now); updateAnims(now); }
}
try {
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50);'], { type: 'text/javascript' })));
  w.onmessage = runTick;
} catch { setInterval(runTick, 50); } // 不支援 Worker:退回一般計時器

// ---- 效能自動調整(使用者 10/22:安卓手機 / 三星平板會卡;測量見 deploy/perf)----
// 等級:0 全速 60fps;1 隔幀畫(30fps,邏輯照跑);2 再加解析度上限 1.5;3 再加解析度上限 1 + 流暢模式。
// 自動模式走完整階梯 0→1→2→3;卡才降(連續 2 秒)、順了才升(連續 15 秒),每次調整後冷卻 20 秒;玩家可在 設定 → 畫質 鎖定(自動 / 高 / 中 / 低),存在這台裝置。
const PERF = {
  mode: (() => { try { const m = localStorage.getItem('l1j.perfMode'); return ['auto', 'high', 'mid', 'low'].includes(m) ? m : 'auto'; } catch (e) { return 'auto'; } })(),
  level: 0, lastDraw: 0, lastNow: 0, ema: 0, dtEma: 16.7, overSince: 0, underSince: 0, coolUntil: 0, autoFlow: false,
  ring: new Float32Array(1800 * 3), ringN: 0, startAt: performance.now(), workSum: 0, workN: 0,
};
const PERF_CAPS = [Infinity, Infinity, 1.5, 1];
const PERF_DESC = ['全速', '30fps', '30fps、解析度上限 1.5', '30fps、解析度上限 1、流暢模式'];
const perfCtx = () => `${typeof panel !== 'undefined' && panel?.name ? panel.name + (panel.tab ? '/' + panel.tab : '') : '無面板'}${document.visibilityState === 'hidden' ? ' 背景' : ''}${document.hasFocus() ? '' : ' 沒焦點'}`;
function perfApply(level, announce) {
  if (level === PERF.level) return;
  const prev = PERF.level;
  PERF.level = level;
  PERF_CAP = PERF_CAPS[level];
  resize();
  if (level >= 3 && PERF.mode !== 'high' && typeof L1S !== 'undefined' && !L1S.flow()) { L1S.setFlow(true); PERF.autoFlow = true; }
  if (level < 3 && PERF.autoFlow) { L1S.setFlow(false); PERF.autoFlow = false; }
  if (level > PERF.level || announce) { (PERF.drops ||= []).push([Date.now(), level, +PERF.ema.toFixed(1), +PERF.dtEma.toFixed(1), perfCtx()]); if (PERF.drops.length > 10) PERF.drops.shift(); }
  if (announce) toast(`畫面偏卡,已自動降低畫質(${PERF_DESC[level]});可在 設定 → 畫質 調整`);
  else if (PERF.mode === 'auto' && level < prev) toast(`效能恢復,畫質調回(${PERF_DESC[level]})`); // 11/10:不提示的降級(來回切換)不要跳成「恢復」
}
function perfSetMode(m) {
  PERF.mode = m;
  try { localStorage.setItem('l1j.perfMode', m); } catch (e) { /* 無痕模式 */ }
  PERF.overSince = 0; PERF.underSince = 0; PERF.coolUntil = 0;
  if (m === 'high') perfApply(0, false);
  else if (m === 'mid') perfApply(1, false);
  else if (m === 'low') perfApply(3, false);
}
function perfSample(now, work, drew) {
  const dt = now - PERF.lastNow;
  PERF.lastNow = now;
  if (dt > 500 || dt <= 0) return; // 切分頁 / 剛進遊戲:不算
  PERF.dtEma = PERF.dtEma * 0.95 + dt * 0.05;
  if (dt > 50) { (PERF.slow ||= []).push([Date.now(), Math.round(dt), Math.round(work), perfCtx()]); if (PERF.slow.length > 20) PERF.slow.shift(); } // 11/10 使用者 Brave/Mac 降畫質但 p95 看不出:記最近 20 個慢幀
  if (drew) { PERF.ema = PERF.ema * 0.9 + work * 0.1; PERF.workSum += work; PERF.workN++; }
  { const rk = (PERF.ringN++ % 1800) * 3; PERF.ring[rk] = work; PERF.ring[rk + 1] = dt; PERF.ring[rk + 2] = drew ? 1 : 0; } // 最近 1800 筆(60fps 約 30 秒)
  if (PERF.mode !== 'auto' || now < PERF.coolUntil) return;
  const lvl = PERF.level;
  const over = lvl === 0 ? (PERF.ema > 11 || PERF.dtEma > 24) : (PERF.ema > 20 || PERF.dtEma > 50);
  const under = lvl > 0 && PERF.ema < 6 && PERF.dtEma < 40;
  if (over && lvl < 3) { // 自動階梯:30fps → 解析度上限 1.5 → 解析度上限 1 + 流暢模式(使用者 / 主導 10/23:Mali 機 CPU×6 仍 94%,只有降 DPR 救得到;卡連續 2 秒才降、順 15 秒才升;玩家鎖「高」就不自動降)
    PERF.overSince ||= now;
    if (now - PERF.overSince > 2000) {
      PERF.overSince = 0; PERF.coolUntil = now + 20000;
      // 11/10 使用者 Brave/Mac(沒顯示卡加速):調回全速 60 秒內又卡 = 這台撐不住全速,10 分鐘內不再自動調回,也不再一直跳提示(原本每 40 秒來回一次)
      const flap = now - (PERF.upAt || -1e9) < 60000; if (flap) PERF.holdUntil = now + 600000;
      perfApply(lvl + 1, !flap);
    }
  } else PERF.overSince = 0;
  if (under && now >= (PERF.holdUntil || 0)) {
    PERF.underSince ||= now;
    if (now - PERF.underSince > 15000) { PERF.underSince = 0; PERF.coolUntil = now + 20000; PERF.upAt = now; perfApply(lvl - 1, false); }
  } else PERF.underSince = 0;
}
// 效能診斷:最近約 5 秒的幀資料 + 裝置資訊(設定 → 畫質 → 效能診斷,可一鍵複製回報)
function perfDiagText() {
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
  const r = [];
  for (let i = 0, n = Math.min(PERF.ringN, 1800); i < n; i++) r.push([PERF.ring[i * 3], PERF.ring[i * 3 + 1], PERF.ring[i * 3 + 2]]);
  const work = r.filter((x) => x[2]).map((x) => x[0]);
  const dts = r.map((x) => x[1]);
  const secs = r.reduce((a, x) => a + x[1], 0) / 1000;
  const st2 = typeof L1S !== 'undefined' && L1S.stats ? L1S.stats() : {};
  return [
    `時間 ${new Date().toLocaleString()}`,
    `繪圖後端 ${JSON.stringify(worldBackendStats())}`,
    `畫質模式 ${PERF.mode} / 目前等級 ${PERF.level}(${PERF_DESC[PERF.level]})/ 流暢模式 ${typeof L1S !== 'undefined' && L1S.flow ? L1S.flow() : '?'}`,
    `畫面 ${innerWidth}x${innerHeight} DPR ${devicePixelRatio} → 畫布 ${canvas.width}x${canvas.height}(DPR ${DPR.toFixed(2)}、ZOOM ${ZOOM.toFixed(2)})`,
    `可視 ${Math.round(window.visualViewport?.width || 0)}x${Math.round(window.visualViewport?.height || 0)} 上移 ${Math.round(window.visualViewport?.offsetTop || 0)} / 螢幕 ${screen.width}x${screen.height} / 安全區 ${safeAreaText()} / 底部補正 ${getComputedStyle(document.documentElement).getPropertyValue('--vvb') || '0px'} / 主畫面模式 ${matchMedia('(display-mode: standalone)').matches || !!navigator.standalone}`,
    `近 ${secs.toFixed(0)} 秒(最多 30 秒):實際 fps ${(r.filter((x) => x[2]).length / Math.max(0.1, secs)).toFixed(1)};幀間隔 p50 ${pct(dts, 0.5)} / p95 ${pct(dts, 0.95)} ms;JS 每幀 p50 ${pct(work, 0.5)} / p95 ${pct(work, 0.95)} ms`,
    `整段 JS 平均每幀 ${(PERF.workSum / Math.max(1, PERF.workN)).toFixed(1)} ms;物件 ${st.objects.size};精靈圖記憶體 ${st2.bitmapMB ?? '?'} MB(上限 ${st2.budgetMB ?? '?'})`,
    `降畫質紀錄(最近 10 次;幾秒前 → 等級 / JS 平均 ms / 幀間隔平均 ms / 當時):${(PERF.drops || []).map((d) => `${Math.round((Date.now() - d[0]) / 1000)}s→${d[1]} ${d[2]}/${d[3]} ${d[4]}`).join(';') || '無'}`,
    `慢幀 >50ms(最近 20 個;幾秒前 幀間隔/JS ms 當時):${(PERF.slow || []).map((d) => `${Math.round((Date.now() - d[0]) / 1000)}s ${d[1]}/${d[2]} ${d[3]}`).join(';') || '無'}`,
    `GPU ${typeof gpuName === 'function' ? gpuName() : '?'}`,
    `記憶體 ${navigator.deviceMemory || '?'} GB / 核心 ${navigator.hardwareConcurrency || '?'}`,
    `UA ${navigator.userAgent}`,
    ...(st.atkLog || st.ackLog || st.msgLog ? [
      `最近出手(${(st.atkLog || []).length} 次;幾秒前 / 和上一次相隔 ms / 目標編號):${(st.atkLog || []).map((x) => `${((performance.now() - x.t) / 1000).toFixed(1)}s/${x.dt}ms/#${x.id}`).join(' ')}`,
      `伺服器回自己攻擊(最近 ${(st.ackLog || []).length} 次,幾秒前):${(st.ackLog || []).map((t) => ((performance.now() - t) / 1000).toFixed(1) + 's').join(' ')}`,
      `伺服器系統訊息編號(最近 ${(st.msgLog || []).length} 則):${(st.msgLog || []).map((x) => `#${x.id}@${((performance.now() - x.t) / 1000).toFixed(0)}s`).join(' ')}`,
    ] : []),
    ...(RM.active ? [`渲染基線 ${JSON.stringify((() => { const m = RM.snapshot(); return { raf: m.raf, renders: m.worldRenders, intervalP95: m.samples.interval.p95, pauses: m.intervals.pausesOver500.length, handleP95: m.samples.handle.p95 }; })())}`] : []),
    ...(b02On() ? [b02DiagText()] : []),
    ...(st.silentLog && st.silentLog.length ? [`AUTO 無回應紀錄(最近 ${st.silentLog.length} 筆):`, ...st.silentLog.map((x) => `  ${x}`)] : []),
  ].join('\n');
}

// 用伺服器格子座標判斷跳躍,不看鏡頭 / px 的插值;同圖、同區塊內瞬移也會觸發。
let preloadPos = null;
let preloadJump = 0;
function preloadPosition(me) {
  if (!me || !st.inGame) { preloadPos = null; preloadJump++; return; }
  const prev = preloadPos;
  const changed = !prev || prev.id !== me.id || prev.key !== st.mapKey;
  const jumped = !changed && Math.max(Math.abs(me.x - prev.x), Math.abs(me.y - prev.y)) > 30;
  if (changed || jumped) {
    const ticket = ++preloadJump;
    const key = st.mapKey, id = st.mapId, selfId = me.id;
    PRELOAD.pause(5000); // 背景最多補 1 條,讓眼前地面先下載
    L1MAP.urlsNear(id, me.x, me.y, 1).then((urls) => {
      // 連續傳送時舊目的地晚到,不能再插回新目的地前面。
      if (ticket === preloadJump && st.inGame && st.mapKey === key && self()?.id === selfId) PRELOAD.add(urls, true);
    }).catch(() => {}); // 暫時失敗由地圖原有重試流程處理
  }
  if (!preloadPos) preloadPos = {};
  preloadPos.id = me.id; preloadPos.key = st.mapKey;
  preloadPos.x = me.x; preloadPos.y = me.y;
}
let hudPosText = ''; // #hud-pos 目前顯示的座標
function frame(now) {
  // 改這個函式要同步 rmFrame（rm_replay.js 會檢查）。
  requestAnimationFrame(frame);
  if (RM.active) return rmFrame(now);
  const perfT0 = performance.now();
  if (catchUp.n <= CATCHUP_PER_FRAME && now > catchUp.until) catchUp.on = false; // 這一格沒有湧進大量事件:補送結束
  catchUp.n = 0;
  step(now);
  updateAnims(now);
  const me = self();
  preloadPosition(me);
  if (me) {
    st.cam.x = me.px; st.cam.y = me.py;
    // 座標有變才寫:每格都寫 textContent 會讓版面失效,小地圖讀 clientWidth 時就要整頁重排
    const pos = `${me.x}, ${me.y}`;
    if (pos !== hudPosText) { hudPosText = pos; $('#hud-pos').textContent = pos; }
  }
  updateCaptureBtn();
  if (me && st.map) PRELOAD.near(st.mapId, me.x, me.y); // 換區塊時才會排新的下載
  // 效能自動調整:PERF.level >= 1 時隔幀畫(邏輯 step / 動畫狀態照每幀跑,只少畫)
  const perfDrew = PERF.level < 1 || now - PERF.lastDraw >= 28;
  if (perfDrew) { PERF.lastDraw = now; draw(now); drawMinimap(now); }
  perfSample(now, performance.now() - perfT0, perfDrew);
}
requestAnimationFrame(frame);


// Retained-world records are data, never Canvas drawImage/getTransform recordings.
// Only overlays use buildScene's Proxy; tiny procedural decorations use native bitmaps.
function worldImages(images, kind = 'floor', key = null, clip = null) {
  WORLD.recording.push({ images, kind, entity: key, clip, order: WORLD.rankCursor ?? 0 });
}
function worldImageSink(images) {
  return {
    imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
    drawImage(img, ...a) {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      let cell = [0, 0, iw, ih], dx, dy, w, h;
      if (a.length === 2) { [dx, dy] = a; w = iw; h = ih; }
      else if (a.length === 4) [dx, dy, w, h] = a;
      else { cell = a.slice(0, 4); [dx, dy, w, h] = a.slice(4); }
      images.push({ img, cell, dx, dy, width: w, height: h, scale: [w / cell[2], h / cell[3]],
        alpha: 1, blend: 'source-over', smooth: this.imageSmoothingEnabled });
    }
  };
}
function worldBitmap(slot, w, h, paint) {
  const scale = DPR * ZOOM, image = slot.image ||= document.createElement('canvas');
  const pw = Math.ceil(w * scale), ph = Math.ceil(h * scale);
  if (image.width !== pw || image.height !== ph) { image.width = pw; image.height = ph; }
  const g = image.getContext('2d'), previous = ctx;
  g.resetTransform(); g.clearRect(0, 0, pw, ph); g.setTransform(scale, 0, 0, scale, 0, 0);
  ctx = g;
  try { paint(g); } finally { ctx = previous; }
  image.__worldRevision = (image.__worldRevision || 0) + 1;
  return { img: image, cell: [0, 0, pw, ph], dx: 0, dy: 0, scale: [1 / scale, 1 / scale],
    width: pw / scale, height: ph / scale, smooth: false, alpha: 1, blend: 'source-over' };
}
const WORLD_BITMAPS = new WeakMap(), WORLD_MAP_COMMANDS = new WeakMap();
function worldObjectBitmap(o, w, h, paint) {
  let slot = WORLD_BITMAPS.get(o);
  if (!slot) WORLD_BITMAPS.set(o, slot = {});
  return worldBitmap(slot, w, h, paint);
}
let worldOrderCache = null;
function worldRetainedOrder(list, maps, props, box) {
  const all = maps.all, mapSignature = [st.mapId, box, ...(box || []), box && instBlocked()];
  const signature = [...mapSignature, st.hideOthersPets, ...list.flatMap(o => [o, o.py - o.px, o.kind])];
  const previous = worldOrderCache;
  if (previous && previous.all === all && !props.length && signature.length === previous.signature.length
      && signature.every((v, i) => Object.is(v, previous.signature[i]))) return previous;
  const started = RM.clock();
  list.sort((a, b) => (a.py - a.px) - (b.py - b.px) || (a.kind === 'item' ? -1 : 1));
  const cr = list.filter(o => o.kind !== 'item'), ordered = [], rank = new Map();
  const eligible = mo => !(st.mapId === 4 && ANT_HOLE_NEAR.has(mo.x * 65536 + mo.y))
    && (!box || (mo.x >= box[0] && mo.y >= box[1] && mo.x <= box[2] && mo.y <= box[3] && instBlocked().has(mo.x * 65536 + mo.y)));
  const mapObjects = previous && previous.all === all && mapSignature.length === previous.mapSignature.length
    && mapSignature.every((v, i) => Object.is(v, previous.mapSignature[i])) ? previous.mapObjects : all.filter(eligible);
  if (!props.length && cr.every(o => Number.isFinite(o.py - o.px))) {
    cr.sort((a, b) => (a.py - a.px) - (b.py - b.px));
    let ci = 0;
    for (const mo of mapObjects) {
      while (ci < cr.length && cr[ci].py - cr[ci].px <= mo.depth - 0.01) ordered.push({ e: cr[ci++], k: 1 });
      ordered.push({ e: mo, k: 0 });
    }
    while (ci < cr.length) ordered.push({ e: cr[ci++], k: 1 });
  } else {
    const layers = cr.map(e => ({ e, k: 1, d: e.py - e.px }));
    for (const e of props) layers.push({ e, k: 2, d: e.y - e.x });
    for (const e of mapObjects) layers.push({ e, k: 0, d: e.depth - 0.01 });
    layers.sort((a, b) => a.d - b.d);
    ordered.push(...layers);
  }
  ordered.forEach(({ e }, i) => rank.set(e, i));
  return worldOrderCache = { all, signature, mapSignature, ordered, rank, mapObjects, creatures: ordered.filter(entry => entry.k !== 0), items: list.filter(o => o.kind === 'item'),
    sortMs: RM.clock() - started };
}
function drawRetainedItem(o) {
  const p = toScreen(o.px, o.py);
  const d = worldObjectBitmap(o, 64, 64, () => {
    // 地上的道具:Flare 圖示縮小放在格子上
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(32, 40 + 2, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
    if (GDX.drawIcon(ctx, o, 32 - 13, 40 - 22, 26) || (GDX.hasIcon(o) === false && FLARE.drawIcon(ctx, o, 32 - 13, 40 - 22, 26))) {
      // 已畫
    } else if (GDX.hasIcon(o) === undefined) {
      // 原版圖示還在載入
    } else if (!SPR.draw(ctx, SPR.item(o), 32, 40 + 6, 2)) {
      ctx.fillStyle = KIND_COLOR.item;
      ctx.beginPath(); ctx.arc(32, 40, 6, 0, Math.PI * 2); ctx.fill();
    }
  
  });
  d.dx = p.x - 32; d.dy = p.y - 40;
  worldImages([d], 'item', o);
  const previous = worldLayer('overlay');
  label(o.name, p.x, p.y - 26, '#ffe7a6');
  worldLayer(previous);
}
function retainedCreatureLayers(o, x, y, now, isMe) {
  let layers = L1S.describeCreature(o, x, y, now);
  if (!layers.height && o.kind !== 'door' && !L1S.known(o.gfx)) {
    const fallback = FLARE.describeCreature(o, isMe, st.myType, x, y, now);
    if (fallback.height) layers = fallback;
  }
  // Reproduce the paint-state changes used by subsequent overlays.
  if (layers.shadow) ctx.fillStyle = 'rgba(0,0,0,.28)';
  if (layers.quality) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = layers.quality; }
  worldImages(layers, 'creature', o);
  return layers.height;
}


const WORLD_NO_MAP = [];
const WORLD_FLOOR_BITMAP = {}, WORLD_HOLE_BITMAP = {}, WORLD_TAP_BITMAP = {}, WORLD_PATH_BITMAP = {};
function retainedFloor(now, view, realMap, pendingMap, box) {
  const { W, H } = view, props = [];
  let clip = null;
  if ((realMap || pendingMap) && box) clip = [[box[0] - 0.5, box[1] - 0.5], [box[2] + 0.5, box[1] - 0.5],
    [box[2] + 0.5, box[3] + 0.5], [box[0] - 0.5, box[3] + 0.5]].map(([x, y]) => toScreen(x, y));
  if (realMap || pendingMap) {
    const overview = [];
    drawOverview(worldImageSink(overview), st.mapId, st.cam.x, st.cam.y, W / 2, view.cy, TW / 2, W, H);
    worldImages(overview, 'floor', null, clip);
    if (realMap) worldImages(L1MAP.describeFloor(st.mapId, view, toScreen, now), 'floor', null, clip);
    const hints = [], previous = ctx;
    ctx = worldImageSink(hints);
    try { drawWalkHintFloor(view); } finally { ctx = previous; }
    worldImages(hints);
  } else {
    const d = worldBitmap(WORLD_FLOOR_BITMAP, W, H, () => {
      const R = realMap || L1MAP.pending(st.mapId) ? -1 : Math.ceil(Math.max(W / TW, H / TH)) + 2;
      const cx = Math.round(st.cam.x);
      const cy = Math.round(st.cam.y);
      const outdoor = OUTDOOR_MAPS.has(st.mapId);
    
      const flare = FLARE.terrainReady();
      for (let y = cy - R; y <= cy + R; y++) {
        for (let x = cx - R; x <= cx + R; x++) {
          const p = toScreen(x, y);
          if (p.x < -TW || p.x > W + TW || p.y < -TH * 3 || p.y > H + TH * 3) continue;
          const t = tile(x, y);
          if (!(t & 3)) {
            if (outdoor && isSea(x, y)) {
              // 海:水面
              if (!(flare && FLARE.drawTile(ctx, 'water', FLARE.hash(x * 7919 + y), p.x, p.y))) {
                ctx.drawImage(waterTile((x * 7 + y * 13 + Math.floor(performance.now() / 600)) % 3), p.x - TW / 2, p.y - TH / 2);
              }
              continue;
            }
            if (flare && outdoor) {
              // 內陸不可走:草地上長樹 / 草叢 / 岩石(靠路邊必放,內部隨機)
              // 安全區(村莊)裡的障礙多半是房子 / 圍牆:碎石地上放箱子、帳篷、柵欄;野外則是樹林
              const town = (t & 0x30) === 0x10;
              FLARE.drawTile(ctx, town ? 'stone' : 'grass', FLARE.hash(x * 73856093 ^ y * 19349663), p.x, p.y);
              const edge = (tile(x + 1, y) & 3) || (tile(x - 1, y) & 3) || (tile(x, y + 1) & 3) || (tile(x, y - 1) & 3);
              const h = FLARE.hash(x * 2654435761 ^ y * 40503);
              const groups = town ? ['fence', 'town', 'fence', 'town'] : ['tree', 'tree', 'pine', 'bush', 'tree', 'rock'];
              if (edge || h % 3 === 0) props.push({ x, y, p, group: groups[h % groups.length], seed: h });
              continue;
            }
            // 內陸不可走的格子:室外鋪深色林地,靠路邊的放樹;室內留黑、靠路邊放石牆
            if (outdoor) ctx.drawImage(forestTile(), p.x - TW / 2, p.y - TH / 2);
            if ((tile(x + 1, y) & 3) || (tile(x - 1, y) & 3) || (tile(x, y + 1) & 3) || (tile(x, y - 1) & 3)) props.push({ x, y, p });
            else if (outdoor && SPR.hash(x * 31 ^ y * 17) % 3 === 0) props.push({ x, y, p });
            continue;
          }
          let key;
          if ((t & 0x30) === 0x10) key = outdoor && SPR.hash(x * 73856093 ^ y * 19349663) % 23 === 0 ? 'grass3' : 'safe';
          else if ((t & 0x30) === 0x20) key = 'combat';
          else if (!outdoor) key = 'dungeon';
          else { const r = SPR.hash(x * 73856093 ^ y * 19349663) % 23; key = r === 0 ? 'grass3' : r < 5 ? 'grass2' : 'grass'; }
          // 安全區(村莊)鋪碎石地,其他草地
          if (flare && outdoor && FLARE.drawTile(ctx, key === 'safe' ? 'stone' : 'grass', FLARE.hash(x * 73856093 ^ y * 19349663), p.x, p.y)) continue;
          const img = SPR.isoTile(key, TW, TH);
          if (img) ctx.drawImage(img, p.x - TW / 2, p.y - TH / 2);
          else {
            ctx.fillStyle = { safe: '#4d5236', combat: '#4a2f28' }[key] || '#3b4a2b';
            ctx.beginPath(); ctx.moveTo(p.x, p.y - TH / 2); ctx.lineTo(p.x + TW / 2, p.y); ctx.lineTo(p.x, p.y + TH / 2); ctx.lineTo(p.x - TW / 2, p.y); ctx.fill();
          }
        }
      }
      drawWalkHintFloor(view);
      for (const { x, y, p } of props) {
        if (flare && outdoor) continue; // Flare 的樹在下面和角色一起依深度畫
        if (outdoor) {
          const h = SPR.hash(x * 2654435761 ^ y);
          SPR.draw(ctx, ['town', [SPR.TT.tree, SPR.TT.tree2, SPR.TT.bush][h % 3]], p.x, p.y + 4, 3, h & 8);
        } else {
          const img = SPR.isoTile('wall', TW, TH);
          if (img) for (let k = 0; k < 3; k++) ctx.drawImage(img, p.x - TW / 2, p.y - TH / 2 - k * 10);
        }
      }
    
    
    });
    worldImages([d]);
  }
  if (st.mapId === 4) {
    if (WORLD_HOLE_BITMAP.scale !== DPR * ZOOM) {
      WORLD_HOLE_BITMAP.d = worldBitmap(WORLD_HOLE_BITMAP, TW * 3, TW * 2, () => drawSandHole(TW * 1.5, TW));
      WORLD_HOLE_BITMAP.scale = DPR * ZOOM;
    }
    for (const [hx, hy] of ANT_HOLES) {
      const p = toScreen(hx, hy);
      if (p.x < -TW * 2 || p.x > W + TW * 2 || p.y < -TH * 2 || p.y > H + TH * 2) continue;
      worldImages([{ ...WORLD_HOLE_BITMAP.d, dx: p.x - TW * 1.5, dy: p.y - TW }]);
    }
  }
  const outline = (slot, p, k, color, width) => {
    const key = [k, color, width, DPR * ZOOM].join(';');
    if (slot.key !== key) {
      slot.key = key; slot.description = worldBitmap(slot, TW * 2, TH * 2, () => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      ctx.moveTo(TW, TH - TH / 2 * k); ctx.lineTo(TW + TW / 2 * k, TH);
      ctx.lineTo(TW, TH + TH / 2 * k); ctx.lineTo(TW - TW / 2 * k, TH); ctx.closePath(); ctx.stroke();
      });
    }
    const d = { ...slot.description, dx: p.x - TW, dy: p.y - TH }; worldImages([d]);
  };
  if (st.tap && now - st.tap.at < 300) {
    const k = (now - st.tap.at) / 300;
    outline(WORLD_TAP_BITMAP, toScreen(st.tap.x, st.tap.y), 1.4 - 0.4 * k, `rgba(120,230,150,${1 - k})`, 2);
  }
  if (st.path.length) {
    const d = st.path[st.path.length - 1];
    outline(WORLD_PATH_BITMAP, toScreen(d.x, d.y), 1, 'rgba(120,230,150,.9)', 1.5);
  }
  return FLARE.terrainReady() && OUTDOOR_MAPS.has(st.mapId) ? props : [];
}

function drawRetainedCreature(o, now) {
  const p = objScreen(o);
  const isMe = o.id === st.selfId;
  const color = isMe ? '#8fd0ff' : KIND_COLOR[o.kind] || '#aaa';
  const x = p.x;
  const y = p.y;

  // 伺服器生成的特效物件(火牢的火焰 L1Effect 等,沒有名字所以被當成門):照特效畫(發光混合、循環播放)
  if (o.kind === 'door' && st.game.effectKinds?.[o.gfx]) {
    worldLayer('overlay');
    o.fxStart ??= now;
    const info = L1S.effectInfo(o.gfx);
    if (info) L1S.drawEffect(ctx, o.gfx, x, y, (now - o.fxStart) % Math.max(1, info.dur), o.heading ?? 5, false, o);
    return;
  }
  if (o.kind === 'door') { retainedCreatureLayers(o, x, y, now, isMe); return; } // 門、火把只有原版圖
  // 天堂客戶端的 8 方向動畫;沒有這個外型才用 Flare 素材
  // 原圖還在載入時什麼都不畫(不要先閃一下替代圖)
  let height = retainedCreatureLayers(o, x, y, now, isMe);
  if (isMe && height) st.meH = height; // 擋住人物的物件變淡用(人物圖的高度)
  if (!height && L1S.known(o.gfx)) return; // 原圖還在載入:這幾格先不畫(不要閃出舊的佔位圖)
  if (!height) {
    const d = worldObjectBitmap(o, 80, 96, () => {
    // 沒有天堂原圖的外型:舊的佔位圖
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(40, 80, 14, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (o.dead) return;
    const h = o.heading ?? 4;
    if (!SPR.draw(ctx, SPR.creature(o, isMe, st.myType), 40, 82, 3, DX[h] + DY[h] < 0)) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(40, 60, 12, 0, Math.PI * 2); ctx.fill();
    }

    });
    d.dx = x - 40; d.dy = y - 80;
    worldImages([d], 'creature', o);
    if (o.dead) return;
    height = 48;
  }
  if (o.dead || o.kind === 'door') return; // 門、火把沒有名稱和血條
  worldLayer('overlay');
  const big = height / 48;

  const displayedTarget = unifiedPassive() ? unifiedControl.target : st.target;
  if (displayedTarget && displayedTarget.id === o.id) {
    ctx.strokeStyle = '#ff5b4b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }

  if (st.clickSelect && !auto.on && st.picked?.id === o.id && !o.dying && st.target?.id !== o.id) {
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // 名稱與血條
  const nameColor = o.kind === 'pc' ? (isPink(o.id) ? PINK_NAME : lawfulColor(o.lawful)) : o.kind === 'monster' ? '#ffd0c8' : o.kind === 'pet' ? (isMyPet(o) ? '#9fe8ff' : '#c8d8f5') : '#c8f5c4';
  // 封號:名字正上方另一行(顏色前綴 1~7 = 紅橙黃綠藍靛紫,沒有就跟名字同色)
  const tp = o.title ? titleParts(o.title) : null;
  const onScreen = x > -120 && x < canvas.width / (DPR * ZOOM) + 120 && y > -40 && y < canvas.height / (DPR * ZOOM) + 160;
  // 10/28 試做:其他玩家的名字 / 封號 / 盟徽預設不畫;點到(8 秒)、選為目標時才畫
  const pkRank = o.kind === 'pc' && st.pkRank && !inArenaEvent() && o.pkRank >= 1 && o.pkRank <= 3 ? o.pkRank : 0;
  const pcNameHidden = !pkRank && !st.showPcNames && o.kind === 'pc' && !isMe && !isWarEnemy(o) && st.target?.id !== o.id && st.picked?.id !== o.id && !(st.nameShow?.id === o.id && now < st.nameShow.until);
  if (onScreen && !pcNameHidden) { // 畫面外的(伺服器送來的範圍比手機畫面大很多)不畫名字:省掉一半以上的文字描邊
    const ny = y - height - (isMe ? 13 : 10);
    label(o.name, x, ny, isMe ? (isPink(o.id) ? PINK_NAME : '#bfe6ff') : nameColor); // 11/12 自己先動手也看得到粉紅名
    const eh = drawEmblem(o, x, ny) || 0;
    const ty = Math.min(ny - 14, ny - 5 - eh / 2 - 4); // 原稱號避開盟徽上緣
    if (tp?.text) label(tp.text, x, ty, tp.color || (isMe ? (isPink(o.id) ? PINK_NAME : '#bfe6ff') : nameColor));
    if (pkRank) label(`☠ 殺人榜 No.${pkRank}`, x, tp?.text ? ty - 14 : ty, '#ff4545');
  }
  // 自己:頭上顯示 HP(紅)/ MP(藍)
  if (isMe && st.me?.maxHp) {
    const w = 34;
    const hp = Math.max(0, Math.min(1, st.me.hp / st.me.maxHp));
    const mp = st.me.maxMp ? Math.max(0, Math.min(1, st.me.mp / st.me.maxMp)) : 0;
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x - w / 2 - 1, y - height - 7, w + 2, 8);
    ctx.fillStyle = '#e0453a'; ctx.fillRect(x - w / 2, y - height - 6, w * hp, 3);
    ctx.fillStyle = '#3d74e6'; ctx.fillRect(x - w / 2, y - height - 2, w * mp, 2);
  }
  if (o.kind !== 'doll' && o.hpRatio >= 0 && !isMe) {
    ctx.fillStyle = '#000'; ctx.fillRect(x - 16, y - height - 6, 32, 4);
    ctx.fillStyle = '#e0574a'; ctx.fillRect(x - 16, y - height - 6, (32 * o.hpRatio) / 100, 4);
  }
  if (o.bubble && now - o.bubbleAt < 4000) bubble(o.bubble, x, y - height - 26 - (tp?.text ? 14 : 0) - (pkRank ? 14 : 0));
}

function buildRetainedWorldScene(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0b0a08';
  if (!st.inGame) return; // 遊戲外畫布是隱藏的(style.css body:not(.in-game) canvas#world),不用畫
  worldLayer('background');
  ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);
  worldLayer('floor');
  // 世界整個放大 ZOOM 倍;以下座標都是放大前的
  const W = canvas.width / (DPR * ZOOM);
  const H = canvas.height / (DPR * ZOOM);
  ctx.setTransform(DPR * ZOOM, 0, 0, DPR * ZOOM, 0, 0);
  if (!st.map) return;

  // 地面:有天堂客戶端地圖就畫原版地磚;否則用素材地磚,素材還沒載入時退回純色
  const view = { cam: st.cam, W, H, TW, TH, cy: camCY(H) };
  const realMap = L1MAP.ready(st.mapId);
  const pendingMap = !realMap && L1MAP.pending(st.mapId); // 區塊表還在載(或暫時失敗在重試):先墊模糊縮圖,不要整片黑
  const box = st.map.box;
  const props = retainedFloor(now, view, realMap, pendingMap, box);
  const maps = realMap ? L1MAP.describeObjects(st.mapId, view, toScreen, now) : { all: WORLD_NO_MAP, visible: WORLD_NO_MAP };
  const cameraX = Math.round(W / 2 - (st.cam.x + st.cam.y) * (TW / 2));
  const cameraY = Math.round(view.cy - (st.cam.y - st.cam.x) * (TH / 2));
  WORLD.recording.retained = { cameraX, cameraY, scale: DPR * ZOOM, mapId: st.mapId, mapObjects: null, sortMs: 0 };
  worldLayer('objects');
  // 物件依深度排序
  const list = [...st.objects.values()];
  if (st.hideOthersPets === true) { let w = 0; for (const o of list) if (!isHiddenPet(o)) list[w++] = o; list.length = w; } // 隱藏他人寵物:連畫面物件清單都不放
  const oldOrder = worldOrderCache, order = worldRetainedOrder(list, maps, props, box);
  WORLD.recording.retained.mapObjects = order.mapObjects;
  WORLD.recording.retained.sortMs = (maps.sortMs || 0) + (order === oldOrder ? 0 : order.sortMs);
  for (let i = 0; i < order.items.length; i++) { WORLD.rankCursor = i; drawRetainedItem(order.items[i]); }
  const lay = LAY, layK = LAYK;
  let nLay = 0, ci = 0;
  for (const mo of maps.visible) {
    const rank = order.rank.get(mo);
    if (rank === undefined) continue;
    while (ci < order.creatures.length && order.rank.get(order.creatures[ci].e) < rank) {
      const entry = order.creatures[ci++]; lay[nLay] = entry.e; layK[nLay++] = entry.k;
    }
    lay[nLay] = mo; layK[nLay++] = 0;
  }
  while (ci < order.creatures.length) {
    const entry = order.creatures[ci++]; lay[nLay] = entry.e; layK[nLay++] = entry.k;
  }
  if (RM.active) {
    RM.data.visible = list.filter(o => { const p = toScreen(o.px, o.py); return p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H; }).length;
  }
  // 擋到自己的地圖物件變淡:只淡「圖的不透明像素真的蓋到人物身上」的那幾塊,其他的不動;透明度漸變(FADE_MS)不會閃
  //   畫在人物後面(在人物前方)的物件:蓋到身上任一點就淡
  //   進屋:屋頂在繪製順序上排在人物前面(人物畫在屋頂上),4 格內的物件把腳和頭都蓋到才算在屋裡,
  //   這時蓋到身上(左右多留一點)的屋頂也淡;站在牆前、樹前只蓋到頭,不算
  // 要變淡的物件記在物件上(mo.fon = 這一格的編號),不用每格畫面建 Set
  const meObj = self();
  const meP = meObj ? toScreen(meObj.px, meObj.py) : null;
  const fon = ++fadeFrame;
  if (meP) {
    const h = Math.max(30, Math.min(120, st.meH || 48));
    const body = [[0, -4], [0, -h * 0.3], [0, -h * 0.6], [0, -h * 0.9], [-12, -h * 0.5], [12, -h * 0.5]].map(([dx, dy]) => [meP.x + dx, meP.y + dy]);
    const wide = body.concat([[-24, -h * 0.3], [24, -h * 0.3], [-24, -h * 0.8], [24, -h * 0.8]].map(([dx, dy]) => [meP.x + dx, meP.y + dy]));
    const mx = meObj.x, my = meObj.y;
    const hits = (mo, pts) => { for (const pt of pts) if (L1MAP.opaqueAt(mo, pt[0], pt[1])) return true; return false; };
    const behind = LAY_BEHIND; // 繪製順序在人物前面、4 格內
    behind.length = 0;
    let passed = false;
    for (let i = 0; i < nLay; i++) {
      const k = layK[i];
      if (k === 1) { if (lay[i] === meObj) passed = true; continue; }
      if (k !== 0) continue;
      const mo = lay[i];
      if (!canFadeMapObject(mo)) continue;
      const d = Math.max(Math.abs(mo.x - mx), Math.abs(mo.y - my));
      if (d > 8) continue;
      if (passed) { if (hits(mo, body)) mo.fon = fon; } else if (d <= 4) behind.push(mo);
    }
    const anyAt = (pt) => { for (const mo of behind) if (L1MAP.opaqueAt(mo, pt[0], pt[1])) return true; return false; };
    const inside = anyAt(body[0]) && anyAt(body[3]);
    if (inside) {
      // 屋頂 = 同一個地圖物件(轉檔的 "g")把腳下和頭都蓋到:整個物件一起變淡,牆和其他東西不動
      const covering = (pt) => { const s = new Set(); for (const mo of behind) if (mo.g && L1MAP.opaqueAt(mo, pt[0], pt[1])) s.add(mo.g); return s; };
      const atHead = covering(body[3]);
      const roofs = new Set([...covering(body[0])].filter((g) => atHead.has(g)));
      if (roofs.size) { for (let i = 0; i < nLay; i++) if (layK[i] === 0 && canFadeMapObject(lay[i]) && roofs.has(lay[i].g)) lay[i].fon = fon; }
      else for (const mo of behind) if (hits(mo, wide)) mo.fon = fon; // 舊格式地圖(沒有 "g"):只淡人物附近
    }
  }
  const fadeStep = Math.min(1, (now - (st.fadeAt || now)) / FADE_MS) * (1 - FADE_ALPHA);
  st.fadeAt = now;
  // st.fades:物件(位置 + 圖塊)-> 目前透明度,< 1 的才記;key 第一次用到才組字串、記在物件上
  // 沒有變淡中的物件時(村莊、平常)完全不用查表
  const fades = st.fades;
  const kept = LAY_KEPT; // 這一格記進去的 key(其他的是移出畫面的,最後清掉)
  kept.length = 0;
  for (let i = 0; i < nLay; i++) {
    const k = layK[i], e = lay[i];
    WORLD.rankCursor = order.rank.get(e);
    if (k === 0) {
      let key = null, cur = 1;
      if (fades.size) { key = e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; cur = fades.get(key) ?? 1; }
      const a = !canFadeMapObject(e) ? 1 : e.fon === fon ? Math.max(FADE_ALPHA, cur - fadeStep) : Math.min(1, cur + fadeStep);
      if (a < 1) { key ??= e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; fades.set(key, a); kept.push(key); } else if (key !== null) fades.delete(key);
      let command = WORLD_MAP_COMMANDS.get(e);
      if (!command) WORLD_MAP_COMMANDS.set(e, command = { mapObject: e, alpha: 1, order: 0 });
      command.alpha = a; command.order = WORLD.rankCursor;
      WORLD.recording.push(command);
      continue;
    }
    if (k === 1) drawRetainedCreature(e, now);
    else {
      const images = []; FLARE.drawTile(worldImageSink(images), e.group, e.seed, e.p.x, e.p.y);
      worldImages(images, 'creature', e);
    }
  }
  if (fades.size) { const keep = new Set(kept); for (const k of fades.keys()) if (!keep.has(k)) fades.delete(k); } // 移出畫面的
  for (let i = nLay; i < LAY_N; i++) lay[i] = null; // 上一格比較多(森林走到村莊):尾端的舊物件放掉,不要一直抓著舊圖
  LAY_N = nLay;

  WORLD.rankCursor = order.ordered.length;
  worldLayer('overlay');
  // 白天 / 黑夜(室外地圖):夜裡整片變暗,角色身邊留一圈光
  const night = st.cave ? 1 : OUTDOOR_MAPS.has(st.mapId) ? darkness(now) : 0;
  const me = self();
  if (night > 0 && me) drawDarkness(night, me, W, H);

  // 魔法 / 藥水 / 箭的特效:蓋在人物和夜色上面
  drawEffects(now);

  // 傷害數字
  drawFloaters(now);
  ctx.globalAlpha = 1;
}

// ---------------- 繪圖 ----------------
// Low terrain objects never participate in fading; old segments remain eligible.
function canFadeMapObject(mo) {
  return mo.hm === undefined || mo.hm > 2;
}

// ---- B-02b 地圖物件「同排合併圖」(heatlag-1121;旗標 window.HEATLAG_MAP_LAYER_ENABLED === true 才走,每格畫面讀一次)----
// 地圖物件的深度是整數(y - x),角色只會插在兩排之間,同一排的物件在繪製順序上一定連在一起。
// 所以把「同一排、順序相連」的幾個物件照原順序 1:1 預先畫到合併圖(世界解析度,和物件圖集一樣),每格畫面一排只貼幾張,
// 位置用其中一個物件這一格的 left / top 反推(所有物件每格都是平移同一個整數,走路時也成立)。
// 這一格有成員在淡出(擋住自己 / 屋頂)的那一塊照原本逐個畫;還沒建好的也照原本畫(每格最多建約 2 ms)。
// 已知差異:物件圖有半透明像素時,先合成再貼會有 ±1 的捨入差;圖塊邊緣落在小數裝置像素時,邊緣那 1 像素的混色可能不同。
const B02 = { key: null, hw: 0, hh: 0, mapId: -1, chunks: 0, pages: [], pi: 0, sx: 0, sy: 0, sh: 0, gen: 0, fullAt: -1e9, resetAt: -1e9, need: [],
  alpha: [], frame: { used: false, reason: '', blits: 0, merged: 0, single: 0, built: 0 }, totals: { frames: 0, used: 0, skip: {}, builds: 0, resets: 0 }, off: 0 };
const B02_PAGE = 1024, B02_MAXPAGES = matchMedia('(pointer: coarse)').matches ? 5 : 12; // 每頁 4 MB:手機最多 20 MB、電腦 48 MB
const b02On = () => window.HEATLAG_MAP_LAYER_ENABLED === true;
function b02Free() {
  for (const p of B02.pages) { L1MAP.trackCanvas(p.c, false); p.c.width = p.c.height = 0; }
  B02.pages.length = 0; B02.key = null; B02.pi = B02.sx = B02.sy = B02.sh = 0; B02.gen++;
}
function b02ResetPages() { // 清空全部合併圖(畫布留著),之後看得到的再慢慢建回來
  for (const p of B02.pages) { p.g.setTransform(1, 0, 0, 1, 0, 0); p.g.clearRect(0, 0, B02_PAGE, B02_PAGE); }
  B02.pi = B02.sx = B02.sy = B02.sh = 0; B02.gen++;
}
// 物件表換了(區塊 / 圖集)→ 重新分塊:同一排連續的物件,外框不會比成員面積大太多、不超過 512 的就併成一塊
function b02Chunks(sorted, hw, hh) {
  b02ResetPages();
  B02.key = sorted; B02.hw = hw; B02.hh = hh; B02.mapId = st.mapId; B02.chunks = 0;
  const ant = st.mapId === 4;
  let ch = null, depth = NaN, area = 0;
  const close = () => {
    if (ch && ch.m.length < 2) ch.m[0].b2 = null;
    else if (ch) { B02.chunks++; for (const e of ch.m) { e.b2x -= ch.bx; e.b2y -= ch.by; } ch.w = ch.x1 - ch.bx; ch.h = ch.y1 - ch.by; }
    ch = null;
  };
  for (const e of sorted) {
    const c = e.c, wx = e.sum * hw + e.ox, wy = e.dif * hh + e.oy, w = c[2], h = c[3];
    if (!Number.isInteger(wx) || !Number.isInteger(wy) || !(w > 0 && h > 0) || (ant && ANT_HOLE_NEAR.has(e.x * 65536 + e.y))) { close(); e.b2 = null; continue; }
    if (ch && e.depth === depth) {
      const bx = Math.min(ch.bx, wx), by = Math.min(ch.by, wy), x1 = Math.max(ch.x1, wx + w), y1 = Math.max(ch.y1, wy + h);
      if (x1 - bx <= 512 && y1 - by <= 512 && (x1 - bx) * (y1 - by) <= 2.5 * (area + w * h) + 2048) {
        ch.bx = bx; ch.by = by; ch.x1 = x1; ch.y1 = y1; area += w * h; ch.m.push(e); e.b2 = ch; e.b2x = wx; e.b2y = wy; continue;
      }
    }
    close();
    ch = { m: [e], bx: wx, by: wy, x1: wx + w, y1: wy + h, w: 0, h: 0, page: -1, px: 0, py: 0, gen: -1, fadeF: 0, drawF: 0, needF: 0, dead: false };
    depth = e.depth; area = w * h; e.b2 = ch; e.b2x = wx; e.b2y = wy;
  }
  close();
}
function b02Place(ch, now) { // 在頁面上找位置(一排一排往下放,留 1 像素間隔);放不下回傳 false
  const w = ch.w + 1, h = ch.h + 1;
  if (B02.sx + w > B02_PAGE) { B02.sy += B02.sh; B02.sx = 0; B02.sh = 0; }
  if (B02.sy + h > B02_PAGE) { B02.pi++; B02.sx = B02.sy = B02.sh = 0; }
  if (B02.pi >= B02.pages.length) {
    if (B02.pages.length >= B02_MAXPAGES) {
      if (now - B02.resetAt > 10000) { B02.resetAt = now; B02.totals.resets++; b02ResetPages(); } // 滿了:10 秒內最多清一次,其餘先照原本畫
      else { B02.fullAt = now; return false; }
    } else {
      const c = document.createElement('canvas'); c.width = c.height = B02_PAGE;
      const g = c.getContext('2d'); if (!g) { B02.fullAt = now; return false; }
      const lost = () => { b02ResetPages(); };
      c.addEventListener?.('contextlost', lost); c.addEventListener?.('contextrestored', lost);
      g.imageSmoothingEnabled = false;
      L1MAP.trackCanvas(c, true); B02.pages.push({ c, g });
    }
  }
  ch.page = B02.pi; ch.px = B02.sx; ch.py = B02.sy; B02.sx += w; if (h > B02.sh) B02.sh = h;
  return true;
}
function b02Build(ch, now) {
  if (!b02Place(ch, now)) return false;
  const g = B02.pages[ch.page].g;
  try { for (const e of ch.m) { const c = e.c; g.drawImage(e.img, c[0], c[1], c[2], c[3], ch.px + e.b2x, ch.py + e.b2y, c[2], c[3]); } }
  catch { ch.dead = true; return true; }
  ch.gen = B02.gen; B02.totals.builds++;
  return true;
}
function b02Skip(reason) { B02.frame.used = false; B02.frame.reason = reason; B02.totals.skip[reason] = (B02.totals.skip[reason] || 0) + 1; return false; }
// 取代 buildWorldScene 的物件 / 角色迴圈;回傳 false 時沒動過任何狀態(呼叫端照原本的迴圈畫)
function b02DrawLay(nLay, now, view, fon, fadeStep, fades, kept) {
  B02.totals.frames++;
  if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== 'source-over') return b02Skip('state');
  const sorted = L1MAP.objectsKey(), hw = view.TW / 2, hh = view.TH / 2;
  if (!sorted || !sorted.length) return b02Skip('empty');
  if (B02.key !== sorted || B02.hw !== hw || B02.hh !== hh || B02.mapId !== st.mapId) b02Chunks(sorted, hw, hh);
  const lay = LAY, layK = LAYK, alpha = B02.alpha, need = B02.need, gen = B02.gen;
  // 淡出透明度:和原本迴圈同一段算式、同一順序;順便記下這格哪些塊有成員在淡、哪些還沒建
  need.length = 0;
  for (let i = 0; i < nLay; i++) {
    if (layK[i] !== 0) continue;
    const e = lay[i];
    let key = null, cur = 1;
    if (fades.size) { key = e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; cur = fades.get(key) ?? 1; }
    const a = !canFadeMapObject(e) ? 1 : e.fon === fon ? Math.max(FADE_ALPHA, cur - fadeStep) : Math.min(1, cur + fadeStep);
    if (a < 1) { key ??= e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; fades.set(key, a); kept.push(key); } else if (key !== null) fades.delete(key);
    alpha[i] = a;
    const ch = e.b2;
    if (ch) { if (a < 1) ch.fadeF = fon; else if (ch.gen !== gen && !ch.dead && ch.needF !== fon) { ch.needF = fon; need.push(ch); } }
  }
  let built = 0;
  if (need.length && now - B02.fullAt > 5000) {
    const t0 = performance.now();
    for (let j = 0; j < need.length; j++) {
      const ch = need[j];
      if (ch.fadeF === fon) continue;
      if (!b02Build(ch, now)) break;
      built++;
      if ((built & 3) === 0 && performance.now() - t0 > 2) break;
    }
  }
  const pages = B02.pages, gen2 = B02.gen; // 建的途中可能整個清空過(gen 變了)
  let smooth = null, blits = 0, merged = 0, single = 0;
  for (let i = 0; i < nLay; i++) {
    const k = layK[i], e = lay[i];
    if (k === 0) {
      if (smooth === null) { smooth = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false; }
      const ch = e.b2;
      if (ch && ch.gen === gen2 && ch.fadeF !== fon) {
        merged++;
        if (ch.drawF !== fon) { ch.drawF = fon; blits++; ctx.drawImage(pages[ch.page].c, ch.px, ch.py, ch.w, ch.h, e.left - e.b2x, e.top - e.b2y, ch.w, ch.h); }
        continue;
      }
      const c = e.c, a = alpha[i];
      if (a < 1) { ctx.globalAlpha = a; ctx.drawImage(e.img, c[0], c[1], c[2], c[3], e.left, e.top, c[2], c[3]); ctx.globalAlpha = 1; } else ctx.drawImage(e.img, c[0], c[1], c[2], c[3], e.left, e.top, c[2], c[3]);
      single++;
      continue;
    }
    if (smooth !== null) { ctx.imageSmoothingEnabled = smooth; smooth = null; }
    if (k === 1) drawCreature(e, now);
    else FLARE.drawTile(ctx, e.group, e.seed, e.p.x, e.p.y);
  }
  if (smooth !== null) ctx.imageSmoothingEnabled = smooth;
  alpha.length = 0; need.length = 0;
  const F = B02.frame; F.used = true; F.reason = ''; F.blits = blits; F.merged = merged; F.single = single; F.built = built;
  B02.totals.used++;
  return true;
}
function b02DiagText() {
  const f = B02.frame, t = B02.totals;
  return `地圖物件合併圖 開;本格 ${f.used ? `貼 ${f.blits} 張(併 ${f.merged} 個)、逐個畫 ${f.single}、新建 ${f.built}` : '沒用(' + f.reason + ')'};累計 ${t.used}/${t.frames} 格 退回 ${JSON.stringify(t.skip)};${B02.pages.length} 頁 ${B02.pages.length * 4} MB、建 ${t.builds} 塊、清空 ${t.resets} 次`;
}

function buildWorldScene(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0b0a08';
  if (!st.inGame) return; // 遊戲外畫布是隱藏的(style.css body:not(.in-game) canvas#world),不用畫
  worldLayer('background');
  ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);
  worldLayer('floor');
  // 世界整個放大 ZOOM 倍;以下座標都是放大前的
  const W = canvas.width / (DPR * ZOOM);
  const H = canvas.height / (DPR * ZOOM);
  ctx.setTransform(DPR * ZOOM, 0, 0, DPR * ZOOM, 0, 0);
  if (!st.map) return;

  // 地面:有天堂客戶端地圖就畫原版地磚;否則用素材地磚,素材還沒載入時退回純色
  const view = { cam: st.cam, W, H, TW, TH, cy: camCY(H) };
  const realMap = L1MAP.ready(st.mapId);
  const pendingMap = !realMap && L1MAP.pending(st.mapId); // 區塊表還在載(或暫時失敗在重試):先墊模糊縮圖,不要整片黑
  const box = st.map.box;
  if ((realMap || pendingMap) && box) {
    // 個人獵場:地面只畫開放的那一塊
    const c = [[box[0] - 0.5, box[1] - 0.5], [box[2] + 0.5, box[1] - 0.5], [box[2] + 0.5, box[3] + 0.5], [box[0] - 0.5, box[3] + 0.5]].map(([x, y]) => toScreen(x, y));
    ctx.save();
    ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.clip();
    drawOverview(ctx, st.mapId, st.cam.x, st.cam.y, W / 2, camCY(H), TW / 2, W, H); // 清晰的區塊還沒載好:先墊模糊的縮小版,不要整片黑
    if (realMap) L1MAP.drawFloor(ctx, st.mapId, view, toScreen, now);
    ctx.restore();
  } else if (realMap || pendingMap) {
    drawOverview(ctx, st.mapId, st.cam.x, st.cam.y, W / 2, camCY(H), TW / 2, W, H); // 同上
    if (realMap) L1MAP.drawFloor(ctx, st.mapId, view, toScreen, now);
  }
  const R = realMap || L1MAP.pending(st.mapId) ? -1 : Math.ceil(Math.max(W / TW, H / TH)) + 2;
  const cx = Math.round(st.cam.x);
  const cy = Math.round(st.cam.y);
  const outdoor = OUTDOOR_MAPS.has(st.mapId);
  const props = [];
  const flare = FLARE.terrainReady();
  for (let y = cy - R; y <= cy + R; y++) {
    for (let x = cx - R; x <= cx + R; x++) {
      const p = toScreen(x, y);
      if (p.x < -TW || p.x > W + TW || p.y < -TH * 3 || p.y > H + TH * 3) continue;
      const t = tile(x, y);
      if (!(t & 3)) {
        if (outdoor && isSea(x, y)) {
          // 海:水面
          if (!(flare && FLARE.drawTile(ctx, 'water', FLARE.hash(x * 7919 + y), p.x, p.y))) {
            ctx.drawImage(waterTile((x * 7 + y * 13 + Math.floor(performance.now() / 600)) % 3), p.x - TW / 2, p.y - TH / 2);
          }
          continue;
        }
        if (flare && outdoor) {
          // 內陸不可走:草地上長樹 / 草叢 / 岩石(靠路邊必放,內部隨機)
          // 安全區(村莊)裡的障礙多半是房子 / 圍牆:碎石地上放箱子、帳篷、柵欄;野外則是樹林
          const town = (t & 0x30) === 0x10;
          FLARE.drawTile(ctx, town ? 'stone' : 'grass', FLARE.hash(x * 73856093 ^ y * 19349663), p.x, p.y);
          const edge = (tile(x + 1, y) & 3) || (tile(x - 1, y) & 3) || (tile(x, y + 1) & 3) || (tile(x, y - 1) & 3);
          const h = FLARE.hash(x * 2654435761 ^ y * 40503);
          const groups = town ? ['fence', 'town', 'fence', 'town'] : ['tree', 'tree', 'pine', 'bush', 'tree', 'rock'];
          if (edge || h % 3 === 0) props.push({ x, y, p, group: groups[h % groups.length], seed: h });
          continue;
        }
        // 內陸不可走的格子:室外鋪深色林地,靠路邊的放樹;室內留黑、靠路邊放石牆
        if (outdoor) ctx.drawImage(forestTile(), p.x - TW / 2, p.y - TH / 2);
        if ((tile(x + 1, y) & 3) || (tile(x - 1, y) & 3) || (tile(x, y + 1) & 3) || (tile(x, y - 1) & 3)) props.push({ x, y, p });
        else if (outdoor && SPR.hash(x * 31 ^ y * 17) % 3 === 0) props.push({ x, y, p });
        continue;
      }
      let key;
      if ((t & 0x30) === 0x10) key = outdoor && SPR.hash(x * 73856093 ^ y * 19349663) % 23 === 0 ? 'grass3' : 'safe';
      else if ((t & 0x30) === 0x20) key = 'combat';
      else if (!outdoor) key = 'dungeon';
      else { const r = SPR.hash(x * 73856093 ^ y * 19349663) % 23; key = r === 0 ? 'grass3' : r < 5 ? 'grass2' : 'grass'; }
      // 安全區(村莊)鋪碎石地,其他草地
      if (flare && outdoor && FLARE.drawTile(ctx, key === 'safe' ? 'stone' : 'grass', FLARE.hash(x * 73856093 ^ y * 19349663), p.x, p.y)) continue;
      const img = SPR.isoTile(key, TW, TH);
      if (img) ctx.drawImage(img, p.x - TW / 2, p.y - TH / 2);
      else {
        ctx.fillStyle = { safe: '#4d5236', combat: '#4a2f28' }[key] || '#3b4a2b';
        ctx.beginPath(); ctx.moveTo(p.x, p.y - TH / 2); ctx.lineTo(p.x + TW / 2, p.y); ctx.lineTo(p.x, p.y + TH / 2); ctx.lineTo(p.x - TW / 2, p.y); ctx.fill();
      }
    }
  }
  drawWalkHintFloor(view); // 地面完成後、所有物件 / 角色 / 名字之前
  for (const { x, y, p } of props) {
    if (flare && outdoor) continue; // Flare 的樹在下面和角色一起依深度畫
    if (outdoor) {
      const h = SPR.hash(x * 2654435761 ^ y);
      SPR.draw(ctx, ['town', [SPR.TT.tree, SPR.TT.tree2, SPR.TT.bush][h % 3]], p.x, p.y + 4, 3, h & 8);
    } else {
      const img = SPR.isoTile('wall', TW, TH);
      if (img) for (let k = 0; k < 3; k++) ctx.drawImage(img, p.x - TW / 2, p.y - TH / 2 - k * 10);
    }
  }

  // 沙漠螞蟻洞入口(dungeon 表 砂漠 -> 蟻ケイブ 6 個傳點):客戶端地圖圖檔在入口是平沙地,看不出洞口 → 自己畫沙坑(使用者 10/18)
  if (st.mapId === 4) {
    for (const [hx, hy] of ANT_HOLES) {
      const p = toScreen(hx, hy);
      if (p.x < -TW * 2 || p.x > W + TW * 2 || p.y < -TH * 2 || p.y > H + TH * 2) continue;
      drawSandHole(p.x, p.y);
    }
  }

  // 點擊的格子:菱形外框(一整格),點下去時從格子大小往內收
  const cellOutline = (p, k, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - (TH / 2) * k); ctx.lineTo(p.x + (TW / 2) * k, p.y);
    ctx.lineTo(p.x, p.y + (TH / 2) * k); ctx.lineTo(p.x - (TW / 2) * k, p.y);
    ctx.closePath(); ctx.stroke();
  };
  if (st.tap && now - st.tap.at < 300) {
    const k = (now - st.tap.at) / 300;
    cellOutline(toScreen(st.tap.x, st.tap.y), 1.4 - 0.4 * k, `rgba(120,230,150,${1 - k})`, 2);
  }
  // 目的地格子
  if (st.path.length) {
    const d = st.path[st.path.length - 1];
    cellOutline(toScreen(d.x, d.y), 1, 'rgba(120,230,150,.9)', 1.5);
  }

  worldLayer('objects');
  // 物件依深度排序
  const list = [...st.objects.values()];
  if (st.hideOthersPets === true) { let w = 0; for (const o of list) if (!isHiddenPet(o)) list[w++] = o; list.length = w; } // 隱藏他人寵物:連畫面物件清單都不放
  list.sort((a, b) => (a.py - a.px) - (b.py - b.px) || (a.kind === 'item' ? -1 : 1));
  for (const o of list) if (o.kind === 'item') drawItem(o);
  // 樹木 / 草叢和角色合併排序,前面的樹會擋住後面的人
  // 森林一畫面上千個物件:不再每格畫面包上千個小物件、整批重排,排好的放進重複使用的 LAY(LAYK:0 地圖物件、1 角色、2 Flare 的樹)
  const lay = LAY, layK = LAYK;
  let nLay = 0;
  const cr = LAY_CR;
  cr.length = 0;
  let crOk = true;
  for (const o of list) if (o.kind !== 'item') { cr.push(o); if (!Number.isFinite(o.py - o.px)) crOk = false; }
  if (realMap && !props.length && crOk) {
    // 原版地圖:L1MAP.objects 已依深度排好(畫面上的區塊沒變就不重排),角色只有幾個,排好後合併進去。
    // 和以前「全部放在一起穩定排序」的結果一樣:同深度時角色在前(先放進去的),地圖物件照原本先後
    cr.sort((a, b) => (a.py - a.px) - (b.py - b.px));
    const blk = box ? instBlocked() : null;
    let ci = 0;
    for (const mo of L1MAP.objects(st.mapId, view, toScreen, now)) {
      if (st.mapId === 4 && ANT_HOLE_NEAR.has(mo.x * 65536 + mo.y)) continue; // 螞蟻洞口(drawSandHole)上的沙丘不畫
      if (box && (mo.x < box[0] || mo.y < box[1] || mo.x > box[2] || mo.y > box[3])) continue; // 個人獵場外面的不畫
      if (box && !blk.has(mo.x * 65536 + mo.y)) continue; // 個人獵場裡面:只畫伺服器擋住的那幾格(樹),其他整塊是空地(地圖圖檔補齊物件後才不會長出一堆能穿過去的樹)
      const d = mo.depth - 0.01; // 原版地圖的樹、牆、建築:同一格時先畫物件再畫人
      while (ci < cr.length && cr[ci].py - cr[ci].px <= d) { lay[nLay] = cr[ci++]; layK[nLay++] = 1; }
      lay[nLay] = mo; layK[nLay++] = 0;
    }
    while (ci < cr.length) { lay[nLay] = cr[ci++]; layK[nLay++] = 1; }
  } else {
    const layered = cr.map((o) => ({ depth: o.py - o.px, o }));
    if (flare && outdoor) for (const pr of props) layered.push({ depth: pr.y - pr.x, pr });
    // 原版地圖的樹、牆、建築:同一格時先畫物件再畫人
    if (realMap) {
      for (const mo of L1MAP.objects(st.mapId, view, toScreen, now)) {
        if (st.mapId === 4 && ANT_HOLE_NEAR.has(mo.x * 65536 + mo.y)) continue; // 螞蟻洞口(drawSandHole)上的沙丘不畫
        if (box && (mo.x < box[0] || mo.y < box[1] || mo.x > box[2] || mo.y > box[3])) continue; // 個人獵場外面的不畫
        if (box && !instBlocked().has(mo.x * 65536 + mo.y)) continue; // 個人獵場裡面:只畫伺服器擋住的那幾格(樹)
        layered.push({ depth: mo.depth - 0.01, mo });
      }
    }
    layered.sort((a, b) => a.depth - b.depth);
    for (const e of layered) { lay[nLay] = e.o || e.mo || e.pr; layK[nLay++] = e.o ? 1 : e.mo ? 0 : 2; }
  }
  if (RM.active) {
    RM.data.visible = list.filter(o => { const p = toScreen(o.px, o.py); return p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H; }).length;
  }
  // 擋到自己的地圖物件變淡:只淡「圖的不透明像素真的蓋到人物身上」的那幾塊,其他的不動;透明度漸變(FADE_MS)不會閃
  //   畫在人物後面(在人物前方)的物件:蓋到身上任一點就淡
  //   進屋:屋頂在繪製順序上排在人物前面(人物畫在屋頂上),4 格內的物件把腳和頭都蓋到才算在屋裡,
  //   這時蓋到身上(左右多留一點)的屋頂也淡;站在牆前、樹前只蓋到頭,不算
  // 要變淡的物件記在物件上(mo.fon = 這一格的編號),不用每格畫面建 Set
  const meObj = self();
  const meP = meObj ? toScreen(meObj.px, meObj.py) : null;
  const fon = ++fadeFrame;
  if (meP) {
    const h = Math.max(30, Math.min(120, st.meH || 48));
    const body = [[0, -4], [0, -h * 0.3], [0, -h * 0.6], [0, -h * 0.9], [-12, -h * 0.5], [12, -h * 0.5]].map(([dx, dy]) => [meP.x + dx, meP.y + dy]);
    const wide = body.concat([[-24, -h * 0.3], [24, -h * 0.3], [-24, -h * 0.8], [24, -h * 0.8]].map(([dx, dy]) => [meP.x + dx, meP.y + dy]));
    const mx = meObj.x, my = meObj.y;
    const hits = (mo, pts) => { for (const pt of pts) if (L1MAP.opaqueAt(mo, pt[0], pt[1])) return true; return false; };
    const behind = LAY_BEHIND; // 繪製順序在人物前面、4 格內
    behind.length = 0;
    let passed = false;
    for (let i = 0; i < nLay; i++) {
      const k = layK[i];
      if (k === 1) { if (lay[i] === meObj) passed = true; continue; }
      if (k !== 0) continue;
      const mo = lay[i];
      if (!canFadeMapObject(mo)) continue;
      const d = Math.max(Math.abs(mo.x - mx), Math.abs(mo.y - my));
      if (d > 8) continue;
      if (passed) { if (hits(mo, body)) mo.fon = fon; } else if (d <= 4) behind.push(mo);
    }
    const anyAt = (pt) => { for (const mo of behind) if (L1MAP.opaqueAt(mo, pt[0], pt[1])) return true; return false; };
    const inside = anyAt(body[0]) && anyAt(body[3]);
    if (inside) {
      // 屋頂 = 同一個地圖物件(轉檔的 "g")把腳下和頭都蓋到:整個物件一起變淡,牆和其他東西不動
      const covering = (pt) => { const s = new Set(); for (const mo of behind) if (mo.g && L1MAP.opaqueAt(mo, pt[0], pt[1])) s.add(mo.g); return s; };
      const atHead = covering(body[3]);
      const roofs = new Set([...covering(body[0])].filter((g) => atHead.has(g)));
      if (roofs.size) { for (let i = 0; i < nLay; i++) if (layK[i] === 0 && canFadeMapObject(lay[i]) && roofs.has(lay[i].g)) lay[i].fon = fon; }
      else for (const mo of behind) if (hits(mo, wide)) mo.fon = fon; // 舊格式地圖(沒有 "g"):只淡人物附近
    }
  }
  const fadeStep = Math.min(1, (now - (st.fadeAt || now)) / FADE_MS) * (1 - FADE_ALPHA);
  st.fadeAt = now;
  // st.fades:物件(位置 + 圖塊)-> 目前透明度,< 1 的才記;key 第一次用到才組字串、記在物件上
  // 沒有變淡中的物件時(村莊、平常)完全不用查表
  const fades = st.fades;
  const kept = LAY_KEPT; // 這一格記進去的 key(其他的是移出畫面的,最後清掉)
  kept.length = 0;
  let smooth = null; // 畫地圖物件時暫時關掉平滑(最近像素,同 L1MAP.drawObject);畫人物前還原
  if (B02.pages.length) { if (b02On()) B02.off = 0; else if (++B02.off > 60) b02Free(); } // 旗標關掉 60 格後還掉合併圖畫布
  // B-02b:旗標開時由 b02DrawLay 畫(同一排的地圖物件貼合併圖);其餘情況照原本的迴圈
  if (!(b02On() && realMap && !box && !props.length && crOk && ctx === canvasCtx && b02DrawLay(nLay, now, view, fon, fadeStep, fades, kept))) {
    for (let i = 0; i < nLay; i++) {
      const k = layK[i], e = lay[i];
      if (k === 0) {
        let key = null, cur = 1;
        if (fades.size) { key = e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; cur = fades.get(key) ?? 1; }
        const a = !canFadeMapObject(e) ? 1 : e.fon === fon ? Math.max(FADE_ALPHA, cur - fadeStep) : Math.min(1, cur + fadeStep);
        if (a < 1) { key ??= e.fk ??= `${e.x},${e.y},${e.c[0]},${e.c[1]}`; fades.set(key, a); kept.push(key); } else if (key !== null) fades.delete(key);
        if (smooth === null) { smooth = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false; }
        const c = e.c;
        if (a < 1) { ctx.globalAlpha = a; ctx.drawImage(e.img, c[0], c[1], c[2], c[3], e.left, e.top, c[2], c[3]); ctx.globalAlpha = 1; } else ctx.drawImage(e.img, c[0], c[1], c[2], c[3], e.left, e.top, c[2], c[3]);
        continue;
      }
      if (smooth !== null) { ctx.imageSmoothingEnabled = smooth; smooth = null; }
      if (k === 1) drawCreature(e, now);
      else FLARE.drawTile(ctx, e.group, e.seed, e.p.x, e.p.y);
    }
    if (smooth !== null) ctx.imageSmoothingEnabled = smooth;
  }
  if (fades.size) { const keep = new Set(kept); for (const k of fades.keys()) if (!keep.has(k)) fades.delete(k); } // 移出畫面的
  for (let i = nLay; i < LAY_N; i++) lay[i] = null; // 上一格比較多(森林走到村莊):尾端的舊物件放掉,不要一直抓著舊圖
  LAY_N = nLay;

  worldLayer('overlay');
  // 白天 / 黑夜(室外地圖):夜裡整片變暗,角色身邊留一圈光
  const night = st.cave ? 1 : OUTDOOR_MAPS.has(st.mapId) ? darkness(now) : 0;
  const me = self();
  if (night > 0 && me) drawDarkness(night, me, W, H);

  // 魔法 / 藥水 / 箭的特效:蓋在人物和夜色上面
  drawEffects(now);

  // 傷害數字
  drawFloaters(now);
  ctx.globalAlpha = 1;
}

// ---- 傷害數字:先放大彈出再縮回、往上飄、最後淡出;深色描邊 + 上亮下深的漸層 ----
// hit 打到別人(金)、hurt 自己被打(紅)、miss(灰藍斜體,往旁邊飄)
const FLOAT_MS = 1000;
const FLOAT_STYLE = {
  hit: { top: '#fffbe0', bottom: '#ffb428', edge: '#3a1d00', glow: 'rgba(255,170,40,0.55)' },
  hurt: { top: '#ffe2dc', bottom: '#ff3a2c', edge: '#3a0000', glow: 'rgba(255,40,30,0.55)' },
  miss: { top: '#eef4ff', bottom: '#9fb3cf', edge: '#1a2230', glow: null },
  crit: { top: '#fff0ee', bottom: '#ff2a1a', edge: '#2a0000', glow: 'rgba(255,40,20,0.85)' }, // 暴擊:紅色、字放大
  missme: { top: '#ffd6d0', bottom: '#ff4a3a', edge: '#2a0000', glow: null }, // 別人打我沒打中:小一點的紅色 MISS
};
function drawFloaters(now) {
  st.floaters = st.floaters.filter((f) => now - f.born < FLOAT_MS);
  if (st.floaters.length > 24) st.floaters.splice(0, st.floaters.length - 24); // 最多留最新的 24 個
  if (!st.floaters.length) return;
  const vw = canvas.width / (DPR * ZOOM), vh = canvas.height / (DPR * ZOOM);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  for (const f of st.floaters) {
    const t = (now - f.born) / FLOAT_MS;
    const sty = FLOAT_STYLE[f.kind] || FLOAT_STYLE.hit;
    const miss = f.kind === 'miss' || f.kind === 'missme';
    // 彈出:前 15% 從 1.7 倍縮回 1 倍(帶一點回彈),之後維持
    // 彈出縮放取到 0.1(字形不用每一格畫面都用新的大小重新點陣化)
    const pop = Math.round((t < 0.15 ? 1.7 - 0.8 * (t / 0.15) : t < 0.25 ? 0.9 + 0.1 * ((t - 0.15) / 0.1) : 1) * 10) / 10;
    const rise = 1 - Math.pow(1 - t, 3); // 先快後慢
    const p = toScreen(f.x, f.y);
    const x = p.x + (f.dx || 0) + (miss ? rise * 14 : 0);
    const y = p.y - 52 - rise * 34;
    if (x < -60 || x > vw + 60 || y < -60 || y > vh + 60) continue; // 畫面外的不畫
    // 傷害越高字越大(上限 1.5 倍)
    // 字級:一般傷害小、暴擊大(差距明顯);傷害越高稍微大一點
    const grow = Math.min(1.35, 1 + Math.log10(Math.max(1, f.dmg)) * 0.15);
    const size = miss ? 8 : f.kind === 'crit' ? Math.round(22 * grow) : Math.round(13 * grow);
    ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    ctx.font = `${miss ? 'italic ' : ''}900 ${size}px "Georgia", "Times New Roman", serif`;
    const g = ctx.createLinearGradient(0, -size * 0.85, 0, 0);
    g.addColorStop(0, sty.top);
    g.addColorStop(1, sty.bottom);
    if (sty.glow) { ctx.shadowColor = sty.glow; ctx.shadowBlur = 8; }
    ctx.lineWidth = 4;
    ctx.strokeStyle = sty.edge;
    ctx.strokeText(f.text, 0, 0);
    ctx.shadowBlur = 0;
    ctx.fillStyle = g;
    ctx.fillText(f.text, 0, 0);
    if (f.kind === 'crit' && !f.noLabel) { // 暴擊:數字上方加「CRITICAL!」(三重矢同一輪只畫第一個)
      ctx.font = `italic 900 ${Math.round(size * 0.5)}px "Georgia", "Times New Roman", serif`;
      ctx.lineWidth = 3;
      ctx.strokeText('CRITICAL!', 0, -size * 0.95);
      ctx.fillStyle = '#ffd04a';
      ctx.fillText('CRITICAL!', 0, -size * 0.95);
    }
    ctx.restore();
  }
  ctx.restore();
}

// 夜晚 / 洞穴:整片暗下來,再挖出光圈。自己身邊永遠有一圈小光;
// 有亮度的物件(伺服器 S_Light:日光術 14、燈 / 燈籠、NPC 的燈火)光圈照亮度放大
let darkCanvas = null;
function drawDarkness(night, me, W, H) {
  darkCanvas ??= document.createElement('canvas');
  const dc = darkCanvas;
  const dhw = Math.max(1, canvas.width >> 1), dhh = Math.max(1, canvas.height >> 1);
  if (dc.width !== dhw || dc.height !== dhh) { dc.width = dhw; dc.height = dhh; }
  const g = dc.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, dc.width, dc.height);
  g.fillStyle = `rgba(4,6,18,${0.78 * night})`;
  g.fillRect(0, 0, dc.width, dc.height);
  g.setTransform(DPR * ZOOM * 0.5, 0, 0, DPR * ZOOM * 0.5, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  const hole = (o, size, base) => {
    const p = toScreen(o.px, o.py);
    const outer = base + size * 14; // 每 1 點亮度約多 14px
    const grad = g.createRadialGradient(p.x, p.y - 20, outer * 0.25, p.x, p.y - 20, outer);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(p.x - outer, p.y - 20 - outer, outer * 2, outer * 2);
  };
  hole(me, Math.max(0, me.light || 0), 170);
  for (const o of st.objects.values()) {
    if (o === me || !(o.light > 0) || o.dead || isHiddenPet(o)) continue;
    hole(o, o.light, 40);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(dc, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

// 遊戲時間是現實的 6 倍(L1GameTime):遊戲一天 = 現實 4 小時,6:00–17:59 白天。
// 照伺服器 L1GameTime.valueOf 一模一樣算(含 int 溢位:伺服器把秒數轉成 32 位元整數,早就繞回去了)。
// 伺服器約 50 秒才送一次 S_GameTime,以前沒收到前用沒溢位的公式,差 6.5 小時,登入 / 重新整理時時鐘會跳。
const GAME_BASE_MS = 1057233600000;
const serverGameSec = (ms) => { const raw = ((ms - GAME_BASE_MS) * 6) / 1000; const i = Math.trunc(raw); return (i | 0) + (raw - i); };
function gameHour() {
  const sec = serverGameSec(Date.now()) + (st.gameTimeOff || 0);
  return ((((sec % 86400) + 86400) % 86400)) / 3600;
}
// 0 = 白天、1 = 深夜;5–7 點天亮、17–19 點天黑之間漸變
function darkness(now) {
  const h = gameHour(now);
  if (h >= 7 && h < 17) return 0;
  if (h >= 19 || h < 5) return 1;
  return h < 7 ? (7 - h) / 2 : (h - 17) / 2;
}

// 程式畫的斜角地磚:海水(3 種浪花位置)與林地
const tileCache = {};
function diamondCanvas(key, paint) {
  if (tileCache[key]) return tileCache[key];
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  g.beginPath(); g.moveTo(TW / 2, 0); g.lineTo(TW, TH / 2); g.lineTo(TW / 2, TH); g.lineTo(0, TH / 2); g.closePath();
  g.clip();
  paint(g);
  tileCache[key] = c;
  return c;
}
function waterTile(v) {
  return diamondCanvas(`water${v}`, (g) => {
    g.fillStyle = '#2f6fa3'; g.fillRect(0, 0, TW, TH);
    g.fillStyle = '#3a82bb'; g.fillRect(0, TH / 2 - 2, TW, 4);
    g.fillStyle = 'rgba(220,240,255,.55)';
    const wx = [10, 22, 32][v];
    g.fillRect(wx, 7 + v * 3, 6, 1);
    g.fillRect(wx - 8, 14 - v, 4, 1);
  });
}
function forestTile() {
  return diamondCanvas('forest', (g) => {
    g.fillStyle = '#3d6b34'; g.fillRect(0, 0, TW, TH);
    g.fillStyle = '#34602d'; g.fillRect(8, 6, 6, 3); g.fillRect(28, 13, 8, 3);
  });
}

function drawItem(o) {
  const p = toScreen(o.px, o.py);
  // 地上的道具:Flare 圖示縮小放在格子上
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 2, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
  if (GDX.drawIcon(ctx, o, p.x - 13, p.y - 22, 26) || (GDX.hasIcon(o) === false && FLARE.drawIcon(ctx, o, p.x - 13, p.y - 22, 26))) {
    // 已畫
  } else if (GDX.hasIcon(o) === undefined) {
    // 原版圖示還在載入
  } else if (!SPR.draw(ctx, SPR.item(o), p.x, p.y + 6, 2)) {
    ctx.fillStyle = KIND_COLOR.item;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
  }
  const itemLayer = worldLayer('overlay');
  label(o.name, p.x, p.y - 26, '#ffe7a6');
  worldLayer(itemLayer);
}

function drawCreature(o, now) {
  const previous = worldLayer('creatures');
  try { return drawCreatureScene(o, now); } finally { worldLayer(previous); }
}
function drawCreatureScene(o, now) {
  const p = objScreen(o);
  const isMe = o.id === st.selfId;
  const color = isMe ? '#8fd0ff' : KIND_COLOR[o.kind] || '#aaa';
  const x = p.x;
  const y = p.y;

  // 伺服器生成的特效物件(火牢的火焰 L1Effect 等,沒有名字所以被當成門):照特效畫(發光混合、循環播放)
  if (o.kind === 'door' && st.game.effectKinds?.[o.gfx]) {
    worldLayer('overlay');
    o.fxStart ??= now;
    const info = L1S.effectInfo(o.gfx);
    if (info) L1S.drawEffect(ctx, o.gfx, x, y, (now - o.fxStart) % Math.max(1, info.dur), o.heading ?? 5, false, o);
    return;
  }
  if (o.kind === 'door') { L1S.drawCreature(ctx, o, x, y, now); return; } // 門、火把只有原版圖
  // 天堂客戶端的 8 方向動畫;沒有這個外型才用 Flare 素材
  // 原圖還在載入時什麼都不畫(不要先閃一下替代圖)
  let height = L1S.drawCreature(ctx, o, x, y, now) || (L1S.known(o.gfx) ? 0 : FLARE.drawCreature(ctx, o, isMe, st.myType, x, y, now));
  if (isMe && height) st.meH = height; // 擋住人物的物件變淡用(人物圖的高度)
  if (!height && L1S.known(o.gfx)) return; // 原圖還在載入:這幾格先不畫(不要閃出舊的佔位圖)
  if (!height) {
    // 沒有天堂原圖的外型:舊的佔位圖
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 14, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (o.dead) return;
    const h = o.heading ?? 4;
    if (!SPR.draw(ctx, SPR.creature(o, isMe, st.myType), x, y + 2, 3, DX[h] + DY[h] < 0)) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y - 20, 12, 0, Math.PI * 2); ctx.fill();
    }
    height = 48;
  }
  if (o.dead || o.kind === 'door') return; // 門、火把沒有名稱和血條
  worldLayer('overlay');
  const big = height / 48;

  const displayedTarget = unifiedPassive() ? unifiedControl.target : st.target;
  if (displayedTarget && displayedTarget.id === o.id) {
    ctx.strokeStyle = '#ff5b4b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }

  if (st.clickSelect && !auto.on && st.picked?.id === o.id && !o.dying && st.target?.id !== o.id) {
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // 名稱與血條
  const nameColor = o.kind === 'pc' ? (isPink(o.id) ? PINK_NAME : lawfulColor(o.lawful)) : o.kind === 'monster' ? '#ffd0c8' : o.kind === 'pet' ? (isMyPet(o) ? '#9fe8ff' : '#c8d8f5') : '#c8f5c4';
  // 封號:名字正上方另一行(顏色前綴 1~7 = 紅橙黃綠藍靛紫,沒有就跟名字同色)
  const tp = o.title ? titleParts(o.title) : null;
  const onScreen = x > -120 && x < canvas.width / (DPR * ZOOM) + 120 && y > -40 && y < canvas.height / (DPR * ZOOM) + 160;
  // 10/28 試做:其他玩家的名字 / 封號 / 盟徽預設不畫;點到(8 秒)、選為目標時才畫
  const pkRank = o.kind === 'pc' && st.pkRank && !inArenaEvent() && o.pkRank >= 1 && o.pkRank <= 3 ? o.pkRank : 0;
  const pcNameHidden = !pkRank && !st.showPcNames && o.kind === 'pc' && !isMe && !isWarEnemy(o) && st.target?.id !== o.id && st.picked?.id !== o.id && !(st.nameShow?.id === o.id && now < st.nameShow.until);
  if (onScreen && !pcNameHidden) { // 畫面外的(伺服器送來的範圍比手機畫面大很多)不畫名字:省掉一半以上的文字描邊
    const ny = y - height - (isMe ? 13 : 10);
    label(o.name, x, ny, isMe ? (isPink(o.id) ? PINK_NAME : '#bfe6ff') : nameColor); // 11/12 自己先動手也看得到粉紅名
    const eh = drawEmblem(o, x, ny) || 0;
    const ty = Math.min(ny - 14, ny - 5 - eh / 2 - 4); // 原稱號避開盟徽上緣
    if (tp?.text) label(tp.text, x, ty, tp.color || (isMe ? (isPink(o.id) ? PINK_NAME : '#bfe6ff') : nameColor));
    if (pkRank) label(`☠ 殺人榜 No.${pkRank}`, x, tp?.text ? ty - 14 : ty, '#ff4545');
  }
  // 自己:頭上顯示 HP(紅)/ MP(藍)
  if (isMe && st.me?.maxHp) {
    const w = 34;
    const hp = Math.max(0, Math.min(1, st.me.hp / st.me.maxHp));
    const mp = st.me.maxMp ? Math.max(0, Math.min(1, st.me.mp / st.me.maxMp)) : 0;
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x - w / 2 - 1, y - height - 7, w + 2, 8);
    ctx.fillStyle = '#e0453a'; ctx.fillRect(x - w / 2, y - height - 6, w * hp, 3);
    ctx.fillStyle = '#3d74e6'; ctx.fillRect(x - w / 2, y - height - 2, w * mp, 2);
  }
  if (o.kind !== 'doll' && o.hpRatio >= 0 && !isMe) {
    ctx.fillStyle = '#000'; ctx.fillRect(x - 16, y - height - 6, 32, 4);
    ctx.fillStyle = '#e0574a'; ctx.fillRect(x - 16, y - height - 6, (32 * o.hpRatio) / 100, 4);
  }
  if (o.bubble && now - o.bubbleAt < 4000) bubble(o.bubble, x, y - height - 26 - (tp?.text ? 14 : 0) - (pkRank ? 14 : 0));
}

// 封號顏色(血盟面板選的 7 色);title 字串開頭 1~7 是顏色,後面才是文字
const TITLE_COLORS = [['紅', '#ff5a52'], ['橙', '#ff9d3c'], ['黃', '#ffe14d'], ['綠', '#5fe06c'], ['藍', '#4fb0ff'], ['靛', '#8a86ff'], ['紫', '#d27dff']];
function titleParts(t) {
  const m = /^[\f\n]([1-7])/.exec(t || ''); // 10/28:血盟面板以前送成「換行 + 數字」,也當顏色碼
  return m ? { text: t.slice(2), color: TITLE_COLORS[+m[1] - 1][1], idx: +m[1] } : { text: t || '', color: null, idx: 0 };
}

// ---- 盟徽(伺服器 EmblemEnabled;SPEC deploy/feature-emblem/SPEC.md 4.3)----
// 血盟名 → 盟徽 id 對照:GET /api/clan-emblems(伺服器端快取 60 秒);角色封包沒有盟徽 id,只有血盟名。收到 S_CharReset 0x3c 的 emblem 事件(換盟徽 / 被刪)就即時更新。
// 圖:GET /emblem/<id>.png(16×12,1 天快取);名牌文字左邊畫、血盟面板顯示。開關關著(config.json emblem:false)完全不畫、不抓。
st.clanEmblems = {};
const emblemImgs = new Map(); // 盟徽 id -> Image
function emblemImg(id) {
  let im = emblemImgs.get(id);
  if (!im) {
    im = new Image(); im.src = `/emblem/${id}.png?v=3`; emblemImgs.set(id, im); if (emblemImgs.size > 300) emblemImgs.delete(emblemImgs.keys().next().value);
    im.onerror = () => setTimeout(() => { if (emblemImgs.get(id) === im) emblemImgs.delete(id); }, 10000); // 抓失敗(剛上傳、伺服器快取還沒更新:404)10 秒後忘掉它,下一次畫名牌重新抓
    // 拿到 16×12:5 秒後同網址再抓一次(一般是瀏覽器快取、不連線;剛上傳高清檔還沒對上時伺服器回 no-store → 這次會拿到高清)
    im.onload = () => { if (im.naturalWidth !== 16) return; setTimeout(() => { if (emblemImgs.get(id) !== im) return; const n = new Image(); n.onload = () => { if (emblemImgs.get(id) === im && n.naturalWidth) emblemImgs.set(id, n); }; n.src = im.src; }, 5000); };
  }
  return im;
}
let emblemAt = 0, emblemBusy = false;
async function refreshClanEmblems(fresh) { // fresh:繞過伺服器 60 秒快取與瀏覽器快取(盟徽事件後用)
  if (!st.emblem || emblemBusy) return;
  emblemBusy = true; emblemAt = Date.now();
  try { const r = await fetch(fresh ? `/api/clan-emblems?fresh=1&r=${Date.now()}` : '/api/clan-emblems'); if (r.ok) { const m = await r.json(); if (m && typeof m === 'object') st.clanEmblems = m; } } catch (e) { /* 抓不到就沿用舊的 */ }
  emblemBusy = false;
}
setInterval(() => { if (st.emblem && st.inGame && Date.now() - emblemAt > 60000) refreshClanEmblems(); }, 5000);
function onEmblemEvent(ev) { // { id: 角色 objid, emblem: 盟徽 id(0 = 沒有 / 被刪) }
  if (!st.emblem) return;
  const o = st.objects.get(ev.id);
  if (o) o.noEmblem = !(ev.emblem > 0); // 角色層級:0(退盟 / 被刪)只讓這個人不畫盟徽,不動整個血盟的對照
  const cn = (o && o.clan) || (ev.id === st.selfId && st.clan && st.clan.name) || '';
  if (ev.emblem > 0 && cn) st.clanEmblems[cn] = ev.emblem; // 知道血盟名(自己剛創盟也行):直接寫入,不等 API
  else { setTimeout(() => refreshClanEmblems(true), 1500); setTimeout(() => refreshClanEmblems(true), 7000); } // 其餘:繞過快取重抓兩次(伺服器 DB 可能晚一點才更新)
  if (ev.emblem > 0) emblemImg(ev.emblem);
}
function drawEmblem(o, x, ny) { // 名牌文字(label 剛畫完,字型已設好)左邊:右緣離名字 3、垂直置中在名字上;用裝置像素畫,每格整數倍(高清 24×18 / 48×36、舊 16×12)
  if (!st.emblem || o.kind !== 'pc' || !o.clan || o.noEmblem) return;
  const id = st.clanEmblems[o.clan];
  if (!id) return;
  const im = emblemImg(id);
  if (!im.complete || !im.naturalWidth) return;
  const w = ctx.measureText(o.name).width;
  const t = ctx.getTransform();
  const s = Math.abs(t.a) || 1;
  const nw = im.naturalWidth, nh = im.naturalHeight;
  const target = 15 * s; // 10/27:拿掉高清 36 裝置像素下限(1024×768 不放大時盟徽會比名字大 3 倍);跟名字一起縮放 // 目標高度:15 世界單位(換成裝置像素);高清至少 36 裝置像素(24×18 = 每格 2×2),電腦版倍率低時也看得清楚(使用者 10/26「還是很模糊」)
  let dw, dh, smooth = false;
  if (nh <= target * 1.25) { const k = Math.max(1, Math.round(target / nh)); dw = nw * k; dh = nh * k; } // 整數倍放大:每格一樣大
  else { dh = Math.max(1, Math.round(target)); dw = Math.max(1, Math.round(target * nw / nh)); smooth = true; } // 48×36 在低解析度螢幕:平滑縮小
  const wx = x - w / 2 - 3, wy = ny - 5; // 右緣中點(世界座標;12px 字的視覺中心約在基線上 5)
  const rx = t.a * wx + t.c * wy + t.e, cy = t.b * wx + t.d * wy + t.f;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im, Math.round(rx - dw), Math.round(cy - dh / 2), dw, dh);
  ctx.restore();
  return dh / s; // 10/28:盟徽高度(世界單位),封號要避開
}

function label(text, x, y, color) {
  ctx.font = '12px "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function bubble(text, x, y) {
  ctx.font = '12px "Microsoft JhengHei", sans-serif';
  const w = Math.min(220, ctx.measureText(text).width + 14);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 16, w, 20, 6); ctx.fill();
  ctx.fillStyle = '#222'; ctx.textAlign = 'center';
  ctx.fillText(text, x, y - 2, 206);
}

function drawTitle(W, H, now) {
  // 登入畫面背景:緩慢捲動的斜角格
  ctx.strokeStyle = 'rgba(216,180,106,.07)';
  const off = (now / 60) % TH;
  ctx.beginPath();
  for (let i = -H; i < W + H; i += TW) {
    ctx.moveTo(i, -TH + off); ctx.lineTo(i + H * 2, H * 1 + off);
    ctx.moveTo(i, H + off); ctx.lineTo(i + H * 2, -H + off);
  }
  ctx.stroke();
}

// 玩家名字顏色照正義值:0 是中立(白色),1 起就是正義、-1 起就是邪惡;
// 從白色照比例漸漸變色,32767 最藍、-32768 最紅
// 粉紅名(先動手打藍名玩家,伺服器 L1PinkName):期間內名字顯示粉紅,蓋過正義值顏色
const PINK_NAME = '#ff6ec7';
const isPink = (id) => (st.pink?.get(id) || 0) > performance.now();
function lawfulColor(lawful) {
  const l = lawful || 0;
  if (!l) return '#ffffff';
  const t = Math.min(1, Math.abs(l) / (l > 0 ? 32767 : 32768));
  const [r, g, b] = l > 0 ? [80, 140, 255] : [255, 70, 60];
  const mix = (c) => Math.round(255 + (c - 255) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Metrics frame twin: control flow stays in sync with frame; drawing uses the common scene.
function rmFrame(now) {
  const perfT0 = performance.now();
  if (catchUp.n <= CATCHUP_PER_FRAME && now > catchUp.until) catchUp.on = false; // 這一格沒有湧進大量事件:補送結束
  catchUp.n = 0;
  RM.data.raf++;
  let rmT = RM.clock();
  step(now);
  RM.add('step', RM.clock() - rmT);
  rmT = RM.clock();
  updateAnims(now);
  RM.add('anims', RM.clock() - rmT);
  rmT = RM.clock();
  const me = self();
  preloadPosition(me);
  if (me) {
    st.cam.x = me.px; st.cam.y = me.py;
    // 座標有變才寫:每格都寫 textContent 會讓版面失效,小地圖讀 clientWidth 時就要整頁重排
    const pos = `${me.x}, ${me.y}`;
    if (pos !== hudPosText) { hudPosText = pos; $('#hud-pos').textContent = pos; }
  }
  updateCaptureBtn();
  if (me && st.map) PRELOAD.near(st.mapId, me.x, me.y); // 換區塊時才會排新的下載
  // 效能自動調整:PERF.level >= 1 時隔幀畫(邏輯 step / 動畫狀態照每幀跑,只少畫)
  const perfDrew = PERF.level < 1 || now - PERF.lastDraw >= 28;
  RM.add('hud', RM.clock() - rmT);
  if (perfDrew) {
    PERF.lastDraw = now;
    if (st.inGame && st.map) {
      const d = RM.data;
      if (d.lastRender !== null) RM.add('interval', now - d.lastRender);
      d.lastRender = now; d.renders++;
      const draws = d.draws, texts = d.texts;
      rmT = RM.clock(); rmDraw(now);
      RM.add('submit', RM.clock() - rmT - RM.sceneMs);
      RM.add('drawImage', d.draws - draws); RM.add('fillText', d.texts - texts);
    } else draw(now);
    rmT = RM.clock(); drawMinimap(now); RM.add('minimap', RM.clock() - rmT);
  }
  perfSample(now, performance.now() - perfT0, perfDrew);
}
function rmDraw(now) { draw(now); }

// BEGIN DOLLSYNTH UI — all costs, rates, tiers and quantities come from the server.
let dollSynthUi = null;
const dollSynthTierName = n => ['', '一階', '二階', '三階'][n] || '';
function dollSynthTierText(id) {
  const n = st.dollSynth?.tiers?.findIndex(t => t.includes(id));
  return Number.isInteger(n) && n >= 0 ? `${dollSynthTierName(n + 1)}。` : '';
}
function renderDollSynthEntry(foot) {
  if (!foot) return;
  const visible = st.dollSynth && ((st.dollHoldPending?.id === st.selfId && st.dollHoldPending.active) || [...st.inv.values()].some(i => (st.dollSynth.tiers.some(t => t.includes(dollItemId(i))) || Object.values(DOLL_NAME_IDS).includes(dollItemId(i))))); // REROLLHOLD: keep the existing entry reachable with an empty doll inventory.
  let b = foot.querySelector('.dollsynth-open');
  if (!visible) { b?.remove(); return; }
  if (!b) { b = el('button', 'learn dollsynth-open', '娃娃合成'); b.type = 'button'; b.onclick = openDollSynth; foot.append(b); }
}
function closeDollSynth() {
  const t = dollSynthUi; if (!t) return;
  if (dollSynthActive(t) && t.quote?.holdEnabled === false) send({ t: 'dollsynth', op: 3 }); // REROLLHOLD: an unknown quote must not confirm a persisted result. // Also closes a pending result whose token has not arrived yet.
  clearTimeout(t.timer); clearTimeout(t.timeout); clearTimeout(t.coolTimer); clearTimeout(t.stageTimer); t.root.remove(); dollSynthUi = null;
  t.focus?.isConnected && t.focus.focus();
}
function dollSynthActive(t) { return !!t && t === dollSynthUi && st.inGame && st.dollSynth && t.id === st.selfId; } // 主導 11/17:視窗關掉後才到的回覆(關閉時會送「結束重骰」)t 是 null,原本會丟例外、連同一批的其他事件一起略過
function openDollSynth() {
  if (!st.dollSynth || !st.inGame) return;
  closeDollSynth();
  const root = el('div', 'dollsynth-overlay'); root.id = 'dollsynth';
  const box = el('section', 'dollsynth-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '魔法娃娃合成');
  const head = el('header', 'dollsynth-head'); head.append(el('strong', '', '魔法娃娃合成'));
  const close = el('button', '', '關閉'); close.type = 'button'; close.onclick = closeDollSynth; head.append(close);
  const body = el('div', 'dollsynth-body'); body.append(el('p', '', '讀取背包與合成規則…')); box.append(head, body); root.append(box); document.body.append(root);
  const t = dollSynthUi = { root, body, box, id: st.selfId, selected: new Map(), busy: false, quote: null, note: '', focus: document.activeElement };
  root.onkeydown = e => {
    if (e.key === 'Escape' && !t.busy) { e.stopPropagation(); closeDollSynth(); }
    if (e.key === 'Tab') {
      const buttons = [...box.querySelectorAll('button:not(:disabled)')].filter(b => b.offsetParent !== null);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const poll = () => {
    if (!dollSynthActive(t)) { closeDollSynth(); return; }
    if (!t.busy) send({ t: 'dollsynth', op: 0 });
    t.timer = setTimeout(poll, 1500);
  };
  poll(); close.focus();
}
function onDollSynth(j) {
  // BEGIN REROLLHOLD: login/poll replies also update the existing entry while the dialog is closed.
  if (!st.inGame || !j || j.id !== st.selfId || !Array.isArray(j.items) || !Number.isInteger(j.token)) return;
  st.dollHoldPending = { id: j.id, active: !!j.holdEnabled && (dollHoldRows(j).length > 0 || j.result === 'review') };
  if (typeof panel !== 'undefined' && panel.name === 'inv' && panel.tab !== 'collection') renderDollSynthEntry($('#panel-foot'));
  // END REROLLHOLD
  const t = dollSynthUi;
  if (!dollSynthActive(t) || !j || j.id !== t.id || !Array.isArray(j.items) || !Number.isInteger(j.token)) return;
  t.quote = j; t.holdClock = performance.now(); // REROLLHOLD: countdown uses the server timestamp.
  if (j.tiers) st.dollSynth.tiers = j.tiers;
  const messages = { holdfull: DOLL_HOLD_FULL, materials: '材料已變動，請重新選擇', tier: '請放入同階的一階或二階娃娃', active: '召喚中的娃娃不能合成', locked: '請先解除道具上鎖',
    gold: `金幣不足，需要 ${t.paidGold || 0}`, alternative: '沒有其他可重骰的三階娃娃', diamond: '可用的品質鑽石不足', capacity: '背包空間不足，請先清出空間', state: '請結束死亡、交易、擺攤或無法行動狀態', config: '合成設定已變更或暫不可用',
    cooldown: '合成間隔尚未結束，請稍候', stale: '這次確認已失效，請核對背包後重新選擇', refunded: '操作未完成，娃娃、鑽石與金幣已補回', review: '合成未完成，請聯絡管理員核對，請勿重試' };
  const receipt = j.receipt && j.receipt.token === t.pending ? j.receipt : null;
  // REROLLHOLD: only the accepted receipt may advance the stage to a new operation/token.
  if (receipt?.holdSlot && dollHoldRows(j).some(h => h.slot === receipt.holdSlot && h.operation === receipt.holdOperation)) {
    t.stageSlot = receipt.holdSlot; t.stageOperation = receipt.holdOperation;
  }
  if (t.recovering && !receipt && !j.result) {
    dollSynthStageEnd(t);
    t.busy = false; t.pending = null; t.note = '未取得本次完成紀錄，請核對背包後再確認合成';
  }
  t.recovering = false;
  if (receipt || j.result) {
    t.busy = false; clearTimeout(t.timeout);
    if (t.rerolling && receipt?.result !== 'reroll') {
      t.rerolling = false; t.stage?.classList.remove('rerolling');
      if (t.stage && t.outcome && (j.reroll || dollHoldStageRow(t)?.reroll)) { t.stage.classList.add('win'); t.stage.querySelector('.ds-text').textContent = '重骰未完成'; dollSynthRerollControls(t); } else dollSynthStageEnd(t);
    } else dollSynthReveal(t, receipt);
    if (receipt && (!t.rerollRequest || ['reroll', 'refunded', 'review'].includes(receipt.result))) { t.outcome = receipt; t.pending = null; t.selected.clear(); }
    const code = receipt?.result || j.result; t.note = messages[code] || '';
    t.pending = null; t.rerollRequest = false;
    if (code === 'ended') { t.ending = false; dollSynthStageEnd(t); }
    if (['success', 'failure', 'reroll', 'refunded', 'review'].includes(code)) invResync(true);
    t.coolUntil = performance.now() + (j.intervalMs || 0);
    clearTimeout(t.coolTimer); t.coolTimer = setTimeout(() => { if (dollSynthActive(t)) renderDollSynth(t); }, (j.intervalMs || 0) + 20);
  }
  for (const [id, n] of t.selected) {
    const i = j.items.find(v => v.id === id);
    if (!i || i.active || i.locked || i.count < n) t.selected.delete(id);
  }
  if (t.stage?.classList.contains('deciding') && !t.busy) {
    if (j.holdEnabled && !dollHoldStageRow(t)) dollSynthStageEnd(t);
    else dollSynthRerollControls(t);
  }
  // Keep confirmation DOM stable while background snapshots arrive; confirmation revalidates below.
  if (!t.confirm) renderDollSynth(t);
}
function dollSynthUnits(t) {
  const units = []; for (const [id, n] of t.selected) { const i = t.quote.items.find(v => v.id === id); if (i) for (let k = 0; k < n; k++) units.push(i); }
  return units;
}
function dollSynthCost(t, tier) {
  const j = t.quote, n = j.diamonds[tier - 1] || 0;
  const held = j.mode === 'sealed' ? j.sealed : j.mode === 'unsealed' ? j.ordinary : j.sealed + j.ordinary;
  const mode = j.mode === 'any' ? `刻印 ${j.sealed} / 一般 ${j.ordinary}，先扣刻印` : j.mode === 'sealed' ? '只收刻印' : '只收一般（沒刻印）';
  if (!n) return { n, held, text: '' }; // 使用者 11/16:不扣鑽石的那一階什麼都不要寫
  return { n, held, text: `${j.diamondName} ×${n}（身上可用 ${held}） · ${mode}` };
}
function dollSynthCostRow(t, tier) { // 使用者 11/16:品質鑽石不夠明顯 → 放道具圖示、數量放大、不夠時變紅
  const c = dollSynthCost(t, tier), j = t.quote; if (!c.n) return null;
  const row = el('div', `dollsynth-cost${c.held < c.n ? ' poor' : ''}`);
  const info = el('div', 'dollsynth-cost-info');
  const need = el('strong', ''); need.append(`${j.diamondName} `, el('b', '', `×${c.n}`));
  const mode = j.mode === 'any' ? `刻印 ${j.sealed}、一般 ${j.ordinary}，先扣刻印` : j.mode === 'sealed' ? '只收刻印的' : '只收沒刻印的';
  info.append(need, el('small', '', `身上可用 ${c.held} 顆（${mode}）${c.held < c.n ? '　數量不足' : ''}`));
  row.append(iconCanvas({ name: j.diamondName }, 36), info);
  return row;
}
function dollSynthGoldRow(t, tier) {
  const n = t.quote.gold?.[tier - 1] || 0; if (!n) return null;
  const held = t.quote.goldHeld || 0, row = el('div', `dollsynth-cost${held < n ? ' poor' : ''}`), info = el('div', 'dollsynth-cost-info');
  info.append(el('strong', '', `金幣 ${n.toLocaleString()}`), el('small', '', `身上可用 ${held.toLocaleString()}${held < n ? '　金幣不足' : ''}`));
  row.append(iconCanvas({ name: '金幣' }, 36), info); return row;
}
function dollSynthReady(t) {
  if (!t.quote?.enabled || t.busy || t.stage || performance.now() < (t.coolUntil || 0)) return false;
  if (t.quote.holdEnabled && dollHoldRows(t.quote).length >= 3) return false; // REROLLHOLD: only the three-slot cap blocks synthesis.
  const u = dollSynthUnits(t), j = t.quote;
  return u.length === j.count && u.every(i => i.tier === u[0].tier && i.tier < 3 && !i.active && !i.locked && i.count >= t.selected.get(i.id)) && dollSynthCost(t, u[0].tier).held >= dollSynthCost(t, u[0].tier).n && (j.goldHeld || 0) >= (j.gold?.[u[0].tier - 1] || 0);
}
function renderDollSynth(t) {
  if (!dollSynthActive(t) || t.confirm) return;
  const j = t.quote; t.body.replaceChildren();
  dollHoldCard(t); // REROLLHOLD: persistent decision appears above all synthesis content.
  if (!j?.enabled) { t.body.append(el('p', 'dollsynth-note', t.note || '合成目前無法使用')); return; }
  t.body.append(el('p', 'dollsynth-intro', `放入 ${j.count} 隻同階的魔法娃娃，有機率合成 1 隻高一階的娃娃。`));
  if (t.outcome && ['success', 'failure', 'reroll'].includes(t.outcome.result)) {
    const win = ['success', 'reroll'].includes(t.outcome.result), result = el('div', `dollsynth-result ${win ? 'success' : 'failure'}`); result.setAttribute('role', 'status');
    result.append(el('strong', '', win ? '合成成功！' : '合成失敗'));
    const got = win ? [t.outcome.product] : t.outcome.returned;
    for (const i of got || []) if (i) { const row = el('div', 'dollsynth-got'); row.append(iconCanvas(i, 40), el('span', '', `${win ? (j.holdEnabled && dollHoldRows(j).some(h => h.slot === t.outcome?.holdSlot && h.operation === t.outcome?.holdOperation && h.status === 'active') ? '待確認' : '獲得') : '保留'} ${i.name} ×${i.count}`)); result.append(row); }
    if (!win) result.append(el('small', '', `其餘 ${j.count - j.failReturn} 隻${t.paidDiamonds ? '與本次鑽石' : ''}已消耗`));
    t.body.append(result);
  }
  if (t.note) { const note = el('p', 'dollsynth-note', t.note); note.setAttribute('role', 'status'); t.body.append(note); }
  const units = dollSynthUnits(t), tier = units[0]?.tier || 0;
  const slots = el('div', 'dollsynth-slots'); slots.style.setProperty('--ds-cols', Math.min(j.count, 4));
  for (let k = 0; k < j.count; k++) {
    const i = units[k], slot = el('button', `dollsynth-slot${i ? ' filled' : ''}`); slot.type = 'button'; slot.disabled = t.busy;
    if (i) { slot.append(iconCanvas(i, 36), el('small', '', i.name.replace(/^魔法娃娃[:：]/, ''))); slot.setAttribute('aria-label', `取出 ${i.name}`); slot.onclick = () => { const n = t.selected.get(i.id) - 1; n ? t.selected.set(i.id, n) : t.selected.delete(i.id); t.outcome = null; renderDollSynth(t); }; }
    else slot.append(el('span', '', '＋'), el('small', '', `材料 ${k + 1}`)); slots.append(slot);
  }
  t.body.append(slots);
  const rules = el('div', 'dollsynth-rules');
  if (tier) { rules.append(el('strong', '', `${dollSynthTierName(tier)} → ${dollSynthTierName(tier + 1)} · 成功率 ${j.rates[tier - 1]}%`)); const cr = dollSynthCostRow(t, tier); if (cr) rules.append(cr); const gr = dollSynthGoldRow(t, tier); if (gr) rules.append(gr); }
  else rules.append(el('strong', '', '先選擇一隻一階或二階娃娃'));
  rules.append(el('small', '', `失敗隨機退回投入材料中的 ${j.failReturn} 隻，其餘消失${tier && dollSynthCost(t, tier).n ? '；鑽石成功、失敗都扣' : ''}${tier && j.gold?.[tier - 1] ? '；金幣成功、失敗都扣' : ''}。`)); t.body.append(rules);
  const actions = el('div', 'dollsynth-actions');
  const auto = el('button', '', '自動放入'); auto.type = 'button'; auto.disabled = t.busy; auto.onclick = () => autoDollSynth(t);
  const submit = el('button', 'dollsynth-submit', t.busy ? '合成處理中…' : '合成'); submit.type = 'button'; submit.disabled = !dollSynthReady(t); submit.onclick = () => confirmDollSynth(t);
  actions.append(auto, submit); t.body.append(actions, el('h4', '', '背包裡的娃娃 · 點選放入，點材料格取出'));
  const pool = el('div', 'dollsynth-pool');
  // 使用者 11/16:娃娃不能疊,同一種會拆成好幾格各寫「持有 1」→ 同種合成一格,顯示總數;召喚中 / 上鎖的另外一格。
  const groups = new Map();
  for (const i of j.items) { const k = `${i.itemId}|${i.active ? 'a' : i.locked ? 'l' : ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  for (const list of groups.values()) {
    const i = list[0], total = list.reduce((s, v) => s + v.count, 0), n = list.reduce((s, v) => s + (t.selected.get(v.id) || 0), 0);
    const reason = i.active ? '召喚中' : i.locked ? '道具已上鎖' : i.tier === 3 ? '三階無法再合成' : tier && i.tier !== tier ? '與材料不同階' : '';
    const b = el('button', `dollsynth-item${n ? ' selected' : ''}`); b.type = 'button'; b.disabled = !!reason || t.busy;
    b.append(iconCanvas(i, 32)); const label = el('span', ''); label.append(el('span', '', i.name.replace(/^魔法娃娃[:：]/, '')), el('small', '', `${dollSynthTierName(i.tier)} · ${reason ? `${reason} · ${total} 隻` : `持有 ${total}${n ? ` / 已放 ${n}` : ''}`}`)); b.append(label);
    b.onclick = () => {
      const spare = list.find(v => (t.selected.get(v.id) || 0) < v.count);
      if (spare && units.length < j.count) t.selected.set(spare.id, (t.selected.get(spare.id) || 0) + 1); // 還有沒放的:再放一隻
      else if (n) for (const v of list) t.selected.delete(v.id); // 都放了或格子滿了:這一種全部取出
      t.outcome = null; t.note = ''; renderDollSynth(t);
    }; pool.append(b);
  }
  t.body.append(pool);
}
function autoDollSynth(t) {
  const j = t.quote, current = dollSynthUnits(t)[0]?.tier;
  const candidates = j.items.filter(i => i.tier < 3 && !i.active && !i.locked);
  const total = tier => candidates.filter(i => i.tier === tier).reduce((n, i) => n + (i.stackable ? i.count : 1), 0);
  const tier = current || ([1, 2].find(n => total(n) >= j.count)) || candidates[0]?.tier;
  const choices = candidates.filter(i => i.tier === tier), kinds = new Map();
  for (const i of choices) kinds.set(i.itemId, (kinds.get(i.itemId) || 0) + (i.stackable ? i.count : 1));
  choices.sort((a, b) => kinds.get(b.itemId) - kinds.get(a.itemId) || a.itemId - b.itemId || a.id - b.id);
  t.selected.clear(); let left = j.count;
  for (const i of choices) { const n = Math.min(left, i.stackable ? i.count : 1); if (n > 0) { t.selected.set(i.id, n); left -= n; } }
  t.outcome = null; t.note = left ? `同階可用材料還少 ${left} 隻` : ''; renderDollSynth(t);
}
// 合成動畫(使用者 11/16:「合成要有動畫」):4 隻材料旋轉吸進中央 → 等伺服器結果 → 成功爆光跳出新娃娃 / 失敗碎裂留下退回的那隻。
// 只是畫面效果;結果完全以伺服器回覆為準,動畫蓋住的期間下面的結果區已經照常更新。
const DOLLSYNTH_SPIN_MS = 1700, DOLLSYNTH_SHOW_MS = 1900;
function dollSynthStage(t, units, force = false) {
  dollSynthStageEnd(t);
  if (!force && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const stage = t.stage = el('div', 'dollsynth-stage'); stage.setAttribute('aria-hidden', 'true');
  const ring = el('div', 'ds-ring');
  units.forEach((i, k) => { const m = el('div', 'ds-mat'); m.style.setProperty('--a', `${Math.round(360 * k / units.length) - 90}deg`); m.append(iconCanvas(i, 48)); ring.append(m); });
  ring.append(el('div', 'ds-rays'), el('div', 'ds-orb'), el('div', 'ds-prize'));
  stage.append(ring, el('strong', 'ds-text', '合成中…'), el('small', 'ds-sub', ''));
  t.stageAt = performance.now(); t.box.append(stage);
}
function dollSynthStageEnd(t) { clearTimeout(t.stageTimer); t.stage?.remove(); t.stage = null; t.box?.classList.remove('ds-quake', 'ds-quake-hard'); }
function dollSynthReveal(t, receipt) {
  if (receipt) { t.stageSlot = receipt.holdSlot || 0; t.stageOperation = receipt.holdOperation || ''; } // REROLLHOLD: stage actions belong to this receipt's slot.
  if (!t.stage && (t.quote?.holdEnabled ? dollHoldStageRow(t)?.status === 'active' : !!t.quote?.reroll) && ['success', 'reroll'].includes(receipt?.result)) dollSynthStage(t, [], true);
  const stage = t.stage; if (!stage) return;
  const code = receipt?.result, direct = code === 'reroll' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (code !== 'success' && code !== 'failure' && code !== 'reroll') { dollSynthStageEnd(t); return; }
  clearTimeout(t.stageTimer);
  t.stageTimer = setTimeout(() => {
    if (t.stage !== stage) return;
    // 使用者 11/16:結果先蓋住,玩家點下去才揭曉成功 / 失敗與娃娃
    stage.classList.add('ready'); stage.removeAttribute('aria-hidden'); stage.setAttribute('role', 'button'); stage.tabIndex = 0;
    stage.querySelector('.ds-text').textContent = ''; // 使用者 11/16:不要寫「點一下揭曉」
    const open = () => {
      if (t.stage !== stage) return;
      const win = code !== 'failure', got = win ? receipt.product : (receipt.returned || [])[0];
      stage.classList.remove('ready', 'rerolling'); t.rerolling = false; stage.classList.add(win ? 'win' : 'lose');
      // 使用者 11/16:揭曉的特效要更重 — 整面閃光、衝擊波、往外噴的碎片(成功 = 金色星芒;失敗 = 暗紅碎片往下掉)+ 整個視窗震動
      const ring = stage.querySelector('.ds-ring'), rnd = (a, b) => a + Math.random() * (b - a);
      stage.append(el('div', 'ds-flash'));
      for (let k = 0; k < 3; k++) { const w = el('div', 'ds-wave'); w.style.animationDelay = `${k * 140}ms`; ring.append(w); }
      for (let k = 0; k < (win ? 44 : 34); k++) {
        const q = el('i', 'ds-p'), ang = rnd(0, Math.PI * 2), dist = win ? rnd(110, 300) : rnd(60, 220);
        q.style.setProperty('--dx', `${Math.round(Math.cos(ang) * dist)}px`);
        q.style.setProperty('--dy', `${Math.round(Math.sin(ang) * dist * (win ? 1 : .6) + (win ? 0 : rnd(120, 300)))}px`);
        q.style.setProperty('--rot', `${Math.round(rnd(-540, 540))}deg`);
        q.style.setProperty('--sz', `${Math.round(win ? rnd(4, 11) : rnd(6, 18))}px`);
        q.style.animationDelay = `${Math.round(rnd(0, 180))}ms`; q.style.animationDuration = `${Math.round(win ? rnd(900, 1700) : rnd(800, 1400))}ms`;
        ring.append(q);
      }
      t.box.classList.remove('ds-quake', 'ds-quake-hard'); void t.box.offsetWidth; t.box.classList.add(win ? 'ds-quake' : 'ds-quake-hard');
      const prize = stage.querySelector('.ds-prize'); prize.replaceChildren(); if (got) prize.append(iconCanvas(got, 64));
      stage.querySelector('.ds-text').textContent = win ? '合成成功！' : '合成失敗';
      stage.querySelector('.ds-sub').textContent = got ? `${win ? (dollHoldStageRow(t)?.status === 'active' ? '待確認' : '獲得') : '保留'} ${got.name}` : '';
      if (win && (t.quote?.holdEnabled ? dollHoldStageRow(t)?.status === 'active' : (t.quote?.reroll || code === 'reroll')) && !t.ending) { dollSynthRerollControls(t); return; }
      const shown = performance.now();
      stage.onclick = stage.onkeydown = () => { if (performance.now() - shown > 500) dollSynthStageEnd(t); }; // 看完再點一下關閉(剛揭曉的半秒內不算,免得連點直接關掉)
    };
    stage.onclick = open; stage.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    if (direct) open(); else stage.focus?.();
  }, Math.max(0, (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : code === 'reroll' ? 1000 : DOLLSYNTH_SPIN_MS) - (performance.now() - t.stageAt)));
}
// Decisions are server-owned; polling only recovers receipts, never resubmits a paid request.
function dollSynthRerollControls(t) {
  const stage = t.stage; if (!stage) return;
  stage.classList.add('deciding'); stage.removeAttribute('aria-hidden'); stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', '三階娃娃結果'); stage.removeAttribute('tabindex');
  stage.onclick = stage.onkeydown = null;
  const previous = stage.querySelector('.ds-decisions'), focused = previous?.contains(document.activeElement), focusClass = document.activeElement?.className;
  previous?.remove();
  const controls = el('div', 'ds-decisions'), buttons = el('div', 'ds-buttons');
  const done = el('button', 'ds-done', '確定'), again = el('button', 'ds-again'); done.type = again.type = 'button';
  const q = t.quote || {}, h = dollHoldStageRow(t), rr = q.holdEnabled ? h?.reroll : q.reroll, n = rr?.diamonds || 1, rm = q.rerollMode || q.mode; // 使用者 11/17:重骰不能用刻印的鑽石(DollSynthRerollDiamondMode)
  const held = rm === 'sealed' ? q.sealed : rm === 'unsealed' ? q.ordinary : (q.sealed || 0) + (q.ordinary || 0);
  done.disabled = t.busy || t.rerolling || (q.holdEnabled && h?.status !== 'active'); again.disabled = t.busy || t.rerolling || (q.holdEnabled && !q.enabled) || !rr || held < n || t.ending;
  again.append(iconCanvas({ name: '品質鑽石' }, 24), el('span', '', `重骰 ×${n}`));
  done.onclick = () => {
    if (t.busy || t.rerolling) return;
    if (t.quote?.holdEnabled) { dollHoldConfirm(t, h); return; } // REROLLHOLD
    t.ending = true; t.quote.reroll = null; send({ t: 'dollsynth', op: 3 }); dollSynthStageEnd(t); renderDollSynth(t);
  };
  again.onclick = () => {
    const current = t.quote?.holdEnabled ? dollHoldStageRow(t)?.reroll : t.quote?.reroll;
    if (t.busy || t.rerolling || !current || t.ending) return;
    t.busy = true; t.rerollRequest = t.rerolling = true; t.pending = current.token; t.stageAt = performance.now();
    stage.classList.remove('win', 'lose'); stage.classList.add('rerolling');
    stage.querySelectorAll('.ds-flash, .ds-wave, .ds-p').forEach(e => e.remove());
    stage.querySelector('.ds-text').textContent = '重骰中…';
    dollSynthRerollControls(t); send({ t: 'dollsynth', op: 2, token: t.pending });
    clearTimeout(t.timeout); t.timeout = setTimeout(() => {
      if (!dollSynthActive(t) || !t.busy) return;
      t.recovering = true; t.note = '正在查詢本次結果，請勿重送'; send({ t: 'dollsynth', op: 0 });
    }, 8000);
  };
  buttons.append(done, again); controls.append(buttons, el('small', held < n ? 'poor' : '', `身上可用 ${held} 顆${held < n ? ' · 品質鑽石不足' : ''}`), el('small', '', rr ? '按下確定後就不能再重骰' : '重骰資格已結束，請按確定'));
  // BEGIN REROLLHOLD
  if (q.holdEnabled && h?.status === 'active') {
    const later = el('button', 'ds-later', '稍後再決定'); later.type = 'button'; later.disabled = t.busy || t.rerolling;
    later.onclick = () => { if (!t.busy && !t.rerolling) { dollSynthStageEnd(t); renderDollSynth(t); } };
    buttons.append(later); controls.append(el('small', '', dollHoldTip(q, h)));
    if (dollHoldRows(q).length >= 3) controls.append(el('small', 'dollhold-limit-tip', '已達 3 隻上限，確定前不能再合成'));
  }
  // END REROLLHOLD
  stage.append(controls);
  if (focused) controls.querySelector(focusClass === 'ds-again' && !again.disabled ? '.ds-again' : '.ds-done')?.focus();
}
function confirmDollSynth(t) {
  if (!dollSynthReady(t) || t.confirm) return;
  const j = t.quote, units = dollSynthUnits(t), tier = units[0].tier;
  const snapshot = [...t.selected].map(([id, count]) => ({ id, count }));
  const confirm = t.confirm = el('div', 'dollsynth-confirm'); confirm.setAttribute('role', 'alertdialog'); confirm.setAttribute('aria-label', '確認合成');
  confirm.append(el('strong', '', '確認消耗以下材料？'));
  const list = el('ul', ''); for (const i of units) list.append(el('li', '', i.name)); confirm.append(list);
  confirm.append(el('p', '', `${dollSynthTierName(tier)} → ${dollSynthTierName(tier + 1)}，成功率 ${j.rates[tier - 1]}%`), el('p', '', `失敗隨機退回 ${j.failReturn} 隻材料，其餘 ${j.count - j.failReturn} 隻${dollSynthCost(t, tier).n ? '與鑽石' : ''}消失${j.gold?.[tier - 1] ? '；金幣成功、失敗都扣' : ''}。`)); { const cr = dollSynthCostRow(t, tier); if (cr) confirm.lastChild.before(cr); const gr = dollSynthGoldRow(t, tier); if (gr) confirm.lastChild.before(gr); }
  const yes = el('button', 'dollsynth-confirm-yes', '確認合成'), no = el('button', '', '取消'); yes.type = no.type = 'button';
  const close = () => { confirm.remove(); t.confirm = null; renderDollSynth(t); };
  no.onclick = close;
  yes.onclick = () => {
    if (!dollSynthActive(t) || t.busy) return;
    if (!dollSynthReady(t) || t.quote.token !== j.token || JSON.stringify([...t.selected].map(([id, count]) => ({ id, count }))) !== JSON.stringify(snapshot)) { t.note = '背包或規則已變更，請重新確認'; close(); return; }
    t.busy = true; t.pending = j.token; t.outcome = null; t.paidDiamonds = dollSynthCost(t, tier).n; t.paidGold = j.gold?.[tier - 1] || 0; t.ending = false; close();
    dollSynthStage(t, units);
    send({ t: 'dollsynth', op: 1, token: j.token, items: snapshot });
    t.timeout = setTimeout(() => {
      if (!dollSynthActive(t) || !t.busy) return;
      t.recovering = true; t.note = '正在查詢本次結果，請勿重送'; dollSynthStageEnd(t); renderDollSynth(t); invResync(true); send({ t: 'dollsynth', op: 0 });
    }, 8000);
  };
  confirm.append(yes, no); t.body.append(confirm); confirm.scrollIntoView({ block: 'nearest' }); no.focus();
}
// BEGIN REROLLHOLD
const DOLL_HOLD_FULL = '待確認的三階娃娃已有 3 隻(上限)，請先確定後才能再合成';
function dollHoldRows(q) { return Array.isArray(q?.holds) ? q.holds : q?.hold ? [q.hold] : []; }
function dollHoldStageRow(t) { return dollHoldRows(t.quote).find(h => h.slot === t.stageSlot && h.operation === t.stageOperation); }
function dollHoldTip(q, h = dollHoldRows(q)[0]) {
  const hours = h ? Math.round((h.expires - h.created) / 3600000) : 24;
  return `${hours} 小時內沒有確定，會自動確定。按確定或 ${hours} 小時後放進背包；背包滿或不在線會寄到信箱。`;
}
function dollHoldConfirm(t, h) {
  const current = dollHoldRows(t.quote).find(v => v.slot === h?.slot && v.token === h?.token);
  if (t.busy || t.rerolling || current?.status !== 'active') return;
  t.busy = true; t.ending = true; t.pending = null; send({ t: 'dollsynth', op: 3, token: current.token });
  renderDollSynth(t); if (t.stage) dollSynthRerollControls(t);
  clearTimeout(t.timeout); t.timeout = setTimeout(() => {
    if (!dollSynthActive(t) || !t.busy) return;
    t.recovering = true; t.note = '正在查詢確認結果，請勿重送'; send({ t: 'dollsynth', op: 0 });
  }, 8000);
}
function dollHoldReroll(t, h) {
  const current = dollHoldRows(t.quote).find(v => v.slot === h?.slot && v.token === h?.token);
  if (t.busy || t.rerolling || !current?.reroll || current.status !== 'active') return;
  t.ending = false;
  if (!t.stage) {
    dollSynthStage(t, [], true); t.stage.classList.add('win');
    t.stage.querySelector('.ds-prize').append(iconCanvas(current.product, 64));
    t.stage.querySelector('.ds-text').textContent = '待確認';
    t.stage.querySelector('.ds-sub').textContent = current.product.name;
  }
  t.stageSlot = current.slot; t.stageOperation = current.operation;
  dollSynthRerollControls(t); t.stage.querySelector('.ds-again')?.click();
}
function dollHoldCard(t) {
  const q = t.quote; if (!q?.holdEnabled) return;
  const rows = dollHoldRows(q), group = el('section', 'dollhold-group');
  group.append(el('strong', 'dollhold-heading', `待確認 ${rows.length} / 3`));
  if (rows.length >= 3) { const warning = el('p', 'dollhold-full', DOLL_HOLD_FULL); warning.setAttribute('role', 'status'); group.append(warning); }
  const list = el('div', 'dollhold-list');
  for (const h of rows) {
    const card = el('article', 'dollhold-card'); card.dataset.slot = h.slot; card.setAttribute('aria-label', `待確認娃娃 ${h.slot}`);
    const row = el('div', 'dollhold-product'), text = el('div', '');
    text.append(el('strong', '', h.product.name)); row.append(iconCanvas(h.product, 32), text); card.append(row);
    if (h.status !== 'active') { card.append(el('small', 'poor', '此筆結果需要管理員核對，請勿重送。')); list.append(card); continue; }
    const minutes = Math.max(0, Math.ceil((h.expires - q.serverNow - (performance.now() - (t.holdClock || 0))) / 60000));
    text.append(el('small', '', minutes ? `剩 ${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : '到期確認處理中…'));
    const rr = h.reroll, n = rr?.diamonds || 0, mode = q.rerollMode || q.mode;
    const held = mode === 'sealed' ? q.sealed : mode === 'unsealed' ? q.ordinary : (q.sealed || 0) + (q.ordinary || 0);
    const actions = el('div', 'dollhold-controls'), buttons = el('div', 'dollhold-buttons'), again = el('button', 'ds-again'), done = el('button', 'ds-done', '確定');
    again.type = done.type = 'button'; again.append(iconCanvas({ name: q.diamondName || '品質鑽石' }, 20), el('span', '', `重骰 ×${n}`));
    again.disabled = t.busy || !q.enabled || !rr || held < n || minutes === 0; done.disabled = t.busy;
    again.onclick = () => dollHoldReroll(t, h); done.onclick = () => dollHoldConfirmAsk(t, h);
    buttons.append(again, done); actions.append(buttons, el('small', held < n ? 'poor' : '', `身上可用 ${held || 0} 顆${held < n ? ' · 品質鑽石不足' : ''}`));card.append(actions);list.append(card);
  }
  group.append(list); if (rows.length) group.append(el('small', 'dollhold-delivery-tip', dollHoldTip(q)));
  t.body.append(group);
}
// 11/18 待確認卡按「確定」先確認一次(確定之後就無法再重骰更換)
function dollHoldConfirmAsk(t, h) {
  if (t.busy || t.rerolling || t.confirm || h?.status !== 'active') return;
  const box = t.confirm = el('div', 'dollsynth-confirm'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', '確定娃娃');
  box.append(el('strong', '', `確定要「${h.product?.name || '這隻娃娃'}」嗎？`), el('p', '', '確定之後就無法再重骰更換。'));
  const yes = el('button', 'dollsynth-confirm-yes', '確定'), no = el('button', '', '取消'); yes.type = no.type = 'button';
  const close = () => { box.remove(); t.confirm = null; renderDollSynth(t); };
  no.onclick = close;
  yes.onclick = () => { box.remove(); t.confirm = null; dollHoldConfirm(t, h); };
  box.append(yes, no); t.body.append(box); box.scrollIntoView({ block: 'nearest' }); no.focus();
}
// END REROLLHOLD
// END DOLLSYNTH UI

// BEGIN BOXBATCH
var boxBatch = { quote: null, sheet: null, pending: null, timer: null, seen: new Set(), result: null, queryAt: 0 };
function resetBoxBatch() {
  if (!boxBatch) return;
  clearTimeout(boxBatch.timer); boxBatch.result?.remove(); boxBatch.sheet?.row?.remove();
  boxBatch = { quote: null, sheet: null, pending: null, timer: null, seen: new Set(), result: null, queryAt: 0 };
}
function queryBoxBatch() {
  if (!st.inGame) return;
  const wait = Math.max(0, 1050 - (Date.now() - boxBatch.queryAt));
  clearTimeout(boxBatch.timer);
  boxBatch.timer = setTimeout(() => {
    if (!st.inGame) return;
    boxBatch.queryAt = Date.now(); send({ t: 'boxbatch', op: 0 });
    if (boxBatch.pending) boxBatch.timer = setTimeout(queryBoxBatch, 2500);
  }, wait);
}
function mountBoxBatch(body, it) {
  const host = el('div', 'boxbatch-slot'); body.append(host);
  boxBatch.sheet = { body: host, it, id: st.selfId, n: 2, row: null };
  if (!st.inGame || (it.count || 1) < 2) return;
  // Inventory packets do not carry itemId. Query returns the authoritative object -> item mapping.
  boxBatch.quote = null; queryBoxBatch();
}
function boxBatchLimit(it, q) {
  const bag = q?.bags?.find(b => b.id === it.id);
  const free = Number.isInteger(q?.free) ? Math.max(0, q.free) : Math.max(0, (st.inventoryMax || 180) - st.inv.size);
  return { bag, free, max: Math.max(0, Math.min(it.count || 0, bag?.count || 0, q?.max || 0, free)) };
}
function renderBoxBatch() {
  const t = boxBatch.sheet, q = boxBatch.quote;
  if (!t || t.id !== st.selfId || !st.inGame || !t.body.isConnected || $('#itemsheet').classList.contains('hidden')) return;
  t.row?.remove(); t.row = null;
  const it = st.inv.get(t.it.id), v = boxBatchLimit(it || t.it, q);
  if (!it || it.count < 2 || !q?.enabled || !v.bag || !q.itemIds.includes(v.bag.itemId)) return;
  const row = el('div', 'boxbatch-row'); t.row = row;
  row.append(el('div', 'boxbatch-label', '數量選擇'));
  const controls = el('div', 'boxbatch-controls'), input = el('input', 'boxbatch-number');
  input.type = 'number'; input.inputMode = 'numeric'; input.min = '1'; input.max = String(v.max); input.step = '1'; input.setAttribute('aria-label', '袋子使用數量');
  const button = (label, fn) => { const b = el('button', '', label); b.type = 'button'; b.onclick = fn; return b; };
  const set = n => { t.n = v.max ? Math.max(1, Math.min(v.max, Math.floor(Number(n)) || 1)) : 0; input.value = String(t.n); use.textContent = `使用 ${t.n} 個`; };
  const minus = button('−', () => set(t.n - 1)), plus = button('+', () => set(t.n + 1)), max = button('最大', () => set(v.max));
  const use = button('', () => {
    if (boxBatch.pending || !st.inGame || t.id !== st.selfId) return;
    const latest = st.inv.get(it.id), bound = boxBatchLimit(latest || { count: 0 }, boxBatch.quote);
    set(input.value);
    if (!latest || !boxBatch.quote?.enabled || !boxBatch.quote.token || !bound.bag || bound.bag.locked || isLocked(latest) || t.n < 1 || t.n > bound.max) return;
    const token = boxBatch.quote.token;
    boxBatch.pending = { token, id: it.id, self: st.selfId, requested: t.n };
    renderBoxBatch(); // Set pending before send: a rapid second click cannot submit another batch.
    send({ t: 'boxbatch', op: 1, token, id: it.id, count: t.n });
    clearTimeout(boxBatch.timer); boxBatch.timer = setTimeout(queryBoxBatch, 5000);
  });
  use.className = 'boxbatch-use'; input.onchange = () => set(input.value); set(t.n);
  const disabled = !!boxBatch.pending || !v.max || v.bag.locked || isLocked(it);
  for (const b of [minus, input, plus, max, use]) b.disabled = disabled;
  if (boxBatch.pending) use.textContent = '使用中…';
  controls.append(minus, input, plus, max); row.append(controls, el('small', 'boxbatch-free', `背包剩 ${v.free} 格`), use); t.body.append(row);
}
function onBoxBatch(j) {
  if (!j || !st.inGame) return;
  const p = boxBatch.pending;
  if (j.gateway) {
    if (p && p.self === st.selfId && j.requestToken === p.token) {
      boxBatch.pending = null; boxBatch.quote = null; renderBoxBatch(); toast('操作太快，請稍候再試'); queryBoxBatch();
    }
    return;
  }
  if (j.id !== st.selfId) return;
  boxBatch.quote = j;
  const receipt = j.op === 1 ? j : j.receipt;
  if (p && p.self === st.selfId && receipt?.requestToken === p.token && receipt.objectId === p.id) {
    clearTimeout(boxBatch.timer); boxBatch.pending = null;
    if (!boxBatch.seen.has(p.token)) {
      boxBatch.seen.add(p.token); if (boxBatch.seen.size > 64) boxBatch.seen.delete(boxBatch.seen.values().next().value);
      showBoxBatchResult(receipt);
    }
  } else if (p && j.op === 0 && j.token === p.token) {
    // Ordered query arrived after the action but token was never consumed (e.g. gateway dropped it).
    clearTimeout(boxBatch.timer); boxBatch.pending = null; toast('本次尚未使用，請重新選擇數量');
  }
  renderBoxBatch();
}
function showBoxBatchResult(r) {
  boxBatch.result?.remove();
  const root = el('div', 'boxbatch-overlay'), card = el('section', 'boxbatch-result');
  boxBatch.result = root; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', '袋子使用結果');
  const close = el('button', '', '關閉'); close.type = 'button'; close.onclick = () => { root.remove(); if (boxBatch.result === root) boxBatch.result = null; };
  const reasons = { disabled: '目前未開放', state: '目前狀態無法使用', locked: '袋子已上鎖', count: '袋子數量不足或超過上限', item: '這個道具不能批次使用', unsupported: '這個道具不能批次使用', config: '目前無法使用', open: '開啟未完成，未開的袋子沒有扣除', stale: '資料已更新，請重新選擇', cooldown: '操作太快，請稍候再試', review: '開啟途中發生異常，請聯絡管理員確認' };
  const text = r.reason === 'full' ? `背包滿了，只開了 ${r.opened} 個，剩下 ${Math.max(0, r.requested - r.opened)} 個沒動` : r.reason === 'ok' ? `已使用 ${r.opened} 個袋子` : `${reasons[r.reason] || '本次未完成'}（已開 ${r.opened} 個）`;
  card.append(el('h3', '', '袋子使用結果'), el('p', '', text));
  for (const i of r.products || []) { const row = el('div', 'boxbatch-product'); row.append(iconCanvas(i, 36), el('span', '', `${i.name} × ${i.count}`)); card.append(row); }
  card.append(el('small', '', `袋子剩 ${r.remaining} 個`), close); root.append(card); document.body.append(root); close.focus();
  root.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); close.click(); } else if (e.key === 'Tab') { e.preventDefault(); close.focus(); } };
}
// END BOXBATCH
