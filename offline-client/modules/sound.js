// 音效:照 1.82 原版 list.spr 每一幀標的音效播放(tools/build_sounds.py 匯出 assets/sound/sfx.json + <N>.mp3)。
// 角色 / 怪物 / 特效的動畫播到標了音效的那一幀就播(只有畫面上畫出來的才會響);離自己越遠越小聲。
// 手機瀏覽器要使用者先點一下才能出聲:第一次點畫面 / 按鍵時才建立 AudioContext。
'use strict';

const SFX = (() => {
  const BASE = 'assets/sound/';
  const VER = '?v=1'; // 重跑 build_sounds.py 時改這個
  const MAX_DIST = 13; // 幾格以外聽不到
  const MAX_VOICES = 16; // 同時最多幾個聲音
  const STEP_VOL = 0.35; // 腳步聲比較小聲
  const settings = { on: true, vol: 70 };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('l1j.sound')) || {}); } catch { /* 沒有存過 */ }
  const save = () => { try { localStorage.setItem('l1j.sound', JSON.stringify(settings)); } catch { /* 無痕模式 */ } };

  let ac = null;
  let master = null;
  let table = null; // 外型 -> 動作 -> [[幀序號, 種類, 音效…], …]
  fetch(`${BASE}sfx.json${VER}`).then((r) => r.json()).then((t) => { table = t; }).catch(() => {});

  function unlock() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = settings.vol / 100;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
  }
  for (const e of ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown']) window.addEventListener(e, unlock, { capture: true, passive: true });

  const buffers = new Map(); // 音效編號 -> AudioBuffer;載入中是 Promise;載不到是 null
  function load(id) {
    if (buffers.has(id)) return Promise.resolve(buffers.get(id));
    const p = fetch(`${BASE}${id}.mp3${VER}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((buf) => new Promise((res, rej) => ac.decodeAudioData(buf, res, rej)))
      .then((b) => { buffers.set(id, b); return b; })
      .catch(() => { buffers.set(id, null); return null; });
    buffers.set(id, p);
    return p;
  }

  let voices = 0;
  const lastPlay = new Map(); // 同一個音效太密就不重疊(一群怪同時出手)
  function start(buf, vol) {
    if (!buf || voices >= MAX_VOICES) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(g).connect(master);
    voices++;
    src.onended = () => { voices--; };
    src.start();
  }
  function play(id, vol = 1) {
    if (!settings.on || !ac || ac.state !== 'running' || vol < 0.03) return;
    const now = performance.now();
    if (now - (lastPlay.get(id) || 0) < 60) return;
    lastPlay.set(id, now);
    const b = buffers.get(id);
    if (b === null) return;
    if (b && !(b instanceof Promise)) { start(b, vol); return; }
    // 第一次用到:下載完還來得及(0.4 秒內)就補播,太晚就算了(對不上動作)
    load(id).then((buf) => { if (performance.now() - now < 400) start(buf, vol); });
  }

  // 動作 → 動作編號(sprite 的 actions 物件反查)
  const actIds = new WeakMap();
  function actIdOf(actions, act) {
    let m = actIds.get(actions);
    if (!m) { m = new Map(); for (const k in actions) m.set(actions[k], +k); actIds.set(actions, m); }
    return m.get(act);
  }
  // 聲音的位置:物件(x, y);特效用固定位置、跟著的物件,或飛行特效的目的地
  function posOf(t) {
    if (t.follow != null && typeof st !== 'undefined') { const o = st.objects.get(t.follow); if (o) return o; }
    if (t.to) return t.to;
    return t;
  }
  function volumeAt(t) {
    const me = typeof self === 'function' ? self() : null;
    const p = posOf(t);
    if (!me || p.x == null) return 1;
    const d = Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y));
    return d >= MAX_DIST ? 0 : 1 - (d / MAX_DIST) * 0.85;
  }

  // 動畫畫到哪一幀(l1spr.js 每次畫的時候呼叫):換到有音效的幀就播;中間跳過的幀(畫面卡頓、長度 0 的幀)也補播
  // 特效的動作是重新整理過的(殘影搬到最後):actId 給原本的動作編號,idxMap[新幀序號] = 原本的幀序號
  function frame(tag, gfx, actions, act, f, actId = null, idxMap = null) {
    if (!table || !tag || !act) return;
    const idx = act[1].indexOf(f);
    if (idx < 0) return;
    const prevAct = tag._sfxAct;
    const prevIdx = tag._sfxIdx;
    if (prevAct === act && prevIdx === idx) return;
    tag._sfxAct = act;
    tag._sfxIdx = idx;
    const marks = table[gfx]?.[actId ?? actIdOf(actions, act)];
    if (!marks) return;
    // 同一個動作往後走:播 (上一幀, 這一幀];換了動作或重頭開始:播 [0, 這一幀](換算成原本的幀序號)
    const from = prevAct === act && idx > prevIdx ? prevIdx + 1 : 0;
    const hit = new Set();
    for (let i = from; i <= idx; i++) hit.add(idxMap ? idxMap[i] : i);
    let vol = -1;
    for (const m of marks) {
      if (!hit.has(m[0])) continue;
      if (vol < 0) vol = volumeAt(tag);
      const ids = m.slice(2);
      play(ids[(Math.random() * ids.length) | 0], m[1] === 1 ? vol * STEP_VOL : vol);
    }
  }

  return {
    frame, play, unlock, settings, save,
    get state() { return ac ? ac.state : 'none'; }, // 除錯用:running = 可以出聲
    setOn(on) { settings.on = !!on; save(); },
    setVolume(v) { settings.vol = Math.max(0, Math.min(100, v)); if (master) master.gain.value = settings.vol / 100; save(); },
  };
})();

// 背景音樂:照 1.82 原版 music.def(tools/build_music.py 匯出 assets/music/music.json + <N>.mp3)。
// 每 2 秒看自己在哪張地圖、哪一塊範圍,換區域就淡出舊的、淡入新的;一首播完照原版的間隔再重播。
// 登入畫面播 Login,死掉時播 Death。戰鬥中(打人 / 被打,停手 10 秒內)改播該區的 BATTLE,沒寫或 -1(村莊、地面)就用 Hunting,不管在哪都換。
// 設定和音效存在同一份(SFX.settings 的 music / musicOn)。
const MUSIC = (() => {
  const BASE = 'assets/music/';
  const VER = '?v=3'; // 重跑 build_music.py 時改這個(v3:只留登入 82 + 戰鬥 6 兩首,其他移到 l1j-web/music-unused)
  const s = SFX.settings;
  s.musicOn ??= true;
  s.music ??= 50;
  s.battleMusic ??= true; // 戰鬥音樂開關(設定 → 音效):關 = 戰鬥中也繼續播背景音樂,不切換
  let data = null;
  fetch(`${BASE}music.json${VER}`).then((r) => r.json()).then((d) => { data = d; }).catch(() => {});
  const audio = new Audio();
  audio.preload = 'auto';
  let cur = null; // 正在播(或要播)的編號
  let gap = 0; // 播完隔幾秒再播(秒)
  let replay = null;
  let fade = null;
  const target = () => (s.musicOn ? s.music / 100 : 0);

  function fadeTo(v, ms, done) {
    clearInterval(fade);
    const from = audio.volume;
    const t0 = performance.now();
    fade = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      audio.volume = Math.max(0, Math.min(1, from + (v - from) * k));
      if (k >= 1) { clearInterval(fade); fade = null; done?.(); }
    }, 50);
  }
  function start() {
    if (cur == null || !s.musicOn) return;
    audio.volume = 0;
    audio.play().then(() => fadeTo(target(), 1200)).catch(() => {}); // 還沒點過畫面:等 unlock 再播
  }
  // 縮小 / 切到背景:改成靜音繼續播(不暫停)。手機看到網頁還在播放,比較不會把網頁凍住、斷線;
  // 背景時播完馬上接著播(不等間隔),中間不留空檔。回到前台恢復音量
  let bgMute = false;
  document.addEventListener('visibilitychange', () => {
    bgMute = document.visibilityState === 'hidden';
    audio.muted = bgMute; // iOS 不能用程式改 volume,muted 才有效
    if (!bgMute && !audio.paused) { clearInterval(fade); fade = null; audio.volume = target(); }
  });
  audio.addEventListener('ended', () => {
    clearTimeout(replay);
    replay = setTimeout(start, bgMute ? 0 : (gap || 0) * 1000);
  });
  function want(id, interval) {
    if (id === cur) return;
    cur = id;
    gap = interval ?? 0;
    clearTimeout(replay);
    const go = () => {
      if (cur == null) { audio.pause(); return; }
      audio.src = `${BASE}${cur}.mp3${VER}`;
      start();
    };
    if (!audio.paused && audio.src) fadeTo(0, 800, go); else go();
  }
  // 這個位置該播哪首:有範圍的(村莊)取最小的那塊,沒有就用整張地圖的
  function pick(map, x, y) {
    if (!data) return null;
    let best = null;
    let whole = null;
    for (const z of data.zones) {
      if (z[0] !== map) continue;
      if (z[1] == null) { whole ??= z; continue; }
      if (x < z[1] || x > z[3] || y < z[2] || y > z[4]) continue;
      const area = (z[3] - z[1]) * (z[4] - z[2]);
      if (!best || area < best.area) best = { z, area };
    }
    const z = best?.z || whole;
    return z ? [z[5], z[6], z[7]] : null;
  }
  const tick = () => {
    if (!data) return;
    if (typeof st === 'undefined' || !st.inGame) { want(data.system.Login ?? null, 0); return; }
    const me = typeof self === 'function' ? self() : null;
    if (!me) return;
    if (me.dead) { want(data.system.Death ?? null, 0); return; }
    const m = pick(st.mapId, me.x, me.y);
    if (s.battleMusic !== false && performance.now() - (st.lastCombat || -1e9) < 10000) { want(m?.[2] > 0 ? m[2] : data.system.Hunting, 0); return; }
    if (m) want(m[0], m[1]);
  };
  setInterval(tick, 2000);
  // 第一次點畫面時(手機要使用者手勢才能播):把該播的播起來
  for (const e of ['pointerdown', 'touchend', 'click', 'keydown']) {
    window.addEventListener(e, () => { if (cur != null && audio.paused && s.musicOn) start(); }, { capture: true, passive: true });
  }
  // 設定畫面的開關 / 滑桿用(對應到 SFX.settings 的 musicOn / music)
  const cfg = {
    get on() { return s.musicOn; }, set on(v) { s.musicOn = v; },
    get vol() { return s.music; }, set vol(v) { s.music = v; },
    get battle() { return s.battleMusic !== false; }, set battle(v) { s.battleMusic = !!v; },
  };
  return {
    cfg,
    get playing() { return audio.paused ? null : cur; }, // 除錯用
    setOn(on) { s.musicOn = !!on; SFX.save(); if (on) start(); else fadeTo(0, 500, () => audio.pause()); },
    setVolume(v) { s.music = Math.max(0, Math.min(100, v)); SFX.save(); if (!audio.paused) audio.volume = target(); },
    setBattle(on) { s.battleMusic = !!on; SFX.save(); tick(); }, // 開關當下就重新判斷該播哪首(戰鬥中關掉 → 馬上切回背景音樂)
  };
})();
