// 網頁版 11/05 polymenu：手動、設定與離線預覽共用元件；不依賴遊戲連線。
const PolyMenu = (() => {
  const empty = () => ({ enabled: false, tiers: [] });
  const active = data => data?.enabled === true && Array.isArray(data.tiers) && data.tiers.length > 0;
  const bookTier = data => active(data) && data.bookEnabled === true ? {
    book: true, tier: 'book', label: '變身書', buy_item: 99247, buy_name: '變身書', default_poly: 0,
    items: [{ item_id: 99247, name: '變身書', sort_no: 0 }], forms: data.bookForms || [],
  } : null;
  const tierForKind = (data, kind) => +kind === 99247 ? bookTier(data) : active(data) ? data.tiers.find(t => t.items.some(i => i.item_id === +kind)) : null;
  function matches(item, row) {
    if (item.itemId != null) return +item.itemId === row.item_id;
    const name = String(item.name || '').replace(/^\+\d+\s*/, '');
    return !!row.name && (name === row.name || name.startsWith(row.name + ' (') || name.startsWith(row.name + '('));
  }
  const tierForItem = (data, item) => {
    const book = bookTier(data);
    if (book && matches(item, book.items[0])) return book;
    return active(data) ? data.tiers.find(t => t.items.some(i => matches(item, i))) : null;
  };
  function scrolls(tier, inventory) {
    const rows = [...tier.items].sort((a, b) => (a.item_id === tier.buy_item) - (b.item_id === tier.buy_item) || a.sort_no - b.sort_no || a.item_id - b.item_id);
    const bag = [...inventory];
    return rows.flatMap(row => bag.filter(item => matches(item, row) && (item.count ?? 1) > 0).sort((a, b) => (b.bless >= 128) - (a.bless >= 128)));
  }
  const count = (tier, inventory) => scrolls(tier, inventory).reduce((n, it) => n + (it.count ?? 1), 0);
  function migrate(poly, data) {
    if (data?.bookEnabled || !tierForKind(data, poly.kind) || poly.form != null) return false;
    poly.form = +poly.kind === 49402 ? 2284 : +poly.kind === 49401 ? 3784 : 0;
    return true;
  }
  function selection(poly, data) {
    if (data?.bookEnabled && +poly.kind !== 99215) {
      const tier = tierForKind(data, poly.kind);
      const id = poly.form == null ? 0 : +poly.form;
      return { tier, form: tier?.forms.find(f => f.poly_id === (id || tier.default_poly)) };
    }
    const tier = tierForKind(data, poly.kind);
    const id = poly.form == null ? (+poly.kind === 49402 ? 2284 : +poly.kind === 49401 ? 3784 : 0) : +poly.form;
    return { tier, form: tier?.forms.find(f => f.poly_id === (id || tier.default_poly)) };
  }
  function problem(tier, form, level) {
    if (!tier || !form) return '這張卷軸不能變成這個外型';
    if (!form.enabled) return '這個變身外型已停用，自動變身先暫停';
    if (level < form.min_level) return `等級 ${form.min_level} 以上才能變身成 ${form.name}`;
    return '';
  }
  function weapons(mask) {
    if (mask == null || (mask & 2047) === 2047) return '';
    if (mask === 0) return '不可拿武器';
    const bits = [[1, '匕首'], [2, '劍'], [4, '雙手劍'], [8, '斧'], [16, '矛'], [32, '杖'], [64, '雙刀'], [128, '鋼爪'], [256, '弓'], [512, '奇古獸'], [1024, '鎖鏈劍']];
    // 主導 11/05:能拿的種類少(1~2 種)才列「限…」;只有少數不能拿就寫「不能拿…」;其餘不標,免得一格塞滿字
    const can = bits.filter(([bit]) => mask & bit).map(([, name]) => name), cannot = bits.filter(([bit]) => !(mask & bit)).map(([, name]) => name);
    return can.length <= 2 ? '限' + can.join('／') : cannot.length <= 2 ? '不能拿' + cannot.join('／') : '';
  }
  // 主導 11/05 使用者「格子可能再小一點 因為之後可能會擴充 變多」:一列 5 格的小格子,一頁 20 格(4 列);超過才依等級分頁
  const PAGE = 20;
  // 格子左上角的短標籤:只能拿 1~2 種武器才標(例:弓);完整說明放在滑鼠提示(title)
  function weaponTag(mask) {
    if (mask == null || (mask & 2047) === 2047) return '';
    if (mask === 0) return '空手';
    const bits = [[1, '匕'], [2, '劍'], [4, '雙手'], [8, '斧'], [16, '矛'], [32, '杖'], [64, '雙刀'], [128, '爪'], [256, '弓'], [512, '奇古'], [1024, '鎖鏈']];
    const can = bits.filter(([bit]) => mask & bit).map(([, name]) => name);
    return can.length <= 2 ? can.join('·') : '';
  }
  function pages(forms) {
    const visible = forms.filter(f => f.enabled);
    if (visible.length <= PAGE) return [{ label: '', forms: visible }];
    const levels = [...new Set(visible.map(f => f.min_level))].sort((a, b) => a - b);
    return levels.flatMap(level => {
      const group = visible.filter(f => f.min_level === level), result = [];
      for (let i = 0; i < group.length; i += PAGE) result.push({
        label: (level ? `Lv${level} 以上` : '不限等級') + (group.length > PAGE ? ` · ${i / PAGE + 1}` : ''),
        forms: group.slice(i, i + PAGE),
      });
      return result;
    });
  }
  const footer = (poly, waits, flags, enabled) => enabled
    ? [65535, 3, flags, (poly.kind || 0) & 65535, (poly.kind || 0) >>> 16, (poly.form || 0) & 65535, (poly.form || 0) >>> 16, ...waits]
    : [65535, 2, flags, (poly.kind || 0) & 65535, (poly.kind || 0) >>> 16, ...waits];
  const node = (tag, cls, text) => {
    const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e;
  };
  function choose(tier, form, options) {
    const reason = problem(tier, form, options.level);
    if (reason) { options.message(reason); return; }
    options.select(tier, form);
  }
  function card(tier, form, options) {
    const reason = problem(tier, form, options.level);
    const b = node('button', 'poly-card' + (reason ? ' locked' : '') + (options.selected === form.poly_id ? ' on' : ''));
    b.type = 'button'; b.setAttribute('aria-disabled', reason ? 'true' : 'false');
    const pic = node('span', 'poly-pic'); pic.append(options.portrait(form.poly_id, 46)); b.append(pic);
    const tag = weaponTag(form.weaponequip), restriction = weapons(form.weaponequip);
    if (tag) b.append(node('i', 'poly-tag', tag));
    if (!form.enabled) b.append(node('i', 'poly-lv lock', '停用'));
    else if (form.min_level) b.append(node('i', 'poly-lv' + (options.level < form.min_level ? ' lock' : ''), (options.level < form.min_level ? '🔒' : '') + 'Lv' + form.min_level));
    b.append(node('span', 'poly-name', form.name));
    if (tier.book) {
      const price = node('span', 'poly-price' + (options.gold < form.price ? ' poor' : ''), Number(form.price).toLocaleString('zh-TW'));
      const coin = node('i', 'poly-coin'); coin.setAttribute('aria-label', '金幣'); price.append(coin); b.append(price);
    }
    b.title = form.name + (restriction ? ' · ' + restriction : '') + (form.min_level ? ' · Lv' + form.min_level + ' 以上' : '');
    b.onclick = () => choose(tier, form, options);
    return b;
  }
  function grid(parent, tier, options) {
    const groups = tier.book ? [{ label: '', forms: tier.forms.filter(f => f.enabled) }] : pages(tier.forms), controls = node('nav', 'poly-tabs'), body = node('div', 'poly-grid');
    controls.setAttribute('aria-label', '外型等級分頁');
    const render = index => {
      body.replaceChildren(...(groups[index]?.forms || []).map(f => card(tier, f, options)));
      [...controls.children].forEach((button, i) => { button.classList.toggle('on', i === index); button.setAttribute('aria-pressed', String(i === index)); });
    };
    if (!tier.book && tier.forms.filter(f => f.enabled).length > PAGE) {
      groups.forEach((g, i) => { const b = node('button', '', g.label); b.type = 'button'; b.onclick = () => render(i); controls.append(b); });
      parent.append(controls);
    }
    parent.append(body); render(0);
    if (!groups.some(g => g.forms.length)) parent.append(node('p', 'hint', '這一階目前沒有可選外型'));
  }
  function render(parent, options) {
    parent.replaceChildren();
    if (options.mode === 'setting') {
      const shana = node('button', 'potion-pick poly-shana');
      shana.type = 'button'; shana.append(options.shanaPortrait(), node('span', 'nm', '夏娜的變形卷軸'), node('small', '', '外型不變 · 沒有時買一張(3,600 金幣)'));
      shana.onclick = options.selectShana; parent.append(shana);
    }
    for (const tier of options.tiers) {
      const section = node('section', 'poly-section' + (tier.book ? ' poly-book' : ''));
      if (options.mode === 'setting') section.append(node('h4', '', tier.book ? '時間到自動變身，變了才扣金幣' : `${tier.label} · 沒有時買一張(${Number(tier.price).toLocaleString('zh-TW')} 金幣)`));
      else {
        const last = tier.forms.find(f => f.poly_id === options.last?.[tier.tier]);
        if (last) {
          const row = node('div', 'poly-last'), title = node('div', '');
          title.append(node('b', '', last.name), node('small', '', '上次的變身'));
          const again = node('button', '', tier.book ? `再變一次 ${Number(last.price).toLocaleString('zh-TW')}` : '再變一次'); again.type = 'button'; again.onclick = () => choose(tier, last, options);
          row.append(options.portrait(last.poly_id, 40), title, again); section.append(row);
        }
      }
      grid(section, tier, options);
      section.append(node('footer', 'poly-foot', tier.book ? `身上金幣 ${Number(options.gold).toLocaleString('zh-TW')} · ${options.mode === 'setting' ? '只選擇外型，現在不扣金幣' : '變身成功才扣金幣'}` : `背包 ${count(tier, options.inventory)} 張${options.mode === 'setting' ? ' · 只選擇外型' : ' · 點一下變身'}`));
      parent.append(section);
    }
  }
  function confirmText(seconds, form, gold) {
    return seconds > 60 ? `目前的變身還剩 ${Math.ceil(seconds / 60)} 分鐘，確定要重新變身成「${form.name}」嗎?變身成功會扣 ${Number(form.price).toLocaleString('zh-TW')} 金幣(身上 ${Number(gold).toLocaleString('zh-TW')})` : '';
  }
  function bookDecision({ valid, enabled, level, minLevel, scroll, book, gold, price }) {
    if (!valid) return 'invalid';
    if (!enabled) return 'disabled';
    if (level < minLevel) return 'level';
    if (scroll) return 'scroll';
    if (!book) return 'missing';
    if (!Number.isInteger(price) || price < 0 || gold < price) return 'poor';
    return 'book';
  }
  function bookAuto(poly, data, inventory, level, gold) {
    const { tier, form } = selection(poly, data), bag = [...inventory];
    const scroll = tier && !tier.book ? scrolls(tier, bag)[0] : null;
    const book = bag.find(it => matches(it, { item_id: 99247, name: '變身書' }) && (it.count ?? 1) > 0);
    const action = bookDecision({ valid: !!form, enabled: form?.enabled, level, minLevel: form?.min_level,
      scroll: !!scroll, book: !!book, gold, price: form?.price });
    const error = ({ invalid: '這個變身外型不存在', disabled: '這個變身外型已停用，自動變身先暫停',
      level: `等級 ${form?.min_level} 以上才能變身成 ${form?.name}`, missing: '背包沒有變身書，請重新登入領取', poor: '金幣不足，自動變身先暫停' })[action] || '';
    return { action, error, item: scroll || book, form };
  }
  return { bookTier, bookDecision, bookAuto, confirmText, empty, active, matches, tierForKind, tierForItem, scrolls, count, migrate, selection, problem, weapons, weaponTag, pages, footer, render };
})();
if (typeof module !== 'undefined') module.exports = PolyMenu;

