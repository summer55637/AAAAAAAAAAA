// 橫式版面控制；沒有 html.land 時不改原介面。按鈕只建立一次。
(function () {
  var root = document.documentElement;
  var KEY = 'l1j.landNavMin';
  function load() { try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } }
  function save(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* 私密模式 */ } }
  function mk() {
    var hud = document.getElementById('hud');
    if (!hud || document.getElementById('land-chat-btn')) return;
    var b = document.createElement('button');
    b.id = 'land-chat-btn'; b.type = 'button'; b.textContent = '聊';
    b.setAttribute('aria-label', '展開 / 收合聊天');
    b.setAttribute('aria-controls', 'chat-log chat-tabs chat-form');
    var n = document.createElement('button');
    n.id = 'land-nav-btn'; n.type = 'button';
    n.setAttribute('aria-label', '展開 / 收起選單');
    n.setAttribute('aria-controls', 'bottom-nav');
    // 首次直式載入時也先隱藏，不能依賴 html.land 的 CSS 才藏按鈕。
    b.style.display = n.style.display = 'none';
    hud.append(b, n);
    var wasLand = false;
    var input = document.getElementById('chat-input');
    var log = document.getElementById('chat-log');
    function setNav(min, persist) {
      root.classList.toggle('land-nav-min', min);
      n.textContent = min ? '☰' : '▴';
      n.setAttribute('aria-expanded', String(!min));
      if (persist) save(min);
    }
    function setChat(open) {
      if (!root.classList.contains('land')) return;
      // 變更高度前記下是否在看最新訊息；正在看舊紀錄時不跳底。
      var atEnd = log && log.scrollHeight - log.clientHeight - log.scrollTop <= 4;
      root.classList.toggle('land-chat', open);
      b.setAttribute('aria-expanded', String(open));
      if (!open && input && document.activeElement === input) input.blur();
      if (atEnd) log.scrollTop = log.scrollHeight;
    }
    function syncLayout() {
      var land = root.classList.contains('land');
      b.style.display = n.style.display = land ? '' : 'none';
      if (land !== wasLand) {
        wasLand = land;
        if (land) setNav(load(), false);
        else root.classList.remove('land-nav-min', 'land-chat');
      }
      b.setAttribute('aria-expanded', String(land && root.classList.contains('land-chat')));
    }
    b.onclick = function () { setChat(!root.classList.contains('land-chat')); };
    n.onclick = function () { if (root.classList.contains('land')) setNav(!root.classList.contains('land-nav-min'), true); };
    // 原 hud.js 的 Enter 會聚焦輸入框；先展開才能聚焦，送訊息仍由原流程處理。
    document.addEventListener('keydown', function (e) {
      var target = e.target;
      if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented || !root.classList.contains('land') || hud.classList.contains('hidden')) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(target.tagName))) return;
      setChat(true);
    }, true);
    if (input) input.addEventListener('focus', function () { setChat(true); });
    // Only the game canvas collapses navigation; let the original move / attack event continue.
    var world = document.getElementById('world');
    document.addEventListener('pointerdown', function (e) {
      if (!world || e.target !== world || !root.classList.contains('land') || hud.classList.contains('hidden') || root.classList.contains('land-nav-min')) return;
      setNav(true, true);
    }, { capture: true, passive: true });
    var badge = document.querySelector('#nav-mail .badge');
    function syncBadge() {
      var dot = !!badge && !badge.classList.contains('hidden');
      if (n.classList.contains('dot') !== dot) n.classList.toggle('dot', dot);
    }
    if (badge) new MutationObserver(syncBadge).observe(badge, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(syncLayout).observe(root, { attributes: true, attributeFilter: ['class'] });
    syncBadge(); syncLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
})();

// Reversible landscape presentation. Original nodes stay available for portrait.
(function () {
  var root = document.documentElement, active = null, timer = null;
  function state() { return typeof st === 'undefined' ? {} : st; }
  function stop() { clearInterval(timer); timer = null; }
  function restore() {
    stop();
    if (active && active.wrap.parentNode === active.body) {
      active.parents.forEach(function (p) { p.node.replaceChildren.apply(p.node, p.children); });
      active.body.replaceChildren.apply(active.body, active.nodes);
    }
    active = null;
  }
  function put(cell, value) {
    value = String(value == null ? '-' : value);
    if (cell.textContent !== value) cell.textContent = value;
  }
  function refresh() {
    if (!active || !active.wrap.isConnected) { stop(); active = null; return; }
    var game = state(), m = game.me || {}, t = (game.game || {}).expTable || [];
    var lv = m.level == null ? 1 : m.level, lo = t[lv - 1], hi = t[lv];
    var pct = hi > lo ? Math.max(0, Math.min(100, ((m.exp || 0) - lo) * 100 / (hi - lo))).toFixed(2) + '%' : '-';
    var mr = document.getElementById('st-mr');
    var lawful = document.getElementById('st-lawful-label');
    var rows = [
      ['等級', 'Lv.' + lv, '經驗', pct],
      ['HP', (m.hp ?? 0) + ' / ' + (m.maxHp ?? 0)],
      ['MP', (m.mp ?? 0) + ' / ' + (m.maxMp ?? 0)],
      ['AC', m.ac ?? 0, 'MR', mr ? mr.textContent : '-'],
      ['STR', m.str ?? 0, 'DEX', m.dex ?? 0],
      ['CON', m.con ?? 0, 'INT', m.int ?? 0],
      ['WIS', m.wis ?? 0, 'CHA', m.cha ?? 0],
      [lawful ? lawful.textContent : '正義', m.lawful ?? 0, 'PK 次數', Number.isInteger(game.pkCount) ? game.pkCount : '-'], // 11/03 PK 次數(伺服器送)
      ['火', m.fire == null ? '-' : m.fire + '%', '水', m.water == null ? '-' : m.water + '%'],
      ['風', m.wind == null ? '-' : m.wind + '%', '地', m.earth == null ? '-' : m.earth + '%']
    ];
    rows.forEach(function (row, i) {
      var tr = active.table.rows[i];
      row.forEach(function (v, j) { put(tr.cells[j], v); });
    });
    // Update only the original name text node, preserving the ranking button.
    var head = active.body.querySelector('.char-head');
    if (head && head.firstChild && head.firstChild.nodeType === 3) {
      head.firstChild.textContent = head.firstChild.textContent.replace(/Lv\.\d+/, 'Lv.' + lv);
    }
  }
  // Presentation only: expose the selected item's current enchant level, even without a scroll.
  function syncEnchant() {
    var body = document.getElementById('panel-body');
    if (!body) return;
    var top = body.querySelector('.enc-top');
    var slot = top && top.lastElementChild;
    var target = typeof enchantSel === 'undefined' ? null : enchantSel.target;
    var tag = body.querySelector('.land-enc-current');
    if (!root.classList.contains('land') || !slot || !target || typeof enchantLevel !== 'function') {
      if (tag) tag.remove();
      return;
    }
    if (!tag) {
      tag = document.createElement('span'); tag.className = 'land-enc-current';
      slot.appendChild(tag);
    }
    var level = enchantLevel(target);
    put(tag, '目前 ' + (level >= 0 ? '+' : '') + level);
  }
  function arrange() {
    syncEnchant();
    if (!root.classList.contains('land')) { restore(); return; }
    var body = document.getElementById('panel-body');
    if (!body) return;
    if (active && active.wrap.parentNode === body) return;
    stop(); active = null;
    var grid = body.querySelector(':scope > .char-grid');
    if (!grid) return; // Ranking and other character subpages keep their own DOM.
    var nodes = Array.from(body.childNodes);
    var parents = [grid].concat(Array.from(grid.querySelectorAll('.equip-col, .helm-wrap, .helm-sub'))).map(function (node) { return { node: node, children: Array.from(node.childNodes) }; });
    var wrap = document.createElement('div'); wrap.className = 'lc-wrap';
    var left = document.createElement('div'); left.className = 'lc-left';
    var right = document.createElement('div'); right.className = 'lc-right';
    var table = document.createElement('table'); table.className = 'lc-values';
    table.setAttribute('aria-label', '角色能力');
    for (var i = 0; i < 10; i++) {
      var tr = table.insertRow();
      var count = [1, 2].includes(i) ? 2 : 4; // 11/03 第 8 列(正義)加 PK 次數,改 4 格
      for (var j = 0; j < count; j++) {
        var cell = document.createElement(j % 2 ? 'td' : 'th');
        if (j % 2 === 0) cell.scope = 'row';
        if (count === 2 && j === 1) cell.colSpan = 3;
        tr.appendChild(cell);
      }
    }
    var doll = document.createElement('div'); doll.className = 'lc-doll';
    var cols = grid.querySelectorAll('.equip-col');
    var equipment = [];
    for (var c = 0; c < cols.length; c++) equipment.push.apply(equipment, Array.from(cols[c].querySelectorAll('button.equip')));
    // The helmet's two magic slots occur before T-shirt in the original column.
    var positions = [[1,1],[1,2],[1,3],[3,1],[2,4],[3,4],[3,5],[4,3],[2,1],[2,5],[1,5],[1,4],[4,1],[4,2]];
    equipment.forEach(function (node, i) {
      var pos = positions[i]; if (!pos) return;
      var slot = document.createElement('div'); slot.className = 'lc-slot';
      slot.style.gridRow = pos[0]; slot.style.gridColumn = pos[1];
      slot.appendChild(node); doll.appendChild(slot);
    });
    var center = grid.querySelector('.char-center');
    if (center) doll.appendChild(center);
    left.appendChild(doll); right.appendChild(table);
    wrap.append(left, right);
    nodes.forEach(function (node) {
      if (node.classList && node.classList.contains('char-head')) return;
      if (node.classList && node.classList.contains('equip-sets')) left.appendChild(node);
      else if (node.classList && node.classList.contains('orig-bonus')) {
        var bonus = document.createElement('details'); bonus.className = 'lc-bonus';
        var summary = document.createElement('summary');
        var title = node.querySelector('b');
        summary.textContent = title ? title.textContent : '\u521d\u59cb\u80fd\u529b\u52a0\u6210';
        bonus.append(summary, node); wrap.appendChild(bonus);
      }
      else if (node.classList && (node === grid || node.classList.contains('char-stats') || node.classList.contains('char-exp'))) wrap.appendChild(node);
      else right.appendChild(node);
    });
    body.appendChild(wrap);
    active = { body: body, wrap: wrap, nodes: nodes, parents: parents, table: table };
    refresh();
    startTimer();
  }
  function startTimer() {
    var box = document.getElementById('panel');
    if (!active || timer || document.hidden || !box || box.classList.contains('hidden')) return;
    refresh();
    timer = setInterval(function () {
      var box = document.getElementById('panel');
      if (!root.classList.contains('land')) { restore(); return; }
      if (document.hidden || !box || box.classList.contains('hidden')) { stop(); return; }
      refresh();
    }, 250);
  }
  // Observe after each synchronous renderer finishes: some pages set dlg.mode after showDialog.
  function syncNpc() {
    var dialog = document.getElementById('dialog');
    if (!dialog) return;
    var land = root.classList.contains('land');
    // Candle pages share #dialog, including loading and confirmation states.
    var candle = land && typeof dlg !== 'undefined' && dlg.mode === 'charreset' && !dialog.classList.contains('hidden');
    if (dialog.classList.contains('land-charreset') !== candle) dialog.classList.toggle('land-charreset', candle);
    var rename = land && typeof dlg !== 'undefined' && dlg.mode === 'rename' && !dialog.classList.contains('hidden');
    if (dialog.classList.contains('land-rename') !== rename) dialog.classList.toggle('land-rename', rename);
    var book = land && typeof dlg !== 'undefined' && dlg.mode === 'dungeonbook';
    if (dialog.classList.contains('dbook') !== book) dialog.classList.toggle('dbook', book);
    var object = typeof st !== 'undefined' && st.objects && typeof dlg !== 'undefined' ? st.objects.get(dlg.npc) : null;
    var teleports = object && object.menu && object.menu.teleports;
    var npc = land && typeof dlg !== 'undefined' && dlg.mode === 'menu' && !(teleports && teleports.length);
    if (dialog.classList.contains('land-npc') !== npc) dialog.classList.toggle('land-npc', npc);
  }
  function sync() {
    syncNpc();
    arrange();
    if (active && !timer) startTimer();
  }
  function hook() {
    if (typeof window.renderPanel === 'function' && !window.renderPanel.__land) {
      var original = window.renderPanel;
      window.renderPanel = function () {
        // Restore first: the normal renderer may return without replacing the body.
        restore();
        var result = original.apply(this, arguments);
        arrange(); return result;
      };
      window.renderPanel.__land = true;
    }
    var dialog = document.getElementById('dialog');
    if (dialog && !dialog.__landNpcLayout) {
      new MutationObserver(syncNpc).observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      dialog.__landNpcLayout = true;
    }
    var box = document.getElementById('panel');
    if (box && !box.__landVisibility) { new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ['class'] }); box.__landVisibility = true; }
    sync();
  }
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else sync(); });
  addEventListener('load', hook);
})();

// Landscape buff rows: preserve the original buttons, art and click handlers.
(function () {
  var root = document.documentElement;
  function bindBuffLayout() {
    var hud = document.getElementById('hud'), bar = document.getElementById('buffbar');
    if (!hud || !bar || bar.__landBuffLayout) return;
    bar.__landBuffLayout = true;
    function putStyle(node, name, value) {
      if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    }
    function syncBuffLayout() {
      if (!root.classList.contains('land')) {
        bar.style.removeProperty('--land-buff-size');
        bar.style.removeProperty('--land-buff-gap');
        hud.style.removeProperty('--land-buff-height');
        return;
      }
      var count = Array.from(bar.children).filter(function (node) {
        return node.classList.contains('buff') && !node.classList.contains('hidden');
      }).length;
      var width = bar.getBoundingClientRect().width;
      if (!(width > 0) && count) return; // Empty bars still clear their reserved height.

      var size = 24, gap = 2;
      var columns = Math.max(1, Math.floor((width + gap) / (size + gap)));
      if (count > columns) {
        size = 22;
        columns = Math.max(1, Math.floor((width + gap) / (size + gap)));
      }
      if (count > columns * 3) {
        columns = Math.ceil(count / 3);
        gap = Math.min(2, Math.floor(width / columns / 4));
        // Quarter pixels avoid rounding a nearly full row into an extra row.
        size = Math.max(.25, Math.floor((width - gap * (columns - 1)) / columns * 4) / 4);
      }
      var rows = count ? Math.ceil(count / columns) : 0;
      var height = rows * size + Math.max(0, rows - 1) * gap;
      putStyle(bar, '--land-buff-size', size + 'px');
      putStyle(bar, '--land-buff-gap', gap + 'px');
      putStyle(hud, '--land-buff-height', height + 'px');
    }
    // Item changes matter; per-second fade / timer updates inside each button do not.
    new MutationObserver(syncBuffLayout).observe(bar, { childList: true });
    new MutationObserver(syncBuffLayout).observe(root, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(syncBuffLayout).observe(hud, { attributes: true, attributeFilter: ['class'] });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncBuffLayout).observe(bar);
    addEventListener('resize', syncBuffLayout);
    syncBuffLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindBuffLayout); else bindBuffLayout();
})();

// Single-item actions share one grid row without moving/replacing original buttons.
(function () {
  var root = document.documentElement;
  function hookItemSheet() {
    var sheet = document.getElementById('itemsheet'), body = document.getElementById('is-body');
    if (!sheet || !body || sheet.__landItemLayout) return;
    sheet.__landItemLayout = true;
    var previousHead = null, wasOpen = false;
    function syncItemSheet() {
      var head = body.querySelector(':scope > .is-head');
      var actions = body.querySelector(':scope > .is-actions');
      var open = root.classList.contains('land') && !sheet.classList.contains('hidden') && !!head && !!actions;
      if (sheet.classList.contains('land-item-detail') !== open) sheet.classList.toggle('land-item-detail', open);
      var stats = body.querySelector(':scope > .is-stats');
      var rows = stats ? Array.from(stats.children) : [];
      var many = open && rows.length > 10;
      if (stats && stats.classList.contains('land-item-many') !== many) stats.classList.toggle('land-item-many', many);
      rows.forEach(function (row) {
        // Long effects get the full line; short properties can share two columns.
        var wide = many && row.textContent.length > 12;
        if (row.classList.contains('land-item-wide') !== wide) row.classList.toggle('land-item-wide', wide);
      });
      if (open) {
        var hotbar = body.querySelector(':scope > .is-hotbar');
        var count = Array.from(actions.children).filter(function (n) { return n.tagName === 'BUTTON'; }).length;
        if (hotbar) count += Array.from(hotbar.children).filter(function (n) { return n.tagName === 'BUTTON'; }).length;
        var columns = String(Math.max(1, count));
        if (body.style.getPropertyValue('--land-item-actions') !== columns) body.style.setProperty('--land-item-actions', columns);
        // A previously scrolled picker must not leave the new item's name above the viewport.
        if (!wasOpen || head !== previousHead) { body.scrollTop = 0; sheet.scrollTop = 0; }
      } else {
        body.style.removeProperty('--land-item-actions');
      }
      previousHead = head; wasOpen = open;
    }
    new MutationObserver(syncItemSheet).observe(sheet, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    new MutationObserver(syncItemSheet).observe(root, { attributes: true, attributeFilter: ['class'] });
    syncItemSheet();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hookItemSheet); else hookItemSheet();
  addEventListener('load', hookItemSheet);
})();
