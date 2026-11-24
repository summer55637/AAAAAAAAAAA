// 天堂客戶端地圖(tools/build_client_maps.py 匯出到 assets/map/):地面 + 物件。
// 每個區塊 64x64 格,只載入畫面附近的區塊;沒有這張地圖時 ready() 回傳 false,呼叫端改用舊的地形。
'use strict';

const L1MAP = (() => {
  const BASE = 'assets/map/';
  const VER = '?v=3'; // 區塊(seg/<雜湊>)版本:檔名是來源雜湊,只有改了畫法、整批重建時才改這個
  // 每張地圖的區塊表與小地圖:版本由 gateway 依檔案修改時間給(window.AV.map)
  const mapVer = (k) => (window.AV?.map?.[k] ? `?v=${window.AV.map[k]}` : VER);
  const SEG = 64;
  // 新格式(tools/build_tile_maps.py → assets/tmap/):下載地磚圖集 + 每格的地磚編號,在網頁上拼出地面和物件
  // (舊格式是預先拼好的大圖,一個區塊約 0.8 MB;新格式約 10 KB + 共用的圖集)。沒有新格式的地圖退回舊的
  const TBASE = 'assets/tmap/';
  const TVER = `?v=${window.AV?.tmap || 't1'}`; // 基準版本(gateway 有 assets/tmap/.vbase 時是固定的基準,沒有就是全部最新 mtime)
  const SEGVER = `${TVER}g3`; // g3: optional second floor layer l, referencing p.
  // g1:seg 多了 "g"(物件編號);g2(10/29):多了 "h"(物件高度):AV.tmap 不看 seg 的修改時間,seg 改格式時換這個尾碼
  // 索引 json / 圖集各自的版本:AV.tmapV[鍵](mtime 比基準新才有;鍵 = 地圖編號 / 'til/<組>')沒有就用基準
  const tver = (key) => `?v=${window.AV?.tmapV?.[key] ?? window.AV?.tmap ?? 't1'}`;
  const maps = {}; // id -> { byPos: Map('區塊 x,區塊 y' -> sha1) } | null(沒有)| undefined(載入中 / 暫時失敗等重抓)
  const segs = new Map(); // 't:<sha1>' / 'o:<sha1>' -> { ready, tile, meta, floor, objs, used, bytes }(兩種格式分開記)
  const KEEP = 14; // 最多保留幾個區塊(舊格式一個解碼後約 30 MB;地磚格式只剩物件圖集約 5~20 MB);手機畫面加外框一次就會用到 4~6 個
  // 另外用位元組限制:物件圖集(2048 寬)最大 21 MB,14 個可以到 250 MB,iOS 舊機的畫布上限只有 224~384 MB
  const BUDGET = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 128 : 256) * 1048576;

  // ---- 下載:檢查 HTTP 狀態;卡住的請求不等了(交給重試);失敗後退避 1 → 2 → 4 … 30 秒再抓 ----
  // 「卡住」= 等超過 30 秒,而且最近 15 秒整個網頁都沒有任何下載完成(慢網路一直有東西在完成就繼續等,不會越重抓越慢)。
  // 逾時只是不等了,不中斷下載:慢慢下載完的檔案會進快取,重抓時直接命中
  const NET_MS = 30000;
  const STALL_MS = 15000;
  let lastDone = 0;
  const backoff = (n) => Math.min(30000, 1000 * 2 ** Math.min(n, 5));
  const netTimeout = (p) => new Promise((res, rej) => {
    const t0 = performance.now();
    let t;
    const check = () => { const now = performance.now(); if (now - t0 >= NET_MS && now - lastDone >= STALL_MS) rej(new Error('timeout')); else t = setTimeout(check, 5000); };
    t = setTimeout(check, NET_MS);
    p.then((v) => { clearTimeout(t); lastDone = performance.now(); res(v); }, (e) => { clearTimeout(t); lastDone = performance.now(); rej(e); });
  });
  function getJSON(url) {
    return netTimeout(fetch(url).then((r) => {
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; } // 502 / 530 的 HTML 錯誤頁不能當成「沒有這個檔」
      return r.json();
    }));
  }
  const loadImg = (src) => netTimeout(new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; }));
  // 先在背景解碼(最多等 3 秒;解碼失敗 / 太久也照用,drawImage 會自己解)
  const decoded = (img) => (img.decode ? Promise.race([img.decode(), new Promise((r) => setTimeout(r, 3000))]).then(() => img, () => img) : img);

  // 某張地圖整張改用另一份圖(座標相同;伺服器的通行資料不變),例 { 0: '0-182' }。
  // 目前全部地圖都已經從老天堂 1.82 客戶端匯出,不需要替換
  const ART_OVERRIDE = {};
  const artOf = (id) => ART_OVERRIDE[id] ?? id;
  const mapLoads = {};
  const idxFail = {}; // id -> { n, at }:區塊表暫時抓不到(斷線、5xx、逾時),at 之後再抓;at = Infinity 表示正在重抓
  function loadMapInfo(id) {
    if (window.NATISHA_OFFLINE === true) {
      if (!(id in mapLoads)) {
        maps[id] = undefined;
        mapLoads[id] = getJSON(`${TBASE}${id}.json${tver(id)}`)
          .then((j) => { maps[id] = { byPos: new Map(Object.entries(j)), t: true }; })
          .catch(() => { maps[id] = null; }); // 沒有同步到本機的地圖索引：改用 app.js 的替代地磚。
      }
      return mapLoads[id];
    }
    const f = idxFail[id];
    if (f && performance.now() >= f.at) { f.at = Infinity; delete mapLoads[id]; } // 上次是暫時失敗:時間到就重抓
    if (!(id in mapLoads)) {
      maps[id] = undefined;
      const old = () => getJSON(`${BASE}${artOf(id)}.json${mapVer(artOf(id))}`).then((j) => { maps[id] = { byPos: new Map(Object.entries(j)) }; });
      mapLoads[id] = getJSON(`${TBASE}${id}.json${tver(id)}`)
        .then((j) => { maps[id] = { byPos: new Map(Object.entries(j)), t: true }; })
        .catch((e) => (e && e.status === 404 ? old() : Promise.reject(e))) // 只有確定「沒有這個檔」(404)才改用舊格式
        .then(() => { delete idxFail[id]; })
        .catch((e) => {
          if (e && e.status === 404) { maps[id] = null; delete idxFail[id]; return; } // 兩種格式都沒有:呼叫端畫替代地形
          const g = idxFail[id] || (idxFail[id] = { n: 0, at: 0 });
          g.n++;
          g.at = performance.now() + backoff(g.n - 1); // 暫時失敗:維持「載入中」(畫面先墊模糊縮圖),稍後重抓,不會整個 session 卡在舊格式
        });
    }
    return mapLoads[id];
  }
  function mapInfo(id) {
    loadMapInfo(id);
    return maps[id];
  }

  // 預先下載用:(x, y) 附近 radius 個區塊內要抓的檔案,近的先;和實際載入時同一組網址
  // segsOnly:圖集已經全部排進背景下載了,只要區塊檔本身,不用再下載 + 解析區塊找圖集
  async function urlsNear(id, x, y, radius, segsOnly = false) {
    await loadMapInfo(id);
    const info = maps[id];
    if (!info) return [];
    const cx = Math.floor(x / SEG);
    const cy = Math.floor(y / SEG);
    const keys = [];
    for (let a = cx - radius; a <= cx + radius; a++) {
      for (let b = cy - radius; b <= cy + radius; b++) {
        const key = info.byPos.get(`${a},${b}`);
        if (key) keys.push([Math.max(Math.abs(a - cx), Math.abs(b - cy)), key]);
      }
    }
    keys.sort((p, q) => p[0] - q[0]);
    const out = []; // 小地圖不在這裡預抓:有縮小版(ov)的地圖用不到它(大陸那張 3.4 MB),沒有縮小版的地圖由 app.js 需要時才抓
    if (info.t) {
      const gs = new Set();
      for (const [, key] of keys) {
        const url = `${TBASE}seg/${key}.json${SEGVER}`;
        out.push(url);
        if (segsOnly) continue;
        const d = await getJSON(url).catch(() => null);
        // 中心區塊的圖集緊跟在它後面,先於鄰近區塊的 seg / 圖集。
        if (d) for (const g of segGroups(d)) {
          if (gs.has(g)) continue;
          gs.add(g);
          out.push(`${TBASE}til/${g}.json${tver('til/' + g)}`, `${TBASE}til/${g}.webp${tver('til/' + g)}`);
        }
      }
      return out;
    }
    for (const [, key] of keys) {
      const json = `${BASE}seg/${key}.json${VER}`;
      const meta = await getJSON(json).catch(() => null);
      if (!meta) continue;
      out.push(json);
      if (meta.floor) out.push(`${BASE}seg/${key}.webp${VER}`);
      if (meta.cells.length) out.push(`${BASE}seg/${key}-o.webp${VER}`);
    }
    return out;
  }

  // ---- 新格式:地磚圖集(每組 .til 一張,載入後一直留著;圖檔解碼由瀏覽器管理) ----
  const groups = new Map(); // 組 -> Promise<{ at, img }>(載入中 / 成功的;失敗的會拿掉,退避時間到再抓)
  const groupData = new Map(); // 組 -> { at, img }(載入成功的;piece() 直接查這裡,晚到的圖集重拼時就畫得出來)
  const groupFail = new Map(); // 組 -> { n, at }
  function group(g) {
    let p = groups.get(g);
    if (p) return p;
    const f = groupFail.get(g);
    if (f && performance.now() < f.at) return Promise.reject(new Error('backoff'));
    p = Promise.all([
      getJSON(`${TBASE}til/${g}.json${tver('til/' + g)}`),
      loadImg(`${TBASE}til/${g}.webp${tver('til/' + g)}`).then(decoded),
    ]).then(([at, img]) => {
      const v = { at, img };
      groupData.set(g, v);
      groupFail.delete(g);
      floorCache.ver++; // 地面一組組補上(還沒拼完整的地面會重拼,最多每 100ms 一次)
      return v;
    });
    groups.set(g, p);
    p.catch(() => {
      if (groups.get(g) === p) groups.delete(g); // 失敗的不要留著(以前一次失敗整個 session 都缺這組)
      const fl = groupFail.get(g) || { n: 0, at: 0 };
      fl.n++;
      fl.at = window.NATISHA_OFFLINE ? Infinity : performance.now() + backoff(fl.n - 1);
      groupFail.set(g, fl);
    });
    return p;
  }
  const settle = (gs) => Promise.all([...gs].map((g) => group(g).catch(() => null))); // 等這些圖集(失敗的不擋)
  const piece = (r) => { const gr = groupData.get(r >> 10); const a = gr && gr.at[r]; return a ? [gr.img, a] : null; };
  const floorGroups = (d) => new Set(d.p.map((r) => r >> 10));
  function segGroups(d) {
    const out = new Set();
    for (const r of d.p) out.add(r >> 10);
    for (const row of d.o) for (let i = 2; i < row.length; i += 2) out.add(row[i] >> 10);
    return out;
  }
  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
  // 物件:同一格的圖塊照順序疊(右半格 +24),範圍取所有圖塊的外框;再用架子排進一張圖集
  // (地面不在這裡畫:區塊只留資料(d.f / d.p),drawFloor 直接畫到「畫面大小」的暫存上)
  async function buildObjects(d, s) {
    await settle(segGroups(d));
    if (s.cancelled) return null; // 等圖集的時候已經被清掉:不要配置畫布
    const cellsOut = [];
    const objs = [];
    const boxes = [];
    // d.g(新版轉檔才有):每塊屬於 s32 的第幾個物件。同一格不同物件拆成不同圖塊(進屋時只讓屋頂那個物件整片變淡)
    d.o.forEach((row, ri) => {
      const ids = d.g ? d.g[ri] : -1;
      const heights = d.h ? d.h[ri] : undefined; // Old segments have no heights: keep their fade behavior.
      // Preserve contiguous runs: merging A,B,A by object id would paint A,A,B
      // and discard the exporter height/order relationship at this cell.
      const runs = [];
      let b = null;
      for (let i = 2, k = 0; i < row.length; i += 2, k++) {
        const g = Array.isArray(ids) ? ids[k] : ids;
        if (!b || b.g !== g) {
          b = { gx: row[0], gy: row[1], g, hm: undefined, parts: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          runs.push(b);
        }
        const hm = Array.isArray(heights) ? heights[k] : heights;
        if (hm !== undefined) b.hm = b.hm === undefined ? hm : Math.max(b.hm, hm);
        const p = piece(row[i]);
        if (!p) continue;
        const [, [, , w, h, ox, oy]] = p;
        const dx = (row[i + 1] ? 24 : 0) + ox;
        b.parts.push([p, dx, oy]);
        b.x0 = Math.min(b.x0, dx); b.y0 = Math.min(b.y0, oy); b.x1 = Math.max(b.x1, dx + w); b.y1 = Math.max(b.y1, oy + h);
      }
      for (const run of runs) if (run.parts.length) boxes.push(Object.assign(run, { w: run.x1 - run.x0, h: run.y1 - run.y0 }));
    });
    const AW = 2048;
    let ax = 0, ay = 0, shelf = 0;
    for (const b of [...boxes].sort((p, q) => q.h - p.h)) {
      if (ax + b.w > AW) { ax = 0; ay += shelf + 1; shelf = 0; }
      b.ax = ax; b.ay = ay;
      ax += b.w + 1;
      shelf = Math.max(shelf, b.h);
    }
    let atlas = null;
    if (boxes.length) {
      atlas = document.createElement('canvas');
      atlas.width = AW;
      atlas.height = ay + shelf;
      const ac = atlas.getContext('2d');
      if (!ac) { atlas.width = atlas.height = 0; return { noCanvas: true }; } // 畫布記憶體不夠(iOS 16 以前會回 null):稍後再試,地面照畫
      let n = 0;
      for (const b of boxes) {
        for (const [[img, [sx, sy, w, h]], dx, dy] of b.parts) ac.drawImage(img, sx, sy, w, h, b.ax + dx - b.x0, b.ay + dy - b.y0, w, h);
        cellsOut.push([b.ax, b.ay, b.w, b.h]);
        objs.push([b.gx, b.gy, cellsOut.length - 1, b.x0 - 24, b.y0 - 12, b.g, b.hm]);
        if ((++n & 127) === 0) { await yieldFrame(); if (s.cancelled) { atlas.width = atlas.height = 0; return null; } }
      }
    }
    if (atlas) atlas.__worldRevision = 1; // Immutable until replaced.
    return { meta: { floor: null, objs, cells: cellsOut }, objs: atlas };
  }

  // ---- 區塊的載入 / 重試 ----
  const segTries = new Map(); // 區塊 -> 連續失敗次數(載入成功就清掉)
  const freeCanvas = (c) => { if (c && c instanceof HTMLCanvasElement) c.width = c.height = 0; }; // 畫布記憶體立刻還給瀏覽器
  function markFailed(sk, s) { // 區塊檔抓不到 / 壞掉:退避時間到了 segment() 會整個重抓
    if (segs.get(sk) !== s) return;
    const n = (segTries.get(sk) || 0) + 1;
    segTries.set(sk, n);
    s.failed = true;
    s.retryAt = window.NATISHA_OFFLINE ? Infinity : performance.now() + backoff(n - 1);
  }
  function retryLater(s) {
    s.partial = (s.partial || 0) + 1;
    s.retryAt = window.NATISHA_OFFLINE ? Infinity : performance.now() + backoff(s.partial - 1);
  }
  function startTile(key, sk, s) {
    getJSON(`${TBASE}seg/${key}.json${SEGVER}`).then((d) => {
      if (!d || !Array.isArray(d.p) || !Array.isArray(d.f) || !Array.isArray(d.o)) throw new Error('bad segment');
      if (segs.get(sk) !== s) return null;
      s.tile = { d, piece }; // 地面馬上開始畫:圖集一組組到了就補上(一組卡住只缺那一組,不會整片只剩模糊縮圖)
      floorCache.ver++;
      segTries.delete(sk);
      // 先抓地面用到的圖集,再抓房子的(地面約快 1.5~2.7 倍出來,不用等物件圖集)
      return settle(floorGroups(d)).then(() => { if (segs.get(sk) === s) composeObjects(sk, s); });
    }).catch(() => markFailed(sk, s));
  }
  function composeObjects(sk, s) {
    s.retryAt = null;
    buildObjects(s.tile.d, s).then((v) => {
      if (!v) return;
      if (segs.get(sk) !== s) { freeCanvas(v.objs); return; } // 組好的時候已經被清掉:圖集直接還掉
      if (v.noCanvas) { retryLater(s); return; }
      const old = s.objs;
      Object.assign(s, { meta: v.meta, objs: v.objs, ready: true, bytes: v.objs ? v.objs.width * v.objs.height * 4 : 0 });
      if (old && old !== v.objs) freeCanvas(old);
      watchAtlas(sk, s, v.objs);
      evict(lastNow, sk); // 物件圖集好了才知道多大:超過上限就清掉畫面外最舊的
      s.missing = [...segGroups(s.tile.d)].filter((g) => !groupData.has(g));
      if (s.missing.length) retryLater(s); else s.partial = 0; // 有圖集沒抓到:稍後重抓、重拼(以前缺的就永遠缺)
    }).catch(() => { if (segs.get(sk) === s) retryLater(s); });
  }
  // 缺圖集的區塊:重抓缺的組,有抓到才重拼物件圖集(地面在圖集到的時候會自己重拼)
  function retryParts(sk, s) {
    s.retryAt = null;
    const miss = s.missing || [];
    settle(miss).then(() => {
      if (segs.get(sk) !== s) return;
      if (!miss.length || miss.some((g) => groupData.has(g))) composeObjects(sk, s);
      else retryLater(s);
    });
  }
  // GPU 重設時畫布內容會被清空:恢復後(或一直沒恢復)重拼這個區塊的物件圖集
  function watchAtlas(sk, s, c) {
    if (!c || !c.addEventListener) return;
    const redo = () => { if (segs.get(sk) === s && s.objs === c) composeObjects(sk, s); };
    c.addEventListener('contextrestored', redo);
    c.addEventListener('contextlost', () => setTimeout(() => { if (c.getContext('2d')?.isContextLost?.()) redo(); }, 4000));
  }
  function startOld(key, sk, s) {
    getJSON(`${BASE}seg/${key}.json${VER}`).then((meta) => Promise.all([
      meta.floor ? loadImg(`${BASE}seg/${key}.webp${VER}`) : null,
      meta.cells.length ? loadImg(`${BASE}seg/${key}-o.webp${VER}`) : null,
    ]).then(([floor, objs]) => {
      if (segs.get(sk) !== s) return;
      const px = (im) => (im ? im.naturalWidth * im.naturalHeight * 4 : 0);
      Object.assign(s, { meta, floor, objs, ready: true, bytes: px(floor) + px(objs) });
      segTries.delete(sk);
      evict(lastNow, sk);
    })).catch(() => markFailed(sk, s));
  }
  // 太多區塊(個數或位元組)時丟掉最久沒用的;這一格畫面用到的(used === now)不丟,畫面上真的超過就暫時多留
  function evict(now, keep) {
    let n = 0, bytes = 0;
    for (const o of segs.values()) if (o.ready) { n++; bytes += o.bytes || 0; }
    const over = () => n > KEEP || bytes > BUDGET || segs.size > KEEP * 2;
    if (!over()) return;
    const old = [...segs.entries()].filter(([k, o]) => k !== keep && (o.used || 0) < now)
      .sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
    for (const [k, o] of old) {
      if (!over()) break;
      segs.delete(k);
      o.cancelled = true; // 還在組物件圖集的話就不要再配置畫布
      if (o.ready) { n--; bytes -= o.bytes || 0; }
      freeCanvas(o.floor); freeCanvas(o.objs);
    }
  }
  let lastNow = 0; // 最近一格畫面的時間(區塊在畫面外載好時清舊區塊用)
  function segment(key, now, tmap) {
    lastNow = now;
    const sk = (tmap ? 't:' : 'o:') + key; // 同一個 s32 兩種格式的資料不一樣,分開記
    let s = segs.get(sk);
    if (s && s.failed && now >= s.retryAt) { segs.delete(sk); s = null; } // 上次失敗:退避時間到了就重抓
    if (!s) {
      s = { ready: false, used: now }; // 先記使用時間:下面清舊區塊時才不會把剛建立的這個當成最舊的丟掉
      segs.set(sk, s);
      if (tmap) startTile(key, sk, s); else startOld(key, sk, s);
      evict(now, sk);
    } else if (s.retryAt != null && !s.failed && now >= s.retryAt) retryParts(sk, s); // 缺圖集:重抓
    s.used = now;
    return s.tile || s.ready ? s : null;
  }

  // 畫面範圍內的區塊;view = { cam, W, H, TW, TH }
  let waiting = 0; // 上一次畫面需要、但地面還沒好的區塊數(預先下載用來讓路)
  function visible(id, view, now) {
    const info = mapInfo(id);
    if (!info) return [];
    const { cam, W, H, TW, TH } = view;
    // 畫面四角換回格子座標
    const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => {
      const a = (px - W / 2) / (TW / 2) + cam.x + cam.y; // x + y
      const b = (py - (view.cy ?? H / 2)) / (TH / 2) + cam.y - cam.x; // y - x(鏡頭中心不一定在畫面正中)
      return [(a - b) / 2, (a + b) / 2];
    });
    const pad = 4; // 高的建築會超出所在格子
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const sx0 = Math.floor((Math.min(...xs) - pad) / SEG);
    const sx1 = Math.floor((Math.max(...xs) + pad) / SEG);
    const sy0 = Math.floor((Math.min(...ys) - pad) / SEG);
    const sy1 = Math.floor((Math.max(...ys) + pad + 8) / SEG);
    const out = [];
    let wait = 0;
    for (let a = sx0; a <= sx1; a++) {
      for (let b = sy0; b <= sy1; b++) {
        const key = info.byPos.get(`${a},${b}`);
        if (!key) continue;
        const s = segment(key, now, info.t);
        if (s) out.push({ s, x0: a * SEG, y0: b * SEG }); else wait++;
      }
    }
    waiting = wait;
    return out;
  }

  // 有這張地圖的資料(index 已載入)
  const ready = (id) => !!mapInfo(id);
  // 地圖資料還在下載(還不知道有沒有這張圖):先不要畫替代地形
  const pending = (id) => mapInfo(id) === undefined;

  // 地面;toScreen 回傳格子中心
  const FPAD = 96; // 暫存比畫面四邊各多幾像素(走幾步才需要重畫)
  const floorCache = { canvas: null, id: null, gx0: 0, gy0: 0, w: 0, h: 0, ver: 0, builtVer: -1, complete: false, revision: 0 };
  // 半格缺圖時墊暗土色;有圖時沿用原本的矩形,不多配畫布或讀像素。
  function drawFloorPiece(c, p, px, py, side) {
    if (p) {
      const [img, [ax, ay, pw, ph, ox, oy]] = p;
      c.drawImage(img, ax, ay, pw, ph, px - 24 + side * 24 + ox, py - 12 + oy, pw, ph);
      return;
    }
    c.fillStyle = '#2a2622';
    c.beginPath();
    c.moveTo(px, py - 12);
    c.lineTo(px + (side ? 24 : -24), py);
    c.lineTo(px, py + 12);
    c.closePath();
    c.fill();
  }
  function drawTileFloor(ctx, id, view, now, describe = false) {
    const info = mapInfo(id);
    const { cam, W, H } = view;
    const cy = view.cy ?? H / 2;
    // 全域斜角座標:格 (x, y) 中心 = ((x+y)*24, (y-x)*12);畫面左上角的全域座標
    const sx0 = (cam.x + cam.y) * 24 - W / 2;
    const sy0 = (cam.y - cam.x) * 12 - cy;
    const fc = floorCache;
    const segsNow = visible(id, view, now); // 順便讓畫面附近的區塊開始載入
    const inside = fc.canvas && fc.id === id && sx0 >= fc.gx0 && sy0 >= fc.gy0 && sx0 + W <= fc.gx0 + fc.w && sy0 + H <= fc.gy0 + fc.h;
    // 還沒拼完整時,有新區塊好了才重拼,而且最多每 100ms 一次(避免每一格畫面都重拼整片地面)
    if (!inside || (!fc.complete && fc.builtVer !== fc.ver && now - (fc.builtAt || 0) >= 100)) {
      const w = Math.ceil(W) + FPAD * 2;
      const h = Math.ceil(H) + FPAD * 2;
      if (!fc.canvas) {
        const cv = fc.canvas = document.createElement('canvas');
        // GPU 重設時這張畫布會被清空:下一格整片重拼;一直沒恢復(瀏覽器放棄)就換一張新畫布
        cv.addEventListener?.('contextlost', () => { fc.id = null; setTimeout(() => { if (fc.canvas === cv && cv.getContext('2d')?.isContextLost?.()) fc.canvas = null; }, 4000); });
        cv.addEventListener?.('contextrestored', () => { fc.id = null; });
      }
      if (fc.canvas.width !== w || fc.canvas.height !== h) { fc.canvas.width = w; fc.canvas.height = h; }
      fc.id = id;
      fc.gx0 = Math.floor(sx0) - FPAD;
      fc.gy0 = Math.floor(sy0) - FPAD;
      fc.w = w; fc.h = h;
      fc.builtVer = fc.ver;
      fc.builtAt = now;
      const c = fc.canvas.getContext('2d');
      c.clearRect(0, 0, w, h);
      // 暫存範圍的四角換回格子座標,逐格畫(外擴 2 格,邊緣的半格才不會缺)
      const toCell = (gx, gy) => { const a = gx / 24, b = gy / 12; return [(a - b) / 2, (a + b) / 2]; };
      const cs = [[fc.gx0, fc.gy0], [fc.gx0 + w, fc.gy0], [fc.gx0, fc.gy0 + h], [fc.gx0 + w, fc.gy0 + h]].map(([a, b]) => toCell(a, b));
      const x0 = Math.floor(Math.min(...cs.map((q) => q[0]))) - 2, x1 = Math.ceil(Math.max(...cs.map((q) => q[0]))) + 2;
      const y0 = Math.floor(Math.min(...cs.map((q) => q[1]))) - 2, y1 = Math.ceil(Math.max(...cs.map((q) => q[1]))) + 2;
      let complete = true;
      const segAt = new Map();
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = (x + y) * 24 - fc.gx0, py = (y - x) * 12 - fc.gy0;
          if (px < -48 || py < -48 || px > w + 48 || py > h + 48) continue;
          const sk = `${x >> 6},${y >> 6}`;
          let sg = segAt.get(sk);
          if (sg === undefined) {
            const key = info && info.byPos.get(sk);
            sg = key ? (segs.get('t:' + key) || null) : 0;
            segAt.set(sk, sg);
          }
          if (sg === 0) continue; // 這裡沒有地圖
          if (!sg || !sg.tile) {
            complete = false;
            drawFloorPiece(c, null, px, py, 0);
            drawFloorPiece(c, null, px, py, 1);
            continue;
          } // 地面只要區塊資料和地面的圖集,不用等物件圖集
          const { d } = sg.tile;
          const base = (((y & 63) * SEG) + (x & 63)) * 2;
          for (let side = 0; side < 2; side++) {
            const fi = d.f[base + side];
            if (!fi) continue;
            const ref = d.p[fi - 1];
            const p = piece(ref);
            if (!p && !groupData.has(ref >> 10)) complete = false; // 圖集到了照原本版本號流程重拼
            drawFloorPiece(c, p, px, py, side);
          }
        }
      }
      // Composite layer2 only after ALL base floors, including neighbouring segments.
      // Its references share p, so atlas loading, prefetch and retry include them.
      for (const [sk, sg] of segAt) {
        if (!sg || !sg.tile) continue;
        const [sx, sy] = sk.split(',').map(Number);
        const { d } = sg.tile;
        for (const [hx, gy, fi] of d.l || []) {
          const x = sx * SEG + (hx >> 1), y = sy * SEG + gy;
          const ref = d.p[fi - 1], p = piece(ref);
          if (!p) { if (!groupData.has(ref >> 10)) complete = false; continue; }
          const px = (x + y) * 24 - fc.gx0, py = (y - x) * 12 - fc.gy0;
          const [, [, , pw, ph, ox, oy]] = p;
          const left = px - 24 + (hx & 1) * 24 + ox, top = py - 12 + oy;
          if (left + pw <= 0 || top + ph <= 0 || left >= w || top >= h) continue;
          drawFloorPiece(c, p, px, py, hx & 1);
        }
      }
      fc.complete = complete;
      fc.revision++;
      fc.canvas.__worldRevision = fc.revision;
    }
    if (describe) return [{ img: fc.canvas, cell: [0, 0, fc.w, fc.h], dx: fc.gx0, dy: fc.gy0,
      scale: [1, 1], blend: 'source-over', alpha: 1, smooth: false, world: true }];
    // 放大到手機解析度時用「最近像素」:原版是點陣圖,平滑放大會整片糊掉(前面畫模糊縮圖時會把平滑打開)
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fc.canvas, Math.round(fc.gx0 - sx0), Math.round(fc.gy0 - sy0));
    ctx.imageSmoothingEnabled = smooth;
    return segsNow;
  }

  function drawFloor(ctx, id, view, toScreen, now) {
    if (mapInfo(id)?.t) { drawTileFloor(ctx, id, view, now); return; }
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false; // 舊格式的地面也用最近像素(2026-10-09 的修正以前只做在地磚格式)
    for (const { s, x0, y0 } of visible(id, view, now)) {
      if (!s.floor) continue;
      const p = toScreen(x0, y0);
      ctx.drawImage(s.floor, Math.round(p.x + s.meta.floor[0]), Math.round(p.y + s.meta.floor[1]));
    }
    ctx.imageSmoothingEnabled = smooth;
  }

  // WebGL: share the existing floor cache, without drawing it through a 2D recorder.
  function describeFloor(id, view, toScreen, now) {
    if (mapInfo(id)?.t) return drawTileFloor(null, id, view, now, true);
    const out = [];
    for (const { s, x0, y0 } of visible(id, view, now)) {
      if (!s.floor) continue;
      const p = toScreen(x0, y0);
      out.push({ img: s.floor, cell: [0, 0, s.floor.width, s.floor.height],
        dx: Math.round(p.x + s.meta.floor[0]), dy: Math.round(p.y + s.meta.floor[1]),
        scale: [1, 1], blend: 'source-over', alpha: 1, smooth: false });
    }
    return out;
  }

  // 地形提示獨立一張地面尺寸暫存;平常每幀只貼一次,開關不必重拼原版地磚。
  // 新格式跟隨 floorCache 的範圍 / revision;舊格式與替代地形也用相同 FPAD 策略。
  let walkHintCache = null;
  function drawWalkHint(ctx, id, view, hint) {
    if (!hint) {
      if (walkHintCache) freeCanvas(walkHintCache.canvas);
      walkHintCache = null;
      return;
    }
    const { cam, W, H, TW, TH } = view;
    const hw = TW / 2, hh = TH / 2;
    const sx0 = (cam.x + cam.y) * hw - W / 2;
    const sy0 = (cam.y - cam.x) * hh - (view.cy ?? H / 2);
    const fc = floorCache.canvas && floorCache.id === id && mapInfo(id)?.t ? floorCache : null;
    const revision = fc ? fc.revision : -1;
    let hc = walkHintCache;
    const inside = hc && sx0 >= hc.gx0 && sy0 >= hc.gy0 && sx0 + W <= hc.gx0 + hc.w && sy0 + H <= hc.gy0 + hc.h;
    if (!inside || hc.id !== id || hc.source !== hint.source || hc.tiles !== hint.tiles || hc.key !== hint.key
        || hc.mask !== hint.mask || hc.style !== hint.style || hc.revision !== revision
        || hc.W !== W || hc.H !== H || hc.TW !== TW || hc.TH !== TH) {
      if (!hc) {
        const canvas = document.createElement('canvas');
        hc = walkHintCache = { canvas };
        // GPU 重設只清掉提示暫存;下次畫面重建,不讓失效的畫布一直被重用。
        canvas.addEventListener?.('contextlost', () => {
          if (walkHintCache === hc) { freeCanvas(canvas); walkHintCache = null; }
        });
      }
      const w = fc ? fc.w : Math.ceil(W) + FPAD * 2;
      const h = fc ? fc.h : Math.ceil(H) + FPAD * 2;
      const gx0 = fc ? fc.gx0 : Math.floor(sx0) - FPAD;
      const gy0 = fc ? fc.gy0 : Math.floor(sy0) - FPAD;
      if (hc.canvas.width !== w || hc.canvas.height !== h) { hc.canvas.width = w; hc.canvas.height = h; }
      const c = hc.canvas.getContext('2d');
      if (!c || c.isContextLost?.()) { freeCanvas(hc.canvas); walkHintCache = null; return; }
      c.clearRect(0, 0, w, h);
      const corners = [[gx0, gy0], [gx0 + w, gy0], [gx0, gy0 + h], [gx0 + w, gy0 + h]]
        .map(([x, y]) => [(x / hw - y / hh) / 2, (x / hw + y / hh) / 2]);
      const x0 = Math.floor(Math.min(...corners.map((p) => p[0]))) - 1;
      const x1 = Math.ceil(Math.max(...corners.map((p) => p[0]))) + 1;
      const y0 = Math.floor(Math.min(...corners.map((p) => p[1]))) - 1;
      const y1 = Math.ceil(Math.max(...corners.map((p) => p[1]))) + 1;
      c.beginPath();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = (x + y) * hw - gx0, py = (y - x) * hh - gy0;
        if (px < -hw || px > w + hw || py < -hh || py > h + hh || !hint.blocked(x, y)) continue;
        c.moveTo(px, py - hh); c.lineTo(px + hw, py);
        c.lineTo(px, py + hh); c.lineTo(px - hw, py); c.closePath();
      }
      if (hint.style === 'hatch') {
        c.save();
        c.clip(); // 全部菱形一起裁切;斜線固定在世界像素,移動重建也不跳相位
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1;
        c.beginPath();
        const phase = ((gx0 + gy0) % 8 + 8) % 8;
        for (let d = -phase; d <= w + h; d += 8) { c.moveTo(d, 0); c.lineTo(d - h, h); }
        c.stroke();
        c.restore();
      } else {
        c.fillStyle = 'rgba(0,0,0,0.28)'; c.fill();
      }
      hc.canvas.__worldRevision = (hc.canvas.__worldRevision || 0) + 1;
      Object.assign(hc, { id, source: hint.source, tiles: hint.tiles, key: hint.key, mask: hint.mask,
        style: hint.style, revision, gx0, gy0, w, h, W, H, TW, TH });
    }
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(hc.canvas, Math.round(hc.gx0 - sx0), Math.round(hc.gy0 - sy0));
    ctx.imageSmoothingEnabled = smooth;
  }

  // 畫面上的物件,已依深度(y - x)排好(同深度照區塊、區塊內的原順序),給呼叫端和人物合併
  // 座標換算直接用 view(和 app.js toScreen 同一個算式、同樣的運算順序),不用每一列呼叫 toScreen
  // 森林一畫面上千個物件:每個區塊的物件只建一次(座標、深度、g 字串都不會變),畫面上的區塊沒變就不重排,
  // 每格畫面只更新 left / top、挑出畫面內的。回傳的陣列和裡面的物件會重複使用:呼叫端不要留到下一格
  function segObjs(s, x0, y0) {
    if (!s.oe || s.oeMeta !== s.meta || s.oeImg !== s.objs) { s.oe = new Map(); s.oeMeta = s.meta; s.oeImg = s.objs; } // 物件圖集重拼過:重建
    const k = x0 * 65536 + y0;
    let list = s.oe.get(k);
    if (list) return list;
    const { objs, cells } = s.meta;
    list = [];
    for (let i = 0; i < objs.length; i++) {
      const r = objs[i];
      const x = x0 + r[0];
      const y = y0 + r[1];
      list.push({
        x, y, depth: y - x, img: s.objs, c: cells[r[2]], left: 0, top: 0, g: r[5] >= 0 ? `${x0},${y0}:${r[5]}` : null,
        sum: x + y, dif: y - x, ox: r[3], oy: r[4], hm: r[6],
        fk: null, // app.js 變淡用的 key(第一次用到才建)
        al: undefined, // opaqueAt 的透明度表
        fon: 0, // app.js:這一格要變淡(畫面編號)
      });
    }
    s.oe.set(k, list);
    return list;
  }
  let sortSrc = []; // 上次排序用到的各區塊物件表(同一批就不用重排)
  let sorted = [];
  let oyMin = 0, botMax = 0; // 排好的物件裡圖的最高點 / 最低點(相對所在格子):用深度先框出可能在畫面上的那一段
  const srcNow = [];
  const shown = [];
  function objects(id, view, toScreen, now) {
    const { cam, W, H, TW, TH } = view;
    const cy = view.cy ?? H / 2;
    const csum = cam.x + cam.y, cdif = cam.y - cam.x, W2 = W / 2, hw = TW / 2, hh = TH / 2;
    let n = 0, same = true;
    for (const { s, x0, y0 } of visible(id, view, now)) {
      if (!s.objs || !s.meta) continue;
      const l = segObjs(s, x0, y0);
      if (sortSrc[n] !== l) same = false;
      srcNow[n++] = l;
    }
    if (n !== sortSrc.length) same = false;
    if (!same) {
      // 穩定排序:同深度的保持原本的先後(和以前每格畫面整批排序的結果一樣)
      sortSrc = srcNow.slice(0, n);
      sorted = [].concat(...sortSrc).sort((a, b) => a.depth - b.depth);
      oyMin = Infinity; botMax = -Infinity;
      for (const e of sorted) { oyMin = Math.min(oyMin, e.oy); botMax = Math.max(botMax, e.oy + e.c[3]); }
    }
    srcNow.length = 0;
    shown.length = 0;
    // 畫面的上下緣只看深度(y - x)就能先框出一段(多留 1 格),不用每格畫面把四個區塊幾千個物件都算一遍;框內的照舊逐一檢查
    const dLo = cdif - (cy + botMax) / hh - 1, dHi = cdif + (H - cy - oyMin) / hh + 1;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m].depth < dLo) lo = m + 1; else hi = m; }
    for (let i = lo; i < sorted.length; i++) {
      const e = sorted[i];
      if (e.depth > dHi) break;
      const c = e.c;
      const left = W2 + (e.sum - csum) * hw + e.ox;
      const top = cy + (e.dif - cdif) * hh + e.oy;
      if (left > W || top > H || left + c[2] < 0 || top + c[3] < 0) continue;
      e.left = Math.round(left) + 0; // + 0:-0 變 0(欄位一直是整數,V8 不用改成小數欄位)
      e.top = Math.round(top) + 0;
      shown.push(e);
    }
    return shown;
  }

  // all changes identity only when segment membership/atlas identity changes.
  // shown is transient; all entries retain their original objects() identity.
  let describedObjects = null, describedTW = 0, describedTH = 0;
  function describeObjects(id, view, toScreen, now) {
    const before = sorted, clock = window.__rmMeasureNow || performance.now.bind(performance), started = clock();
    const visible = objects(id, view, toScreen, now);
    const sortMs = before === sorted ? 0 : clock() - started;
    if (describedObjects !== sorted || describedTW !== view.TW || describedTH !== view.TH) {
      describedObjects = sorted; describedTW = view.TW; describedTH = view.TH;
      for (const e of sorted) {
        e.worldX = e.sum * (view.TW / 2) + e.ox;
        e.worldY = e.dif * (view.TH / 2) + e.oy;
      }
    }
    return { all: sorted, visible, sortMs };
  }

  // B-02b(app.js 同排合併圖用):objects() 排好的物件表;同一個陣列 = 畫面上的區塊 / 物件圖集都沒換過
  const objectsKey = () => sorted;
  // B-02b:app.js 的合併圖畫布也算進 canvasMB(旗標關著時是空的)
  const extraCanvases = new Set();
  const trackCanvas = (c, on) => { if (on) extraCanvases.add(c); else extraCanvases.delete(c); };

  // 房子、樹也用最近像素(和地面一樣;平滑放大會糊、相鄰圖塊之間還會露出細縫)。
  // 每次都要設:中間畫人物時 l1spr.js 會把平滑打開
  function drawObject(ctx, e) {
    const [sx, sy, w, h] = e.c;
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(e.img, sx, sy, w, h, e.left, e.top, w, h);
    ctx.imageSmoothingEnabled = smooth;
  }

  // 物件這個位置有沒有畫東西(不透明像素):擋住人物才變淡用(app.js)。每塊圖只讀一次透明度,存起來
  const alphaCache = new WeakMap(); // 圖集 -> Map(圖塊 -> Uint8Array 透明度 | null)
  function opaqueAt(e, x, y) {
    const c = e.c;
    const w = c[2], h = c[3];
    const lx = Math.floor(x - e.left);
    const ly = Math.floor(y - e.top);
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
    let a = e.al; // objects() 的物件會留著:查過一次就記在物件上(每格畫面上千次查詢不用再組字串)
    if (a === undefined) a = e.al = alphaOf(e.img, c[0], c[1], w, h);
    return a ? a[ly * w + lx] > 40 : true; // 讀不到像素就當成有蓋到
  }
  function alphaOf(img, sx, sy, w, h) {
    let m = alphaCache.get(img);
    if (!m) { m = new Map(); alphaCache.set(img, m); }
    const key = `${sx},${sy},${w},${h}`;
    let a = m.get(key);
    if (a === undefined) {
      try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, sx, sy, w, h, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        a = new Uint8Array(w * h);
        for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
      } catch { a = null; }
      m.set(key, a);
    }
    return a;
  }

  // 小地圖:每格 1 像素的俯視圖(左上角是地圖範圍的 x0, y0);還沒載入或沒有時回傳 null
  const minis = {}; // id -> img | null(載入中)| false(失敗,等重試)
  const miniFail = {};
  function mini(id) {
    const f = miniFail[id];
    if (minis[id] === false && f.n < 3 && performance.now() >= f.at) delete minis[id]; // 抓失敗:最多再試 3 次(沒有這個檔的地圖不要一直抓)
    if (!(id in minis)) {
      minis[id] = null;
      const img = new Image();
      img.onload = () => { minis[id] = img; delete miniFail[id]; };
      img.onerror = () => { const g = miniFail[id] || (miniFail[id] = { n: 0, at: 0 }); g.n++; g.at = performance.now() + backoff(g.n - 1); minis[id] = false; };
      img.src = `${BASE}mini/${artOf(id)}.webp${mapVer(artOf(id))}`;
    }
    return minis[id] || null;
  }

  // 全部地磚圖集的網址(進遊戲後在背景慢慢抓,之後傳送到哪裡都不用等)
  async function allTileUrls() {
    const list = await getJSON(`${TBASE}til/index.json${tver('til/index')}`).catch(() => []);
    return list.flatMap((g) => [`${TBASE}til/${g}.json${tver('til/' + g)}`, `${TBASE}til/${g}.webp${tver('til/' + g)}`]);
  }

  // 網路恢復 / 回到前景 / 重新連上時呼叫:失敗的東西不用等退避時間,下一格畫面就重抓
  function retryFailed() {
    for (const f of groupFail.values()) f.at = 0;
    for (const id in idxFail) if (idxFail[id].at !== Infinity) idxFail[id].at = 0;
    for (const s of segs.values()) if (s.retryAt != null) s.retryAt = 0;
    for (const id in miniFail) miniFail[id].at = 0;
  }
  const busy = () => waiting > 0;

  // 除錯:目前留著的區塊與畫布像素(MB,RGBA)
  function stats() {
    let px = 0, n = 0, failed = 0, partial = 0, oh = 0;
    for (const s of segs.values()) {
      if (s.failed) failed++;
      if (s.partial) partial++;
      if (!s.ready) continue;
      n++;
      for (const c of [s.floor, s.objs]) if (c && c.width) { px += c.width * c.height; if (c === s.objs) oh = Math.max(oh, c.height); }
    }
    if (floorCache.canvas) px += floorCache.canvas.width * floorCache.canvas.height;
    if (walkHintCache) px += walkHintCache.canvas.width * walkHintCache.canvas.height;
    for (const c of extraCanvases) px += c.width * c.height;
    return { segs: n, failed, partial, canvasMB: Math.round(px * 4 / 1e6), maxObjAtlasH: oh, groups: groupData.size, groupFails: groupFail.size };
  }

  // 目前用到的 assets/tmap/ 版本參數(app.js 清舊快取時保留這些;seg 的是 TVER + 尾碼)
  const cacheVers = () => [TVER, SEGVER].map((v) => v.slice(3));
  // assets/tmap/ 底下某個檔「現在該用的版本」(app.js 清快取:快取裡的 v 不等於這個才刪)
  const tmapVerOf = (pathname) => {
    const m = pathname.match(/\/assets\/tmap\/(.+)$/);
    if (!m) return null;
    const rel = m[1];
    if (rel.startsWith('seg/')) return SEGVER.slice(3);
    const k = rel.match(/^(til\/[^/]+|[^/]+)\.(?:json|webp)$/);
    return k ? tver(k[1]).slice(3) : null;
  };

  return { ready, pending, describeFloor, describeObjects, drawFloor, drawWalkHint, objects, objectsKey, trackCanvas, drawObject, opaqueAt, mini, urlsNear, allTileUrls, stats, retryFailed, busy, cacheVers, tmapVerOf };
})();
