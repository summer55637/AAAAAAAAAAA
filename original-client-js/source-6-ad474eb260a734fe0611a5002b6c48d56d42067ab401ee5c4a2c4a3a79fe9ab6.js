// Flare 素材(CC-BY-SA 3.0,見 assets/flare/CREDITS.txt)的載入與繪製。
// 圖集由 tools/build_flare_assets.py 產生;角色依需要才載入。
'use strict';

const FLARE = (() => {
  const BASE = 'assets/flare/';
  const VER = '?v=5'; // 重建圖集時改這個,避免手機用到舊快取
  const sprites = {}; // key -> { img, meta, ready }
  let terrain = null; // { img, meta, ready }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  (async () => {
    try {
      const [img, meta] = await Promise.all([loadImage(`${BASE}terrain.webp${VER}`), fetch(`${BASE}terrain.json${VER}`).then((r) => r.json())]);
      terrain = { img, meta };
    } catch { /* 載入失敗就用舊的佔位地磚 */ }
  })();

  function sprite(key) {
    if (!sprites[key]) {
      sprites[key] = { ready: false };
      Promise.all([loadImage(`${BASE}sprites/${key}.webp${VER}`), fetch(`${BASE}sprites/${key}.json${VER}`).then((r) => r.json())])
        .then(([img, meta]) => Object.assign(sprites[key], { img, meta, ready: true }))
        .catch(() => { sprites[key].failed = true; });
    }
    return sprites[key];
  }

  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); return (n ^ (n >>> 15)) >>> 0; };

  // ---- 角色 / 怪物對照 ----
  const CLASS_KEY = ['pc_royal', 'pc_knight', 'pc_elf', 'pc_wizard', 'pc_elf', 'pc_knight', 'pc_wizard'];
  // 其他玩家用外型編號判斷職業(L1PcInstance classId)
  const GFX_CLASS = { 0: 0, 1: 0, 61: 1, 48: 1, 138: 2, 37: 2, 734: 3, 1186: 3, 2786: 4, 2796: 4, 6658: 5, 6661: 5, 6671: 6, 6650: 6 };
  const MONSTER_RULES = [
    [/弓箭手|弓兵|射手/, 'skeleton_archer'],
    [/骷髏|亡靈|幽靈|鬼|木乃伊|死亡/, 'skeleton'],
    [/法師|巫|術士|祭司|薩滿/, 'skeleton_mage'],
    [/殭屍|屍|腐/, 'zombie'],
    [/哥布林|地靈|矮人|鼠人/, 'goblin'],
    [/妖魔|奧克|歐克|半獸|狼人/, 'goblin_elite'],
    [/牛頭|巨人|食人|獨眼|歐吉|巨魔|熊/, 'minotaur'],
    [/龍|飛龍|雙足/, 'wyvern'],
    [/火|炎|熔岩/, 'fire_ant'],
    [/冰|雪|霜/, 'ice_ant'],
    [/蟻|蟲|蜘蛛|蠍|甲|螳螂|蜥蜴|鱷|蛇|蟹/, 'antlion'],
  ];
  const MONSTER_FALLBACK = ['goblin', 'goblin_elite', 'skeleton', 'zombie', 'antlion'];
  const NPC_KEYS = ['npc_man1', 'npc_man2', 'npc_woman1', 'npc_woman2', 'npc_guild', 'npc_trader'];

  function keyFor(o, isMe, myType) {
    if (isMe && myType != null) return CLASS_KEY[myType] || 'pc_knight';
    if (o.kind === 'pc') return CLASS_KEY[GFX_CLASS[o.gfx] ?? 1];
    if (o.kind === 'guard') return 'npc_knight';
    if (o.kind === 'npc') {
      if (/警衛|騎士|衛兵/.test(o.name)) return 'npc_knight';
      if (/商|販|老闆|店/.test(o.name)) return 'npc_trader';
      return NPC_KEYS[hash(o.gfx * 31 + (o.name || '').length) % NPC_KEYS.length];
    }
    for (const [re, key] of MONSTER_RULES) if (re.test(o.name || '')) return key;
    return MONSTER_FALLBACK[hash(o.gfx) % MONSTER_FALLBACK.length];
  }

  function frameOf(anim, elapsed) {
    const n = anim.frames;
    if (n <= 1) return 0;
    const t = Math.max(0, elapsed) / anim.duration;
    if (anim.type === 'play_once') return Math.min(n - 1, Math.floor(t * n));
    if (anim.type === 'back_forth') {
      const k = Math.floor(t * (n * 2 - 2)) % (n * 2 - 2);
      return k < n ? k : n * 2 - 2 - k;
    }
    return Math.floor(t * n) % n;
  }

  // 天堂 heading(0 = 畫面左上,順時針)→ Flare 方向(0 = 畫面左,順時針)
  const dirOf = (heading) => ((heading ?? 4) + 1) % 8;

  // 畫一個角色;成功回傳圖高(給名稱標籤定位),素材還沒載入回傳 0
  function drawCreature(ctx, o, isMe, myType, x, y, now) {
    const s = sprite(keyFor(o, isMe, myType));
    if (!s.ready) return 0;
    let name = 'stance';
    let start = 0;
    if (o.dead) { name = 'die'; start = o.deadAt ?? -1e9; }
    else if (o.lunge && now - o.lunge < (o.lungeMs || s.meta.attack?.duration || 400)) { name = 'attack'; start = o.lunge; }
    else if (o.anim) { name = 'run'; start = o.anim.start; }
    const anim = s.meta[name] || s.meta.stance;
    // 攻擊動作照實際攻擊間隔播放(素材本身固定 400ms,會看起來比實際攻速快)
    const stretch = name === 'attack' && o.lungeMs ? anim.duration / o.lungeMs : 1;
    const f = frameOf(anim, (now - start) * stretch);
    const d = dirOf(o.heading);
    const cell = anim.cells[`${f},${d}`] || anim.cells[`0,${d}`] || anim.cells['0,0'];
    if (!cell) return 0;
    const [sx, sy, w, h, ox, oy] = cell;
    ctx.drawImage(s.img, sx, sy, w, h, Math.round(x - ox), Math.round(y - oy), w, h);
    return oy;
  }

  function describeCreature( o, isMe, myType, x, y, now) {
    const s = sprite(keyFor(o, isMe, myType));
    if (!s.ready) return Object.assign([], { height: 0 });
    let name = 'stance';
    let start = 0;
    if (o.dead) { name = 'die'; start = o.deadAt ?? -1e9; }
    else if (o.lunge && now - o.lunge < (o.lungeMs || s.meta.attack?.duration || 400)) { name = 'attack'; start = o.lunge; }
    else if (o.anim) { name = 'run'; start = o.anim.start; }
    const anim = s.meta[name] || s.meta.stance;
    // 攻擊動作照實際攻擊間隔播放(素材本身固定 400ms,會看起來比實際攻速快)
    const stretch = name === 'attack' && o.lungeMs ? anim.duration / o.lungeMs : 1;
    const f = frameOf(anim, (now - start) * stretch);
    const d = dirOf(o.heading);
    const cell = anim.cells[`${f},${d}`] || anim.cells[`0,${d}`] || anim.cells['0,0'];
    if (!cell) return Object.assign([], { height: 0 });
    const [sx, sy, w, h, ox, oy] = cell;
    return Object.assign([{ img: s.img, cell: [sx, sy, w, h], dx: Math.round(x - ox), dy: Math.round(y - oy),
      scale: [1, 1], alpha: 1, blend: 'source-over' }], { height: oy });
  }

  // ---- 地形 ----
  const terrainReady = () => !!terrain;

  function drawTile(ctx, group, seed, x, y) {
    const cells = terrain?.meta[group];
    if (!cells?.length) return false;
    const [, sx, sy, w, h, ox, oy] = cells[seed % cells.length];
    ctx.drawImage(terrain.img, sx, sy, w, h, Math.round(x - ox), Math.round(y - oy), w, h);
    return true;
  }

  // ---- 道具圖示(icons.webp:8 欄、每格 48px)----
  let icons = null;
  loadImage(`${BASE}icons.webp${VER}`).then((img) => { icons = img; }).catch(() => {});
  const ICON = 48;
  const pick = (list, seed) => list[seed % list.length];
  // 依道具名稱與部位(S_InvList 的 useType)挑圖示編號
  function iconOf(it) {
    const n = it.name || '';
    const h = hash(n.length * 131 + n.charCodeAt(0));
    const has = (re) => re.test(n);
    if (has(/金幣/)) return 88;
    if (has(/藥水/)) {
      if (has(/終極治癒/)) return 85;
      if (has(/強力治癒|強化/)) return 84;
      if (has(/治癒|紅色/)) return 64;
      if (has(/藍色|魔力|精神/)) return 65;
      if (has(/加速|綠色/)) return 80;
      if (has(/勇敢/)) return 82;
      if (has(/慎重/)) return 81;
      if (has(/翡翠/)) return 83;
      return 81;
    }
    if (has(/魔法書|技術書|精靈水晶|書/)) return 225;
    if (has(/卷軸|捲軸|信紙|傳送符|船票/)) return has(/傳送|回家|瞬間/) ? 74 : 224;
    if (has(/鑰匙/)) return 226;
    if (has(/鑽石|寶石|水晶/)) return pick([68, 69, 70, 71], h);
    if (has(/箭筒/)) return 8;
    if (has(/箭/)) return 8;
    if (has(/蠟燭|燈/)) return 15;
    switch (it.useType) {
      case 22: return has(/鐵|鋼|騎士|板/) ? 160 : has(/鎖|鏈|環/) ? 152 : 136; // 頭盔
      case 2: return has(/鋼|騎士|板|鱗/) ? 161 : has(/鎖|鏈|環/) ? 153 : has(/袍/) ? 193 : 145; // 盔甲
      case 18: return 129; // T恤
      case 19: return 185; // 斗篷
      case 20: return has(/鐵|鋼|騎士|板/) ? 162 : has(/鎖|鏈/) ? 154 : 138; // 手套
      case 21: return has(/鐵|鋼|騎士|板/) ? 164 : has(/鎖|鏈/) ? 156 : 140; // 靴子
      case 25: return has(/大|塔/) ? 123 : has(/小/) ? 120 : 121; // 盾
      case 24: return pick([212, 213, 214, 215], h); // 項鍊
      case 57: return pick([198, 199, 200, 201, 202, 203, 204, 205, 206, 207], h); // 戒指
      case 37: return 208; // 腰帶
      case 40: return 214; // 耳環
      default: break;
    }
    if (it.useType === 1 || has(/劍|刀|斧|鎚|錘|棍|棒|矛|槍|弓|杖|匕首|巴迪須|亞連/)) {
      if (has(/石弓|弩/)) return 113;
      if (has(/弓/)) return 114;
      if (has(/匕首|短劍|小刀|飛刀/)) return 96;
      if (has(/雙手|巨劍|大劍/)) return 99;
      if (has(/劍|刀/)) return 98;
      if (has(/斧|巴迪須/)) return has(/雙/) ? 119 : 117;
      if (has(/鎚|錘|棍|棒|亞連/)) return 110;
      if (has(/杖/)) return 105;
      if (has(/矛|槍/)) return 106;
      return 98;
    }
    return 30;
  }

  // 在 (x, y) 畫一個 size×size 的道具圖示;圖示還沒載入回傳 false
  function drawIcon(ctx, it, x, y, size) {
    if (!icons) return false;
    const i = iconOf(it);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(icons, (i % 8) * ICON, Math.floor(i / 8) * ICON, ICON, ICON, x, y, size, size);
    return true;
  }

  // 直接畫圖示表裡第 i 格(狀態列用)
  function drawIconIndex(ctx, i, x, y, size) {
    if (!icons) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(icons, (i % 8) * ICON, Math.floor(i / 8) * ICON, ICON, ICON, x, y, size, size);
    return true;
  }

  // 頭像 / 角色面板:畫角色正面(朝南)的站立動作,高度縮放到 height
  function drawFigure(ctx, o, isMe, myType, cx, footY, height, now = 0, crop = 1) {
    const s = sprite(keyFor(o, isMe, myType));
    if (!s.ready) return false;
    const anim = s.meta.stance;
    const f = frameOf(anim, now);
    const cell = anim.cells[`${f},7`] || anim.cells['0,7'];
    if (!cell) return false;
    const [sx, sy, w, h, ox, oy] = cell;
    const k = height / (oy * crop);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(s.img, sx, sy, w, h, cx - ox * k, footY - oy * k, w * k, h * k);
    return true;
  }

  return { describeCreature, drawCreature, drawTile, terrainReady, keyFor, hash, drawIcon, drawIconIndex, drawFigure };
})();
