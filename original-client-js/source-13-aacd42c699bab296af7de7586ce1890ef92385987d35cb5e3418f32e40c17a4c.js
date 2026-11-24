
  const W = 640, H = 480; // 觸控裝置與電腦預設維持原版 4:3
  const deskSizes = { '800x600': [800, 600], '1024x768': [1024, 768] }; // 10/28 使用者:電腦橫式拿掉 640×480(觸控橫式仍固定 640×480)
  function validDeskRes(res) { return Object.prototype.hasOwnProperty.call(deskSizes, res); }
  window.deskRes = '800x600';
  try {
    const saved = localStorage.getItem('l1j.deskRes');
    if (validDeskRes(saved)) window.deskRes = saved;
  } catch (e) { /* 無痕模式 */ }
  const f = document.getElementById('game');
  const coarse = matchMedia('(pointer: coarse)');
  const landscape = matchMedia('(orientation: landscape)');
  // 鍵盤只改 viewport,方向優先讀實體螢幕;舊瀏覽器依序退回。
  function isLandscape() {
    const o = screen.orientation;
    if (o && /^(landscape|portrait)-/.test(o.type)) return o.type.indexOf('landscape') === 0;
    const angle = o && typeof o.angle === 'number' && isFinite(o.angle) ? o.angle : window.orientation;
    if (typeof angle === 'number' && isFinite(angle)) return Math.abs(angle) % 180 === 90;
    if (screen.width > 0 && screen.height > 0) return screen.width > screen.height;
    return landscape.matches;
  }
  function hasInput(doc) {
    const el = doc.activeElement;
    if (!el) return false;
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) return true;
    try { return el.tagName === 'IFRAME' && !!el.contentDocument && hasInput(el.contentDocument); } catch (e) { return false; }
  }
  const modeButton = document.getElementById('desk-mode');
  const PORT_W = 412, PORT_H = 892;
  window.deskMode = 'land';
  try { if (localStorage.getItem('l1j.deskMode') === 'port') window.deskMode = 'port'; } catch (e) { /* 無痕模式 */ }
  window.setDeskMode = function (mode) {
    if (coarse.matches || (mode !== 'land' && mode !== 'port')) return;
    window.deskMode = mode;
    try { localStorage.setItem('l1j.deskMode', mode); } catch (e) { /* 存不了仍可切換 */ }
    fit(); // 只改尺寸並通知原 iframe,不重新載入
  };
  window.setDeskRes = function (res) {
    if (coarse.matches || !validDeskRes(res)) return;
    window.deskRes = res;
    try { localStorage.setItem('l1j.deskRes', res); } catch (e) { /* 存不了仍可切換 */ }
    fit(); // 沿用模式切換流程,不改 iframe 的 src
  };
  modeButton.onclick = () => { window.setDeskMode(window.deskMode === 'land' ? 'port' : 'land'); f.focus(); };
  let fittedWidth = 0, fittedHeight = 0, pendingRotation = false;
  // 放大倍率給 iframe 裡的遊戲用(app.js resize():畫布解析度乘上這個,放大後才不會糊)
  window.deskScale = 1;
  window.deskLand = coarse.matches ? isLandscape() : window.deskMode === 'land';
  function fit(rotated) {
    if (rotated === true) pendingRotation = true;
    // 縮放期間保留既有排版;初次載入仍須按 layout viewport 建立框架。
    const viewport = window.visualViewport;
    if (coarse.matches && fittedWidth && viewport && viewport.scale !== 1) return;
    rotated = pendingRotation; // 縮放回 1 倍後補做實體轉向,不被鍵盤 / 焦點防護擋住。
    const width = coarse.matches ? document.documentElement.clientWidth : innerWidth;
    const height = coarse.matches ? document.documentElement.clientHeight : innerHeight;
    modeButton.hidden = coarse.matches;
    modeButton.textContent = window.deskMode === 'land' ? '切換直式' : '切換橫式';
    modeButton.title = '電腦版畫面:' + (window.deskMode === 'land' ? '新版橫式' : '舊版直式');
    modeButton.setAttribute('aria-label', modeButton.title + ',' + modeButton.textContent);
    // 觸控裝置同寬、只有高度縮小時保留整個框的位置與倍數,允許鍵盤遮住下緣。
    // 容許 2px 寬度誤差;真實轉向事件不受鍵盤 / 焦點防護阻擋。
    if (coarse.matches && rotated !== true && Math.abs(width - fittedWidth) <= 2 && height < fittedHeight) return;
    const safe = getComputedStyle(document.body);
    const left = parseFloat(safe.paddingLeft) || 0, right = parseFloat(safe.paddingRight) || 0;
    const top = parseFloat(safe.paddingTop) || 0, bottom = parseFloat(safe.paddingBottom) || 0;
    const availableWidth = width - left - right, availableHeight = height - top - bottom;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const land = coarse.matches ? (rotated !== true && hasInput(document) ? window.deskLand : isLandscape()) : window.deskMode === 'land';
    const size = !coarse.matches && validDeskRes(window.deskRes) ? deskSizes[window.deskRes] : [W, H];
    const frameWidth = land ? size[0] : coarse.matches ? availableWidth : PORT_W;
    const frameHeight = land ? size[1] : coarse.matches ? availableHeight : PORT_H;
    const margin = !coarse.matches || Math.min(screen.width, screen.height) < 600 ? 1 : 0.85; // 10/27 使用者:電腦版上下黑框太多 → 電腦不留 15% 黑邊(填滿高度);平板照舊
    const factor = land ? margin : 1;
    let fitHeight = availableHeight, frameTop = top;
    let s = coarse.matches && !land ? 1 : Math.min(availableWidth / frameWidth, fitHeight / frameHeight) * factor;
    // 一般視窗維持原縮放;黑邊放不下 88×28 按鈕時,在頂部留一條黑邊。
    if (!coarse.matches && (availableWidth - frameWidth * s) / 2 < 104 && (availableHeight - frameHeight * s) / 2 < 44) {
      fitHeight = Math.max(1, availableHeight - 44); frameTop += 44;
      s = Math.min(availableWidth / frameWidth, fitHeight / frameHeight) * factor;
    }
    fittedWidth = width; fittedHeight = height;
    pendingRotation = false;
    window.deskLand = land;
    window.deskScale = s;
    f.style.width = `${frameWidth}px`; f.style.height = `${frameHeight}px`;
    f.style.transform = `translateX(-50%) scale(${s})`;
    f.style.left = `${left + availableWidth / 2}px`;
    f.style.top = `${frameTop + (fitHeight - frameHeight * s) / 2}px`;
    try { f.contentWindow.dispatchEvent(new Event('resize')); } catch (e) { /* 還沒載入 */ }
  }
  function rotate() { fit(true); }
  // iOS 鍵盤收起後外框常停在被推上去的位置(遊戲往上偏、下緣露黑邊);外框本來就不捲動,沒有輸入框時捲回頂端。
  function unscroll() {
    if (hasInput(document)) return;
    const se = document.scrollingElement || document.documentElement;
    if (window.scrollY || se.scrollTop || document.body.scrollTop) { window.scrollTo(0, 0); se.scrollTop = 0; document.body.scrollTop = 0; }
  }
  function afterInput() { setTimeout(() => { fit(); unscroll(); }, 0); setTimeout(unscroll, 400); } // 等 activeElement 更新;鍵盤仍縮高時等後續 resize。
  addEventListener('resize', fit);
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fit); window.visualViewport.addEventListener('resize', unscroll); }
  addEventListener('scroll', unscroll);
  addEventListener('orientationchange', rotate);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', rotate);
  if (landscape.addEventListener) landscape.addEventListener('change', fit);
  else if (landscape.addListener) landscape.addListener(fit);
  if (coarse.addEventListener) coarse.addEventListener('change', fit);
  else if (coarse.addListener) coarse.addListener(fit);
  // 10/29 使用者:電腦版快捷鍵失效。點到 iframe 外的黑邊後焦點落在外框 body,按鍵不會進遊戲;
  // 外框收到鍵盤事件就轉送進遊戲(hud.js 是在 document 上聽 keydown),並把焦點還給 iframe;點黑邊也把焦點還回去。
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === f) return;
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'BUTTON') return;
    try {
      const w = f.contentWindow;
      const ev = new w.KeyboardEvent('keydown', { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true });
      w.__selfEvt = true; // 10/30:外框轉送的按鍵是自己產生的,遊戲裡的假點擊統計不算
      try { w.document.dispatchEvent(ev); } finally { w.__selfEvt = false; }
      if (ev.defaultPrevented) e.preventDefault();
    } catch (err) { /* 框還沒載入 */ }
    f.focus();
  });
  document.addEventListener('pointerdown', (e) => { if (e.target !== modeButton) setTimeout(() => f.focus(), 0); });
  document.addEventListener('focusout', afterInput);
  fit();
  f.addEventListener('load', () => {
    // iframe 的 focusout 不會冒泡到外框。
    try { f.contentDocument.addEventListener('focusout', afterInput); } catch (e) { /* 還沒載入 */ }
    fit(); f.focus();
  });
  f.src = 'index.html' + location.search;
  // 網址列顯示回首頁網址;重新整理時 index.html 會再依裝置進框。
  try { history.replaceState(null, '', '/' + location.search); } catch (e) { /* 舊瀏覽器 */ }
