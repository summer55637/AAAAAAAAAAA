// 暫用素材:Kenney Tiny Dungeon / Tiny Town(CC0,見 assets/LICENSE-kenney.txt)。
// 只是測試用的替代圖,依名稱 / 外型編號對應到大致相近的圖。
'use strict';

const SPR = (() => {
  const T = 16; // 素材格大小
  const COLS = 12;
  const sheets = {};
  for (const name of ['dungeon', 'town']) {
    const img = new Image();
    img.src = `assets/${name}.png`;
    sheets[name] = img;
  }
  const ready = () => Object.values(sheets).every((i) => i.complete && i.naturalWidth);

  // Tiny Dungeon 格子編號(row * 12 + col)
  const D = {
    wizard: 84, villager: 85, bearded: 86, viking: 87, peasant: 88,
    helmKnight: 96, knight: 97, man: 98, woman: 99, elder: 100,
    slime: 108, cyclops: 109, crab: 110, monk: 111, bandit: 112,
    bat: 120, ghost: 121, spider: 122, rat: 123, beetle: 124,
    potionRed: 115, potionBlue: 116, potionGreen: 114, sword: 104, dagger: 103, axe: 118, hammer: 117,
    shield: 102, chest: 89, staff: 129, spear: 131, wall: 28,
  };
  // Tiny Town
  const TT = { grass: 0, grass2: 1, flower: 2, dirt: 25, stone: 43, tree: 4, tree2: 16, bush: 6, coin: 93, scroll: 106 };

  // 職業外型編號 -> 圖(L1PcInstance 的 classId)
  const CLASS_GFX = {
    0: D.helmKnight, 1: D.helmKnight, 61: D.knight, 48: D.knight, 138: D.bandit, 37: D.bandit,
    734: D.wizard, 1186: D.wizard, 2786: D.monk, 2796: D.monk, 6658: D.viking, 6661: D.viking, 6671: D.woman, 6650: D.woman,
  };
  const CLASS_TYPE = [D.helmKnight, D.knight, D.bandit, D.wizard, D.monk, D.viking, D.woman];

  const MONSTER_RULES = [
    [/哥布林|地靈|矮人/, D.bandit], [/妖魔|奧克|歐克/, D.cyclops], [/狼|狗|犬|熊|野豬|獸/, D.rat],
    [/蝙蝠|鳥|鷹|蜂/, D.bat], [/骷髏|殭屍|幽靈|亡靈|鬼|木乃伊|死/, D.ghost], [/蜘蛛|蠍|蟲|螞蟻/, D.spider],
    [/史萊姆|果凍|泥/, D.slime], [/巨人|食人|獨眼|牛頭/, D.cyclops], [/蛇|蜥蜴|鱷|龍|蟹/, D.crab],
    [/稻草人/, D.peasant], [/警衛|騎士|士兵/, D.helmKnight],
  ];
  const MONSTER_FALLBACK = [D.cyclops, D.crab, D.spider, D.rat, D.beetle, D.slime];
  const NPC_POOL = [D.villager, D.bearded, D.peasant, D.man, D.woman, D.elder];

  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); return (n ^ (n >>> 15)) >>> 0; };

  function creature(o, isMe, myType) {
    if (isMe && myType != null) return ['dungeon', CLASS_TYPE[myType] ?? D.knight];
    if (o.kind === 'pc') return ['dungeon', CLASS_GFX[o.gfx] ?? D.knight];
    if (o.kind === 'guard') return ['dungeon', D.helmKnight];
    if (o.kind === 'npc') return ['dungeon', /師|法|預言|魔/.test(o.name) ? D.wizard : NPC_POOL[hash(o.gfx) % NPC_POOL.length]];
    if (o.kind === 'door') return ['dungeon', D.chest];
    for (const [re, idx] of MONSTER_RULES) if (re.test(o.name)) return ['dungeon', idx];
    return ['dungeon', MONSTER_FALLBACK[hash(o.gfx) % MONSTER_FALLBACK.length]];
  }

  function item(o) {
    const n = o.name;
    if (/金幣|阿頭那/.test(n)) return ['town', TT.coin];
    if (/紅色|治癒|治療/.test(n)) return ['dungeon', D.potionRed];
    if (/藍色|魔力|加速|綠色|藥水/.test(n)) return ['dungeon', /綠色|加速/.test(n) ? D.potionGreen : D.potionBlue];
    if (/卷軸|捲軸|書/.test(n)) return ['town', TT.scroll];
    if (/箭/.test(n)) return ['town', 119];
    if (/弓/.test(n)) return ['town', 118];
    if (/蠟燭|燈/.test(n)) return ['town', 104];
    if (/鑰匙/.test(n)) return ['town', 117];
    if (/斧/.test(n)) return ['dungeon', D.axe];
    if (/鎚|錘/.test(n)) return ['dungeon', D.hammer];
    if (/匕首|短劍/.test(n)) return ['dungeon', D.dagger];
    if (/劍|刀/.test(n)) return ['dungeon', D.sword];
    if (/矛|槍|杖/.test(n)) return ['dungeon', /杖/.test(n) ? D.staff : D.spear];
    if (/盾|甲|盔|靴|手套|斗篷|袍/.test(n)) return ['dungeon', D.shield];
    return ['dungeon', D.chest];
  }

  // 畫一格素材;(x, y) 為腳底位置
  function draw(ctx, [sheet, idx], x, y, scale, flip) {
    const img = sheets[sheet];
    if (!img.complete) return false;
    const sx = (idx % COLS) * T;
    const sy = Math.floor(idx / COLS) * T;
    const s = T * scale;
    ctx.imageSmoothingEnabled = false;
    if (flip) {
      ctx.save(); ctx.translate(x, 0); ctx.scale(-1, 1);
      ctx.drawImage(img, sx, sy, T, T, -s / 2, y - s, s, s);
      ctx.restore();
    } else ctx.drawImage(img, sx, sy, T, T, x - s / 2, y - s, s, s);
    return true;
  }

  // 把方形材質轉成斜角菱形地磚(預先畫好,畫面上每格只要 drawImage)
  const isoCache = {};
  function isoTile(key, tw, th) {
    const k = `${key}:${tw}`;
    if (isoCache[k]) return isoCache[k];
    if (!ready()) return null;
    const [sheet, idx, tint] = {
      grass: ['town', TT.grass], grass2: ['town', TT.grass2], grass3: ['town', TT.flower], safe: ['town', TT.grass, 'rgba(255,220,120,.18)'], combat: ['town', TT.dirt, 'rgba(120,30,20,.3)'],
      dungeon: ['dungeon', 48], wall: ['dungeon', D.wall],
    }[key];
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const side = tw / Math.SQRT2;
    g.translate(tw / 2, 0);
    g.scale(1, th / tw);
    g.rotate(Math.PI / 4);
    g.drawImage(sheets[sheet], (idx % COLS) * T, Math.floor(idx / COLS) * T, T, T, 0, 0, side + 0.5, side + 0.5);
    // 圖片 complete 但還沒解碼完時會畫出空白,這種結果不快取,下一幀再試
    if (g.getImageData(tw / 2, th / 2, 1, 1).data[3] === 0) return null;
    if (tint) { g.fillStyle = tint; g.fillRect(0, 0, side + 0.5, side + 0.5); }
    isoCache[k] = c;
    return c;
  }

  return { creature, item, draw, isoTile, hash, ready, TT };
})();
