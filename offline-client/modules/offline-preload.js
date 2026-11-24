'use strict';
// 離線模式不預載線上圖集，也不阻擋登入；原版素材缺漏時由 SPR / app.js 的備援繪圖接手。
function charselUrl(key, ext) {
  return 'assets/charsel/' + encodeURIComponent(key) + '.' + (ext || 'webp');
}
const PRELOAD = Object.freeze({
  ready: Promise.resolve(),
  add: function () {},
  pause: function () {},
  near: function () {},
  boss: function () {},
  stats: function () { return { total: 0, done: 0, active: 0, queued: 0, bytes: 0 }; }
});
window.PRELOAD = PRELOAD;
