// 伊娃的寶藏(金幣老虎機;伺服器 L1EvaTreasure / C_WebEva,gateway 'eva';使用者 10/16;只在測試站)
// 進遊戲後問一次伺服器有沒有開放(altsettings EvaTreasureEnabled),有開才在右上角 AUTO 那排放按鈕。
// 轉一次:伺服器先扣押注、算完整個過程(含連鎖消除、免費遊戲)並發獎,網頁只照 frames 播動畫。返還率不在網頁出現。
// 動畫(使用者 10/16:沒有特效等待感太久):按下去圖案往下滾 → 沿同一條軌跡減速 → 結果一欄一欄停好 →
// 中獎的發亮、放大消失 → 上面的掉下來補 → 倍數 / 免費遊戲 / 大獎跳大字;贏分數字往上跳。
'use strict';

const EVA = { info: null, bet: 0, busy: false, fast: false, lastInGame: false, panel: null, sentAt: 0, spinT0: 0, loop: 0, last: null,
  auto: false, autoN: 0, waiting: false, reqTimer: 0, spinId: 0 };
const EVA_REPLY_TIMEOUT_MS = 8000; // 送出後這麼久沒回(切到背景斷線、結果沒收到)就停下來,不然會一直轉
const EVA_COLS = 6;
const EVA_ROWS = 5;
const EVA_SCATTER = 9;
const EVA_MULT = 10;
const EVA_ICON = 40; // 格子圖示的大小(CSS px)
// 伺服器規定每轉至少隔 1.5 秒(EvaTreasureIntervalMs):按鈕要等滿這個時間才放開,不然再按會被擋
const EVA_MIN_CYCLE_MS = 1800; // 多留 0.3 秒給網路延遲的抖動
const EVA_MIN_SPIN_MS = 750; // 轉動動畫至少播這麼久(伺服器回得很快也一樣)
const EVA_REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const EVA_MOBILE = window.matchMedia('(pointer: coarse)');
const evaReduced = () => false; // 10/28:不跟 Windows「動畫效果」(關掉的玩家整個舞台空白、盤面不轉);要關用遊戲內「戰鬥動畫」按鈕
const evaDpr = () => EVA_MOBILE.matches ? Math.min(window.devicePixelRatio || 1, 2) : window.devicePixelRatio || 1;

function evaStore(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch { /* 無痕模式 */ }
  return null;
}

// 進遊戲(含斷線重連)後問一次開放狀態
setInterval(() => {
  const inGame = !!(typeof st !== 'undefined' && st.inGame);
  if (inGame && !EVA.lastInGame) send({ t: 'eva', op: 0, bet: 0 });
  EVA.lastInGame = inGame;
}, 1000);

// 11/10 玩家回報(電腦版):一進免費遊戲,角色狀態列的金幣就已經是最後的數字(伺服器算完就發獎,背包金幣馬上更新)= 動畫還沒播完就知道結果。
// 這一轉播完之前,狀態列 / 背包底下顯示的金幣先不含這一轉的贏分;只改顯示(hud.js goldShown / refreshGold),背包裡的金幣和夠不夠錢的判斷都不動。
// EVA.hold:送出後 { frozen } = 停在送出時的數字;收到結果後 { win, final } = 顯示「實際 − 這轉贏分」(掛機撿到 / 花掉的金幣照常跳);播完、出錯、沒回覆 = null。
function evaGoldShown(real) {
  const h = EVA.hold;
  if (!h) return real;
  if (h.win == null) return h.frozen;
  if (!h.seen && real >= h.final) h.seen = true; // 背包金幣已經加上這一轉的贏分(伺服器先送背包、再送結果;順序反過來時先顯示「結果 − 贏分」)
  return h.seen ? real - h.win : Math.min(real, h.final - h.win);
}
function evaHold(h) {
  EVA.hold = h;
  try { if (typeof refreshGold === 'function') refreshGold(); } catch { /* 顯示而已,不能擋住開獎 */ }
}

function evaEvent(ev) {
  if (ev.op === 'rtp') { evaRtpRender(ev); return; } // gateway 的登入連線專用資訊
  if (ev.op === 'info') {
    // 第 6 個圖案原本是對盔甲施法的卷軸(圖示和對武器的幾乎一樣),伺服器 10/16 19:43 起是綠寶石;舊資料網頁先換圖
    if (ev.symbols?.[5]?.gfx === 467) ev.symbols[5] = { name: '綠寶石', gfx: 239 };
    EVA.info = ev;
    EVA.sym = null; // 圖案快取重建
    if (ev.enabled) evaButton(); else document.querySelector('#btn-eva')?.remove();
    if (EVA.panel && !EVA.busy) evaRenderInfo();
    return;
  }
  if (ev.op === 'err') {
    const wasWaiting = EVA.waiting; // 這個錯誤是回給「正在等的那一轉」的(不是多送的)才重送
    evaReplied();
    // 「轉太快了」:網路延遲忽快忽慢時,伺服器量到的間隔可能比網頁短一點;自己等一下重送,不跳錯誤、不停自動轉(最多 3 次)
    if (/轉太快/.test(ev.msg || '') && wasWaiting && EVA.busy && (EVA.retry || 0) < 3) {
      EVA.retry = (EVA.retry || 0) + 1;
      setTimeout(evaSend, 700);
      return;
    }
    EVA.retry = 0;
    EVA.auto = false; // 出錯(金幣不足、到上限…)就停自動轉
    evaHold(null);
    evaStopSpinFx();
    if (EVA.last) evaDrawFrame(EVA.last.g, EVA.last.m, { drop: false });
    EVA.busy = false;
    // 錯誤直接寫在盤面下方(toast 會被這個視窗蓋住,玩家以為按了沒反應)
    if (EVA.panel && !EVA.panel.classList.contains('hidden')) EVA.panel.querySelector('.eva-msg').textContent = ev.msg || '發生錯誤';
    else toast(ev.msg || '伊娃的寶藏:發生錯誤');
    if (EVA.panel) evaRenderInfo();
    return;
  }
  if (ev.op === 'spin') { evaReplied(); EVA.retry = 0; evaPlay(ev); }
}
function evaReplied() {
  EVA.waiting = false;
  EVA.replyAt = performance.now();
  clearTimeout(EVA.reqTimer);
}

// 切到背景:動畫直接快轉、停自動轉;切回來:重新要一次金幣 / 今天押注(畫面才會是最新的)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (EVA.busy) EVA.fast = true;
    EVA.auto = false;
    evaFinishMotions(); // rAF 在背景不會跑,有限動畫直接到終點,不阻塞開獎
    evaStageStop();
    evaFxStop();
  } else if (EVA.panel && !EVA.panel.classList.contains('hidden')) {
    send({ t: 'eva', op: 0, bet: 0 });
    evaRenderInfo();
    evaStageStartS();
    evaQueueMotion();
  }
});

function evaButton() {
  if (document.querySelector('#btn-eva')) return;
  const box = document.querySelector('#side-buttons');
  if (!box) return;
  const b = el('button', 'round eva-btn');
  b.id = 'btn-eva';
  b.type = 'button';
  b.setAttribute('aria-label', '伊娃的寶藏');
  const sym = EVA.info?.symbols?.[EVA_SCATTER];
  if (sym) b.appendChild(iconCanvas({ name: sym.name, gfx: sym.gfx }, 24));
  b.appendChild(el('small', '', '寶藏'));
  b.onclick = () => evaOpen();
  const auto = document.querySelector('#btn-auto');
  if (auto && auto.nextSibling) box.insertBefore(b, auto.nextSibling); else box.appendChild(b);
}

function evaOpen() {
  if (!EVA.panel) evaBuild();
  EVA.panel.classList.remove('hidden');
  evaRtpLoad();
  send({ t: 'eva', op: 0, bet: 0 }); // 更新金幣 / 今天押了多少
  evaRenderInfo();
  if (!EVA.last) evaIdleBoard();
  evaStageSelfS();
  ST.resize = true;
  evaStageStartS();
}
// 11/06 使用者:「資訊」面板顯示 設定 RTP / 昨日 RTP / 今日 RTP(00:00 起)/ 近 1 小時 RTP。
// 數字由 gateway 已登入 WS 提供(百分比與倍率,每分鐘更新);功能沒開(on:false)整塊隱藏。
function evaRtpRender(d) {
  const box = EVA.panel && EVA.panel.querySelector('.eva-info');
  if (!box) return;
  box.classList.toggle('hidden', !(d && d.on));
  if (!(d && d.on)) return;
  const f = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
  const top = (x, at) => typeof x === 'number' && Number.isFinite(x) && x > 0 ? `${x.toLocaleString('en-US', { maximumFractionDigits: 2 })} 倍${/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(at) ? `<small>${at}</small>` : ''}` : '—';
  const rows = [['設定 RTP', typeof d.set === 'number' ? `${d.set}%` : '—'], ['昨日 RTP', f(d.yesterday)], ['今日 RTP(00:00 起)', f(d.today)], ['近 1 小時 RTP', f(d.hour)],
    ['歷史最高倍率', top(d.maxX, d.maxAt)],
    ['本日最高倍率', top(d.dayMaxX, d.dayMaxAt)],
    ['個人歷史最高倍率', top(d.personalMaxX, d.personalMaxAt)]];
  const t = d.at ? new Date(d.at) : null;
  const hm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  box.querySelector('.eva-info-body').innerHTML = rows.map(([k, v]) => `<div class="eva-info-row"><span>${k}</span><b>${v}</b></div>`).join('')
    + `<p class="eva-info-note">${d.warming ? '統計整理中，請稍後重新展開資訊。' : `昨日、今日、近 1 小時為全服實際統計，每分鐘更新${hm ? `（${hm}）` : ''}。短時間內的數字起伏較大。`}</p>`;
}
function evaRtpLoad() {
  send({ t: 'evaRtp' });
}

function evaClose() {
  EVA.auto = false;
  if (EVA.busy) { EVA.fast = true; return; } // 動畫播完才關,先快轉
  EVA.panel?.classList.add('hidden');
  evaStageStop();
  evaFxStop();
}

function evaBuild() {
  const p = el('div', 'eva-panel hidden');
  p.innerHTML = `<div class="eva-box">
      <div class="eva-head"><b>伊娃的寶藏</b><button type="button" class="eva-x" aria-label="關閉">✕</button></div>
      <div class="eva-bar"><span class="eva-gold"></span><span class="eva-free hidden"></span></div>
      <div class="eva-grid"></div>
      <div class="eva-msg">&nbsp;</div>
      <div class="eva-bets"></div>
      <div class="eva-actions"><button type="button" class="eva-spin">轉 動</button><button type="button" class="eva-auto">自動轉</button></div>
      <div class="eva-foot"></div>
      <details class="eva-rule"><summary>玩法說明</summary>
        <p>盤面上同一種圖案出現 8 個以上就中獎(不看連線),中獎的圖案消失、上面的往下掉,可以連續中獎。</p>
        <p>魔法寶石帶有 2~500 倍的倍數:這一轉有贏分時,盤面上所有倍數加總後乘上贏分。</p>
        <p>出現 4 個以上藏寶箱:送 15 次免費遊戲;免費遊戲中倍數會累積,出現 3 個以上藏寶箱再加 5 次(最多 100 次)。</p>
        <p class="eva-rule-max"></p>
        <p>自動轉:按一下就一直轉,再按一次停止;金幣不足、關掉視窗或切到別的畫面時會自動停。</p>
      </details>
      <details class="eva-info hidden"><summary>資訊</summary><div class="eva-info-body"></div></details>
      <details class="eva-disclaimer"><summary>免責聲明</summary>
        <p><b>娛樂遊戲聲明</b></p>
        <p>本機台為《娜緹夏天堂》遊戲內娛樂功能，使用遊戲中取得的天幣參與，所有結果均由隨機機制決定。</p>
        <p>天幣僅供遊戲內裝備強化、道具購買及角色成長等用途。官方不提供天幣與現金之間的兌換服務，亦禁止任何形式的現金交易。</p>
        <p>本機台不提供現金或其他現實財物獎勵，請玩家理性參與。</p>
      </details>
    </div>`;
  document.body.appendChild(p);
  EVA.panel = p;
  evaStageBuildS(p);
  p.querySelector('.eva-x').onclick = evaClose;
  p.querySelector('.eva-info').addEventListener('toggle', (ev) => { if (ev.target.open) evaRtpLoad(); }); // 11/06 RTP 面板:點開才更新
  p.querySelector('.eva-spin').onclick = () => { EVA.auto = false; evaSpin(); };
  p.querySelector('.eva-auto').onclick = () => {
    if (EVA.auto) { EVA.auto = false; evaRenderInfo(); return; } // 自動轉中再按 = 停(這一轉播完就停)
    EVA.auto = true;
    EVA.autoN = 0;
    if (!EVA.busy) evaSpin(); else evaRenderInfo();
  };
  p.querySelector('.eva-grid').onclick = () => { if (EVA.busy) EVA.fast = true; }; // 點盤面快轉
  p.addEventListener('click', (e) => { if (e.target === p) evaClose(); });
  const grid = p.querySelector('.eva-grid');
  const dpr = evaDpr();
  for (let i = 0; i < EVA_COLS * EVA_ROWS; i++) {
    const cell = el('div', 'eva-cell');
    const face = el('div', 'eva-face');
    const cv = document.createElement('canvas');
    cv.className = 'eva-ic';
    cv.width = cv.height = Math.round(EVA_ICON * dpr);
    face.appendChild(cv);
    face.appendChild(el('b', 'eva-x-tag', ''));
    cell.appendChild(face);
    grid.appendChild(cell);
  }
  grid.appendChild(el('div', 'eva-banner hidden', ''));
}

const evaFmt = (n) => Number(n || 0).toLocaleString('zh-TW');
// 代金券(99226,面額 1,000;伺服器 L1EvaTreasure):押 1,000 而且身上有代金券時,伺服器先扣 1 張代金券、不扣金幣,所以沒金幣也能轉
// 使用者 10/20 再改規格:每張代金券 = 1,000;押注 1,000 / 2,000 / 5,000 / 10,000 且代金券張數夠(>= 押注 ÷ 1,000)時,押注鈕顯示「代金券×N」,轉這一注不需要金幣;不夠就顯示一般金額(用金幣)
const EVA_VOUCHER_UNIT = 1000;
const evaVoucherN = (bet) => (bet >= EVA_VOUCHER_UNIT && bet % EVA_VOUCHER_UNIT === 0 && (EVA.info?.vouchers ?? 0) >= bet / EVA_VOUCHER_UNIT ? bet / EVA_VOUCHER_UNIT : 0);
const evaBetLabel = (bet) => (evaVoucherN(bet) ? `代金券×${evaVoucherN(bet)}` : evaFmt(bet));
const evaCanAfford = (bet) => evaVoucherN(bet) > 0 || (EVA.info?.adena ?? 0) >= bet;

function evaRenderInfo() {
  const p = EVA.panel;
  const info = EVA.info;
  if (!p || !info) return;
  p.querySelector('.eva-gold').textContent = `金幣 ${evaFmt(info.adena)}${info.vouchers > 0 ? ` · 代金券 ×${evaFmt(info.vouchers)}` : ''}`;
  const bets = info.bets || [];
  if (!bets.includes(EVA.bet)) EVA.bet = bets.includes(+evaStore('evaBet')) ? +evaStore('evaBet') : bets[0] || 0;
  const box = p.querySelector('.eva-bets');
  box.textContent = '';
  for (const b of bets) {
    const btn = el('button', `eva-bet${b === EVA.bet ? ' on' : ''}`, evaBetLabel(b));
    btn.type = 'button';
    btn.onclick = () => { if (EVA.busy) return; EVA.bet = b; evaStore('evaBet', b); evaRenderInfo(); };
    box.appendChild(btn);
  }
  const spin = p.querySelector('.eva-spin');
  spin.disabled = EVA.busy || !EVA.bet || !evaCanAfford(EVA.bet);
  spin.textContent = EVA.busy ? '轉動中…' : `轉 動(押 ${evaBetLabel(EVA.bet)})`;
  const auto = p.querySelector('.eva-auto');
  auto.classList.toggle('on', EVA.auto);
  auto.textContent = EVA.auto ? `停止(${EVA.autoN})` : '自動轉';
  auto.disabled = !EVA.auto && (!EVA.bet || !evaCanAfford(EVA.bet));
  const mx = p.querySelector('.eva-rule-max');
  mx.textContent = info.maxX ? `每次押注最高可贏得押注的 ${evaFmt(info.maxX)} 倍。` : '';
  // 每日押注不設上限(使用者 10/17:「頁面也不要寫上限」):只顯示今天押了多少
  p.querySelector('.eva-foot').textContent = info.used != null ? `今天已押 ${evaFmt(info.used)}${EVA.usedVouchers > 0 ? ` · 這轉使用代金券 ${EVA.usedVouchers} 張` : ''}` : '';
}

// ---------------- 畫格子 ----------------

// 每種圖案先畫好一張(建立滾動帶與顯示結果時重用,轉動中不重畫)
function evaSymCanvas(s) {
  if (!EVA.sym) EVA.sym = [];
  if (!EVA.sym[s]) {
    const sym = EVA.info?.symbols?.[s];
    EVA.sym[s] = sym ? iconCanvas({ name: sym.name, gfx: sym.gfx }, EVA_ICON) : null;
  }
  return EVA.sym[s];
}
function evaCells() { return EVA.panel.querySelectorAll('.eva-cell'); }
function evaPaint(cell, s, mult) {
  const cv = cell.querySelector('.eva-ic');
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const src = evaSymCanvas(s);
  if (src) g.drawImage(src, 0, 0, cv.width, cv.height);
  const tag = cell.querySelector('.eva-x-tag');
  tag.textContent = (s === EVA_MULT && mult) ? `×${mult}` : '';
  cell.classList.toggle('scatter', s === EVA_SCATTER);
  cell.classList.toggle('mult', s === EVA_MULT);
  cell.dataset.k = `${s}:${mult || 0}`;
}
function evaAnim(cell, cls, delayMs) {
  evaCancelMotion(cell);
  evaReelFinish(cell);
  cell.classList.remove('drop', 'out', 'pop', 'hit', 'zap');
  cell.style.transform = '';
  cell.style.opacity = '';
  cell.style.animationDelay = '0ms';
  if (cls === 'drop') {
    if (evaReduced() || EVA.fast || document.hidden) return;
    const delay = delayMs || 0;
    evaMotion(cell, delay + 340, (dt) => {
      const t = Math.max(0, Math.min(1, (dt - delay) / 340));
      const e = 1 - (1 - t) ** 3; // 單調減速,沒有原本 cubic-bezier 的過衝 / 彈回
      cell.style.transform = `translate3d(0, ${-160 * (1 - e)}%, 0)`;
      cell.style.opacity = String(.25 + .75 * e);
    }, () => { cell.style.transform = ''; cell.style.opacity = ''; });
    return;
  }
  if (cls) cell.classList.add(cls);
}
// 打開視窗時先放一張隨機盤面(不會中獎的樣子就好)
function evaIdleBoard() {
  const cells = evaCells();
  for (let k = 0; k < cells.length; k++) evaPaint(cells[k], Math.floor(Math.random() * 9), 0);
}

// 畫一張盤面:g = 圖案、m = 倍數;格子 index = 欄 * 5 + 列,畫面上一列一列排。
// drop:true = 整盤一欄一欄掉下來;'changed' = 只有變了的格子從上面掉下來(消除後補上)
function evaDrawFrame(g, m, { drop }) {
  const cells = evaCells();
  const fast = EVA.fast;
  for (let c = 0; c < EVA_COLS; c++) {
    let fresh = 0; // 這一欄有幾格是新的(掉的距離)
    for (let r = EVA_ROWS - 1; r >= 0; r--) {
      const i = c * EVA_ROWS + r;
      const cell = cells[r * EVA_COLS + c];
      const key = `${g[i]}:${m[i] || 0}`;
      const changed = cell.dataset.k !== key;
      evaPaint(cell, g[i], m[i]);
      // 全盤在既有 700ms 內停齊;補圖在 420ms 內停齊,不讓下一次 hit 打斷掉落。
      if (drop === true) {
        const delay = fast ? 0 : c * 60 + (EVA_ROWS - 1 - r) * 15;
        if (cell._evaReel) evaLandReel(cell, delay);
        else evaAnim(cell, 'drop', delay);
      }
      else if (drop === 'changed' && changed) { fresh++; evaAnim(cell, 'drop', fast ? 0 : c * 12 + fresh * 4); }
      else evaAnim(cell, null, 0);
    }
  }
  EVA.last = { g, m };
}

// ---------------- 轉動動畫 ----------------

// 所有格子共用一個 rAF。timer 只負責有限動畫的截止點,不是逐格計時器;
// 掉幀依 performance.now 補到同一條軌跡,背景沒有 rAF 也能完成等待。
const EVA_MOTIONS = new Map();
function evaCancelMotion(node) {
  const a = EVA_MOTIONS.get(node);
  if (!a) return;
  clearTimeout(a.timer);
  EVA_MOTIONS.delete(node);
  if (a.cancel) a.cancel();
  if (!EVA_MOTIONS.size && EVA.loop) { cancelAnimationFrame(EVA.loop); EVA.loop = 0; }
}
function evaQueueMotion() {
  if (!EVA.loop && EVA_MOTIONS.size && !document.hidden) EVA.loop = requestAnimationFrame(evaMotionFrame);
}
function evaMotion(node, ms, draw, done, cancel) {
  evaCancelMotion(node);
  const a = { t0: performance.now(), ms, draw, done, cancel, timer: 0 };
  EVA_MOTIONS.set(node, a);
  if (Number.isFinite(ms)) a.timer = setTimeout(() => evaFinishMotion(node, a), ms);
  draw(0);
  evaQueueMotion();
  return a;
}
function evaFinishMotion(node, a) {
  if (EVA_MOTIONS.get(node) !== a) return;
  a.draw(a.ms);
  evaCancelMotion(node);
  if (a.done) a.done();
}
function evaFinishMotions() {
  for (const [node, a] of EVA_MOTIONS) if (Number.isFinite(a.ms)) evaFinishMotion(node, a);
  if (EVA.loop) cancelAnimationFrame(EVA.loop);
  EVA.loop = 0;
}
function evaMotionFrame() {
  EVA.loop = 0;
  const now = performance.now();
  for (const [node, a] of EVA_MOTIONS) {
    if ((a.fast && EVA.fast) || now - a.t0 >= a.ms) evaFinishMotion(node, a);
    else a.draw(now - a.t0);
  }
  evaQueueMotion();
}
function evaReelPosition(reel, distance) {
  reel.distance = distance; // 不取餘數的邏輯位置;供停格沿用,永遠向下
  const phase = distance % 3;
  reel.strip.style.transform = `translate3d(0, ${(-5 + phase) * 100 / 6}%, 0)`;
}
function evaReelFinish(cell) {
  const reel = cell._evaReel;
  if (!reel) return;
  reel.face.style.visibility = '';
  reel.face.style.transform = '';
  reel.strip.classList.add('hidden');
  reel.strip.style.transform = '';
  cell.classList.remove('reeling');
  cell._evaReel = null;
}
function evaStartSpinFx() {
  evaStopSpinFx();
  const cells = evaCells();
  EVA.spinT0 = performance.now();
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    evaAnim(cell, null, 0);
    if (evaReduced() || EVA.fast || document.hidden) continue;
    const cv = cell.querySelector('.eva-ic');
    const face = cell.querySelector('.eva-face');
    let strip = cell.querySelector('.eva-reel');
    if (!strip) { strip = document.createElement('canvas'); strip.className = 'eva-reel'; cell.appendChild(strip); }
    const size = Math.round(cv.width / .84);
    strip.width = size; strip.height = size * 6;
    const g = strip.getContext('2d');
    const icons = [evaSymCanvas(Math.floor(Math.random() * 9)), evaSymCanvas(Math.floor(Math.random() * 9)), cv];
    // 兩份相同的三格帶,循環邊界的像素相同;每轉只畫一次,逐幀只移動 transform。
    for (let r = 0; r < 6; r++) {
      const src = icons[r % 3];
      if (src) g.drawImage(src, size * .08, size * (r + .08), size * .84, size * .84);
      if (r % 3 === 2 && cell.querySelector('.eva-x-tag').textContent) {
        g.font = `bold ${11 * size / (EVA_ICON / .84)}px sans-serif`;
        g.textAlign = 'right'; g.fillStyle = '#fff3b0';
        g.fillText(cell.querySelector('.eva-x-tag').textContent, size * .98, size * (r + .98));
      }
    }
    const reel = { face, strip, size, t0: EVA.spinT0 + (k % EVA_COLS) * 35, distance: 0 };
    cell._evaReel = reel;
    face.style.visibility = 'hidden';
    strip.classList.remove('hidden');
    cell.classList.add('reeling');
    evaMotion(cell, Infinity, () => evaReelPosition(reel, Math.max(0, (performance.now() - reel.t0) / 140)));
  }
}
function evaLandReel(cell, delay) {
  const reel = cell._evaReel;
  if (evaReduced() || EVA.fast || document.hidden) { evaCancelMotion(cell); evaReelFinish(cell); return; }
  const start = performance.now();
  const at = Math.max(0, (start + delay - reel.t0) / 140);
  const phase = at % 3;
  const target = Math.ceil(phase) + 1; // 結果放在還沒進入視窗的下一格,不覆蓋眼前圖案
  const travel = target - phase;
  const row = 5 - target;
  let prepared = false;
  evaMotion(cell, delay + 340, (dt) => {
    if (dt < delay) { evaReelPosition(reel, Math.max(0, (start + dt - reel.t0) / 140)); return; }
    if (!prepared) {
      reel.strip.getContext('2d').clearRect(0, row * reel.size, reel.size, reel.size);
      reel.face.style.visibility = '';
      prepared = true;
    }
    const t = Math.min(1, (dt - delay) / 340);
    // Hermite:接上轉動速度(1 格 / 140ms),終速 0;travel 在 [1, 2],導數不為負。
    const v = 340 / 140;
    const moved = (v - 2 * travel) * t ** 3 + (3 * travel - 2 * v) * t ** 2 + v * t;
    reel.distance = at + moved;
    reel.strip.style.transform = `translate3d(0, ${(-5 + phase + moved) * 100 / 6}%, 0)`;
    reel.face.style.transform = `translate3d(0, ${(moved - travel) * 100}%, 0)`;
  }, () => evaReelFinish(cell));
}
function evaStopSpinFx() {
  EVA.spinId++; // 取消前一轉尚未觸發的裝飾回呼(含免費遊戲沿用同一隻 BOSS)
  if (!EVA.panel) return;
  for (const cell of evaCells()) {
    if (cell._evaReel) { evaCancelMotion(cell); evaReelFinish(cell); }
  }
}

const evaSleep = (ms) => new Promise((res) => setTimeout(res, EVA.fast ? Math.min(ms, 40) : ms));

// 中間跳大字(倍數、免費遊戲、大獎)
async function evaBanner(text, ms, cls = '') {
  const b = EVA.panel.querySelector('.eva-banner');
  b.className = `eva-banner ${cls}`;
  b.textContent = text;
  b.classList.add('show');
  await evaSleep(ms);
  b.className = 'eva-banner hidden';
}

// 贏分數字往上跳
async function evaCount(node, from, to, prefix, suffix = '') {
  const ms = EVA.fast ? 0 : Math.min(900, 250 + Math.log10(Math.max(10, to - from)) * 120);
  // 保留原本 16ms 計數器的完成時間,減少動態效果也不提早顯示結算。
  const duration = Math.ceil(ms / 16) * 16;
  await new Promise((res) => {
    const a = evaMotion(node, document.hidden ? 0 : duration, (dt) => {
      const t = ms && !document.hidden && !EVA.fast ? Math.min(1, dt / ms) : 1;
      const value = evaReduced() && t < 1 ? from : Math.round(from + (to - from) * (1 - (1 - t) * (1 - t)));
      const text = `${prefix}${evaFmt(value)}${suffix}`;
      if (node.textContent !== text) node.textContent = text;
    }, res, res);
    a.fast = true; // 點盤面快轉時,下一個 rAF 就完成原本的數字等待
  });
}

// 一轉:第一張盤面掉下來,每次消除:發亮 → 放大消失 → 補上;回傳這一轉的消除贏分(還沒乘倍數)
async function evaFrames(frames, msgPrefix, firstDrop) {
  const msg = EVA.panel.querySelector('.eva-msg');
  const cells = evaCells();
  let sum = 0;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    evaDrawFrame(f.g, f.m, { drop: k === 0 ? firstDrop : 'changed' });
    await evaSleep(k === 0 ? 700 : 420);
    if (f.rm && f.rm.length) {
      for (const i of f.rm) { const c = Math.floor(i / EVA_ROWS); const r = i % EVA_ROWS; evaAnim(cells[r * EVA_COLS + c], 'hit', 0); }
      evaStageStrikeS(f);
      const before = sum;
      sum += f.w || 0;
      evaCount(msg, before, sum, `${msgPrefix}贏分 `);
      await evaSleep(520);
      for (const i of f.rm) { const c = Math.floor(i / EVA_ROWS); const r = i % EVA_ROWS; evaAnim(cells[r * EVA_COLS + c], 'pop', 0); }
      await evaSleep(230);
    }
  }
  return sum;
}

function evaSpin() {
  if (EVA.busy || !EVA.bet) return;
  if (!evaCanAfford(EVA.bet)) { EVA.auto = false; EVA.panel.querySelector('.eva-msg').textContent = '金幣不足'; evaRenderInfo(); return; }
  EVA.busy = true;
  EVA.fast = false;
  if (typeof adena === 'function') evaHold({ frozen: evaGoldShown(adena()) }); // 結果回來之前,狀態列的金幣先停住
  const msg = EVA.panel.querySelector('.eva-msg');
  msg.classList.remove('big');
  msg.textContent = ' ';
  evaRenderInfo();
  EVA.retry = 0;
  evaStageNewRoundS();
  evaStartSpinFx();
  evaSend();
}
function evaSend() {
  EVA.sentAt = performance.now();
  EVA.waiting = true;
  clearTimeout(EVA.reqTimer);
  EVA.reqTimer = setTimeout(evaNoReply, EVA_REPLY_TIMEOUT_MS);
  send({ t: 'eva', op: 1, bet: EVA.bet });
}
// 送出後一直沒回(斷線、切到背景時結果沒收到):停下來,重新要金幣(伺服器那邊可能已經轉完並發獎了)
function evaNoReply() {
  if (!EVA.waiting) return;
  EVA.waiting = false;
  EVA.auto = false;
  evaHold(null);
  evaStopSpinFx();
  if (EVA.last) evaDrawFrame(EVA.last.g, EVA.last.m, { drop: false });
  EVA.busy = false;
  EVA.panel.querySelector('.eva-msg').textContent = '連線不穩,這一轉的結果沒收到,請看金幣有沒有變動';
  send({ t: 'eva', op: 0, bet: 0 });
  evaRenderInfo();
}

// ---------------- 戰鬥舞台(盤面上方的小舞台;純裝飾,照伺服器已送的 frames 播,不影響結果) ----------------
// 左 = 玩家自己的角色,右 = 一隻怪。每次消除 = 角色出手、怪跳傷害數字、中獎圖案從怪身上噴向盤面;
// 倍數寶石 = 魔法爆閃 +「×N」;免費遊戲 = 換 BOSS(死亡騎士)+ 怒氣條;大獎 / 免費遊戲結束 = 怪倒下爆裝。
// 只用已經有的素材(玩家外型、怪的外型都是原版精靈圖;BOSS 圖第一次出現才下載),特效全部程式畫,不增加下載量。
// 舞台的動畫全部是「同時播」,不佔用原本每轉的等待時間,所以自動轉的節奏不變。
const EVA_MOBS = [1022, 152, 1020]; // 哥布林、食人妖精、歐吉(使用者 10/20 指定)
const EVA_MOB_SCALE = { 1022: 1.35, 152: 1.1, 1020: 0.9 }; // 各隻怪的顯示倍率(歐吉很大,縮小才不會頂到舞台上緣)
const EVA_BOSS_GFX = 11616; // 死亡騎士
const ST = { on: true, cv: null, g: null, w: 0, h: 0, dpr: 1, raf: 0, P: null, M: null, boss: false, rage: 0, rageFlash: 0, resize: true, lastFrame: -Infinity, parts: [], texts: [], flashes: [], shake: 0 };
const evaStageEnabled = () => evaStore('evaStage') !== '0';

function evaStageBuild(p) {
  const cv = document.createElement('canvas');
  cv.className = 'eva-stage';
  p.querySelector('.eva-box').insertBefore(cv, p.querySelector('.eva-grid'));
  ST.cv = cv;
  ST.g = cv.getContext('2d');
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { ST.resize = true; }).observe(cv);
  window.addEventListener('resize', () => { ST.resize = true; });
  const opt = el('button', 'eva-stage-opt', '');
  opt.type = 'button';
  p.querySelector('.eva-foot').after(opt);
  opt.onclick = () => {
    ST.on = !ST.on;
    evaStore('evaStage', ST.on ? 1 : 0);
    evaStageApply();
  };
  ST.on = evaStageEnabled();
  evaStageApply();
}
function evaStageApply() {
  const opt = EVA.panel.querySelector('.eva-stage-opt');
  opt.textContent = ST.on ? '戰鬥動畫:開(點一下關閉)' : '戰鬥動畫:關(點一下開啟)';
  ST.cv.classList.toggle('hidden', !ST.on);
  if (ST.on) evaStageStart(); else { evaStageStop(); evaFxStop(); }
}
function evaStageSelf() {
  let me = null;
  try { me = typeof self === 'function' ? self() : null; } catch { me = null; }
  ST.P = { gfx: me?.gfx ?? 61, kind: 'pc', heading: 2, weapon: me?.weapon || 0, id: 7 };
}
function evaStageMonster(gfx) {
  ST.M = { gfx, kind: 'monster', heading: 6, id: 11 };
}
function evaStageSize() {
  ST.resize = false;
  const w = ST.cv.clientWidth || 380;
  // Desktop canvas resolution follows its CSS height; touch keeps the original size.
  const h = matchMedia('(pointer: fine)').matches ? (ST.cv.clientHeight || 128) : w < 340 ? 104 : 128;
  const dpr = evaDpr();
  if (ST.w !== w || ST.h !== h || ST.dpr !== dpr) {
    ST.w = w; ST.h = h; ST.dpr = dpr;
    ST.cv.width = Math.round(w * dpr);
    ST.cv.height = Math.round(h * dpr);
    if (!matchMedia('(pointer: fine)').matches) ST.cv.style.height = `${h}px`; // 10/28:電腦版高度交給 CSS(以前寫回 clientHeight 會每次少 2px 外框,電腦直式一直縮小再跳回 = 視窗一直跳)
  }
}
function evaStageStart() {
  if (evaReduced() || document.hidden || !ST.on || !EVA.panel || EVA.panel.classList.contains('hidden')) return;
  ST.resize = true;
  ST.lastFrame = -Infinity;
  if (!ST.P) evaStageSelf();
  if (!ST.M) evaStageMonster(EVA_MOBS[0]);
  if (!ST.raf) ST.raf = requestAnimationFrame(evaStageLoop);
}
function evaStageStop() {
  if (ST.raf) cancelAnimationFrame(ST.raf);
  ST.raf = 0;
}
// 每轉開始:換一隻新怪(上一轉倒下的復活;免費遊戲留下來的 BOSS 退場)
function evaStageNewRound() {
  evaFxStop();
  evaStageSelf();
  ST.boss = false;
  ST.rage = 0;
  evaStageMonster(EVA_MOBS[(Math.random() * EVA_MOBS.length) | 0]);
  ST.parts.length = 0;
}
const evaStageLive = () => ST.on && !evaReduced() && !EVA.fast && ST.raf && !document.hidden;

function evaStageNum(n) { return n >= 100000000 ? `${(n / 100000000).toFixed(1)}億` : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}萬` : evaFmt(n); }

// 一次消除:角色出手 → 怪被打中、跳傷害數字,中獎圖案從怪身上噴向盤面
function evaStageStrike(f) {
  if (!evaStageLive() || !f.rm?.length) return;
  const now = performance.now();
  const P = ST.P;
  const M = ST.M;
  const spinId = EVA.spinId;
  P.lunge = now; P.lungeMs = 420;
  setTimeout(() => {
    if (!evaStageLive() || ST.M !== M || EVA.spinId !== spinId) return;
    const t = performance.now();
    M.hurt = t; M.hurtMs = 280;
    ST.shake = t + 160;
    if (f.w > 0) ST.texts.push({ s: evaStageNum(f.w), x: ST.w * 0.74 + (Math.random() * 24 - 12), y: ST.h - 84, vy: -0.03, t0: t, life: 900, c: ST.boss ? '#ff9a7a' : '#ffe08a', sz: 17 });
    let n = 0;
    for (const i of f.rm) {
      if (n++ >= 8) break; // 一次最多噴 8 個,不然太亂
      ST.parts.push({ ic: evaSymCanvas(f.g[i]), x: ST.w * 0.74, y: ST.h - 46, vx: -0.12 - Math.random() * 0.1 + (Math.random() - 0.5) * 0.12, vy: -0.28 - Math.random() * 0.12, t0: t, life: 800 });
    }
  }, 170);
}
// 倍數寶石:從舞台上的玩家劈閃電(鋸齒折線 + 白藍光暈 + 閃爍)到盤面上每一顆魔法寶石,被劈到的寶石亮起震一下,
// 「×N」再從寶石飛到怪身上。閃電畫在蓋住整個視窗的透明 canvas 上(舞台 canvas 在盤面上方,畫不到盤面),只在有特效時才跑 rAF。
const FX = { cv: null, g: null, raf: 0, bolts: [], labels: [], glows: [] };
function evaFxEnsure() {
  if (FX.cv) return;
  const cv = document.createElement('canvas');
  cv.className = 'eva-fx';
  EVA.panel.appendChild(cv);
  FX.cv = cv;
  FX.g = cv.getContext('2d');
}
function evaFxSize() {
  const dpr = evaDpr();
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (FX.cv.width !== Math.round(w * dpr) || FX.cv.height !== Math.round(h * dpr)) {
    FX.cv.width = Math.round(w * dpr);
    FX.cv.height = Math.round(h * dpr);
  }
  return dpr;
}
// 兩點之間的鋸齒折線(兩端偏移小、中間大)
function evaBoltPoints(a, b) {
  const n = 9;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const pts = [{ x: a.x, y: a.y }];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const amp = Math.sin(t * Math.PI) * Math.min(26, len * 0.14);
    const o = (Math.random() * 2 - 1) * amp;
    pts.push({ x: a.x + dx * t + nx * o, y: a.y + dy * t + ny * o });
  }
  pts.push({ x: b.x, y: b.y });
  return pts;
}
function evaFxStroke(g, pts, w, col) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.lineWidth = w;
  g.strokeStyle = col;
  g.stroke();
}
function evaFxStop() {
  if (FX.raf) cancelAnimationFrame(FX.raf);
  FX.raf = 0;
  FX.bolts.length = 0; FX.labels.length = 0; FX.glows.length = 0;
  if (FX.g) { FX.g.setTransform(1, 0, 0, 1, 0, 0); FX.g.clearRect(0, 0, FX.cv.width, FX.cv.height); }
}
function evaFxStart() {
  if (evaReduced() || document.hidden) return;
  if (!FX.raf) FX.raf = requestAnimationFrame(evaFxLoop);
}
function evaFxLoop(now) {
  try { evaFxFrame(now); } catch { if (FX.raf) cancelAnimationFrame(FX.raf); FX.raf = 0; FX.bolts.length = 0; FX.labels.length = 0; FX.glows.length = 0; }
}
function evaFxFrame(now) {
  FX.raf = 0;
  if (!FX.cv) return;
  if (!evaStageLive()) { evaFxStop(); return; }
  const dpr = evaFxSize();
  const g = FX.g;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, window.innerWidth, window.innerHeight);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = FX.bolts.length - 1; i >= 0; i--) {
    const b = FX.bolts[i];
    const dt = now - b.t0;
    if (dt >= b.life) { FX.bolts.splice(i, 1); continue; }
    if (dt < 0) continue; // 還沒輪到(依序劈)
    // 每 60 ms 重畫一次折線形狀 = 閃爍;最後 1/3 時間漸隱
    const fr = Math.floor(dt / 60);
    if (b.fr !== fr) {
      b.fr = fr;
      b.pts = evaBoltPoints(b.a, b.b);
      b.fork = [];
      const forks = 1 + ((Math.random() * 2) | 0);
      for (let k = 0; k < forks; k++) {
        const p = b.pts[2 + ((Math.random() * (b.pts.length - 4)) | 0)];
        const ang = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x) + (Math.random() - 0.5) * 1.6;
        b.fork.push(evaBoltPoints(p, { x: p.x + Math.cos(ang) * 34, y: p.y + Math.sin(ang) * 34 }));
      }
    }
    const alpha = dt > b.life * 0.66 ? 1 - (dt - b.life * 0.66) / (b.life * 0.34) : 1;
    g.save();
    g.globalAlpha = alpha;
    g.shadowColor = 'rgba(140, 190, 255, .95)';
    g.shadowBlur = EVA_MOBILE.matches ? 0 : 14;
    evaFxStroke(g, b.pts, 7, 'rgba(110, 160, 255, .35)');
    evaFxStroke(g, b.pts, 3, 'rgba(190, 225, 255, .95)');
    evaFxStroke(g, b.pts, 1.4, '#ffffff');
    for (const f of b.fork) { evaFxStroke(g, f, 3, 'rgba(150, 200, 255, .5)'); evaFxStroke(g, f, 1, '#eaf5ff'); }
    g.restore();
  }
  for (let i = FX.glows.length - 1; i >= 0; i--) {
    const q = FX.glows[i];
    const k = (now - q.t0) / q.life;
    if (k >= 1) { FX.glows.splice(i, 1); continue; }
    if (k < 0) continue;
    const r = 16 + k * 26;
    const gr = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
    gr.addColorStop(0, `rgba(220, 235, 255, ${0.9 * (1 - k)})`);
    gr.addColorStop(1, 'rgba(120, 170, 255, 0)');
    g.fillStyle = gr;
    g.fillRect(q.x - r, q.y - r, r * 2, r * 2);
  }
  for (let i = FX.labels.length - 1; i >= 0; i--) {
    const q = FX.labels[i];
    const dt = now - q.t0;
    if (dt >= q.life) { FX.labels.splice(i, 1); continue; }
    if (dt < 0) continue;
    const k = dt / q.life;
    const e = k * k * (3 - 2 * k);
    const x = q.a.x + (q.b.x - q.a.x) * e;
    const y = q.a.y + (q.b.y - q.a.y) * e - Math.sin(k * Math.PI) * 18;
    g.save();
    g.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
    g.font = `800 ${Math.round(16 + 6 * Math.sin(k * Math.PI))}px sans-serif`;
    g.textAlign = 'center';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0, 0, 40, .85)';
    g.fillStyle = '#e6f0ff';
    g.strokeText(q.s, x, y);
    g.fillText(q.s, x, y);
    g.restore();
  }
  if (FX.bolts.length || FX.labels.length || FX.glows.length) FX.raf = requestAnimationFrame(evaFxLoop);
  else g.clearRect(0, 0, window.innerWidth, window.innerHeight);
}
function evaStageMagic() {
  if (!evaStageLive()) return;
  evaFxEnsure();
  const sr = ST.cv.getBoundingClientRect();
  const from = { x: sr.left + ST.w * 0.24 + 6, y: sr.top + ST.h - 46 };
  const monster = { x: sr.left + ST.w * 0.74, y: sr.top + ST.h - 46 };
  const gems = [];
  evaCells().forEach((cell) => {
    const [s, m] = (cell.dataset.k || '').split(':').map(Number);
    if (s === EVA_MULT && m > 0) gems.push({ cell, m });
  });
  const now = performance.now();
  const round = ST.M;
  const spinId = EVA.spinId;
  gems.slice(0, 6).forEach((gm, k) => {
    const key = gm.cell.dataset.k;
    const r = gm.cell.getBoundingClientRect();
    const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const t0 = now + k * 190;
    FX.bolts.push({ a: from, b: to, t0, life: 340, fr: -1 });
    FX.glows.push({ x: from.x, y: from.y, t0, life: 260 }, { x: to.x, y: to.y, t0: t0 + 40, life: 320 });
    setTimeout(() => { // 寶石被劈到:亮起、震一下
      if (!evaStageLive() || ST.M !== round || EVA.spinId !== spinId) return;
      if (gm.cell._evaReel || gm.cell.dataset.k !== key) return;
      gm.cell.classList.add('zap');
      setTimeout(() => { if (EVA.spinId === spinId && gm.cell.dataset.k === key) gm.cell.classList.remove('zap'); }, 460);
    }, k * 190 + 40);
    FX.labels.push({ s: `×${gm.m}`, a: to, b: monster, t0: t0 + 260, life: 560 });
    setTimeout(() => { // ×N 砸到怪身上
      if (!evaStageLive() || ST.M !== round || EVA.spinId !== spinId) return;
      const t = performance.now();
      ST.M.hurt = t; ST.M.hurtMs = 360;
      ST.shake = t + 260;
      ST.flashes.push({ x: ST.w * 0.74, y: ST.h - 46, t0: t, life: 500, c: '190,220,255' });
    }, k * 190 + 260 + 560);
  });
  evaFxStart();
}
// 免費遊戲:換 BOSS(圖是第一次用才下載);acc = 累積倍數,多一點就怒氣條漲一點,再觸發時狂暴
function evaStageBoss(on) {
  if (!ST.on) return;
  ST.boss = on;
  ST.rage = 0;
  if (on) evaStageMonster(EVA_BOSS_GFX);
}
function evaStageRage(acc, grew) {
  if (!ST.on || !ST.boss) return;
  const prev = ST.rage;
  ST.rage = acc || 0;
  if (grew && ST.rage > prev) {
    ST.rageFlash = performance.now();
    if (evaStageLive()) {
      ST.shake = performance.now() + 400;
      ST.flashes.push({ x: ST.w * 0.74, y: ST.h - 46, t0: performance.now(), life: 600, c: '255,80,60' });
    }
  }
}
// 怪倒下:大獎 / 免費遊戲結束。big = 大獎(噴更多)
function evaStageDie(big) {
  if (!ST.on || !ST.M || ST.M.dead) return;
  const t = performance.now();
  ST.M.dead = true; ST.M.deadAt = t;
  if (!evaStageLive()) return;
  const n = big ? 26 : 10;
  for (let k = 0; k < n; k++) {
    const a = -Math.PI * (0.15 + Math.random() * 0.7);
    const v = 0.12 + Math.random() * (big ? 0.3 : 0.2);
    const sym = (Math.random() * 9) | 0;
    ST.parts.push({ ic: Math.random() < 0.5 ? evaSymCanvas(sym) : null, x: ST.w * 0.74, y: ST.h - 40, vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(a) * v - 0.08, t0: t, life: 1300, g: 0.00035 });
  }
  ST.flashes.push({ x: ST.w * 0.74, y: ST.h - 46, t0: t, life: 700, c: '255,210,90' });
}

// rAF 回呼:畫面出錯就停掉舞台(不再排下一格),不影響轉動播放
function evaStageLoop(now) {
  try { evaStageFrame(now); } catch { if (ST.raf) cancelAnimationFrame(ST.raf); ST.raf = 0; ST.on = false; }
}
function evaStageFrame(now) {
  ST.raf = 0;
  if (evaReduced() || document.hidden || !ST.on || !EVA.panel || EVA.panel.classList.contains('hidden')) return;
  ST.raf = requestAnimationFrame(evaStageLoop);
  // 手機裝飾舞台最多 30fps,格子仍跟隨螢幕 rAF;尺寸只在開啟 / resize 後讀取。
  if (EVA_MOBILE.matches && now - ST.lastFrame < 1000 / 30 - .1) return;
  ST.lastFrame = now;
  if (ST.resize) evaStageSize();
  const g = ST.g;
  const { w, h } = ST;
  g.setTransform(ST.dpr, 0, 0, ST.dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, ST.boss ? '#2a1010' : '#17120b');
  bg.addColorStop(1, ST.boss ? '#3a1512' : '#2b2113');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255, 220, 150, .08)';
  g.fillRect(0, h - 22, w, 22);
  const sx = ST.shake > now ? (Math.random() - 0.5) * 5 : 0;
  const foot = h - 14;
  if (!ST.P) evaStageSelf();
  if (!ST.M) evaStageMonster(EVA_MOBS[0]);
  const M = ST.M;
  const draw = (o, x, k) => {
    let r = 0;
    g.save();
    g.translate(x, foot);
    g.scale(k, k);
    try { r = typeof L1S !== 'undefined' && L1S.ready() ? L1S.drawCreature(g, o, 0, 0, now) : 0; } catch { r = 0; }
    g.restore();
    if (!r) { // 圖還沒載好(第一次載入 BOSS 圖等):先畫影子輪廓
      g.fillStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.ellipse(x, foot - 18, 14, 22, 0, 0, 7); g.fill();
    }
  };
  g.save();
  g.translate(sx, 0);
  draw(ST.P, w * 0.24, 1.15);
  if (!M.dead || now - M.deadAt < 900) draw(M, w * 0.74, ST.boss ? 1.0 : (EVA_MOB_SCALE[M.gfx] || 1.2)); // 倒地動畫播完就收掉
  g.restore();
  // BOSS 怒氣條
  if (ST.boss && !M.dead) {
    const bw = Math.min(150, w * 0.4);
    const bx = w * 0.74 - bw / 2;
    const fill = ST.rage / (ST.rage + 40);
    const fl = now - ST.rageFlash < 500;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(bx - 1, 7, bw + 2, 9);
    g.fillStyle = fl ? '#ffd0a0' : '#e0482a'; g.fillRect(bx, 8, bw * fill, 7);
    g.fillStyle = '#fff3d6'; g.font = '11px sans-serif'; g.textAlign = 'center';
    g.fillText(ST.rage > 0 ? `怒氣 ×${ST.rage}` : '怒氣', w * 0.74, 28);
  }
  // 閃光
  for (let i = ST.flashes.length - 1; i >= 0; i--) {
    const f = ST.flashes[i];
    const k = (now - f.t0) / f.life;
    if (k >= 1) { ST.flashes.splice(i, 1); continue; }
    const r = 14 + k * 70;
    const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    gr.addColorStop(0, `rgba(${f.c},${0.85 * (1 - k)})`);
    gr.addColorStop(1, `rgba(${f.c},0)`);
    g.fillStyle = gr;
    g.fillRect(f.x - r, f.y - r, r * 2, r * 2);
  }
  // 噴出的圖案 / 金幣:拋物線,往下飛出舞台(飛進盤面的感覺)
  for (let i = ST.parts.length - 1; i >= 0; i--) {
    const q = ST.parts[i];
    const dt = now - q.t0;
    if (dt >= q.life) { ST.parts.splice(i, 1); continue; }
    const gr = q.g ?? 0.0006;
    const x = q.x + q.vx * dt;
    const y = q.y + q.vy * dt + gr * dt * dt / 2;
    if (y > h + 20) { ST.parts.splice(i, 1); continue; }
    g.globalAlpha = Math.min(1, (q.life - dt) / 250);
    if (q.ic) g.drawImage(q.ic, x - 10, y - 10, 20, 20);
    else { g.fillStyle = '#ffd24a'; g.beginPath(); g.arc(x, y, 3.2, 0, 7); g.fill(); }
    g.globalAlpha = 1;
  }
  // 傷害數字 / ×N
  for (let i = ST.texts.length - 1; i >= 0; i--) {
    const q = ST.texts[i];
    const dt = now - q.t0;
    if (dt >= q.life) { ST.texts.splice(i, 1); continue; }
    const pop = dt < 120 ? 0.7 + dt / 400 : 1;
    g.save();
    g.globalAlpha = Math.min(1, (q.life - dt) / 300);
    g.font = `800 ${Math.round(q.sz * pop)}px sans-serif`;
    g.textAlign = 'center';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,.85)';
    g.fillStyle = q.c;
    const y = q.y + q.vy * dt;
    g.strokeText(q.s, q.x, y);
    g.fillText(q.s, q.x, y);
    g.restore();
  }
}

// 舞台 / 閃電只是畫面:任何一個瀏覽器在畫的時候丟例外,都不能中斷這一轉的動畫播放(結果和金幣是伺服器算的)。
// 在 spin 播放流程裡被同步呼叫的函式,對外一律走這層 try(畫面出錯就安靜略過)
const evaSafe = (fn) => (...a) => { try { return fn(...a); } catch { return undefined; } };
const evaStageBuildS = evaSafe(evaStageBuild);
const evaStageNewRoundS = evaSafe(evaStageNewRound);
const evaStageStrikeS = evaSafe(evaStageStrike);
const evaStageMagicS = evaSafe(evaStageMagic);
const evaStageBossS = evaSafe(evaStageBoss);
const evaStageRageS = evaSafe(evaStageRage);
const evaStageDieS = evaSafe(evaStageDie);
const evaStageStartS = evaSafe(evaStageStart);
const evaStageSelfS = evaSafe(evaStageSelf);

async function evaPlay(ev) {
  if (!EVA.panel) evaBuild();
  const p = EVA.panel;
  const msg = p.querySelector('.eva-msg');
  const freeTag = p.querySelector('.eva-free');
  evaHold(ev.win > 0 && Number.isFinite(+ev.adena) ? { win: +ev.win, final: +ev.adena } : null); // 贏分等動畫播完(finally)才出現在狀態列
  try {
    // 轉動動畫至少播 EVA_MIN_SPIN_MS(伺服器回得太快時也要有轉的感覺)
    const spun = performance.now() - EVA.spinT0;
    if (spun < EVA_MIN_SPIN_MS) await evaSleep(EVA_MIN_SPIN_MS - spun);
    freeTag.classList.add('hidden');
    const baseSum = await evaFrames(ev.base.frames, '', true);
    if (baseSum > 0 && ev.base.mult > 0) {
      evaStageMagicS(ev.base.mult);
      await evaBanner(`×${ev.base.mult}`, 850, 'mult');
      await evaCount(msg, baseSum, ev.base.win, '魔法寶石加乘 贏分 ');
      await evaSleep(350);
    }
    if (ev.free && ev.free.length) {
      evaStageBossS(true);
      let shown = Math.min(15, ev.free.length); // 11/06 使用者「先劇透」:先只顯示 15 次，再觸發才加，不先露出總轉數
      await evaBanner(`免費遊戲 ${shown} 次!`, 1400, 'free');
      let freeTotal = ev.scatterPay || 0;
      for (let i = 0; i < ev.free.length; i++) {
        const f = ev.free[i];
        freeTag.classList.remove('hidden');
        if (i + 1 > shown) shown = i + 1; // 保險:顯示的總數不會小於目前轉數
        freeTag.textContent = `免費遊戲 ${i + 1}/${shown} · 累積倍數 ×${f.acc || 0}`;
        // 免費遊戲每一轉也有短的轉動動畫
        evaStartSpinFx();
        await evaSleep(EVA.fast ? 0 : 480);
        const s = await evaFrames(f.frames, '免費遊戲 ', true);
        if (f.win > 0) {
          if (s > 0 && f.mult > 0) { evaStageRageS(f.acc, true); evaStageMagicS(f.acc); await evaBanner(`×${f.acc}`, 700, 'mult'); }
          const before = freeTotal;
          freeTotal += f.win;
          await evaCount(msg, before, freeTotal, '免費遊戲累計 ');
          await evaSleep(300);
        }
        if (f.retrig) { await evaBanner('再加 5 次!', 900, 'free'); shown = Math.min(ev.free.length, shown + 5); }
      }
      await evaSleep(400);
    }
    if (ev.free?.length || ev.x >= 20) evaStageDieS(ev.x >= 20);
    if (ev.win > 0) {
      if (ev.x >= 20) await evaBanner(ev.x >= 100 ? '超級大獎!' : '大獎!', 1300, 'big');
      msg.classList.toggle('big', ev.x >= 20);
      await evaCount(msg, 0, ev.win, '贏得 ', ` 金幣(${ev.x} 倍)${ev.capped ? ' · 已達單次上限' : ''}`);
    } else {
      msg.textContent = '沒有中獎,再試一次吧';
    }
  } finally {
    evaStopSpinFx();
    evaHold(null);
    if (EVA.info) { EVA.info.adena = ev.adena; EVA.info.used = ev.used; EVA.info.cap = ev.cap; if (ev.vouchers != null) EVA.info.vouchers = ev.vouchers; }
    EVA.usedVouchers = ev.vouchersUsed != null ? +ev.vouchersUsed : (ev.voucher ? 1 : 0); // 這轉用了幾張代金券(伺服器 vouchersUsed;舊版只有 voucher 布林 = 1 張),顯示在底部
    EVA.fast = false;
    // 下一轉:送出後滿 1.8 秒,而且收到回覆後滿 1.6 秒(伺服器是在這兩個時間點之間記下這一轉的,網路延遲忽快忽慢也不會被擋)
    const now = performance.now();
    const wait = Math.max(EVA_MIN_CYCLE_MS - (now - (EVA.sentAt || 0)), 1600 - (now - (EVA.replyAt || 0)));
    if (wait > 0) { evaRenderInfo(); await new Promise((res) => setTimeout(res, wait)); } // 按鈕先維持「轉動中…」
    EVA.busy = false;
    if (EVA.auto) EVA.autoN++;
    evaRenderInfo();
    // 自動轉:視窗開著、畫面在前景、金幣夠就接著轉(大獎多停一下讓人看清楚)
    if (EVA.auto) {
      const ok = EVA.panel && !EVA.panel.classList.contains('hidden') && !document.hidden && evaCanAfford(EVA.bet);
      if (!ok) { EVA.auto = false; evaRenderInfo(); } else setTimeout(() => { if (EVA.auto && !EVA.busy) evaSpin(); }, ev.x >= 20 ? 1500 : 250);
    }
  }
}

// 系統設定可以在視窗開著時改;僅收掉視覺效果,保留播放流程的等待。
EVA_REDUCED.addEventListener('change', () => {
  if (evaReduced()) {
    evaStopSpinFx();
    if (EVA.panel) for (const cell of evaCells()) {
      const a = EVA_MOTIONS.get(cell);
      if (a && Number.isFinite(a.ms)) evaFinishMotion(cell, a);
    }
    evaStageStop(); evaFxStop();
  } else evaStageStartS();
});
