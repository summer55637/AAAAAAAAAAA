// 預先下載素材:開網頁時先抓共用素材(圖示、職業動畫、說話之島),進入地圖後依距離抓附近的地圖區塊與怪物 / NPC 動畫。
// 只下載不解碼:檔案進瀏覽器快取(有 Service Worker 時也存進 Cache Storage),真正用到時直接讀本機,不佔記憶體。
'use strict';

// 選角立繪網址(app.js 也用;版本由 gateway 依檔案修改時間給)
function charselUrl(key, ext) { return `assets/charsel/${key}.${ext}?v=${window.AV?.charsel?.[key] ?? 1}`; }

const PRELOAD = (() => {
  const PC_GFX = [0, 1, 61, 48, 138, 37, 734, 1186, 2786, 2796, 6658, 6661, 6671, 6650];
  const TOWN = [0, 32593, 32922]; // 新角色出生的說話之島
  const MAX = 4; // 同時下載數
  const queue = [];
  const seen = new Set();
  let active = 0;
  let total = 0;
  let done = 0;
  let bytes = 0;
  // 開網頁時的第一批素材全部下載完才能登入(不然進遊戲會先看到替代圖、介面圖慢慢冒出來)
  let firstAdded = false;
  let ready = false;
  let onReady;
  const readyP = new Promise((r) => { onReady = r; });
  const loginBtn = document.querySelector('#login-form button[type=submit]');
  const loginText = '進入遊戲'; // 按鈕一開始顯示「準備素材中…」(index.html),下載完、選好 Google 帳號後才顯示「進入遊戲」
  const loginInputs = document.querySelectorAll('#login-form input');
  const UI182 = ['bar', 'close', 'dragon', 'exp', 'exp0', 'hp', 'mp', 'panel', 'round', 'slot',
    'i_bag', 'i_char', 'i_chat', 'i_gear', 'i_help', 'i_party', 'i_skill', 'stone', 'buff_brave', 'st_481', 'st_486', 'st_480', 'st_5399', 'st_484g', 'st_1477'].map((n) => `assets/ui182/${n}.webp?v=${window.AV?.ui?.[n] ?? 1}`);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.storage?.persist?.().catch(() => {}); // 請瀏覽器不要自動清掉
  }

  // 進度列(登入 / 選角畫面才顯示)
  const box = document.createElement('div');
  box.id = 'preload';
  box.innerHTML = '<div class="bar"><i></i></div><span></span>';
  document.body.appendChild(box);
  function render() {
    const k = total ? done / total : 1;
    box.querySelector('i').style.width = `${Math.round(k * 100)}%`;
    box.querySelector('span').textContent = `預先下載素材 ${done} / ${total} · ${(bytes / 1e6).toFixed(1)} MB`;
    if (!ready && firstAdded && done >= total) {
      ready = true;
      document.body.classList.add('assets-ready'); // Google 登入按鈕這時才顯示(style.css)
      onReady();
    }
    box.classList.toggle('done', ready && done >= total); // 下載完就隱藏
    // 開網頁就開始下載;下載完之前帳號、密碼都不能輸入
    for (const inp of loginInputs) inp.disabled = !ready;
    if (loginBtn) {
      loginBtn.disabled = !ready;
      loginBtn.textContent = ready ? (window.enterLabel ? window.enterLabel() : loginText) : firstAdded ? `下載素材中 ${Math.floor(k * 100)}%` : '準備素材中…';
    }
  }

  let pauseUntil = 0; // 換地圖 / 傳送後一小段時間:背景預抓先讓路(app.js preloadPosition 呼叫 pause)
  function pump() {
    // 眼前的地圖還沒載好(或剛換地圖)時只留 1 條背景下載,頻寬先給畫面要用的
    const busy = performance.now() < pauseUntil || (typeof L1MAP !== 'undefined' && L1MAP.busy && L1MAP.busy());
    // 已開始的不取消;降到上限以下才補新下載,避免中斷快完成的檔案。
    const lim = busy ? 1 : MAX;
    while (active < lim && queue.length) {
      const url = queue.shift();
      active++;
      fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then((b) => { bytes += b.byteLength; })
        .catch(() => { seen.delete(url); }) // 抓失敗的下次經過還可以再排
        .finally(() => { active--; done++; render(); pump(); });
    }
  }

  function add(urls, front = false) {
    const ordered = [...new Set(urls)];
    const fresh = ordered.filter((u) => !seen.has(u));
    if (front) {
      // 已排在全圖背景佇列的也要移到最前面;下載中 / 已完成的不重抓、不重算進度。
      const wanted = new Set(ordered);
      const queued = new Set(queue);
      let n = 0;
      for (const u of queue) if (!wanted.has(u)) queue[n++] = u;
      queue.length = n;
      queue.unshift(...ordered.filter((u) => queued.has(u) || !seen.has(u)));
    } else queue.push(...fresh);
    for (const u of fresh) seen.add(u);
    total += fresh.length;
    render();
    pump();
  }

  async function gfxUrls(list) {
    const out = [];
    for (const g of list) out.push(...await L1S.urls(g).catch(() => []));
    return out;
  }

  // (x, y) 附近 range 格內的怪物 / NPC 外型,近的先
  async function gfxNear(mapId, x, y, range) {
    const sp = (await L1S.spawns())[mapId] || [];
    const best = new Map();
    for (const [g, sx, sy] of sp) {
      const d = Math.max(Math.abs(sx - x), Math.abs(sy - y));
      if (d <= range && d < (best.get(g) ?? Infinity)) best.set(g, d);
    }
    return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([g]) => g);
  }

  // 開網頁:共用素材
  (async () => {
    add(UI182, true);
    add(GDX.urls());
    // 選角立繪(和 app.js 同一組網址)
    add([charselUrl('index', 'json'), ...['0_0', '0_1', '1_0', '1_1', '2_0', '2_1', '3_0', '3_1'].map((k) => charselUrl(k, 'webp'))], true);
    // 14 個職業外型不在登入前下載(約 21 MB):進遊戲後只下載自己的(near())
    const [m, x, y] = TOWN;
    add(await L1MAP.urlsNear(m, x, y, 1));
    add(await gfxUrls(await gfxNear(m, x, y, 40)));
  })().catch(() => {}).finally(() => { firstAdded = true; render(); });

  // 進入地圖 / 換區塊時:附近的地圖區塊與怪物動畫(呼叫端可以每隔幾秒呼叫,換區塊才會真的排新工作)
  let lastKey = '';
  let retryAt = 0;
  let allTilesQueued = false;
  let hotQueued = false;
  const HOT_SPOTS = [[33640, 32320]]; // 火龍窟中心(涵蓋威頓村莊 33722,32496 的區塊)
  async function near(mapId, x, y) {
    const key = `${mapId}:${x >> 6}:${y >> 6}`;
    if (key === lastKey && !(retryAt && performance.now() >= retryAt)) return;
    lastKey = key;
    retryAt = 0;
    const me = typeof self === 'function' ? self() : null; // 自己的外型(含變身)先下載
    if (me?.gfx) add(await gfxUrls([me.gfx]), true);
    const urls = await L1MAP.urlsNear(mapId, x, y, 1, allTilesQueued); // 圖集都排進去了:只要區塊檔,不用再解析
    if (!urls.length && L1MAP.pending(mapId)) retryAt = performance.now() + 3000; // 區塊表還沒載到(暫時失敗在重試):3 秒後再排
    add(urls, true);
    const g60 = await gfxNear(mapId, x, y, 60);
    add(await gfxUrls(g60));
    // 外圈(半徑 2,約 16 個區塊 / 十幾 MB)不再預先下載:載入中有縮小版地圖墊底,手機流量省很多
    const s60 = new Set(g60);
    add(await gfxUrls((await gfxNear(mapId, x, y, 150)).filter((g) => !s60.has(g)))); // 60 格內的上面已經排過
    // 第一次進地圖後:在背景把全部地磚圖集抓下來(約 20 MB,只抓一次,之後存在手機裡);省流量模式不抓
    if (!allTilesQueued && !navigator.connection?.saveData) {
      allTilesQueued = true;
      add(await L1MAP.allTileUrls());
    }
    // 10/30 威頓 / 火龍窟:人在大陸上就先把這一帶的區塊抓進快取(半徑 2 = 25 個區塊、約 3~4 MB;圖集上面已排過),傳送進去不用等下載;省流量模式不抓
    if (!hotQueued && mapId === 4 && !navigator.connection?.saveData) {
      hotQueued = true;
      for (const [hx, hy] of HOT_SPOTS) add(await L1MAP.urlsNear(4, hx, hy, 2, allTilesQueued));
    }
  }

  // BOSS 戰素材(app.js preloadRaidBoss):指定外型的檔案排進背景下載(同一個網址只排一次);只下載不解碼
  async function boss(list) { add(await gfxUrls(list)); }

  return { near, boss, add, ready: () => readyP, pause: (ms) => { pauseUntil = Math.max(pauseUntil, performance.now() + ms); } };
})();
