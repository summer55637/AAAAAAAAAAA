// gamedex 圖片(tools/build_gamedex_assets.py 匯出):道具 / 技能圖示。
// 找不到對應圖時回傳 false,呼叫端改用 Flare 素材。
'use strict';

const GDX = (() => {
  const BASE = 'assets/gamedex/';
  const VER = window.AV?.gdx ? `?v=${window.AV.gdx}` : '?v=4'; // 版本由 gateway 依檔案修改時間給
  let icons = null; // { img, meta }
  let extra = null; // icons3:後來補的道具圖(夏娜的變形卷軸、地監記憶書;invgfx 9001~9099),不動大圖集

  const load = (name) => Promise.all([
    new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = `${BASE}${name}.webp${VER}`; }),
    fetch(`${BASE}${name}.json${VER}`).then((r) => r.json()),
  ]).then(([img, meta]) => ({ img, meta }));
  load('icons3').then((x) => { extra = x; }).catch(() => { extra = false; });
  load('icons2').then((x) => { icons = x; }).catch(() => {}); // icons2:icons + 客戶端魔法圖示(spellicon.idx)補上 gamedex 沒有的技能

  // 和 build_gamedex_assets.py 的 norm 一致
  const norm = (n) => (n || '').replace(/^[+-]\d+\s*/, '').replace(/\s*\(\d+\)$/, '').trim();

  // 補充圖集:invgfx / grdgfx 9001~9099 專用
  const isExtra = (it) => it.gfx >= 9000 && it.gfx < 9100;
  const extraIndex = (it) => (extra ? extra.meta[it.kind === 'item' ? 'grd' : 'inv'][it.gfx] ?? null : null);
  function iconIndex(it) {
    if (!icons) return null;
    const m = icons.meta;
    // 背包裡的 gfx 是 invgfx;地上的道具是 grdgfx
    const byGfx = it.kind === 'item' ? m.grd[it.gfx] : m.inv[it.gfx];
    return byGfx ?? m.name[norm(it.name)] ?? null;
  }

  function drawCell(ctx, i, x, y, size) {
    const { img, meta } = icons;
    const c = meta.cell;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, (i % meta.cols) * c, Math.floor(i / meta.cols) * c, c, c, x, y, size, size);
    return true;
  }

  // 道具圖示;沒有對應圖回傳 false
  function drawIcon(ctx, it, x, y, size) {
    if (isExtra(it)) {
      const e = extraIndex(it);
      if (e == null) return false;
      const c = extra.meta.cell;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(extra.img, (e % extra.meta.cols) * c, Math.floor(e / extra.meta.cols) * c, c, c, x, y, size, size);
      return true;
    }
    const i = iconIndex(it);
    return i == null ? false : drawCell(ctx, i, x, y, size);
  }

  // 圖庫裡名稱不同的魔法(指定傳送 = 傳送術)
  const SKILL_ICON_ALIAS = { 指定傳送: '傳送術' };
  // 依名稱畫技能或道具圖示(狀態列用)
  function drawNamed(ctx, name, x, y, size) {
    if (!icons) return false;
    const i = icons.meta.skill[SKILL_ICON_ALIAS[name] || name] ?? icons.meta.name[name];
    return i == null ? false : drawCell(ctx, i, x, y, size);
  }

  // 圖集還沒載入時回傳 undefined(呼叫端可以稍後重試),確定沒有對應圖回傳 null
  const hasIcon = (it) => (isExtra(it) ? (extra === null ? undefined : extraIndex(it) != null) : icons ? iconIndex(it) != null : undefined);

  const urls = () => [`${BASE}icons2.webp${VER}`, `${BASE}icons2.json${VER}`, `${BASE}icons3.webp${VER}`, `${BASE}icons3.json${VER}`];
  return { drawIcon, drawNamed, hasIcon, norm, urls };
})();
