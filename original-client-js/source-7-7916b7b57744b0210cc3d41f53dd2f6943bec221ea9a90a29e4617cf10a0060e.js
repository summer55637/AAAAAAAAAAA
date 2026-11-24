'use strict';
// Original procedural royal sword; immutable content-hash filenames.
const RoyalFX = (() => {
 const M = {"A": {"sheet": "royal-A-87a7310b108d.png", "icon": "icon-A-ce6733d4848f.png", "frames": 14, "frameMs": 50, "width": 192, "height": 224, "anchor": [96, 196], "blend": "lighter", "impactMs": 250}, "B": {"sheet": "royal-B-6e6ade68c11e.png", "icon": "icon-B-bedbb5427b17.png", "frames": 14, "frameMs": 50, "width": 192, "height": 224, "anchor": [96, 196], "blend": "lighter", "impactMs": 250}, "C": {"sheet": "royal-C-b15db87cea89.png", "icon": "icon-C-14c39eaa8978.png", "frames": 14, "frameMs": 50, "width": 192, "height": 224, "anchor": [96, 196], "blend": "lighter", "impactMs": 250}}, images = new Map();
 const enabled = () => window.ROYAL_SWORD_FX_ENABLED !== false;
 const variant = () => window.ROYAL_SWORD_FX_TEST === true && M[window.ROYAL_SWORD_FX] ? window.ROYAL_SWORD_FX : 'B'; // 11/22 使用者:「用B版」
 const image = name => { if (!images.has(name)) { const im=new Image(); if(name.startsWith('icon-')) im.addEventListener('load',()=>{if(typeof renderHotbar==='function')renderHotbar();},{once:true}); im.src='assets/royalsword-fx/'+name; images.set(name,im); } return images.get(name); };
 const active = gfx => enabled() && +gfx === 60001;
 function info() {const im=image(M[variant()].sheet); return im.complete && im.naturalWidth ? {dur:700,hit:250,impact:0} : null;}
 function draw(ctx,x,y,t,tag) {
  const m=M[tag?.royalVariant || variant()], im=image(m.sheet); if(!im.complete || !im.naturalWidth)return false;
  const i=Math.max(0,Math.min(13,Math.floor(t/50)));
  ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.imageSmoothingEnabled=false;
  ctx.drawImage(im,(i%7)*192,Math.floor(i/7)*224,192,224,x-96,y-196,192,224); ctx.restore(); return true;
 }
 function named(ctx,x,y,size) { const im=image(M[variant()].icon); if(!im.naturalWidth) return false; ctx.drawImage(im,x,y,size,size); return true; }
 function icon(canvas) { const im=image(M[variant()].icon); const paint=()=>{if(im.naturalWidth)canvas.getContext('2d').drawImage(im,0,0,canvas.width,canvas.height);}; if(im.complete)paint();else im.addEventListener('load',paint,{once:true}); }
 if(enabled()) { image(M.B.sheet); image(M.B.icon); }
 return {active,info,draw,icon,named,variant,enabled};
})();
// 天堂客戶端動畫(tools/build_client_sprites.py 匯出到 assets/spr/):8 方向、走路 / 攻擊 / 待機 / 死亡。
// 沒有這個外型時回傳 0,呼叫端改用 Flare 素材。
'use strict';

const L1S = (() => {
  const BASE = 'assets/spr/';
  const VER = '?v=7'; // 圖集圖片版本 // 重建圖集時改這個
  const JVER = '?v=8'; // 動作資料(json)版本:只改 json 時改這個,圖片不用重抓
  // 版本由 gateway 依檔案修改時間給(index.html 內嵌的 window.AV);沒有時才用上面的固定版本
  const AVT = window.AV || {};
  const gv = (gfx) => (AVT.spr?.[gfx] ? `?v=${AVT.spr[gfx]}` : null);
  const mv = (f, fb) => (AVT.meta?.[`spr/${f}`] ? `?v=${AVT.meta[`spr/${f}`]}` : fb);
  const TICK = 40; // list.spr 的幀長度單位(毫秒)
  // 天堂方向 0..7 的格子位移(L1J HEADING_TABLE)
  const HX = [0, 1, 1, 1, 0, -1, -1, -1];
  const HY = [-1, -1, 0, 1, 1, 1, 0, -1];
  const sprites = {}; // gfx -> { ready, imgs, meta, height }
  // ImageBitmap 預算(使用者 / 主導 10/20:低階 Android 看大型外型會卡):用 createImageBitmap 載入的大圖集解碼後常駐記憶體(飛龍 28MB、有的外型 300MB 以上),
  // 以前完全不回收,玩久了看過的外型越積越多。這裡設預算:超過時,把「最久沒畫」的外型整個丟掉(close() 釋放),下次要畫再從 HTTP 快取重載(載入期間照原本行為先不畫)。
  // 保護:最近 KEEP_MS 內「畫過」的外型(畫面上的)不會被丟(只有真的畫才更新 last;hasAction / hitFrac 等查詢不算);單一外型就超過預算、而且正在用,就讓它超過(只丟別人)。
  // 發光層(glowImage)的畫布也算進該外型的用量。沒超過預算時完全不動作。
  const BUDGET_NORMAL = 150 * 1048576;
  const BUDGET_FLOW = 100 * 1048576;
  let FLOW = false; // 流暢模式(下面 setFlow)
  try { FLOW = localStorage.getItem('l1j.flow') === '1'; } catch { /* 無痕模式 */ }
  const MOBILE_DEV = (() => { try { if (window.matchMedia && matchMedia('(pointer: coarse)').matches) return true; } catch (e) { /* */ } const ua = navigator.userAgent || ''; return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); })(); // 手機 / 平板(主要指標是觸控,或 UA 是 Android / iOS / iPadOS);電腦直接開遊戲網址、桌機框都算桌機
  const MOBILE_S50 = new Set(['7558']); // 手機 / 平板對這些大型 BOSS 外型(安塔瑞斯 7558;之後的大型 BOSS 加編號)一律用 0.5 倍圖(原版解碼約 370 MB 會被系統回收);桌機照規則
  const LOWMEM = (navigator.deviceMemory || 8) <= 4; // 低記憶體裝置(瀏覽器回報 <= 4 GB):大型外型預設用 0.5 倍圖、圖集上限用流暢模式的
  const budget = () => (FLOW || LOWMEM ? BUDGET_FLOW : BUDGET_NORMAL);
  const KEEP_MS = 10000;
  let bitmapBytes = 0;
  let evictions = 0;
  const evictedAt = new Map(); // 外型 -> 被淘汰的時間
  function evictBitmaps() {
    if (bitmapBytes <= budget()) return;
    const now = performance.now();
    const cand = Object.entries(sprites).filter(([, s]) => s.ready && s.bytes && now - (s.last || 0) > KEEP_MS).sort((a, b) => (a[1].last || 0) - (b[1].last || 0));
    for (const [g, s] of cand) {
      if (bitmapBytes <= budget()) break;
      delete sprites[g]; // 之後的 sprite(g) 會重新載入;這幾格先不畫
      bitmapBytes -= s.bytes;
      evictions++;
      evictedAt.set(String(g), now);
      s.ready = false;
      s.glow = null;
      const imgs = s.imgs;
      setTimeout(() => { for (const im of imgs) { try { if (im && im.close) im.close(); } catch { /* 已經關了 */ } } }, 1500); // 晚一點才 close:畫過的指令可能還沒光柵化完
    }
  }
  setInterval(evictBitmaps, 5000);
  // 解碼量大的外型(飛龍、墮落…)重新切成每頁 ≤ 2048×2048 放在 assets/sprs/(tools/repack_spr.py);sprs/index.json 列出有哪些外型,沒有 / 抓失敗 = 全部用原本的 spr/
  // index.json 是 { "外型": "內容雜湊" }(repack_spr.py 產生);它自己不帶 ?v=(gateway 回 no-cache,只多一個 304),外型檔用雜湊當版本,改圖 / 擴充清單玩家都拿得到新的
  let sprsSet = new Map();
  fetch('assets/sprs/index.json').then((r) => (r.ok ? r.json() : {})).then((l) => { sprsSet = new Map(Object.entries(l)); }).catch(() => {});
  const sprsHash = (gfx) => sprsSet.get(String(gfx));
  // index.json 的值以 s75- 開頭 = 0.75 倍縮小版圖集(tools/scale_spr.py),放在 assets/sprs75/;舊版 l1spr.js 讀到這種值仍會去 assets/sprs/ 拿原尺寸版(兩邊檔案都在,舊分頁不會壞)
  // 流暢模式:大型外型改用 0.5 倍縮小版(assets/sprs50/,tools/scale50.py);index.json 是 { 外型: 內容雜湊 },只有開流暢模式才抓
  let s50 = new Map();
  const is50 = (gfx) => (FLOW || LOWMEM || (MOBILE_DEV && MOBILE_S50.has(String(gfx)))) && s50.has(String(gfx));
  const loadS50 = () => fetch('assets/sprs50/index.json').then((r) => (r.ok ? r.json() : {})).then((l) => { s50 = new Map(Object.entries(l)); syncVariants(); }).catch(() => {});
  if (FLOW || LOWMEM || MOBILE_DEV) loadS50();
  const baseOf0 = (gfx) => (sprsHash(gfx) ? (String(sprsHash(gfx)).startsWith('s75-') ? 'assets/sprs75/' : 'assets/sprs/') : BASE);
  const baseOf = (gfx) => (is50(gfx) ? 'assets/sprs50/' : baseOf0(gfx));
  const verOf0 = (gfx, fb) => (sprsHash(gfx) ? `?v=${sprsHash(gfx)}` : (gv(gfx) ?? fb));
  const verOf = (gfx, fb) => (is50(gfx) ? `?v=${s50.get(String(gfx))}` : verOf0(gfx, fb));
  let index = null;
  const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  let indexP = null;
  let indexRetryAt = 0;
  // 外型清單:抓失敗的話稍後重抓(以前一次失敗整個 session 所有角色、怪物都畫不出來)
  function loadIndex() {
    if (index || indexP || performance.now() < indexRetryAt) return indexP;
    indexP = getJSON(`${BASE}index.json${mv('index.json', VER)}`).then((list) => { index = new Set(list); })
      .catch(() => { indexRetryAt = performance.now() + 3000; }).finally(() => { indexP = null; });
    return indexP;
  }
  let indexReady = loadIndex();

  // 預先下載用:這個外型要抓的檔案(和實際載入時同一組網址,快取才對得上)
  const urlMemo = new Map(); // 外型 -> Promise<網址>(預先下載每換一個區塊都會問,不用每次重新下載 + 解析 json)
  function urls(gfx) {
    let p = urlMemo.get(gfx);
    if (!p) {
      p = (async () => {
        if (!index) await (loadIndex() || indexReady);
        if (!index || !index.has(gfx)) return [];
        const json = `${baseOf(gfx)}${gfx}.json${verOf(gfx, JVER)}`;
        const meta = await getJSON(json);
        return [json, ...[...Array(meta.pages || 1).keys()].map((q) => `${baseOf(gfx)}${gfx}${q ? `-${q}` : ''}.webp${verOf(gfx, VER)}`)];
      })();
      urlMemo.set(gfx, p);
      p.catch(() => { if (urlMemo.get(gfx) === p) urlMemo.delete(gfx); });
    }
    return p;
  }
  // 各地圖的怪物 / NPC 出生點 [[外型, x, y], ...]
  let spawnsP = null;
  const spawns = () => (spawnsP ??= getJSON(`${BASE}spawns.json${mv('spawns.json', VER)}`).catch(() => { setTimeout(() => { spawnsP = null; }, 10000); return {}; }));

  function dropSprite(g, s) {
    delete sprites[g];
    if (s.bytes) bitmapBytes -= s.bytes;
    s.ready = false;
    s.glow = null;
    const imgs = s.imgs || [];
    setTimeout(() => { for (const im of imgs) { try { if (im && im.close) im.close(); } catch { /* 已經關了 */ } } }, 1500);
  }
  // 流暢模式切換 / sprs50 清單晚到:已載入、版本和現在要的不一樣的外型丟掉(下次畫時重載,期間先不畫)
  function syncVariants() {
    for (const [g, s] of Object.entries(sprites)) if (s.ready && s.v50 !== is50(g)) dropSprite(g, s);
  }
  function setFlow(on) {
    FLOW = !!on;
    try { localStorage.setItem('l1j.flow', FLOW ? '1' : '0'); } catch { /* 無痕模式 */ }
    urlMemo.clear();
    if (FLOW && !s50.size) loadS50();
    syncVariants();
    evictBitmaps();
  }
  function sprite(gfx, query) {
    if (!index) loadIndex();
    if (!index || !index.has(gfx)) return null;
    let s = sprites[gfx];
    if (s && s.ready && s.v50 !== is50(gfx)) { dropSprite(gfx, s); s = null; } // 流暢模式切換過:版本不對,重新載入
    if (!s && query && evictedAt.has(String(gfx)) && performance.now() - evictedAt.get(String(gfx)) < 60000) return null;
    if (s && s.failed && performance.now() >= s.retryAt) { delete sprites[gfx]; s = null; } // 抓失敗:時間到再抓
    if (!s) {
      const tries = (sprite.tries[gfx] || 0);
      s = sprites[gfx] = { ready: false, v50: is50(gfx) };
      setTimeout(evictBitmaps, 0);
      const loadEl = (src) => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
      // 大圖集(飛龍 3 頁解碼後 68MB):<img> 要等第一次 drawImage 才在主執行緒同步解碼(手機上會卡),手機瀏覽器解碼快取小時還可能被驅逐、每次重畫都重解碼。
      // 改用 createImageBitmap:在背景執行緒解碼好,之後 drawImage 直接用;不支援 / 失敗就退回原本的 <img>。
      // 只用在 sprs 清單裡的大圖集外型:ImageBitmap 解碼後一直佔記憶體、不會被瀏覽器丟掉(沒有回收),全部外型都用的話看過的外型會越積越多;一般外型維持 <img>(記憶體吃緊時瀏覽器可以丟掉再解)
      const loadImg = (src) => (useBitmap && typeof createImageBitmap === 'function'
        ? fetch(src).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then((bl) => createImageBitmap(bl)).catch(() => loadEl(src))
        : loadEl(src));
      const base = baseOf(gfx), ver = (fb) => verOf(gfx, fb), useBitmap = !!sprsHash(gfx) || is50(gfx); // 這次載入用哪個目錄固定下來(index.json 晚到也不會半套)
      fetch(`${base}${gfx}.json${ver(JVER)}`).then((r) => r.json())
        // 圖集太大時分成好幾頁:<gfx>.webp、<gfx>-1.webp …
        .then((meta) => Promise.all([...Array(meta.pages || 1).keys()].map((p) => loadImg(`${base}${gfx}${p ? `-${p}` : ''}.webp${ver(VER)}`)))
          .then((imgs) => {
            const bytes = useBitmap ? imgs.reduce((t, im) => t + (im.width || 0) * (im.height || 0) * 4, 0) : 0;
            Object.assign(s, { imgs, meta, ready: true, bytes, last: performance.now() });
            if (bytes) { bitmapBytes += bytes; setTimeout(evictBitmaps, 0); }
            delete sprite.tries[gfx];
          }))
        .catch(() => { sprite.tries[gfx] = tries + 1; s.failed = true; s.retryAt = performance.now() + Math.min(30000, 1000 * 2 ** tries); });
    }
    return s.ready ? s : null;
  }
  sprite.tries = {};

  // 待機動作(拿這把武器的,沒有就空手的);都沒有回傳 null
  // 主導 11/05:玩家變身成「既沒有這把武器、也沒有空手動作」的外型(例:銀光巡守 3145 只有拿弓的動作)時,借用它有的那一組,免得角色整個看不見;只套玩家,怪物照舊
  const ANY_BASES = [20, 4, 50, 24, 40, 46, 54, 58, 62, 11, 83];
  function anyAct(a, off) { for (const b of ANY_BASES) if (a[b + off]) return a[b + off]; return null; }
  function breathAct(meta, o) {
    const w = o.kind === 'pc' ? o.weapon || 0 : 0;
    return meta.actions[w + 3] || meta.actions[3] || (o.kind === 'pc' ? anyAct(meta.actions, 3) : null);
  }

  // 武器動作:伺服器送的武器值就是走路動作編號(0 空手、4 單手劍、11 斧、20 弓…),攻擊 +1、受傷 +2、待機 +3
  function pick(meta, o, kind) {
    const a = meta.actions;
    const w = o.kind === 'pc' ? o.weapon || 0 : 0;
    const off = { walk: 0, attack: 1, breath: 3 }[kind];
    const id = w + off;
    if (a[id]) return a[id];
    if (a[off]) return a[off];
    if (o.kind === 'pc') { const any = anyAct(a, off); if (any) return any; }
    return kind === 'walk' ? null : a[0];
  }

  // 施法動作的時間重排(對照原版錄影):舉手慢慢舉到 SPELL_RELEASE(72%)才推出去放魔法,之後收手比較快。
  // list.spr 標的出手幀(!)在動作裡的位置各外型不同(法師大約 30%),這裡把 ! 之前的幀拉長、之後的縮短。
  const SPELL_RELEASE = 0.72;
  function spellTime(act, t, total) {
    const h = act[2];
    if (h == null || !total) return t;
    const r = SPELL_RELEASE;
    const u = t / total; // 0..1
    const v = u < r ? (u / r) * h : h + ((u - r) / (1 - r)) * (1 - h);
    return v * total;
  }

  // 受傷動作:武器動作編號 + 2(沒拿武器的 2);沒有就回傳 null(不播,不要退回走路圖)
  function damageAct(a, o) {
    const w = o.kind === 'pc' ? o.weapon || 0 : 0;
    return a[w + 2] || a[2] || null;
  }
  // 玩家職業(沒變身)的硬直照參考表(altsettings PlayerStunTable,網頁 st.playerStun):一律 0.50 秒,
  // 拿匕首時 王子、女騎士、女妖精、男法師、黑暗精靈 0.63 秒
  // 變身卷軸也照參考表:死亡騎士 0.33 秒(匕首 0.42)、黑暗精靈 0.33 秒。外型 → [一般, 拿匕首](毫秒);伺服器 L1HitStun 同一份
  const STUN = { 3784: [330, 420], 2284: [330, 330] };
  for (const g of [0, 1, 61, 48, 138, 37, 734, 1186, 2786, 2796, 6658, 6661, 6671, 6650]) STUN[g] = [500, [0, 48, 37, 734, 2786, 2796].includes(g) ? 630 : 500];
  // 受傷動作長度(毫秒);外型還沒載入或沒有受傷動作回傳 0
  function damageMs(o) {
    if (typeof st !== 'undefined' && st.playerStun && st.shana && o.id === st.selfId) return o.weapon === 46 ? 540 : 450; // 夏娜的卷軸(伺服器 L1Shana.stunMs)
    if (typeof st !== 'undefined' && st.playerStun && o.kind === 'pc' && STUN[o.gfx]) return STUN[o.gfx][o.weapon === 46 ? 1 : 0];
    const s = sprite(o.gfx, true);
    const act = s && damageAct(s.meta.actions, o);
    return act ? act[1].reduce((t, f) => t + (f[2] || 1), 0) * TICK : 0;
  }

  // 依經過時間挑幀;stretch 時整個動作剛好播完 total 毫秒
  function frameAt(frames, elapsed, { loop = true, total = 0 } = {}) {
    const lens = frames.map((f) => f[2] || 1);
    const sum = lens.reduce((a, b) => a + b, 0);
    const scale = total > 0 ? total / (sum * TICK) : 1;
    let t = Math.max(0, elapsed) / (TICK * scale);
    if (loop) t %= sum;
    for (let i = 0; i < frames.length; i++) {
      if (t < lens[i]) return frames[i];
      t -= lens[i];
    }
    return frames[frames.length - 1];
  }

  // 有些外型只做了部分方向(例如木頭人只有 4 個),缺的方向用相近的代替
  function cellOf(s, act, f, heading) {
    const cells = s.meta.cells;
    if (!act[0]) return cells[`${f[0]}.${f[1]}`];
    for (const d of [heading, heading & 3, 0]) {
      const c = cells[`${f[0] + d}.${f[1]}`];
      if (c) return c;
    }
    return null;
  }

  // 名稱標籤的高度:用待機第一幀,避免動作時跳動
  function heightOf(s, o) {
    if (s.height == null) {
      const act = pick(s.meta, o, 'breath') || pick(s.meta, o, 'walk');
      const c = act && cellOf(s, act, act[1][0], 5);
      s.height = c ? Math.max(24, -c[6]) : 48;
    }
    return s.height;
  }

  // (x, y) 為格子中心;成功回傳圖高,沒有這個外型或還沒載入回傳 0
  // Rule queries (walkProgress/hitFrac/damageMs) always keep the actual o.gfx.
  // Freeze the chosen sprite for one action, including while its image is downloading.
  function visual(o, now) {
    if (o.kind !== 'pc' || !o.skin) { o.skinPose = null; return sprite(o.gfx); }
    const key = o.dead ? `d:${o.deadAt}:${o.skin}` : o.anim ||
      (o.lunge && now - o.lunge < (o.lungeMs || 600) ? `a:${o.lunge}` :
        (o.hurt && now - o.hurt < (o.hurtMs || 0) ? `h:${o.hurt}` : null));
    if (!o.skinPose || o.skinPose.key !== key || key === null) {
      o.skinPose = { key, gfx: o.skin, hit: hitFrac(o) };
    }
    return sprite(o.skinPose.gfx) || sprite(o.gfx);
  }

  function attackTime(act, elapsed, total, release) {
    if (act[2] == null || !total) return elapsed;
    const r = Math.max(0.001, Math.min(0.999, release));
    const u = elapsed / total, h = act[2];
    return (u < r ? u / r * h : h + (u - r) / (1 - r) * (1 - h)) * total;
  }

  // Broken final cells (e.g. 7847 death): keep the nearest existing frame of this action.
  function visualCell(s, act, f, heading, cosmetic) {
    const c = cellOf(s, act, f, heading);
    if (c || !cosmetic) return c;
    const i = act[1].indexOf(f);
    for (let k = i - 1; k >= 0; k--) { const v = cellOf(s, act, act[1][k], heading); if (v) return v; }
    for (let k = i + 1; k < act[1].length; k++) { const v = cellOf(s, act, act[1][k], heading); if (v) return v; }
    return null;
  }

  function describeCreature(o, x, y, now) {
    const out = []; out.height = 0;
    const done = height => { out.height = height; return out; };
    const footX = x;
    const footY = y;
    const s = visual(o, now);
    if (!s) return out;
    const cosmetic = !!(o.kind === 'pc' && o.skin && s === sprites[o.skinPose?.gfx]);
    s.last = performance.now();
    const heading = (o.heading ?? 5) & 7;
    let act;
    let f;
    const a = s.meta.actions;
    if (o.kind === 'door') {
      // 門:狀態就是動作編號(28 開、29 關);火把、鴿群等只有待機動畫
      act = a[o.status] || a[29] || a[3] || a[8] || a[0];
      if (!act) return out;
      // 11/19 主導:門的開 / 關(28 / 29)只播一次、停在最後一格;剛進畫面的門直接顯示最後一格。火把等待機動畫照常循環
      const doorAct = act === a[28] || act === a[29];
      f = doorAct ? (o.statusAt ? frameAt(act[1], now - o.statusAt, { loop: false }) : act[1][act[1].length - 1])
        : frameAt(act[1], now + ((o.id || 0) % 997) * 37);
    } else if (o.dead) {
      act = a[8];
      if (!act) return done(heightOf(s, o)); // 沒有死亡動作就不畫
      // list.spr 死亡動作的第一幀是「已經倒地」的屍體圖(例:24.5 24.0 24.1 …),播動畫時跳過,不然看起來會死兩次
      const fr = act[1];
      const corpse = fr.length > 1 && fr[0][0] === fr[1][0] && fr[0][1] > fr[1][1];
      const realDeath = cosmetic && sprite(o.gfx, true)?.meta.actions[8]?.[1];
      const realCorpse = realDeath && realDeath.length > 1 && realDeath[0][0] === realDeath[1][0] && realDeath[0][1] > realDeath[1][1];
      const total = realDeath ? (realCorpse ? realDeath.slice(1) : realDeath).reduce((n, f) => n + (f[2] || 1), 0) * TICK : 0;
      f = o.deadAt == null ? (corpse ? fr[0] : fr[fr.length - 1]) : frameAt(corpse ? fr.slice(1) : fr, now - o.deadAt, { loop: false, total });
    } else if (!o.anim && o.hurt && now - o.hurt < (o.hurtMs || 0) && !(o.lunge && o.lunge > o.hurt) && damageAct(a, o)) {
      // 被打:受傷動作(硬直);打中時正在出手的話會被打斷(原版也是),之後才又出手的照常播攻擊
      act = damageAct(a, o);
      f = frameAt(act[1], now - o.hurt, { loop: false, total: o.hurtMs });
    } else if (o.lunge && now - o.lunge < (o.lungeMs || 600) && !(o.anim && o.anim.start > o.lunge)) {
      act = (o.lungeAct != null && a[o.lungeAct]) || pick(s.meta, o, 'attack') || breathAct(s.meta, o);
      if (!act) return done(heightOf(s, o));
      const spell = o.lungeAct === 18 || o.lungeAct === 19;
      f = frameAt(act[1], spell ? spellTime(act, now - o.lunge, o.lungeMs) : cosmetic ? attackTime(act, now - o.lunge, o.lungeMs, o.skinPose.hit) : now - o.lunge, { loop: false, total: o.lungeMs });
    } else if (o.anim || (o.walkUntil && now < o.walkUntil)) {
      act = pick(s.meta, o, 'walk') || pick(s.meta, o, 'breath');
      if (o.anim) {
        o.walkUntil = now + 120; // 連續走路時,兩步之間不要閃回待機
        f = frameAt(act[1], now - o.anim.start, { loop: false, total: o.anim.dur });
        // 原版走路圖自己帶著位移:第 k 幀(共 n 幀)已經往目的地移了 k/n 格。
        // 位置(px, py)也照 walkProgress 走了 k/n 格,把圖裡的位移扣掉,不然會走兩倍遠再彈回來(看起來像在跳)
        const k = act[1].indexOf(f);
        const n = act[1].length;
        const mx = HX[heading];
        const my = HY[heading];
        x -= ((mx + my) * 24 * k) / n;
        y -= ((my - mx) * 12 * k) / n;
      } else f = act[1][0]; // 兩步之間:第 0 幀沒有位移
    } else {
      // 沒有待機動作的外型(例如黑暗精靈變身空手):停在走路的第一幀,不要原地播走路(看起來會抖)
      const br = breathAct(s.meta, o);
      act = br || pick(s.meta, o, 'walk');
      if (!act) return out;
      // 每個物件錯開起始時間,避免整群同步呼吸
      f = br ? frameAt(act[1], now + ((o.id || 0) % 997) * 37) : act[1][0];
    }
    if (typeof SFX !== 'undefined') SFX.frame(o, cosmetic ? o.skinPose.gfx : o.gfx, a, act, f); // 這一幀有標音效就播(sound.js)
    const c = visualCell(s, act, f, heading, cosmetic);
    if (!c) return done(heightOf(s, o));
    const [page, sx, sy, w, h, dx, dy, sw = w, sh = h] = c; // 後兩個:縮小過的圖集(meta 的 scale)裡的實際尺寸,w / h 仍是畫在畫面上的原尺寸
    if (!o.dead) out.shadow = [footX, footY, Math.min(20, w * 0.35), 6];
    out.quality = FLOW ? 'low' : 'high';
    out.push({ img: s.imgs[page], cell: [sx, sy, sw, sh], dx: Math.round(x + dx), dy: Math.round(y + dy),
      scale: [w / sw, h / sh], width: w, height: h, blend: s.meta.attr & 8 ? 'lighter' : 'source-over', alpha: 1 });
    for (const lg of s.meta.clothes || []) {
      const ls = sprite(lg);
      if (!ls) continue;
      ls.last = performance.now();
      const c = cellOf(ls, act, f, heading);
      if (!c) continue;
      const [page, sx, sy, w, h, dx, dy, sw = w, sh = h] = c;
      const glow = ls.meta.attr & 8;
      out.push({ img: glow ? glowImage(ls, page) : ls.imgs[page], cell: [sx, sy, sw, sh],
        dx: Math.round(x + dx), dy: Math.round(y + dy), scale: [w / sw, h / sh], width: w, height: h,
        blend: glow ? 'lighter' : 'source-over', alpha: 1, clothes: true });
    }
    return done(heightOf(s, o));
  }

  // Descriptions own frame selection and SFX. Both consumers paint these exact results.
  function paintCreature(ctx, layers) {
    if (layers.shadow) {
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(...layers.shadow, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (layers.length) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = layers.quality;
    }
    for (const d of layers) {
      const [sx, sy, sw, sh] = d.cell;
      const saved = d.clothes || d.blend === 'lighter';
      if (saved) ctx.save();
      try {
        if (d.blend === 'lighter') ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(d.img, sx, sy, sw, sh, d.dx, d.dy, d.width, d.height);
      } finally { if (saved) ctx.restore(); }
    }
    return layers.height;
  }

  function drawCreature(ctx, o, x, y, now) {
    return paintCreature(ctx, describeCreature(o, x, y, now));
  }

  // 發光圖層:亮度轉成透明度(只做一次)
  function glowImage(ls, page) {
    ls.glow ??= [];
    if (ls.glow[page]) return ls.glow[page];
    const img = ls.imgs[page];
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    if (!g) return (ls.glow[page] = img); // 畫布配置失敗(iOS 大圖):直接用原圖,不要每一格丟錯
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const m = Math.max(p[i], p[i + 1], p[i + 2]);
      p[i + 3] = Math.min(p[i + 3], m);
    }
    g.putImageData(d, 0, 0);
    if (ls.bytes) { const gb = c.width * c.height * 4; ls.bytes += gb; bitmapBytes += gb; } // 發光層畫布也佔記憶體,跟著這個外型一起算 / 一起丟
    return (ls.glow[page] = c);
  }

  // 覆蓋層(list.spr 105.clothes):同一幀疊在主圖上面,例如死亡騎士的劍(3784 → 242)
  function drawClothes(ctx, s, act, f, heading, at, k) {
    for (const lg of s.meta.clothes || []) {
      const ls = sprite(lg);
      if (!ls) continue;
      ls.last = performance.now();
      const c = cellOf(ls, act, f, heading);
      if (!c) continue;
      const [page, sx, sy, w, h, dx, dy, sw = w, sh = h] = c; // 後兩個:縮小過的圖集(meta 的 scale)裡的實際尺寸,w / h 仍是畫在畫面上的原尺寸
      const [px, py] = at(dx, dy);
      ctx.save();
      try {
        // 發光層(attr 8):原版是加亮混合,黑色等於透明。先把黑色轉成透明(亮度當透明度),
        // 遊戲畫面和透明底的角色面板看起來都一樣
        const glow = ls.meta.attr & 8;
        if (glow) ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glow ? glowImage(ls, page) : ls.imgs[page], sx, sy, sw, sh, px, py, w * k, h * k);
      } finally { ctx.restore(); }
    }
  }

  // 頭像 / 角色面板:待機第一幀(面向 5 = 正前方偏左下),高度縮放到 height
  // now:有給就播待機動畫(角色面板);沒給就畫第一幀(頭像)
  function drawFigure(ctx, o, cx, footY, height, now) {
    const s = (o.kind === 'pc' && o.skin ? sprite(o.skin) : null) || sprite(o.gfx);
    if (!s) return false;
    s.last = performance.now();
    const br = breathAct(s.meta, o);
    const act = br || pick(s.meta, o, 'walk');
    const f = act && (now != null && br ? frameAt(act[1], now) : act[1][0]);
    const c = act && cellOf(s, act, f, 5);
    if (!c) return false;
    const [page, sx, sy, w, h, dx, dy, sw = w, sh = h] = c; // 後兩個:縮小過的圖集(meta 的 scale)裡的實際尺寸,w / h 仍是畫在畫面上的原尺寸
    const k = height / heightOf(s, o);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(s.imgs[page], sx, sy, sw, sh, cx + dx * k, footY + dy * k, w * k, h * k);
    drawClothes(ctx, s, act, f, 5, (cdx, cdy) => [cx + cdx * k, footY + cdy * k], k);
    return true;
  }

  // 走路進度:原版是一格格踩的,4 張圖各往前 1/4 格。回傳目前這張是第幾張 / 共幾張(k / n),
  // 呼叫端用它決定位置,畫面和鏡頭就跟原版一樣一步步走;沒有這個外型回傳 null(改用平滑移動)
  function walkProgress(o, now) {
    const s = sprite(o.gfx, true);
    if (!s || !o.anim) return null;
    const act = pick(s.meta, o, 'walk');
    if (!act) return null;
    const f = frameAt(act[1], now - o.anim.start, { loop: false, total: o.anim.dur });
    return act[1].indexOf(f) / act[1].length;
  }

  // ---- 特效(魔法、藥水、箭):動作 0 播一輪 ----
  // 比原圖小一點、慢一點(實際看起來比較接近原版的感覺)
  const FX_SCALE = 0.8;
  const FX_TICK = 60;
  // 特效的幀順序:list.spr 把「最後一格」(淡掉的殘影)寫在最前面,例 0.fire(0 9,0.8:5 0.0:4 … 0.7:5)
  // → 移到最後播;殘影停留太久的(地裂術 240)最多留 20 格
  const FX_TAIL_MAX = 20;
  function effectAct(s) {
    if (s.fxAct !== undefined) return s.fxAct;
    const a = s.meta.actions;
    const raw = a[0] || a[Object.keys(a)[0]];
    if (!raw) return (s.fxAct = null);
    // 音效表用原本的動作編號、原本的幀序號(下面殘影搬到最後會改順序):記下對照
    s.fxActId = a[0] ? 0 : +Object.keys(a)[0];
    s.fxIdx = null;
    let frames = raw[1];
    const total = frames.reduce((t, f) => t + (f[2] || 1), 0);
    let hitTicks = raw[2] != null ? raw[2] * total : null; // list.spr 標 ! 的那一格(命中的瞬間)
    if (frames.length > 2 && frames[1][1] === 0 && frames[0][1] === Math.max(...frames.map((f) => f[1])) && frames[0][1] === frames.length - 1) {
      const [tail, ...rest] = frames;
      frames = [...rest, [tail[0], tail[1], Math.min(tail[2] || 1, FX_TAIL_MAX)]];
      s.fxIdx = [...rest.map((_, i) => i + 1), 0]; // 新的第 i 幀 = 原本的第 fxIdx[i] 幀
      if (hitTicks != null) hitTicks = Math.max(0, hitTicks - (tail[2] || 1)); // 殘影搬到最後,命中點往前移
    }
    s.fxHit = hitTicks != null ? hitTicks * FX_TICK : 0;
    return (s.fxAct = [raw[0], frames]);
  }
  // 特效資訊:{ dur 一輪的毫秒數, impact 命中後的特效 };還沒載入回傳 null(會開始載入),沒有這個特效回傳 false
  function effectInfo(gfx) {
    if (RoyalFX.active(gfx)) return RoyalFX.info();
    if (!index) return null;
    if (!index.has(gfx)) return false;
    const s = sprite(gfx);
    if (!s) return null;
    const act = effectAct(s);
    if (!act) return false;
    return { dur: act[1].reduce((t, f) => t + (f[2] || 1), 0) * FX_TICK, impact: s.meta.impact || 0, hit: s.fxHit || 0 };
  }
  // loop:飛行中循環播放;否則播完停在最後一張(呼叫端依 dur 移除)
  // tag:這個特效自己的狀態物件(音效記錄播到哪一幀;位置 x, y / follow / to 用來算遠近)
  function drawEffect(ctx, gfx, x, y, elapsed, heading = 5, loop = false, tag = null) {
    if (RoyalFX.active(gfx)) return RoyalFX.draw(ctx,x,y,elapsed,tag);
    const s = sprite(gfx);
    if (!s) return false;
    s.last = performance.now();
    const act = effectAct(s);
    if (!act) return false;
    const f = frameAt(act[1], (elapsed * TICK) / FX_TICK, { loop });
    if (tag && typeof SFX !== 'undefined') SFX.frame(tag, gfx, s.meta.actions, act, f, s.fxActId, s.fxIdx);
    // 影子層 → 主圖 → 覆蓋層(list.spr 101.shadow / 105.clothes),都用主圖這一幀
    const layers = [[s.meta.shadow, 'shadow'], [gfx, 'main'], ...(s.meta.clothes || []).map((g) => [g, 'clothes'])];
    let drew = false;
    for (const [lg, role] of layers) {
      if (!lg) continue;
      const ls = lg === gfx ? s : sprite(lg);
      if (!ls) continue;
      ls.last = performance.now();
      const c = cellOf(ls, act, f, heading & 7);
      if (!c) continue;
      const [page, sx, sy, w, h, dx, dy, sw = w, sh = h] = c; // 後兩個:縮小過的圖集(meta 的 scale)裡的實際尺寸,w / h 仍是畫在畫面上的原尺寸
      ctx.save();
      // list.spr 的 attr 8:發光疊加。原版用加亮混合畫,黑色部分等於透明,只留下亮光
      if (ls.meta.attr & 8) ctx.globalCompositeOperation = 'lighter';
      else if (role === 'shadow') ctx.globalAlpha = 0.5;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(ls.imgs[page], sx, sy, sw, sh, x + dx * FX_SCALE, y + dy * FX_SCALE, w * FX_SCALE, h * FX_SCALE);
      ctx.restore();
      drew = true;
    }
    return drew;
  }

  const ready = () => !!index;
  // 正在播的攻擊 / 施法動作裡「出手」那一刻佔整個動作的比例(list.spr 標 ! 的幀:箭射出、手往前推放出魔法)
  function hitFrac(o) {
    if (o.lungeAct === 18 || o.lungeAct === 19) return SPELL_RELEASE; // 施法:放出的時間固定在原版的位置(見 spellTime)
    const s = sprite(o.gfx, true);
    if (!s) return 0.6;
    const act = (o.lungeAct != null && s.meta.actions[o.lungeAct]) || pick(s.meta, o, 'attack');
    return act?.[2] ?? 0.6;
  }

  // 這個外型有天堂原圖(清單還沒載入時也當作有,先不要畫替代圖)
  const known = (gfx) => !index || index.has(gfx);

  // 這個外型有沒有這個動作(外型還沒載入回傳 null)
  const hasAction = (gfx, act) => { const s = sprite(gfx, true); return s ? !!s.meta.actions[act] : null; };

  return { hasAction, known, hitFrac, damageMs, describeCreature, paintCreature, drawCreature, drawFigure, walkProgress, effectInfo, drawEffect, ready, has: (gfx) => !!index?.has(gfx), urls, spawns,
    setFlow, flow: () => FLOW,
    stats: () => ({ bitmapMB: +(bitmapBytes / 1048576).toFixed(1), budgetMB: budget() / 1048576, flow: FLOW, loaded: Object.values(sprites).filter((v) => v.ready).length, evictions }) };
})();
