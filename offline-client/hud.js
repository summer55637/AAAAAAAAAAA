// 遊戲 HUD:狀態列、聊天頻道、快捷欄、底部導覽與各面板(角色 / 背包 / 技能 / 設定)、自動狩獵。
// 依賴 app.js 的 st、send、$、SPR、self()、findPath、adena()。
'use strict';

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`l1j.${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`l1j.${key}`, JSON.stringify(value)); } catch { /* 無痕模式等情況存不了,不影響遊戲 */ }
  },
};

st.clickSelect = store.get('clickSelect', false) === true; // 這台裝置共用,預設關;不放進角色 / AUTO 的伺服器設定
function setClickSelect(v) {
  st.clickSelect = !!v;
  store.set('clickSelect', st.clickSelect);
  if (!st.clickSelect) clearPicked();
}

st.showPcNames = store.get('showPcNames', false) === true; // 設定「顯示其他玩家名字」(使用者 10/29;這台裝置,預設關 = 點了 / 選為目標才顯示;判斷在 app.js drawCreature 的 pcNameHidden)
st.hideOthersPets = store.get('hideOthersPets', false) === true; // 設定「隱藏他人寵物」(這台裝置,預設關;判斷在 app.js isHiddenPet)
function setHideOthersPets(v) {
  st.hideOthersPets = !!v;
  store.set('hideOthersPets', st.hideOthersPets);
  if (st.hideOthersPets && st.target) { const t = st.objects.get(st.target.id); if (t && isHiddenPet(t)) { st.target = null; st.path = []; } } // 選中的是被隱藏的寵物:清掉
}
st.game = { expTable: [], skills: {} };
loadGameData('/game.json', (g) => isGameDataTable(g?.safeEnchant) && Array.isArray(g.expTable) && g.expTable.length > 0 && isGameDataTable(g.skills), (g) => {
  // 機率類減益魔法(資料表 type 1,不改會預設放自己 → 伺服器判定失敗):對敵人放。44 魔法相消術:PVP 用
  for (const id of [29, 36, 39, 40, 44, 64, 71, 76, 87, 133, 152, 153, 157, 167, 173, 174, 183, 188, 193]) if (g.skills?.[id]) g.skills[id].hostile = true;
  st.game = g; syncRoyalSwordData(); updateHud(); renderPanel(); renderHotbar(); renderSupport(); });

// ---------------- 小工具 ----------------
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const baseName = (it) => it.name.replace(/^[+-]\d+\s*/, '').replace(/\s*\(.*$/, '').trim();
// 背包名稱(客戶端字串表)和資料庫名稱有時只差空格或異體字(品質 綠寶石 / 品質綠寶石、斗蓬 / 斗篷),
// 括號只拿掉數量和狀態,保留(右)(男爵)這種名稱的一部分
const nameKey = (s) => String(s).replace(/^[+-]\d+\s*/, '').replace(/\s*\((揮舞|穿戴|點燃|燃料用盡|\d+)\)/g, '').replace(/\s+/g, '').replace(/蓬/g, '篷');
// 用道具名稱查 game.json 的表(itemStats、safeEnchant):先照原樣查,查不到再用 nameKey 比對
function byName(map, it) {
  if (!map) return undefined;
  const v = map[baseName(it)];
  if (v !== undefined) return v;
  if (!map.__keys) Object.defineProperty(map, '__keys', { value: new Map(Object.keys(map).map((k) => [nameKey(k), k])) });
  const k = map.__keys.get(nameKey(it.name));
  return k === undefined ? undefined : map[k];
}
// 快捷欄記的名稱:祝福 / 受詛咒的和一般的同名,要分開記(「祝福的瞬間移動卷軸」≠「瞬間移動卷軸」)
// 魔法屏障卷軸(名稱「魔法卷軸 (魔法屏障)」帶括號,baseName 會去掉變成「魔法卷軸」,會跟別種魔法卷軸撞名):快捷欄記完整名稱,別種魔法卷軸不能放
const CM_HOTBAR_NAME = '魔法卷軸 (魔法屏障)';
const CM_HOTBAR_RE = /魔法卷軸\s*\(魔法屏障\)/;
const isCmScroll = (it) => /^魔法卷軸\s*\(魔法屏障\)/.test(String(it.name || '').replace(/^[+-]\d+\s*/, '').trim());
// 空的魔法卷軸(10/31 使用者「空的魔法卷軸增加放入快捷鍵」):baseName 會把「(等級N)」去掉,五種等級撞名 → 快捷欄記「空的魔法卷軸(等級N)」
const blankScrollKey = (it) => { const m = /^空的魔法卷軸\s*\(等級\s*(\d)\)/.exec(String(typeof it === 'string' ? it : it?.name || '').replace(/^[+-]\d+\s*/, '').trim()); return m ? `空的魔法卷軸(等級${m[1]})` : null; };
const hotbarName = (it) => itemLabel(it, isCmScroll(it) ? CM_HOTBAR_NAME : (blankScrollKey(it) || baseName(it)));
const isEquipped = (it) => /\((揮舞|穿戴)\)/.test(it.name);
const isLocked = (it) => !!st.locks?.has(it.id); // 道具上鎖:st.locks = 上鎖的道具編號集合(伺服器 PACKETBOX 0xEF 的 locks / lock 事件)
// 次數制道具(魔杖、寵物召喚笛…):單個道具名稱結尾的「(n)」是剩餘次數;堆疊道具結尾的「(n)」是數量
const chargeOf = (it) => { const m = it.count <= 1 && /\((\d+)\)$/.exec(it.name); return m ? +m[1] : null; };
// 祝福的道具(bless 0):名稱前面加「祝福的」、圖示加金色光暈。只改顯示,比對道具還是用原本的名稱
// 刻印(祝福值 +128,128~131)的道具:去掉刻印再看祝福 / 詛咒(刻印的祝福瞬間移動卷軸 = 128)
const blessOf = (it) => (it?.bless == null ? 1 : it.bless >= 128 && it.bless <= 131 ? it.bless - 128 : it.bless);
const isBlessed = (it) => blessOf(it) === 0;
// 受詛咒的道具(bless 2):名稱前面加「受詛咒的」
const isCursed = (it) => blessOf(it) === 2;
const itemLabel = (it, name = it.name) => {
  const pre = isBlessed(it) && !name.includes('祝福') ? '祝福的' : isCursed(it) && !name.includes('詛咒') ? '受詛咒的' : '';
  return pre ? name.replace(/^([+-]\d+\s*)?/, (m) => `${m}${pre}`) : name;
};
// 獲得訊息與背包事件可任一方先到;每筆只配對一次,保留 500 ms。
const pendingGain = [], recentGain = [];
let gainBurst = null;
const itemBlessOn = () => settings.itemBlessNotice !== false; // 11/02 #43:設定 → 訊息過濾 裡的開關(預設開,不靠 gateway)
function gainName(name) {
  try { return String(name || '').replace(/\s*\(\d+\)$/, '').trim(); }
  catch (err) { console.warn('gainName', err); return ''; }
}
// 813 的隊友訊息與逾時原文沿用既有格式；關閉標示時只去掉伺服器加的字首。
function partyGainLog(ev) {
  const name = String(ev.args?.[1] || '');
  const prefix = /^(祝福的|受詛咒的) /.exec(name);
  let text = serverMsg(ev), cls = 'sys';
  if (prefix) {
    if (itemBlessOn()) cls = prefix[1] === '祝福的' ? 'bless' : 'cursed';
    else text = text.replace(name, () => name.slice(prefix[0].length));
  }
  log(text, cls);
}
function gainMsgHold(ev) {
  try {
    const party = ev.id === 813;
    if (party && (!itemBlessOn() || !st.myName || ev.args?.[2] !== st.myName)) {
      partyGainLog(ev);
      return true;
    }
    if (!itemBlessOn() || (ev.id !== 143 && ev.id !== 403 && !party)) return false;
    const itemName = ev.args?.[ev.id === 403 ? 0 : 1];
    const name = gainName(party ? String(itemName || '').replace(/^(祝福的|受詛咒的) /, '') : itemName);
    if (!name) return false;
    const now = Date.now();
    while (recentGain.length && now - recentGain[0].at > 500) recentGain.shift();
    const index = recentGain.findIndex((g) => g.name === name);
    if (index >= 0) { recentGain.splice(index, 1); return true; }
    const entry = { name, text: serverMsg(ev), party: party ? ev : null, at: now };
    entry.timer = setTimeout(() => {
      try {
        const i = pendingGain.indexOf(entry);
        if (i < 0) return;
        pendingGain.splice(i, 1);
        if (entry.party) partyGainLog(entry.party);
        else log(entry.text, 'sys');
      } catch (err) { console.warn('gainMsgHold timeout', err); }
    }, 500);
    pendingGain.push(entry);
    return true;
  } catch (err) { console.warn('gainMsgHold', err); return false; }
}
function gainNoticeLog(text, cls) {
  try {
    if (!gainBurst) {
      const burst = { count: 0, extra: 0 };
      setTimeout(() => {
        try {
          if (gainBurst === burst) gainBurst = null;
          if (burst.extra && itemBlessOn()) log(`獲得 ${burst.extra} 項道具(…)`, 'sys');
        } catch (err) { console.warn('gainNoticeLog timeout', err); }
      }, 1000);
      gainBurst = burst;
    }
    if (++gainBurst.count <= 8) log(text, cls);
    else gainBurst.extra++;
  } catch (err) { console.warn('gainNoticeLog', err); }
}
function itemGainNotice(oldItem, newItem) {
  try {
    if (!itemBlessOn() || !newItem) return;
    if (!oldItem && isEquipped(newItem)) return; // 已穿戴中的道具重送不是獲得
    if (performance.now() - (st.gearUseAt || 0) < 3000 && isGear(newItem)) return; // 剛穿 / 脫裝備:堆疊拆開 / 合併不是獲得
    const delta = Number(newItem.count) - (oldItem ? Number(oldItem.count) : 0);
    const name = gainName(newItem.name);
    if (!Number.isFinite(delta) || delta <= 0 || !name || name === '金幣' || Number(newItem.itemId) === 40308) return;
    const now = Date.now();
    const index = pendingGain.findIndex((g) => now - g.at <= 500 && g.name === name);
    if (index >= 0) {
      clearTimeout(pendingGain[index].timer);
      pendingGain.splice(index, 1);
    } else {
      while (recentGain.length && now - recentGain[0].at > 500) recentGain.shift();
      recentGain.push({ name, at: now });
    }
    const label = itemLabel(newItem, newItem.count > 1 ? name : newItem.name);
    gainNoticeLog(`獲得 ${label}${delta > 1 ? ' ×' + delta : ''}`, isBlessed(newItem) ? 'bless' : isCursed(newItem) ? 'cursed' : 'sys');
  } catch (err) { console.warn('itemGainNotice', err); }
}
// S_InvList 的 useType(ItemTable._useTypes):1 武器、2 盔甲、18 T恤、19 斗篷、20 手套、21 靴子、22 頭盔、24 項鍊、25 盾、37 腰帶、40 耳環、57 戒指
const SLOT_OF_USETYPE = { 1: 'weapon', 2: 'armor', 18: 'T', 19: 'cloak', 20: 'glove', 21: 'boots', 22: 'helm', 24: 'amulet', 25: 'shield', 37: 'belt', 40: 'earring', 57: 'ring' };
function equipSlot(it) {
  if (SLOT_OF_USETYPE[it.useType]) return SLOT_OF_USETYPE[it.useType];
  if (/戒指/.test(it.name)) return 'ring';
  return null;
}
const isGear = (it) => !!equipSlot(it);
// 魔法頭盔:放在頭盔旁邊另外兩格(不能重複、只給魔法,伺服器 L1PcInventory.isMagicHelm)
const MAGIC_HELMS = new Set(['治癒魔法頭盔', '敏捷魔法頭盔', '力量魔法頭盔']);
const isMagicHelm = (it) => MAGIC_HELMS.has(baseName(it));

// 自訂圖示來源 deploy/feature-battlescroll/icon.png (58×58)，invgfx 65043。
// 內嵌獨立 PNG，不修改共用圖集或範圍外的資產索引。
const TISHA_GUARD_NAME = '緹夏的守護';
const TISHA_GUARD_DESCRIPTION = '刻印道具:不能交易、給予或賣出。使用後 30 天內 AC-3、減傷+1、回魔+1。死亡不會消失,下線照算時間。效果期間再使用一個延長 30 天。'; // 10/27 使用者:說明改成「刻印道具」開頭,結尾不再寫不能交易
const TISHA_ITEM_ICON = 'data:image/png;base64,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';
const TISHA_BUFF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAxOklEQVR4nO19d5gdxZVvV+fum+/koImSRhrlLCRQIghEENhkbIIXbMJisA3PYC+O2MaA1zZre8FgWBMM2MYgwCCShDLKWRpJM6PJOdy5qXPX+073DX3DSPjtvn/ec33SzL0dqqt+dfI51YOWzKgIuFlF1REi/tlSDWOCY+nRqEoH3OztV83y+d0kHP8nSHbDJkGMhaLPvXmQVlXd53cfaRk83THMcTSBif/fGyIURa+tKpheX6SqOk0ggiRQW+fw8+sOsxxDEDhNRSjNdvYnDLdbH5H9OUFyOHEs+dVxS/qxzl//B8SKcz9mLCa2vqUGkBiDddT+Cqew/RnmaF+f7ij5HSOkKtq/rJ0xs76YQARtH+VYhuMYhmOsHjGBgOFQJjr2geR/qyv7oPN04hM8DCUOZOI0Li55STf/1c65pSeYmHhmd4lLMU51ZWFkNTMJYKqLxNyRBYh9PAEQxhi6h18YCCcJPLIJx5ovEI1FONZvOOBcJRswJ3RJOsqzznmmnhc5BxJnYP3kVUAWuQgmCCs5IwdMieszL0YImxYcOAOg5IgtdPKMAaUIJ+usk2WSn5MElbejzC7P0hzXWJBnTjLzKnsVk9NM/E7DButrcVZqtEmMrDPO4WUMLA2QdYpMkUOKb5DjFptwcqaa2W8aqTx3ZR93NJtgEUGYaX7IOJs5lmy8UlIyIREdEihDUKbusseJgcJtMk9MHQaBxgEo82FELjo50Dh/5IKQezQ/2VhHSYIwTCBtmnKwZQ5Lpk+lRpfih6SIdKyyRTZZMGWSUgItxwFns6yfZG+Z57LIIucaawXysV3iUBY6KR2X8d1x1MSES6QDXtZITirvZZnf0qNyHnE+NvviHEpMdZy6C+UFKKFykmoc+kWZU031YB1K4gNHnVSZdSh5UcZUUfqKxD+GomTFuO9Ljd+9c6ahExRFZl2QvMnRiROpxPkMu8Q53NQAnCuX/Jxg7bxMMA6L5ZNXKPlrnLXKQzJZXeQnN0RQJIpK2nnzSr5wQRXDkItmFWzZOxDwcppuEpliOflwh0ROGBUpDoERpHguWwundGuWcE4ecgiwXBZzyt9sMYtyCfIM6DgWNj0xlI9PEEqIHq+L+eq1k1mGpEjypsvqWBoZupm4J4fLsgVp7lpmiosMvZJzAsyejNMZGDlYzBJ3zlmjHM7KIMxcnnIQbYoNE9A4EHEyClxLIlU1V59bsWRWkaSYcUm/8Jzyc2YXxiSdykTcBiuNV7qz/EyXITAdasfuIdVH2ohM9JVBNBlfEmhmAo0ybs5evizCcS6E0zDKI1mTs8AYFwW5r3xhoqqbluQBwr/jmimIBEs3U7A4lsRBqNkCzzn4PFIpR0I7ZbbNko6RpgFyarlcnYXST8wYaLYbkhxxxtjz4WI3mkJxybj6wpq6SremmQTCJEnIqjl/euGKBaVjUYWm7IfkQSot/tMI5Ewhe8h5r3AI8ZwBO7VYoqMzcBZyopPLVilAHCojGxLHPCkKqZpZUSKuXVUJFhCBGZpkKNLEJkOTt1w5iSRh1UgyfzcZwGQxnc0qqQHko6MsXsNkUkmOD1CuxiGyOCv7bB7CSRx0MlQeJiEIhiI11cQEccc1k2orPbG47haZP68//cJbp7wuJhxRF88sunp1zeCojCw1Nx4ZOp+YwdMIDKu83ODkqvRBDKxt/3PiQOehu9yxENm0nc/WyqHbfNRt30aRREzWyovE+29uXHNeRTiuuUS6d1B67NmDmoEvXTahOMjLqvmdr86qKnO/uK41FNHcAqUblseeA1NaqaeCNTBP5PfQsmLKipHQ8M5L08Nx3pvj0+bIIMtZdTIXkaOznLIuSTYJ09epybO4IEm6iIQPkmKuXlrx3I+XXLaiMirrPEsZBv72L3Z2D8TGotpjzx4xTGA3RBD/euPUXz+8cEqtNyYZFEWm9WAms2fxO0kShmGeM6ukvFhQk+ZC1oql9ZpTtMM3PC6LJdDH4zIXchKCNVsCEzxHB3yMk3UzdIdTQpEApWEQd13X8Pi35lWWuuKyEfCyI2PKnT/a9u6mTpfIFAfETXv7739s98CI5HMzkai2YFrw6e8vXrWwVJYNmiIdS5DJyBkfEEWhpXOLSgoESdZsKTY+Rll8g87gauThMJTRSxbtIMMkyoqERTOKYRB2F1kWnFNCYWSa+Ju3NN5zY4NhYEUzNM14+e3mL97/yTsbO1wC7RE5hiI5hty+b+C272x79o2TqmZIihn0sk88OO+ipWVxwMiBTKbtkCQl2/JkZzUE6irdpmkmxG9eeZSFTTY+WXZQBnNl9JSBTnJYFEmqmlFT4b5wSZmmG6aBM6Smw1xBBCJJJKvGLVfWf/mK2mhcMzFmKDIu6dsPDDS1jLpEJuhziTxrky/NkEMhtaM7Jqsmw5CKapIk+t7dM2c1+KJxjaad+ifFXolG06SqGrMaApOqvKsWlzEMMjHoqCzF4SCLbJnqNKUdMuhMtjuR68ZRCMjYMPHMyYHlC0pYBumGSdPJWG2aDyyhQCFJNZbMKf7mLY0URfIcjTGh6WZhgH/q4cUv/GR5RbGXoigIkJNINwiXwDz5wLwff31uoZ/TNCABbBKlheKjX59bXiSoOoa4aOaUSUTQJGJoUpKNwgB/9w0NsmrMayy49cpJQyMSSSKaJklkxZIzoMlj5+ZnMQcW+dSW1dLShEAmJgZG5IXTC9YsqxA46pYrJ45FVd2SiE50krcRHI0Wzig41hL67OBgz2Dc46I5llQ1U1KMKy+o/t6dM1JTpkj08B3TL1xSNhZVFc2kKORx08NhZf3Wrv5haXKtR1X1hG3k0A0mxlFZHxlTKorFn9w/Z9pEv6KZuom/deuMO66ebOh4JKTIKthbeRX/eBo8I+Rqq8nEo8dhLpTs2+thVy4sufv6hpICIS4bd3yxQdfxB9t6R8dU3bC8BAcpYhOTFPrT30//7tUToxGptJBbc+6Er103pSggyIoxFlEvWVaxr2nkT++eJhF53ZqaS84tj8Q0RCAW+Mv43QvH3/yk/VTbmKwZHhdDU6TAWmyWyhxgwuflJ9e4p9cHLl85oabCJckGRQLdMTT53TtnrVxUtmlP//GWsdauSFzSk3NLKP6kp5+0B8YDaBwbCGUeh4+NE/23rK2/YHEZy5LhqEaRiGbIb98+Y/n80hffbv3s4KCug0Pj7A1jFInCynsEbixiPve35l1Hh3/17UV1le64bOgGvnZ1zdsbOhiKXrtyAoacA+IZMhRRv/Hzz97Z2MnQyO/mCwK0pYghI0FmRgT9bmbhjKLLV1RWloiRWCJRjBBhWhbDigWlbpHWdbN/WIrLuhWQTs4uGTtJmT/4bPGgnPh7zpeTbeFHnz70t4/a7r+5cWqdP67oyDAfffrwK+80KypmaJplqQxn1c6JwJxIkaZIEhX4+dMdsZ/+/vCvv7OApamYpDfW+SdXu2MSnjHJH5U0W6z+26/3vLOxI+jjPSLLsYzNFpa9a5t06bl19sV+96em/3j52AVLyh64dVphQNB0uE4QqI07e3/2+0OHTg5TFOIYmuNohgIfL1+mxIrmj2soWgHsXJsAObndUhmabo5F1PVbur/9i729Q5JHZJ7/28mfPHNgYERWNNOAGSR509axthma+IkNw1RV0+/l9hwZefPjTrdIY5PQDXNuY2HdBBfNkJqOfW5m3caOdRs6/B7O4+IEjk2Ak8zJ2ArMhiwt9DB69b3T33hs12hYtdJb1Pot3bd+d/OuowMsQ4k8x7E0TZFOWzBLWmc6wHmFdM6duV8RuJpkRYnneEvkrY874pL+21ePizwd9ImFAZdbZFO2mfPxmTaAFYhBxLZ9A8MhhaFIXcdT6vyN9X5VhbhHXDE+3NoVlzSfmxdY1rS8B1vCZun1tPdp2QfVpd49R0O///MJj4vuHog9/MvdcUkv8gt+j+C2yJCyUoMO1zFLWo9jB6W8YOfl2FKfFAVWTA5iWNUMiiKONo9t2tM/FlFFnhF4BtY34SbmNU7T5hFUUHBkR09sKKSwHKmbuLrc3Vjv1w2TY8iBIelUR9jtYqFPS36OlyNIDdpWbapuukVm466BnoH4+q1d7b1Rn5sTeQ64CltZQbgSbBSLzzK7ytFk+WPSKcZmaVJVjJiuszRJUyRl+UdJjw80K8dSp3sib33SSdMkx9KkrRZyXGdQF5CCypDbmMAUgaJxXVHAz9J0vTjIBzysYYBYlRR9JKSIHEMiBDzr1ImWQZp8VCKvjAmUXBhMU2hoVD50YnTvsWFDxyLPUhRpmdQEjcCa1w2sytCrW6A1A+ysHD82P0DWRJKfCAJSVA/eNTMu65t29R9rGYvLOkkSAkdjK5BsMRoaGJZHRlWOoWmKyvMAGhkG1nTMJKV2ArwEjAgjBEaBVXLiFiEjDj0nLQ6KoSwxk8wpJxFXNczQiKYJw8hxx4FCAIJdh4d6ByUQOmC+YpomNc3UNJ1hqaoy15LZxROr3S+80dw5EKdJWOwsojwTBdnkQ1FoLKx1D8Qf+pcZN15a19oZfX9z1yc7e093xTiOZGnStGZimoRmmoLAJhSMo3uKJCNR1e/lioPs0KickQ60RS7CLo7mWejKEcFBpoF5jvS6GEXVQPdZ7hS2lgSmTxJVZeJoWB0OyV43YxgJUkp3D+YP2nloeGhUdQkMRYLPGIlpfi+7alHpZSsq50wtKC3kX33vdEtXWOBpbNFkXhpyApTh9kEmz8Asg/6yvv2qVVXV5a6GWu/Mhhk3XFr79sauv37Y3t0X97hpGyNYapuLkqRnD1dW9fPmld5+9cTtBwafe+OUm6cNM22OUgipmlFaKHhERtfhmC1ETExoBvZ7uaoyV1ffMGlnxJOY0gjFJG31uWXnzCp+/o3mrQcGOMayjDDIIGw5JRAgJFH3QFw3TI+bVSGYi9aumnDN6poF0woxwpputvfGHnvuYDgmU5TAsgxhmjb640YU8zaKJsdi6lsbOnmOlmUjEtWKC/h7b5zyzA8XX7qyUlYNoP9UbVpyiqno7D03NDz13fmzpgSONo9GYoqBAZ5UxA5Z4ecJ5a6gn9MMgySJuKRHYhpEc0wz6OMmVvtkVbfFeVpzWT8PnQhNm+j79Xfm3/elqRafppW0gwkwyFAV11d5fv3Qgp/eP3fRzEJJ0aMxXeToNz9qa24fcwkMx9AJhZqvnQUgwrKNNu3u6xuSGJYET1LHYzG1tsL9xLfmfh0GB/ScHHriN0kiTTPuvK7hnhsgrDEypvQNRWVVp0hIWzjcKPAkpk/yCRxtmJimyL3Hhj7Z0c0ylGmFqOc1FrhF2jBwag3sWyka/I+RsKpq5h3XTLz3xgZNN+2oLMbAgMm4GopJ+tqVE575weJVi0s13YzGdMt9QaMR5c1P2kGe8mxa7p4ZIGeuOfXTxFjg6Nau6NZ9Ax6RMUwIO9AUqaqmopl339Dw4G3TrLkk7rXGB8O6YEnZLWvrxqKabuCyImH6JD+B4caEOgKvnVBVs6xIXDqnWFLA7RIFasPO3rc/7eRYCKBHY9p5c0ury10xSaMgEJmKsSBFNRtqfWWFvGHicES96fK6CxeXjUU1CKcllRpCSFb0W6+a+JP75/g9rO3ZQfgBmx4X897mrgNNw14XS1NUuu7KGaz5/BREIEJWjM17+oH4E6VVgAIiUCii3nh53a1r62Pg/pG2YsIYF/jZO69tsPGiSKTp+OYrJlWXi9EYeG02l1GI1A18wTkAgaqaNIVCYXX34aHDJ0eb28M8B8Z0UZC/ZnWtrOgUZZmIFnVIilFeJFx1/gTTBHOGIJBu4DuunuT3ULq1fnbwKRbXb1pT+8Btjbpp6gaQp63iKBKFo9p7mztlRedhKdL0cRYKGq+ZJhRd7Dw0eLo7IvCAdxJuKG6MxrRv3znzmtXVYDRa48UEIQpMR18MIYIBIwbwnVLr/7evzXK5KHuxaIqMScbkGs+Xr6iTFcPEhMfFbtjZe6ItNDAib9ozwFvOeiSuf+ny+rmNgbGoyljBVkwgt0jf9+UpU+p8kmLY9jrPUZG4RlOELOsUCahpqnn9pbU/vHd2XAa5l8qJYIwFnj5yanTDzp6Al2MYKr/xkx+gFH85Ih0IHAJM0WhwVN6xf9Cy9xMnMcY0A4rrpTdP9Q5FNfDfLduPRAMj8oNP7Pvx04dikmqHqWKyfsmyygmlvCzrLE1pmlngZx+6Y5rfMgtpCkXj2mvvt3rd7MIZJe982t07KNmSiOfoH9wzuyDAyqoOhoxuVpaKq5eWS4oO0QyMWYZ85s9NNz+0qak1pBm6YWADzFcweT7+rA+S/UB9yTHDeuMPt3ePhhWBt1Yvi34SS3w2Csr2KQyCY6gPtvdYS5TqFBTq93+z76vf3/Ln90/HJFXVDFC0GOiZYdBLb5/+zZ9OWI4HTKO5PbK/aUjVNE0DG+ehO6bNaggqKth5okBv3NmzbkPbrVdOuuu6KfuPjby7qYumgacUxWio9f/grpkuAWAVObqzN7776DDLUKpuuAT6lXdbHnxy12hYCfgFgWNT+utvH3d+7Qfbn3rlKMjsZJUnMHJEeXdTh6288k52fAoav2GMKQqdao8caxmjaTA6TRNzNLn7yNDL7zZ7RHZCmbcw4EpVhtkWV3GQ3/BZf0dPHLwFAvUNxfuHpJhkcCx66I7p5y8ui8uanX0eHVP+/Y9H/B5+zbIJ86YHK4q5P/6tpbk9IvDAVjFJP3duyQ/umSkKVCwOdsCxljFLG6KhkPLXD0/TFCoIiEGvwNAQybVljcdFsSz9xzdbD58MMQxpeYjg3G/a3d/aGRF5xhF9/W8ChOAHRSJZMT7a0csxpF0GSpJEW3eEJJFLZAXeUjwOJQBkQ1gujw4CWNPNKXX+y1ZULZhe9OP7Zq9ZVh6XNIokDdMUeOqpV45t3d9//Zq6hmpfSQG/aklJW1/0P187aeX8MAl5NGP5gtKffWP2/BnBWVMCi2cUaLrJMmQ0roVjmktgXAJnB4lSQRXDwCyNGJqCRSWRlXMEGf/2p+2qbgocQ5Ip7X4mGhrXWc26C1tBmD1HhwdHFZGnDQMs19oKN4lgEI5C0kT8ByGkWAmPoI9VddM0iaCP/c13z9F0M+jl4pJBkqRumD43+86nHU+/1jSpynfblZMwwqqKb1pT/8mOvo27+l99r+32qydGogZNI0k2Fs4onFLrUzUz6OdUFTzPoJcrLRTaumPg0IK1mHRmk+EnjHFpIQ8fTCzw1JFToT1HhniWssSzXS91xgrjHAoa16DEoCzIjt7ogaYRkQenVNXNOVML504F25ShwcBJy0LTshVV8+KlFWVFIlhxJKHrBMtQboGRgC4gHcJz1JHm0e//dl9U0r52bcOMyQFFMVXNnFTtu/2LkwzDfPmdtq37Bl0iZZjgOkiywbGk180oYMFDgC3g4y5ZVplyALNCCLqOy4rF2VMKNMuhFXh6466ejt6oR2TTkjQPQYwTDzpro2kyFNG27x+EkDyBTQNU5gO3TWcYsBvtnCdpaVmaRmNR9aJzy69dXS3JOmnX7Vv0BR6TpX1sonjkqb1NrWNXrqq+7arJkTjYOxQF5XjXXVJ38bmlobDyqxebOvtiPAtCxLoRJc0f8ITDUe3a1XUXn1cZCisQyLWNICt3hBBSdfP2L04q8LGabjA0OTgsf7KjBxGI45izavd/ACASMkqgKSMxjaHIbfsHOvqiHAfOaVzRls4pffTeuQyNopKu6YaqY0k2onF99bnl3/nqdAYm5szrp2Lk4Al/7z/2bdjZU1Pheej2WTwPSj1xGZhzxFevmez3Mu3dsSf+cDwUtm1UK2zm6A2qRGjy0a/PveCc0nBck2RD0yG0IsmGLBu3Xll/6XJwGAkC8Rx1tGV0x6EBrweSIv8AWZwJGoRIBF5PTNJKCoTGer9p4kMnRw8eH60ucyuqTkMtD167qqq6zP3q+6ebTocJjP0e7pJlFWtXVdrGiLO6J90QBIlau8I8TzM0vX5Lz8RqT+o6OyTwp/daT3WMlhS4B0dlRTM8JIP17ApLiI5rwGg/uX/OO592f7C1ZzikYIwDPu6KlROuXDXBwCayAm6GiT/a0ROLa5UlXuuA+d8CyPb0FNUwTWNyje/8xaWLZhWeaA3/fXM3Ioj3t3VdtLQcSlgkfTSs1E/wzmjwz58xv6svpoB7JbhFOho3dD2j9snZObh4PPXT++Z95ZHtPMu+9n577QTPFy+qisRUwrKVP9zW/exfToLdYOJ7b5pSUSJG4w4TzLmK4BhjiqRuuqz2CxdU9Q7GMUZlRaCmdNOMxWAVRYEaHQPzR7D2eymqSVGgl227Ef+jAEHhF5Q2mXMaC65ZXbNiQYlh4J89e2j9tp54XONYavfhoeaOcEONV+CoFz/trC5zX3dx7WBILgyC3aKbOBzLP5n0rMCTNGY0FNx1fcOvXjzh83B/eKOlsd5XP8Gt6eZISHnyv44QBGYY9uYrJy2ZYxV0jt+hTVaRGCTdKopdVrDc1BDRPyJ/sK3rqvOrWZrdfqC7vSda4OPnTS9UVPNURzgugenPMZSdQB8Pp2xuJBHQRXmJ8Mids575weIb19T0DkpfuG/DH9edjERljidFgZEVc/3WHoahOJZaubD00WcOrN/WHfRximqCvsCQOz7jqiQwisb16y6pPW9+oazog6PyH99q0XTT62JfX3/6QNMww1DnzCq55YpaVTPz1TlmN+uhSDNMRQOLWdXMbz2+q9DPF/g5TBDvbGzXIC1OxuLG6nPL/vCjJQ/cNm3u1CDHUmMRFZzYzxMPIkkot7jwnLIXHl36pcvrWIZq64nd/9iOQyeGPC7G5xFcPGdrEMjVjCpxWZ/XWHjZ8sr7frpr75FhrythyGY12wIwTRAE9j8gbCs7RlPkvTdOcQkkQ6MNu/oPnQj1jcRfe78VEUShX7z7hga/lwVytmx35715F9wOBpIIcRz9rz/ZrhvGmmWVimo2d4T3HhviGIpjyOaO8ON/OPr0600XLS1/+fFlv/z2/JsuqxM4Glg4YeqO44tBKkrSrrqw+okH51eWuEbDqkdkXl/fuvPgYMDHQeUODYoGnAyWau2ObNs/4HHRkqJffVEtIsyHf7WvvSfGMVZ02QLFSh6YVp4eUxCaojwu2i3SLoHmOYplSJ6lNN2cWhd44LZpBMK6jjft6d93dPjwyWGvm/vqNZPPmQXsABezpMBTboH2uGiXSDNWEN6w4hgp3Wc3A2Ovm378+UPvb+m696ZpNE0KPL1lT19bN5g/JEXRNOlxMR9t773mG5/uOjR4wdLy79096/lHl162otI2aLPKIRMyiITNAPp588q+89WZLE3GZZ1jyEhMO3B8GGPTLXIUxLoS9Xtg+8vGpt19F51brkElTnDlotI3Pup68oVjP//mXNuEo0jEMpTtTEVi2siYEoqqIyF1eEwORdRQWAlH1GhclxRDUgyI9UVlnuU+Ozh0uisqcHTAwx9vDT/8q/2yojIM8rlYv5f1e9iioFBaJPg9bMDL+b0cgXFc1mHHAkYkBaF+j8is29D+8+cOrVpUdu7ckrhkIEL/ZGevrmMegvNgW+s6URgUQmH10WcOVZa4CoN8Q633yf81f8H7bb988VgsrjklRAIgw8QiR92ytr44wI2EIUZBYIhsK6rOMhTLQA2hlVaBWw0Du0R6x8Ghlo7IlFqvqplXr679YFvPhs/6/vZxx81r6zBB6Bpu7hg70RY+dmq0uTPS2Rft7IsNheSYpJtW3N5WlBRJ0lbGjWFIrwtRw+TAsOx28XHZ3LR7ICapI2NxRQO6tSItEBXwe5jyUrG61DVtYnD2lOCMycG6So9h4LiicyzZ0hV55Kl9JsY3XzmJIpHAUYdPjWzb1+fzWMHD5FY0VTU8buZkW/iDbT13Xj8ZUrs0eeuV9QEv+8hT+8eiYKmnASJJQlGN6nL3gmmFkTjoRWQpI5+bKSsSrbKxDI8FRBqFRsaU7fsHp9Z5FdWc2RCsn+Bu7ZReeru1caLvYNPwW5+0n+oI9w3FwZImKa/IeN3s5Gp/SaFQVugqKeCLArzXzbpEyi0yNElSDNnSEXlpXetYVFs2r+zmtXVgDUBCzYzLRjimjY5BkmdgWOkaiHb2xrbtG/54Rz/HkkE/O29a4WXLJ6xYUMp7uV/81+Hjp0PLF5SvXFBmxQzpLXv7hkJyRbEbtuolI8s2KWk67h2MG7odb0QjY+qV51edaBt78vnDqaq9BAWZJhZ5OuBjFdVI5l9hidcsm/DGx+06gORwtawwI8uSH2zrufbiaopChX7+4vMqn3zhaDSu3/G9HR29YY5BFcXu2ecWTK3zV5d7JpS4yoqFoJd1i1BYQZLWPytkYUlX6HzF/OKjp0Y/+azvK1fVr1hcGrc8j3S9gyX+TEzouhkaU7sHpZbOSFPr2MGTI7sPj/z9065J1Z5l80vf29wpcvR1F9fyLKVopiTr726ClAzDJJKaiQSJNQ2aREEvC36ClYiirGj6VedXvfLOSUlJFNAkg0aQqzSiEriddl6GolAkqq1cWH7x0soPt/cFvJyug/5ICHpIQqDmjsjeo8NrllVu2du7ff9ATNLikj5nWvCeGxoaar31E7wlBQLLQEwaDA2YHjZM8CFNwrQLt+2cKUqu0OUrK0xszp9e0D8IRXOpvYN2QsAOqNAUWVzIlxWLi2YW0BQUEJ1sC+87NrJ+a/eL61owxiUFrtlTClwijSRj676+IydHrNwhRFdtRjBNKFnUDFzg5xbPLtKslJwds1d1s6rMLQr0YEiyLUkACGOCZ0Gj7z82vGJhWTiqWmrCKhc08SN3zm7p2trdJ4s8KJ0UEQEbGua7n3YdPDXy5POHIjH1/EUVd9/YuGB6YVGA1w1TlsFHCUctV5tElAU6TZI0B9mfRPDIDnFbWUFM4PPmlc5tLOA5CoLZyQrmZKYaZJ+um6C8dEI2dHu1aBrNmRpcML3wCxdWHTg++vI7rbuPDj3073uvX1N7+xcnvr2xQ5INr5unKEjJJzqyEuKxqH7d6pq5jQUxi1TthyCCiMu6LOujEcXOLiQAomkyHFVfeLN5/vQChiFNA1xnZHk65cXirx5aeN/PdnX3SS4BIg92DQrGBMOgzXsHQhvl6grP/V9qvHTZBJfIyIoxElJM6BNw51nQrIpmxCTdUlu6rBhxyRgek8NRVZKNmKxLoIkwzN8E9QfxAMut5zlK5BmRp1wiHfTybhctcGAluEU64GKtKIIRVyDGiAnCJdArF5csmln43uau/3z95A9/u3/7gb59R4coCrEs5RShVuBVPX9R2b1fnqpqJpms8dB17PcyH27vaeuJTKwqsdcuqcUM7BaZLfv6f/bs4UfunMnQCKonSVjqmKRPnxj47XcXf/vf9zS1ht2QHUvkwq0qHv2yFVXfu3tmgZ+zpSlDQYaLYylJMVq6Im1dkfae2Mn2UM9AfGBEHgrJIyF1LKoiqECnPB7GJcCcOQaCWHYcniBAaRgYnPJYXItKuiRDjTHLoICPLw7yZUVCeYmrsc43sco7sdpXVeoGglWNaEwnSXTDZbVzG4OPPXd0654BwzR8Ho4mwam2zXfdxFFJv3RZ5ffvmSVwEOe2HUbdMEWeGhxRnnj+cCSu+1yJkEjaFwNNz7Ovvdc2ElYevn1GTbknKkHaDwoQ4npDjffp7y/50e8OfLyjzyXSds0G6EvFLCkUgj5udExlQVVDNOtIS+iDrV2b9/Q1d4TDUYhC0BSqKnc31PiWzi2pKXMXBYXiIOd1sxwLFiNDg7K3+C4xGF2H4Wm6qWqGqsF+i9GwMjSq9A5Kbd2R46fH3vyo42VJFQXa7wYttnppxfKFZcUB2OExNKpMrvF+89apTadDkkwbVvTXFihx2RB58r5rp95+9SSEkGaV0BrWFW6BHg4pd/14+2cH+90CU+CFrCSIvLSdToCaEAXq/c3dJ1rG7rlxykXnVgS8bDimI5OIxLVCP/f4A/Ofe+PUS+ta45Lh4mmIYwrU5j19111cXVfp0Q3zvS2dr7zT/MlnvZGYVlwgNNT6lswunj+tCBKhRQJjoQCl8rY9ZULUzRLfiVc/pHaUsla9nRV+I+EnFIUl6ilshyMc0Y63jm3d379lb/9HO3rf+qSjsd5/zeqa69fUFfg5VTO7+mMn20dLgi6olsSwO8Q08ZI5RXddP3nu1AJVA5WIrKQmyyCRZzbv6XvkP/buPTrkEhmGJFkGLMEMCrIlmGEQHpHpHpC+9cSepR+3feGC6vPPqQh6eUXVFQ0k9Ne/NHVuY8FvXmk6CLFXWuCo013R9p5YZan48C93v7iu2TDx4lnFl6+oOmd28bSJAZGnVA0MPcMAulAdgRhHHZwz3Z3aVwPGBCaM1NdUESVJIq+HXjKncMXCktGwuuvw8Jsfd3y6q/ex545s2NX7/btnz5tWuG5DhwqhMqxrYENOm+i/dnX12vOrRB7cLlvTUxTyupi2nsiL65qf+fPxkZDi83I8Z5XmJ8t4ssMdGMPC0jTJs+TWfUM7DgzVV524aGn5Zcurais8LAOlNCsWlE6p9b7+Xvsr77ZG4ipB4C17+yGC89eTXhdz1/WN9325MeDlFM2QFSMUBsPZ1kkgtsZxmsdrqd1xWU3XsYaxpMDWuwvPKV0+v/jld08/99dTJ1qjDz6x93/9y/TNe3rtov2qMuGa1dWXLq+oKBYjMQ2StDQJNWAYD47Kz/yl6eV3Th1rDgkcFfQLPAdWq6yqZwmYgZVpEH43ixHR0hl76qWmZ/96cs6U4KpF5fMaCytKxAmlrgfvmnnFqooX3mr5cGvPC281k4goDAgcy8yYHPS4mKFROVH6n6fq7H+gpZJMGBOwm0yk508LPP2aLgj00Kj6DdgsJM+YHLjp0kmXLq8sLRQU1RgNqzxHBXwM+JhNw+9t7vjbR20tXZC5KvDxLJMwJrPCBA4WS8iAdK2MZhXvuQUGQYGTufPQ8IbP+twuuqHG2zgxMKshOLXW/8AtjbdcMfG9zV1b9/Wfao8AU1gVgLbQ/b+CTTZSUCdoVR4TkqZGY2bAI8xtLFy+oPGipeUTSl2K5QzzHOUSmVPtY58dHNyws2fjzp7+EUnkab+b58AQAcq2wzJZxTCZFJTIEmVMzLDsK5JEfg8f8PCaYTadju45OsLQrR4XXeDjJ9f4ZkwOXLi0vLQotHnPgMAnNgmcuSVyfM53AjhewJGRKx/njTQZvRFgiJMYuUXmp/fPOXdecTDAm5ppK+K+YWnrvv6Nu3r2Hx/q7I1Jiu53c2WFLqiqhF16EAJ2pK0ydjVmb0VIDTVVD0EkC5OsiBxBk2TQywf9PDaxphl9w0prV8/6bT0iT7E0SdGU7azkzsgKdNkvQYKsr10cQtobm5ISKvVMOyQGcV8rVAa+SaLqJ2O/saMhnqUgzc9RC2cWYoz3HBpo740daBreeXDwaMtoOKJqhsnQlN/DlxRYGSJ7B5v1iEysz74VwZ5FJlJJPxji+KCIIAVG01TAQwW9gm2zmIap6booQA1sap42AVCQBQaFTZGIsqpNJVmPyFo4Avt5dIirmJoBSgtC0TTJcRRDU9YWO9olMiJPgz6yfDr4Z8XJ7HJn2x2xqwc4jhoJKz955nBXf+TA8aHugTjGkJ4UWNoPmXsSpCI4wFa5dAKMLJljl2TnAyg1q+Q21FTRmFUBasXJDMvBM0wiHFGt11FhiFURhvV2EiTp+KIlExrrfVbJD2YpsC9ME0IWkZjW3hNt6Yyc7o6090YHhqTRiBqXoUJat00bw7R52Y5t2iKMZUiOpTwupqRAKCsW6ys8k2q89ZWeoJ8XLH9Nkg0gDCjfhPgcTaFYXPv7pu5oXCawCUzEACgOM8KKQDp4KP0h5ROOR0FZpOVgLyJVRKko+uRqr6yae44McyTUN9sbMUlEyKpRVe5+4LZGkacokuR5qm9Q2nNkaO+xoV2HB481j/aPSLpVr2s5jRDuYCjLgLYqF4HjEGyoszx7QlbA+Td0QzfAwjOJkWT1OPa52fpK9+ypBefNK5s+0V9rRcvGImrQx914af3PnzvscdEiL1r+UGLjAsdRsrWhKFGI65xhxu88LR+L2a61Q4xg6wCUv6nGtIkB3TS37+/nOQ4mkdxsRSLi9i9OnFzjHR5V9h0f+Pizni17+5pOhwSW8rhho2XAK4AHC3CAAKBISw59jpZS5wTGDAOsHYoYf9/U8/r6tuKgsGR20YVLKhbPLNYN85a1kz7a3nuqPREaJ0mQXBxDrphfuufIUM+QZLulKVRyuCtXRTmFdIYcT5Tr4nSWApjTLTANtZAOU2GrEVQr2W+Nk6DIzrtqUVlTa3jDzp7u/lihn3vgtulVpW6XAIUmugFVLK++1/ba+20MTUIdGNDR582QW+Eq86oLqu64epJV+AIzjSt676DU3BHedWiwoye6bEFpXaX3psvqvvn47uKgAPvNEFJVoyjIf+3aSSfaQlKX6ndzdiFDDnOllZe1EOmB5VjSNoIJMY1TeFIUkiR9Yo13/vRChkZV5a7+IdXvYSHaZBnKl5xXWT7BIw5JN6+dyHMgDkC42NLUYiuepzxuOhKTOUbMX/WfryX3HgBJFwW4idXesYhqW1gkQpOqvSsXlek67IymEOFyMWtXVv3p7y1Hm8MeFwNOMklet7pmyqTANatrDp0YjskGOFkZqGSilDOkNEBmDnfhRLENfI5JusfFfOOWxqIAZxj40a/P+/pPd4XjGs9Q2AB+OdUefvqPxzRd97qZ4gKxocZXWSIaBqgnu06YQDgUlsNROejj03v3U7swztwsatN0LMs6RHAsgBgIxyBJ1tt7oh090Z7BWDimxyS9qz+qWwmc2VOC/3rjlCWzi0eGpRsurS0rEp5+/eSx5pCjUCfFVw76yOS8DAqyFVOS6e0J2AWH5PTJgXuub1i+oDQmQYZ3xYKy3z6y6JnXT57qjGgqeFvvfNr11w/bxiISTSOPmy0O8AtnFK1dWbV4VrFbBOueIBBsBkqk5lIrdxY5lNCtFv/b9b0YajRh19HJ9rGPt/ds2Nnd2h2FPFJUsyo4CZ4lPS7OMIiewfiH23smlLlKi4SxiLp1b19rZ8gwDBBjDppJQZSXmvIZisnIM7KqDCpLxS9dXn/VBdV+Dzscku3akbisX7C4Yuak4J8/aPvrh+19w5LIky6e97k5K8BuDowob33SuW5Dx/zphXdeN2XlgjIoj8955VY+BZK35ittRHpdbNPp0NN/bnp7Y3s4Atv1eY4WBbq4wAURNzu0arkEA8Pys3852d4TeenJFT/63f4nXzgkcrTHzWXUt2a9DcSa+ziGYhLF9K0Y1G73gPT7v5z4YGv3jZfVXnxuZVSCHbEiT/99c+evXzrS1h1VIRdOQWANwX4QsLZpygdbbGCf18EToTt/uOPGS2u/+7XZIgeFb7Z1llvTnkk02cds047jqKdfO/6L/zp8ugcypX4vzzHgSVm1VZZwBWq2xSfslwr6uWMt4Y82d23d28fSZEFAZGk6acBmM5fzlZ55AHJSWqJWiYBLVdXoG9JPnB7bfmDgp/dpV6+u0U382cGBf/m3LaGo4hYZngVrxi6+te4FPjUIwi4a9LlgN+VL61pHx1QIfQGPOIb2+fSYZbpDiPZ3rzZ96/FdDE0UB0WBA1/KXgbQiWmWSTzAPqZoxhsftUclQxQYjoXtSRnWTwZzpXVUXoCyfJKEMLKIgiwuECTJ+PXLTXMaC2orPU88f3gsqhYHBYHlkpuV8vgpGLb/gj0S9Auf7hrQDEPgKKhZsGoaP3+zc6rvbuzs6o/ZSXoeyigS0avMQadxtz8bBt5zZDga063topm2YcZS5fVVc2VQygRyMCTCUHzK81RHb2TT7n4SEdsP9rtFmqUZO1JrxwiSL79NPCK12dkEVxNewUFTsJ8FNs6lZ/U5PPWk39/RG8ME9ogsD691hm4zLssmoUQzTRyOa1axXqrKL5NsMiXhuM6qdQ34zCgTIyJxwKpfwcTJtjGOJQ0Tu6yNoAl31BFHyYEp8cUO8ufUB45buZTbILeFEc9lUV/2K4MdX1Nv+gHfJpndyUM7GSxvyYg8ACW7cnhgRAZG8KoghmrvjSmaCZlKx1SdRncGGyc3zKdfpJwesvP3WVrakc6gjvGhGRf5s6CTpI3x7KD0hdmvlSBAFkLsrrM3Njgi25vPISPhyHw6MUrMP6kUM6jJaXIkrjsbNpljzDYEct7blSkT0yoquzwq84VcDhU1DkAp0Wzfh9IvHU88E5FoNKxYqVsw9+34V/q93MlH2j50anDO8lXnix8+nzWdR93lvE87HzAZVyaQcEigPLSTqetzAEoDmRQ7ONPnSJywrrN3b6VOpvYREvkOZXBVmrqyyejsLfPCXEE0vtjNodk86KTmnvEUp6GYhZ1TVmfotdSeXYeccUgfxzgyowGJlv094+iZEBnvWK60caKTgdq4nJXRTX4t5uwtufzY6ilhDqXmbHFKGiG7lMH+kbjGmQHM3EmfnTQ4Ixbjthx6yRy+U/Jkdp91Yz7OymKzHKWb5wvOMxzbY0h16Yil2DfkUmPGuX/ITHQOKFnhemZ0ks/6h9HJwSBdQGWnC6x3NiXe95NoSVLJejlZyplyHrOPpN9ilT52dp/rc/BY5rOyQLZI00HymVQPp1K3J3Sqbe+kxYANVUKCJPtIAKSomqJoWcIVZU7P7ifFbun3LiY7S2nfTDgyEfwfSSZmiN0MUskl9JQqyfzbI8m/gJHLWbAHQ1NULQkQOMC4ZkLBV66Y8c8/XZP60zU1EwqsKkGCZll6LBSdXl80s77of2h9/9/540csS6N//vksIi9CyT+f9b8Buc6iHCDrwAYAAAAASUVORK5CYII=';
const NODEATH_NAME = '免掉經驗證';
const NODEATH_DESCRIPTION = '刻印道具:不能交易、給予或賣出。使用期間內無限次死亡不會損失經驗。'; // 10/27 使用者
const isNoDeathExp = (it) => it?.itemId === 99242 || (typeof it?.name === 'string' && /^免掉(%|經驗)證$/.test(baseName(it)));
const HIGHPET_ICON = 'data:image/png;base64,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'; // 10/27 使用者:高寵契約證圖示 + BUFF(藍底,deploy/feature-highpet-icon/highpet-blue-96.png)
const isHighPetCert = (it) => it?.itemId === 99206 || (typeof it?.name === 'string' && baseName(it).startsWith('高寵契約證'));
let highPetImage = null;
function drawHighPetIcon(g, x, y, size) {
  if (!highPetImage) { highPetImage = new Image(); highPetImage.src = HIGHPET_ICON; }
  if (!highPetImage.complete || !highPetImage.naturalWidth) return false;
  g.drawImage(highPetImage, x, y, size, size);
  return true;
}
const EXP_BUFF_ICON = 'data:image/png;base64,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'; // 10/28 使用者:經驗加倍 BUFF(綠底 XP;之後經驗加倍道具也用這個圖,deploy/feature-expbuff/exp-green-96.png)
let expBuffImage = null;
function drawExpBuffIcon(g, x, y, size) {
  if (!expBuffImage) { expBuffImage = new Image(); expBuffImage.src = EXP_BUFF_ICON; }
  if (!expBuffImage.complete || !expBuffImage.naturalWidth) return false;
  g.drawImage(expBuffImage, x, y, size, size);
  return true;
}
const RENAME_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAA9FElEQVR4nO29d3gUVds/fqbP9r6bZNMrvYMUBR5EESwoNsReQdRHFHtBfUQfuz72gr0riIooXRGlCQkkJKTtJpuebMr23Zmd8rvOzJbZAH7f971+3z++1/UOJs7MzszO+Zz7/tzl3OcEGe/UWbRUjGHB/26ZG02RAyEGt2ipu5fOMtqsKBCl8wj4n2ziqT9C/k8X/I835L/87f+tDT5NBMiQt/+lr/7EYwxrslmPtnrd7k6KJoH4f6Ml/09tCMLE2OJi5/hCW4xhcRlkt7tzxx/VapqS8YOwI/BfcgeeRaQdoDipvFI+gP8TFZ/Kd0p7SGaPIuJ/oacV1yRfK31eTPalmPyWxAkksZP4Bf8lDlN3yPvyfcmLE1ciCBKJMCIAEwptAAA8oW80qaYptYoSRVEGIIUCkoYDnkw2NLGTOJ/eT6OThE9+wAlo/I9kX4lqej8FVVI9xMxPEgCJwy5IfAYxSh0k305Fk/ITcMWDxORvBPYBkuhkeUcEiZPyQyTRSIoLAu+TT8inpIulnoSSkvnNEi7SefDfEiHx/4hUUlZS35eJi3RaPLkoKR8rNUeGQgFQ4h0lDJQaBJDhMpLR+SkRyxCcTIFKPvkEGJL3/Z0oSTDKXZJssqxrCeZPfyR3JLw+0ZHSzTIzSP0Bj6QGJpuQ7HUl+mneSG5pgJJKJD/gJDQEZIAQ+SVSlJS8cxhhpQgoxU/Jd00K2H/JCKFKbCRxROVDSV5Q6YHy16W+Cz5eVhwZMBkN6UcWkAxznRR7RARCikgVnaaQIPnpGbyDZKCTvEt+RaXgZJB08gIl/6TvzRTA9MlTbOm+Tap2kvTht8niIJOyLB0pOBD4EUQoLYNyA1OwJWlB2oEnE1qPnFKC5O9UHIDh6EDIMvUr81rllYmDE9BISdx/aVPelXi1JGYyKJI0JcBJHiZbLklGQicUtJWU8qToKYQvdeYkAGUKxXArBpImTKFWacudaezSuGSoW2pfbmbq4oROn/BqSROROBJlQYP8km6GgvwT7UtAkiCgNFRJqUkorMxYJ4CUpJGTAZSQwMzWIooOTzVa2asnSE1KnhL3KtVH0q/E3enzp5KlTEFLKhfkkIS8pA1lsoGytCR4Lk1M4gmiBMlLou0EaSVJSr7m1CSdULF0I0GmZqVtlnQG+W84RBlqOOxL/25TGOwUqya+UxwOU+pQbq58mL4mzTdJUyibtgwxGm5U0wAlHzes5UhKdpIqhpxMrTKgUTiTyRdOgpuS95TSKTriZOBIH6ApB08WyUQLE3YSem4KLywNfBK2FK+nODl1WUrXZDgzeHcYQEk4Eu+sBAWcVMVSiCgYJ1O/0vKRMl4JzUobxDSWPMdhGKYEKPWeMgRpdk0xqvKLZN/uBAJCEOlHlAQuYewlZy9T15REpEQogwoyqGeYZiHJM8OuT+OWpnCZ5eULEvcqXUoJUnmTD0RB0Gi0S66+wWgyAYFHUOgnKGVKeb3ysZnuq+JNUARDURzDcOlnWGNOFJQMBsgUZiWHJpRL9gblByLJ95AOM84kXzvjXZUnk/qpPAs3NIWddBeGIgLPWez2S2+/e/7FS33BMIaiiORKoVIPKx6efE7iDeFvFEUwuKHSP0wSFpHnOJZlYtFIOBgMBfwEThAEIbsDye9NG2VFAxU9egpPOrEny568KUUm9b+TqF7ypZX9kIQp03JlsrUMx1kXXoyI/EVXX9/R2fPbhk+1Wh2CYzzPZ/BaAh34W0QQkecFQeA4jovH4QujMk4YpVIZzFZrVlaWM8/udNqycvIKi4J+39p7V3GxmJCKNkCGrqWUd9iW4UlnmqRMVBR3nlQYM/zzkzlEyRPKW0QMJyKh0OgpU+ctWVZ74M+a2vo71jxuNRm3fv1xLBqhVRpINYIgwM6HBlaIx+MQkDgQRUqlUmt1Gp1erdGaHY4sZ57DmefIzbNn5ZjtdlqtBjQNUBVsY9wHcPy8K6794NWXbBZjnOXS4XXKTqSM2t+Y+VSMnrgISbRUcXhyYjrRV5TbI1ufYaCnYjQMJ9gYY3FkXXvn/YDWNTa3vPjCK2MnTrji7sdGTRj/w8cfHD9yCAARJ0gUg/lOnCBMWdlme5bZZrdl59hznBZ7li07x2x34AYDAFSqHUCMRLzersamtrZ2lmHmzJ1Nqugl19/ocrXu37JRpVZjGCoAROD54R6jHKufXIJO6H/kJLR9auuWKTgphVLEZZB+UAQVBUFEAI7hsWhEpzcsf/CxgrHjQn2eb779bsXtK9999snr7oxMnHfe+JmnH9v35++/bKqrPIxg2NzzFk+YcbrBbDaYzITRBBAtABgALAAxEIuFe/va29qbm5vr6xuaGpvbPJ5IJMqybDAYGvL5X3r5uctvuhEPDN3/9Nqv8nK2rv8yEg7xPI8TVCqllzTew8U8U4IULlOqx5GMxmdoVsrEpqUsqVXQfkNA0vIm8qIQ5xiWwUmSwIlw0O8sLLrpgcdHzpoP4sE3Xn61tbXt8iuXZps0z91319jTfyodO2H2GacvX/NU2O/zD/Rl5eQRVic70B2JxsID7kGv1+PxuJtbauuO19fV9/b1EThutpj1BoNOb5gwZcqIkSMmjBsT9A89fteqDe+9PmZ0+egZZwgB/3V3/HPeokWH9/7RfLx2/6+7BEFIeAVJD2kYDw3jIIn+FNoEkogmbVGaMhO0n9yT5QUeijJrCKIocLx0wHMIimn1ektubk5eQV93V1era/5Fl55/7c2O7Jyq3Vvef+f9r77+5aVXn9ba7YuWXlV9tPrXjV8AlBg7dnRWQZ7e7mhr79r//Y8t9fXuts62js7urm6vd0BvMJRVlJWXl154yUV5+Xm5zhyr2aChSZ5lBr19/kCgZv/vF1y+7I57V7/y2KOvPHTPVasemLNwEUBBfnlF/qgxgI3dvPjc3o52DMdFIRULK5qtACjhfKUyBhnMgqRUJGFWoZ2GByiA7MkLPM/HOVEUUBTD4YZhOAaJ0+6wZWc7nHlWR5bZnm222wmCbHc19nd3j546rXjydABQwd+PIdjEqdP6vAOVu3654spLBwd9m7fvefBfzy66egUAsV+++OzDDz5p7+z2D/nMVuvI0aMWLjqntLQ4KyvLZDKiQAj7B/t7ujta3b/t/7Wzu6+r19vT1z/kD7AM5w+CfVV1r7//XnffwOZP3v336tt//O7MhRdfOmXyBL1OL4oiacvvq2vKt+kZgU9ytFJ6xJNwkJKbgcJOoyiGIkDgeS4e5zmei3MAEWlapdFqtTqdWqs1WW02RzZEJDfPnpNrtjm0Oh1OEAhNA5wCQAWYfnd1tS230DlyLA3EhoP7RAQ3WUzjZs8eN/ucK6+98j8P3v3z5x9R9sLS8tJFS6+PBnrffOa5vw5XzZw7b+rUifk5WSSBMZGwt6ertdm1bc8Od3NzT1//YCAaCIVjbFwQRIokVDSpIohcm4kmMJrAO6r++Oj5p2+859EzZp/+wycfNNTXP3T7yrFTZ7z36QcYjpeOHLVj8+Z8myHFLYl45aQcdLKEGUjFxNFwEEVQg8lksdks9iyTzWpz5NhzckxWm9WRZbE7VEYTIFJ2JMlpTHCwu6enu9vjaWuoO97d3ePt7vI0Nw54B/xhlkNAbq5z6vRpV11z1bR5Z9669oW3nniYOVJ94003AIx84ZFHft7224UXX2jB45XbN61v8Xg87T09vaEYKyAYgqAEjlEkrqaIPJuRIjAaRwgU2gRBiioE2GKB0mlaGo6/8vA9U/5x9n0vvBpnY+uef7rq4CFvV7ejtGzsmFFxEbC8oMwr/W00f4Lfg0haR9P0kmuuGz/tNIPBpIIio6eNRkBopdsFAOKAZwDL8tHwQP9ge3uHq9nV3NTsdrk72tpD4TAbi4Uj4ViM1Wi0o0eW/uPss/OLSvLycvUGXWBoaO+vO//9wD0XXXntNXfeO/u8i798+7VZC87aveGDz774mlJpt3/5ISLEAywiYgRJEFq93mZBaRzFUUBiAOIkIcJDqoOg8BCYRFoeASAaCi+55ob9f+xefd1V2uzilXfdMWvhhT//vK3L43aUVhTk55qsNoaNa2kizsOMazp7exIJUriTaSZGEIZl8otLLr95Ja7TAo4HBAn4OOPz+3ztAb+/qwtKh6vZ1VDf2NTY5O3rU6log16vNxl1en1hWdnIERUjRpTlO7PNZhNFYEwsFgr4Br3eTo+randTd0dHwO+n+dj3772qV1OLl10Z4zgu5H//nfc5ES3RE8UWfSjO50tAyAkz+R0FQeQlXHghmdeQ06xyzlkEKIpyXHzOwvMnzJpdPHqsWmf8Zt3bh3b+MnfO0+4e3/G6+olnnmu1WPILi7xNNXo1ifCJlNApzXw6463wBVAYNyIjx03ANWp2aAjDsE0/fvPrzt96+/pa3S2dnZ2hsJiVpS8rLSktLZ4ydXJOrjO/ID83J0uvUeGoGPQN9XV2dnV176k53NnR2dHR0dXZOTAwGOMEmH1HMQLDVCRm0NI2Df3zR28Ul5f+47xLt3/6RvWxeptBm2skWU6gpD4VRCAo0/OS3ZTdPOl8onMVmWsRw3GaVrW5GvNHjmZQGiFVod4OhGeLi4tqqo+BeMiYZS8qKW6qPOi0GQCQwpphjv8pVUzaUBTleV5vMJx7+TLAMDhND/R5n3/2BZfLc8mlF5xzzvzC4iK7zabTaVQkGY9FfP3ernZP88Hfd3raurr7evr6vQODAZ8/xogoDiiSkIYnSZvNoiExEkVxVCQwhJQFAyCxaHTLp+vKx0/5eccefyRWnmMiUCQOGQW6VTiCQsHhOV4KwSRfC0MxHEUwmA0Q+HRCRwQIhgk8j6Lo95994O3tOfvKG1987gWe5wN+fyTgO2PO7Kq/DsT6vXR20ciRFZugDGYEZX/rSadGJlBozZlo9IZ/3u0sK4+Hw4ROd+jgoebmjmuuXPLsy8/XVh5qb2nd8cevzQ0N7W3tg4FIMBKNxhie5xEE0CTEQk2RtjyHhsJVBErgCCo/m+cEgYeZHwSGo7wgf61I0VS7q+GvHT+1t3n0WpVZjQmCCAN6HBUEMRIMoDimNZhUGi2O4yIQmRgT8vtCgSGCpEmahpGtlBJCUTTOsij0bgSz1eZpbti47nUVRWpJxIgxHZ7WiVOnfPHRZ96BgbzsorLSYrXeEI9zGIpIcUcySkpKywk5aVl6MRSGhfH40puWL7ziaj4Ww3AiOjT0zlvvMCx/1sKF7uO1S8+7PIohGAatiYoiNCRhN6hVNp2awCkSI1AEAyIPmZMX+LjA8NEIz3MciuMmi1VnMgcG+4O+IVqlUjrwPMdv/ey9+FC/UU1J4ReKiGIsHNIaTJMWnFs2flJ2QZHJYqdUtCCI4WDA29PV0lB75M8/Wo4fIygawzERwE4dOXFqm7spEgoiCBoK+MP+o2YaaCmcFPjaqsNnXHBpIBRtcbXkjZlYVlZiMFsCIa9ZJ5vg4ZsMkGzlYMYAICDOMDzDmcyWK265ddHSq0VJqkmj/rVnn/9jz+F/nDF+ztwzPnjlBbXDVmbWqsQYQeAkhsLmwDwMF2egGDEIiuMYiuMUSVlyHNn5hfklpXnFpbZsp1qjIShSRNBfv1+/9cuPoSObHnYRh7xeIyFqjBSCYhzDoggyd/FlcxdfkldSjmj1gGMBx0G7hSDmHGfe2AmT5i+cf/Gyw7t3bv78I293pyiIJaPGXrf6wSdvv5EXAA7FFgqhXQtTRXwcq68+cskNy8tHFFVXVc1etDC7oCArO7vlaIfFoAYCl4g2ElSU6ShChWJiCIJkOXPGTp560dXX55VXcJEIQABptHz+9ttvvvGuQU/dt+ZRJhT8ZdPmK665pr92X9Oxah7FgixDEKRGp9UaYDBpcWTnFBTmlZYVFJeZrDYURWKRUDQSHezvP15T42pq6OnuGTdj9oU33SECdPMn72i0GlnTJP8c19EigmFsLGbPcV5y2+rxs/4BUFRkGd4/pEh9SzsMI4qiwWiad/lVY6fN/PCFp9x1NVfeeY8zvyDAgIEwl2vGGQ6OHmKQt0UMw/t7elAgjBk34fDBQ4BlUY2uYkRFQ+VBDACYVTqBiBOhBoIgXDxeUFR28dXXTZgx015QCHheiMVwlQoIwrsvvvj02mdYNv7Ci0/PmDfnkWuWMbjmuuU3ffDv9qwYN3bcWHtOjjUrx56dk5WbpzeaOZbp62zv7uw8vH9fa0tLW2tbe1tbd3fXwFAgLiAIBn3c77/bFPEPLbjw4u++/ZbmIhiGiSLESBRFFEPjTKyoYvQNa/5tLywWwiG5lgBFYVIskQEURSDADTKGIAihkC0v/7bHn+lqdZdNnhYP+P2oOhbvQxEUSIGWvGEYFotFO9yuitEj3922JRIOqzXasWNHb0RxDj7qlCoGMBwPBSOzz15w9lUrADPEh8MySx89VPnyC6/8tGl7Xr597TNPnrvkwo+fenzjT9tX/2utOct5/V33ARTT0pRvaKirraWm8tCm9etdrpbOrm5fMBwMBMLhiCAiJEVoKFKnocoLHBqojwhJoJggHN3+/cXLrjTkV3RW7i7JsTBxAYH2B42zTE5h8Yp/PW/MzeMCPgSGdmoICsvyHMfEYizL0jRN0TRKUQBFhEgU4sswGq22bPJUIRLBcUKjM/gEPp2NkokORbk4e6yqctzYKXEBuBsax9izxo0fAzA8zHBqEkvy9AkAwX5DQSwadVX+4W7xnHXeQoCgrU3NN11388DA0Mrbb7j9ztv0Rv1/7rvrzXe+OG/pZTfccWvlth/XffBZd3dfZLCn3xeIMnFRBEyUycvPcTiyfC6XRa8qNJl1GkpLk5L1hQGh3PdQWBAQCwUBGy2rqDi4/aeSHBtULxSKg0qjueruh425eazPRxr0QATtLlflX4cO7jtQ39Do9Q7EGEatUuXkOqdOnTp/wfyxUyYBlkUQFApaJAKfgiA2m7WlJmPMPuUruRvqF1xyhcliqamqHHPGnPz8PEdWVtTXo6NxnhueMUtykCAQFNHT2R4M+Lf8su2sJYvFcESn0xqMxuK8rH+99Oye79a/9tyzR+pbr7j5xjXPPNV1rPrJhx45WNdqNahpHNXRRJZBhfFxNa1f/fTTYyZN2bXx64HenlAg0N/V0dHiFgSOolSCmBBjBDoxSJxhm+uqy8vLBIziBQGTEIpFQwuXXV80cRofCpIWS1PVkW+++Gr71m1ut4cgMJ2K1FKEHkewaMTb0P911f4fvvx04UUXr7p3NUWR0M5gGNQ7HM/KcsRhtkUxRIRApaQoureznSJxs9V64MCBK0SBJIiKUaMO/dqGoZpELHZiqCGIIkVR7vp6tVqtoohwX79aozKbzcUlxXUHfme9fRu//4l2FKx74pnZZ5/ZeOjAk/feW9XckZ9lKbWQpGQpMAydOu+COecuLh07AaDYucvvAkw0HouGg8EeT8vPX3xw/NABWq0ReS6ZbMJ4jmuorjpt0cVakznKsFoVyURjzpLyWectgS4hL37wwsufffRxa2u7Qa8ZmW+1a0k1ieIIgqPJpCVu7fMOaFEOI0lBFOVRNshXGOZw2Nl4XEgOnqWGp0mC6O/t6Wr3VFSUV1ceEiNB3OicM+eMXzdvgq404IGYMTaXVDEg4jjR29UZC4f0Ok1zc/P4SRMBTZeUlezc9FMw4C8YMYatPTb7nAsObv3uwX+ucvf6LXpNoRHHUcALsLLm6lUPzL7oMhgssjHACwLDAATBccJotRtznCVjxn/47BMHt2/W6vQ8H0/l3jrdrvyCAovVPjjkMWgoBAUTZs3V55Z7Xccef2TN1i3bSIquyLPlmUgtAZO3AoBBaVzyfVEUiwwNnr14ybUProENkMLUxIaidruNiUMSgvYrnZwXUQwPDg62uVznX7j4j927/9q1MyJiO3fsYmHwg9NqPBaJnmxcTIrBOI4b8PbaHfamJjegKCCCiopygKPHq4+Wlhb98tPmlsN7vvp6Y7W7P89uGGGjaQIDKLQ4M+cvmH3R5WI4LMSiUuYZps4wDIPvxXN8OERQ1BWrHnCOHB+EphqeB0AgKWqwt4uNRnILC31hBgGAoFQzF13Y665ZdcstW7ZsNxn045y6MQ5aT8I4g4fkBXFFAcAxlI1FJ58x77I7HxAEwHNwoAL65VIgIgBgd9gRHIeaK8uVHFpKFEySZEP1kYEuT19f3xfvv7v9p59GjR75xrtvP/z8K5NnzOI4Vh6Vy+QgaXgFxbA2V7OtoLzV0wZQCsSC+fl5lFpz5HDleUuvdDidv23Z3N/RajZShUYCg3kGEZc0fOZZi6RUPIKimcVQkt+CYbjI8zqd7rZ/Pb/p/Tfq9u7kBRSIIkEQwaGBDlfD+Anjqn7fyXPx4rGTKQJ//p8rqo7WOszGUTbSpCHjUgpDzm0mchnQGMVLx4y79t5HVVotYBmA4wBFAYZBSy4KAKPtNqtao43HBTUcWYX3YRjGQ68+TlDUvp3bRvr97374/riJ463Z2YDUAiD0tzQeOHA4zCF4kiuHpzswDHM31FdMnnH0SJXIhhGeKy4sMBqNx47V3laQpzMYt/z4Ay8Idj0NAOBEgCMIz3NWR44txymXcp1ygwZG2LV95+bfD6ljcTMNXW8Uw0NDvu7WltOmT/vgdYxh41l5hd+99WJldZ1er5uQrVKTGMfLKTxlJSE8RFHUP9D/+kN3+RhxgKf0BoPNbnM4HI4se05OtiXLwfGc2WqNsYNGNSGhg0fDYVqjUZEancm0dOWdU8+YC1RqEIsKDMMGg5TR8Pprb++ubCzINpqJdEZIGayKGIa1ezwmg45jmP6ubpvdZszOKigsaG318Fw8x+k89ueuUicMxoHEiAiKcixrstlUag2MAE5djymIIqZSUzR1pLK6vMCmJhANhkpkinW6GsfPWYASVIQHdXt3eb39Ak6PNpF6Gmd5UR6mh7olAQO1R0oYIgji6+/r7+lu9zGBWFwQBJYTYnGOifMkrTKaLWartX9gkFDBwQMURaOhUGF5xTmXXRUK+CbNmpMzahI72N3tdtvtdopWkRQd6Ovfs2cvReE2DYFw0GU5UcUAhmOhYADwHIKTXV3dtpxsgOPlI0Zsrj7S5WkdObKi8o/fVCSKITBkS9wliARFoUkx/rsNQfQGA01jxVYVjULIZBrqaGkSeDavsCjQ1cSGgwDDC02IkcZYiVYE6UcKeuEPTpAIBvsXQUQUg+mkUgcF7bcI/+PkLJoghGOxUF+LjQJqkgIAiUZCc85dfOVd99EkEYsy+pyC5sN7m5pdU6ZNo9VqnuNwvXH/L1tb3B6rQa0m0FA8VdiWmTBDUTQWifb39hjN5gFvHyBJEGfHjR/3ybvrPG735CkTP3kPgTKfQkdKSvn6vWwspjGaACTHU4GDAIY5fOBgjBOZuKCi5ZSWSBJkj6eFDYcmTZm87etaFMdpTjCadQQNo3xYjIChMHGE40AEKp3e1+/t7WjDcQJ6OFIv85JdQ0SY70KhSKK8wGsNWqtegGkVIEZCoYuvv+XS5XcABImzrD7Hun3DN63ulkuWLTXZrCLLQsHkub379vsDkWK79e/yQQiCsizT0tSQl5vf0dIqx816g66gMK+xofHcS68AKB5h4moKSzCBIOAE0e1pddfXTnbmCgwzrMAntaEoKsS5uto6DUUSMBUolxTCoDQYGAoODYyfNOnb99/hRZSNRmedf8n08y8XYiGSUuEEgRMkTsJQOOYffPOhf8pDkspiXtlISRUhSCgYmH7WwrA/UFd1ECfocDB40XU3X7pylcDA2QWEVvveiy/7Boduu2eVWq2GvggAKEX3eTy7dv1m0FNaAoOZAuWbK5sBXSxR9Lhcec7s9s5OIcbEQmFPq+fKa686crhSr9MaTJYwG8egU5+6RUAxfNMn78d8PgyHebwT0ZEqBaAP0dPTq1cTJI5K6b/EIAqG4Z7jNbn5eTxGxeI8InIoimSVVuQUlVlzC4yObK3RROsMXJx7ZPU93+3Y7wlw8nBoul8lr4KPx6OR8NwLLlm6clU0HIiwsALmqjtWX7ZyFc9CLwfTap9b82RnR9eqh+9X0ZTAstDmIghC0zt37Ko/7rLoYJp42NjY8BJlkiR7e7r1eu3goE8Uhbra2u7unrMXLejp7evp6RkxqiIQYeEIWfL9REEkKdJ1/NiGdW+IsMoAU0ycyBBOb5+3t7dPReIwpFCAh+N4c80Ri8ngLCgIRmI0Tfv6eoXAIHRtuLjAcTzHxTnuobtWr/9hO4trLWoCx6RBfim4RzHokYf9fr3JfMVtq2/810uu6iMHDtX0RpCrblt13g0rRA4Ciht0Tz+0xuv1Pv7Mk7BSiONRggAoGgyGXEeP/ufl186cP2fCiOI4wygql09QMVEUCJLydncLPA+VReC3b9vhzMkuGH362Gmzao4cmTljWtUfu9P1GdImiAJJ0b/+uCGvpEJtc06aNB7BYCyQeqwgCJhadbSqKhKN5uu1GABcKrEuQIe4zdVkNhoqRo5s3r/TkqWPBANxlqVU6sScAhyPM4wzP6+40GkRA3qMYBgop3BUF3qFvC0nd/zMuXMXX5pdPiLu93711TdVLt8N115w9nW38MGgKAiE0fLq2rXuZtcbH77LsSyArcMHvf3NjU2BYPDNN95pb+t48eXn/9r+o7uhzqqBNTenAgjaXd/AQG9XZ0lxwZcffdTncV9x9VWhvpblt6/8+M3XB7x9HILzohR2J3VVFEQMQxkmtvXrj9t9zC2r7zv9rDOFSAzWrMhEg6JcJLrh2w0ix2lI6FqKQmpGAfQtwv6hsH+gZMTIvb/8WJFjDvp9TDRCaXQCF5c9T1qtvuuRhy67/JKWmkp3Xc2Qt5fj4iq11pLjLB4xpmjkGGtBMYgzQOS//2b9D1t/LyyyTT9tsiiIcZalrdlfr3v3t12/ffrNF5RGA1AMtp/j1Iwqv6Li6L79TbU1c2ZOmTF//vHKA0MMsGXa4xOT9kg8znh7u0ePGbPipuUfffhOfkXZun+vHTFp+h2PPPrcA/foVWRXd4/VpMeJxIQhOIIpQIPd39PFBoKfv/36tNOm4iQteyuS+KjfeeGlX3futpm0ehrlhEQKIiHLKMqzbFP10dKyEo6geBFEg36WiYkYinBQ+iBGPM+zrLOk1FlSdvq5F0nekNRLGAbH6QSBDfhJo7G+6sijDz++dNnSPJMqO78QYRnaYv5z2y/vvf3uR199rjHoPbW1nrYOt6ulvb3D6+3r6x90HT+OAuSf967GCDKvbAQDMA7S6MlCjUSZjMir1JrGmpqWJtcNK26ZsvAiPuD9esNm1c+7/v3KSw88/dzCJQdaaqsP/76zp70dxTFpvFaqK5WqwPRaLRYaaHc1lkyYIkSjiExJCN7f38/EuGKbTkNhPIxJEkkaOdbmea659ujcy67XGc3hGItj4VgkgmB4lPGrNFpoy+NQlKAlknCRxQoGX/G4yLKwDMFsbjpWu+KG5Y4s+90PP/zH+o+t2U5Aqtrq65945LGnnnsqKzt796Yf/9x/qLHJzQs8x8ZDoWBbi5tjYvPOml9QkAf4WMXo0RhORpg4+jcSJPAChuN/7dm95Nobrrh9VZ/7+BMPraltaHboVU+uuPbi5asuvWmlzx8c8AVFgMIcqWJ6D3SXESQeiwz1eQFOiACGxRIWwnmLF/+1Z4+ZCMUiLBQKDA4kYxgBR0YlJ7mz1ZWVDcf4B3pdFCpwLDvY07v86msWXnD+tctvwTQawDB8PC5TGp+cKYdjGKyz44WdmzY/+chjHk/7h59+YMnOo012vdkqMrH7V99/5dXLTpt3FuPtGTVx4tip0w1GHYagAoa5a2seW3nzyAlzeZbZtWnjVfc+lA3r+HJDva1GGj9pqCHVNYpCflHJrQ8+PHLmIsAOtDa5MEqV58xWRQfOXbLkwquu/O69/zxw/6MCghdZNTl6Qi5BTo4CQL+GicV4KekjywgMHmORiVMmfbz+2/pDez3Ha3s7PEHfQGhowDfgVak0KI7hJOXr6w37BguKS4601ju0OBMJbfzg7X37Kjtbml1HDi264uqxE8brHXZYVSZyUvIBvjnnH2qqrPzy0y83rN/g84VvXXnj3LPnC+H+ktHjzDnZa+99IC/Xee1tt3L+QUqjtel0kDDjfFwUBZZ9+sln2nyxtf+8590nH22oq5P8IWrkqJF7PI1GOg3LCRPqAKBU6qp9e+trj4+aNGXagnOnLVhycMv6t9Y+ctZFl4V7Oz9ftw4lqGw95dATyrSAVNwshvz+8TNmjTpthhAOwwR74rGwItVktcw4b8mMiy4DDBMc8PZ1tNXs+33vz98zsRiOk/6hwXZ308RJ4/ds2UTSqh1ff1xZddRs1o3K0fsb/3pu9T576diyMePKysuMRgOGouFwuM3jOXqkeu+fe31DPr1eN31cyc23XA8wVIhxpRPH//z5l/W1tW9//TUc1MMwaEo4yfPmOMKgf/O5F7fs/N2s14aGBuzF5Tt2/sYOekmDccyYUT9v+EYwqk8Sasg1/QBBGmuO/vXnnqyyscjGn53OnLvvXz3tnAt4UcBIYveOHY6ysVFONIkhXDZkySF8lmFwHJ9zwZLLV96lM1mgC68se5UwEuNxSe2AzmDS2bJKpp1ePGrcJ88/DgQhGgp1t7ZMnjpNAGiMF101VUAApVbaQKICUJU5EG/bsV8q968XcR4jRAHEWDYciqAYYjXqxhQ6yHhw3sxJFkcWH4UjMR2Nza+/8c5Lr76k1Wn5UBCRasnhuBjPE3rt0T/3vfnG27CYIjTY0Xh8wszZ32zY1NniLpo8c9SoEShJM3FBCpKHSVAy60ar1QiGnjnv9PHTZz6++u4H72xfefeqGQsXh3vaG44fX3bNFV++1tndMogT6sS0RhSNhiPlY8dddOOt46bPgqEjwwxPDMlFnEmZgpFnJMRx3LgzF445XPXnd5/QKrrd1TD5rPMotT4QZuwmjQbhtBTKC7A2gReA1aizmg1xjouwPBPnOVGFoyYCR0gE4ASu1Tu0JgtGUnGWBSj6xMNrli67fMSUKbzfh0kl5FB2eB7BsHD/0JpHH0cwzESh19502z8WX1Jz+K++Xu/hQ4eLJs/Oz8/Lzs2PeNvQ5PhzZqgh/eZ5GEYfrzqkVmsWXHjxnXfd8d6zTzcc+IPW6Q5WHSvIy8W1pj5/RBoaToRvCy5dev+r7447Y67Ic9BJzURHniMLK/WkDVoiHMcomlJrAEosuHQZq8vmBTEwNIhjqMlq8UU5RJpAAR2I5JsxHMewrChAYIxqwqLG9RSigs5s3GzPuuD6FZRKhQCENJo/eeNttUp9zcoVnN+HoKicbISjxhSF0tTTTz5ddaSaj4Rvuvm6G9c8ufnLT9esvtuW7bRl54hs0GqzFpeW+AIxqd7mZFYs5bz19fRSFNnj7c8pqVj92BMfvf6fe9Y+3d7lbfO055eU7N61Sx6liUUiZ16w5Jr7HxMYRohEZN5JTBtOzh2GZpkgEAImrgDPA44T4vG+Pm9bm6e50dXc2Hjc02vjBi4YO4EkyZh/UITujwgHydIFuolfcqWL7GBDBUfRWIyZueD80tHjent6AEm6a2u2btn20msvA56Ho54kBUQexJigz9fd3bPp+03r139HEfjcWZOuunnFV68898Sjz4w67bR1b/7HWZAfDwdV1uJRo0b8sv6XFL0O94PkKUcYikXC4eBgv9nmqKuunrf42vFHj+7ZukVDE40NjVOnTvvovQ8EgLBMNLugaMktK0UuLsJSVlguk6hpxHFAEgCjICSBwEBvr9/n93jaGusbamtrG+rqW1zuaDSuUWN6vd5itS06/4pzrl3x8wdvDgwOmQ0aQap6SUMj5/il7LII6yFgjAFbIIganX7MtBnmrOyS0RP4SPjDN96++pqrcsoqQt0d3oGBtta2I1VHKg9X9XT1dPb0+f0+nVpFc7FF5y7q7+174+XXzIXF/3nzVWdZCRcMIRi+7bvPdu/aLZJInEu4i8MlKBFiQdGItjQ15Ofldnd0iPzguRdftn/3LpMK7e7qvOCCc0QUj7AcCsDEWbPNuflcwI9TNMwK4zjAcBBnB7q6Wlvb2j0eV5Or2eVqdbs9rZ6e3giOgMICU0lJ8ZTLl5SWVxSXFJWWljjz8kSR3/HZe5+s+yAqoFYVAfP6sqxI5SFSeR1MAUC/HMfVOr1Ko0UQdMjbZ3Fka/R6HCfGzZy54/sftDrtuUsv4/wDbW3tf/11qLurm+eFOWfNpzH0vVdeGlc8QquinNm20+adtevH7z3e8Np7b8wtr2AH+xECW/vY2rfefJ+iCLUKF+SqHGV1R3ouvYwUzzfVN5y5+JId23cKkYDOoD193vz333q7z+OCOU2LNRAO5Jg1p/1jPgAITpBMNOpp9dQdq6uprqk9Vtvm8fh9vnAozDDAYKRHjx555bLLxk0YX1JRYTYZDVqtSqPyD/S7G47v/mljY0OTu8XjavH4GT5XT+pQ1jcUgXpJ0QRF0RrKYLPbc/LNdrtGp0fgkGzI29PV3d4GgxbZWcdwb1f37t17Vt17twhLMLCCwsLS8jLSZAbAxA40PHb7rTMmj7n/6ecRIBK0KhwM7ty23eawzpt3hhAOkEbDZ++se/219y0WnUNHUGJcHmE7FQdBsAiS7G5vt1hM/QND0UhMo8FUarXWlt1YfywWDo0eM7rmz18LskwdLld15eFtv+2tqa71tHYAEei1pNFkyslznnXWmZOnTBw/aWKO04kIfCToD4dCrW73wV1b62uPNze7ur2DgTCctITwAEOBWo2NcJjK8rMNVrveYsnKLTQ7sowmM0EQcSbmG+jvavccqavram8Lh8MxJs5DJ5xThSNwtg9Ob/1p84JFCy25eUI4hKlVGr0ZAC7o9R7av+mZfz3tamm97fYVWzau/2PPn0dqalFBiCHEaTOmZzudKAD+np5vv9lA0WiOnrJpsGCYP0khuTKPBoNPkurp6mBjMUpFD3i9WoMOIMioseN++3lbLBycOm3K/l3bwqHwKw/f3RvkWY159KgRixYtGDFqZHlZScXIEbTJyPR721zNzUerfl7/tavJBUPEjg5/IBoXAY4CLYVpaDxHR+aPGlFSWlZYXJTlzDZaHSStQRAQDvq62zydbtfelh1ut7ursyvKsCLARASWMtAkTuEYTWAEgnU117OxaI+rUa3RTD9jFhcMYhjaVHOspvqYq9l15MjRA/sO+P0xq4H4bcMXhYX5uCn33MuWVYyoKCstLi4uwnACaNRt1cfqao9b9RqTCjoWSV3K5CBZ5VNpHgzHhrze7o72gtycutragrJSgGHjxo4OR8XWpuZxE8b7gtyYabNOmzM3q6BYZzRZTAaSwDs8rcerq3f9tLG+vrmjs6evfyDg87NxgGBARSI2o76w3GrSq3Nyc0vKK/KKiqw2G6VWMzFmsL+/q72t8sCB/v7+js6e3p6+nKLig/uOqDS4wWBUq7R2PUphCIEiOExoCiiGsLHYjLPPcxaXRYIBFUqcv3gxTtMiHLlEKIrasXX7Dxt/okjUYtKvXH79zFnTc/PytCaL0eEAhFmaCBMDjD845CME3u/3+wLhnDwLCnk/Q58yrFh6lQ95aQdR6GzzlJaWVlbXLrzkYsDFi0uKLFm6yr8OXnTtjTqTNr9idPGoMXVHqprq6o4dq3W5WvqGAlE2LvI8LF+lSDWFVeTbcxxWu81qy7Jn5eY7cnJ1er0g8AHfkMfl/m3rls62dl8w7A+Gg+EIywm0WiUwsWU33zxhwvglF/fs3bKp2+PmuSDBY4BHWGncU6XViiLGcHzdkaozL16WU1IR8PZs2by5qa62Z2DI7w92dnZ1tLXlGInyfMf1d94zf9l1AJAAEABEI31drZ6jvT297W3tXZ1dHR1dy1cu7/MO8DxQkZKPkkk4J3CQZOalSFOgVWp3Q/2kWbN7t/0KP2E5q8VSWFJ26OBfK1bfO2rMmLdeePbrt/9zrDsoIjiBI1qaNGtVGkqrITEVgeq1GrPNZoZl+Q5arebirG9goK76aGuLp6e3l+VElodDNJgEpUpFWYwaGhUBG114+a3zllz+1hMPTph/3j0vvdVYU9nZ3OwfGuS5OKVSme1ZecWlGqvt61efrzm4v6m6smDCaQYM/Lp9+/pvf1CrSETgUUQ0moxzFyy+4dYVJRMm9zUdP1Z7vNnV2t3d7fcHUBS12my5uc7TZs5YZDayYf9n77yp15IwGIJ1EanVDDJJOrWMjLSMBeB5OODlqq+DYy8iN9TZaTSbdSZjSVnJnp++B6J41jkLtkV8BpwvEzGKwLRqChMTA+FSBkPkBDEQCIbC0eaGhsHBIe+gLy4AHtZlChgiqEjSplfpdRoSRwHHcizDCaxObz736rvmX33TS7ddN3vx5e2tLc8/+vCyO1afOWm6Rq0mCBKhKUAY2aGOI4f/auvpHztr3rxlNx/bvWXnHwdGTpg8+khlto4sLCszmMyObKcjJ+fAzi3ff/z+YAxojOa8/Lw5c84wm40oAoJDQ+3u5gPbNrlb2ptdzb0DAZ0KlqkkRgNOXmmfdhWlmYIwnY719XSzkZDdaqmpPT573lxA0WPGjNr+w8aDf+y5/Oorrrv+ahxDdv+y+eevPmttblRpNHFYAyxNnUMRaVJtiIlzUZaLs3FU5O06tcVqMdsdjqzswvIKe04uRasr/9y9d8dWu7NgzNQZ8y9ZqjKaPn7qkZ5+38yzFxFa9Yv33n3bknOnnbN4+coVZSMr2Ehk++YNm3/c9NfhKjYWu++5VxDAffjuuve/2GpUAwIFurIsioQzFhAUicaYohFjJ50+D0FBNOBvbWndv2trY11dV1fPoD/kC4QZTiAJTKdRGTQqE40SGMKny/VOBChdSQ3rv1Jz+Xs72nPz85uammcvXAS4WGFhQVxEP3j5ee3nn/May8xZMy+6/JJpZy9867GHDv62XaXR8vF4svoX1v2qdfri0tKC0nJnYZGzsMSWlY2TVMjva22qrz58KBCKOPPybl3zVPm4iTpnbr+7+avXX/nqq28N2UVdre7cESOr3V033nbbdffcB0hduK9z985fAYJev3x5672rr71zZem4mXs2fvLz9t0XLp43Z9o4e25ebkGBUa8TRODz+XrbPUcO7q89VtfY0NDb0xeHC+DA8RAaToEh87PNKgKlpOE0GBJLsxrkAEbpEGaoWHp1A+m3KMDh3cbaY6Nnzj2wdx+8JMqMGz/2lttujfW2NdXVVO7649efftjw+Rf3PrFm1b9femzFDbUH95qsFp3BVFheUTpqTH5JmdXuUGu1kXC409N67Ehlc11dV3evPxSuGDP23AvOd+QVZOU4VXo9z7IgFLLa7Ffdtmrhtbds/vSjr954aeTpZ1EUfcXKVYKIbHjvrfXffGc0G/MKCo/8+evYipLLb7qZGep8b91H02bNeuHFZ3x9XW1u1/7tW1zuFo+n09PR6e0PIiigVJRKRRtNRhWBURiKYyIh8QAvTfiQejKlUpIRz6y2P9mcVTnggKPdIopiDXW1s8+7KBoKRWECUOXIctz7wD0AQaLB4B87tvzw8fvu5oZn7rrtqTffveuZl1tqKovLyjEcj4ZD/b29DXW16z/9tO5YdSgURkkaIWijzTHptNlnzpujVtNtrqYj337V1dXpHQoyCKEzGEeMHDl95vSJ06ctX/Nc5dZv33nhmVsf/hep0b3+5JrK6uPT/zF36uSJ7trqfZHIDfc+KOD0gT1bf/t974iKsoduWObu8nYNhuNS9lqtojVqqrzIoSIQEoNJT3kkF86ClIbwMxctU/DL8F1lqKGARqJpGA1hGNbb3a1VUTwAzc3usZMmsKEwFFMMU2m1Zy29etTkaW89+cixv/Z/9Pzac665pbG5ZevmX5rq6+pqj7PxuDO/KLeoaPycBeWjRpWWFpWVlRls1mBvd7vbHfD26PWGyfMWzFBrg76BlsZGT6vn6KGDW3/8werIuv7WFbMWXHgjL8C5FJ+ua+/sXnXf6khfe29zzd7tWy5ZennFhMmACX/66ZciiiGh/iCPCgDNtRm0JE6TCIEgsNpBCgkgKrKwJFsnt1M5bJDGJbXYyckkKOFBpjASJYBikUh/T3d+QUGcZQChJ004YONcNIoBwAcCzuLS2594Zs2tN7U21r/56H0N/ZGSsoppp00+78rri0tL7Tar3WYhzRZpzrY0GYcJ8ADNKSobGBpqrqvtrK4eGuiP80KWM/eSSy8eMX7cwMDQ1o0bXl3zQNOx6utWrR5qc33yzjvtAa6h6mB3V3d/UDAYNXetfQ4A7suPPvnttz0mrcqsIQkcySNgP8OJY6LIQnDSwiCzBzLM10vkT1Ink8sEpq8aFs0nn6VYDEkECKzlqjx4cPmDjx/4/dd/r15ZMmbC7LlnZBUViKEwRuBcJJxVUHjDPQ93uurHTZycXVCo0ujgchlqWvLNpCHWyGBHe31XV5enxdNU39jW0cEzjE6nsWbllI0onzBrtkGj4mLRrvbWX378saa2we8b4kKhr157wWzQBFlQ1dRh1dJqlRqWR1nZM+b+o3xk+RtrHn71rQ95EbNpcGh9YEV0em27hMnJTCcp6gnScCgYOKlDp/Kk01fI6CXtmSiIjbU1kUhMss7Zn3/0yUv/fvaam25csfJmeUYQFw5Pn3MGOGt+cqkO+KSIt7+xvvF4fX2LNEoXizEajSrb6cwvKZk7/0ybzUICfqCns721dft3B4/X1ra2tASCEQ7BBICQGKZR01aNZsun67wxOKssy6DSUAQNAMcg51x82ef/ef6jd94TMFWRgXRoiZS4pHUjtbhkEpnMBQLTcCgFKC0WJwUodXWSf2QJ5AmKam1ueuCaJVRW8elnzvvwk3U1VZVPPfxgV0vTw2vXqiwmCGYoFPL5B7wDdbW1x2pq29vbg8EQQVJOp7O0tGj2nNNtFguBo76BPk9z45+bvnG3tLk97d09feEIT9EYSdMamnLYLCoS2l0Sl9JBIggFg6QgFFlUahJwohCLMuVjx+3bteWXjRsZQlOsw7N0VJJxFXySXDsy1fhUxYa8dt4JZ5K3yBgpCs9PHNVI6aI03gckUUJAnOPdzU19h2t+2LAhJy//sbX/+nTj9y8+9uhgX/egy/X7r7vbPG0D/QMYhhstlpKS4snTpuY7sxCRjwYDLS73vm2bG47VdnX39PtDgXA0zgtwKpmKdlhNWgpXE3BmXXqdM2g9BU6eXQjn0WHZeliTwvMCTuC9XZ2epoYQh9o0SLaOglUtmVqRudzmyTTrb3UtGWidFCAFBylXURMleSJIuiBLVSiCcNR3383X//PhR59d93Ek6P/5x585Tpg7b152lkNL4+HAUG97+/H9e9bX1jU3wmkDrIgICFzKR00SGhVlM2g0JEbhgEDgLFHpn1Tuc7JNNkAKlUdCfr+IoGoS1ZJYPJn0S/NDhtqkhUqpWcNZWqk7mcI1HKC0pZcqAJOrWQJ5eSZB4FkpC6yiyeIcy5dvvFiY7xw7dfr4KZO72z0tR/Zta2h0tbS1dXT7/AxGAkrSGqPZpKZQCkUhIpLPKvmpoiCAmGRPh1d9pudpDd9kcwOFCohaEk7LUL6wssnKBUuHaVZa+xQIKlcrTdioU5n59KTNFBWBpO8g7SIAgdMpRYQiqVfWPNgXA23ekBiPodJcGI1apVOrHGa9hsRgibmkNVLIknDP5G9JLuCUAYUifh7eYRlnpClTw7pTgU7iSGG/hmvWqdCRl/BSGqvhAKUXxVXUf4EUGSVUT5pmLOEsiKKR4AUDgWO0msTVJApdeOlDSO4CkFd7UNaSpIgGVoLIZ5Kjr6nxLwVa6RuVOb4T3bnEaqUK8NLmONOKKcRAIV+Jb8jg+JMBpFTZ1KIxiIK2EueT+SIACAxzGvFUGjsOl73JWK8h0RDFWnjK1UQVXZ6pa8kXHE5Nsl83rBnJRyR0EJxarU6UHQVPp786UZV9AkCKVavT7UEyDX/COUpKliACVppglZjkpLhM9tWSHZ5axUhBMkmkkhNmT7Ep2pyJngLdTMYZ1tnDTirRySCt5PlTpjtSdyLDGQjIte3y0rvJtRjl+jFwInAJrkrem2I0eb4snEKZ7I9Ut5+yQF+pc8ql/JKenizfw0g6DYtC4k6ELM1NyXuV8nEygJR8rliKESQkKm3X0oZXnq6WXhxUXpE4uUC3PLkwvVhCgilSL5SimpOpmUIrTrDiyg4f5tQMY+4UJsNMfgoqhVFTsNMprFgGaSkWBgZpXVPE/cnuTKRoU49IulHyCEnaaKYH2jNxPvH/p9rEU1yuhGa4CVOClIHdcM1K7WRa+QwVS+u0MuMhJjlZuYplOuaVVUqhWbIrIed2JcuSWLFQmuueBhheMMxaDQMok5vSRbWpw7SEDhcchbhlsnCmRVdoVkLKFLCeAJCS6JKVFWLa3qQNmZx2U5g2JULyKhOK5VKVi9pL7ZHgTUYVJ0XmVGeVa9FLvkLifGpnmHAooUlHUUpfWaFZmVp8Mit2AjWkVCntXippWxaYYRGJ9B0J1yljlldaWFL6kDh16jlUyXdQ2K1huCnJQgGHUo2UTRumiidhokzdUwCUXAI0sbDHyZZGRFImObXQR6LJKQnLWB112B3pa9L7/4Ut0w9IHikX+E1zXNJDk9aczlD5hPOWqBlMYCEvApzxUkn/JbXObAqgaIyNRBjFuruKNZZACoe0dqQ+VSKUWnY+cSLZiAxcUp0zDKmTAqagW+Wewt6npSLjz48kUVC4k6mLU/KS/ihl4yXgkEgUrl6QBkgEoKTYiQDwv3+6Rvmna2T8cJoih7z94wttEwqt8ufgv72Jpzh/6tj8/+ftb77of9gcQfrjRzRFIv/757PAKTb5z2f9f+rOuA7wOqf8AAAAAElFTkSuQmCC'; // 10/28 使用者:改名卡圖示(棕底)
const isRenameCard = (it) => it?.itemId === 99227 || (typeof it?.name === 'string' && baseName(it) === '改名卡');
let renameImage = null;
function drawRenameIcon(g, x, y, size) {
  if (!renameImage) { renameImage = new Image(); renameImage.src = RENAME_ICON; }
  if (!renameImage.complete || !renameImage.naturalWidth) return false;
  g.drawImage(renameImage, x, y, size, size);
  return true;
}
const isTishaGuard = (it) => it?.gfx === 65044 || it?.itemId === 99244 || (typeof it?.name === 'string' && baseName(it) === TISHA_GUARD_NAME);
let tishaItemImage, tishaBuffImage, nodeathBuffImage = null;
function drawTishaGuardIcon(g, x, y, size) {
  if (!tishaItemImage) { tishaItemImage = new Image(); tishaItemImage.src = TISHA_ITEM_ICON; }
  if (!tishaItemImage.complete || !tishaItemImage.naturalWidth) return false;
  g.drawImage(tishaItemImage, x, y, size, size);
  return true;
}

const BATTLE_SCROLL_NAME = '戰鬥強化卷軸';
const BATTLE_SCROLL_DESCRIPTION = '使用後 30 分鐘內 近距離傷害 +1、遠距離傷害 +1、SP +1、命中 +1、AC -1。魔法相消術與重新登入不會消失,死亡時消失。';
const BATTLE_SCROLL_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAYAAADhu0ooAAAdnElEQVR4AeV7d1BWebatYytttwkDQUDJOYPknHPOUTIoOSNBQYIKiBJEAQEFiaJgQgQFs2JuadvQwZ7pmelw760786ZeNffVe7Pe+r5uX3U500/toer98ajadb5zvvOdc9bZ+7f32uv3Y1FFRcWi32qLFi1aTBN5m/3W6y/k734zSMFD8E9z/drVdbIyEkc01OTaNDXk21QUZdoU5Ta0yWwQbxNbv/oIz8mjKdJWLeSDv++13gsoH3YJTZy2kSZD87Qx1fk6OcIdu0viUVeeguLMEGQl+iI60AnOtvqQkFwxJ/LBol6em06Tp0n/ExNcT/J9H/59zn9foB+tWrWiUkFp46S9he7FxBCH0ert8X9uq8/F0aYC9B4sQk9rIbobC3F4Tx72lKQgPyMM22I8ER3idC/Ay/aMq4PJhJ2l1oSlkeqEkZb8hKqc2IT42iWTy5YtriZYfZrM+wB413PfCShvLhiLAm+Yy2ySPuHrY419O+NwdagSN8dbMDvdhTN9NTjdV43bl47g/uWjeHJ5AI+mB/Hw6ghuXezE1bPNGOioQHtDPhrKt6CmMAQliV6I9NSHocZHUJD84JXokkVXeI8S2maawW8wwe+0aCvffAHvCnSpiMjiYqk1ix542qi9aNyVhL7mPFw8XoUrpxtxa6INl8cacfnUftw4dxC3xw/jAcE9nDpKsMdx60I7Zk4342RnBfoPbsfRhlx01mahlaHeWBaDvUXBqMoJQFmqD4q3BX1ZtDX0YW5S8FxWQsBcyhb3uaQo97m4MFqw/Vysv+XcFn+7uWh/+7lQT8u5IDezOT8ngzlHM9U5ZakVT8VFPxwlUKXfCvSDjz9c1KS1cRHSQgxxqa9SCHJmuP4nYBePYHaqE7OT3J49iLvnW/FwsoNe7cbz630E2y38fvpEPS4cq8RoRyVOte3CQFMxznZX4fbpJlzji5rmS7t2kp9HfrKZE/txtp/n9uzC4JFdGDq8HUPNWRg6WIjhg8U4WpuJ9qpkNJYEozjRAe5G0lCSWvkNgWbSzGnLXwN+V4/qia1d3hjjrYG6Ih+c7inF5EANbo4102udmLt2HM/ujuD57Ek8vnQcT6b78PLmEF7OjuDzh2P4/O5JfDF7AgOHd6CNnnx86SieXjmOTy4dw9Nr/fiK531xh+fNnuV2lPun8ILXEtjLOyd4fARf3R/DS17nGT9/cr0H96c7MHZ0J7ob0pAfa4mcKHOUJTsi2k1nXldB9N/WrxIZIFCpdwbKkw0XL15Upbxp+fc7U+1xuCYKY8dLMTW8F7PnDhPUMTy/OYCvHp+lncP9iz14NNWLV/dO4dXD0/jqyThePRjD7++eQnN1BsrzovDZjQF8LTj24DT++Mk5fPfpBL6dm8K3n87gz3MTNP6G9vWn4zw2jh+eTeAvn1/Gv385g+++vIJXT8bw7P5x9LcVorY0AhGuaojx1kbpVmdkhpvAy0IGm8SXT/HZ/09ie6tHCTJVbeOiv/har0NPfSaGW4tx7lgFrp5uwcNrDEt685Pr9Mp9euH2MNrqcjHYVo5vHp4hkDF899lFXBttQeeeHNSXJqO6KBb15Vtx8tgefPt8Cn9+MYXvv5ih50YZ8t24MNTA76pwqqMKo501wiQ30l2J9n0FOD90AM/vj+LRzFFM80Vnxpgj1EsV9iZrYWskCmuDVQj1UEFZtjtMDRQvvC/QLH2F3/3PKFdpDDYXY6xjFy4cZ9ieO4TH1weEIOfooa/osWfXB1G3IwHdTYX4w89A/41Ab51pxfEDRWhk8tlXGsesuxWjvbX4/uUMvnl6EV/PXeDD92P6RDMuDtbj/MBejPfW0fZirLcGfe3lqCiMR++hcrxklMyMHkDv/gwkhhog0F0RjuZisCFQU93lCPdQxd6SIFiZqQqAbnzn0KVHM4xVRebjvVUwwhud482nzzQxszKrXuzHi5vDDNMRfDl7BnMzg6hi2Thcu43HRvE1w/dbhu63n5zH959eQN9hgq1OZiT04/NHZ/H90yt4yvJztrsWZ3jdqdEmfDLTw2sO4CWv+eTmIKZOHUbP4Qqkxnqi9/BOfPtyGgf3xCM+VI/e1ESQhzqCPdXg46gEOyMJpIab4ci+JDhYab936GbY6a2bTw81wkh7Jc737cPM2VbMTnTjyaVBvLx1Aq+YiARJ6PaZI9i7PQKNuxLxYOoYx+Ig/sSx9qdPBGNwEtfo2Ynh/XjJ8BOM6W+fTuPxzACO7S/A2d7dzMzd+IzD4OWtIby4x8TG3w927EFDVTaKMkIw1leH/3h1Dc2VcYjy0USAqxL8nBUQ5KZC0BqIDTRAUbobCjN9/qqlsWmEHlV4Z48uWbI4w89Oc74k2Qsj3XswPtSEK+c68eASvXmDCYee+4Zj8ULPHgwf2okGjsGqnEgM89w7l3rwzbOL+OOTSXz3ZBo/0IMCE3j4z/T0D6+u48ZkJ2pKInGJperLO4wMZllBhLx6chZ3mZnLchJQU5yK1vp8TJ89jB+/v4tD1akIcdCCi6UUXK2k4Osoj8QwI/S2ZSM/K+Cv68RXtxKkP038nYGKLFmSEexsOL9zmx9OdlTjbE8dzh/fxwRzmLWylyHcjuskCd11WdhfGo/StCBkxXpjT3ECzg3U4ykTlCDRfH1vHH94cJ5JimH8bBJf3j/NsdiAnubt6GrIwp0LbSwjJzkEWEoYITNnOtDfuQf7qwrQvLeYPDqD43ofvvv8CqllLGwMNkFdfvWskuyqWxpKorOm+ptmI0Ns7xkbqhwjQEENXfIapGD71qwrABruZjG/Ky2URZ7Fvn0XTrSW4dLgftxl+J4d2IOjLUWoyo3E7oIoZrxQpEZ7IMHPigDycH9GEMLD+Po+gTJB/fHRGfzlj7dYd0dRGOeN6uwwTPXtZoSQXDCkf/+IJYk1s7W2GAdqyJ0P16KjsZLXTUBX0y6O7YsoZhhrKYuC+aOGgDRo6j+bgP6p0D78Jch3AyqyJCMxzH2+jgT9TG89OhsKkRXngfRYD6TEuBCUAxIDrbEtzBH1JTGYGjyAzrp8hLvqIyfREzWlCagrTUTTTv6eJeXSSDO3dThSX4AQN0McrEpnKF/El/dOM1zPs0bX0nvbGM6paKjMR9PuHdhdmo3YEDe0NewQAu0io4rj/STXi+57E9Cv7b/doyIiGamx/vP7d2XSewdwiA8Y6GkKB3M1WBhugq+dBgu2AeJ8LVDG8L5/8RgGWsoR6KCJ+EBLJEW6IIOWE+XMbEjqxnBsKU9HQYIvfJ312PWU4r/+8Ah/ejpFgnABu8sSCcoRFQXJBJiJvaWFyE3Zgki2fT2HqvDywThfRh3K8rZAVlpyH7239NfA/fL4OwClRyM953dvT2L3UY0hFvHew+UMo1J0N5fg0okm3DnfhdQtbnCzYqp3NYG/vSEiXUzRXpMjTFp3L3TjPu3rx5N4ydDLYb+aFO6I4a5K3Jk4ir+8vInJ4WZUbI9FuJ8tM6gVdmXHoTI3CQE+jshIicDkqXbcuHCMJWeMhGIvirMjsFFaXABU5JeAfu3zOwGND3efrywQFOwKYeY9P9iIC8NNzMCNJOzktbdHsT09CM4WajBQEoe9vhKyIzxx4nAlvqIHXvDhPr95Cl89nMSDa6MEY4lMtmj3LvPBrwyw9Eyjc38xQn0sEeRpgTBvaxSnRiIvORzenjao3pmOx9dO4AHr9Bw58VhfPXYVxi28R6MinedL8iJxpLEYQ0dqCLIF0ydbSerbcZ+t2MOrPaRoefSqF1QklyPExRAP2Jp9crkXn14hsb8toIPjOFiZi61hngxnVxyqy8FfSf2e3xohtTvIMecKNbk1iAqwQXqCD5wcjODmYsZwrcQkx/XDix14cWcY35LzXjt/hMmqACoKsgsburGRbvPFzKqt5LHHyVLODzZheqQVd0534MFkNx5O92CYrVdVQQI0pFYiluNVQPTnrvThs2tkONODtCGUbA1FmJsZDuxKx+jRvfiPZ5dJJY+gLDcGfjxuoisn9Gp8hCsCvG2QzfOnRg+x5z2E2fFD+OwWCQi58c2JLg6bMmioyC8kUJGMpCjv+bKcGNTuTEb7/kJhPZs60YI7ZEIPOG4eX+xlH3oEY0w0ZqrSzMJ2eMai/+k1tmrXT+EqX8rQoXL4O2oj2FkXjyb78QW9/MNnV3CwOhdiKxYJk1tMiB08HAzhaK2Ltt25bAX34xGZ0l32s5Ns6h9c7cXvPz2P2ctdGDlaBW0NhYUFuiXIZb4gNQzVxUnksfkYJeuZYLG/cqoF104dwk2Sh9ss8BN9+xFkb4zcGB/M8aEeM3Rf3D4lBJmf4I3CZD+Wma2sqyN4cLmfvWkhEiis6WlKwclOF36e5gjzYehGe7FMMcmNdwl73fts4CdPHcDDGQJ9PI7HV/oxyQbAUFttIYEuyQjytJ7PiPdHRX6y0AOnmX3P9NRgfLgW40z1E6yvd+jRqxy3OVt8UZUZhfvsbh6SBLx6Oo6yrGCYa4pRGajAg4keEvPLmDnfDh1lSZjoy8PH2wROTpthZq6N7HhfdFRnMvTJpu6fp0LRK1QopkYb8ZAv7vckHs8ZJXfP98BYX3thgQZ72cxnxPmRncRh34409LFgn2K7NjGwj2pDLT28G1MDjULrYEnpP1CMT9l2XehrwP7yNGRRBcyJ8cBUfzOb9S4Mt1dgZ24UdDQkYL5ZgaGqjRAvSyRzbJ4g+7rFITE7eRR3qUTcp/B2Z+IILlNeuUmO/fjqCSoZ5/AZQ9/URLf+18rJm8ffXl5IAYUejfVhCYlGTVEijuzNYstWwQffj5MEOdRZjfNkOxPkohPkwVdYE1+ypBxvrICPtQFy+du2qgxm6SO4N96DkpQABLoYQEdbAqaGcrDerEZyYc+GIIbJjY3A44vkus0M1wbcpg5141wbZoaacWW0DTcvHsfzBxeoQFyGmZHeAdbRQJrWm8De3H8r0CUE6uNiPi8QqfPi/FGeEYGO3ZmoLYxGRoQDghz1EUg7si+fLdx+Nt8jmKVS0N+8k7UwGE6WqqjdngBBuF9n9zE+tB/GmrLQkBeHibEqrEw1YLmZ5xQn4y7DXyCTPmWmrirawt42mqXrOOtnLz3bg2vMvhN9B6gbnaMycQNpsf4/6GrI/Wnx4sXJbwJ7c/+dgHo5Gc8nhDojK8qbukwI2moyUMSC72aqCH35NdCUWYW6smQh0BccW7fOdGJ3fgzig2zg76KHlso0jB+rF3YzrRS7ZSVW0VbD3EQDdla68Hc1Q2/TDrzgS3p6ZZDN9yBSY9w5Xr2EKsZjZt7HN/rZzx7G2a49eHb7NLuYGyjJjORLUvs7gWa8CezN/XcAujjD21lvPj7UFgkk1jnxfuSqKdgWYgNDhZXYuG4JJNd8QC/n4hK58MHKdOxMD4a7mSISA6wYjnE4Rn481rUbnra6UOZL0WUSMlCXgqaCBFK2eNJbR3GbkumtiQ48vNKLexTc/O30EEEa+Zw972c3TuDZjT7coqpxrp/Z9yrLFsO3vmIbpRSzH9kzp70J7M39dwLqZqc9Hx1giZhgJ2Sw19xXEo+0MFtYaYlDVmwpNol9gMPVaThJMpET7UpmZABXejs3xg0t7FpaSRAO7EzFZvUNPFcEeqqS1Hfk4Wm/mRpTChPLMJNPF4G048F0L+6SbflYayGYNVVANOaoQnzK8L1FRiSgnQ+mB4Th21Kbg6hAu4UDamusPh/oboJwejGJD78zN4IKnAtCWfwNlUShvVEExcneKEny4eelMFReja0M23L2jS01WUiJ9IC9mTrLiTg0SPNUN62Bi5UOGVYjroy1UcBup3XgFu3JJQpuHKeCzsbXQQdXqRkJjt89140bZ9txaawJjy714vm1k+hqLGGr6EmgSxbGo2a6ivM+TDjRAqDRzihI9UdOkgeytjjAVk+aY1QEEe4GCOKDKUkshYWmJApiXVFI4Dlb/eFuowNTzY3QU5EQmgNBb2NzLuDLMyMHcePkISHxuEHQF1iuRtgduZopwc1cCUMsN6eP1uIiQ/YSS8w0Vf17F7vxmLRysK0aRalRP1Ic+NeBCga6jrLUvCtbsIRQGySG22MrwW7P8MW+ili2ZOrQlBaBFr2qJrkUyhLL4WKsiJqcMBJ4B1hs3gRdhTXQlV4FbYX10FeXRm6yPxlWLgTAbgk8eoYeZcYVtHMNJXFMevyd+jrY8SXWV6SyB84nxy5nM7Efs5c62fUIMvEw2VMbmsrzf1wmIrIQQBdlqGwSn7czUkYCO4ukYAdKii7IZdbdkRuMGB9TOG+Wh478cihtEIGS2IcwUREXlh17QwW2beuxWXktjJTWwMlMDYEeJthXlsCklcZxnUlVIgElGcEoSg5kvfVFqIsR3M1VYaC4Bqbq4tgSZIuUaJa2rcEk/1FsxpPY+RRSvqnA8dZd1I+2LhDQRYuyN0ms+V/m2vKIJw9NCrBHaogLMpkt8xiWKaGOiPIwg66KKOQll0Bh7RIoE6zahhVQ3bCSY3Y1jJTXwERNFFF+FiglqL4DBThSk4kd2wKRSCLvaKkCc22Gtux66MqthY7sGkbIamhtEoUhE56FoTzrsR4cLLRhZ6pJPmzHVs+bk87hSI/3+VFEZAFCl6zDfflHIgO6qtJ/T/A1Qxwfdou/JRKCrLCVobzFy4yyiT60ZEWhI7canNaDD8fqxvX0rvRKJp+10GQC0lZaJxyzTTuS0MFaKpi6aOFcTANLBCeTqQfHo744EdkxfmRJTtisIc2XtwGhbqbUqHxxgOXrEKWYLgpzrfu2o2lvIbdF2FEQ/+OyZQsQugS6jLZdXUnyv+J9jRFDC/MxRrSPCRJ9TSmCbYaHuSYTksBz4ijY6osw9qNSrK+K0vQqvaOyUZTS5DoyK28coFjWVJ2ORnq0iRn54N4chiJnzBu3C3XhvQWJ2J4SCjM9eRhqbkJaqBuq82OF8sn4SCNuTHXg3HAj9+twkomLL2BhgAoKL//spcVFuyOZWcNddelBdUS56yEl0AKOxgpQY4hpEIghSYC5vhoTjiy0FNdDnd6UZwgr0rPKG1cJy4uRpjQ87TQRSEGNxR7pcV5U+tLZ1OdRhyrmdANrbmUyXKx12KNqoWFXGtqZjE6wRo8JNGX2wTcmjpHw95MPt6O7tfzHFSuW/evJ6GegH0quX14X6qKDYEct+FkrI8xZC/H+pjDXkYGc5MfQYQIy1JSBpiLLjaIktOldPbUNMNOVxWYe11aWgDLrpxJfiomONKxI5i0MFakoWFH5S6KHM4RN/aG6TDTvSYO3kxE8KLIJMm630NvlOEl2dZpTIldZU2cJ9Pp4NyegqhcU6BLxtcsbPOzU4WmjAk8TOXhz60Ow+mripHUruZUUmuqm1SQEokJS4O1oQLE5iOTCk6qDMxnRJshKroW6ohgFaDGCXsXyo4T4MHfsyInCgap0tOzJQsvebGEDHuxJEZxqY1dLGfWqEhzjLHd/ezFOHiXg4w1UGvopwbYsKNBl60SXH3CxUoabpaIQqIuJAmyM5Zgw1jNs13IrRq+JQVVOFLqqVAJNlBHNxFWcFoB8ypv51HGDXU3hYqHDzKkGc5YeDYV1ZEwa7EK8UZEXjSaWnCZ6tpHdUSJLWDQzfNOeHOG8S3vDdnQ2Ubk/tB2DnVUEW4tr9OiJnn0LCvTjtas+arQnMGdTOfhaKMBCa4Mwq+oQnAE5rACsCr2pp7aO9E6ZpMIJOXH01DZ/lHHtUVlOBHbnRWBvfjhlTF/EsSyZ6yrA39kEpTnhnCROxCE2BI1VaZw9S0dxVijSOCNQQv12d0kiVb88tFGv6mouIdidnO3eJQzjjqZSAdD0N0n8m/tvJfU/j1ER0ZUfNVjpSsNaVwYW2pLQZbkQhKmW4jqWDjFm1tVCudLORAle9lqI9DNFfLA10qIEjYA7sqgZ5RNgUYovCtN8WIO9KGI70JserIdhqOS8zZ7t0djFbUVBNLJ5bjyZVe7WAOzKj+JUYRpa92RzWqIAxxjKA6SG5zn90X2QyWjZwgFdKrp8aYO5mgSMGZbKBCXwngZ7UXXWSMFnRWZVXSYkT3sD+DgZwM9Vh5O0zNIsQVuCrPnQdmQ4rsyy7ijJ8kN5fhBqd0SxhkaiNDucXg3m1o882g95Kf6MCIYu53TS4zxJMkLQVMYuiOWojXM/Pa3lXKVSQ723Fb3tNQKP/uv96OsQWP7R0npdRbIWhbUsJ6sJkCVF2ImICoEaq4vR2xvgRKroTK+6WqvAxYx60GYZ+NhrUIE3/Ak0S1JquB0ytjjRyx7IjHelOXF1mRNfhKOQS8eF2rEWm8LfTZ+z2UaIIFGJD7ZFsmAeh+L2XrZ2B/fmCmtpe+MOgUffHShr5SqaJy2JFv+GxXz80dIWVbIfgQlByv4EVpBhBZ610ZWEo4E07PXkYGsgC3tTeVjrbYCx8krYG2+kpzXg66KLADcDriAxQZy/OWKD7WhWiAsxQQRLVZCnMdszHXhxktfNRhXOlsqkforCMe/OySxvR35nr8OZPE+O2yShVw/Vb39voNJaalJnw303z/u76P53Lwftv9maKv7NXH/j3zZrSv43fXWJ/xSQAkHS0SQZ0FQQAFzO+rmGS9zWw1Kf49dABiYcv6baYqyVPK6+GjpKK0jn1vKYBKwNN3L1CBOahRJnqwUg6HVrVQhA+HOaMdjTBIUpflxJFiuc5xni2gbBxNY5Koz3rwxzRnsXstj6JYTaI5MhPciVK237SsiM3s+j0hrKUhNRAab/IzbYmInCDBFcuxPqps6pcxWWFWZaPRmY6UgRjMAEKgHDdbMUbOkxB2ZjO3rR0lCGZGADbAzFCJ4qn44492V4jhycLJQJSp0dzGbKm0acNTNCZIAF513sORY9UEiS31FXgFPUhe7PDHFpz0mqgH1caziAx7fHMNC5G4XpQT8lMc7eHaf631iTJ6CA7xe67D1D2MTmqciLTlkbSf09xEMTMQGc+ww25Vu0wNYoe4YZZ7xI/8J9NjPJmPOmbKMi7BDhYyTkwMJMusWF85/Mpik+KGWTvqeYS25I4Hcym1az3+ynl4YIZuBINU5wDmaU+u8opwLHumo499mAc5Q2H1FpeDhFQYyK4j5mXF21NXC2UmOS0xeGe1FqAARzttkp4X9n95L9Opf82vYfygvHpgQtWFr841tm+rLf2Zopfethp8LVH5z79NDjGNMRjjdvwZjjZG8wvRPGntTXSZtLYLSxJdCKCydshZ1NRqQTOxYvkvII1O9IRCEfrpT18TBpXRs7kW6WiaMtO4TWUZ+HdpaPrv1F6KYAfpakfVIgip88SOkmGjJivyOP3sSVKIbIiHdDZeEWFHFGIMDL/hUdlPBrAF8f/weggi/4J0ZzpnnTciTXLv5EXkrkaz3VFeSu6zm+yIr0xGGsuBxWTEK2xrKwpZJgz60f+bCPoyabbEUmDg1mWhM27BZcLGlD+ZNlhq1dNpv2orRALsRIZYlJpoYby2UzgVzQ7IVybquyQlDB2bt6fjfBhVV1bM51VVbD20FPuKSgdmcSiUMxzE11vuDzZdH+YTXna4Cvt/8U6Osvfwa9iRey5ILdAhmJZXOKG1c+0VaVeMJkNKsj9+FfLHRFORbFOHbXcgyLw91WiWNRHjYsK85WisyUXA9Ebwcz4/o7a7Nr0UOUvxkSwmxIILxQwPAuSA1kcnFDaqSDMOS3U2grYsiX0fvtbOFq2cPGMTtnxXM48FgBLT7a+3OxdWsEIOV/+by/9vmtQF//kBeUpf1ysbDt8o8XHZUS+91tKbEl1yXWfnBDQ24Zw0sCFgaSMNeTYIaVZomQZ5alQkCzN90k3HrYqcLPSYPKhC7LjCm2sqZuDWMjH2SKzEg7ZHM/O9Gdaxco1+SFceFGHFkR1zOUxZNoRMLeSvc5nyWbJvf6+d62fWegb16INxGhCf4pQJWmRAtas3LJaSnxjydkJJePC0x2w6pxhY2rxxVkaBvXjMv9vFWSWz+uqiA2rq0iOa6jLj1uoCM3bqC5cdyAn420ZcdNdBTGjfQVx00NVMatTTXGbcy0x+0t9catTDUvmBqqTa5a8XEx7yf75jP93/Z/M9A3L8obCwjHP/vHgIU8JviHBcE/Goi9ef+37S8Y0Lfd6P/19//fAP3f+YIjjFBZi/cAAAAASUVORK5CYII=';
const isBattleScroll = (it) => it?.gfx === 65043 || it?.itemId === 99243 || (typeof it?.name === 'string' && baseName(it) === BATTLE_SCROLL_NAME);
let battleScrollImage;
function drawBattleScrollIcon(g, x, y, size) {
  if (!battleScrollImage) { battleScrollImage = new Image(); battleScrollImage.src = BATTLE_SCROLL_ICON; }
  if (!battleScrollImage.complete || !battleScrollImage.naturalWidth) return false;
  g.drawImage(battleScrollImage, x, y, size, size);
  return true;
}

// 外觀解鎖卡:自訂圖示(使用者 11/11 給的圖,來源 deploy/feature-appearunlock/merchant/icon-96.png,96×96),invgfx 65045。
const APPEAR_CARD_ICON = 'data:image/png;base64,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';
const isAppearCard = (it) => it?.gfx === 65045 || (typeof it?.name === 'string' && baseName(it).startsWith('外觀解鎖卡'));
let appearCardImage;
function drawAppearCardIcon(g, x, y, size) {
  if (!appearCardImage) { appearCardImage = new Image(); appearCardImage.src = APPEAR_CARD_ICON; }
  if (!appearCardImage.complete || !appearCardImage.naturalWidth) return false;
  g.drawImage(appearCardImage, x, y, size, size);
  return true;
}

// 變身書:自訂圖示(使用者 11/11 給的圖,來源 deploy/feature-polybook/icon/icon-96.png,96×96);認道具 99247 或名稱。
const POLY_BOOK_ICON = 'data:image/png;base64,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';
const isPolyBook = (it) => it?.itemId === 99247 || (typeof it?.name === 'string' && baseName(it) === '變身書');
let polyBookImage;
function drawPolyBookIcon(g, x, y, size) {
  if (!polyBookImage) { polyBookImage = new Image(); polyBookImage.src = POLY_BOOK_ICON; }
  if (!polyBookImage.complete || !polyBookImage.naturalWidth) return false;
  g.drawImage(polyBookImage, x, y, size, size);
  return true;
}

function iconCanvas(it, px) {
  const c = el('canvas', isBlessed(it) ? 'icon blessed' : isCursed(it) ? 'icon cursed' : 'icon');
  c.width = c.height = px * DPR;
  c.style.width = c.style.height = `${px}px`;
  const g = c.getContext('2d');
  g.scale(DPR, DPR);
  // gamedex 圖示 → Flare 道具圖示 → 舊的小圖;圖集還沒載入就稍後補畫
  const paint = () => {
    g.clearRect(0, 0, px, px);
    if (isTishaGuard(it)) return drawTishaGuardIcon(g, 0, 0, px);
    if (isRenameCard(it)) return drawRenameIcon(g, 0, 0, px);
    if (isHighPetCert(it)) return drawHighPetIcon(g, 0, 0, px);
    if (isNoDeathExp(it)) { // 10/27 使用者:道具圖示改用 BUFF 圖
      if (!nodeathBuffImage) { nodeathBuffImage = new Image(); nodeathBuffImage.src = NODEATH_BUFF_ICON; }
      if (!nodeathBuffImage.complete || !nodeathBuffImage.naturalWidth) return false;
      g.drawImage(nodeathBuffImage, 0, 0, px, px);
      return true;
    }
    if (isBattleScroll(it)) return drawBattleScrollIcon(g, 0, 0, px);
    if (isAppearCard(it)) return drawAppearCardIcon(g, 0, 0, px);
    if (isPolyBook(it)) return drawPolyBookIcon(g, 0, 0, px);
    if (GDX.drawIcon(g, it, 0, 0, px)) return true;
    if (GDX.hasIcon(it) !== false) return false; // 原版圖示還在載入:等它,不先畫替代圖
    const done = FLARE.drawIcon(g, it, 0, 0, px);
    if (!done) SPR.draw(g, SPR.item(it), px / 2, px * 0.92, (px / 16) * 0.85);
    return done && GDX.hasIcon(it) !== undefined;
  };
  if (!paint()) {
    const retry = () => { if (!paint()) setTimeout(retry, 600); };
    setTimeout(retry, 600);
  }
  return c;
}

function findItem(re) {
  for (const it of st.inv.values()) if (re.test(it.name)) return it;
  return null;
}

// 魔法卷軸(各種法術):use_type spell_buff = 可以對自己用(送自己的物件編號當目標);spell_long / spell_short = 需要選目標(網頁沒有選目標流程,先不送)
const SCROLL_SELF = new Set(['初級治癒術', '中級治癒術', '高級治癒術', '神聖武器', '解毒術', '通暢氣脈術', '聖潔之光', '體魄強健術', '祝福魔法武器', '全部治癒術']);
const SCROLL_TARGET = new Set(['光箭', '冰箭', '風刃', '寒冷戰慄', '毒咒', '地獄之牙', '火箭', '極光雷電', '起死回生術', '闇盲咒術', '寒冰氣息', '能量感測', '燃燒的火球', '壞物術',
  '吸血鬼之吻', '緩速術', '岩牢', '木乃伊的詛咒', '極道落雷', '迷魅術', '冰錐', '魔力奪取', '黑闇之影']);
// 空的魔法卷軸(等級 1~5 = 40090~40094):法師選要寫入的魔法(伺服器 C_ItemUSe 把封包第二個 D 的第一個 byte 當魔法索引,以前網頁不帶 → 永遠初級治癒術)
const BLANK_MAX = [7, 15, 22, 31, 39]; // 卷軸等級 1~5 可寫的最大索引(0 起算;伺服器寫死)
function openBlankScroll(it, lv) {
  if (st.myType !== 3) { send({ t: 'useitem', id: it.id }); return; } // 非法師:照舊,伺服器回「你的職業無法使用此道具」
  const skills = st.game.skills || {};
  const rows = [];
  for (let idx = 0; idx <= BLANK_MAX[lv - 1]; idx++) {
    if (idx === 23) continue; // 40882 不存在(skill 24 = none):伺服器什麼都不會發生
    const sid = idx + 1; // 技能表 skill_id = 索引 + 1(伺服器扣的魔法,產出的卷軸顯示的名稱也是它)
    const sk = skills[sid];
    if (!sk || !sk.name || sk.name === 'none' || !st.skills.has(sid)) continue;
    rows.push({ idx, sk, cost: sk }); // 伺服器扣的是 index + 1 那個魔法的 MP / HP / 材料
  }
  showDialog(`空的魔法卷軸(等級 ${lv})`, '選擇要寫入的魔法:消耗該魔法的 MP / 材料,產出一張魔法卷軸');
  if (!rows.length) { $('#dlg-body').appendChild(el('p', 'empty', '沒有可以寫入的魔法(要已學會、而且卷軸等級夠)。')); return; }
  for (const r of rows) {
    const c = r.cost;
    const sub = `Lv${r.sk.level} · MP ${c.mp || 0}${c.hp ? ` · HP ${c.hp}` : ''}${c.mat ? ` · ${c.mat[0] === 40318 ? '魔法寶石' : `材料 ${c.mat[0]}`} ×${c.mat[1]}` : ''}`;
    menuButton(r.sk.name, sub, () => { closeDialog(); send({ t: 'useitem', id: it.id, target: r.idx }); });
  }
}
function useItem(it) {
  if (paraBlocked('麻痺中無法使用道具')) return;
  if (!it) return;
  if (PolyMenu.tierForItem(polyMenuData, it)) return openPolyPicker(it); // 網頁版 11/05 polymenu
  const sc = /^魔法卷軸\s*\(([^()]+)\)/.exec(String(it.name || '').replace(/^[+-]\d+\s*/, '').trim());
  if (sc && SCROLL_SELF.has(sc[1].trim())) { closeItemSheet(); send({ t: 'useitem', id: it.id, target: st.selfId }); return; } // 對自己施放(伺服器只扣 1 張)
  if (sc && SCROLL_TARGET.has(sc[1].trim())) { closeItemSheet(); toast('這張魔法卷軸要指定目標,請對目標使用'); return; } // 不送封包、不扣卷軸
  // 強化卷軸:不直接使用(沒有目標不會有效果),改開強化視窗並先放好這張卷軸
  if (scrollKind(it)) {
    enchantSel.scroll = it;
    if (enchantSel.target && gearKind(enchantSel.target) !== scrollKind(it)) enchantSel.target = null;
    enchantSel.msg = '';
    closeItemSheet();
    openPanel('enchant');
    return;
  }
  { const bl = /^空的魔法卷軸\s*\(等級\s*(\d)\)/.exec(String(it.name || '').replace(/^[+-]\d+\s*/, '').trim()); if (bl && +bl[1] >= 1 && +bl[1] <= 5) { closeItemSheet(); openBlankScroll(it, +bl[1]); return; } }
  if (baseName(it) === '回憶蠟燭') { closeItemSheet(); openCharReset(); return; } // 重新分配能力值(不走 C_ItemUSe)
  if (isGear(it) && !isEquipped(it)) { equipSwap(it); return; }
  // 祝福的瞬間移動卷軸:先選地點(隨機 / 記憶座標)
  if (/瞬間移動卷軸$/.test(baseName(it)) && isBlessed(it)) { openTeleportSheet(it); return; }
  if (baseName(it) === '復活卷軸') { openResSheet(it); return; }
  if (RENAME_CARD.test(baseName(it))) { openRenameDialog(it); return; } // 改名卡:開輸入新名稱的視窗
  if (baseName(it) === '贖罪聖書' && (it.count || 1) > 1) { closeItemSheet(); openAtonementDialog(it); return; } // 10/31 選本數
  if (baseName(it) === '贖罪卷軸' && (it.count || 1) > 1) { closeItemSheet(); openPkEraseDialog(it); return; } // 11/03 選張數
  if (baseName(it) === '烏木魔杖') { useWand(it); return; } // 10/31 快捷鍵:對目標用
  send({ t: 'useitem', id: it.id });
}
// 烏木魔杖(伺服器 40007 閃電魔杖,使用者 10/31「烏木魔杖加入可以放到快捷鍵」):伺服器拿封包第二個 D 當目標,沒有目標 / 打不到也照扣次數 → 沒有目標不送。
// 目標:點選鎖定的(點選模式)> 正在打的那隻 > 畫面上最近的怪;開 PvP 時鎖定的敵人玩家也可以(和快捷欄攻擊魔法同規則)。不會走過去,有障礙就提示。
function useWand(it) {
  const me = self();
  if (!me || me.dead) return;
  const alive = (o) => o && !o.dead && !o.dying && o.kind === 'monster';
  const enemyPc = (o) => st.forceAttack && o && !o.dead && !o.dying && o.kind === 'pc' && o.id !== st.selfId && !(st.party || []).some((m) => m.id === o.id);
  const ok = (o) => alive(o) || enemyPc(o);
  let t = st.clickSelect && st.picked ? pickedTarget() : null;
  if (!ok(t)) t = st.target?.mode === 'attack' ? st.objects.get(st.target.id) : null;
  if (!ok(t)) {
    t = null;
    let bd = Infinity;
    const W = canvas.width / (DPR * ZOOM);
    const H = canvas.height / (DPR * ZOOM);
    for (const o of st.objects.values()) {
      if (!alive(o)) continue;
      const p = toScreen(o.px, o.py);
      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue;
      const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
      if (d < bd && clearLine(me.x, me.y, o.x, o.y)) { t = o; bd = d; }
    }
  }
  if (!t) { toast('畫面上沒有可以使用的目標(沒有送出,不扣次數)'); return; }
  if (!clearLine(me.x, me.y, t.x, t.y)) { toast('與目標之間有障礙'); return; }
  closeItemSheet();
  send({ t: 'useitem', id: it.id, target: t.id });
}

// ---- 改名卡(使用者 10/20:3 天冷卻、不公告、舊名保護 24 小時;伺服器 rename 封包 / 結果碼見 RENAME_MSG)----
const RENAME_CARD = /改名卡/;
const RENAME_MAX = 12; // 同建立角色:不分中英最多 12 字,只能中文 / 英文 / 數字
// 伺服器結果碼 → 繁中訊息(hours = 伺服器給的剩餘小時;冷卻 / 保護用)
const RENAME_MSG = {
  1: () => '請輸入新名稱',
  2: () => `名稱長度要 1~${RENAME_MAX} 字`,
  3: () => '名稱只能用中文、英文或數字',
  4: () => '這個名稱不能使用,請換一個',
  5: () => '這個名稱已經有人使用了',
  6: (h) => `這個名稱還在保護中,${h > 0 ? `${h} 小時後` : '稍後'}才能使用`,
  7: (h) => `還要 ${h > 0 ? h : 1} 小時才能再改名`,
  8: () => '新名稱和現在的名稱一樣',
  9: () => '目前不能改名(個人獵場、交易、組隊或戰鬥中請先結束)',
  10: () => '找不到改名卡',
  99: () => '改名失敗,請稍後再試',
};
// 改名成功後把這台裝置上這個角色的設定搬到新名稱(AUTO 設定、快捷欄、背包整理、掛機統計、勇敢 / buff 紀錄、選角畫面的格子位置);別台裝置本來就沒有這些
const RENAME_PREF_KEYS = ['settings', 'hotbar', 'hotbarLock', 'invSorted', 'huntStats', 'huntBase', 'brave4', 'buffTotal'];
function migrateCharPrefs(oldName, newName, account) {
  if (!oldName || !newName || oldName === newName) return 0;
  let n = 0;
  try {
    for (const k of RENAME_PREF_KEYS) {
      const from = `l1j.${k}:${oldName}`;
      const v = localStorage.getItem(from);
      if (v == null) continue;
      if (localStorage.getItem(`l1j.${k}:${newName}`) == null) { localStorage.setItem(`l1j.${k}:${newName}`, v); n++; }
      localStorage.removeItem(from);
    }
    if (account) {
      const sk = `l1j.slots.${account}`;
      const map = JSON.parse(localStorage.getItem(sk) || '{}');
      if (oldName in map) { if (!(newName in map)) map[newName] = map[oldName]; delete map[oldName]; localStorage.setItem(sk, JSON.stringify(map)); n++; }
    }
  } catch { /* 無痕模式存不了就算了 */ }
  return n;
}
// 送出後先記下「舊 → 新」:成功事件沒收到(斷線 / 關頁)時,下次選角畫面看到新名稱就補做搬移
const RENAME_PENDING = 'l1j.renamePending';
function renameSetPending(oldName, newName) { try { localStorage.setItem(RENAME_PENDING, JSON.stringify({ oldName, newName, account: st.account || '', at: Date.now() })); } catch { /* 無痕模式 */ } }
function renameClearPending() { try { localStorage.removeItem(RENAME_PENDING); } catch { /* 無痕模式 */ } }
function renameApplyPending() { // 選角畫面載入角色後呼叫(app.js renderChars)
  let p = null;
  try { p = JSON.parse(localStorage.getItem(RENAME_PENDING) || 'null'); } catch { p = null; }
  if (!p) return;
  if (Date.now() - p.at > 10 * 60 * 1000) { renameClearPending(); return; }
  if (p.account && st.account && p.account !== st.account) return;
  const names = new Set((st.chars || []).map((c) => c.name));
  if (names.has(p.newName)) { migrateCharPrefs(p.oldName, p.newName, p.account || st.account); renameClearPending(); }
  else if (names.has(p.oldName) && names.size > 0) { /* 還是舊名:改名沒成功,不搬;等逾時清掉 */ }
}
let renameCard = null, renameUi = null;
// 10/31 使用者「贖罪聖書可以選擇一次要使用的數量」:選本數後連續送 useitem(每本 +3000,伺服器在正義值滿時不扣書);預設 = 補到上限剛好需要的本數
const ATONE_GAIN = 3000, ATONE_MAX = 32767;
function openAtonementDialog(book) {
  const have = Math.max(1, book.count || 1);
  const now = st.me?.lawful ?? 0;
  const need = Math.max(1, Math.ceil((ATONE_MAX - now) / ATONE_GAIN));
  const maxUse = Math.min(have, need);
  showDialog('贖罪聖書', `目前正義值:${now}(身上 ${have} 本)`);
  dlg.mode = 'atonement';
  const body = $('#dlg-body');
  if (now >= ATONE_MAX) { body.appendChild(el('p', 'hint', '正義值已經是最高了,不需要使用。')); return; }
  const inp = el('input');
  inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = '1'; inp.max = String(maxUse); inp.value = String(maxUse);
  inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;font-size:16px;margin:6px 0';
  const prev = el('p', 'hint', '');
  const n = () => Math.max(1, Math.min(maxUse, Math.floor(+inp.value || 1)));
  const upd = () => { const k = n(); prev.textContent = `使用 ${k} 本:正義值 ${now} → ${Math.min(ATONE_MAX, now + k * ATONE_GAIN)}${k === maxUse && maxUse < have ? '(已到上限,多的不會使用)' : ''}`; };
  inp.oninput = upd;
  const row = el('div', 'dlg-row');
  for (const [label, v] of [['1', 1], ['補滿', maxUse]]) { const b = el('button', 'clan-btn', label); b.type = 'button'; b.onclick = () => { inp.value = String(v); upd(); }; row.appendChild(b); }
  const go = el('button', 'clan-btn on', '使用'); go.type = 'button';
  go.onclick = () => {
    const k = n(); closeDialog(); closeItemSheet();
    for (let i = 0; i < k; i++) setTimeout(() => send({ t: 'useitem', id: book.id }), i * 150); // 間隔送,伺服器逐本處理
  };
  body.appendChild(el('p', 'hint', `每本正義值 +${ATONE_GAIN},最高 ${ATONE_MAX}。最多可用 ${maxUse} 本。`));
  body.appendChild(inp); body.appendChild(prev); body.appendChild(row); body.appendChild(go);
  upd();
}
// 11/03 使用者「放一個贖罪卷軸,但要跟贖罪聖書區分」:贖罪卷軸每張 PK 次數 −1、正義值 +500;選張數後連續送 useitem(伺服器在 PK 次數 0 時不扣卷軸)
const PKERASE_GAIN = 500;
function openPkEraseDialog(scroll) {
  const have = Math.max(1, scroll.count || 1);
  const now = st.me?.lawful ?? 0;
  const pk = Number.isInteger(st.pkCount) ? st.pkCount : null; // 伺服器送的目前 PK 次數(舊伺服器沒送 = null,照張數)
  showDialog('贖罪卷軸', `${pk === null ? '' : `目前 PK 次數:${pk},`}目前正義值:${now}(身上 ${have} 張)`);
  dlg.mode = 'pkerase';
  const body = $('#dlg-body');
  if (pk === 0) { body.appendChild(el('p', 'hint', 'PK 次數已經是 0,不需要使用。')); return; }
  const maxUse = pk === null ? have : Math.min(have, pk);
  const inp = el('input');
  inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = '1'; inp.max = String(maxUse); inp.value = String(maxUse);
  inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;font-size:16px;margin:6px 0';
  const prev = el('p', 'hint', '');
  const n = () => Math.max(1, Math.min(maxUse, Math.floor(+inp.value || 1)));
  const upd = () => { const k = n(); prev.textContent = `使用 ${k} 張:PK 次數 ${pk === null ? `−${k}` : `${pk} → ${pk - k}`},正義值 ${now} → ${Math.min(ATONE_MAX, now + k * PKERASE_GAIN)}`; };
  inp.oninput = upd;
  const row = el('div', 'dlg-row');
  for (const [label, v] of [['1', 1], ['10', Math.min(10, maxUse)], ['全部', maxUse]]) { const b = el('button', 'clan-btn', label); b.type = 'button'; b.onclick = () => { inp.value = String(v); upd(); }; row.appendChild(b); }
  const go = el('button', 'clan-btn on', '使用'); go.type = 'button';
  go.onclick = () => {
    const k = n(); closeDialog(); closeItemSheet();
    for (let i = 0; i < k; i++) setTimeout(() => send({ t: 'useitem', id: scroll.id }), i * 150); // 間隔送,伺服器逐張處理
  };
  body.appendChild(el('p', 'hint', `每張 PK 次數 −1、正義值 +${PKERASE_GAIN}(最高 ${ATONE_MAX})。PK 次數已經是 0 時不會消耗。${pk === null ? '' : `最多可用 ${maxUse} 張。`}`));
  body.appendChild(inp); body.appendChild(prev); body.appendChild(row); body.appendChild(go);
  upd();
}
function openRenameDialog(card) {
  renameCard = card;
  const me = st.myName || '';
  showDialog('角色改名', `目前名稱:${me}`);
  dlg.mode = 'rename';
  const body = $('#dlg-body');
  body.appendChild(el('p', 'hint', `改名後會先登出,重新登入即可;這台裝置的 AUTO 設定、快捷欄會自動帶過去。改名後 3 天內不能再改,舊名稱 24 小時內別人不能使用。`));
  const inp = el('input');
  inp.placeholder = `新名稱(最多 ${RENAME_MAX} 字)`; inp.maxLength = RENAME_MAX * 2; inp.autocomplete = 'off';
  inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;font-size:16px;margin:6px 0';
  const msg = el('p', 'hint', '');
  msg.style.color = '#ff9a8a';
  const go = el('button', 'clan-btn on', '改名'); go.type = 'button';
  const check = () => {
    const nm = inp.value.trim();
    if (!nm) return RENAME_MSG[1]();
    if ([...nm].length > RENAME_MAX) return RENAME_MSG[2]();
    if (!/^[\p{L}\p{N}]+$/u.test(nm)) return RENAME_MSG[3]();
    if (nm === me) return RENAME_MSG[8]();
    return '';
  };
  const step1 = () => {
    const err = check();
    if (err) { msg.textContent = err; return; }
    const nm = inp.value.trim();
    msg.style.color = '#f2c55c';
    msg.textContent = `確定把「${me}」改成「${nm}」?改名卡會消耗,改名後會登出。再按一次確認。`;
    go.textContent = '確定改名';
    go.onclick = () => {
      go.disabled = true; inp.disabled = true; msg.textContent = '送出中…';
      renameSetPending(me, nm);
      send({ t: 'rename', id: card.id, name: nm });
    };
  };
  go.onclick = step1;
  inp.addEventListener('input', () => { msg.style.color = '#ff9a8a'; msg.textContent = ''; go.textContent = '改名'; go.onclick = step1; });
  renameUi = { inp, msg, go, step1 };
  body.append(inp, msg, go);
  const cancel = el('button', 'clan-btn', '取消'); cancel.type = 'button'; cancel.style.marginLeft = '8px'; cancel.onclick = closeDialog;
  body.appendChild(cancel);
  setTimeout(() => inp.focus(), 50);
}
// 伺服器結果(app.js case 'rename'):成功 → 搬設定、等伺服器踢回選角;失敗 → 顯示原因,可以改名稱再試(不扣卡)
function renameResult(ev) {
  if (ev.ok || ev.code === 0) {
    migrateCharPrefs(ev.oldName || st.myName, ev.newName, st.account);
    renameClearPending();
    closeDialog();
    { const old = ev.oldName || st.myName; const c = st.chars?.find((x) => x.name === old); if (c && ev.newName) c.name = ev.newName; } // 選角清單改成新名字(伺服器回選角時不重送清單,不改會一直顯示舊名、點進去找不到)
    if (typeof logoutToSelect === 'function') logoutToSelect(); // 伺服器已登出角色但不重送角色清單:照換角流程送 changechar(gateway 跑 s.inGame = false)並拿新清單
    toast(`改名成功:${ev.oldName || ''} → ${ev.newName || ''}`);
    return;
  }
  renameClearPending();
  if (ev.code === 99 && typeof logoutToSelect === 'function') { // 登出後改名交易失敗:角色已在選角畫面(名字和卡都沒變),網頁也回選角
    closeDialog(); logoutToSelect(); toast(ev.msg || RENAME_MSG[99]()); return;
  }
  const text = ev.msg || (RENAME_MSG[ev.code] || RENAME_MSG[99])(ev.hours | 0);
  if (dlg.mode === 'rename' && renameUi) { // 留在視窗:顯示原因,輸入欄 / 按鈕恢復,可以改名稱再試(沒扣卡)
    renameUi.msg.style.color = '#ff9a8a'; renameUi.msg.textContent = text;
    renameUi.inp.disabled = false; renameUi.go.disabled = false; renameUi.go.textContent = '改名'; renameUi.go.onclick = renameUi.step1;
  } else toast(text);
}

// 復活卷軸:網頁點不到地上的寵物屍體,改成選項圈(伺服器 C_ItemUSe 會復活那個項圈領出來、已經死掉的寵物;沒死不扣卷軸)
// 只列死掉的寵物:先問 gateway 哪些項圈的寵物死了(pets.dead),回來再畫(showResTargets)
let resScroll = null;
function openResSheet(scroll) {
  const collars = [...st.inv.values()].filter((i) => /^項圈/.test(i.name));
  showDialog('復活卷軸', '請選擇要復活的寵物');
  dlg.mode = 'res';
  resScroll = scroll;
  if (!collars.length) { showResTargets([]); return; } // 沒有項圈:不用問 gateway,直接列(附近死亡的玩家 / 沒有可復活的目標)
  $('#dlg-body').appendChild(el('p', 'empty', '查詢中…'));
  send({ t: 'deadpets', ids: collars.map((c) => c.id) });
}
function showResTargets(ids) {
  if (dlg.mode !== 'res' || !resScroll) return;
  const scroll = resScroll;
  const dead = ids ? new Set(ids) : null; // null:查詢失敗 → 全部列出
  const collars = [...st.inv.values()].filter((i) => /^項圈/.test(i.name) && (!dead || dead.has(i.id)));
  showDialog('復活卷軸', dead ? '請選擇要復活的寵物' : '查不到寵物狀態,請選擇項圈');
  dlg.mode = 'res';
  // 附近死亡的玩家(伺服器 C_ItemUSe:目標是玩家物件編號 → 問對方要不要復活 321 / 322);範圍 = 畫面附近 12 格
  const me = self();
  const deadPcs = [...st.objects.values()].filter((o) => o.kind === 'pc' && o.dead && o.id !== st.selfId && me && Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) <= 12);
  if (!collars.length && !deadPcs.length) $('#dlg-body').appendChild(el('p', 'empty', '沒有死亡的寵物,附近也沒有死亡的玩家。'));
  for (const c of collars) {
    const m = /\[(Lv\.\d+) ([^\]]*)\]/.exec(c.name);
    menuButton(m ? m[2] : c.name, m ? m[1] : '', () => { send({ t: 'useitem', id: scroll.id, target: c.id }); closeDialog(); });
  }
  for (const o of deadPcs) menuButton(o.name || '玩家', '死亡的玩家', () => { send({ t: 'useitem', id: scroll.id, target: o.id }); closeDialog(); });
}

// 背包 / 裝備格:點一下開道具選單,快速點兩下直接使用(裝備就是穿上 / 脫下)
// 用道具 id 記住第一下,畫面中途重畫(格子換成新的元素)也認得出是第二下
const DOUBLE_TAP_MS = 280;
let itemTap = null;
function tapItem(it) {
  if (itemTap && itemTap.id === it.id) {
    clearTimeout(itemTap.timer);
    itemTap = null;
    if (typeof tpTag === 'function') tpTag('invdbl'); // 11/17 tpsource:背包點兩下
    useItem(st.inv.get(it.id) || it);
    return;
  }
  if (itemTap) clearTimeout(itemTap.timer);
  itemTap = { id: it.id, timer: setTimeout(() => { itemTap = null; openItemSheet(st.inv.get(it.id) || it); }, DOUBLE_TAP_MS) };
}

// ---- 記憶座標(伺服器 C_AddBookmark / C_DeleteBookmark;st.bookmarks 是伺服器送來的清單)----
// 記住目前位置;同名的記憶點直接覆蓋(先刪掉舊的再記)
function addBookmark(name) {
  const me = self();
  name = (name || '').trim() || `${st.mapName || '記憶'} ${me?.x ?? ''},${me?.y ?? ''}`;
  if ((st.bookmarks || []).some((b) => b.name === name)) deleteBookmark(name);
  send({ t: 'bookmark', name });
}
// 「/記憶」:列出記憶點,點一個就用祝福的瞬間移動卷軸飛過去(身上要有卷軸)
function openBookmarkList() {
  const scroll = [...st.inv.values()].find((i) => /瞬間移動卷軸$/.test(baseName(i)) && isBlessed(i));
  openTeleportSheet(scroll || null, 0, true);
}
function deleteBookmark(name) {
  send({ t: 'bookmarkdel', name });
  st.bookmarks = (st.bookmarks || []).filter((b) => b.name !== name);
}
// 用祝福的瞬間移動卷軸:選隨機傳送或飛往記憶點;下面可以記憶目前位置、刪除記憶點
// skillId:指定傳送(5) / 集體傳送術(69)施法時也用這個選單
// listOnly:「/記憶」打開的清單(沒有隨機傳送;沒有卷軸也能看,點地點時才提示)
function openTeleportSheet(scroll, skillId = 0, listOnly = false) {
  if (!skillId && !listOnly && (!scroll || !st.inv.has(scroll.id))) { closeDialog(); return; }
  showDialog(listOnly ? '記憶座標' : skillId ? (st.game.skills[skillId]?.name || '傳送') : '祝福的瞬間移動卷軸',
    listOnly ? (scroll ? '點地點用祝福的瞬間移動卷軸前往' : '前往需要祝福的瞬間移動卷軸') : '選擇要傳送的地點');
  dlg.mode = 'teleport';
  $('#dialog').classList.add('tp'); // 畫面中間的長條視窗,清單約 8 筆高、超過可以捲
  dlg.scroll = scroll;
  dlg.skill = skillId;
  dlg.listOnly = listOnly;
  const go = (b) => {
    if (listOnly && !scroll) { toast('身上沒有祝福的瞬間移動卷軸'); return; }
    if (typeof tpTag === 'function') tpTag('menu'); // 11/17 tpsource
    if (skillId) {
      const me = self();
      if (me) startCast(me, st.game.skills[skillId], null);
      send({ t: 'useskill', skill: skillId, bookmark: b ? { map: b.map, id: b.id } : null });
    } else send(b ? { t: 'useitem', id: scroll.id, bookmark: { map: b.map, id: b.id } } : { t: 'useitem', id: scroll.id });
    closeDialog();
  };
  if (!listOnly) menuButton('隨機傳送', '同一張地圖隨機地點', () => go(null));
  const list = [...(st.bookmarks || [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true })); // 測試點2 排在 測試點10 前面
  for (const b of list) {
    menuButton(b.name, `${b.mapName || '地圖 ' + b.map} (${b.x}, ${b.y})`, () => go(b));
    const btn = $('#dlg-body').lastElementChild;
    const del = el('b', 'bm-del', '刪除');
    let armed = 0;
    del.onclick = (e) => {
      e.stopPropagation();
      if (performance.now() - armed < 3000) { deleteBookmark(b.name); openTeleportSheet(scroll, skillId, listOnly); return; }
      armed = performance.now();
      del.textContent = '確定?';
      setTimeout(() => { del.textContent = '刪除'; }, 3000);
    };
    btn.appendChild(del);
  }
  if (!list.length) $('#dlg-body').appendChild(el('p', 'empty', '還沒有記憶點。輸入「/記憶 名稱」或在下面輸入名稱,記住目前的位置。'));
  const row = el('div', 'bm-add');
  const input = el('input');
  input.placeholder = '記憶目前位置(名稱)';
  input.maxLength = 16;
  const add = el('button', 'clan-btn on', '記憶');
  add.type = 'button';
  add.onclick = () => addBookmark(input.value);
  row.append(input, add);
  // 輸入列固定在視窗最下面(清單捲動時不會跟著跑掉)
  const foot = $('#dlg-foot');
  [...foot.querySelectorAll('.bm-add')].forEach((e) => e.remove());
  foot.prepend(row);
  foot.classList.remove('hidden');
}

// 背包直接換裝:同部位已經穿著別的就先脫掉再穿新的。
// (原版要先脫斗篷才能換盔甲、先脫斗篷和盔甲才能換內衣;伺服器已拿掉這個規定,直接換)
function equipSwap(it) {
  const slot = equipSlot(it);
  const worn = [...st.inv.values()].filter(isEquipped);
  const on = (sl) => worn.filter((w) => equipSlot(w) === sl);
  const off = []; // 要先脫的(依序)
  if (slot === 'ring') { const r = on('ring'); if (r.length >= 2) off.push(r[0]); } // 戒指有兩格,滿了才換掉第一個
  else if (slot === 'helm' && isMagicHelm(it)) { // 魔法頭盔兩格:同一種已經戴著就不動;兩格滿了換掉第一頂
    const mh = on('helm').filter(isMagicHelm);
    if (mh.some((w) => baseName(w) === baseName(it))) { toast('同一種魔法頭盔不能戴兩頂'); return; }
    if (mh.length >= 2) off.push(mh[0]);
  } else if (slot === 'helm') off.push(...on('helm').filter((w) => !isMagicHelm(w))); // 一般頭盔只換一般頭盔
  else if (slot !== 'weapon') off.push(...on(slot)); // 武器伺服器會自己換
  const steps = [...off.map((w) => w.id), it.id];
  steps.forEach((id, i) => setTimeout(() => send({ t: 'useitem', id }), i * 250));
}

// ---------------- 狀態列 ----------------
const BASE_MR = [10, 0, 25, 15, 10, 18, 20]; // L1PcInstance.resetBaseMr
function mrFromWis(wis) {
  // CalcStat.calcStatMr
  if (wis <= 14) return 0;
  if (wis <= 16) return 3;
  const table = { 17: 6, 18: 10, 19: 15, 20: 21, 21: 28, 22: 37, 23: 47 };
  if (table[wis] != null) return table[wis];
  if (wis >= 50) return 65;
  if (wis >= 47) return 64;
  if (wis >= 44) return 62;
  if (wis >= 40) return 59;
  if (wis >= 35) return 55;
  if (wis >= 30) return 52;
  return 50;
}

function expPercent(m) {
  const t = st.game.expTable;
  if (!t.length || !m.level) return 0;
  const cur = t[m.level - 1] ?? 0;
  const next = t[m.level] ?? cur;
  if (next <= cur) return 100;
  return Math.max(0, Math.min(100, ((m.exp - cur) * 100) / (next - cur)));
}

function updateHud() {
  const m = st.me;
  if (!m) return;
  if (m.maxHp) {
    $('.bar.hp i').style.width = `${(100 * m.hp) / m.maxHp}%`;
    $('.bar.hp b').textContent = `${m.hp}/${m.maxHp}`;
  }
  if (m.maxMp) {
    $('.bar.mp i').style.width = `${(100 * m.mp) / m.maxMp}%`;
    $('.bar.mp b').textContent = `${m.mp}/${m.maxMp}`;
  }
  $('#hud-lv').textContent = `Lv.${m.level ?? 1}`;
  $('#btn-charmarket').classList.toggle('hidden', !st.charMarket && !st.charMarketRecovery);
  $('#btn-auction').classList.toggle('hidden', (m.level ?? 1) < 20); // 拍賣行 20 級才能用(L1Auction.MIN_LEVEL)
  $('#st-ac').textContent = m.ac ?? 0;
  const mr = (BASE_MR[st.myType] ?? 0) + mrFromWis(m.wis ?? 0) + Math.floor((m.level ?? 1) / 2) + (m.mrBonus ?? 0);
  $('#st-mr').textContent = mr;
  const lawful = m.lawful ?? 0;
  $('#st-lawful-label').textContent = lawful < 0 ? '邪惡' : '正義';
  $('#st-lawful').textContent = lawful > 0 ? `+${lawful}` : lawful;
  $('#st-lawful-wrap').classList.toggle('chaotic', lawful < 0);
  $('#st-gold').textContent = goldShown().toLocaleString('zh-TW');
  if (st.game.expTable.length) {
    const pct = expPercent(m);
    $('#exp-bar i').style.width = `${pct}%`;
    $('#exp-bar b').textContent = `${pct.toFixed(4)}%`;
  } else $('#exp-bar b').textContent = '載入中…';
  drawPortrait();
  if (panel.name === 'char') renderPanel();
}

function drawPortrait() {
  const c = $('#portrait-canvas');
  const me = self();
  if (!c || !me) return;
  // 頭像:角色的上半身(天堂客戶端圖,沒有就用 Flare 正面;畫布 48×48,DPR 下用更高解析度)
  const px = 48 * DPR;
  if (c.width !== px) { c.width = c.height = px; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, px, px);
  if (L1S.drawFigure(g, me, px / 2, px * 1.55, px * 1.5)) return;
  if (L1S.known(me.gfx)) { setTimeout(drawPortrait, 300); return; } // 原圖還在載入
  const flare = FLARE.drawFigure(g, me, true, st.myType, px / 2, px * 1.55, px * 1.5);
  if (!flare) {
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    SPR.draw(g, SPR.creature(me, true, st.myType), 24, 46, 2.6);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (!flare || !L1S.ready() || L1S.has(me.gfx)) setTimeout(drawPortrait, 800); // 圖集還沒載入,稍後再畫
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.style.opacity = 1;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.opacity = 0), Math.max(1500, text.length * 90)); // 長句子留久一點
}

// ---------------- 聊天(頻道) ----------------
// S_ChatPacket 的 type:0 一般、2 大喊、3 全體、4 / 11 血盟、13 聯盟、14 / 11 組隊、16 密語、17 王族公告;全體頻道封包 type 9 = 密語回顯或系統訊息(protocol.js 依格式區分)
const CHANNEL_SEND = { all: 0, normal: 0, party: 11, clan: 4, world: 3, sys: 0 };
const CHANNEL_HINT = { all: '點擊輸入聊天內容', normal: '一般聊天(開頭 ! 大喊)', party: '組隊頻道', clan: '血盟頻道', world: '全體頻道', whisper: '/密 名字 內容', sys: '點擊輸入聊天內容' };
st.chatLog = [];
st.chatTab = 'normal'; // 「全」:所有頻道 + 系統訊息都顯示,送出時是一般聊天

// 密語狀態跟角色連線走,名單只接受伺服器回覆,不另存 localStorage 或自動重送切換封包。
const whisper = { lastFrom: '', lastSent: -Infinity, enabled: true, names: [], pending: null, uncertain: false, timer: 0 };
const EXCLUDE_MAX = 16;
const WHISPER_QUOTES = { '"': '"', '＂': '＂', '“': '”', '「': '」' };
const whisperNameKey = (name) => name.toLowerCase(); // 對照 L1ExcludingList.equalsIgnoreCase
function resetWhisper() {
  clearTimeout(whisper.timer);
  Object.assign(whisper, { lastFrom: '', enabled: true, names: [], pending: null, uncertain: false, timer: 0 });
  $('#chat-input').value = '';
  whisperHint(); // lastSent 保留,快速重登也不重置每秒限制
}
function whisperHint() {
  $('#chat-input').placeholder = st.chatTab === 'whisper' && whisper.lastFrom ? `回覆 ${whisper.lastFrom}` : CHANNEL_HINT[st.chatTab];
}
function selectChatTab(ch) {
  st.chatTab = ch;
  document.querySelectorAll('#chat-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.ch === ch));
  whisperHint();
  renderChat(true);
}
function whisperNotice(text) {
  log(text, 'whisper-error', 'whisper'); // 相關錯誤在每個頁籤都顯示,暫停捲動時仍有提示
  toast(text);
}
function beginWhisper(name) {
  if (!name || /[\x00-\x1f\x7f]/.test(name)) return;
  let target = name;
  if (/\s/.test(name) || WHISPER_QUOTES[name[0]]) {
    const pair = Object.entries(WHISPER_QUOTES).find(([a, b]) => !name.includes(a) && !name.includes(b));
    if (!pair) { whisperNotice('名字包含無法配對的引號,請手動輸入密語對象。'); return; }
    target = pair[0] + name + pair[1];
  }
  selectChatTab('whisper');
  $('#chat-input').value = `/密 ${target} `;
  toggleChat(true);
}
// /密、/w 的空白名字需成對引號;原版單一開頭引號仍以第一個空白分開名字與內容。
function parseWhisperInput(input, tab = st.chatTab, lastFrom = whisper.lastFrom) {
  const text = input.trim();
  const cmd = /^\/(密|w|r)(?:\s|$)/i.exec(text);
  const legacy = !!WHISPER_QUOTES[text[0]];
  if (!cmd && !legacy && (tab !== 'whisper' || text.startsWith('/'))) return null;
  const error = (message) => ({ error: message });
  if (/[\x00-\x1f\x7f]/.test(text)) return error('密語不可包含控制字元。');
  if ((cmd && cmd[1].toLowerCase() === 'r') || (!cmd && !legacy)) {
    const message = cmd ? text.slice(cmd[0].length).trim() : text;
    if (!lastFrom) return error('還沒有人密語給你,請先用 /密 名字 內容。');
    return message ? { name: lastFrom, text: message } : error('請輸入要回覆的內容。');
  }
  let rest = cmd ? text.slice(cmd[0].length).trim() : text;
  let name, message;
  const close = WHISPER_QUOTES[rest[0]];
  if (close) {
    const end = rest.indexOf(close, 1);
    if (end > 0) {
      if (!/^\s/.test(rest.slice(end + 1))) return error('名字的結尾引號後請加空白與內容。');
      name = rest.slice(1, end).trim(); message = rest.slice(end + 1).trim();
    } else if (cmd) return error('名字有空白時請用成對引號,例如 /密 "王 小明" 你好。');
    else rest = rest.slice(1); // 原版："名字 內容(不必有結尾引號)
  }
  if (name === undefined) {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
    if (m) { name = m[1]; message = m[2].trim(); }
  }
  return name && message ? { name, text: message } : error('用法：/密 名字 內容、/w 名字 內容、"名字 內容。');
}
function whisperAction(action) {
  if (!connUp()) { whisperNotice('連線中斷,密語操作未送出。'); return false; }
  try { if (send(action) !== false) return true; } catch { /* 保留輸入,不重送切換封包 */ }
  whisperNotice('密語操作未送出,請確認連線。');
  return false;
}
function sendWhisper(parsed) {
  if (parsed.error) { whisperNotice(parsed.error); return false; }
  if (whisperNameKey(parsed.name) === whisperNameKey(st.myName || '')) { whisperNotice('不能密語給自己。'); return false; }
  const now = performance.now();
  if (now - whisper.lastSent < 1000) { whisperNotice('密語每秒最多一則,請稍後再送。'); return false; }
  if (!whisperAction({ t: 'whisper', name: parsed.name, text: parsed.text })) return false;
  whisper.lastSent = now; // 只記送出的時間;聊天紀錄等成功回顯才加入
  return true;
}
function refreshWhisperSettings() {
  if (panel.name === 'settings' && panel.tab === 'whisper') renderPanel();
}
function changeExclude(name, remove) {
  name = name.trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name)) { whisperNotice('請輸入有效的斷絕對象名字。'); return false; }
  if (whisper.pending || whisper.uncertain) { whisperNotice('名單正在等待回覆或尚未同步,請勿重送;必要時重新登入角色。'); return false; }
  const exists = whisper.names.some((n) => whisperNameKey(n) === whisperNameKey(name));
  if (exists !== remove) { whisperNotice(exists ? '此名字已在斷絕名單,請使用移除按鈕。' : '此名字不在目前名單。'); return false; }
  // 原版 C_Exclude 先查 isFull 再移除:保留一格,避免送到第 16 人後無法移除。
  if (!remove && whisper.names.length >= EXCLUDE_MAX - 1) { whisperNotice(`斷絕名單已滿(${EXCLUDE_MAX - 1} 人),請先移除一人。`); return false; }
  if (!whisperAction({ t: 'exclude', name })) return false;
  whisper.pending = { name, remove };
  whisper.timer = setTimeout(() => {
    whisper.uncertain = true;
    whisperNotice('斷絕名單未收到回覆,暫停操作以免切換錯誤;請重新登入角色。');
    refreshWhisperSettings();
  }, 5000);
  refreshWhisperSettings();
  return true;
}
function onExclude(ev) {
  const names = ev.t === 'excludes' ? ev.names : [ev.name]; // 17 是複數新增,不是清空名單
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    const key = whisperNameKey(name);
    whisper.names = whisper.names.filter((n) => whisperNameKey(n) !== key);
    if (ev.excluded !== false) whisper.names.push(name);
  }
  if (ev.t === 'exclude' && whisper.pending && whisperNameKey(ev.name) === whisperNameKey(whisper.pending.name)) {
    clearTimeout(whisper.timer);
    whisper.pending = null; whisper.uncertain = false;
  }
  refreshWhisperSettings();
}
function whisperServerError(ev) {
  const who = ev.args?.[0] || '對方';
  const messages = {
    404: `密語失敗：等級需達 ${ev.args?.[0] || 5} 級才能使用密語。`,
    73: `密語失敗：${who} 不在線上。`,
    117: `密語失敗：${who} 已斷絕你的密語。`,
    205: `密語失敗：${who} 目前關閉接收密語。`,
    242: '目前被禁言,無法聊天或密語。',
    472: '斷絕名單已滿。',
  };
  if (!messages[ev.id]) return false;
  if (ev.id !== 242 && ev.id !== 472 && !(performance.now() - whisper.lastSent < 3000)) return false; // 主導 10/27:73 等也用在組隊邀請等,只有剛送出密語 3 秒內才當密語失敗
  if (ev.id === 472) {
    clearTimeout(whisper.timer); whisper.pending = null;
    if (whisper.names.length < EXCLUDE_MAX) whisper.uncertain = true; // 顯示數量與伺服器不一致,不再猜切換
    refreshWhisperSettings();
  }
  whisperNotice(messages[ev.id]);
  return true;
}
function renderWhisperSettings(body) {
  const row = el('div', 'set-row');
  row.appendChild(el('b', 'set-mid', '接收密語'));
  const toggle = el('button', 'secondary', whisper.enabled ? '開啟' : '關閉');
  toggle.type = 'button'; toggle.setAttribute('aria-pressed', String(whisper.enabled));
  toggle.onclick = () => {
    const on = !whisper.enabled;
    if (whisperAction({ t: 'whisperconfig', on })) { whisper.enabled = on; refreshWhisperSettings(); }
  };
  row.appendChild(toggle); body.appendChild(row);
  body.appendChild(el('p', 'hint', '切換立即送出;重新登入角色依伺服器預設開啟。斷絕名單依伺服器維護,不另存瀏覽器。'));
  body.appendChild(el('h4', '', `斷絕名單 ${whisper.names.length} / ${EXCLUDE_MAX - 1}`)); // 網頁上限 15(伺服器 16 滿額後無法移除,保留一格)
  const addRow = el('div', 'set-row'); addRow.style.flexWrap = 'wrap';
  const input = el('input'); input.type = 'text'; input.placeholder = '要斷絕的完整角色名字'; input.setAttribute('aria-label', '斷絕對象名字'); input.style.minWidth = '0'; input.style.flex = '1';
  const add = el('button', 'secondary', '新增'); add.type = 'button';
  add.disabled = !!whisper.pending || whisper.uncertain;
  add.onclick = () => changeExclude(input.value, false);
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add.onclick(); } };
  addRow.appendChild(input); addRow.appendChild(add); body.appendChild(addRow);
  if (whisper.pending || whisper.uncertain) body.appendChild(el('p', 'hint', whisper.uncertain ? '名單尚未同步,請重新登入角色後再操作。' : '等待伺服器確認…'));
  for (const name of whisper.names) {
    const item = el('div', 'set-row'); item.appendChild(el('span', 'set-mid', name));
    const del = el('button', 'secondary', '移除'); del.type = 'button'; del.disabled = !!whisper.pending || whisper.uncertain;
    del.onclick = () => changeExclude(name, true);
    item.appendChild(del); body.appendChild(item);
  }
}
// 不改 HTML / CSS 檔:沿用既有聊天頁籤及設定面板,直式與橫式共用。
{
  const b = el('button', '', '密'); b.type = 'button'; b.dataset.ch = 'whisper';
  $('#chat-tabs').appendChild(b);
  const style = el('style');
  style.textContent = '#chat-log .whisper{color:#ff9ee6} #chat-log .whisper-error{color:#ffb278} #chat-log .whisper[role=button]{cursor:pointer} #chat-tabs button{min-width:0}';
  document.head.appendChild(style);
}
const chatVisible = (m) => st.chatTab === 'normal' || m.ch === st.chatTab || m.cls === 'whisper-error' || (st.whisperAllTabs && m.ch === 'whisper'); // 11/18 whisperall:密語在所有分頁都看得到

function channelOf(ev) {
  if (ev.kind === 'whisper') return 'whisper';
  if (ev.global && ev.kind === 9) return 'sys';
  if (ev.kind === 3 || ev.kind === 12) return 'world';
  if (ev.kind === 4 || ev.kind === 13 || ev.kind === 17) return 'clan';
  if (ev.kind === 11 || ev.kind === 14) return 'party';
  return 'normal';
}

function log(text, cls = 'sys', ch = 'sys', peer = '', who = '') {
  st.chatLog.push({ text, cls, ch, peer, who });
  if (st.chatLog.length > 300) st.chatLog.shift();
  renderChat(false, ch, cls);
}

// 往上滑看舊訊息時暫停自動捲動(使用者 10/19):新訊息先不畫,右下角顯示「▼ N 則新訊息」;滑回最下面或點一下就恢復
const chatPause = { on: false, unseen: 0, btn: null };
const chatAtBottom = (ol) => ol.scrollHeight - ol.scrollTop - ol.clientHeight < 8;
function chatNewBtn() {
  const ol = $('#chat-log');
  if (!chatPause.btn) {
    const b = el('button', '', '');
    b.id = 'chat-new';
    b.type = 'button';
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.onclick = (e) => { e.stopPropagation(); renderChat(true); };
    ol.parentNode.appendChild(b);
    chatPause.btn = b;
  }
  const b = chatPause.btn;
  b.classList.toggle('hidden', !chatPause.on || !chatPause.unseen);
  if (!chatPause.on || !chatPause.unseen) return;
  b.textContent = `▼ ${chatPause.unseen > 99 ? '99+' : chatPause.unseen} 則新訊息`;
  // 貼在聊天框右下角(聊天框的位置由 CSS 決定,這裡跟著它)
  b.style.left = `${ol.offsetLeft + ol.offsetWidth - b.offsetWidth - 4}px`;
  b.style.top = `${ol.offsetTop + ol.offsetHeight - b.offsetHeight - 2}px`;
}
function renderChat(force = false, ch = null, cls = '') {
  const ol = $('#chat-log');
  if (chatPause.on && !force) { // 暫停中:只數目前分頁看得到的訊息(d3)
    if (!ch || chatVisible({ ch, cls })) { chatPause.unseen++; chatNewBtn(); }
    return;
  }
  chatPause.on = false;
  chatPause.unseen = 0;
  ol.innerHTML = '';
  const rows = st.chatLog.filter(chatVisible).slice(-150);
  for (const m of rows) {
    const li = el('li', m.cls, m.text);
    const who = m.ch !== 'sys' && (m.who || m.peer);
    if (who && who !== st.myName) {
      li.setAttribute('role', 'button'); li.tabIndex = 0; li.title = `開啟 ${who} 的選單`;
      li.style.touchAction = 'pan-y';
      li.style.webkitTapHighlightColor = 'transparent'; // 11/05 使用者「點下去對話框會縮一下」:手機點擊閃框關掉
      li.onmousedown = (e) => e.preventDefault(); // 點擊不搶焦點(搶焦點時手機會把這行捲進可見範圍,聊天框跳一下);鍵盤 Tab 仍可選
      let press = null;
      li.onpointerdown = (e) => { press = { x: e.clientX, y: e.clientY, at: performance.now(), moved: false }; };
      li.onpointermove = (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) press.moved = true; };
      li.onpointercancel = () => { press = null; };
      li.onclick = (e) => {
        if (e.detail && (!press || press.moved || performance.now() - press.at > 500)) return;
        if (getSelection()?.toString()) return;
        openChatPlayerMenu(who);
      };
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openChatPlayerMenu(who); } };
    }
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
  chatNewBtn();
}
$('#chat-log').addEventListener('scroll', (e) => {
  const ol = e.currentTarget;
  if (chatAtBottom(ol)) { if (chatPause.on) renderChat(true); } // 滑回最下面:補畫期間的新訊息
  else chatPause.on = true;
}, { passive: true });
addEventListener('resize', () => { if (chatPause.on) chatNewBtn(); }); // 轉向 / 聊天框大小改變:按鈕跟著重新定位(d3)

// 關機倒數:伺服器 GameServer 廣播「伺服器將在N秒內關閉」→ buff 欄下方一排紅字跑馬燈,本地每秒倒數;「已取消伺服器關機」收起
const shutdownBanner = { el: null, end: 0, timer: 0 };
function showShutdownBanner(sec) {
  if (!shutdownBanner.el) {
    const b = el('div', '');
    b.id = 'shutdown-marquee';
    b.appendChild(el('span', 'sm-text', ''));
    (document.getElementById('hud') || document.body).appendChild(b);
    shutdownBanner.el = b;
  }
  shutdownBanner.end = performance.now() + sec * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((shutdownBanner.end - performance.now()) / 1000));
    const t = left > 60 ? `${Math.ceil(left / 60)} 分鐘` : `${left} 秒`;
    shutdownBanner.el.firstChild.textContent = `⚠ 伺服器將在 ${t} 後重新啟動,請到安全的地方,角色資料會自動存檔`;
  };
  tick();
  clearInterval(shutdownBanner.timer);
  shutdownBanner.timer = setInterval(tick, 250);
  shutdownBanner.el.classList.remove('hidden');
  document.body.classList.add('sd-on');
}
function hideShutdownBanner() {
  clearInterval(shutdownBanner.timer);
  shutdownBanner.el?.classList.add('hidden');
  document.body.classList.remove('sd-on');
}
function checkShutdownNotice(text) {
  const m = /伺服器將在\s*(\d+)\s*(秒|分鐘)內關閉/.exec(text || '');
  if (m) {
    showShutdownBanner(+m[1] * (m[2] === '分鐘' ? 60 : 1));
    if (typeof auto !== 'undefined' && auto.on) { stopAuto('伺服器關機倒數'); log('伺服器即將關機,AUTO 已關閉', 'sys'); } // 10/27 使用者:倒數開始伺服器會把人送回村,但網頁 AUTO 沒關
  }
  else if (/已取消伺服器關機/.test(text || '')) hideShutdownBanner();
}

// 全服公告(伺服器 web_announce,系統訊息「【公告】」開頭):除了聊天框,也在畫面中間跳出來;點一下關掉
function showAnnounce(text) {
  let b = document.getElementById('announce-pop');
  if (!b) {
    b = el('div', '');
    b.id = 'announce-pop';
    b.appendChild(el('div', 'ap-title', '公告'));
    b.appendChild(el('div', 'ap-text', ''));
    b.onclick = () => b.classList.remove('on');
    document.body.appendChild(b);
  }
  b.lastChild.textContent = text;
  b.classList.add('on');
  clearTimeout(showAnnounce.timer);
  showAnnounce.timer = setTimeout(() => b.classList.remove('on'), Math.max(8000, text.length * 200));
}
function onChat(ev) {
  if (ev.kind === 'whisper') {
    if (ev.direction === 'in' && ev.sender) { whisper.lastFrom = ev.sender; whisperHint(); }
    log(ev.text, 'whisper', 'whisper', ev.sender || ev.recipient || '', ev.sender || ev.recipient || '');
    return; // 玩家密語內容不走系統公告 / 自訂控制訊息的判斷
  }
  if (ev.kind === 9 && ev.text === '對方正在離線掛機,看不到密語') { whisperNotice(ev.text); return; } // Java 建議 patch 的回覆也顯示於密頁籤
  const hp = /^##HIGHPET##(\d+)(?:\|(\w+)\|(.*))?$/.exec(ev.text || ''); // 高寵契約(伺服器 L1HighPet):有綁定才顯示 BUFF
  if (hp && ev.kind === 9) { setHighPet(+hp[1], hp[2] || '', hp[3] || ''); return; }
  const tg = /^##TISHAGUARD##(\d+)$/.exec(ev.text || '');
  if (tg && ev.kind === 9) { setTishaGuard(+tg[1]); return; }
  const rcd = /^##ROYALSWORDCD##(\d+)$/.exec(ev.text || '');
  if (rcd && ev.kind === 9) { confirmRoyalSwordCooldown(+rcd[1]); return; }
  const scd = /^##SKILLCD##(\d+)$/.exec(ev.text || '');
  if (scd && ev.kind === 9) { confirmSkillCooldown(+scd[1]); return; }
  const nde = /^##NODEATHEXP##(\d+)$/.exec(ev.text || ''); // 免掉%證到期時間(epoch 秒):不顯示在聊天框,畫在狀態列(setNoDeathExp)
  if (nde) { setNoDeathExp(+nde[1]); return; }
  const ndc = /^##NODEATHCD##(\d+)$/.exec(ev.text || ''); // 11/05:免掉經驗證冷卻結束時間(epoch 秒):狀態列畫變暗的同款圖示 + 分秒倒數
  if (ndc) { setNoDeathCd(+ndc[1]); return; }
  { const crj = crJson(ev.text, '##CHARRESET##'); if (crj !== undefined) { onCharReset(crj); return; } const obj = crJson(ev.text, '##ORIGBONUS##'); if (obj !== undefined) { st.origBonus = obj ? { ...obj, who: st.myName } : obj; if (panel.name === 'char') renderPanel(); return; } } // 回憶蠟燭 / 初始能力加成(不進聊天)
  { const bb = ev.kind === 9 ? crJson(ev.text, '##BOXBATCH##') : undefined; if (bb !== undefined) { onBoxBatch(bb); return; } } // BEGIN BOXBATCH / END BOXBATCH
  { const ds = ev.kind === 9 ? crJson(ev.text, '##DOLLSYNTH##') : undefined; if (ds !== undefined) { if (st.dollSynth) onDollSynth(ds); return; } }
  { const td = ev.kind === 9 ? crJson(ev.text, '##TISHADIAMOND##') : undefined; if (td !== undefined) { onTishaDiamond(td); return; } }
  { const cu = ev.kind === 9 ? crJson(ev.text, '##CATCHUP##') : undefined; if (cu !== undefined) { onCatchup(cu); return; } }
  // 血流成河:伺服器每秒送積分王位置(L1BloodArena,只給場內的人),不顯示在聊天框,畫在小地圖上(app.js drawMinimap)
  const ba = ev.kind === 9 && /^##BAANON##([\u4e00-\u9fff]{4})$/.exec(ev.text || '');
  if (ba) {
    st.arenaAlias = ba[1]; // 自己名牌保留真名,主人封包改暱稱後仍可認出自己的召喚獸。
    // 進場通知先於傳送;丟棄場外 objid 的名字／血盟,等待完整角色封包重建。
    for (const id of st.objects.keys()) if (id !== st.selfId) st.objects.delete(id);
    st.arenaKing = null;
    if (st.clickSelect) clearPicked();
    return;
  }
  const bk = /^##BAKING##(?:(\d+),(\d+),(.*))?$/.exec(ev.text || '');
  if (bk) { st.arenaKing = bk[1] ? { x: +bk[1], y: +bk[2], name: bk[3], at: performance.now() } : null; return; }
  const evm = /^##EVENT##(\w*)$/.exec(ev.text || ''); // 活動種類(伺服器進場時送):arena 血流成河、raid BOSS 戰
  if (evm) { st.eventMode = evm[1] || null; if (evm[1] === 'raid' && typeof raidEnter === 'function') raidEnter(); return; }
  checkShutdownNotice(ev.text);
  if (ev.kind === 9 && /^【公告】/.test(ev.text || '')) showAnnounce(ev.text.replace(/^【公告】/, ''));
  if (ev.kind === 9 && /^【公告】/.test(ev.text || '') && /打王|BOSS 戰|安塔瑞斯/.test(ev.text) && typeof preloadRaidBoss === 'function') preloadRaidBoss(); // 活動公告:先把 BOSS 素材背景下載好
  const ch = channelOf(ev);
  const cls = ev.kind === 2 ? 'shout' : ev.kind === 'whisper' ? 'whisper' : ch === 'world' ? 'world' : ch === 'clan' ? 'clan' : ch === 'party' ? 'party' : ch === 'sys' ? 'sys' : '';
  log(ev.text, cls, ch, '', ev.npc || ch === 'sys' ? '' : ev.who || '');
  if (ev.id && (ev.kind === 0 || ev.kind === 2)) {
    const o = st.objects.get(ev.id);
    if (o) { o.bubble = ev.text.replace(/^[^:>]+[:>]\s*/, ''); o.bubbleAt = performance.now(); }
  }
}

for (const b of document.querySelectorAll('#chat-tabs button')) {
  b.onclick = () => {
    selectChatTab(b.dataset.ch); // 換頻道一律跳到最新
  };
}

function toggleChat(open) {
  if (open === false) $('#chat-input').blur();
  else $('#chat-input').focus();
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (text) {
    const parsed = parseWhisperInput(text);
    if (parsed) { if (!sendWhisper(parsed)) return; }
    else if (/^\/(記憶|bookmark)(\s|$)/i.test(text)) { // /記憶(/bookmark):列出記憶點;/記憶 名稱:記住目前位置(同名覆蓋)
      const name = text.replace(/^\/(記憶|bookmark)/i, '').trim();
      if (name) addBookmark(name); else openBookmarkList();
    }
    else if (/^\/(裝備組?|equipset)\s*([12])$/i.test(text)) equipSetOp(2, +text.slice(-1)); // /裝備1、/裝備2(/裝備組1):套用裝備組(這個站沒開就沒反應)
    else if (/^\/(who|誰)$/i.test(text)) send({ t: 'who' }); // 線上人數(伺服器 C_Who;離線掛機的角色還在世界裡,一起算)
    else if (/^\/打王$/.test(text)) send({ t: 'home', town: 98 }); // 全服 BOSS 戰進場(伺服器 C_WebHome town 98 → L1RaidBoss.enter)
    else if (/^\/(血流成河|血戰)$/.test(text)) send({ t: 'home', town: 99 }); // 血流成河活動進場(伺服器 C_WebHome town 99 → L1BloodArena.enter)
    else if (/^\/追趕$/.test(text) && st.eventHunt?.catchup) openCatchup();
    else if (/^\/經驗獵場$/.test(text)) send({ t: 'home', town: 97 }); // 經驗獵場直接進場並扣費(伺服器 C_WebHome town 97 → L1PersonalHunt.enterEventHuntByCommand;開關 EventHuntCommandEnabled)
    else if (/^\/(稱號|title)(\s|$)/i.test(text)) titleCommand(text); // 改封號(血盟成員改自己的;盟主可以改成員的)
    else if (text.startsWith('!')) send({ t: 'chat', kind: 2, text: text.slice(1) });
    else if (st.chatTab === 'whisper') { whisperNotice('未知指令;密語請用 /密 名字 內容 或 /r 內容。'); return; }
    else send({ t: 'chat', kind: CHANNEL_SEND[st.chatTab] ?? 0, text }); // C_Chat:0 一般、3 全體、4 血盟、11 組隊
  }
  $('#chat-input').value = '';
  $('#chat-input').blur();
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#chat-input').blur();
  e.stopPropagation();
});
// 手機鍵盤:打字時瀏覽器會把整個網頁往上推(讓輸入框露出來)。改成遊戲畫面不動,
// 只有輸入列浮到鍵盤正上方:整頁往下移回瀏覽器推上去的距離(visualViewport.offsetTop),輸入列放在看得到的範圍最下面
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const input = $('#chat-input');
  const form = $('#chat-form');
  let typing = false;
  const place = () => {
    if (!typing) return;
    if (window.scrollY) window.scrollTo(0, 0);
    document.body.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    form.classList.add('kb');
    form.style.top = `${Math.round(vv.height - form.offsetHeight - 6)}px`;
    form.style.bottom = 'auto';
  };
  const reset = () => {
    typing = false;
    document.body.style.transform = '';
    form.classList.remove('kb');
    form.style.top = '';
    form.style.bottom = '';
    if (window.scrollY) window.scrollTo(0, 0);
  };
  // 11/08 三星瀏覽器:按返回鍵收鍵盤時輸入框不會失焦,聊天列停在「打字中」位置、底部補正也不會重算 → 看到鍵盤開過(可視區 < 螢幕 60%)又收起(≥ 75%)就主動失焦
  let kbSeen = false;
  const kbWatch = () => {
    if (!typing) return;
    if (vv.height < screen.height * 0.6) kbSeen = true;
    else if (kbSeen && vv.height >= screen.height * 0.75) { kbSeen = false; input.blur(); }
  };
  input.addEventListener('focus', () => { typing = true; kbSeen = false; place(); setTimeout(place, 60); setTimeout(place, 350); });
  input.addEventListener('blur', reset);
  vv.addEventListener('resize', kbWatch);
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
})();

document.addEventListener('keydown', (e) => {
  if (!st.inGame || e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter') { toggleChat(true); e.preventDefault(); }
  if (e.key === 'i' || e.key === 'I') togglePanel('inv');
  if (e.key === 'c' || e.key === 'C') togglePanel('char');
  if ((e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.altKey && !e.metaKey) togglePanel('skill'); // 10/28 使用者:K = 技能頁
  if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === 'Digit1' || e.code === 'Digit2')) { // 10/28 使用者:Shift+1 / Shift+2 = 換裝備組(同快捷欄上方「1」「2」)
    e.preventDefault();
    if (!e.repeat) { if (st.equipSets) equipSetOp(2, e.code === 'Digit1' ? 1 : 2); else toast('這裡沒有開放裝備組'); }
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= 5) useSlot(n - 1);
  if (n === 6 && !e.repeat) { if (typeof tpTag === 'function') tpTag('hotkey6'); window.__selfEvt = true; try { $('#btn-home').click(); } finally { window.__selfEvt = false; } } // 10/28 使用者:6 = 回城(同按鈕:3 秒冷卻、關 AUTO);10/30 標記自己觸發,假點擊統計不算
});

// ---------------- 面板 ----------------
const panel = { name: null, tab: null };
const PANEL_TITLES = { dailyquest: '每日任務', collection: '收藏', clan: '血盟', char: '角色', inv: '背包', skill: '技能', settings: '設定', enchant: '強化', mail: '信箱', charmarket: '角色市場', auction: '拍賣行', dutch: '鑽石拍賣', deathlog: '死亡紀錄' };

function togglePanel(name) {
  if (panel.name === name) closePanel();
  else openPanel(name);
}
function openPanel(name, tab, pickSlot = null) {
  if (panel.name === 'dailyquest' && name !== 'dailyquest') dailyQuestClose();
  if (name === 'dailyquest' && !dailyQuestUi.enabled) return;
  if (name === 'dutch' && !dutchVisible()) return;
  if (panel.name === 'dutch') { dutchStopTimers(); da.confirm = null; }
  if (name === 'inv' && typeof invResync === 'function') invResync(); // 打開背包:最多 10 秒對一次伺服器的背包(10/28)
  panel.pickSlot = pickSlot; // 點空的快捷欄打開技能頁:點魔法就放進這一格
  closeDialog();
  closeItemSheet();
  if (panel.name === 'mail' && name !== 'mail') mailOp(4); // 從信箱換到別的面板:也算關閉信箱
  panel.name = name;
  if (name === 'inv') { panel.invQuery = ''; $('#inv-search')?.remove(); }
  panel.tab = tab || { inv: 'all', settings: 'potion' }[name] || null;
  $('#panel-title').textContent = PANEL_TITLES[name];
  if (name === 'dailyquest') dailyQuestOpen();
  if (name === 'collection') collectionOpen();
  if (name === 'clan') clanOp(0); // 打開血盟面板就跟伺服器要最新資料
  if (name === 'mail') { st.mail = null; mailOp(0); }
  if (name === 'charmarket') { panel.tab = st.marketTarget || !st.charMarket ? 'mine' : 'browse'; cm.data = null; cm.detail = null; marketRead(); }
  if (name === 'dutch') { panel.tab = tab || 'sale'; da.confirm = null; da.mineAsked = false; dutchRead('snap'); }
  $('#btn-dutch')?.classList.toggle('on', name === 'dutch');
  if (name === 'auction') auctionOpen(tab);
  $('#panel').classList.remove('hidden');
  $('#btn-mail').classList.toggle('on', name === 'mail');
  $('#btn-auction').classList.toggle('on', name === 'auction');
  $('#btn-deathlog').classList.toggle('on', name === 'deathlog');
  if (name === 'deathlog') { st.deathLog = undefined; send({ t: 'deathlog' }); } // 每次打開都跟 gateway 要最新的
  document.querySelectorAll('#bottom-nav button').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  renderPanel();
}
function closePanel() {
  if (panel.name === 'dailyquest') dailyQuestClose();
  if (panel.name === 'dutch') { dutchStopTimers(); da.confirm = null; }
  $('#btn-dutch')?.classList.remove('on');
  enchantFx?.cancel();
  closeAuctionDescription();
  if (panel.name === 'mail') mailOp(4); // 關閉信箱:伺服器刪掉附件已領完的信
  $('#btn-mail').classList.remove('on');
  $('#btn-auction').classList.remove('on');
  $('#btn-deathlog').classList.remove('on');
  panel.name = null;
  panel.pickSlot = null;
  $('#panel').classList.add('hidden');
  document.querySelectorAll('#bottom-nav button').forEach((b) => b.classList.remove('on'));
}
// app.js 的 NPC 對話會呼叫:開對話框時收起背包
function toggleInv(open) {
  if (open === false) { if (panel.name === 'inv') closePanel(); } else togglePanel('inv');
}

$('#panel-close').onclick = closePanel;
for (const b of document.querySelectorAll('#bottom-nav button')) b.onclick = () => togglePanel(b.dataset.panel);

function setTabs(tabs) {
  const box = $('#panel-tabs');
  box.innerHTML = '';
  box.classList.toggle('hidden', !tabs);
  if (!tabs) return;
  for (const [key, label] of tabs) {
    const b = el('button', key === panel.tab ? 'on' : '', label);
    b.onclick = () => { panel.tab = key; renderPanel(); };
    box.appendChild(b);
  }
}

function renderPanel() {
  if (!panel.name) return;
  if (enchantFx?.active) {
    if (panel.name === 'enchant') return; // 保留送出時畫面,背包更新不打斷動畫
    enchantFx.cancel();
  }
  $('#panel').dataset.panel = panel.name;
  $('#panel').classList.toggle('da-panel', panel.name === 'dutch');
  if (panel.name !== 'inv') $('#inv-search')?.remove();
  closeAuctionDescription();
  const body = $('#panel-body');
  const foot = $('#panel-foot');
  body.innerHTML = '';
  foot.innerHTML = '';
  setTabs(null);
  ({ dailyquest: renderDailyQuest, collection: renderCollection, clan: renderClan, char: renderChar, inv: renderInvPanel, skill: renderSkillPanel, settings: renderSettings, enchant: renderEnchant, mail: renderMail, charmarket: renderCharMarket, auction: renderAuction, dutch: renderDutch, deathlog: renderDeathLog }[panel.name])(body, foot);
  // 設定面板的「登出(回到選角)」按鈕已拿掉(使用者 10/15:玩家會誤會);換角色請重新整理網頁
}


// ---- 鑽石拍賣:顯示時間可推算,成交與庫存只認伺服器快照。 ----
const da = { snap: null, offset: 0, qty: 1, confirm: null, pending: null, lastReq: null, completed: null,
  message: '', success: false, rows: null, mineAsked: false, entered: false,
  poll: null, clock: null, timeout: null, boundary: '', reads: { snap: -Infinity, mine: -Infinity } };
function dutchConnected() { return st.dutchAuction === true && st.inGame && st.ws?.readyState === 1; }
function dutchVisible() { return st.dutchAuction === true && !!da.snap?.sessions?.length; }
function dutchEntry() { $('#btn-dutch')?.classList.toggle('hidden', !dutchVisible()); }
function dutchRead(op, force = false) {
  if (!dutchConnected()) return false;
  const now = Date.now(), delay = op === 'mine' ? 2000 : 1000;
  if (!force && now - da.reads[op] < delay) return false;
  da.reads[op] = now;
  send({ t: 'dutch', op });
  return true;
}
function dutchStopTimers() {
  clearInterval(da.poll); clearInterval(da.clock); da.poll = da.clock = null;
}
function dutchReset() {
  dutchStopTimers(); clearTimeout(da.timeout); da.timeout = null;
  Object.assign(da, { snap: null, rows: null, confirm: null, pending: null, lastReq: null, completed: null,
    entered: false, mineAsked: false, qty: 1, message: '', success: false, boundary: '', reads: { snap: -Infinity, mine: -Infinity } });
  dutchEntry();
  if (panel.name === 'dutch') closePanel();
}
function dutchConfigChanged() {
  if (!st.dutchAuction) { dutchReset(); return; }
  dutchEntry();
  if (st.inGame && !da.entered && dutchRead('snap')) da.entered = true;
}
function dutchEnter() { dutchReset(); dutchConfigChanged(); }
function dutchDisconnect() {
  dutchStopTimers(); da.confirm = null;
  if (panel.name === 'dutch') renderPanel(); // 處理中的 req 保留到回覆 / 8 秒逾時。
}
function dutchResume() {
  if (!st.dutchAuction) return;
  dutchRead('snap', true); // 只重新讀狀態,不重播 buy。
  if (panel.name === 'dutch') {
    da.mineAsked = false;
    renderPanel();
  }
}
function dutchSyncTimers() {
  const active = dutchConnected() && panel.name === 'dutch' && panel.tab === 'sale';
  if (!active) { dutchStopTimers(); return; }
  if (da.poll === null) da.poll = setInterval(() => dutchRead('snap'), 3000);
  if (da.clock === null) da.clock = setInterval(dutchTick, 1000);
}
function dutchNotice(message, success = false) { da.message = message; da.success = success; }
function dutchOtpNeed() {
  clearTimeout(da.timeout); da.timeout = null; da.pending = null; da.confirm = null;
  dutchNotice('請先完成手機驗證,再重新確認購買。');
  if (panel.name === 'dutch') renderPanel();
}
function dutchApplySnap(snap) {
  if (!snap) return;
  if (snap.on === false) { st.dutchAuction = false; dutchReset(); return; }
  if (!Number.isFinite(snap.now) || (da.snap && snap.now < da.snap.now)) return; // 斷線補送的舊快照不倒轉畫面。
  if (da.snap?.cur?.id !== snap.cur?.id) { da.confirm = null; da.qty = 1; }
  da.snap = snap; da.offset = snap.now - Date.now();
  da.qty = dutchQty(da.qty);
  dutchEntry();
}
function onDutch(ev) {
  if (!st.dutchAuction || !st.inGame) return;
  const previousSid = da.snap?.cur?.id;
  if (ev.op === 'snap') dutchApplySnap(ev);
  else if (ev.op === 'mine') da.rows = Array.isArray(ev.rows) ? ev.rows : [];
  else if (ev.op === 'buy') {
    if (!ev.req || ev.req !== da.lastReq || ev.req === da.completed) return;
    da.completed = ev.req;
    clearTimeout(da.timeout); da.timeout = null; da.pending = null; da.confirm = null;
    dutchApplySnap(ev.snap);
    dutchNotice(ev.msg || '請查看我的成交確認結果', ev.ok === true);
  } else return;
  if (panel.name === 'dutch') {
    // 每三秒的快照不打斷手機輸入法;即時價格/庫存/合計仍更新,離開輸入格後重畫其他資訊。
    if (document.activeElement?.id === 'da-qty' && previousSid === da.snap?.cur?.id && panel.tab === 'sale' && da.snap?.cur?.state === 'live' && !da.pending) dutchTick();
    else renderPanel();
  }
}
const dutchNow = () => Date.now() + da.offset;
function dutchTime(ms, seconds = false) {
  const d = new Date(ms), n = (v) => String(v).padStart(2, '0');
  return `${n(d.getHours())}:${n(d.getMinutes())}${seconds ? ':' + n(d.getSeconds()) : ''}`;
}
function dutchCountdown(ms) {
  const n = Math.max(0, Math.ceil(ms / 1000));
  const pad = (v) => String(v).padStart(2, '0');
  if (n >= 3600) return `${Math.floor(n / 3600)}:${pad(Math.floor(n / 60) % 60)}:${pad(n % 60)}`; // 11/10 截圖:超過 1 小時顯示 289:40 不好讀 → 4:49:40
  return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
}
function dutchPrice(c, now = dutchNow()) {
  if (c.state !== 'live' || now < c.start || !(c.stepMs > 0)) return c.price;
  return Math.max(c.floorPrice, c.startPrice - Math.max(0, Math.floor((now - c.start) / c.stepMs)) * c.step);
}
function dutchQty(v) {
  const max = Math.max(1, da.snap?.cur?.remaining || 1), n = Number(v);
  return Math.min(max, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1));
}
function dutchAffordable() {
  const c = da.snap?.cur, price = c && dutchPrice(c);
  return c && price > 0 ? Math.max(0, Math.min(c.remaining, Math.floor(da.snap.gold / price))) : 0;
}
function dutchCanBuy() {
  const c = da.snap?.cur;
  return dutchConnected() && c?.state === 'live' && c.remaining > 0 && dutchNow() < c.end
    && (st.me?.level ?? 1) >= (da.snap.minLevel || 20) && !da.pending;
}
function dutchBuy() {
  const c = da.confirm;
  if (!c || !dutchCanBuy() || c.sid !== da.snap?.cur?.id) return;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const req = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  da.pending = { ...c, req }; da.lastReq = req; da.confirm = null;
  dutchNotice('處理中…');
  da.timeout = setTimeout(() => {
    if (da.pending?.req !== req) return;
    da.pending = null; da.timeout = null;
    dutchNotice('還沒收到結果,請看「我的成交」確認');
    if (panel.name === 'dutch') renderPanel();
  }, 8000);
  try {
    if (send({ t: 'dutch', op: 'buy', sid: c.sid, qty: c.qty, max: c.max, req }) === false) {
      clearTimeout(da.timeout); da.timeout = null; da.pending = null;
      dutchNotice('連線已中斷,請看「我的成交」確認');
    }
  } catch {
    clearTimeout(da.timeout); da.timeout = null; da.pending = null;
    dutchNotice('連線已中斷,請看「我的成交」確認');
  }
  renderPanel();
}
function dutchBar(cls, id) {
  const bar = el('div', 'da-bar' + (cls ? ' ' + cls : '')), fill = el('i');
  if (id) fill.id = id;
  bar.append(fill); return bar;
}
function dutchTick() {
  if (!dutchConnected()) dutchStopTimers();
  if (panel.name !== 'dutch' || panel.tab !== 'sale') return;
  const c = da.snap?.cur;
  if (!c) return;
  const now = dutchNow(), price = dutchPrice(c, now);
  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const width = (id, value) => { const node = document.getElementById(id); if (node) node.style.width = `${Math.max(0, Math.min(100, value))}%`; };
  text('da-pre-count', dutchCountdown(c.start - now));
  text('da-price', fmt(price));
  const gold = $('#panel-foot .gold'); if (gold) gold.textContent = fmt(da.snap.gold);
  text('da-stock', c.remaining); text('da-stock-land', c.remaining);
  width('da-stock-fill', c.remaining / c.stock * 100);
  const nextAt = c.state === 'live' && price > c.floorPrice ? c.start + (Math.floor((now - c.start) / c.stepMs) + 1) * c.stepMs : 0;
  text('da-next-label', now >= c.end ? '等待結算' : nextAt ? '下次降價' : '已到底價');
  text('da-count', nextAt ? dutchCountdown(nextAt - now) : `${dutchTime(c.end)} 結束`);
  text('da-next-price', nextAt ? `→ ${fmt(Math.max(c.floorPrice, price - c.step))}` : '');
  width('da-step-fill', nextAt ? (now - (nextAt - c.stepMs)) / c.stepMs * 100 : 100);
  text('da-total', fmt(price * da.qty));
  text('da-afford', `身上金幣最多可買 ${fmt(dutchAffordable())} 顆`);
  const button = document.getElementById('da-buy-button');
  if (button) {
    button.disabled = !dutchCanBuy();
    button.classList.toggle('da-ineligible', (st.me?.level ?? 1) < (da.snap.minLevel || 20));
    button.textContent = da.pending ? '處理中…' : (st.me?.level ?? 1) < (da.snap.minLevel || 20) ? '20 級以上才能購買' : !dutchConnected() ? '連線中斷' : da.confirm ? '確定購買' : '購買';
  }
  const input = document.getElementById('da-qty');
  if (input) { input.max = String(Math.max(1, c.remaining)); if (document.activeElement !== input) input.value = da.qty; }
  // 每個跨越點只觸發一次;跳頁/背景恢復跨多階也立即要新快照。
  const due = c.state === 'pre' && now >= c.start ? c.start
    : c.state === 'live' && now >= c.end ? c.end
    : c.state === 'live' && c.nextAt > 0 && now >= c.nextAt ? c.nextAt : 0;
  const key = `${c.id}:${due}`;
  if (due && da.boundary !== key) { da.boundary = key; dutchRead('snap', true); }
}
function renderDutch(body, foot) {
  if (!st.dutchAuction) { dutchStopTimers(); body.append(el('p', 'da-message', '活動目前沒有開放')); return; }
  setTabs([['sale', '拍賣'], ['table', '價格表'], ['mine', '我的成交']]);
  for (const [i, key] of ['sale', 'table', 'mine'].entries()) {
    $('#panel-tabs').children[i].onclick = () => {
      panel.tab = key; da.confirm = null;
      if (key === 'mine') da.mineAsked = false;
      if (key === 'sale') dutchRead('snap');
      renderPanel();
    };
  }
  dutchSyncTimers();
  const notice = () => { if (da.message && !da.pending) body.append(el('p', `da-message${da.success ? ' da-success' : ''}`, da.message)); };
  if (da.snap) {
    const cap = el('span', 'cap', '金幣 '); cap.append(el('span', 'gold', fmt(da.snap.gold))); foot.append(cap);
  }
  if (panel.tab === 'mine') {
    notice();
    if (!da.mineAsked && dutchRead('mine')) { da.mineAsked = true; da.rows = null; }
    if (da.rows === null) body.append(el('p', 'da-note', '讀取中…'));
    else if (!da.rows.length) body.append(el('p', 'da-note', '還沒有成交紀錄'));
    else for (const [time, no, price, qty, total, name] of da.rows) {
      const row = el('div', 'da-order');
      row.append(el('div', '', `${dutchTime(time, true)} · 第 ${no} 場 · ${name}`), el('div', 'da-order-price', `每顆 ${fmt(price)} × ${fmt(qty)} 顆　合計 ${fmt(total)}`));
      body.append(row);
    }
    foot.append(clanBtn('重新整理', 'clan-btn', () => { if (dutchRead('mine')) { da.rows = null; da.mineAsked = true; renderPanel(); } }));
    return;
  }
  const c = da.snap?.cur;
  if (!c) { body.append(el('p', 'da-note', da.snap ? '目前沒有拍賣場次' : '讀取中…')); return; }
  if (panel.tab === 'table') { renderDutchTable(body, c); return; }
  const head = el('div', 'da-head' + (da.confirm ? ' da-head-confirm' : '')), icon = da.icon || (da.icon = iconCanvas({ kind: 'inv', gfx: 237, name: '品質鑽石' }, 40));
  icon.classList.add('da-icon');
  icon.style.width = icon.style.height = ''; // 讓 da- CSS 在橫式縮成 30px,不受 helper 的 inline 40px 蓋過。
  const name = el('div', 'da-name'), small = el('small');
  name.append(el('b', '', '品質鑽石'), small);
  small.append(el('span', 'da-p', `第 ${c.no} 場 ${dutchTime(c.start)} 開賣 · 共 ${c.stock} 顆`));
  const land = el('span', 'da-l', `第 ${c.no} 場 · 剩餘 `), left = el('b', '', c.remaining); left.id = 'da-stock-land';
  land.append(left, ` / ${c.stock} 顆`); small.append(land);
  const label = { pre: '尚未開始', live: '進行中', sold: '已售完', ended: '已結束', stopped: '目前暫停購買' }[c.state] || '';
  head.append(icon, name, el('span', `da-tag ${c.state === 'live' ? 'da-live' : 'da-end'}`, label)); body.append(head);
  if (c.state === 'pre') {
    const box = el('div', 'da-big'), countdown = el('b'); countdown.id = 'da-pre-count';
    box.append(el('small', '', '距離開賣'), countdown, el('span', '', `${dutchTime(c.start)} 開場`)); body.append(box);
    body.append(el('p', 'da-note', `每顆 ${fmt(c.startPrice)} 起,每 ${c.stepMs / 60000} 分鐘降 ${fmt(c.step)},最低 ${fmt(c.floorPrice)}。`));
  } else if (c.state === 'live') renderDutchLive(body, c);
  else {
    const box = el('div', 'da-big'); box.append(el('small', '', label), el('b', '', c.lastPrice ? fmt(c.lastPrice) : '沒有成交'), el('span', '', '最後成交價 / 顆')); body.append(box);
    body.append(el('p', 'da-note', `你這一場買到 ${fmt(da.snap.mine?.qty || 0)} 顆,共花 ${fmt(da.snap.mine?.total || 0)} 金幣。`));
    if (da.snap.next) body.append(el('p', 'da-note', `下一場:第 ${da.snap.next.no} 場 ${dutchTime(da.snap.next.start)} 開賣`));
  }
  notice();
  if (c.state !== 'pre') {
    body.append(el('div', 'da-sub', '最近成交'));
    for (const [time, price, qty] of da.snap.log || []) {
      const row = el('div', 'da-log'); row.append(el('span', 'da-time', dutchTime(time, true)), el('span', 'da-log-price', fmt(price)), el('span', '', `× ${qty}`)); body.append(row);
    }
  }
  dutchTick();
}
function renderDutchLive(body, c) {
  const main = el('div', 'da-main' + (da.confirm ? ' da-main-confirm' : '')), price = el('div', 'da-price'), value = el('b'); value.id = 'da-price';
  price.append(el('small', '', '現在每顆'), value);
  const next = el('div', 'da-next'), label = el('small'), count = el('b'), nextPrice = el('span');
  label.id = 'da-next-label'; count.id = 'da-count'; nextPrice.id = 'da-next-price'; next.append(label, count, nextPrice);
  main.append(price, next, dutchBar('', 'da-step-fill')); body.append(main);
  const stock = el('div', 'da-stock', '剩餘 '), remaining = el('b', '', c.remaining); remaining.id = 'da-stock';
  stock.append(remaining, ` / ${c.stock} 顆`, dutchBar('', 'da-stock-fill')); body.append(stock);
  const buy = el('div', 'clan-row da-buy');
  if (da.confirm) {
    const confirm = el('div', 'da-confirm'), txt = el('div', 'da-txt');
    txt.append('用每顆 ', el('b', '', fmt(da.confirm.max)), ' 買 ', el('b', '', da.confirm.qty), ' 顆,合計 ', el('b', '', fmt(da.confirm.max * da.confirm.qty)), ' 金幣。', el('br'), '送出後如果剛好降價,照較低的價扣。');
    const actions = el('div', 'da-act'), yes = clanBtn('確定購買', 'clan-btn on da-go', dutchBuy); yes.id = 'da-buy-button';
    actions.append(clanBtn('取消', 'clan-btn', () => { da.confirm = null; renderPanel(); }), yes); confirm.append(txt, actions); buy.append(confirm);
  } else {
    const quantity = el('div', 'da-qty'), input = el('input', 'da-number');
    input.id = 'da-qty'; input.type = 'number'; input.inputMode = 'numeric'; input.min = '1'; input.max = String(c.remaining); input.step = '1'; input.value = da.qty; input.setAttribute('aria-label', '購買顆數');
    input.oninput = () => { da.qty = dutchQty(input.value); if (input.value !== '') input.value = da.qty; dutchTick(); };
    input.onblur = () => { da.qty = dutchQty(input.value); input.value = da.qty; dutchTick(); };
    const change = (n) => { da.qty = dutchQty(n); input.value = da.qty; dutchTick(); };
    const minus = clanBtn('−', 'clan-btn da-step', () => change(da.qty - 1)), plus = clanBtn('＋', 'clan-btn da-step', () => change(da.qty + 1));
    quantity.append(el('span', 'da-lbl', '數量'), minus, input, plus, clanBtn('最多', 'clan-btn', () => change(Math.max(1, dutchAffordable()))));
    const total = el('span', 'da-total', '合計'), amount = el('b'); amount.id = 'da-total'; total.append(amount);
    const go = clanBtn('購買', 'clan-btn on da-go', () => {
      if (!dutchCanBuy()) return;
      da.confirm = { sid: c.id, qty: dutchQty(da.qty), max: dutchPrice(da.snap.cur) };
      dutchNotice(''); renderPanel();
    }); go.id = 'da-buy-button';
    for (const control of quantity.querySelectorAll('button, input')) control.disabled = !!da.pending;
    buy.append(quantity, total, go);
  }
  body.append(buy);
  const hint = el('p', 'da-note da-afford'); hint.id = 'da-afford'; body.append(hint);
}
function renderDutchTable(body, c) {
  const wrap = el('div', 'da-table-wrap'), table = el('table', 'da-tbl'), head = el('tr'), thead = el('thead'), tbody = el('tbody');
  for (const s of da.snap.sessions) head.append(el('th', '', `第 ${s.no} 場`)); head.append(el('th', '', '每顆金幣')); thead.append(head);
  const steps = c.step > 0 ? Math.floor((c.startPrice - c.floorPrice) / c.step) : 0, now = dutchNow();
  for (let i = 0; i <= steps; i++) {
    const tr = el('tr');
    for (const s of da.snap.sessions) {
      const at = s.start + i * c.stepMs, until = i === steps ? s.end : at + c.stepMs;
      const active = s.state === 'live' && now >= at && now < until;
      const cell = el('td', active ? 'da-now' : now >= until ? 'da-past' : '', dutchTime(at) + (active ? ' ◀ 現在' : ''));
      tr.append(cell);
    }
    tr.append(el('td', 'da-table-price', fmt(c.startPrice - i * c.step))); tbody.append(tr);
  }
  table.append(thead, tbody); wrap.append(table); body.append(wrap);
  body.append(el('p', 'da-note', `每 ${c.stepMs / 60000} 分鐘降 ${fmt(c.step)},到底價後賣到該場結束。`));
}
$('#btn-dutch').onclick = () => { if (dutchVisible()) togglePanel('dutch'); };
// ---- 鑽石拍賣結束 ----

// ---- Single-character market; server supplies every price/version/snapshot. ----
const cm = { data: null, detail: null, cursor: 0, pages: [], pending: null, message: '', draft: null };
const marketKey = () => crypto.randomUUID().replaceAll('-', '');
const marketSend = (op, id = 0, version = 0, price = 0, key = '', epoch) => send({ t: 'charmarket', op, id, version, price, key, ...(epoch === undefined ? {} : { epoch }) });
// BEGIN T5 MARKET UI
function marketRosterRead() {
  send({ t: 'rosterget', key: cm.request?.key || '' });
}
function marketRosterStatus(status) {
  if (!status || !cm.request || status.key !== cm.request.key) return;
  cm.request.phase = status.phase;
  if (status.phase === 'FINAL') {
    cm.message = status.result || '此操作已完成，已重新整理角色與訂單狀態。';
    cm.pending = null; cm.request = null; cm.draft = null; cm.detail = null;
    if (st.inGame && panel.name === 'charmarket') marketRead();
  } else if (status.phase === 'REVIEW') cm.message = '交易待查核，請勿再次付款。';
  else if (status.phase === 'PENDING') cm.message = '交割處理中，請勿再次付款。';
  else cm.message = '尚未確認操作結果，請查詢原請求與訂單狀態；請勿再次付款。';
}
function marketDisconnect() {
  if (!rosterActive()) return;
  st.roster = null; st.rosterError = true;
  if (cm.request) cm.request.phase = 'UNKNOWN';
}
function marketResume() {
  if (!rosterActive() && !cm.request) return;
  marketRosterRead();
  if (st.inGame && panel.name === 'charmarket') marketRead();
}
function marketSubmit(args) {
  if (cm.pending || !st.roster || st.rosterError) return;
  const key = args[4].split('|')[0];
  cm.pending = args;
  cm.request = { key, epoch: st.roster.epoch, actor: st.myName, account: st.account, phase: 'SENT' };
  marketSend(...args, args[0] === 3 ? undefined : cm.request.epoch);
  const request = cm.request;
  setTimeout(() => {
    if (cm.request !== request) return;
    cm.request.phase = 'UNKNOWN';
    marketRosterRead(); // Lost reply with a live socket: query only, never reissue payment.
    if (panel.name === 'charmarket') renderPanel();
  }, 12000);
  renderPanel();
}
function marketRetry() {
  if (!cm.request) { if (cm.pending) marketSend(...cm.pending); return; }
  // A payment is never resent, including an explicit click. Reads keep the original key.
  marketRosterRead(); marketRead();
}
function marketReplay() {
  if (!cm.pending || !cm.request || cm.pending[0] === 4 || cm.request.account !== st.account || cm.request.actor !== st.myName ||
      !['UNKNOWN', 'RETRY'].includes(cm.request.phase)) return;
  cm.request.phase = 'SENT_REPLAY';
  marketSend(...cm.pending, cm.pending[0] === 3 ? undefined : cm.request.epoch);
}
function marketCanBuy() {
  return !!st.roster?.canBuy && !st.rosterError && (!cm.detail || (cm.orderMode?.id === cm.detail.id &&
    (cm.orderMode.mode === 1 || (cm.orderMode.mode === 0 && st.roster.total < st.roster.capacity))));
}
function marketBuyNotice(r = st.roster) {
  if (cm.detail && cm.orderMode?.id !== cm.detail.id) return '正在確認訂單適用的角色名額，請稍候或重新整理。';
  if (cm.detail && ![0, 1].includes(cm.orderMode?.mode)) return '訂單已變動，請重新整理市場列表。';
  if (cm.detail && cm.orderMode?.mode === 0 && r && r.total >= r.capacity) return '這是舊制訂單，帳號全部持有角色須少於可玩位置才能購買；上架、鎖定與待刪除都會計入。';
  if (!r) return '角色清單尚未確認，請重新整理後再購買。';
  if (!r.canBuy) return r.pending ? '交易處理中或待查核，請勿重複付款。' :
    r.total >= r.capacity + 1 ? `已持有 ${r.total} 隻角色（可玩位置 ${r.capacity} ＋ 1），不能再購買；上架、鎖定與待刪除都計入持有數。` :
    '目前不能購買：角色容量已滿、替換功能暫停或資料待整理，請先處理後再購買。';
  return r.incoming === 'K' ? `你的 ${r.capacity} 個位置都滿了，買到的角色會先鎖定，要等你上架其中一隻角色後才能使用。鎖定期間不能登入或使用資產。` : '買到的角色完成交割後可使用，請重新整理選角清單。';
}
function marketListNotice(id) {
  const r = st.roster, c = r?.characters.find(c => c.id === id);
  const k = r?.characters.find(c => c.state === 'K' && c.id !== id && !c.deleting);
  return `確定上架「${c?.name || ''}」？` + (k ? `上架後，鎖定中的「${k.name}」會接手這個位置。` : '') +
    '上架後不能使用或修改角色、不能改價。取消或到期時，若位置已滿，角色會鎖定。';
}
function marketCancelNotice(r) {
  const roster = st.roster;
  return `確定停止出售「${r.name}」？` + (roster?.playable < roster?.capacity ? '取消後有空位，角色會恢復使用。' : '取消後沒有空位，角色會鎖定。') +
    (Number.isInteger(roster?.cancelRelistHours) ? `取消後 ${roster.cancelRelistHours} 小時內這個帳號不能再上架任何角色` : '取消後這個帳號會進入再次上架冷卻') + '；自然到期不新增這項冷卻。';
}
function marketConfirm(text, run) { cm.confirm = { text, run, epoch: st.roster?.epoch }; renderPanel(); }
function renderMarketConfirm(body, foot) {
  const box = el('section', 'roster-confirm'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', '確認角色市場操作');
  box.append(el('h3', '', '請確認角色狀態'), el('p', '', cm.confirm.text));
  const { run, epoch } = cm.confirm;
  box.append(clanBtn('返回', 'clan-btn', () => { cm.confirm = null; renderPanel(); }),
    clanBtn('確認', 'clan-btn on', () => { cm.confirm = null; if (!st.roster || st.rosterError || st.roster.epoch !== epoch) { cm.message = '角色清單已變動，請重新整理並再次確認'; marketRosterRead(); renderPanel(); return; } run(); }));
  body.append(box);
}
// END T5 MARKET UI

function marketRead() {
  if (rosterActive() || cm.request) marketRosterRead();
  cm.data = null;
  marketSend(panel.tab === 'mine' ? 1 : 0, panel.tab === 'mine' ? 0 : cm.cursor);
}
function onCharMarket(ev) {
  if (typeof ev.enabled === 'boolean') st.charMarket = ev.enabled;
  if (ev.recovery) st.charMarketRecovery = true;
  if (!st.charMarket && panel.name === 'charmarket') { panel.tab = 'mine'; cm.detail = null; }
  if (ev.tab === 'result') {
    cm.message = ev.msg || '';
    toast(cm.message);
    if (cm.request && !ev.ok) {
      if (ev.notSent && ev.requestKey === cm.request.key && cm.request.phase === 'SENT' && !ev.retryable) { cm.pending = null; cm.request = null; }
      else { cm.request.phase = ev.notSent ? 'RETRY' : 'UNKNOWN'; marketRosterRead(); }
      if (/清單|版本|重新整理/.test(cm.message)) cm.message += '；請重新整理頁面，確認最新角色狀態。';
    } else if (!ev.ok && ev.retryable === false) cm.pending = null;
    if (ev.ok) {
      if (cm.request && cm.pending?.[0] === 4) { cm.request.phase = 'UNKNOWN'; marketRosterRead(); } // ok may still mean PAYOUT_PENDING.
      else { cm.request = null; cm.pending = null; }
      cm.draft = null; cm.detail = null; invResync(true);
    }
    if (!st.charMarket) { panel.tab = 'mine'; cm.detail = null; }
    if (ev.ok && panel.name === 'charmarket') marketRead();
  } else if (ev.tab === 'detail') {
    cm.detail = ev.rows?.[0] || null;
    if (rosterActive()) { cm.orderMode = null; marketRosterRead(); }
    if (!cm.detail) cm.message = '商品已失效，請重新整理';
  } else if (ev.rows) {
    cm.data = ev;
    if (ev.tab === 'mine') st.charMarketRecovery = ev.rows.some((r) => r.state === 'LISTED' || (rosterActive() && ['DEBIT_PENDING', 'PAYOUT_PENDING', 'REVIEW_REQUIRED'].includes(r.state))) || (rosterActive() && !!st.roster?.pending);
  }
  $('#btn-charmarket').classList.toggle('hidden', !st.charMarket && !st.charMarketRecovery);
  $('#btn-charmarket').setAttribute('aria-label', st.charMarket ? '角色市場' : '角色市場訂單下架');
  if (panel.name === 'charmarket') renderPanel();
}
function marketFeeText(q) {
  if (!q?.valid) return q?.msg || '費用資料尚未載入';
  if (q.v === 2) return `手續費 ${q.flat.toLocaleString()} 金幣（買方支付）`; // 11/08 使用者:只顯示手續費
  const terms = q.legacy ? '歷史訂單費額' : `固定費 ${q.flat.toLocaleString()} ＋ 抽成 ${q.rate}%（${q.percentage.toLocaleString()}）`;
  return `${terms}；總費用 ${q.total.toLocaleString()}，賣方實收 ${q.net.toLocaleString()} 金幣（從標價內扣）`;
}
// ---- 11/07 角色市場 UI(使用者 23:1x「點開應該要顯示 職業 等級 數值 甚至是魔法 裝備等等」):列表卡片 + 詳情四分頁 ----
// 伺服器快照(L1CharMarket.candidate):能力值 / HP / MP 是角色本身(不含裝備),AC 是最後下線時;items 有 useType(裝備部位);列表每列有 sum 摘要。
// 紙娃娃 / 能力 / 魔法格重用人物頁、技能頁的樣式(char-grid、char-stats、skill-group);外面包 .cmui-doll,電腦版 land.js 才不會當成自己的人物頁重排。
const CMUI_CLS = ['王族', '騎士', '妖精', '法師', '黑暗妖精', '龍騎士', '幻術師'];
const CMUI_ATTR = ['', '地', '火', '水', '風'];
const cmui = { cls: -1, sort: 'new', tab: 'equip' };
const cmuiN = (n) => Number(n || 0).toLocaleString();
const cmuiItemName = (it) => `${it.enchant ? (it.enchant > 0 ? '+' : '') + it.enchant + ' ' : ''}${it.name}${it.attr ? `(${CMUI_ATTR[it.attr] || ''}${it.attrLevel || ''})` : ''}`;
const cmuiDays = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T').replace(/\.0$/, '')); return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 86400000)) : null; };
const cmuiIcon = (it, px) => iconCanvas({ name: it.name, bless: it.bless, item: it.item, gfx: it.gfx }, px); // 11/08 快照帶 gfx(invgfx)才對得到自訂道具圖;舊快照沒有就照名稱
const cmuiWeapon = (s) => (s && s.wpnName ? { name: s.wpnName, enchant: s.wpnEnchant | 0, bless: s.wpnBless, item: s.wpnItem } : null);
// 角色人像:跟人物頁一樣用遊戲精靈圖;anim = 播待機動畫(詳情),列表只畫一格。面板關掉就停
function cmuiFigure(o, type, w, h, foot, height, anim) {
  const c = el('canvas', 'cmui-fig');
  c.width = w * DPR; c.height = h * DPR; c.style.width = `${w}px`; c.style.height = `${h}px`;
  const g = c.getContext('2d'); g.scale(DPR, DPR);
  if (!o || o.gfx == null) return c;
  let drawn = false, key = '';
  const loop = (now) => {
    if ((drawn && !c.isConnected) || panel.name !== 'charmarket') return;
    const k = String(Math.floor(now / 40));
    if (k !== key) {
      key = k;
      const fig = { gfx: o.gfx, skin: o.skin || 0, kind: o.kind, weapon: o.weapon || 0, heading: 5, x: 0, y: 0 };
      g.clearRect(0, 0, w, h);
      drawn = L1S.drawFigure(g, fig, w / 2, foot, height, anim ? performance.now() : null)
        || (!L1S.known(o.gfx) && FLARE.drawFigure(g, fig, true, type, w / 2, foot, height)) || drawn;
      if (drawn && !anim) return; // 列表:畫到一次就停
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return c;
}
function cmuiPills(s) {
  const p = el('div', 'cmui-pills');
  p.append(el('span', 'hp', `HP ${cmuiN(s.hp)}`), el('span', 'mp', `MP ${cmuiN(s.mp)}`), el('span', 'ac', `AC ${s.ac ?? '-'}`));
  return p;
}
function cmuiCard(r, onClick) {
  const s = r.sum || {};
  const card = el('button', 'cmui-card'); card.type = 'button';
  const pic = el('div', 'cmui-pic'); pic.appendChild(cmuiFigure(r.sum, r.type, 64, 78, 70, 58, false));
  const mid = el('div', 'cmui-mid');
  mid.appendChild(el('div', 'cmui-name', r.name));
  mid.appendChild(el('div', 'cmui-cls', `${r.level != null ? `Lv.${r.level}　` : ''}${CMUI_CLS[r.type] ?? ''}${r.sum ? `　${s.sex ? '女' : '男'}` : ''}`));
  if (r.sum) {
    mid.appendChild(cmuiPills(s));
    const wl = el('div', 'cmui-wpn'), w = cmuiWeapon(s);
    if (w) { wl.appendChild(cmuiIcon(w, 20)); wl.appendChild(el('span', '', cmuiItemName(w))); } else wl.appendChild(el('span', 'dim', '未裝備武器'));
    wl.appendChild(el('small', 'dim', `魔法 ${s.skills ?? 0}`));
    mid.appendChild(wl);
  }
  const right = el('div', 'cmui-price');
  if (r.price > 0) right.append(el('b', '', cmuiN(r.price)), el('small', '', '金幣')); else right.append(el('b', '', '未標價'));
  if (r.private) right.appendChild(el('small', '', '🔒 指定買家'));
  const d = cmuiDays(r.expires); if (d != null && r.state === 'LISTED') right.appendChild(el('small', 'dim', `剩 ${d} 天`));
  card.append(pic, mid, right);
  if (onClick) card.onclick = onClick; else card.disabled = true;
  return card;
}
// 市場列表:職業篩選 + 排序(這一頁內)
function cmuiList(body, rows) {
  const bar = el('div', 'cmui-bar'), chips = el('div', 'cmui-chips');
  [[-1, '全部'], [0, '王族'], [1, '騎士'], [2, '妖精'], [3, '法師']].forEach(([i, n]) => {
    const b = el('button', `cmui-chip${cmui.cls === i ? ' on' : ''}`, n); b.type = 'button';
    b.onclick = () => { cmui.cls = i; renderPanel(); };
    chips.appendChild(b);
  });
  const sort = el('select', 'cmui-sort');
  for (const [v, t] of [['new', '最新上架'], ['priceAsc', '價格低→高'], ['priceDesc', '價格高→低'], ['level', '等級高→低']]) { const o = el('option', '', t); o.value = v; sort.appendChild(o); }
  sort.value = cmui.sort; sort.onchange = () => { cmui.sort = sort.value; renderPanel(); };
  bar.append(chips, sort);
  body.appendChild(bar);
  const by = { new: (a, b) => b.id - a.id, priceAsc: (a, b) => a.price - b.price, priceDesc: (a, b) => b.price - a.price, level: (a, b) => (b.level | 0) - (a.level | 0) }[cmui.sort];
  const list = rows.filter((r) => cmui.cls < 0 || r.type === cmui.cls).sort(by);
  if (rows.length && !list.length) body.appendChild(el('p', 'cm-notice', '這個職業目前沒有角色上架'));
  for (const r of list) body.appendChild(cmuiCard(r, () => { cmui.tab = 'equip'; marketSend(5, r.id); }));
}
// 11/08 輸入 8 位數訂單編號(賣方設了密碼的角色只能這樣找到)
function cmuiCodeBox(body) {
  const box = el('div', 'cmui-codebox'), input = el('input');
  input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 8; input.placeholder = '輸入 8 位數訂單編號'; input.autocomplete = 'off';
  input.oninput = () => { input.value = input.value.replace(/\D/g, '').slice(0, 8); };
  const go = clanBtn('查詢', 'clan-btn', () => {
    if (!/^\d{8}$/.test(input.value)) { toast('訂單編號是 8 位數字'); return; }
    cmui.tab = 'equip'; marketSend(6, 0, 0, 0, input.value);
  });
  box.append(input, go);
  body.appendChild(box);
}
// 我的訂單:同樣的卡片 + 狀態 / 費用 / 下架
function cmuiMine(body, r) {
  const box = el('div', 'cmui-mine');
  box.appendChild(cmuiCard(r, null));
  const STATE = { LISTED: '上架中', COMMITTED: '已成交', CANCELLED: '已下架', EXPIRED: '已到期', REFUNDED: '已退款', DEBIT_PENDING: '付款處理中', PAYOUT_PENDING: '撥款處理中', REVIEW_REQUIRED: '等待管理員核對' };
  const line = el('div', 'cmui-mineline');
  line.appendChild(el('span', '', `${r.code ? `訂單編號 ${r.code}` : `#${r.id}`}${r.private ? '（密碼）' : ''}　${STATE[r.state] || r.state}`)); // 11/08 訂單編號
  if (r.state === 'LISTED') line.appendChild(clanBtn('下架', 'clan-btn danger', () => {
    if (!rosterActive()) { marketSend(3, r.id); return; }
    if (!st.roster || cm.pending || st.rosterError) return;
    marketConfirm(marketCancelNotice(r), () => marketSubmit([3, r.id, 0, 0, marketKey()]));
  }));
  box.appendChild(line);
  if (r.fees) box.appendChild(el('small', 'cm-notice', marketFeeText(r.fees)));
  body.appendChild(box);
}
// 詳情:人像 + 基本資料 + 分頁(裝備 / 能力 / 魔法 / 背包)+ 購買確認
function cmuiDetail(body, foot, r) {
  const s = r.snapshot || {};
  const items = Array.isArray(s.items) ? s.items : [];
  const back = el('button', 'cmui-back', '‹ 返回列表'); back.type = 'button'; back.onclick = () => { cm.detail = null; renderPanel(); };
  body.appendChild(back);
  const head = el('div', 'cmui-head');
  head.appendChild(cmuiFigure(s, s.type, 92, 104, 96, 80, true));
  const info = el('div', 'cmui-info');
  info.appendChild(el('div', 'cmui-name big', s.name || r.name));
  info.appendChild(el('div', 'cmui-cls', `Lv.${s.level}　${CMUI_CLS[s.type] ?? ''}${s.sex != null ? `　${s.sex ? '女' : '男'}` : ''}`));
  const t = st.game.expTable || []; const lo = t[s.level - 1] ?? 0, hi = t[s.level];
  if (hi && s.exp != null) info.appendChild(el('div', 'cmui-exp', `經驗 ${Math.max(0, Math.min(99.99, (s.exp - lo) * 100 / (hi - lo))).toFixed(2)}%`));
  if (s.hp != null) info.appendChild(cmuiPills(s));
  const price = el('div', 'cmui-pricebox');
  if (r.price > 0) price.append(el('b', '', cmuiN(r.price)), el('small', '', ' 金幣')); else price.append(el('b', '', '未標價'));
  info.appendChild(price);
  if (r.private) info.appendChild(el('div', 'cmui-cls', '🔒 指定買家：需要賣方給的 6 位數密碼'));
  head.appendChild(info);
  body.appendChild(head);
  const bag = items.filter((it) => !it.equipped);
  const tabs = el('div', 'cmui-tabs');
  for (const [k, n] of [['equip', '裝備'], ['stats', '能力'], ['skills', `魔法 ${s.skills ?? 0}`], ['bag', `背包 ${bag.length}`]]) {
    const b = el('button', `cmui-tab${cmui.tab === k ? ' on' : ''}`, n); b.type = 'button';
    b.onclick = () => { cmui.tab = k; renderPanel(); };
    tabs.appendChild(b);
  }
  body.appendChild(tabs);
  ({ equip: cmuiTabEquip, stats: cmuiTabStats, skills: cmuiTabSkills, bag: cmuiTabBag })[cmui.tab](body, s, items, bag);
  const pay = Number(r.pay ?? r.price), fee = r.fees?.v === 2 ? r.fees.flat : 0;
  body.appendChild(el('p', 'cm-notice', fee ? `手續費 ${cmuiN(fee)} 金幣（買方支付）。${r.price > 0 ? `合計支付 ${cmuiN(pay)} 金幣。` : ''}` : marketFeeText(r.fees)));
  body.appendChild(el('p', 'cm-notice', rosterActive() ? '角色名稱、背包、魔法、任務一起轉移。' + marketBuyNotice() : '角色名稱、背包、魔法、任務一起轉移。買方帳號已有 3 隻角色就不能購買。')); // 11/08 使用者:倉庫那句不寫
  let pass = null;
  if (r.private) { // 11/08 密碼單:輸入賣方給的 6 位數密碼
    pass = el('input', 'cmui-pass'); pass.type = 'text'; pass.inputMode = 'numeric'; pass.maxLength = 6; pass.placeholder = '輸入 6 位數密碼'; pass.autocomplete = 'off';
    body.appendChild(pass);
  }
  const box = el('label', 'cm-confirm');
  const check = el('input'); check.type = 'checkbox';
  box.append(check, document.createTextNode(` 我確認支付 ${cmuiN(pay)} 金幣購買「${s.name || r.name}」`));
  const ready = () => (!rosterActive() || marketCanBuy()) && check.checked && !cm.pending && !!r.fees?.valid && (!pass || /^\d{6}$/.test(pass.value));
  const buy = clanBtn('確認購買', 'clan-btn on', () => {
    if (!ready() || !st.charMarket) return;
    if (rosterActive()) {
      const args = [4, r.id, r.version, 0, pass ? `${marketKey()}|${r.code || ''}|${pass.value}` : marketKey()];
      marketConfirm(`確認支付 ${cmuiN(pay)} 金幣購買「${s.name || r.name}」。` + marketBuyNotice(), () => marketSubmit(args));
      return;
    }
    cm.pending = [4, r.id, r.version, 0, pass ? `${marketKey()}|${r.code || ''}|${pass.value}` : marketKey()];
    marketSend(...cm.pending); renderPanel();
  });
  buy.disabled = true; check.onchange = () => { buy.disabled = !ready(); };
  if (pass) pass.oninput = () => { pass.value = pass.value.replace(/\D/g, '').slice(0, 6); buy.disabled = !ready(); };
  body.appendChild(box);
  foot.appendChild(buy);
}
function cmuiTabEquip(body, s, items) {
  const eq = {};
  for (const it of items) {
    if (!it.equipped) continue;
    let slot = SLOT_OF_USETYPE[it.useType] || (/戒指/.test(it.name) ? 'ring' : null);
    if (slot === 'ring' && eq.ring) slot = 'ring2';
    if (slot === 'helm' && MAGIC_HELMS.has(it.name)) slot = eq.helmA ? 'helmB' : 'helmA';
    if (slot) eq[slot] = it;
  }
  const cell = (it, label, cls = 'equip') => {
    const c = el('button', `${cls}${it ? ' has' : ''}`); c.type = 'button';
    if (it) {
      c.appendChild(cmuiIcon(it, cls.includes('small') ? 22 : 34));
      if (it.enchant && !/戒指|項鍊|腰帶|耳環/.test(it.name)) c.appendChild(el('b', 'enh', `${it.enchant > 0 ? '+' : ''}${it.enchant}`));
      c.title = cmuiItemName(it); c.onclick = () => toast(cmuiItemName(it));
    } else c.appendChild(el('span', '', label));
    return c;
  };
  const col = (slots) => {
    const c = el('div', 'equip-col');
    for (const [k, label] of slots) {
      if (k === 'helm') {
        const wrap = el('div', 'helm-wrap'); wrap.appendChild(cell(eq.helm, label));
        const sub = el('div', 'helm-sub'); sub.append(cell(eq.helmA, '魔法', 'equip small'), cell(eq.helmB, '魔法', 'equip small'));
        wrap.appendChild(sub); c.appendChild(wrap); continue;
      }
      c.appendChild(cell(eq[k], label));
    }
    return c;
  };
  const grid = el('div', 'char-grid');
  const center = el('div', 'char-center');
  center.appendChild(cmuiFigure(s, s.type, 150, 160, 142, 96, true));
  const bars = el('div', 'char-bars');
  bars.append(el('div', 'mini hp', `HP ${cmuiN(s.hp)}`), el('div', 'mini mp', `MP ${cmuiN(s.mp)}`));
  center.appendChild(bars);
  grid.append(col(LEFT_SLOTS), center, col(RIGHT_SLOTS));
  const doll = el('div', 'cmui-doll'); doll.appendChild(grid);
  body.appendChild(doll);
  const list = el('div', 'cmui-eqlist');
  for (const it of items.filter((x) => x.equipped)) {
    const row = el('div', 'cmui-irow'); row.append(cmuiIcon(it, 22), el('span', it.bless === 0 ? 'blessed' : '', cmuiItemName(it)));
    list.appendChild(row);
  }
  body.appendChild(list);
}
function cmuiTabStats(body, s) {
  const dl = el('dl', 'char-stats');
  const add = (k, v) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(v ?? '-'))); };
  add('STR', s.str); add('DEX', s.dex); add('CON', s.con); add('INT', s.int); add('WIS', s.wis); add('CHA', s.cha);
  add('HP', cmuiN(s.hp)); add('MP', cmuiN(s.mp)); add('AC', s.ac);
  add('正義', cmuiN(s.lawful)); add('PK', s.pk); add('魔法', s.skills);
  if (s.type === 2) add('屬性', ['未選', '地', '火', '水', '風'][s.elf] || '-');
  body.appendChild(dl);
  body.appendChild(el('p', 'cm-notice', '能力值與 HP / MP 是角色本身的數值(不含裝備加成);AC 是賣方最後下線時的數值。'));
}
function cmuiTabSkills(body, s) {
  const skills = st.game.skills || {};
  const has = new Set(s.skillIds || []);
  const [maxTier, own] = CLASS_SKILLS[s.type] ?? [10, null];
  for (const [title, lo, full] of SKILL_GROUPS) {
    if (title !== '通用魔法' && title !== own) continue;
    const hi = title === '通用魔法' ? lo + maxTier - 1 : title === '王族魔法' && !st.royalSword ? 15 : full;
    const ids = Object.keys(skills).map(Number).filter((id) => skills[id].level >= lo && skills[id].level <= hi);
    if (!ids.length) continue;
    const learned = ids.filter((id) => has.has(id) && skills[id].name !== 'none');
    const sec = el('section', 'skill-group');
    sec.appendChild(el('h4', '', `${title}(已學 ${learned.length})`));
    const rows = [];
    if (title === '妖精魔法') ELF_TIERS.forEach(([elfLv, tierIds], i) => { const l = tierIds.filter((id) => skills[id]); for (let k = 0; k < l.length; k += 8) rows.push([k ? '' : `${i + 1}階\nLv${elfLv}`, l.slice(k, k + 8)]); });
    else for (let lv = lo; lv <= hi; lv++) rows.push([`${lv - lo + 1}階`, ids.filter((id) => skills[id].level === lv).sort((a, b) => a - b).slice(0, 8)]);
    for (const [label, lvIds] of rows) {
      const row = el('div', 'skill-row'); row.appendChild(el('span', 'tier', label));
      for (const id of lvIds) {
        const ok = has.has(id) && skills[id].name !== 'none';
        const c = el('span', `skill${ok ? ' learned' : ''}`);
        if (ok) { c.appendChild(skillIcon(skills[id].name)); c.onclick = () => toast(skills[id].name); }
        c.title = skills[id].name === 'none' ? '' : skills[id].name;
        row.appendChild(c);
      }
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
}
function cmuiTabBag(body, s, items, bag) {
  const list = el('div', 'cmui-bag');
  const sorted = [...bag].sort((a, b) => (b.enchant - a.enchant) || ((b.useType ? 1 : 0) - (a.useType ? 1 : 0)) || (b.count - a.count));
  for (const it of sorted) {
    const row = el('div', 'cmui-irow');
    row.append(cmuiIcon(it, 26), el('span', it.bless === 0 ? 'blessed' : it.bless >= 128 ? 'sealed' : '', cmuiItemName(it)));
    if (it.count > 1) row.appendChild(el('small', 'dim', `× ${cmuiN(it.count)}`));
    list.appendChild(row);
  }
  if (!sorted.length) list.appendChild(el('p', 'cm-notice', '背包是空的'));
  body.appendChild(list);
}
function renderCharMarket(body, foot) {
  if (rosterActive() && cm.confirm) { renderMarketConfirm(body, foot); return; }
  const tabs = el('div', 'cm-tabs');
  for (const [key, title] of (st.charMarket ? [['browse', '市場列表'], ['mine', '我的訂單／上架']] : [['mine', '我的訂單／下架']])) {
    tabs.append(clanBtn(title, 'clan-btn' + (panel.tab === key ? ' on' : ''), () => { panel.tab = key; cm.detail = null; marketRead(); renderPanel(); }));
  }
  body.append(tabs);
  if (cm.message) body.append(el('p', 'cm-notice', cm.message));
  if (!st.charMarket) body.append(el('p', 'cm-notice', '市場暫停開放，既有上架仍可下架。'));
  const retry = () => marketRetry();
  if (cm.pending) body.append(clanBtn(cm.request ? '查詢原請求狀態（不重送付款）' : '查詢／重試同一筆請求', 'clan-btn', retry));
  if (cm.request && cm.pending?.[0] !== 4 && ['UNKNOWN', 'RETRY'].includes(cm.request.phase)) body.append(clanBtn('以原內容查回上架／取消結果', 'clan-btn', marketReplay));
  if (rosterActive()) {
    if (st.roster?.listAfter) body.append(el('p', 'cm-notice', `帳號可再上架時間：${rosterTime(st.roster.listAfter)}`));
    if (st.rosterError) body.append(el('p', 'cm-notice', '角色狀態暫時無法確認，請重新整理後再操作。'));
  }
  if (cm.detail && panel.tab !== 'mine') { cmuiDetail(body, foot, cm.detail); return; } // 11/07 市場 UI:詳情四分頁
  const d = cm.data;
  if (!d || d.tab !== panel.tab) { body.append(el('p', '', cm.message || '讀取中…')); foot.append(clanBtn('重新整理', 'clan-btn', () => { marketRead(); renderPanel(); })); return; }
  if (panel.tab === 'mine' && st.charMarket) { // 11/08:標價(有密碼可不填)+ 6 位數密碼;手續費 200 萬由買方付,不再試算
    const form = el('div', 'cm-form'), pick = el('select'), price = el('input'), pass = el('input');
    price.type = 'number'; price.min = 0; price.max = d.max; price.step = '1'; price.placeholder = '標價（金幣，有設密碼可不填）';
    pass.type = 'text'; pass.inputMode = 'numeric'; pass.maxLength = 6; pass.placeholder = '6 位數密碼（選填）'; pass.autocomplete = 'off';
    for (const c of d.candidates || []) {
      const meta = st.roster?.characters.find(x => x.id === c.id);
      const o = el('option', '', c.name + (rosterActive() && meta && !meta.canList ? `（${meta.listReason}）` : ''));
      o.value = c.id; pick.append(o); // Keep ineligible candidates selectable so their reason/time can be inspected.
    }
    if (st.marketTarget && rosterActive()) { cm.draft = { id: String(st.marketTarget.id), price: '', pass: '' }; st.marketTarget = null; }
    if (!cm.draft) cm.draft = { id: pick.value, price: '', pass: '' };
    pick.value = cm.draft.id; price.value = cm.draft.price; pass.value = cm.draft.pass || '';
    pick.onchange = () => { cm.draft.id = pick.value; if (rosterActive()) renderPanel(); };
    price.oninput = () => { cm.draft.price = price.value; };
    pass.oninput = () => { pass.value = pass.value.replace(/\D/g, '').slice(0, 6); cm.draft.pass = pass.value; };
    const fee = Number(d.fee || d.flatFee || 0);
    const listing = clanBtn('確認上架', 'clan-btn on', () => {
      const id = Number(pick.value), pw = pass.value, n = price.value === '' ? 0 : Number(price.value);
      if (!id) { toast('請選擇要上架的角色'); return; }
      if (pw && !/^\d{6}$/.test(pw)) { toast('密碼要 6 位數字'); return; }
      if (!Number.isInteger(n) || n < 0 || n > d.max) { toast('標價要是整數金幣'); return; }
      if (!pw && n < d.min) { toast(`沒設密碼要填標價（至少 ${Number(d.min).toLocaleString()}）`); return; }
      if (cm.pending) return;
      if (rosterActive()) {
        const meta = st.roster?.characters.find(c => c.id === id);
        if (!meta?.canList || st.rosterError) { toast(meta?.listReason || '請重新整理角色清單'); return; }
        marketConfirm(marketListNotice(id), () => marketSubmit([2, id, fee, n, pw ? `${marketKey()}|${pw}` : marketKey()]));
        return;
      }
      cm.pending = [2, id, fee, n, pw ? `${marketKey()}|${pw}` : marketKey()]; marketSend(...cm.pending); renderPanel();
    });
    listing.disabled = !!cm.pending || (rosterActive() && (!st.roster?.characters.find(c => c.id === Number(pick.value))?.canList || st.rosterError));
    const selected = st.roster?.characters.find(c => c.id === Number(pick.value));
    if (rosterActive() && selected?.listReason) form.append(el('p', 'cm-notice', selected.listReason));
    if (rosterActive() && selected?.nextListAt) form.append(el('p', 'cm-notice', `此角色可再上架時間：${rosterTime(selected.nextListAt)}`));
    form.append(pick, price, pass,
      el('p', 'cm-notice', `手續費 ${fee.toLocaleString()} 金幣由買方支付，賣方全額收標價。`),
      el('p', 'cm-notice', rosterActive() ? '密碼訂單不公開列出，請將訂單編號與密碼告訴買方。上架後不能使用或修改角色、不能改價。取消或到期時若位置已滿，角色會鎖定。' : '設了密碼的角色不會出現在市場列表：上架後會給你 8 位數訂單編號，請把編號和密碼告訴買方，買方輸入後才能購買。上架後這隻角色不能登入，直到成交或下架。'),
      listing);
    body.append(form);
  }
  if (panel.tab === 'browse') { cmuiCodeBox(body); cmuiList(body, d.rows); } else for (const r of d.rows) cmuiMine(body, r); // 11/07 市場 UI:卡片;11/08 訂單編號查詢
  if (!d.rows.length) body.append(el('p', '', '目前沒有訂單'));
  foot.append(clanBtn('重新整理', 'clan-btn', () => { cm.detail = null; marketRead(); renderPanel(); }));
  if (panel.tab === 'browse') {
    const previous = clanBtn('上一頁', 'clan-btn', () => { cm.cursor = cm.pages.pop() || 0; marketRead(); renderPanel(); }); previous.disabled = !cm.pages.length;
    const next = clanBtn('下一頁', 'clan-btn', () => { cm.pages.push(cm.cursor); cm.cursor = d.rows.at(-1).id; marketRead(); renderPanel(); }); next.disabled = d.rows.length < 20;
    foot.append(previous, next);
  }
}
$('#btn-charmarket').onclick = () => togglePanel('charmarket');

// ---- 拍賣行(伺服器 C_WebAuction / S_WebAuction / L1Auction)----
// au.browse / au.mine 是伺服器送來的清單;20 級才顯示按鈕(伺服器也會擋)
// 瀏覽:同一種道具一筆(最低價、合計數量、幾種價格),點進去(au.detailKey)才列出各單價(op 5,au.detail)
const au = { q: '', cat: 0, sort: 0, page: 0, browse: null, mine: null, sales: null, salesPage: 0,
  buying: null, qty: '1', detailKey: null, detail: null, selling: false, confirm: null,
  message: '', pending: null, reads: {}, failed: {}, update: null, form: { id: 0, count: '1', price: '' } };
const auctionOp = (op, a = 0, b = 0, c = 0, text = '') => send({ t: 'auction', op, a, b, c, text });
const fmtLeft2 = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分` : `${Math.max(1, Math.floor(s / 60))} 分`);
const auMineBadge = (n) => el('span', 'au2-badge', `我的 ${fmt(n)} 個`);
function auctionRead(tab, op, a = 0, b = 0, c = 0, text = '') {
  if (au.reads[tab]) return;
  if (!au.pending) au.message = '';
  delete au.failed[tab];
  au.reads[tab] = setTimeout(() => {
    delete au.reads[tab]; au.failed[tab] = true;
    au.message = '讀取逾時，請重新整理再試一次。';
    if (panel.name === 'auction') renderPanel();
  }, 12000);
  auctionOp(op, a, b, c, text);
}
const auctionBrowse = () => auctionRead('browse', 0, au.cat, au.sort, au.page, au.q);
const auctionDetail = (key) => auctionRead('detail', 5, 0, 0, 0, key);
function auctionOpen(tab) {
  panel.tab = tab === 'sell' ? 'mine' : tab || 'browse';
  au.selling = tab === 'sell'; au.confirm = null; au.buying = null; au.detailKey = null; au.detail = null;
  au.browse = null; au.mine = null; au.sales = null; au.salesPage = 0;
  au.message = au.pending ? '交易結果確認中，請稍候。' : '';
  for (const timer of Object.values(au.reads)) clearTimeout(timer);
  au.reads = {}; au.failed = {};
  if (panel.tab === 'browse') auctionBrowse();
}
function auctionSubmit(op, a = 0, b = 0, c = 0, text = '') {
  if (au.pending) return;
  if (!st.ws || st.ws.readyState !== 1) { au.message = '連線已中斷，請等待重新連線後再試。'; renderPanel(); return; }
  au.message = '交易結果確認中…';
  au.pending = { op, timer: setTimeout(() => {
    au.message = '尚未收到交易結果，請先查看信箱，勿重複送出。若等待仍未解除，請重新整理遊戲。';
    if (panel.name === 'auction') renderPanel();
  }, 12000) };
  if (auctionOp(op, a, b, c, text) === false) {
    clearTimeout(au.pending.timer); au.pending = null; au.message = '連線已中斷，請等待重新連線後再試。';
  }
  renderPanel();
}
function auctionEvent(ev) {
  delete au.failed[ev.tab];
  if (ev.tab === 'detail' && au.detailKey && ev.key !== au.detailKey) {
    clearTimeout(au.reads.detail); delete au.reads.detail; auctionDetail(au.detailKey); return;
  }
  if (au.reads[ev.tab]) { clearTimeout(au.reads[ev.tab]); delete au.reads[ev.tab]; }
  // 沒有請求編號；只由交易結果解除送出鎖，不因瀏覽回覆而重開購買按鈕。
  if (ev.msg && au.pending && (!ev.tab || ev.tab === (au.pending.op === 4 ? 'buy' : 'mine'))) {
    const op = au.pending.op;
    clearTimeout(au.pending.timer); au.pending = null; au.confirm = null;
    if (op === 4) au.buying = null;
    else { au.browse = null; au.detail = null; }
    if (op === 2 && ev.msg.startsWith('已上架')) { au.selling = false; au.form = { id: 0, count: '1', price: '' }; }
  }
  if (ev.msg && !ev.tab) {
    for (const [tab, timer] of Object.entries(au.reads)) { clearTimeout(timer); au.failed[tab] = true; }
    au.reads = {};
  }
  if (ev.msg) au.message = ev.msg.replace(/\d{4,}/g, (n) => fmt(+n));
}
function auctionOtpNeed() {
  if (au.pending) { clearTimeout(au.pending.timer); au.pending = null; }
  au.confirm = null;
  au.message = '請先完成手機驗證，再回拍賣行確認並送出。';
  if (panel.name === 'auction') renderPanel();
}
function auctionRender(top = false) {
  renderPanel();
  if (top) $('#panel-body').scrollTop = 0;
}

function auctionInventoryChanged() {
  if (panel.name !== 'auction') return;
  const gold = document.querySelector('.au2-wallet strong'); if (gold) gold.textContent = fmt(adena());
  au.update?.();
}
function auctionStartBuy(key) {
  au.buying = key; au.qty = '1'; auctionRender();
  document.querySelector('.au2-buy')?.scrollIntoView({ block: 'nearest' });
}
let auctionDesc = null;
function closeAuctionDescription() {
  if (!auctionDesc) return;
  const { pop, cleanup, cell, hover } = auctionDesc;
  auctionDesc = null;
  pop.remove(); cleanup();
  if (!hover && cell.isConnected) cell.focus({ preventScroll: true });
}
// 共用背包的說明內容;拍賣編號不是背包物件編號,不能顯示使用 / 丟棄 / 上鎖等操作。
function openAuctionDescription(it, cell, hover = false) {
  closeAuctionDescription();
  const pop = el('div');
  pop.id = 'auction-desc';
  pop.style.cssText = `position:fixed;z-index:10000;box-sizing:border-box;padding:12px;display:flex;align-items:center;justify-content:center;pointer-events:${hover ? 'none' : 'auto'};background:${hover ? 'transparent' : 'rgba(0,0,0,.35)'}`;
  const box = el('div');
  box.setAttribute('role', hover ? 'tooltip' : 'dialog');
  box.setAttribute('aria-label', '物品說明');
  box.style.cssText = 'display:flex;flex-direction:column;box-sizing:border-box;width:300px;max-width:100%;max-height:100%;min-width:0;min-height:0;padding:8px;zoom:.85;border:1px solid #8a6a1f;border-radius:10px;background:#211d16;color:#f3e6c4;overflow:hidden';
  const close = clanBtn('關閉 ✕', 'clan-btn', closeAuctionDescription);
  close.style.cssText = 'align-self:flex-end;flex-shrink:0';
  const body = el('div');
  body.style.cssText = 'min-height:0;overflow:auto;overflow-wrap:anywhere;overscroll-behavior:contain';
  appendItemDescription(body, { ...it, kind: 'inv' }, false);
  box.append(close, body); pop.appendChild(box);
  pop.onclick = (e) => { e.stopPropagation(); if (e.target === pop) closeAuctionDescription(); };
  pop.onkeydown = (e) => e.stopPropagation(); // 不觸發遊戲快捷鍵
  const vv = window.visualViewport;
  const place = () => {
    pop.style.left = `${vv?.offsetLeft || 0}px`; pop.style.top = `${vv?.offsetTop || 0}px`;
    pop.style.width = `${vv?.width || window.innerWidth}px`; pop.style.height = `${vv?.height || window.innerHeight}px`;
  };
  const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAuctionDescription(); } };
  window.addEventListener('resize', place);
  vv?.addEventListener('resize', place); vv?.addEventListener('scroll', place);
  document.addEventListener('keydown', escape, true);
  auctionDesc = { pop, cell, hover, cleanup: () => {
    window.removeEventListener('resize', place);
    vv?.removeEventListener('resize', place); vv?.removeEventListener('scroll', place);
    document.removeEventListener('keydown', escape, true);
  } };
  place(); document.body.appendChild(pop);
  if (!hover) close.focus({ preventScroll: true });
}
function auctionItemDescription(cell, it) {
  cell.tabIndex = 0; cell.setAttribute('role', 'button');
  cell.setAttribute('aria-label', `${itemLabel(it)}:查看說明`);
  cell.style.cursor = 'pointer';
  let timer = 0, x = 0, y = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const open = (hover) => { if (panel.name === 'auction' && cell.isConnected) openAuctionDescription(it, cell, hover); };
  cell.onclick = (e) => { e.stopPropagation(); cancel(); open(false); };
  cell.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); cancel(); open(false); } };
  cell.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && !e.buttons) { cancel(); timer = setTimeout(() => open(true), 500); }
  });
  cell.addEventListener('pointerdown', (e) => {
    cancel(); x = e.clientX; y = e.clientY;
    if (e.pointerType !== 'mouse' && e.isPrimary !== false) timer = setTimeout(() => open(false), 550);
  });
  cell.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' && (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8)) cancel();
  });
  for (const t of ['pointerup', 'pointercancel', 'blur']) cell.addEventListener(t, cancel);
  cell.addEventListener('pointerleave', () => {
    cancel();
    if (auctionDesc?.cell === cell && auctionDesc.hover) closeAuctionDescription();
  });
  cell.oncontextmenu = (e) => e.preventDefault();
  return cell;
}
// 名稱與數量分開呈現；說明內容、祝福樣式與圖示沿用背包。
const auctionName = (it) => it.count > 1 ? itemLabel(it).replace(/\s*\(\d+\)$/, '') : itemLabel(it);
function auctionItemCell(it, sub = '') {
  const cell = el('div', 'au2-item');
  const art = el('span', 'au2-art'); art.append(iconCanvas({ ...it, kind: 'inv' }, 36));
  const info = el('span', 'au2-info');
  info.append(el('strong', 'au2-name', auctionName(it)));
  if (sub) info.append(el('span', 'au2-muted', sub));
  cell.append(art, info);
  return auctionItemDescription(cell, it);
}
function auctionButton(text, action, kind = '') {
  const b = el('button', `au2-btn ${kind}`, text); b.type = 'button'; b.onclick = action; return b;
}
function auctionEmpty(body, title, note = '') {
  const box = el('div', 'au2-empty'); box.setAttribute('role', 'status');
  box.append(el('strong', '', title));
  if (note) box.append(el('p', 'au2-muted', note));
  body.append(box); return box;
}
function auctionLoading(body, tab) {
  auctionEmpty(body, au.reads[tab] ? '正在讀取…' : '暫時無法取得資料', au.reads[tab] ? '請稍候。' : '請按下方的重新整理。');
}
function auctionPager(foot, data, go) {
  if (!data || data.pages <= 1) return;
  const pager = el('div', 'au2-pager');
  const prev = auctionButton('‹', () => go(data.page - 1)), next = auctionButton('›', () => go(data.page + 1));
  prev.setAttribute('aria-label', '上一頁'); next.setAttribute('aria-label', '下一頁');
  prev.disabled = data.page <= 0; next.disabled = data.page >= data.pages - 1;
  pager.append(prev, el('span', '', `${data.page + 1} / ${data.pages}`), next); foot.append(pager);
}
function auctionFooter(foot, tab, refresh) {
  const wallet = el('div', 'au2-wallet');
  wallet.append(el('span', 'au2-muted', '持有金幣'), el('strong', '', fmt(adena())));
  const actions = el('div', 'au2-foot-actions');
  const reload = auctionButton('重新整理', refresh); reload.disabled = !!au.reads[tab];
  actions.append(auctionButton('信箱領取', () => openPanel('mail')), reload);
  foot.append(wallet, actions);
}
function auctionRules(body) {
  const rules = el('details', 'au2-rules');
  rules.append(el('summary', '', '交易規則與領取方式'), el('p', '', '上架後隨機等待 5～20 分鐘才公開販售，公開後保留 24 小時。上架費不退。買到的道具、賣出的金幣，以及下架或到期的道具，都請到信箱領取。'));
  body.append(rules);
}
function numInput(value, placeholder, onInput) {
  const i = el('input', 'au-num');
  i.type = 'number'; i.inputMode = 'numeric'; i.min = '1'; i.placeholder = placeholder; i.value = value;
  i.addEventListener('input', () => onInput(i.value));
  return i;
}
function auctionNumber(value, label, max, onInput) {
  const wrap = el('label', 'au2-field'); wrap.append(el('span', '', label));
  const input = numInput(value, label, onInput); input.className = 'au2-number'; input.max = String(max); input.step = '1';
  wrap.append(input); return { wrap, input };
}
function auctionBuyBox(key, price, count) {
  const box = el('div', 'au2-buy');
  const qty = auctionNumber(au.qty, '購買數量', count, (v) => { au.qty = v; update(); });
  const total = el('div', 'au2-total'), error = el('p', 'au2-error'); error.setAttribute('role', 'status');
  const validate = () => {
    const n = Number(au.qty);
    if (!Number.isInteger(n) || n < 1 || n > count) return `數量請填 1～${fmt(count)} 的整數。`;
    if (n * price > 2000000000) return '總價不可超過 2,000,000,000 金幣。';
    if (n * price > adena()) return `金幣不足，還差 ${fmt(n * price - adena())}。`;
    return '';
  };
  const yes = auctionButton('確認購買', () => {
    if (validate()) { update(); return; }
    auctionSubmit(4, 0, +au.qty, price, key);
  }, 'au2-primary');
  const update = () => {
    const n = Number(au.qty), valid = Number.isInteger(n) && n > 0 && n <= count;
    total.replaceChildren(el('span', 'au2-muted', '總價'), el('strong', '', valid ? `${fmt(n * price)} 金幣` : '—'));
    error.textContent = validate(); yes.disabled = !!error.textContent || !!au.pending;
    yes.textContent = au.pending ? '確認中…' : '確認購買'; qty.input.disabled = !!au.pending; max.disabled = !!au.pending || adena() < price;
  };
  const quick = el('div', 'au2-qty');
  const max = auctionButton('最多', () => { au.qty = String(Math.min(count, Math.floor(adena() / price), Math.floor(2000000000 / price))); qty.input.value = au.qty; update(); });
  max.disabled = !!au.pending || adena() < price;
  quick.append(qty.wrap, max);
  const actions = el('div', 'au2-actions');
  const cancel = auctionButton('取消', () => { au.buying = null; auctionRender(); }); cancel.disabled = !!au.pending;
  actions.append(cancel, yes);
  box.append(quick, total, error, el('p', 'au2-muted', '成交後，道具寄到信箱。'), actions); au.update = update; update(); return box;
}
function renderAuction(body, foot) {
  au.update = null;
  setTabs([['browse', '瀏覽'], ['mine', '我的上架'], ['sales', '販售紀錄']]);
  $('#panel-tabs').querySelectorAll('button').forEach((b, i) => {
    b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    b.onclick = () => { panel.tab = ['browse', 'mine', 'sales'][i]; au.confirm = null; au.buying = null; au.selling = false; auctionRender(true); };
  });
  if (au.message) {
    const msg = el('div', 'au2-message', au.message); msg.setAttribute('role', 'status'); body.append(msg);
  }
  if (panel.tab === 'mine') { renderAuctionMine(body, foot); return; }
  if (panel.tab === 'sales') { renderAuctionSales(body, foot); return; }
  if (au.detailKey) { renderAuctionDetail(body, foot); return; }
  const refresh = () => { au.browse = null; auctionBrowse(); auctionRender(true); };
  auctionFooter(foot, 'browse', refresh);
  const bar = el('form', 'au2-tools'), search = el('div', 'au2-search');
  const q = el('input'); q.type = 'search'; q.placeholder = '搜尋道具名稱'; q.setAttribute('aria-label', '搜尋道具名稱'); q.maxLength = 20; q.value = au.q;
  const go = () => { if (au.reads.browse) return; au.q = q.value.trim(); au.page = 0; refresh(); };
  bar.onsubmit = (e) => { e.preventDefault(); go(); };
  const searchBtn = auctionButton('搜尋', go, 'au2-primary'); searchBtn.disabled = !!au.reads.browse;
  search.append(q, searchBtn); bar.append(search);
  const filters = el('div', 'au2-filters');
  const select = (title, opts, value, apply) => {
    const label = el('label', 'au2-field'); label.append(el('span', '', title));
    const s = el('select');
    opts.forEach(([text, val]) => { const o = el('option', '', text); o.value = val; s.append(o); });
    s.value = value; s.disabled = !!au.reads.browse; s.onchange = () => { apply(+s.value); go(); }; label.append(s); return label;
  };
  filters.append(select('分類', [['全部道具', 0], ['武器', 1], ['防具', 2], ['消耗品', 4], ['魔法書', 5], ['其他', 3]], au.cat, (v) => { au.cat = v; }),
    select('排序', [['價格由低到高', 0], ['價格由高到低', 1]], au.sort, (v) => { au.sort = v; }));
  bar.append(filters); body.append(bar);
  if (!au.browse && !au.reads.browse && !au.failed.browse) auctionBrowse();
  const b = au.browse;
  if (!b) { auctionLoading(body, 'browse'); return; }
  if (!b.list.length) {
    const empty = auctionEmpty(body, au.q || au.cat ? '沒有符合的道具' : '目前沒有上架的道具', au.q || au.cat ? '試試其他名稱，或清除篩選。' : '稍後再來看看，或到「我的上架」出售道具。');
    if (au.q || au.cat) empty.append(auctionButton('清除篩選', () => { au.q = ''; au.cat = 0; au.page = 0; refresh(); }));
  }
  const list = el('div', 'au2-list');
  for (const it of b.list) {
    const row = el('div', 'au2-card');
    row.append(auctionItemCell(it, `共 ${fmt(it.count)} 個${it.tiers > 1 ? ` · ${fmt(it.tiers)} 種價格` : ''}`));
    const price = el('div', 'au2-price'); price.append(el('span', 'au2-muted', it.tiers != null ? '最低單價' : '單價'), el('strong', '', fmt(it.price)));
    const action = el('div', 'au2-card-action');
    if (it.mine > 0) action.append(auMineBadge(it.mine));
    if (it.tiers != null) {
      const btn = auctionButton('查看價格 ›', () => { au.detailKey = it.key; au.detail = null; au.buying = null; auctionDetail(it.key); auctionRender(true); });
      btn.setAttribute('aria-label', `${itemLabel(it)}：查看價格`); action.append(btn);
    } else {
      const canBuy = it.count - (it.mine || 0), rowKey = `${it.key}@${it.price}`;
      if (canBuy <= 0) action.append(el('span', 'au2-muted', '自己的上架'));
      else if (au.buying === rowKey) row.append(auctionBuyBox(it.key, it.price, canBuy));
      else { const buy = auctionButton('購買', () => { auctionStartBuy(rowKey); }, 'au2-primary'); buy.disabled = !!au.pending; action.append(buy); }
    }
    row.append(price, action); list.append(row);
  }
  body.append(list);
  auctionPager(foot, b, (p) => { au.page = p; refresh(); }); auctionRules(body);
}
function renderAuctionDetail(body, foot) {
  const back = () => { au.detailKey = null; au.detail = null; au.buying = null; auctionRender(true); };
  body.append(auctionButton('‹ 返回列表', back, 'au2-back'));
  auctionFooter(foot, 'detail', () => { au.detail = null; au.buying = null; auctionDetail(au.detailKey); auctionRender(true); });
  const d = au.detail;
  if (!d || d.key !== au.detailKey) { auctionLoading(body, 'detail'); return; }
  if (!d.tiers.length) { auctionEmpty(body, '這個道具已經賣完', '返回列表看看其他道具，或重新整理價格。'); return; }
  const total = d.tiers.reduce((sum, t) => sum + t.count, 0);
  const head = auctionItemCell(d, `共 ${fmt(total)} 個 · 點道具查看說明`); head.classList.add('au2-detail-head'); body.append(head);
  body.append(el('p', 'au2-muted', '依最低單價購買，自己的上架不計入。'));
  const list = el('div', 'au2-list');
  const buyIdx = d.tiers.findIndex((t) => t.count - (t.mine || 0) > 0);
  d.tiers.forEach((t, i) => {
    const row = el('div', `au2-tier${i === buyIdx ? ' au2-best' : ''}`);
    const price = el('div', 'au2-price'); price.append(el('span', 'au2-muted', i === buyIdx ? '目前最低可買' : '單價'), el('strong', '', fmt(t.price)));
    const qty = el('div', 'au2-stock', `${fmt(t.count)} 個`); if (t.mine > 0) qty.append(auMineBadge(t.mine));
    const canBuy = t.count - (t.mine || 0); row.append(price, qty);
    if (i === buyIdx) {
      const key = `${d.key}@${t.price}`;
      const buy = auctionButton('購買', () => { auctionStartBuy(key); }, 'au2-primary'); buy.disabled = !!au.pending;
      if (au.buying !== key) row.append(buy);
      else row.append(auctionBuyBox(d.key, t.price, canBuy));
    } else row.append(el('span', 'au2-muted au2-tier-note', canBuy <= 0 ? '自己的上架' : '低價售完後可買'));
    list.append(row);
  }); body.append(list);
}
function renderAuctionSales(body, foot) {
  const refresh = () => { au.sales = null; auctionRead('sales', 6, au.salesPage); auctionRender(true); };
  auctionFooter(foot, 'sales', refresh);
  if (!au.sales) { if (!au.reads.sales && !au.failed.sales) auctionRead('sales', 6, au.salesPage); auctionLoading(body, 'sales'); return; }
  const s = au.sales;
  body.append(el('p', 'au2-section-title', '最近 30 天'), el('p', 'au2-muted', '最新成交在前，實收金幣請至信箱領取。'));
  if (!s.list.length) auctionEmpty(body, '還沒有販售紀錄', '道具成交後，會在這裡顯示明細。');
  for (const r of s.list) {
    const row = el('div', 'au2-sale'); row.append(auctionItemCell(r, `${r.at} · 售出 ${fmt(r.count)} 個`));
    const net = el('div', 'au2-price'); net.append(el('span', 'au2-muted', '實收金幣'), el('strong', '', fmt(r.net))); row.append(net);
    const details = el('div', 'au2-sale-details');
    for (const [label, value] of [['單價', r.price], ['總價', r.total], ['成交稅', r.tax]]) details.append(el('span', '', `${label} ${fmt(value)}`));
    row.append(details); body.append(row);
  }
  auctionPager(foot, s, (p) => { au.salesPage = p; refresh(); });
}
function renderAuctionMine(body, foot) {
  const refresh = () => { au.mine = null; au.confirm = null; auctionRead('mine', 1); auctionRender(true); };
  auctionFooter(foot, 'mine', refresh);
  if (!au.mine) { if (!au.reads.mine && !au.failed.mine) auctionRead('mine', 1); auctionLoading(body, 'mine'); return; }
  const m = au.mine;
  if (au.selling) { renderAuctionSell(body, m); return; }
  const top = el('div', 'au2-section');
  const add = auctionButton('＋ 新增上架', () => { au.selling = true; au.confirm = null; auctionRender(true); }, 'au2-primary');
  add.disabled = m.mine.length >= m.max || !!au.pending;
  top.append(el('strong', '', `上架中 ${m.mine.length} / ${m.max}`), add); body.append(top);
  if (m.mine.length >= m.max) body.append(el('p', 'au2-muted', '上架欄位已滿，請先下架道具或等待成交。'));
  if (!m.mine.length) auctionEmpty(body, '還沒有上架的道具', '選擇背包裡的道具，設定單價即可上架。');
  for (const it of m.mine) {
    const row = el('div', 'au2-card');
    row.append(auctionItemCell(it, `剩餘 ${fmt(it.count)} 個`));
    const price = el('div', 'au2-price'); price.append(el('span', 'au2-muted', '單價'), el('strong', '', fmt(it.price))); row.append(price);
    const action = el('div', 'au2-card-action');
    action.append(el('span', `au2-state${it.waiting ? ' waiting' : ''}`, it.waiting ? '等待公開' : it.left <= 0 ? '已到期，等待寄回' : `販售中 · 剩 ${fmtLeft2(it.left)}`));
    const cancel = auctionButton(it.left <= 0 ? '領回道具' : '下架', () => { au.confirm = it.id; auctionRender(); }); cancel.disabled = !!au.pending; action.append(cancel); row.append(action);
    if (au.confirm === it.id) {
      const box = el('div', 'au2-confirm'); box.append(el('p', '', `將 ${itemLabel(it)} × ${fmt(it.count)} 寄回信箱，上架費不退。`));
      const buttons = el('div', 'au2-actions');
      const no = auctionButton('取消', () => { au.confirm = null; auctionRender(); }), yes = auctionButton(au.pending ? '確認中…' : '確認寄回', () => auctionSubmit(3, it.id), 'au2-danger');
      no.disabled = yes.disabled = !!au.pending; buttons.append(no, yes); box.append(buttons); row.append(box);
    }
    body.append(row);
  }
  body.append(el('p', 'au2-muted', '已售出請看販售紀錄；下架與到期道具請至信箱領取。')); auctionRules(body);
}
function renderAuctionSell(body, m) {
  body.append(auctionButton('‹ 返回我的上架', () => { au.selling = false; au.confirm = null; auctionRender(true); }, 'au2-back'));
  body.append(el('h4', 'au2-section-title', '新增上架'));
  if (m.mine.length >= m.max) { auctionEmpty(body, '上架欄位已滿', '請先下架道具或等待成交。'); return; }
  const ok = new Set(m.sellable), items = [...st.inv.values()].filter((it) => ok.has(it.id) && !isLocked(it));
  if (!items.length) { auctionEmpty(body, '沒有可上架的道具', '裝備中、已上鎖或不可交易的道具不會列在這裡。'); return; }
  const f = au.form;
  if (!items.some((it) => it.id === f.id)) { f.id = items[0].id; f.count = '1'; f.price = ''; au.confirm = null; }
  const it = items.find((it) => it.id === f.id), box = el('div', 'au2-form');
  const field = el('label', 'au2-field'), select = el('select'); field.append(el('span', '', '選擇道具'));
  for (const item of items) { const o = el('option', '', `${auctionName(item)} × ${fmt(item.count)}`); o.value = item.id; select.append(o); }
  select.value = f.id; select.disabled = !!au.pending;
  select.onchange = () => { f.id = +select.value; f.count = '1'; f.price = ''; au.confirm = null; auctionRender(); }; field.append(select); box.append(field);
  box.append(auctionItemCell(it, `持有 ${fmt(it.count)} 個 · 點道具查看說明`));
  const fields = el('div', 'au2-form-fields');
  const qty = auctionNumber(f.count, '上架數量', it.count, (v) => { f.count = v; au.confirm = null; update(); });
  const price = auctionNumber(f.price, '每個單價', 2000000000, (v) => { f.price = v.replace(/,/g, ''); au.confirm = null; update(); }); price.input.min = '100'; price.input.step = '10'; price.input.placeholder = '最少 100'; price.input.type = 'text';
  const formatPrice = () => { price.input.value = f.price && Number.isFinite(+f.price) ? fmt(+f.price) : f.price; };
  price.input.addEventListener('blur', formatPrice); formatPrice();
  fields.append(qty.wrap, price.wrap); box.append(fields);
  box.append(el('p', 'au2-muted', '單價最少 100 金幣，須為 10 的倍數。'));
  const ref = m.ref?.[it.id];
  if (ref) {
    const reference = auctionButton(`帶入目前最低價 ${fmt(ref)}`, () => { f.price = String(ref); formatPrice(); au.confirm = null; update(); }, 'au2-reference');
    reference.disabled = !!au.pending; box.append(reference);
  }
  const calc = el('div', 'au2-calculation'), error = el('p', 'au2-error'), confirmation = el('div', 'au2-confirm-copy'); error.setAttribute('role', 'status');
  const values = () => {
    const n = Number(f.count), p = Number(f.price), total = n * p;
    return { n, p, total, fee: Math.max(m.feeMin, Math.floor(total * m.fee / 100)), tax: Math.floor(total * m.tax / 100) };
  };
  const validate = () => {
    const { n, p, total, fee } = values();
    const current = st.inv.get(it.id);
    if (!current || isLocked(current) || isEquipped(current)) return '道具已變動，請重新整理可上架清單。';
    if (!Number.isInteger(n) || n < 1 || n > current.count) return `數量請填 1～${fmt(current.count)} 的整數。`;
    if (!Number.isInteger(p) || p < 100 || p % 10) return '單價最少 100，須為 10 的倍數。';
    if (total > 2000000000) return '總價不可超過 2,000,000,000 金幣。';
    if (fee > adena()) return `上架費不足，還差 ${fmt(fee - adena())} 金幣。`;
    return '';
  };
  const submit = auctionButton('確認上架內容', () => {
    if (validate()) { update(); return; }
    if (au.confirm !== 'sell') { au.confirm = 'sell'; update(); submit.scrollIntoView({ block: 'nearest' }); return; }
    const { n, p } = values(); auctionSubmit(2, it.id, n, p);
  }, 'au2-primary');
  const edit = auctionButton('返回修改', () => { au.confirm = null; update(); });
  const update = () => {
    const { total, fee, tax } = values(), ready = !validate(), confirming = au.confirm === 'sell';
    calc.replaceChildren();
    for (const [label, value] of [['販售總價', total], [`上架費 ${m.fee}%（最低 ${fmt(m.feeMin)}，不退）`, fee], [`預估成交稅 ${m.tax}%`, tax], ['預估實收', total - tax]]) {
      const line = el('div'); line.append(el('span', '', label), el('strong', '', f.price && total > 0 && Number.isFinite(total) ? fmt(value) : '—')); calc.append(line);
    }
    error.textContent = f.price || !f.count ? validate() : '';
    confirmation.textContent = confirming ? `確認以每個 ${fmt(+f.price)} 金幣上架 ${fmt(+f.count)} 個，立即扣除上架費 ${fmt(fee)} 金幣。` : '';
    submit.textContent = au.pending ? '確認中…' : confirming ? '支付上架費並上架' : '確認上架內容';
    submit.disabled = !ready || !!au.pending; edit.hidden = !confirming; edit.disabled = !!au.pending;
    qty.input.disabled = price.input.disabled = !!au.pending;
  };
  const actions = el('div', 'au2-actions'); actions.append(edit, submit);
  box.append(calc, error, confirmation, actions); au.update = update; update(); body.append(box); auctionRules(body);
}
$('#btn-auction').onclick = () => togglePanel('auction');

// ---- 信箱(伺服器 C_WebMail / S_WebMail;st.mail 是伺服器送來的整份信箱資料)----
// 附件領完的信先標「已領取」,關閉信箱時伺服器才刪掉
const mailOp = (op, id = 0, text = '') => send({ t: 'mail', op, id, text });
const mailRead = new Set(); // 已經送過「讀信」的信件編號(沒有附件的信打開信箱就算讀過)
function setMailBadge(n) {
  const b = $('#btn-mail .badge');
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('hidden', !(n > 0));
  $('#btn-mail').classList.toggle('has-mail', n > 0); // 有信:按鈕亮起來(沒信時和其他按鈕一樣暗)
  const nb = $('#nav-mail .badge'); // 底部導覽的信箱鈕也顯示未讀數
  if (nb) { nb.textContent = b.textContent; nb.classList.toggle('hidden', !(n > 0)); }
}
function renderMail(body, foot) {
  const box = el('div', 'clan-create');
  const input = el('input');
  input.placeholder = '輸入禮包碼';
  input.maxLength = 32;
  input.autocomplete = 'off';
  const redeem = () => { const code = input.value.trim(); if (!code) { toast('請輸入禮包碼'); return; } mailOp(5, 0, code); input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') redeem(); });
  box.append(input, clanBtn('兌換', 'learn', redeem));
  body.appendChild(box);
  const m = st.mail;
  if (!m) { body.appendChild(el('p', 'empty', '讀取中…')); return; }
  if (!m.mails.length) body.appendChild(el('p', 'empty', '沒有信件。'));
  let pending = 0;
  let readSent = false; // 伺服器封包佇列很小(ClientThread H_CAPACITY = 2,塞滿就丟),一次只送一封讀信,回應後重畫再送下一封
  for (const mail of m.mails) {
    const has = mail.items.length > 0 || mail.gold > 0;
    if (has && !mail.claimed) pending++;
    if (!has && !mail.read && !mailRead.has(mail.id) && !readSent) { mailRead.add(mail.id); mailOp(1, mail.id); readSent = true; }
    const row = el('div', `clan-row mail-row${mail.claimed ? ' off' : ''}`);
    const info = el('div', 'clan-info');
    info.append(el('b', '', mail.title), el('small', '', `${mail.from} · ${mail.time}`));
    row.appendChild(info);
    if (mail.claimed && has) row.appendChild(el('span', 'mail-done', '已領取'));
    else if (has && !mail.claimed) row.appendChild(clanBtn('領取', 'clan-btn on', () => mailOp(2, mail.id)));
    if (mail.body) row.appendChild(el('div', 'mail-body', mail.body));
    if (has) {
      const list = el('div', 'mail-items');
      for (const it of mail.items) {
        const cell = el('div', 'mail-item');
        cell.append(iconCanvas({ ...it, kind: 'inv' }, 28), el('span', '', `${itemLabel(it)}${it.count > 1 ? ' ×' + fmt(it.count) : ''}`));
        list.appendChild(cell);
      }
      if (mail.gold > 0) list.appendChild(el('div', 'mail-item gold', `金幣 ×${fmt(mail.gold)}`));
      row.appendChild(list);
    }
    body.appendChild(row);
  }
  if (pending) foot.appendChild(clanBtn(`全部領取(${pending})`, 'learn', () => mailOp(3)));
}
$('#btn-mail').onclick = () => togglePanel('mail');

// ---- 血盟(伺服器 C_WebClan / S_WebClan;st.clan 是伺服器送來的整份面板資料)----
const clanOp = (op, a = '', b = '') => send({ t: 'clan', op, a, b });
// 聊天指令改封號(伺服器 C_WebClan setTitle:盟主改成員的;血盟成員改自己的要 altsettings ChangeTitleByOneself 開著;最多 8 個字)
//   /稱號 [顏色] 封號 → 改自己的;/title [顏色] 封號 → 改自己的;/title 角色名 [顏色] 封號 → 原版寫法(盟主改成員的)
//   顏色 = 紅橙黃綠藍靛紫(也可以寫「紅色」),跟血盟面板一樣在封號前面加 \f + 1~7;沒寫顏色就跟名字同色
//   封號寫「清除」= 清掉;沒寫封號 = 顯示用法
function titleCommand(text) {
  const byTitle = /^\/title/i.test(text);
  const words = text.replace(/^\/(稱號|title)/i, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    log(`用法:/稱號 封號 或 /稱號 顏色 封號(顏色:${TITLE_COLORS.map(([n]) => n).join('')};最多 8 個字，血盟成員、沒有血盟的 40 級以上玩家都可以改自己的);/稱號 清除 → 清掉封號;盟主可以 /title 角色名 顏色 封號 改成員的`, 'sys');
    return;
  }
  const colorOf = (w) => TITLE_COLORS.findIndex(([n]) => w === n || w === `${n}色`) + 1; // 0 = 不是顏色
  let name = st.myName;
  if (byTitle && words.length >= 2 && !colorOf(words[0])) name = words.shift(); // /title 角色名 …(第一個字是顏色就當成改自己的)
  const color = words.length >= 2 ? colorOf(words[0]) : 0;
  if (color) words.shift();
  const title = words.join(' ');
  clanOp(7, name, title === '清除' ? '' : color ? `\f${color}${title}` : title);
}
// 危險動作(踢出、退出、解散)按兩下才執行:第一下變成「確定?」,3 秒內再按一次
function confirmBtn(label, cls, onYes) {
  const b = el('button', cls, label);
  b.type = 'button';
  let armed = 0;
  b.onclick = () => {
    if (armed && performance.now() - armed < 3000) { armed = 0; onYes(); return; }
    armed = performance.now();
    b.textContent = '確定?';
    setTimeout(() => { b.textContent = label; }, 3000);
  };
  return b;
}
function clanBtn(label, cls, onClick) { const b = el('button', cls, label); b.type = 'button'; b.onclick = onClick; return b; }
// 盟主上傳盟徽:選圖 → 置中裁成 4:3 → 縮成 16×12 → 每點轉 RGB565 小端(透明 / 洋紅 = 0xF81F)→ 預覽(放大 10 倍)→ 送出 384 bytes(base64);結果由伺服器用系統訊息回(冷卻 / 封鎖 / 非盟主…)
// 盟徽自動去背(hud 上傳端與一次性轉換工具共用同一個函式;hud 的補丁由 build_hud.py 直接把這段原文放進 hud.js)
// 輸入 px = 16×12 的 RGBA(長度 W*H*4,已經縮好的圖);回傳 null(不處理:圖本來就有透明 / 邊框沒有明顯的主色 / 去掉的格數不合理)
// 或 Uint8Array(W*H),1 = 背景(要轉成 0xF81F 透明)。
// 做法:數邊框一圈的像素(RGB565 量化後)找主色 bg;邊框主色要佔邊框 ≥ 40%;從邊框上「和 bg 每個 RGB 通道差 ≤ tol」的像素開始 4 連通向內填色,
// 只吃和 bg 相近且連通到邊框的像素(圖案裡面被圍住的同色不動);去掉的格數 = 0 或超過全圖 85%(整張都是同一色)就不處理。
function emblemFindBg(px, W = 16, H = 12, tol = 24) {
  const N = W * H;
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 128) return null; // 已經有透明:照原樣
  const q = (i) => ((px[i * 4] >> 3) << 11) | ((px[i * 4 + 1] >> 2) << 5) | (px[i * 4 + 2] >> 3);
  const border = [];
  for (let x = 0; x < W; x++) { border.push(x); border.push((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { border.push(y * W); border.push(y * W + W - 1); }
  const cnt = new Map();
  for (const i of border) cnt.set(q(i), (cnt.get(q(i)) || 0) + 1);
  let best = -1, bc = 0;
  for (const [v, c] of cnt) if (c > bc) { bc = c; best = v; }
  if (bc < border.length * 0.4) return null;
  const seed = border.find((i) => q(i) === best);
  const br = px[seed * 4], bg = px[seed * 4 + 1], bb = px[seed * 4 + 2];
  const near = (i) => Math.abs(px[i * 4] - br) <= tol && Math.abs(px[i * 4 + 1] - bg) <= tol && Math.abs(px[i * 4 + 2] - bb) <= tol;
  const mask = new Uint8Array(N);
  const stack = [];
  for (const i of border) if (!mask[i] && near(i)) { mask[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j >= 0 && !mask[j] && near(j)) { mask[j] = 1; stack.push(j); }
    }
  }
  let n = 0;
  for (let i = 0; i < N; i++) n += mask[i];
  if (n === 0 || n > N * 0.85) return null;
  return mask;
}
// 高清(feature-emblemhd,使用者 10/26 定案):剛好 24×18 / 48×36 的圖一格不改(關平滑、不縮放);其他尺寸置中裁 4:3,裁出來寬 ≥ 48 縮成 48×36、否則 24×18。
// 自動去背對高清圖做;16×12(伺服器 / 原版客戶端 / 舊網頁用)由去背後的高清圖平滑縮小。送出 data = 384 bytes(照舊)+ hd = 高清 RGBA(hw×hh×4)
function openEmblemUpload() {
  showDialog('血盟盟徽', '選一張圖:剛好 24×18 或 48×36 的圖會一格不改當高清盟徽;其他尺寸會置中裁成 4:3 再縮小(可以有透明)。上傳後 24 小時內不能再換。');
  const body = $('#dlg-body');
  const file = el('input'); file.type = 'file'; file.accept = 'image/*';
  const PW = 144, PH = 108; // 預覽:24×18 放大 6 倍 / 48×36 放大 3 倍(整數倍,看得到每一格)
  const prev = el('canvas'); prev.width = PW; prev.height = PH; prev.style.cssText = 'display:block;margin:8px 0;image-rendering:pixelated;background:repeating-conic-gradient(#555 0 25%,#777 0 50%) 0 0/16px 16px;border:1px solid #888';
  const prevOrig = el('canvas'); prevOrig.width = PW; prevOrig.height = PH; prevOrig.style.cssText = prev.style.cssText;
  const chkRow = el('label', 'hint'); const chk = el('input'); chk.type = 'checkbox'; chk.checked = true; chkRow.append(chk, ' 自動去背(把邊緣相連的單色底變透明;圖本來就有透明就不處理)');
  const msg = el('p', 'hint', '');
  const go = el('button', 'clan-btn on', '上傳'); go.type = 'button'; go.disabled = true;
  let data = null, hd = null, src = null, hw = 0, hh = 0, exact = false;
  const toCanvas = (px, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0); return c; };
  const show = (cv, px) => { const g = cv.getContext('2d'); g.clearRect(0, 0, PW, PH); g.imageSmoothingEnabled = false; g.drawImage(toCanvas(px, hw, hh), 0, 0, PW, PH); };
  function draw() { // src = 高清 RGBA(hw×hh);預覽 = 原圖(左)/ 去背後(右),實際送出的是去背後(沒勾 = 原圖)
    if (!src) return;
    const N = hw * hh;
    const mask = chk.checked ? emblemFindBg(src, hw, hh) : null;
    const orig = new Uint8ClampedArray(N * 4), fin = new Uint8ClampedArray(N * 4); let n = 0;
    for (let i = 0; i < N; i++) { // 半透明以下 = 透明,其餘不透明(和伺服器存的一樣只有兩種)
      if (src[i * 4 + 3] < 128) continue;
      orig[i * 4] = src[i * 4]; orig[i * 4 + 1] = src[i * 4 + 1]; orig[i * 4 + 2] = src[i * 4 + 2]; orig[i * 4 + 3] = 255;
      if (mask && mask[i]) { n++; continue; }
      fin[i * 4] = orig[i * 4]; fin[i * 4 + 1] = orig[i * 4 + 1]; fin[i * 4 + 2] = orig[i * 4 + 2]; fin[i * 4 + 3] = 255;
    }
    show(prevOrig, orig); show(prev, fin);
    // 16×12 RGB565 小端(透明 = 0xF81F):由去背後的高清圖平滑縮小
    const c = document.createElement('canvas'); c.width = 16; c.height = 12;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(toCanvas(fin, hw, hh), 0, 0, 16, 12);
    const s16 = g.getImageData(0, 0, 16, 12).data;
    const out = new Uint8Array(384);
    for (let i = 0; i < 192; i++) {
      const r = s16[i * 4], gg = s16[i * 4 + 1], b = s16[i * 4 + 2], a = s16[i * 4 + 3];
      let v;
      if (a < 128) v = 0xf81f; else { v = ((r >> 3) << 11) | ((gg >> 2) << 5) | (b >> 3); if (v === 0xf81f) v = 0xf81e; } // 真的洋紅不能被當成透明
      out[i * 2] = v & 255; out[i * 2 + 1] = v >> 8;
    }
    data = out; hd = fin; go.disabled = false;
    msg.textContent = `預覽(高清 ${hw}×${hh}${exact ? ',原圖每一格不變' : ',已裁切縮放'};左 原圖 / 右 去背後)` + (mask ? `:已自動去背 ${n} 格` : chk.checked ? ',沒有可去掉的單色底' : '');
  }
  chk.onchange = draw;
  file.onchange = () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const sw = img.naturalWidth, sh = img.naturalHeight;
      exact = (sw === 24 && sh === 18) || (sw === 48 && sh === 36);
      let cw = sw, ch = Math.round(sw * 3 / 4); if (ch > sh) { ch = sh; cw = Math.round(sh * 4 / 3); } // 置中裁成 4:3
      if (exact) { cw = sw; ch = sh; }
      hw = exact ? sw : cw >= 48 ? 48 : 24; hh = hw * 3 / 4;
      const c = document.createElement('canvas'); c.width = hw; c.height = hh;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (exact) { g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0); } // 原樣,一格不改
      else { g.imageSmoothingEnabled = cw >= hw; g.imageSmoothingQuality = 'high'; g.drawImage(img, Math.floor((sw - cw) / 2), Math.floor((sh - ch) / 2), cw, ch, 0, 0, hw, hh); } // 比 24×18 還小的圖放大:不平滑(不糊)
      src = g.getImageData(0, 0, hw, hh).data;
      draw();
    };
    img.onerror = () => { URL.revokeObjectURL(url); msg.textContent = '這個檔案不是圖片'; };
    img.src = url;
  };
  go.onclick = () => {
    if (!data || !hd) return;
    const b64 = (u8) => { let bin = ''; for (const x of u8) bin += String.fromCharCode(x); return btoa(bin); };
    send({ t: 'emblemupload', data: b64(data), hd: b64(hd), hw, hh });
    toast('盟徽已送出,結果看訊息');
    closeDialog();
  };
  const pair = el('div'); pair.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap'; pair.append(prevOrig, prev);
  body.append(file, pair, chkRow, msg, go);
}
function clanSeenText(seen, now = Date.now()) {
  if (!Number.isFinite(seen) || seen <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - seen) / 60000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return days >= 30 ? '30 天以上' : `${days} 天前`;
}
function renderClan(body, foot) {
  const c = st.clan;
  if (!c) { body.appendChild(el('p', 'empty', '讀取中…')); return; }
  if (c.mode === 'list') {
    if (c.crown) { // 王族:創立血盟
      const box = el('div', 'clan-create');
      const input = el('input');
      input.placeholder = '血盟名稱(最多 10 字)';
      input.maxLength = 10;
      box.append(input, clanBtn(`創立(${fmt(c.cost)} 金幣)`, 'learn', () => {
        const name = input.value.trim();
        if (!name) { toast('請輸入血盟名稱'); return; }
        clanOp(9, name);
      }));
      body.appendChild(box);
    }
    body.appendChild(el('h4', 'clan-h', `血盟列表(${c.clans.length})`));
    if (!c.clans.length) body.appendChild(el('p', 'empty', c.crown ? '目前還沒有血盟,你可以創立第一個。' : '目前還沒有血盟。'));
    for (const k of c.clans) {
      const row = el('div', 'clan-row');
      const info = el('div', 'clan-info');
      const kName = el('b', '', k.name);
      const keid = st.emblem ? st.clanEmblems?.[k.name] : null; // 10/26 使用者:申請入盟的血盟列表,血盟名稱前面顯示盟徽
      if (keid) { const im = el('img'); im.alt = ''; im.style.cssText = 'width:24px;height:18px;image-rendering:pixelated;vertical-align:middle;margin-right:6px'; im.onload = () => { const nw = im.naturalWidth, nh = im.naturalHeight; if (!nh) return; const dpr = window.devicePixelRatio || 1; const k2 = Math.max(1, Math.round((nh > 12 ? 27 : 18) * dpr / nh)); im.style.width = `${nw * k2 / dpr}px`; im.style.height = `${nh * k2 / dpr}px`; }; im.onerror = () => im.remove(); im.src = `/emblem/${keid}.png?v=3`; kName.prepend(im); }
      info.append(kName, el('small', '', `盟主 ${k.leader} · ${k.count} 人${k.auto ? ' · 自動加入' : ''}`));
      row.appendChild(info);
      if (!c.crown || c.crownJoin) { // 王族預設不能加入別的血盟;伺服器 CrownJoinClanEnabled 開了才帶 crownJoin
        row.appendChild(k.applied ? clanBtn('取消申請', 'clan-btn', () => clanOp(2))
          : clanBtn(k.auto ? '加入' : '申請加入', 'clan-btn on', () => clanOp(1, k.name)));
      }
      body.appendChild(row);
    }
    return;
  }
  // 有血盟
  const head = el('div', 'clan-head');
  head.append(el('b', '', c.name), el('small', '', `· 盟主 ${c.leader} · ${c.members.length}${c.max ? ' / ' + c.max : ''} 人`));
  if (st.emblem) { // 盟徽:血盟名旁顯示;盟主(伺服器只認君主 / 聯盟君主)有「盟徽」上傳鈕
    const eid = st.clanEmblems?.[c.name];
    if (eid) {
      const im = el('img', 'clan-emblem'); im.alt = ''; let tries = 0;
      im.onerror = () => { if (tries++ < 3) setTimeout(() => { if (im.isConnected) im.src = `/emblem/${eid}.png?v=3&r=${Date.now()}`; }, 10000); };
      im.onload = () => { im.style.imageRendering = im.naturalWidth > 16 ? 'auto' : 'pixelated'; };
      im.src = `/emblem/${eid}.png?v=3`; head.prepend(im);
    }
    if (c.isLeader) head.appendChild(clanBtn('盟徽', 'clan-btn', () => openEmblemUpload()));
  }
  if (st.clanLoot) head.appendChild(clanBtn('血盟寶庫', 'clan-btn on clan-loot-link', () => window.open('/clanloot.html', '_blank', 'noopener')));
  body.appendChild(head);
  const warBox = el('section', 'clan-wars');
  warBox.appendChild(el('h4', 'clan-h', '宣戰'));
  if (c.isLeader) {
    const form = el('div', 'clan-war-form'), input = el('input');
    input.placeholder = '對方血盟名稱'; input.maxLength = 10;
    input.setAttribute('aria-label', '對方血盟名稱'); input.setAttribute('list', 'clan-war-names');
    const choices = el('datalist'); choices.id = 'clan-war-names';
    for (const name of Object.keys(st.clanEmblems || {})) {
      if (name === c.name) continue;
      const option = el('option'); option.value = name; choices.appendChild(option);
    }
    form.append(input, choices, confirmBtn('宣戰', 'clan-btn danger', () => {
      const name = input.value.trim();
      if (!name) { toast('請輸入對方血盟名稱'); return; }
      clanOp(11, name);
    }));
    warBox.appendChild(form);
  }
  if (!c.wars?.length) warBox.appendChild(el('p', 'empty', '目前沒有宣戰中的血盟'));
  for (const w of c.wars || []) {
    const row = el('div', 'clan-row clan-war-row'), info = el('div', 'clan-info');
    const name = el('b', '', w.name);
    const id = st.emblem ? Number(st.clanEmblems?.[w.name]) : 0;
    if (Number.isSafeInteger(id) && id > 0) {
      const im = el('img', 'clan-war-emblem'); im.alt = '';
      im.onload = () => { if (im.naturalWidth <= 16) im.style.imageRendering = 'pixelated'; };
      im.onerror = () => im.remove(); im.src = emblemImg(id).src; name.prepend(im);
    }
    const hours = Math.max(0, (Date.now() - w.since) / 3600000);
    info.append(name, el('small', '', new Date(w.since).toLocaleString() + ' · 已開戰 ' + Math.floor(hours) + ' 小時'));
    if (w.cease) info.appendChild(el('small', '', w.cease === 'me' ? '我方已提出停戰' : '對方已提出停戰'));
    row.appendChild(info);
    if (c.isLeader) {
      if (!w.canCease && hours < 24) row.appendChild(el('small', '', Math.max(1, Math.ceil(24 - hours)) + ' 小時後可停戰'));
      else {
        const op = w.cease === 'me' ? 14 : w.cease === 'them' ? 13 : 12;
        const label = op === 14 ? '取消提議' : op === 13 ? '同意停戰' : '提出停戰';
        row.appendChild(confirmBtn(label, 'clan-btn', () => clanOp(op, w.name)));
      }
    }
    warBox.appendChild(row);
  }
  body.appendChild(warBox);
  if (c.isLeader) {
    const auto = el('div', 'set-row clan-auto');
    auto.append(el('span', 'set-mid', '自動加入(不用審核,按申請就直接入盟)'));
    const t = toggleButton({ on: c.auto }, 'on', () => clanOp(6, c.auto ? '0' : '1'));
    auto.appendChild(t);
    body.appendChild(auto);
  }
  if ((c.canRecruit ?? c.isLeader) && c.requests?.length) { // 盟主或守護騎士(DESIGN clanrank):收申請
    {
      body.appendChild(el('h4', 'clan-h', `申請加入(${c.requests.length})`));
      for (const r of c.requests) {
        const row = el('div', 'clan-row');
        const info = el('div', 'clan-info');
        info.append(el('b', '', r.name), el('small', '', `Lv.${r.lv} ${CLASSES[r.type]?.name ?? ''}`));
        row.append(info, clanBtn('接受', 'clan-btn on', () => clanOp(3, r.name)), clanBtn('拒絕', 'clan-btn', () => clanOp(4, r.name)));
        body.appendChild(row);
      }
    }
  }
  const sorted = [...c.members].sort((a, b) => (b.leader - a.leader) || (b.lv - a.lv));
  for (const [label, list] of [['線上', sorted.filter((m) => m.online)], ['離線', sorted.filter((m) => !m.online)]]) {
    body.appendChild(el('h4', 'clan-h', `${label}(${list.length})`));
    for (const m of list) {
      const row = el('div', `clan-row clan-member${m.online ? '' : ' off'}`);
      const info = el('div', 'clan-info');
      info.append(el('b', '', (m.leader ? '♛ ' : '') + m.name),
        el('small', '', `Lv.${m.lv} ${CLASSES[m.type]?.name ?? ''}${m.rank === 9 ? ' · 守護騎士' : ''}`)); // 階級:9 = 守護騎士(L1Clan.CLAN_RANK_GUARDIAN)
      if (m.title) { // 封號用它的顏色顯示(1~7 前綴,app.js titleParts)
        const tp = titleParts(m.title);
        const t = el('small', 'clan-title-tag', `「${tp.text}」`);
        if (tp.color) t.style.color = tp.color;
        info.lastChild.append(' · ', t);
      }
      const status = m.online ? (m.ohunt === true ? '離線掛機中' : '') : clanSeenText(m.seen);
      if (status) info.appendChild(el('small', m.online ? 'clan-status hunt' : 'clan-status', status));
      row.appendChild(info);
      const actions = el('div', 'clan-actions');
      if (c.isLeader) {
        actions.appendChild(clanBtn('封號', 'clan-btn', () => {
          const edit = row.querySelector('.clan-title') || (() => {
            const box = el('div', 'clan-title');
            const cur = titleParts(m.title);
            const input = el('input');
            input.maxLength = 8;
            input.value = cur.text;
            input.placeholder = '封號(最多 8 字,空白 = 清除)';
            // 顏色:紅橙黃綠藍靛紫,點一下選
            let color = cur.idx || 1;
            const sw = el('div', 'title-colors');
            TITLE_COLORS.forEach(([nm, hex], i) => {
              const b = el('button', `title-color${i + 1 === color ? ' on' : ''}`, nm);
              b.type = 'button';
              b.style.background = hex;
              b.onclick = () => { color = i + 1; for (const x of sw.children) x.classList.toggle('on', x === b); input.style.color = hex; };
              sw.appendChild(b);
            });
            input.style.color = TITLE_COLORS[color - 1][1];
            box.append(sw, input, clanBtn('確定', 'clan-btn on', () => {
              const text = input.value.trim();
              clanOp(7, m.name, text ? `\f${color}${text}` : ''); // 10/28 原本是換行,封號會變成「3我是女生」
            }));
            row.appendChild(box);
            input.focus();
            return box;
          })();
          edit.querySelector('input').focus();
        }));
        if (!m.leader && (c.rankOn ?? c.myRank !== undefined)) actions.appendChild(confirmBtn(m.rank === 9 ? '取消守護騎士' : '設為守護騎士', 'clan-btn', () => clanOp(10, m.name, m.rank === 9 ? '7' : '9'))); // 設階級:op 10,a = 成員,b = 9 守護騎士 / 7 一般
        if (!m.leader) actions.appendChild(confirmBtn('踢出', 'clan-btn danger', () => clanOp(5, m.name)));
      } else if (c.canKick && !m.leader && m.rank !== 9 && m.type !== 0 && m.name !== self()?.name) { // 守護騎士踢人(ClanGuardianKickEnabled;伺服器給 canKick):不能踢盟主、王族、其他守護騎士
        actions.appendChild(confirmBtn('踢出', 'clan-btn danger', () => clanOp(5, m.name)));
      }
      if (actions.childNodes.length) row.appendChild(actions);
      body.appendChild(row);
    }
  }
  foot.appendChild(confirmBtn(c.isLeader ? '解散血盟' : '退出血盟', 'learn danger', () => clanOp(8)));
}

// 武器損傷度(伺服器物品狀態,protocol.js readItem 的 wdmg):格子右下角紅字「損 N」、外框變紅;每 1 點損傷,攻擊傷害 -1
function wornTag(cell, it) {
  if (!(it?.wdmg > 0)) return;
  cell.classList.add('worn');
  cell.appendChild(el('b', 'worn-tag', `損${it.wdmg}`));
  cell.title += `(損傷度 ${it.wdmg})`;
}
// 強化值(名稱開頭的 +7 / -1):背包格左上角,和角色頁的裝備格一樣(使用者 10/16)
function enhTag(cell, it) {
  const m = /^([+-]\d+)\s/.exec(it?.name || '');
  if (m && +m[1] !== 0) cell.appendChild(el('b', 'enh', m[1]));
}

// ---- 角色 ----
const LEFT_SLOTS = [['helm', '頭盔'], ['T', 'T恤'], ['armor', '盔甲'], ['glove', '手套'], ['belt', '腰帶'], ['boots', '長靴']];
const RIGHT_SLOTS = [['weapon', '武器'], ['shield', '盾牌'], ['cloak', '斗篷'], ['amulet', '項鍊'], ['ring', '戒指'], ['ring2', '戒指']];
// 51 級起每升一級 1 點能力值(伺服器 S_bonusstats → SHOWHTML "RaiseAttr";回 C_Attr 479)。
// 選一項 → 再確認一次(選了不能改)→ 送出;「稍後」關掉的話人物頁留一個按鈕可以再打開。還有剩點數時伺服器會再問一次
const RAISE_STATS = [['str', '力量', 'STR'], ['dex', '敏捷', 'DEX'], ['con', '體質', 'CON'], ['int', '智力', 'INT'], ['wis', '精神', 'WIS'], ['cha', '魅力', 'CHA']];
// ---- 回憶蠟燭重新分配 + 初始能力加成(l1j deploy/plan-charreset/PROTOCOL.md;伺服器 C_WebCharReset opcode 238)----
const CR_NAMES = [['STR', '力量'], ['INT', '智力'], ['WIS', '精神'], ['DEX', '敏捷'], ['CON', '體質'], ['CHA', '魅力']]; // 伺服器順序
let crInfo = null, crTimer = 0, crBusy = false, crMsg = '', crState = null;
function crJson(text, tag) { const t = String(text || ''); if (!t.startsWith(tag)) return undefined; try { return JSON.parse(t.slice(tag.length)); } catch (e) { return null; } }
function openCharReset() {
  if (typeof auto !== 'undefined' && auto.on) stopAuto('開回憶蠟燭視窗'); // 伺服器分不出網頁在跑 AUTO:開視窗前先停
  crInfo = null; crBusy = false; crMsg = ''; crState = null;
  showDialog('回憶蠟燭', '查詢中…');
  dlg.mode = 'charreset';
  send({ t: 'charreset', op: 0 });
  clearTimeout(crTimer);
  crTimer = setTimeout(() => { if (dlg.mode === 'charreset' && !crInfo) { const n = $('#dlg-note'); n.textContent = '沒有收到伺服器回應(這個功能可能還沒開放),請稍後再試。'; n.classList.remove('hidden'); } }, 6000);
}
function onCharReset(j) {
  if (!j) return;
  if (j.t === 'info') { crInfo = j; crMsg = ''; crState = null; if (dlg.mode === 'charreset') renderCharReset(); return; }
  if (j.t !== 'result') return;
  crBusy = false; clearTimeout(crTimer);
  if (j.msg) log(j.msg, j.ok ? 'sys' : 'err');
  if (j.ok) {
    toast('能力值已重新分配');
    if (dlg.mode === 'charreset') { dlg.mode = null; closeDialog(); }
    if (panel.name === 'char') renderPanel();
    return;
  }
  toast(j.msg || '重新分配失敗');
  crMsg = j.msg || '重新分配失敗';
  if (dlg.mode === 'charreset') { if (crInfo) renderCharReset(); else { const n = $('#dlg-note'); n.textContent = crMsg; n.classList.remove('hidden'); } }
}
// 回憶蠟燭重配視窗(10/24 使用者要求:照原版 3.80c 重配介面 deploy/feature-charreset/ui-reference.jpg 改版)。
// 取代 hud.js 的 renderCharReset():上方「剩餘點數 N」,六列 ▼ 數值 ▲,右邊即時顯示該能力的效果,下方 確認 / 取消。
// 數值一律是「最終基本能力」(初始 + 萬能藥 + 升級點數);萬能藥 / 升級點數有的話分步驟,每一步用同一種版面,▼▲ 改的是這一步的那一部分。
// 效果數值來自伺服器實際算法產出的表 CRFX(deploy/feature-charreset/charfx.json,l1j),沒有表 / 缺項就不顯示該行,不自己猜。
const CRFX = {"strDmg":[0,-5,-5,-4,-4,-3,-3,-2,-2,-1,-1,0,0,1,1,2,2,3,3,4,4,5,5,6,6,6,7,7,7,8,8,9,9,10,11,11],"strHit":[0,-2,-2,-2,-2,-2,-2,-2,-2,-1,-1,0,0,1,1,2,2,3,3,4,4,5,5,5,6,6,6,7,7,7,8,8,8,9,9,9],"dexBowDmg":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,3,4,4,4,5,5,5,5,6,6,6,7,7,7,8,8,8,9,9],"dexBowHit":[0,-2,-2,-2,-2,-2,-2,-1,-1,0,0,1,1,2,2,3,3,4,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,19,19],"dexAcDivisor":[0,8,8,8,8,8,8,8,8,8,7,7,7,6,6,6,5,5,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],"wisMr":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,3,6,10,15,21,28,37,47,50,50,50,50,50,50,52,52,52,52,52,55],"intMb":[0,-2,-2,-2,-2,-2,-1,-1,-1,0,0,0,1,1,1,2,2,2,3,4,5,6,7,8,9,10,10,10,10,10,10,10,10,10,10,10],"wisMpr":[0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],"wisPotionMp":[0,1,1,1,1,1,1,1,1,1,1,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25],"hp0":[14,16,15,12,12,16,14],"hpPerLevel":[[0.0,7.485,7.486,7.478,7.482,7.481,7.484,7.484,7.481,7.477,7.486,7.487,7.478,7.481,7.484,7.483,8.483,9.482,10.477,11.485,12.487,13.479,14.482,15.483,16.482,17.485,18.482,19.477,20.485,21.487,22.479,23.481,24.483,25.483,26.484,27.483],[0.0,8.974,8.979,8.974,8.981,8.974,8.977,8.98,8.974,8.979,8.973,8.982,8.976,8.977,8.974,8.98,9.976,10.979,11.975,12.975,13.98,14.973,15.984,16.973,17.977,18.978,19.977,20.978,21.974,22.978,23.979,24.976,25.975,26.979,27.977,28.977],[0.0,7.482,7.485,7.483,7.48,7.481,7.484,7.485,7.48,7.481,7.482,7.484,7.484,7.481,7.478,7.486,8.486,9.478,10.482,11.483,12.482,13.484,14.482,15.478,16.485,17.487,18.479,19.48,20.483,21.482,22.485,23.482,24.477,25.486,26.487,27.479],[0.0,4.491,4.488,4.49,4.488,4.489,4.489,4.486,4.491,4.486,4.491,4.488,4.491,4.487,4.488,4.49,5.486,6.491,7.487,8.491,9.488,10.491,11.486,12.488,13.491,14.486,15.49,16.489,17.49,18.489,19.49,20.487,21.488,22.491,23.486,24.491],[0.0,7.479,7.482,7.482,7.483,7.484,7.482,7.477,7.486,7.487,7.478,7.482,7.483,7.482,7.483,7.482,8.478,9.484,10.487,11.479,12.482,13.483,14.482,15.485,16.482,17.477,18.485,19.487,20.479,21.481,22.482,23.483,24.484,25.483,26.477,27.484],[0.0,13.498,13.496,13.501,13.496,13.497,13.498,13.498,13.5,13.496,13.497,13.497,13.501,13.496,13.497,13.497,14.499,15.499,16.497,17.496,18.497,19.501,20.496,21.497,22.498,23.498,24.499,25.497,26.497,27.496,28.501,29.497,30.497,31.497,32.498,33.5],[0.0,9.496,9.496,9.497,9.5,9.498,9.497,9.497,9.497,9.501,9.497,9.497,9.497,9.5,9.498,9.497,10.497,11.497,12.5,13.497,14.496,15.497,16.499,17.499,18.496,19.497,20.497,21.501,22.497,23.497,24.497,25.499,26.5,27.495,28.498,29.496]],"mp0":[[0,2,2,2,2,2,2,2,2,2,2,2,3,3,3,3,4,4,4,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,1,1,1,1,1,1,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,6,6,6,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],[0,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,8,8,8,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6],[0,3,3,3,3,3,3,3,3,3,3,3,4,4,4,4,6,6,6,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,6,6,6,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5]],"mpPerLevel":[[0.0,1.493,1.491,1.497,1.497,1.496,1.491,1.495,1.496,1.997,2.493,2.491,2.995,2.996,2.995,3.99,3.992,3.996,4.494,4.487,4.485,5.489,5.493,5.493,5.986,6.487,6.492,6.993,6.988,7.485,7.489,7.995,7.992,8.485,8.486,8.996],[0.0,0.496,0.494,0.497,0.495,0.498,0.496,0.494,0.499,0.992,1.498,1.495,1.667,1.665,1.666,2.329,2.327,2.327,2.745,2.747,2.737,3.248,3.242,3.251,3.594,3.993,3.998,4.395,4.395,4.742,4.739,4.993,4.994,5.25,5.241,5.597],[0.0,1.99,1.983,1.99,1.992,1.993,1.987,1.981,1.994,2.664,3.495,3.492,4.32,4.325,4.326,5.656,5.652,5.663,6.489,6.486,6.48,7.982,7.989,7.99,8.778,9.478,9.485,10.194,10.188,10.977,10.98,11.792,11.786,12.482,12.476,13.189],[0.0,2.991,2.992,2.993,2.99,2.993,2.99,2.996,2.989,4.002,4.992,4.991,6.002,5.996,6.002,7.994,8.007,7.995,8.989,8.991,8.985,10.991,10.983,10.994,11.993,12.995,12.987,13.999,14.004,14.985,14.992,15.992,16.003,16.982,16.995,17.997],[0.0,1.993,1.993,1.991,1.983,1.99,1.992,1.994,1.986,2.652,3.496,3.497,4.323,4.315,4.32,5.662,5.664,5.655,6.478,6.483,6.491,7.987,7.978,7.98,8.79,9.491,9.482,10.178,10.19,10.99,10.991,11.776,11.78,12.49,12.489,13.181],[0.0,0.495,0.495,0.495,0.494,0.495,0.494,0.494,0.495,0.992,1.496,1.495,1.664,1.666,1.666,2.326,2.328,2.328,2.739,2.742,2.739,3.244,3.243,3.246,3.596,3.993,3.996,4.391,4.396,4.739,4.742,4.991,4.996,5.245,5.242,5.595],[0.0,1.988,1.993,1.987,1.99,1.986,1.993,1.989,1.988,2.985,3.987,3.992,4.659,4.656,4.657,6.324,6.321,6.321,7.231,7.221,7.236,8.731,8.736,8.728,9.59,10.488,10.483,11.388,11.378,12.234,12.228,12.983,12.982,13.734,13.739,14.583]],"orig":{"Dmgup":[[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"Hitup":[[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4]],"BowDmgup":[[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],"BowHitup":[[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],"Ac":[[0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"Hpup":[[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"Hpr":[[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,3,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"MagicHit":[[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,2,2,3,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]],"MagicDamage":[[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],"Mpup":[[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"Mpr":[[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]],"Mr":[[0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]]}};
const CR_ORDER = [0, 3, 4, 1, 2, 5]; // 畫面順序 STR DEX CON INT WIS CHA → 伺服器索引(STR INT WIS DEX CON CHA)
// 每一項能力右邊的效果(l1j deploy/plan-charreset/FORMULAS.md + charfx.json:伺服器現成方法 / 表產生的,只看基本能力,不含裝備 / 魔法 / 料理):
// 能力值 = 最終基本能力 fin[i];「初始加成」(CRFX.orig.X[職業][初始能力值])看的是初始能力 init[i](不是最終)。負重不顯示(prod RateWeightLimit = 0,不計重量)。
// 伺服器索引:0 STR 1 INT 2 WIS 3 DEX 4 CON 5 CHA。表缺項就不顯示該行。
const CR_CLASS_MR = [10, 0, 25, 15, 10, 18, 20]; // 職業基本 MR:王族 騎士 妖精 法師 黑妖 龍騎 幻術(FORMULAS.md)
// 升級點數的送出順序(伺服器索引 0 STR 1 INT 2 WIS 3 DEX 4 CON 5 CHA):體質 → 精神 → 力量 → 智力 → 敏捷 → 魅力;預覽與送出共用
const CR_UP_ORDER = [4, 2, 0, 1, 3, 5];
const CR_CAP_HPMP = [[1400, 800], [2000, 600], [1400, 900], [1000, 1200], [1400, 900], [1800, 600], [1100, 1100]]; // 職業上限 HP / MP(charsettings)
// 平均 HP / MP:2..50 級用初始 CON / WIS;51 級起第 lv 級擲骰時的能力 = 初始 + 前面 51..lv−1 級的加點(順序 = 實際送出的升級加點順序:力量、智力、精神、敏捷、體質、魅力);萬能藥最後才加,不影響
function crAvgHpMp(T, L, init, up) {
  const F = CRFX;
  const ups = []; for (const i of CR_UP_ORDER) for (let k = 0; k < up[i]; k++) ups.push(i);
  const cnt = [0, 0, 0, 0, 0, 0];
  let hp = F.hp0 && F.hp0[T], mp = F.mp0 && F.mp0[T] && F.mp0[T][init[2]];
  if (hp === undefined || mp === undefined) return null;
  const hpup = T >= 5 ? ((F.orig.Hpup[T] || [])[init[4]] || 0) : 0, mpup = (F.orig.Mpup[T] || [])[init[2]] || 0; // Hpup 只有龍騎 / 幻術吃;Mpup 全職業吃
  for (let lv = 2; lv <= L; lv++) {
    if (lv >= 52 && ups[lv - 52] !== undefined) cnt[ups[lv - 52]]++; // 第 lv 級擲骰前,51..lv−1 級的點已加上
    const con = init[4] + cnt[4], wis = init[2] + cnt[2];
    const h = F.hpPerLevel[T][Math.min(35, con)], m = F.mpPerLevel[T][Math.min(35, wis)];
    if (h === undefined || m === undefined) return null;
    hp += h + hpup; mp += m + mpup;
  }
  const cap = CR_CAP_HPMP[T] || [99999, 99999];
  return { hp: Math.min(cap[0], Math.round(hp)), mp: Math.min(cap[1], Math.round(mp)) };
}
function crFxLines(idx, fin, info, init, up, j) {
  const F = CRFX;
  if (!F) return [];
  const T = info.type, L = info.level;
  const at = (arr, v) => (Array.isArray(arr) && arr[v] !== undefined ? arr[v] : null);
  const ob = (name, i) => { const r = F.orig && F.orig[name] && F.orig[name][T]; return r && r[init[i]] !== undefined ? r[init[i]] : 0; }; // 初始加成:依「初始」能力值
  const out = [];
  const add = (label, val) => { if (val !== null && val !== undefined && !Number.isNaN(val)) out.push([label, String(val)]); };
  const str = fin[0], intl = fin[1], wis = fin[2], dex = fin[3], con = fin[4];
  if (idx === 0) {
    const d = at(F.strDmg, str), h = at(F.strHit, str);
    add('近距離傷害', d === null ? null : d + ob('Dmgup', 0) + (T === 3 && str > 12 ? Math.trunc((str - 12) / 3) : 0)); // 法師 STR > 12 每 3 點再 +1(prod MageStrDmgThreshold 12 / Step 3)
    add('近距離命中', h === null ? null : h + ob('Hitup', 0));
  } else if (idx === 3) {
    const d = at(F.dexBowDmg, dex), h = at(F.dexBowHit, dex), k = at(F.dexAcDivisor, dex);
    add('遠距離傷害', d === null ? null : d + ob('BowDmgup', 3));
    add('遠距離命中', h === null ? null : h + ob('BowHitup', 3));
    add('物理防禦力(AC)', k === null ? null : 10 - Math.trunc(L / k) - ob('Ac', 3));
  } else if (idx === 4) {
    const av = crAvgHpMp(T, L, init, up);
    add('目前等級平均體力', av ? av.hp : null);
    const m = L > 11 && con >= 14 ? (con > 25 ? 14 : con - 12) : 1, hpr = ob('Hpr', 4);
    add('體力恢復(回)', m + hpr > 1 + hpr ? `${1 + hpr}~${m + hpr}` : String(1 + hpr));
  } else if (idx === 1) {
    const x = Math.max(1, intl - 12) * 3 / 32 * 100; // 魔法傷害係數 1 + max(1, INT − 12) × 3/32(沒裝備 SP)
    const md = ob('MagicDamage', 1);
    add('增加魔法傷害', `+${Math.round(x)}%${md ? ` +${md}` : ''}`);
    add('增加魔法命中', ob('MagicHit', 1));
    add('魔法加成(MB)', at(F.intMb, intl));
  } else if (idx === 2) {
    const av = crAvgHpMp(T, L, init, up);
    add('目前等級平均魔力', av ? av.mp : null);
    const r = at(F.wisMpr, wis);
    add('魔力恢復(回)', r === null ? null : r + ob('Mpr', 2));
    add('藥水魔力恢復(回)', at(F.wisPotionMp, wis));
    const mr = at(F.wisMr, wis);
    add('魔法防禦(MR)', mr === null ? null : CR_CLASS_MR[T] + mr + Math.trunc(L / 2) + ob('Mr', 2));
  }
  return out;
}
// ▼ / ▲ 按鈕:按一下加減一格;按住 0.4 秒後連續加減(每 70 ms)。onStep() 回 true = 有動,繼續;false = 到底了,停
function crHoldBtn(txt, onStep) {
  const b = el('button', 'cr-step secondary', txt);
  b.type = 'button';
  b.style.cssText = 'width:36px;height:36px;min-height:0;padding:0;font-size:13px;line-height:1;border-radius:6px;touch-action:manipulation;flex:none';
  let t1 = 0, t2 = 0;
  const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = 0; };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (b.disabled) return;
    stop();
    if (!onStep()) return;
    t1 = setTimeout(() => { t2 = setInterval(() => { if (!onStep() || b.disabled) stop(); }, 70); }, 400);
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) b.addEventListener(t, stop);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!b.disabled) onStep(); } });
  return b;
}
let crDlgWatch = null;
function crTallDialog() { // 這個視窗比一般對話框高:放寬高度;換成別的對話框 / 關掉就還原
  const d = $('#dialog');
  d.style.maxHeight = '90dvh';
  if (crDlgWatch) return;
  const undo = () => { if (dlg.mode !== 'charreset' || d.classList.contains('hidden')) { d.style.maxHeight = ''; crDlgWatch.disconnect(); crDlgWatch = null; } };
  crDlgWatch = new MutationObserver(undo);
  crDlgWatch.observe($('#dlg-title'), { childList: true, characterData: true, subtree: true });
  crDlgWatch.observe(d, { attributes: true, attributeFilter: ['class'] });
}
function renderCharReset() {
  const j = crInfo;
  const body = $('#dlg-body');
  body.innerHTML = '';
  const note = $('#dlg-note');
  note.textContent = '';
  note.classList.add('hidden');
  crTallDialog();
  const total = j.total, cap = j.cap, elixir = j.elixir | 0, bonus = j.bonus | 0;
  // 一打開照原版流程:每項從職業最低值開始,剩餘點數 = 總點數 − 最低值合計;萬能藥 / 升級點數從 0 開始(「還原成目前」一鍵帶回目前配點)
  if (!crState) crState = { init: j.min.slice(), elx: [0, 0, 0, 0, 0, 0], up: [0, 0, 0, 0, 0, 0], step: 0, confirming: false };
  const S = crState;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const finals = () => S.init.map((v, i) => v + S.elx[i] + S.up[i]);
  const info = { type: j.type, level: j.level };
  const send1 = () => {
    if (crBusy) return;
    const ups = [];
    for (const i of CR_UP_ORDER) for (let k = 0; k < S.up[i]; k++) ups.push(i + 1);
    crBusy = true; crMsg = '';
    send({ t: 'charreset', op: 1, orig: S.init.slice(), elixir: S.elx.slice(), ups });
    clearTimeout(crTimer);
    crTimer = setTimeout(() => { if (crBusy) { crBusy = false; S.confirming = false; renderCharReset(); toast('沒有收到伺服器回應'); } }, 8000);
    renderCharReset();
  };
  const GOLD = '#f2c55c';
  // ---- 第二段確認:重擲 HP / MP、扣蠟燭、安全區限制(主畫面不放說明,按「確認」後才看到)----
  if (S.confirming) {
    const box = el('div', '');
    box.style.cssText = 'padding:6px 4px 10px;font-size:14px;line-height:1.7';
    const t = el('b', '', '確定要重新分配嗎?');
    t.style.cssText = `display:block;font-size:17px;color:${GOLD};margin-bottom:6px`;
    box.appendChild(t);
    const av = crAvgHpMp(j.type, j.level, S.init, S.up);
    const lines = ['HP / MP 會從 1 級起逐級重新擲骰(可能變高也可能變低)'];
    if (av && typeof j.hp === 'number') lines.push(`目前 HP ${j.hp} / MP ${j.mp};重配後平均約 HP ${av.hp} / MP ${av.mp}(實際會隨機上下)`);
    lines.push(`扣 1 根回憶蠟燭(目前 ${j.candles} 根)`, '初始能力加成依新的初始能力重新計算', '只能在安全區使用,不能在 AUTO / 離線掛機 / 交易中');
    for (const line of lines) box.appendChild(el('div', '', `· ${line}`));
    body.appendChild(box);
    const row2 = el('div', 'yn-row');
    const back = el('button', 'yn-no', '返回');
    back.type = 'button';
    back.disabled = crBusy;
    back.onclick = () => { S.confirming = false; renderCharReset(); };
    const go = el('button', 'yn-yes', crBusy ? '處理中…' : '確定重新分配');
    go.type = 'button';
    go.disabled = crBusy || !j.can || j.candles < 1;
    go.style.opacity = go.disabled ? '.45' : '1';
    go.onclick = send1;
    row2.append(back, go);
    body.appendChild(row2);
    if (crMsg) { const bad = el('p', 'yn-text', crMsg); bad.style.color = '#ff9a8a'; body.appendChild(bad); }
    return;
  }
  const steps = [['init', '初始能力']];
  if (elixir > 0) steps.push(['elx', '萬能藥點數']);
  if (bonus > 0) steps.push(['up', `升級點數(51 級起 ${bonus} 點)`]);
  if (S.step >= steps.length) S.step = 0;
  const cur = steps[S.step][0];
  const arr = cur === 'init' ? S.init : cur === 'elx' ? S.elx : S.up;
  const want = cur === 'init' ? total : cur === 'elx' ? elixir : bonus;

  if (!j.can || crMsg) { const bad = el('p', 'yn-text', crMsg || j.msg || '現在不能重新分配'); bad.style.cssText = 'margin:0 0 4px;color:#ff9a8a'; body.appendChild(bad); }
  // 最上面:剩餘點數(大字金色)+ 右邊小字「還原成目前」;多步驟時下面一行小字寫第幾步
  const headBox = el('div', '');
  headBox.style.cssText = 'margin:0 0 2px;padding:0 2px 4px;border-bottom:1px solid rgba(216,180,106,.35)';
  const top = el('div', '');
  top.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px';
  const remainT = el('b', '', '');
  remainT.style.cssText = `font-size:22px;line-height:1.2;color:${GOLD};font-weight:700`;
  const cur0 = el('button', '', '還原成目前');
  cur0.type = 'button';
  cur0.style.cssText = 'min-height:0;height:26px;padding:0 4px;font-size:12px;background:none;border:0;border-bottom:1px dotted #c9b48a;border-radius:0;color:#c9b48a;flex:none';
  cur0.onclick = () => { // 目前的配點:初始 = 目前初始能力;基本 − 初始 的差額先填萬能藥、再填升級點數
    const init = j.orig.slice(); const elx = [0, 0, 0, 0, 0, 0]; const up = [0, 0, 0, 0, 0, 0];
    let left = elixir;
    for (let i = 0; i < 6; i++) { const extra = Math.max(0, (j.base[i] ?? j.orig[i]) - j.orig[i]); const e = Math.min(left, extra); elx[i] = e; left -= e; up[i] = extra - e; }
    crState = { init, elx, up, step: S.step, confirming: false };
    renderCharReset();
  };
  top.append(remainT, cur0);
  headBox.appendChild(top);
  if (steps.length > 1) { const stepT = el('div', '', `第 ${S.step + 1}/${steps.length} 步:${steps[S.step][1]}`); stepT.style.cssText = 'font-size:12px;color:#c9b48a;margin-top:1px'; headBox.appendChild(stepT); }
  body.appendChild(headBox);

  const valEls = [], fxEls = [], upBtns = [], dnBtns = [];
  const list = el('div', '');
  for (const i of CR_ORDER) {
    const row = el('div', '');
    row.style.cssText = 'display:grid;grid-template-columns:62px 112px 1fr;gap:0 6px;align-items:center;height:62px;box-sizing:border-box;border-bottom:1px solid rgba(90,70,38,.35)';
    const nm = el('div', '');
    nm.style.cssText = 'font-size:13px;line-height:1.2;white-space:nowrap';
    nm.textContent = `${CR_NAMES[i][1]} ${CR_NAMES[i][0]}`;
    const ctl = el('div', '');
    ctl.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
    const lo = () => (cur === 'init' ? j.min[i] : 0);
    const dn = crHoldBtn('▼', () => { if (arr[i] <= lo()) return false; arr[i]--; crRefresh(); return true; });
    const up = crHoldBtn('▲', () => {
      if (arr[i] >= (cur === 'init' ? j.max[i] : want) || sum(arr) >= want || finals()[i] >= cap) return false;
      arr[i]++; crRefresh(); return true;
    });
    const v = el('b', '', '');
    v.style.cssText = 'min-width:28px;text-align:center;font-size:16px';
    ctl.append(dn, v, up);
    const fx = el('div', '');
    fx.style.cssText = 'font-size:12px;line-height:15px;min-width:0;display:flex;flex-direction:column;justify-content:center;height:100%';
    row.append(nm, ctl, fx);
    list.appendChild(row);
    valEls[i] = v; fxEls[i] = fx; upBtns[i] = up; dnBtns[i] = dn;
  }
  body.appendChild(list);
  // 下方按鈕:取消(左)/ 上一步 / 下一步 或 確認(確認 → 第二段確認畫面)
  const actions = el('div', 'yn-row');
  actions.style.cssText = 'position:sticky;bottom:0;padding:8px 0 2px;background:#14110c';
  const cancel = el('button', 'yn-no', '取消');
  cancel.type = 'button';
  cancel.onclick = () => { crState = null; dlg.mode = null; closeDialog(); };
  actions.appendChild(cancel);
  if (S.step > 0) { const back = el('button', 'secondary', '上一步'); back.type = 'button'; back.onclick = () => { S.step--; renderCharReset(); }; actions.appendChild(back); }
  const last = S.step >= steps.length - 1;
  const nextBtn = el('button', 'yn-yes', last ? '確認' : '下一步');
  nextBtn.type = 'button';
  nextBtn.onclick = () => { if (nextBtn.disabled) return; if (last) { S.confirming = true; renderCharReset(); } else { S.step++; renderCharReset(); } };
  actions.appendChild(nextBtn);
  body.appendChild(actions);

  function crRefresh() {
    const fin = finals();
    const left = want - sum(arr);
    remainT.textContent = `剩餘點數 ${left}`;
    remainT.style.color = left === 0 ? '#9fd38b' : GOLD;
    for (const i of CR_ORDER) {
      valEls[i].textContent = String(fin[i]);
      valEls[i].style.color = fin[i] > cap ? '#ff7a6a' : '#ffe08a';
      const dis = (b, d) => { b.disabled = d; b.style.opacity = d ? '.3' : '1'; };
      dis(dnBtns[i], arr[i] <= (cur === 'init' ? j.min[i] : 0));
      dis(upBtns[i], arr[i] >= (cur === 'init' ? j.max[i] : want) || left <= 0 || fin[i] >= cap);
      fxEls[i].innerHTML = '';
      for (const [label, text, sub] of crFxLines(i, fin, info, S.init, S.up, j)) {
        const line = el('div', '');
        line.style.cssText = 'display:flex;justify-content:space-between;gap:4px;white-space:nowrap';
        const a = el('span', '', label); a.style.cssText = 'color:#c9b48a;overflow:hidden;text-overflow:ellipsis';
        const b = el('b', '', text); b.style.cssText = 'color:#ffe08a;font-weight:400;text-align:right;flex:none';
        if (sub) { const d = el('small', '', ` ${sub}`); d.style.cssText = `font-size:11px;color:${sub[0] === '+' ? '#9fd38b' : '#ff9a8a'}`; b.appendChild(d); }
        line.append(a, b);
        fxEls[i].appendChild(line);
      }
    }
    // 這一步分完才能下一步 / 確認;確認還要三部分都分完、沒有超過上限、伺服器說現在可以
    const allOk = sum(S.init) === total && sum(S.elx) === elixir && sum(S.up) === bonus && fin.every((x) => x <= cap);
    const can = left === 0 && (!last ? fin.every((x) => x <= cap) : allOk && j.can && j.candles > 0 && !crBusy);
    nextBtn.disabled = !can;
    nextBtn.style.opacity = can ? '1' : '.45';
  }
  crRefresh();
}
// 人物頁:初始能力加成(伺服器 ##ORIGBONUS##:原版 3.80c resetOriginal* 算出來的值;0 的不列)
const OB_ROWS = [['dmg', '近戰額外傷害', '+'], ['hit', '近戰命中', '+'], ['bowdmg', '遠距離額外傷害', '+'], ['bowhit', '遠距離命中', '+'], ['mr', '魔法防禦 MR', '+'], ['ac', '防禦 AC', '-'], ['er', '迴避 ER', '+'],
  ['hpr', 'HP 回復量', '+'], ['mpr', 'MP 回復量', '+'], ['mhit', '魔法命中', '+'], ['mcrit', '魔法暴擊率', '+%'], ['mdmg', '魔法傷害', '+'], ['mpcut', 'MP 消耗減少', '-'],
  ['wstr', '負重減輕(力量)', '+'], ['wcon', '負重減輕(體質)', '+'], ['hpup', '升級 HP 加成', '+'], ['mpup', '升級 MP 加成', '+']];
function renderOrigBonus(body) {
  const b = st.origBonus;
  if (!b || b.who !== st.myName) return; // 換角色後不顯示上一隻的(開關關著時登入不會重送)
  const box = el('div', 'orig-bonus');
  box.style.cssText = 'margin-top:8px;padding:6px 8px;border:1px solid rgba(216,180,106,.35);border-radius:6px;font-size:12px';
  const t = el('b', '', '初始能力加成');
  t.style.cssText = 'display:block;color:#f2c55c;margin-bottom:3px';
  box.appendChild(t);
  if (Array.isArray(b.orig)) { const o = el('div', 'hint'); o.style.margin = '0 0 3px'; o.textContent = `初始能力 ${CR_NAMES.map(([a], i) => `${a} ${b.orig[i]}`).join(' / ')}`; box.appendChild(o); }
  const dl = el('dl', 'char-stats');
  let n = 0;
  for (const [k, label, sign] of OB_ROWS) { if (!b[k]) continue; dl.appendChild(el('dt', '', label)); dl.appendChild(el('dd', '', `${sign}${b[k]}`.replace('+%', '+') + (sign === '+%' ? '%' : ''))); n++; }
  if (n) box.appendChild(dl); else box.appendChild(el('div', 'hint', '目前沒有任何加成'));
  body.appendChild(box);
}
function openRaiseAttr(pick) {
  const m = st.me || {};
  showDialog('能力值提升', '');
  dlg.mode = 'raiseattr';
  const body = $('#dlg-body');
  if (!pick) {
    body.appendChild(el('p', 'yn-text', `Lv.${m.level ?? ''}:獲得 1 點能力值,請選擇要提升的項目(單項最高 35)`));
    const grid = el('div', 'raise-grid');
    for (const [key, label, abbr] of RAISE_STATS) {
      const v = m[key] ?? 0;
      const b = el('button', 'raise-btn');
      b.type = 'button';
      b.append(el('span', 'raise-name', label), el('span', 'raise-val', `${abbr} ${v} → ${v + 1}`));
      b.onclick = () => openRaiseAttr(key);
      grid.appendChild(b);
    }
    body.appendChild(grid);
    const later = el('button', 'raise-later', '稍後再分配');
    later.type = 'button';
    later.onclick = () => { dlg.mode = null; closeDialog(); toast('可以在人物頁再打開能力值分配'); };
    body.appendChild(later);
    return;
  }
  const [, label] = RAISE_STATS.find(([k]) => k === pick);
  body.appendChild(el('p', 'yn-text', `確定要提升「${label}」嗎?\n分配後不能更改。`));
  const row = el('div', 'yn-row');
  const no = el('button', 'yn-no', '返回');
  const ok = el('button', 'yn-yes', `提升${label}`);
  no.type = ok.type = 'button';
  no.onclick = () => openRaiseAttr();
  ok.onclick = () => {
    send({ t: 'raiseattr', stat: pick });
    st.raisePending = false; // 還有剩的話伺服器會再送一次 RaiseAttr
    dlg.mode = null;
    closeDialog();
    if (panel.name === 'char') renderPanel();
  };
  row.append(no, ok);
  body.appendChild(row);
}
// 排行榜(人物頁的分頁):四大職業 / 血盟各前 10 名,gateway 查 DB(快取 10 分鐘)
const RANK_CLASSES = [[2, '妖精'], [1, '騎士'], [3, '法師'], [0, '王族'], ['clans', '血盟']];
let rankClass = 2;
let rankAskedAt = -Infinity;
setInterval(() => {
  if (st.inGame && st.pkRank && panel.name === 'char' && panel.tab === 'rank' && performance.now() - rankAskedAt >= 30000) {
    rankAskedAt = performance.now(); send({ t: 'ranking' });
  }
}, 30000);
function renderPkRanking(body, data) {
  if (!data?.pk) { body.appendChild(el('div', 'rank-empty', '殺人榜暫時無法讀取，請稍後再試')); return; }
  const table = el('div', 'rank-list');
  const types = ['王族', '騎士', '妖精', '法師', '黑暗妖精', '龍騎士', '幻術士'];
  for (const r of data.pk.list) {
    const row = el('div', `rank-row${r.n === st.myName ? ' me' : ''}`);
    row.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
    row.appendChild(el('span', `rank-no${r.rank <= 3 ? ` top${r.rank}` : ''}`, String(r.rank)));
    const name = el('span', 'rank-name', r.n);
    name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.title = r.n;
    row.append(name, el('small', '', types[r.t] || '—'), el('span', 'rank-lv', `${r.k} 殺`));
    table.appendChild(row);
  }
  if (!data.pk.list.length) table.appendChild(el('div', 'rank-empty', '最近 7 天還沒有算數的擊殺'));
  body.appendChild(table);
  const me = data.pkMine;
  body.appendChild(el('div', 'rank-pk-mine', me ? `我的：最近 7 天擊殺 ${me.k}、${me.rank ? `排名第 ${me.rank}` : '未上榜'}、${me.need ? `再 ${me.need} 殺可進前三` : '已在前三名'}` : '我的：暫時無法讀取'));
  body.appendChild(el('div', 'rank-time', `最近 7 天算數擊殺 · 前十名最多快取 60 秒 · 更新 ${new Date(data.pk.at).toLocaleTimeString()}`));
}
function renderRanking(body) {
  const now = performance.now();
  if (now - rankAskedAt > 30000) { rankAskedAt = now; send({ t: 'ranking' }); } // 打開或切回來時跟 gateway 要最新的
  const back = el('button', 'rank-back', '‹ 返回裝備');
  back.type = 'button';
  back.onclick = () => { panel.tab = 'equip'; renderPanel(); };
  body.appendChild(back);
  const tabs = el('div', 'rank-tabs');
  const choices = [...(st.ranking ? RANK_CLASSES : []), ...(st.pkRank ? [['pk', '殺人']] : [])];
  if (!choices.some(([type]) => type === rankClass)) rankClass = choices[0]?.[0];
  tabs.style.cssText = `display:grid;grid-template-columns:repeat(${choices.length || 1},minmax(0,1fr))`;
  for (const [type, label] of choices) {
    const b = el('button', type === rankClass ? 'on' : '', label);
    b.type = 'button';
    b.style.cssText = 'min-width:0;padding-left:0;padding-right:0;white-space:nowrap';
    b.onclick = () => { rankClass = type; if (type === 'pk') rankAskedAt = -Infinity; renderPanel(); };
    tabs.appendChild(b);
  }
  body.appendChild(tabs);
  const data = st.rankingData;
  if (!data) { body.appendChild(el('div', 'rank-empty', '讀取中…')); return; }
  if (rankClass === 'pk') { renderPkRanking(body, data); return; }
  if (!data.classes) { body.appendChild(el('div', 'rank-empty', '暫時無法讀取')); return; }
  const isClan = rankClass === 'clans';
  const list = (isClan ? data.clans : data.classes?.[rankClass]) || [];
  if (!list.length) { body.appendChild(el('div', 'rank-empty', '目前沒有資料')); return; }
  const me = $('#hud-name').textContent;
  const table = el('div', 'rank-list');
  list.forEach((r, i) => {
    const row = el('div', `rank-row${!isClan && r.n === me ? ' me' : ''}`);
    row.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
    const no = el('span', `rank-no${i < 3 ? ` top${i + 1}` : ''}`, String(i + 1));
    no.style.cssText = 'flex:0 0 18px';
    row.appendChild(no);
    if (st.emblem) {
      const badge = el('span', 'rank-emblem');
      // 盟徽和名牌同比例(16×12);電腦 / 橫式字小,原尺寸,手機直式稍大 20×15(使用者 10/28:24×18 在電腦版太大)
      const [ew, eh] = document.documentElement.classList.contains('land') ? [16, 12] : [20, 15];
      badge.style.cssText = `flex:0 0 ${ew}px;width:${ew}px;height:${eh}px;align-self:center`;
      const id = Number(r.emblem_id);
      // 只用 clan_data 的有效正整數 id;開關關閉時連 emblemImg 都不呼叫。
      if (Number.isSafeInteger(id) && id > 0 && r.clan_name) {
        const im = el('img');
        im.alt = '';
        im.style.cssText = `display:block;width:${ew}px;height:${eh}px`;
        im.onload = () => { if (im.naturalWidth <= 16) im.style.imageRendering = 'pixelated'; }; // 舊 16×12 放大用格點;高清圖縮小用平滑
        im.onerror = () => im.remove(); // 檔案不存在時保留等寬空白
        im.src = emblemImg(id).src;
        badge.appendChild(im);
      }
      row.appendChild(badge);
    }
    const name = el('span', 'rank-name', isClan ? r.clan_name : r.n);
    name.style.cssText = 'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.title = isClan ? r.clan_name : r.n;
    if (isClan) {
      const leader = el('small', 'rank-leader', `盟主 ${r.leader_name || ''}`);
      leader.style.cssText = 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      leader.title = leader.textContent;
      name.appendChild(leader);
    }
    const value = el('span', 'rank-lv', isClan ? `${r.count} 人` : `Lv.${r.lv}`);
    value.style.cssText = 'flex:0 0 auto;white-space:nowrap';
    row.append(name, value);
    table.appendChild(row);
  });
  body.appendChild(table);
  const t = new Date(data.at);
  body.appendChild(el('div', 'rank-time', `更新時間 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`));
}
function renderChar(body) {
  // 排行榜不用分頁列(會把人物頁擠小):名稱旁的小按鈕切過去,排行榜頁有「返回裝備」
  if ((st.ranking || st.pkRank) && panel.tab === 'rank') { renderRanking(body); return; }
  const m = st.me || {};
  const equipped = {};
  for (const it of st.inv.values()) {
    if (!isEquipped(it)) continue;
    let slot = equipSlot(it);
    if (slot === 'ring' && equipped.ring) slot = 'ring2';
    if (slot === 'helm' && isMagicHelm(it)) slot = equipped.helmA ? 'helmB' : 'helmA';
    if (slot) equipped[slot] = it;
  }
  const head = el('div', 'char-head', `${$('#hud-name').textContent} Lv.${m.level ?? 1} ${CLASSES[st.myType]?.name ?? ''}`);
  if (st.ranking || st.pkRank) {
    const rb = el('button', 'rank-open', '排行榜');
    rb.type = 'button';
    rb.onclick = () => { panel.tab = 'rank'; renderPanel(); };
    head.appendChild(rb);
  }
  body.appendChild(head);
  const t = st.game.expTable;
  const next = t[m.level ?? 1];
  body.appendChild(el('div', 'char-exp', `EXP ${(m.exp ?? 0).toLocaleString()} / ${next != null ? next.toLocaleString() : '-'}`));

  const grid = el('div', 'char-grid');
  // 強化值(+7 / -1)標在格子左上角;飾品(項鍊、戒指、腰帶)不能強化,不標
  const enchantTag = (cell, it, key) => {
    if (!it || ['amulet', 'ring', 'ring2', 'belt', 'earring'].includes(key)) return;
    const m = /^([+-]\d+)\s/.exec(it.name);
    if (m && +m[1] !== 0) cell.appendChild(el('b', 'enh', m[1]));
  };
  const slotCell = (it, label, cls) => {
    const cell = el('button', `${cls}${it ? ' has' : ''}`);
    cell.type = 'button';
    if (it) { cell.appendChild(iconCanvas(it, cls.includes('small') ? 22 : 34)); cell.title = itemLabel(it); cell.onclick = () => tapItem(it); enchantTag(cell, it, 'helm'); } else cell.appendChild(el('span', '', label));
    return cell;
  };
  const col = (slots) => {
    const c = el('div', 'equip-col');
    for (const [key, label] of slots) {
      if (key === 'helm') { // 頭盔:一大格(一般頭盔)+ 下面兩小格(魔法頭盔)
        const wrap = el('div', 'helm-wrap');
        wrap.appendChild(slotCell(equipped.helm, label, 'equip'));
        const sub = el('div', 'helm-sub');
        sub.append(slotCell(equipped.helmA, '魔法', 'equip small'), slotCell(equipped.helmB, '魔法', 'equip small'));
        wrap.appendChild(sub);
        c.appendChild(wrap);
        continue;
      }
      const it = equipped[key];
      const cell = el('button', `equip${it ? ' has' : ''}`);
      cell.type = 'button';
      if (it) {
        cell.appendChild(iconCanvas(it, 34));
        cell.title = itemLabel(it);
        cell.onclick = () => tapItem(it);
        enchantTag(cell, it, key);
        wornTag(cell, it);
      } else cell.appendChild(el('span', '', label));
      c.appendChild(cell);
    }
    return c;
  };
  const center = el('div', 'char-center');
  const pc = el('canvas');
  // 畫布留大一點:待機動畫會晃、武器 / 覆蓋層會超出身體,太小會被切掉
  pc.width = 160 * DPR; pc.height = 170 * DPR;
  pc.style.width = '160px'; pc.style.height = '170px';
  const g = pc.getContext('2d');
  g.scale(DPR, DPR);
  // 跟遊戲畫面一樣播待機動畫(站著微微晃動);面板關掉或換頁就停
  let drawnKey = '';
  const drawMe = (now) => {
    if (!pc.isConnected || panel.name !== 'char') return; // 面板關掉時元素還在(只是藏起來):也要停
    const me = self();
    const key = me ? `${me.gfx}|${me.weapon}|${Math.floor(now / 40)}` : ''; // 待機動畫 40ms 一格:沒換格就不重畫
    if (key !== drawnKey) {
      drawnKey = key;
      g.clearRect(0, 0, 160, 170);
      if (me && !L1S.drawFigure(g, me, 80, 150, 100, performance.now()) && !L1S.known(me.gfx) && !FLARE.drawFigure(g, me, true, st.myType, 80, 150, 100)) {
        SPR.draw(g, SPR.creature(me, true, st.myType), 80, 148, 6);
      }
    }
    requestAnimationFrame(drawMe);
  };
  requestAnimationFrame(drawMe);
  center.appendChild(pc);
  const bars = el('div', 'char-bars');
  bars.appendChild(el('div', 'mini hp', `HP ${m.hp ?? 0} / ${m.maxHp ?? 0}`));
  bars.appendChild(el('div', 'mini mp', `MP ${m.mp ?? 0} / ${m.maxMp ?? 0}`));
  center.appendChild(bars);
  grid.append(col(LEFT_SLOTS), center, col(RIGHT_SLOTS));
  body.appendChild(grid);

  const stats = el('dl', 'char-stats');
  const add = (k, v) => { stats.appendChild(el('dt', '', k)); stats.appendChild(el('dd', '', String(v))); };
  add('STR', m.str ?? 0); add('DEX', m.dex ?? 0); add('CON', m.con ?? 0);
  add('INT', m.int ?? 0); add('WIS', m.wis ?? 0); add('CHA', m.cha ?? 0);
  add('AC', m.ac ?? 0); add('MR', $('#st-mr').textContent); add($('#st-lawful-label').textContent, m.lawful ?? 0);
  if (Number.isInteger(st.pkCount)) add('PK 次數', st.pkCount); // 11/03 伺服器送的目前 PK 次數(滿 100 下地獄)
  const elem = (v) => (v == null ? '-' : v + '%'); // 11/06:四屬性抗性(伺服器 S_OwnCharAttrDef;橫式 land.js 同一組欄位)
  add('火', elem(m.fire)); add('水', elem(m.water)); add('風', elem(m.wind)); add('地', elem(m.earth));
  body.appendChild(stats);
  renderOrigBonus(body); // 初始能力加成(伺服器 ##ORIGBONUS##)
  if (st.equipSets) renderEquipSets(body); // 裝備組 1 / 2(這個站有開才顯示)
  if (st.raisePending) { // 51 級起的能力值點數還沒分配(加點視窗按了「稍後」)
    const rb = el('button', 'raise-open', '有能力值點數可以分配');
    rb.type = 'button';
    rb.onclick = () => openRaiseAttr();
    body.appendChild(rb);
  }
}

// ---- 裝備組(伺服器 C_WebEquipSet / PACKETBOX 0xEE;SPEC deploy/feature-equipset/SPEC.md)----
// 把目前穿的全身裝備存成組 1 / 組 2,之後一鍵切換(伺服器一次處理順序;只換不同的格子;缺件 / 穿不了的跳過並回報)
function equipSetOp(op, slot) {
  if (!st.equipSets) return;
  const now = performance.now();
  if (now - (st.equipSetAt || 0) < 1000) { toast('操作太快,請稍候一下'); return; } // 防連點:1 秒內不重複送出
  const set = st.equipSets.find((s) => s.slot === slot);
  if (op === 2 && !(set?.items?.length)) { toast(`裝備組 ${slot} 還沒有存過裝備`); return; }
  st.equipSetAt = now;
  send({ t: 'equipset', op, slot });
}
function equipSetApplied(ev) {
  const names = (ev.skipped || []).map((x) => `${x.name}(${x.reason})`);
  log(`裝備組 ${ev.slot}:換好了(${(ev.ok || []).length} 件)${names.length ? `;沒換成功:${names.join('、')}` : ''}`, 'sys');
  toast(names.length ? `裝備組 ${ev.slot}:有 ${names.length} 件沒換成功,看訊息` : `裝備組 ${ev.slot} 已換上`);
}
function renderEquipSets(body) {
  // 縮小版(使用者 10/22「太大了」):一行一組,字和按鈕都小一號;切換主要用主畫面右側的「裝備1 / 裝備2」小鈕
  const box = el('div', 'equip-sets');
  box.style.cssText = 'margin-top:6px;display:flex;flex-direction:column;gap:3px;font-size:11px';
  const sm = (b) => { b.style.cssText = 'font-size:11px;height:22px;min-height:0;padding:0 7px;line-height:1;width:auto;flex:none'; return b; };
  for (const slot of [1, 2]) {
    const set = st.equipSets.find((s) => s.slot === slot);
    const n = set?.items?.length || 0;
    const row = el('div', 'equip-set-row');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:nowrap;white-space:nowrap';
    const label = el('span', '', `裝備${slot}:${n ? `${n}件` : '空'}`);
    label.style.cssText = 'min-width:58px;font-size:11px;color:#b8a47e';
    if (n) label.title = set.items.map((i) => i.name).join('\n');
    const apply = sm(el('button', 'learn', '套用')); apply.type = 'button'; apply.disabled = !n;
    apply.onclick = () => equipSetOp(2, slot);
    const save = n ? sm(confirmBtn('存目前', 'learn', () => equipSetOp(1, slot))) : sm(el('button', 'learn', '存目前'));
    if (!n) { save.type = 'button'; save.onclick = () => equipSetOp(1, slot); }
    row.append(label, apply, save);
    if (n) row.appendChild(sm(confirmBtn('清除', 'learn', () => equipSetOp(3, slot))));
    box.appendChild(row);
  }
  body.appendChild(box);
}
// 快捷欄左邊上面的兩顆極小切換鈕「1」「2」:點了直接換裝備組;現在穿的就是這組 → 亮框,空的組 → 淡色;這個站沒開裝備組(st.equipSets = null)就不顯示
const equipNameKey = (it) => it.name.replace(/^[+-]\d+\s*/, '').replace(/\s*\((揮舞|穿戴)\)\s*/g, '').trim();
function activeEquipSet() { // 目前穿的(名稱排序後)和哪一組一樣;不一樣回 0
  const cur = [...st.inv.values()].filter((it) => isEquipped(it)).map(equipNameKey).sort().join('|');
  if (!cur) return 0;
  for (const s of st.equipSets || []) if (s.items.length && s.items.map((i) => equipNameKey(i)).sort().join('|') === cur) return s.slot;
  return 0;
}
function placeEquipQuick(box) {
  const hb = document.getElementById('hotbar');
  if (!hb || !hb.offsetParent) { box.style.display = 'none'; return; }
  box.style.left = `${hb.offsetLeft}px`;
  box.style.top = `${hb.offsetTop - 24}px`;
}
function syncEquipQuick() {
  let box = document.getElementById('equip-quick');
  if (!st.equipSets || !st.inGame) { if (box) box.style.display = 'none'; return; }
  if (!box) {
    const hb = document.getElementById('hotbar');
    if (!hb || !hb.parentElement) return;
    box = el('div'); box.id = 'equip-quick';
    box.style.cssText = 'position:absolute;display:flex;gap:4px;z-index:5';
    for (const slot of [1, 2]) {
      const b = el('button', '', String(slot)); b.type = 'button'; b.dataset.slot = String(slot);
      b.style.cssText = 'width:22px;height:20px;min-height:0;padding:0;font-size:12px;font-weight:700;line-height:1;color:#f3e6c4;background:rgba(40,28,12,.85);border:1px solid #6e5a30;border-radius:5px';
      b.onclick = () => equipSetOp(2, slot);
      box.appendChild(b);
    }
    hb.parentElement.appendChild(box);
    window.addEventListener('resize', () => syncEquipQuick());
    setInterval(() => { if (st.equipSets && st.inGame) syncEquipQuick(); }, 1000); // 穿脫裝備後亮框跟著變
  }
  box.style.display = 'flex';
  placeEquipQuick(box);
  const act = activeEquipSet();
  for (const b of box.querySelectorAll('button')) {
    const slot = +b.dataset.slot;
    const n = st.equipSets.find((s) => s.slot === slot)?.items?.length || 0;
    b.style.opacity = n ? '1' : '.45';
    b.style.borderColor = act === slot ? '#ffd36b' : '#6e5a30';
    b.style.background = act === slot ? 'rgba(150,110,30,.95)' : 'rgba(40,28,12,.85)';
    b.style.boxShadow = act === slot ? '0 0 6px rgba(255,210,100,.9)' : 'none';
    b.title = n ? `裝備組 ${slot}(${n} 件)${act === slot ? ',目前穿的就是這組' : ''}` : `裝備組 ${slot} 還沒有存(到人物欄存目前裝備)`;
  }
}

// ---- 背包 ----
// 背包整理:依種類排序 —— 金幣、武器、防具(頭盔→盔甲→T恤→斗篷→手套→靴子→盾牌)、飾品、藥水、卷軸、箭、食物、其他
// 按過「整理」之後一直保持整理好的順序(每隻角色分開記)
const GEAR_ORDER = ['weapon', 'helm', 'armor', 'T', 'cloak', 'glove', 'boots', 'shield', 'amulet', 'ring', 'belt', 'earring'];
function invSortKey(it) {
  const n = baseName(it);
  if (n === '金幣') return [0, 0];
  const slot = equipSlot(it);
  if (slot) return [1, GEAR_ORDER.indexOf(slot)];
  if (/藥水|餅乾/.test(n)) return [2, 0];
  if (/卷軸/.test(n)) return [3, 0];
  if (/箭|飛刀/.test(n)) return [4, 0];
  if (/肉|麵包|蘋果|香蕉|料理|食物|魚/.test(n)) return [5, 0];
  if (/魔法書|精靈水晶|技術書/.test(n)) return [6, 0];
  return [7, 0];
}
function sortInv(items) {
  return items.sort((a, b) => {
    const ka = invSortKey(a); const kb = invSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || (isEquipped(b) - isEquipped(a))
      || baseName(a).localeCompare(baseName(b), 'zh-Hant') || enchantLevel(b) - enchantLevel(a) || a.id - b.id;
  });
}

// st.inv 可確認的分類欄位為 useType;其餘用明確名稱,未知類型歸其他。
// 背包專用分類,不改交易 / 拍賣共用的道具說明。
function invCategory(it) {
  if (isGear(it)) return equipSlot(it) === 'weapon' ? 'weapon' : 'armor';
  const n = baseName(it);
  if (/藥水|精靈餅乾|^惡魔之血$/.test(n)) return 'potion';
  if (/卷軸/.test(n)) return 'scroll';
  if (/^(品質|高品質)?(鑽石|紅寶石|藍寶石|綠寶石)$/.test(n.replace(/\s/g, ''))
    || /^(原石|魔法寶石|精靈玉|米索莉|奧里哈魯根|金屬塊|鐵礦石|銀礦石|金礦石)$/.test(n)) return 'material';
  return 'other';
}
function invMatches(it) {
  return !isEquipped(it) && (panel.tab === 'all' || panel.tab === invCategory(it))
    && itemLabel(it).toLowerCase().includes((panel.invQuery || '').toLowerCase());
}
function renderInvGrid(grid) {
  grid.replaceChildren();
  // 穿著中的裝備沿用既有排除規則。
  let items = [...st.inv.values()].filter(invMatches);
  if (store.get(charKey('invSorted'), false)) items = sortInv(items);
  for (const it of items) {
    const cell = el('button', `cell${isEquipped(it) ? ' equipped' : ''}`);
    cell.type = 'button';
    cell.title = itemLabel(it);
    cell.dataset.id = it.id;
    cell.appendChild(iconCanvas(it, 38));
    if (invCountText(it)) cell.appendChild(el('b', 'count', invCountText(it)));
    if (isEquipped(it)) cell.appendChild(el('i', 'eq', 'E'));
    wornTag(cell, it);
    enhTag(cell, it);
    lockTag(cell, it);
    cell.onclick = () => tapItem(it);
    grid.appendChild(cell);
  }
  const max = st.inventoryMax || 180;
  const empty = panel.tab === 'all' && !panel.invQuery ? Math.max(0, Math.min(max, 25) - items.length) : 0;
  for (let i = 0; i < empty; i++) grid.appendChild(el('div', 'cell blank'));
  if (!items.length && !empty) grid.appendChild(el('p', 'empty inv-empty', '沒有符合的道具'));
}
function renderInvPanel(body, foot) {
  // 11/10 使用者「收藏介面放入背包裡面」:收藏是背包的一個分頁(功能開著才出現)
  setTabs([['all', '全部'], ['weapon', '武器'], ['armor', '防具'], ['potion', '藥水'], ['scroll', '卷軸'], ['material', '材料'], ['other', '其他'], ...((collectionUi.enabled || appearanceUi.enabled) ? [['collection', '收藏']] : [])]);
  if (panel.tab === 'collection') {
    $('#inv-search')?.remove();
    if (!panel.collOpened) { panel.collOpened = true; collectionOpen(); }
    renderCollection(body, foot, true);
    return;
  }
  panel.collOpened = false;
  // 搜尋列保留原節點,輸入時只更新格子,避免失去焦點或中斷中文輸入。
  if (!$('#inv-search')) {
    const search = el('div', 'inv-search'); search.id = 'inv-search';
    const input = el('input'); input.type = 'search'; input.placeholder = '搜尋道具名稱';
    input.setAttribute('aria-label', '搜尋道具名稱'); input.autocomplete = 'off';
    input.value = panel.invQuery || '';
    const clear = el('button', '', '×'); clear.type = 'button';
    clear.setAttribute('aria-label', '清除道具搜尋');
    const update = () => {
      panel.invQuery = input.value;
      const grid = body.querySelector('.inv-grid');
      if (grid) { renderInvGrid(grid); body.scrollTop = 0; }
    };
    input.oninput = update;
    clear.onclick = () => { input.value = ''; update(); input.focus(); };
    search.append(input, clear);
    body.before(search);
  }
  const grid = el('div', 'inv-grid');
  renderInvGrid(grid);
  body.appendChild(grid);
  const max = st.inventoryMax || 180;
  // 11/02 #41:伺服器算背包上限含身上裝備(以吾之名 126 件含 12 件裝備 > 120,網頁卻顯示 114/120);總數 >= 上限時紅字
  const bagTotal = st.inv.size, bagWorn = [...st.inv.values()].filter(isEquipped).length;
  const capEl = el('span', 'cap', `容量:${bagTotal} / ${max}`); // 11/03 使用者「含裝備這文字就不要顯示了」(總數仍含身上裝備)
  if (bagTotal >= max) { capEl.style.color = '#ff6b5b'; capEl.title = '背包已滿(含身上裝備),請先清出空間'; }
  foot.appendChild(capEl);
  foot.appendChild(el('span', 'cap gold', `金幣 ${goldShown().toLocaleString('zh-TW')}`));
  const sb = el('button', 'learn inv-sort', '整理');
  sb.type = 'button';
  sb.onclick = () => { store.set(charKey('invSorted'), true); renderPanel(); toast('已依種類整理'); };
  foot.appendChild(sb);
  const eb = el('button', 'learn enchant-open', '強化');
  eb.type = 'button';
  eb.onclick = () => openPanel('enchant');
  foot.appendChild(eb);
  if (st.dollSynth) renderDollSynthEntry(foot);
}

// ---- 強化(對武器 / 盔甲施法的卷軸)----
// 只能強化沒裝備的;武器卷軸只能用在武器,盔甲卷軸只能用在防具(不含飾品)。成功率照伺服器 Enchant.java(rates EnchantChance = 0)
// BEGIN INLINE ENCHANT FX (原型共用;只呈現既有結果)
function createEnchantFx(body, done) {
  let top = body.querySelector('.enc-top');
  let cells = top.querySelectorAll('.enc-cell');
  const host = body.closest('#panel');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();
  const layer = document.createElement('div'), front = document.createElement('div');
  layer.className = 'ef-layer'; front.className = 'ef-layer ef-front';
  for (const node of [layer, front]) { node.setAttribute('aria-hidden', 'true'); body.appendChild(node); }
  // 不放入 enc-top:其最後一個子元素必須仍是裝備 enc-slot,保留既有 grid 定位規則。
  const ticks = Array.from({ length: 24 }, (_, i) => `<path transform="rotate(${i * 15} 50 50)" d="M50 5v${i % 3 ? 3 : 6}m-2 -1h4"/>`).join('');
  layer.innerHTML = `<div class="ef-flow">${Array.from({ length: 4 }, (_, i) => `<i style="--phase:${-i * .28}s"></i>`).join('')}</div><div class="ef-seal"><svg class="ef-circle" viewBox="0 0 100 100"><g class="ef-inner"><circle cx="50" cy="50" r="34"/><path d="M50 13 82 68.5H18ZM50 87 18 31.5h64Z"/><circle cx="50" cy="50" r="24" stroke-dasharray="1 5"/></g><g class="ef-runes"><circle cx="50" cy="50" r="43"/>${ticks}</g><g class="ef-outer"><circle cx="50" cy="50" r="49"/><path d="M50 1 57 8 50 15 43 8ZM99 50 92 57 85 50 92 43ZM50 99 43 92 50 85 57 92ZM1 50 8 43 15 50 8 57Z"/></g></svg></div><div class="ef-fragments"></div>`;
  front.innerHTML = `<div class="ef-flash"></div><div class="ef-burst"><div class="ef-rays">${Array.from({ length: 10 }, (_, i) => `<i class="ef-ray" style="--angle:${i * 36}deg"></i>`).join('')}</div><div class="ef-column"></div></div><div class="ef-crack"><svg viewBox="0 0 100 100"><path d="M50 4 46 25 59 38 48 52 56 72 47 96M5 27 28 36 35 50 48 52 67 46 92 57M13 83 32 72 35 50M59 38 76 20 89 18M56 72 74 80 83 96"/></svg></div>`;
  const seal = layer.querySelector('.ef-seal'), fragments = layer.querySelector('.ef-fragments');
  const flow = layer.querySelector('.ef-flow'), burst = front.querySelector('.ef-burst');
  const crack = front.querySelector('.ef-crack'), flash = front.querySelector('.ef-flash');
  const place = () => {
    const r = body.getBoundingClientRect(), t = top.getBoundingClientRect();
    const a = cells[0].getBoundingClientRect(), b = cells[1].getBoundingClientRect();
    const x = b.left + b.width / 2 - r.left - body.clientLeft;
    const y = b.top + b.height / 2 - r.top - body.clientTop;
    const ax = a.left + a.width / 2 - r.left - body.clientLeft;
    const ay = a.top + a.height / 2 - r.top - body.clientTop;
    const mobile = matchMedia('(max-width: 899px), (pointer: coarse)').matches;
    const padding = 10; // 包含 SVG 發光的留白;整個陣形放進可視範圍。
    const size = Math.max(0, Math.min(Math.max(mobile ? 110 : 140, Math.min(mobile ? 130 : 180, t.height * 2.3)), body.clientWidth - padding * 2, body.clientHeight - padding * 2));
    const sx = Math.max(size / 2 + padding, Math.min(x, body.clientWidth - size / 2 - padding));
    const sy = Math.max(size / 2 + padding, Math.min(y, body.clientHeight - size / 2 - padding));
    for (const node of [layer, front]) {
      node.style.top = `${body.scrollTop}px`; node.style.height = `${body.clientHeight}px`;
      node.style.setProperty('--seal-size', `${size}px`);
    }
    for (const node of [seal, fragments]) { node.style.left = `${sx}px`; node.style.top = `${sy}px`; }
    for (const node of [burst, crack, flash]) { node.style.left = `${x}px`; node.style.top = `${y}px`; }
    flow.style.left = `${ax}px`; flow.style.top = `${ay}px`;
    flow.style.width = `${Math.hypot(x - ax, y - ay)}px`;
    flow.style.setProperty('--flow-length', flow.style.width);
    flow.style.transform = `rotate(${Math.atan2(y - ay, x - ax)}rad)`;
    flash.style.width = flash.style.height = `${size}px`; flash.style.margin = `${-size / 2}px`;
  };
  place();
  const observer = new ResizeObserver(place); observer.observe(top); observer.observe(body);
  body.addEventListener('scroll', place, { passive: true });
  let active = true, revealed = false, waitTimer, endTimer, frame;
  const clean = () => {
    if (!active) return;
    active = false; clearTimeout(waitTimer); clearTimeout(endTimer); observer.disconnect();
    body.removeEventListener('click', skip, true); body.removeEventListener('keydown', skip, true);
    body.removeEventListener('scroll', place);
    host.classList.remove('ef-charging', 'ef-success', 'ef-failed', 'ef-fizzle', 'ef-grand', 'ef-active');
    layer.remove(); front.remove(); frame?.remove(); done();
  };
  const skip = (ev) => {
    if (!revealed || ev.target.closest('label, #panel-close')) return;
    if (ev.type === 'keydown' && ev.key !== 'Escape' && ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault(); ev.stopPropagation(); clean();
  };
  host.classList.add('ef-active', 'ef-charging');
  body.addEventListener('click', skip, true); body.addEventListener('keydown', skip, true);
  return {
    get active() { return active; },
    cancel: clean,
    reveal(kind, level, message, onReveal) {
      waitTimer = setTimeout(() => {
        if (!active || revealed) return;
        revealed = true;
        onReveal?.(); // 公開結果、名稱與背包格只在揭曉這一刻一起更新。
        observer.unobserve(top);
        top = body.querySelector('.enc-top'); cells = top.querySelectorAll('.enc-cell');
        observer.observe(top); place();
        host.classList.remove('ef-charging'); host.classList.add(`ef-${kind}`);
        if (kind === 'success' && level >= 7) {
          host.classList.add('ef-grand');
          frame = document.createElement('div'); frame.className = 'ef-frame'; frame.setAttribute('aria-hidden', 'true');
          host.appendChild(frame);
        }
        const number = body.querySelector('.enc-lv .to');
        if (kind === 'success' && number) number.textContent = level == null ? '同步中' : `${level >= 0 ? '+' : ''}${level}`;
        let msg = body.querySelector('.enc-msg');
        if (!msg) {
          const status = document.createElement('div'); status.className = 'enc-status';
          msg = document.createElement('div'); msg.className = 'enc-msg'; status.appendChild(msg);
          body.insertBefore(status, body.querySelector('.enc-go'));
        }
        msg.textContent = message; msg.setAttribute('role', 'status');
        msg.classList.toggle('enc-result-failed', kind === 'failed');
        // 動態粒子最多 24:蓄力光流 4 + 高階火花 20;失敗光流 4 + 碎片 12 + 灰燼 8。
        if (!reduced && kind === 'failed') for (let i = 0; i < 12; i++) {
          const fragment = document.createElement('i'); fragment.className = 'ef-fragment';
          const angle = i * Math.PI / 6, end = angle + Math.PI / 6;
          const px = n => 50 + Math.cos(n) * 45, py = n => 50 + Math.sin(n) * 45;
          fragment.innerHTML = `<svg viewBox="0 0 100 100"><path d="M${px(angle)} ${py(angle)}A45 45 0 0 1 ${px(end)} ${py(end)}L50 50Z"/><path d="M${50 + Math.cos(angle) * 20} ${50 + Math.sin(angle) * 20}l8 -6 -5 12"/></svg>`;
          fragment.style.setProperty('--dx', `${Math.cos(angle) * 58}px`);
          fragment.style.setProperty('--dy', `${24 + Math.sin(angle) * 26 + i * 3}px`);
          fragment.style.setProperty('--spin', `${i % 2 ? 38 : -32}deg`);
          fragments.appendChild(fragment);
        }
        if (!reduced && kind !== 'fizzle') for (let i = 0, count = kind === 'failed' ? 8 : level >= 7 ? 20 : 14; i < count; i++) {
          const spark = document.createElement('i'); spark.className = 'ef-spark';
          const angle = i / count * Math.PI * 2;
          spark.style.setProperty('--dx', `${Math.cos(angle) * (kind === 'failed' ? 50 : 95)}px`);
          spark.style.setProperty('--dy', `${kind === 'failed' ? 38 + i * 6 : Math.sin(angle) * 76}px`);
          spark.style.setProperty('--delay', `${i % 4 * 35}ms`); burst.appendChild(spark);
        }
        endTimer = setTimeout(clean, 1500);
      }, Math.max(0, 1200 - (performance.now() - started)));
    },
  };
}
// 揭曉時替換內容,保留兩層特效與其計時;使用 finish() 的實際結果,不預測強化值。
function showEnchantResult(body, view, from, up, kind) {
  const content = el('div');
  renderEnchant(content, null, view);
  // 成功率是本次送出前的機率,揭曉時保留原條與說明,不換成下一次的機率。
  const oldInfo = body.querySelector('.enc-info'), nextInfo = content.querySelector('.enc-info');
  if (oldInfo && nextInfo) { content.insertBefore(oldInfo, nextInfo); nextInfo.remove(); }
  for (const node of [...body.children]) if (!node.classList.contains('ef-layer')) node.remove();
  for (const node of [...content.children]) body.appendChild(node);
  const sign = n => `${n >= 0 ? '+' : ''}${n}`;
  const value = kind === 'failed' ? '消失' : kind === 'success' ? up == null ? '同步中' : sign(up) : sign(from);
  const top = body.querySelector('.enc-top'), name = top.querySelector('.enc-slot:last-child .enc-name');
  if (kind === 'failed') top.querySelector('.enc-plus').textContent = '×'; // 10/28:成功 / 沒事時中間維持「+」(新強化值已顯示在名稱與 +x → +y,放中間會斷成兩行)
  const current = body.querySelector('.enc-current');
  if (kind === 'failed') {
    current?.remove();
    name.textContent = '裝備已消失'; name.title = view.msg;
    const cell = top.querySelector('.enc-slot:last-child .enc-cell');
    cell.appendChild(el('span', 'enc-gone', '消失')); cell.setAttribute('aria-label', '裝備已消失');
  } else {
    const tag = name.querySelector('.enc-tag');
    if (tag) tag.textContent = value;
    name.title = `${value} ${baseName(view.target)}`;
    if (kind === 'success' && up == null) {
      name.title = `強化值同步中 ${baseName(view.target)}`;
      if (current) current.textContent = name.title;
    }
  }
  const info = body.querySelector('.enc-info');
  let row = info.querySelector('.enc-lv');
  if (!row) {
    info.textContent = ''; row = el('div', 'enc-lv');
    row.append(el('span', 'from'), el('span', 'arrow', '→'), el('span', 'to')); info.appendChild(row);
  }
  row.querySelector('.from').textContent = sign(from);
  row.querySelector('.to').textContent = value;
}
// END INLINE ENCHANT FX
let enchantFx = null;
const enchantFxPrefs = { on: store.get('enchantFx', true) !== false };
let enchantView = null; // 蓄力畫面使用送出前複本,不讀已更新的背包 / 結果。
const ARMOR_SLOTS = new Set(['armor', 'T', 'cloak', 'glove', 'boots', 'helm', 'shield']);
const enchantSel = { scroll: null, target: null, busy: false, msg: '' };
let enchantResultEvent = null; // 只有 doEnchant 等待回應期間接收結果
const enchantLevel = (it) => { const m = it.name.match(/^([+-]\d+)\s/); return m ? +m[1] : 0; };
function scrollKind(it) {
  const n = baseName(it);
  if (/象牙塔|幻象/.test(n)) return null;
  if (n.includes('對武器施法的卷軸')) return 'weapon';
  if (n.includes('對盔甲施法的卷軸')) return 'armor';
  return null;
}
function gearKind(it) {
  const slot = equipSlot(it);
  if (slot === 'weapon') return 'weapon';
  return ARMOR_SLOTS.has(slot) ? 'armor' : null;
}
const safeOf = (it) => byName(st.game.safeEnchant, it);
// 成功率(%);null = 不能強化
function enchantChance(scroll, target) {
  const safe = safeOf(target);
  if (safe == null || safe < 0) return null;
  const lv = enchantLevel(target);
  // 網頁版:伺服器送的卷軸名稱沒有「受詛咒」字樣,要看祝福值(bless 2);-7 以下再用會失敗(裝備消失,伺服器 Enchant enchant_level < -6)
  if (isCursed(scroll) || /詛咒/.test(scroll.name)) return lv < -6 ? 0 : 100; // 會 -1
  if (lv < safe) return 100;
  if (scrollKind(scroll) === 'weapon') return lv >= 9 ? 16 : 33; // 伺服器:隨機 1~100 ≤ 門檻(100/3、+9 起 100/6)
  const tmp = safe === 0 ? lv + 2 : lv;
  const c = Math.floor(lv >= 9 ? 100 / (tmp * 2) : 100 / tmp);
  return c; // 門檻 100/強化值(+9 起減半),隨機 1~100 ≤ 門檻
}
function renderEnchant(body, foot, override = null) {
  const view = override || enchantView;
  const inv = view ? view.inv : [...st.inv.values()];
  // 蓄力期間連名稱 / 數量都使用複本;一般重畫仍依既有規則同步選取。
  if (!view) {
    for (const k of ['scroll', 'target']) if (enchantSel[k] && !st.inv.has(enchantSel[k].id)) enchantSel[k] = null;
    if (enchantSel.scroll) enchantSel.scroll = st.inv.get(enchantSel.scroll.id);
    if (enchantSel.target) enchantSel.target = st.inv.get(enchantSel.target.id);
  }
  const { scroll, target } = view || enchantSel;
  const message = view ? view.msg : enchantSel.msg;
  const outcome = view ? view.outcome : enchantSel.outcome;
  const top = el('div', 'enc-top');
  const slot = (it, label) => {
    const box = el('div', 'enc-slot');
    const cell = el('div', 'enc-cell');
    if (it) cell.appendChild(iconCanvas(it, 44));
    const nm = el('span', 'enc-name', it ? itemLabel(it, it.name.replace(/\s*\(\d+\)$/, '')) : label); // 受詛咒 / 祝福的卷軸名稱要看得出來(d3)
    nm.title = nm.textContent;
    if (it && it === target) {
      const lv = enchantLevel(it), safe = safeOf(it);
      const risk = safe != null && safe >= 0 && lv >= safe;
      const name = nm.textContent.replace(/^[+-]\d+\s*/, '');
      nm.textContent = '';
      const tag = `${lv >= 0 ? '+' : ''}${lv}${risk ? ' 可能失敗' : ''}`;
      nm.append(el('b', `enc-tag${risk ? ' enc-warn' : ''}`, tag), el('span', 'enc-item-name', name));
      nm.title = `${tag} ${name}`;
    }
    box.append(cell, nm);
    return box;
  };
  top.append(slot(scroll, '選擇卷軸'), el('b', 'enc-plus', '+'), slot(target, '選擇裝備'));
  body.appendChild(top);
  // 強化值變化 + 成功率條
  const info = el('div', 'enc-info');
  let chance = null;
  if (!st.game.safeEnchant) info.appendChild(el('div', 'enc-note', '遊戲資料載入中…'));
  else if (scroll && target) {
    chance = enchantChance(scroll, target);
    const lv = enchantLevel(target);
    const safe = safeOf(target);
    const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;
    const cursed = isCursed(scroll) || /詛咒/.test(scroll.name);
    if (chance == null) info.appendChild(el('div', 'enc-warn', '這件裝備不能強化'));
    else if (cursed && chance === 0) info.appendChild(el('div', 'enc-warn', `強化值 ${sign(lv)} 再用受詛咒的卷軸會失敗(裝備消失)`));
    else {
      // 受詛咒 -1;祝福的卷軸成功時:+2 以下隨機 +1~+3、+3~+5 隨機 +1~+2(伺服器 Enchant.RandomELevel,安定值內外都一樣)
      const up = cursed ? -1 : !isBlessed(scroll) ? 1 : lv <= 2 ? 3 : lv <= 5 ? 2 : 1;
      const next = cursed ? sign(lv - 1) : up > 1 ? `${sign(lv + 1)} ~ ${sign(lv + up)}` : sign(lv + 1);
      const lvRow = el('div', 'enc-lv');
      lvRow.append(el('span', 'from', sign(lv)), el('span', 'arrow', '→'), el('span', 'to', next));
      info.appendChild(lvRow);
      const bar = el('div', `enc-bar${chance >= 100 ? ' safe' : chance >= 30 ? ' mid' : ' low'}`);
      const fill = el('i');
      fill.style.width = `${chance}%`;
      bar.append(fill, el('b', '', `成功率 ${chance}%`));
      info.appendChild(bar);
      info.appendChild(el('div', 'enc-note', `安定值 ${safe}`));
    }
  } else info.appendChild(el('div', 'enc-note', '點下方的卷軸和裝備放進來'));
  body.appendChild(info);
  if (message) {
    const status = el('div', 'enc-status');
    const msg = el('div', `enc-msg${outcome === 'failed' ? ' enc-result-failed' : ''}`, message);
    msg.title = message;
    status.appendChild(msg);
    if (target) {
      const lv = enchantLevel(target);
      const current = el('div', 'enc-current', `目前選擇:${itemLabel(target, `${lv >= 0 ? '+' : ''}${lv} ${baseName(target)}`)}(剩 ${target.count})`);
      current.title = current.textContent;
      status.appendChild(current);
    }
    body.appendChild(status);
  }
  const go = el('button', 'gold-btn enc-go', enchantSel.busy ? '強化中…' : '開始強化');
  go.type = 'button';
  go.disabled = !st.game.safeEnchant || !scroll || !target || chance == null || enchantSel.busy;
  go.onclick = () => doEnchant(scroll, target);
  body.appendChild(go);
  { // 10/28 使用者:可以勾「不再提醒失敗風險」(這台裝置記住),勾了就不跳確認視窗直接強化
    const lab = el('label', 'enc-noconfirm');
    lab.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;margin:2px 0 4px;font-size:.9em;color:#c9b88f;cursor:pointer;white-space:nowrap';
    const cb = el('input'); cb.type = 'checkbox'; cb.style.cssText = 'flex:none;width:16px !important;height:16px !important;min-width:0 !important;min-height:0 !important;margin:0;padding:0;accent-color:#c9a14a'; cb.checked = !!store.get('encNoConfirm', false);
    cb.onchange = () => { store.set('encNoConfirm', cb.checked); toast(cb.checked ? '強化有失敗風險時不再提醒' : '強化有失敗風險時會先提醒'); };
    lab.append(cb, document.createTextNode('不再提醒失敗風險'));
    body.appendChild(lab);
  }
  {
    const lab = el('label', 'enc-fx-pref');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = enchantFxPrefs.on;
    cb.onchange = () => { enchantFxPrefs.on = cb.checked; store.set('enchantFx', cb.checked); if (!cb.checked) enchantFx?.cancel(); };
    lab.append(cb, document.createTextNode('強化動畫')); body.appendChild(lab);
  }
  // 可以放的:強化卷軸 + 沒裝備的武器 / 防具(選了卷軸就只列對應種類)
  const want = scroll ? scrollKind(scroll) : null;
  const list = inv.filter((it) => scrollKind(it) || (gearKind(it) && !isEquipped(it) && (!want || gearKind(it) === want)));
  const grid = el('div', 'inv-grid enc-grid');
  for (const it of list) {
    const isScroll = !!scrollKind(it);
    const sel = (isScroll ? scroll : target)?.id === it.id;
    const cell = el('button', `cell${sel ? ' equipped' : ''}`);
    cell.type = 'button';
    cell.title = itemLabel(it);
    cell.appendChild(iconCanvas(it, 38));
    if (it.count > 1) cell.appendChild(el('b', 'count', it.count));
    const lv = !isScroll && enchantLevel(it);
    if (lv) cell.appendChild(el('i', 'eq', `${lv > 0 ? '+' : ''}${lv}`));
    cell.onclick = () => {
      if (enchantSel.busy || enchantFx?.active) return;
      enchantSel.msg = '';
      if (isScroll) {
        enchantSel.scroll = it;
        if (target && gearKind(target) !== scrollKind(it)) enchantSel.target = null;
      } else {
        if (scroll && gearKind(it) !== scrollKind(scroll)) { toast(scrollKind(scroll) === 'weapon' ? '對武器施法的卷軸只能強化武器' : '對盔甲施法的卷軸只能強化防具'); return; }
        enchantSel.target = it;
      }
      renderPanel();
    };
    grid.appendChild(cell);
  }
  if (!list.length) body.appendChild(el('p', 'empty', '背包裡沒有強化卷軸或可以強化的裝備。'));
  body.appendChild(grid);
}
// 送出強化;結果以伺服器訊息為主,背包變化補強化值 / 合併數量,沒訊息才用差分判斷
function doEnchant(scroll, target, confirmed = false) {
  if (enchantSel.busy || enchantFx?.active) return;
  if (!st.game.safeEnchant) { toast('遊戲資料載入中…'); return; }
  scroll = st.inv.get(scroll.id);
  target = st.inv.get(target.id);
  if (!scroll || !target) { renderPanel(); return; }
  if (isEquipped(target)) { toast('裝備中的道具不能強化'); return; }
  const name = baseName(target);
  const lv = enchantLevel(target);
  const targetBefore = { ...target };
  const bless = target.bless ?? 1;
  const chance = enchantChance(scroll, target);
  if (chance == null) return;
  if (!confirmed && !store.get('encNoConfirm', false) && lv >= safeOf(target) && !isCursed(scroll) && !/詛咒/.test(scroll.name)) { // 10/28:勾了「不再提醒失敗風險」就不跳確認
    // 沿用現有對話框;確認期間物品或選擇變了就重新選,不送舊目標。
    const key = (it) => it && `${it.id}:${it.name}:${it.bless ?? 1}`;
    const scrollKey = key(scroll), targetKey = key(target);
    showDialog('確認強化', `${itemLabel(target, `${lv >= 0 ? '+' : ''}${lv} ${name}`)} 強化可能失敗並消失(成功率 ${chance}%),確定要強化嗎?`);
    menuButton('確定強化(會有風險)', '', () => {
      closeDialog();
      if (enchantSel.scroll?.id !== scroll.id || enchantSel.target?.id !== target.id || key(st.inv.get(scroll.id)) !== scrollKey || key(st.inv.get(target.id)) !== targetKey) {
        toast('卷軸或裝備已變更,請重新選擇強化'); renderPanel(); return;
      }
      doEnchant(scroll, target, true);
    });
    menuButton('取消', '', closeDialog);
    return;
  }
  const matches = (it) => baseName(it) === name && (it.bless ?? 1) === bless && gearKind(it);
  const snap = () => {
    const m = new Map();
    for (const it of st.inv.values()) if (matches(it)) m.set(enchantLevel(it), (m.get(enchantLevel(it)) || 0) + Math.max(1, it.count));
    return m;
  };
  const before = snap();
  const beforeItems = new Map([...st.inv.values()].filter(matches).map((it) => [it.id, { lv: enchantLevel(it), count: it.count }]));
  const scrollId = scroll.id;
  const scrollCount = scroll.count;
  const t0 = performance.now();
  let result = null, changedAt = null, observedUp = null;
  // app.js 在更新背包前呼叫 statsEvent;記住稍後可能被 restack 刪掉的那件的強化值。
  enchantResultEvent = (ev) => {
    if (ev.t === 'servermsg' && [161, 164, 79, 160].includes(ev.id) && result == null) { // 11/04:+9 以上「持續發出光芒,但是沒有任何事情發生」是 160,不是 79
      result = ev.id;
      if (changedAt == null) changedAt = performance.now();
    }
    const it = ev.t === 'itemname' ? { ...st.inv.get(ev.id), id: ev.id, name: ev.name }
      : (ev.t === 'itemupdate' || ev.t === 'additem') && ev.item ? { ...st.inv.get(ev.item.id), ...ev.item } : null;
    if (it && it.id === target.id && matches(it) && enchantLevel(it) !== lv) {
      observedUp = enchantLevel(it);
      if (changedAt == null) changedAt = performance.now();
    }
  };
  enchantSel.busy = true;
  enchantSel.msg = '';
  if (enchantFxPrefs.on) {
    const inv = [...st.inv.values()].map(it => ({ ...it }));
    enchantView = { inv, scroll: inv.find(it => it.id === scroll.id), target: inv.find(it => it.id === target.id), msg: '', outcome: null };
  }
  let publishResult = null;
  renderPanel();
  const fx = enchantFxPrefs.on ? createEnchantFx($('#panel-body'), () => {
    enchantFx = null;
    enchantView = null;
    publishResult?.();
    if (panel.name === 'enchant') renderPanel();
  }) : null;
  enchantFx = fx;
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  const levelAfter = (after) => {
    let up = null;
    for (const [l, n] of after) if (l !== lv && n > (before.get(l) || 0)) up = l;
    return up;
  };
  const check = () => {
    const after = snap();
    const sc = st.inv.get(scrollId);
    const scrollUsed = !sc || sc.count < scrollCount;
    const changed = !same(before, after);
    const now = performance.now();
    if ((changed || scrollUsed) && changedAt == null) changedAt = now;
    // restack 的 delitem 先到、count 最多晚約 1 秒;從第一個回應起至少等 1.5 秒,不能從送出起算。
    const settled = changedAt != null && now - changedAt >= 1500;
    const complete = scrollUsed && levelAfter(after) != null && (after.get(lv) || 0) < (before.get(lv) || 0);
    const deadline = Math.max(t0 + 5000, (changedAt ?? t0) + 1500);
    const decided = (result === 161 && complete) || (result === 164 && scrollUsed && changed) || ((result === 79 || result === 160) && scrollUsed); // 10/28:結果確定就馬上顯示,不再固定等 1.5 秒
    if (!decided && now < deadline && (!settled || (result === 161 && !complete) || (result == null && (!changed || !scrollUsed)))) { setTimeout(check, 200); return; }
    // 動畫開啟且完全沒收到回應時繼續蓄力;不把慢回應當成「沒事發生」。
    if (fx?.active && result == null && !changed && !scrollUsed) { setTimeout(check, 200); return; }
    finish(after);
  };
  const finish = (after) => {
    const up = levelAfter(after) ?? (result === 161 ? observedUp : null);
    const lost = (before.get(lv) || 0) - (after.get(lv) || 0);
    const success = result === 161 || (result == null && up != null);
    const failed = result === 164 || (result == null && up == null && lost > 0);
    const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;
    let message = success ? `強化成功!${name} ${sign(lv)} → ${up == null ? '強化值同步中' : sign(up)}` : failed ? `強化失敗,${name} 消失了` : '沒有任何事情發生';
    enchantResultEvent = null;
    let nextTarget = enchantSel.target;
    // 成功後先留在原本強化值的那疊;用完才選強化後的那件,祝福 / 刻印狀態也要相同。
    if (success) {
      const items = [...st.inv.values()].filter((it) => matches(it) && it.count > 0 && !isEquipped(it));
      const merged = items.find((it) => enchantLevel(it) === up && beforeItems.get(it.id)?.lv === up && it.count > beforeItems.get(it.id).count);
      if (merged) message += `，已和原本的 ${sign(up)} 疊在一起(共 ${merged.count} 把)`;
      nextTarget = items.find((it) => it.id === target.id && enchantLevel(it) === lv)
        || items.find((it) => enchantLevel(it) === lv) || items.find((it) => enchantLevel(it) === up) || null;
    } else nextTarget = failed ? null : nextTarget;
    const outcome = success ? 'success' : failed ? 'failed' : 'fizzle';
    let published = false;
    publishResult = () => {
      if (published) return;
      published = true; enchantView = null;
      enchantSel.msg = message; enchantSel.outcome = outcome;
      enchantSel.target = nextTarget; enchantSel.busy = false;
    };
    const inv = [...st.inv.values()].map(it => ({ ...it }));
    const displayTarget = failed ? targetBefore : success && up != null
      ? inv.find(it => it.id === target.id && matches(it) && enchantLevel(it) === up)
        || inv.find(it => matches(it) && enchantLevel(it) === up)
        || { ...targetBefore, name: `${sign(up)} ${name}` } : targetBefore;
    const view = { inv, scroll: inv.find(it => it.id === scroll.id) || null, target: displayTarget, msg: message, outcome };
    if (fx?.active && panel.name === 'enchant') fx.reveal(outcome, up, message, () => {
      publishResult();
      showEnchantResult($('#panel-body'), view, lv, up, outcome);
    });
    else {
      publishResult();
      if (panel.name === 'enchant') renderPanel(); else toast(enchantSel.msg);
    }
  };
  send({ t: 'useitem', id: scroll.id, target: target.id });
  setTimeout(check, 300);
}

// 背包開著時,道具數量 / 名稱變了(射箭每一箭、喝水)只改那一格,不整個重畫:
// 整個重畫圖示會先空白再畫(手機上一直閃),捲動位置也會跳回最上面(玩家 10/15 回報開背包一直閃)
// 畫面上顯示的金幣(狀態列、背包底下):伊娃的寶藏那一轉的動畫播完之前,先不含那一轉的贏分(eva.js evaGoldShown;11/10 玩家回報電腦版先看到結果)。
// 只給顯示用;夠不夠錢、自動買藥水一律還是用 adena()。
function goldShown() { const a = adena(); return typeof evaGoldShown === 'function' ? evaGoldShown(a) : a; }
function refreshGold() {
  const t = goldShown().toLocaleString('zh-TW');
  const s = $('#st-gold'); if (s) s.textContent = t;
  const g = document.querySelector('#panel-foot .cap.gold'); if (g) g.textContent = `金幣 ${t}`;
}
function renderInv(changedId, countOnly = false) {
  if (st.dollSynth && panel.name === 'inv' && panel.tab !== 'collection') renderDollSynthEntry($('#panel-foot'));
  auctionInventoryChanged();
  if (panel.name === 'inv' && panel.tab === 'all' && !panel.invQuery && changedId != null && patchInvCell(changedId)) { /* 只改那一格 */ }
  else if (panel.name === 'inv' || panel.name === 'char' || panel.name === 'enchant'
      || (panel.name === 'settings' && panel.tab === 'potion')) renderPanelSoon();
  tradeInvChanged(); // 交易視窗下方的背包
  // 10/29 弓箭角色卡頓:每射一箭 itemupdate 一次,原本整排快捷欄 canvas 重建 + 整個 HUD + 頭像重畫(每秒 1.5 次)讓內顯筆電掉幀;
  // 只有數量變(射箭、喝水、撿金幣)就只改快捷欄那一格的數字,金幣變才更新 HUD 的金幣
  if (countOnly && changedId != null && patchHotbarCount(changedId)) {
    const it = st.inv.get(changedId);
    if (it && (it.itemId === 40308 || baseName(it) === '金幣')) $('#st-gold').textContent = goldShown().toLocaleString('zh-TW');
    return;
  }
  renderHotbar();
  updateHud();
}
// 快捷欄上引用這個道具的格子只改數量文字(裝備格不顯示數量);找不到格子或格子結構不對就回 false 走整排重建
function patchHotbarCount(id) {
  const it = st.inv.get(id);
  if (!it) return false;
  for (const b of document.querySelectorAll('#hotbar .slot[data-slot]')) {
    const i = +b.dataset.slot;
    if (slotSkill(i) || slotItem(i) !== it) continue;
    if (slotGear(i)) continue; // 裝備格顯示強化值,不顯示數量
    let c = b.querySelector('b.count');
    if (it.count > 1) { if (!c) { c = el('b', 'count', ''); b.appendChild(c); } c.textContent = it.count; }
    else if (c) c.remove();
  }
  return true;
}

// 鎖住的道具:格子左下角的鎖頭標記(左上角是強化值 / 裝備 E,右上損傷,右下數量;10/24 使用者:鎖頭會擋強化值)
function lockTag(cell, it) {
  if (!isLocked(it)) return;
  const i = el('i', 'lockmark', '🔒');
  i.style.cssText = 'position:absolute;left:1px;bottom:0;font-size:11px;line-height:1;font-style:normal;pointer-events:none;filter:drop-shadow(0 0 1px #000)';
  cell.appendChild(i);
}
function invCountText(it) {
  if (it.itemId === 40308 || baseName(it) === '金幣') return ''; // 10/28 使用者:背包不顯示金幣數量(底下有總數)
  if (it.count > 1) return it.count >= 10000 ? `${Math.floor(it.count / 1000)}k` : String(it.count);
  return chargeOf(it) != null ? `(${chargeOf(it)})` : '';
}
function patchInvCell(id) {
  const it = st.inv.get(id);
  const cell = document.querySelector(`#panel-body .inv-grid [data-id="${id}"]`);
  if (!it || !cell || isEquipped(it)) return false;
  const txt = invCountText(it);
  let b = cell.querySelector('b.count');
  if (txt && !b) { b = el('b', 'count', ''); cell.insertBefore(b, cell.children[1] || null); }
  if (b) { if (txt) b.textContent = txt; else b.remove(); }
  const lk = cell.querySelector('i.lockmark');
  if (isLocked(it) && !lk) lockTag(cell, it); else if (!isLocked(it) && lk) lk.remove(); // 上鎖 / 解鎖只改這一格
  cell.title = itemLabel(it);
  const gold = document.querySelector('#panel-foot .cap.gold');
  if (gold) gold.textContent = `金幣 ${goldShown().toLocaleString('zh-TW')}`;
  return true;
}
// 一個畫面更新內的多次重畫合併成一次,並保留捲動位置
let panelRenderQueued = false;
function renderPanelSoon() {
  if (panelRenderQueued) return;
  panelRenderQueued = true;
  requestAnimationFrame(() => {
    panelRenderQueued = false;
    const b = $('#panel-body');
    const top = b.scrollTop;
    renderPanel();
    b.scrollTop = top;
  });
}

// ---- 技能 ----
const isPassiveSkill = (id) => Number(id) === 120 || Number(id) === 20052; // 王者加護 / 三角色達標只能查看說明
// 魔法頭盔給的魔法(伺服器 L1EquipmentSlot.setMagicHelm)與 MP 減半(L1SkillUse:除以 2 無條件捨去;風之頭盔的加速術固定 25)
const HELM_SKILLS = { 敏捷魔法頭盔: [26, 43], 治癒魔法頭盔: [1, 19], 力量魔法頭盔: [12, 13, 42], 小型風之頭盔: [43], 風之頭盔: [43, 54] };
const wornHelms = () => [...st.inv.values()].filter((it) => isEquipped(it) && HELM_SKILLS[baseName(it)]).map(baseName);
function helmSkillIds() {
  const out = new Set();
  for (const h of wornHelms()) for (const id of HELM_SKILLS[h]) if (st.skills.has(id)) out.add(id);
  return out;
}
// 實際消耗的 MP(戴對應頭盔時減半)
function skillMp(id) {
  const mp = st.game.skills?.[id]?.mp ?? 0;
  for (const h of wornHelms()) {
    if (h === '風之頭盔' && id === 43) return 25;
    if (HELM_SKILLS[h].includes(id)) return Math.floor(mp / 2);
  }
  return mp;
}
const SKILL_GROUPS = [
  ['通用魔法', 1, 10],
  ['騎士技能', 11, 11],
  ['黑暗妖精魔法', 13, 14],
  ['王族魔法', 15, 15],
  ['妖精魔法', 17, 22],
];
// 技能面板只列自己職業能學的:通用魔法到第幾階(照伺服器學魔法的規則),加上職業專屬魔法
// 妖精魔法照學習等級分階(伺服器 C_ItemUSe.useElfSpellBook 精靈水晶的等級限制;skills.skill_level 17~22 只是客戶端魔法格的排法)
// 暴風疾走 172、生命呼喚 165 沒有精靈水晶,照原版放 Lv50
const ELF_TIERS = [
  [10, [129, 130, 131]],
  [20, [137, 138]],
  [30, [132, 145, 146, 147, 148, 149, 150, 151, 152, 170]],
  [40, [133, 153, 154, 155, 156, 157, 158, 159, 160]],
  [50, [134, 161, 162, 163, 164, 165, 166, 167, 168, 169, 171, 172, 173, 174, 175, 176]],
];
const ELF_LEARN_LV = Object.fromEntries(ELF_TIERS.flatMap(([lv, ids]) => ids.map((id) => [id, lv])));
const CLASS_SKILLS = { 0: [2, '王族魔法'], 1: [1, '騎士技能'], 2: [6, '妖精魔法'], 3: [10, null], 4: [2, '黑暗妖精魔法'] };
// 補血魔法(伺服器 skills.type = 16):初級 / 中級 / 高級治癒術、體力回復術、全部治癒術、生命的祝福
const HEAL_SKILLS = [1, 19, 35, 49, 57, 164];
const ARROW_KIND = 40744; // 銀箭
const ARROW_BUY = 500;
const ARROW_PRICE = 0.2; // 銀箭 1 金幣 5 支(伺服器照商店最便宜的單支價)
// 11/07:自動購買箭矢可選(裝備商人 奧里哈魯根箭 1 支 3 金幣;11/08 11:2x 使用者改 1 支 10 金幣);伺服器 PaidArrowItemIds 要有 40748
const ARROW_KINDS = { 40744: ['銀箭', 0.2], 40748: ['奧里哈魯根箭', 10] };
const arrowKind = () => (settings.arrows?.kind === 40748 ? 40748 : 40744);
const arrowCost = () => Math.ceil(ARROW_BUY * ARROW_KINDS[arrowKind()][1]);
// 所有的箭(DB etcitem item_type = arrow):身上任何箭加起來夠就不用買銀箭
const ARROW_NAMES = new Set(['箭', '銀箭', '米索莉箭', '黑色米索莉箭', '奧里哈魯根箭', '奧里哈魯根鍍金骨箭', '黃金箭', '古代之箭', '象牙塔的箭']);

// 選魔法(自動魔法攻擊 / 自動技能補血):只列已學會的
function openSkillChoice(title, ids, onPick, current = null, selfScroll = false) {
  // 和自動喝水的選藥水一樣:一列一個,左邊圖示、右邊名稱與說明,目前選的有框
  const body = $('#is-body');
  body.innerHTML = '';
  $('#is-title').textContent = title;
  if (!ids.length) body.appendChild(el('p', 'hint', '還沒有學會可以用的魔法。'));
  for (const id of ids) {
    if (isPassiveSkill(id)) continue;
    const sk = st.game.skills[id];
    const b = el('button', `potion-pick${id === current ? ' on' : ''}`);
    b.type = 'button';
    const ic = skillIcon(sk.name);
    ic.style.width = ic.style.height = '36px';
    b.appendChild(ic);
    b.appendChild(el('span', 'nm', sk.name));
    const empty = selfScroll && autoScrollEmpty(id);
    if (empty) b.style.opacity = '.45';
    b.appendChild(el('small', '', empty ? '' : selfScroll && autoScrollInBag(scrollKindForSkill(id)) ? '優先使用背包卷軸' : `消耗 MP ${skillMp(id)}${sk.range ? ` · 射程 ${sk.range}` : ''}`));
    b.onclick = () => { if (empty) return; onPick(id); closeItemSheet(); }; // 沒學會、身上也沒卷軸:不給選
    body.appendChild(b);
  }
  $('#itemsheet').classList.remove('hidden');
}

// 11/02 #47:衝擊之暈(87)限定雙手劍:手上的武器不是雙手劍就不放(手動 / AUTO 都一樣);查不到武器資料時不擋
function wieldsTwoHand() {
  try {
    const w = [...st.inv.values()].find((it) => /\(揮舞\)/.test(it.name) && byName(st.game.itemStats, it)?.k === 'w');
    const s = w && byName(st.game.itemStats, w);
    return !s || s.type === 'tohandsword';
  } catch (e) { return true; }
}
// 11/06 使用者:衝擊之暈只對 PvP 玩家與 BOSS(altsettings ShockStunPvpOnlyEnabled → st.shockStunPvpOnly;BOSS 名單 st.stunBossNames)。
// 手動:鎖定的玩家 / BOSS 就放牠，否則找畫面上最近的玩家或 BOSS,沒有就不放;AUTO 只在目標是 BOSS 時放(23:5x「怪物部分只能boss」)。
const stunPvpOnly = (id) => id === 87 && !!st.shockStunPvpOnly;
function stunEnemy(o) { // 和敵人清單(renderEnemies)同一套:開 PvP 或戰爭敵人或血流成河場內，非自己 / 隊友 / 同盟(血流成河例外)/ 安全區
  const me = self();
  if (!me || !o || o.kind !== 'pc' || o.id === st.selfId || o.dead || o.dying) return false;
  const arena = inArenaEvent();
  if (!(isWarEnemy(o) || st.forceAttack || arena)) return false;
  if ((st.party || []).some((m) => m.id === o.id)) return false;
  if (me.clan && o.clan === me.clan && !arena) return false;
  return !inSafeZone(o.x, o.y) && !inSafeZone(me.x, me.y);
}
const stunBoss = (o) => !!o && o.kind === 'monster' && !o.dead && !o.dying && !!st.stunBossNames && st.stunBossNames.has(o.name);
const stunTarget = (o) => stunEnemy(o) || stunBoss(o);
// 自動魔法攻擊:現在要不要用魔法打(有開、學會、MP 夠)→ 回傳魔法編號或 null(app.js step 用)
function autoAttackSkill(ignoreGap) {
  const c = settings.atkSkill;
  const sk = st.game.skills?.[c?.id];
  if (!auto.on) return null; // 只有開 AUTO 自動打怪時才用魔法;自己點怪物是普通攻擊
  if (!c?.on || !sk || !st.skills.has(c.id) || !st.me?.maxMp) return null;
  if (c.id === 121 && royalSwordCooling()) return null;
  if (c.id === 87 && !wieldsTwoHand()) return null; // #47
  if (stunPvpOnly(c.id) && !stunBoss(st.objects.get(st.target?.id))) return null; // 11/06:AUTO 只對 BOSS 放衝擊之暈
  if (st.me.mp < skillMp(c.id) || (100 * st.me.mp) / st.me.maxMp < c.mp) return null;
  if (!ignoreGap && performance.now() < (st.autoSpellAt || 0)) return null; // 兩次魔法之間(AUTO_SPELL_GAP)穿插普攻(使用者 2026-10-14)
  return c.id;
}
// 開怪技能:AUTO 打一隻新的怪,第一下用這個魔法;之後照自動魔法攻擊(有設)或普通攻擊
st.opened = new Set(); // 已經出過手的怪物編號
function autoOpenSkill(targetId) {
  const c = settings.openSkill;
  if (!auto.on || !c?.on || targetId == null || st.opened.has(targetId)) return null;
  if (c.id === 121 && royalSwordCooling()) return null;
  if (!st.game.skills?.[c.id] || !st.skills.has(c.id) || !st.me?.maxMp) return null;
  if (c.id === 87 && !wieldsTwoHand()) return null; // #47
  if (stunPvpOnly(c.id) && !stunBoss(st.objects.get(targetId))) return null; // 11/06:AUTO 只對 BOSS 放衝擊之暈
  if (st.me.mp < skillMp(c.id) || (100 * st.me.mp) / st.me.maxMp < c.mp) return null;
  return c.id;
}
const AUTO_AOE_FILTER = true; // 排除隔牆、鑽土與誤分類玩家,避免把單體技能擠掉
function autoAoeSkill() {
  const c = settings.aoeSkill;
  const me = self();
  if (!auto.on || !c?.on || !me || !st.game.skills?.[c.id] || !st.skills.has(c.id) || !st.me?.maxMp) return null;
  if (st.me.mp < skillMp(c.id) || (100 * st.me.mp) / st.me.maxMp < (c.mp || 0)) return null;
  let n = 0;
  for (const o of st.objects.values()) {
    if (o.kind !== 'monster' || o.dead || o.dying || Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) > 3) continue;
    if (AUTO_AOE_FILTER && (o.id === st.selfId || o.pcFlag || o.buried || isClosedArea(o.x, o.y) || !clearLine(me.x, me.y, o.x, o.y))) continue;
    n++;
  }
  return n > c.count ? c.id : null;
}
const autoSpellFor = (targetId) => autoAoeSkill() || autoOpenSkill(targetId) || autoAttackSkill();
function markOpened(id) {
  if (st.opened.size > 300) st.opened.clear();
  st.opened.add(id);
}

// 魔法圖示(canvas);圖示集還沒載入就稍後補畫
function skillIcon(name, cls = 'icon') {
  const c = el('canvas', cls);
  c.width = c.height = 64 * DPR;
  if (name === '王者之劍' && RoyalFX.enabled()) { RoyalFX.icon(c); return c; }
  if (name === '勇猛意志' || name === '王者加護') { // 10/29 使用者給的技能圖(VALOR_ICON / AEGIS_ICON)
    const im = name === '王者加護' ? aegisIconImage() : valorIconImage(); const g = c.getContext('2d');
    const d = () => { if (im.complete && im.naturalWidth) g.drawImage(im, 0, 0, c.width, c.height); else setTimeout(d, 200); };
    d(); return c;
  }
  const draw = () => { if (!GDX.drawNamed(c.getContext('2d'), name, 0, 0, c.width) && GDX.hasIcon({}) === undefined) setTimeout(draw, 600); };
  draw();
  return c;
}

function renderSkillPanel(body, foot) {
  foot.appendChild(el('span', 'cap', panel.pickSlot != null ? `點魔法放到快捷欄 ${panel.pickSlot + 1}`
    : '點魔法可以放到快捷欄'));
  const skills = st.game.skills || {};
  let any = false;
  const [maxTier, own] = CLASS_SKILLS[st.myType] ?? [10, null];
  for (const [title, lo, full] of SKILL_GROUPS) {
    if (title !== '通用魔法' && title !== own) continue;
    const hi = title === '通用魔法' ? lo + maxTier - 1 : title === '王族魔法' && !st.royalSword ? 15 : full;
    const ids = Object.keys(skills).map(Number).filter((id) => skills[id].level >= lo && skills[id].level <= hi);
    if (!ids.length) continue;
    const learned = ids.filter((id) => st.skills.has(id) && skills[id].name !== 'none');
    const sec = el('section', 'skill-group');
    sec.appendChild(el('h4', '', `${title}(已學 ${learned.length})`));
    const rows = [];
    if (title === '妖精魔法') { // 照學習等級分階,一排放不下 8 個就接下一排
      ELF_TIERS.forEach(([elfLv, tierIds], i) => {
        const list = tierIds.filter((id) => skills[id]);
        for (let k = 0; k < list.length; k += 8) rows.push([k ? '' : `${i + 1}階
Lv${elfLv}`, list.slice(k, k + 8)]);
      });
    } else {
      for (let lv = lo; lv <= hi; lv++) {
        rows.push([`${lv - lo + 1}階
${title === '通用魔法' ? '魔法書' : title}`, ids.filter((id) => skills[id].level === lv).sort((a, b) => a - b).slice(0, 8)]);
      }
    }
    for (const [tierLabel, lvIds] of rows) {
      const row = el('div', 'skill-row');
      row.appendChild(el('span', 'tier', tierLabel));
      for (const id of lvIds) {
        const has = st.skills.has(id) && skills[id].name !== 'none'; // none:沒有這個魔法的空位,永遠是空格
        const s = el('span', `skill${has ? ' learned' : ''}`);
        if (has) s.appendChild(skillIcon(skills[id].name)); // 學會的填滿魔法圖示,沒學的是空格
        s.title = skills[id].name === 'none' ? '' : skills[id].name;
        if (id === 121 && has) s.dataset.skill = id;
        if (has) {
          s.onclick = () => {
            if (isPassiveSkill(id)) { openSlotPicker({ skill: id }); return; }
            if (panel.pickSlot != null) { const i = panel.pickSlot; setSlot(i, { skill: id }); closePanel(); toast(`已放到快捷欄 ${i + 1}`); }
            else openSlotPicker({ skill: id });
          };
        }
        row.appendChild(s);
        any ||= has;
      }
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
  // 頭盔技能:目前戴的魔法頭盔給的魔法(MP 顯示減半後的)
  const helm = [...helmSkillIds()];
  if (helm.length) {
    const sec = el('section', 'skill-group');
    sec.appendChild(el('h4', '', `頭盔技能(${wornHelms().join('、')})`));
    const row = el('div', 'skill-row');
    row.appendChild(el('span', 'tier', '頭盔'));
    for (const id of helm) {
      const s = el('span', 'skill learned helm');
      s.appendChild(skillIcon(skills[id].name));
      s.appendChild(el('b', 'mp', skillMp(id)));
      s.title = `${skills[id].name}(MP ${skillMp(id)})`;
      s.onclick = () => {
        if (panel.pickSlot != null) { const i = panel.pickSlot; setSlot(i, { skill: id }); closePanel(); toast(`已放到快捷欄 ${i + 1}`); }
        else openSlotPicker({ skill: id });
      };
      row.appendChild(s);
    }
    sec.appendChild(row);
    body.appendChild(sec);
    any = true;
  }
  if (!any) body.prepend(el('p', 'empty', '還沒有學會任何魔法。可以到魔法商人或使用魔法書學習。'));
}
function renderSkills() { if (panel.name === 'skill') renderPanel(); renderSupport(); }

// ---- 輔助魔法列(快捷欄上方):列已學會、有對應卷軸或已勾選的卷軸魔法;點選後效果消失就自動重放 ----
// active:效果還在嗎(看伺服器送的狀態圖示)
const MP_WASH_SKILLS = [130, 146]; // 自動洗 MP:心靈轉換、魂體轉換(妖精)
const SUPPORT_SKILLS = [
  // 防禦魔法:伺服器互相取代,只有保護罩和大地防護能同時存在(大地防護是自己的 'earth' 圖示);身上已經有同等或更強的就不放,不然勾兩個會一直互蓋
  // (離線掛機 L1OfflineHunt.supportActive 同一套)
  [3, () => ['保護罩', '影之防護', '鋼鐵防護'].includes(st.buffs.get('shield')?.label)], // 大地的祝福在 'earth' 欄,不影響保護罩
  [14, () => st.buffs.has('sk14') || castWithin(14, 15)],
  [26, () => st.buffs.has('dex')],
  [42, () => st.buffs.has('str')],
  [43, () => self()?.speed === 1],
  [54, () => self()?.speed === 1],
  [52, () => !!self()?.brave || st.buffs.has('brave')],
  [151, () => st.buffs.has('earth') || ['大地的祝福', '鋼鐵防護'].includes(st.buffs.get('shield')?.label)],
  // 大地的祝福:能和保護罩並存,和大地防護互斥(放了會取代大地防護);只在已經有大地的祝福、或有鋼鐵防護時才不放
  [159, () => st.buffs.get('earth')?.label === '大地的祝福' || st.buffs.get('shield')?.label === '鋼鐵防護'],
  [168, () => st.buffs.get('shield')?.label === '鋼鐵防護'],
  [170, () => st.buffs.has('sk170') || castWithin(170, 15)], // 水之元氣:下一次治癒類魔法加倍,用掉就消失(伺服器 S_WebBuffIcon 170)
  // 耗精靈玉的妖精輔助魔法(使用者 10/22 要全部進 AUTO 清單;精靈玉不夠自動補):都不在伺服器 deleteRepeatedSkills 的互斥組裡,各自獨立,不會互相蓋
  [169, () => st.buffs.has('sk169') || castWithin(169, 15)], // 體能激發(伺服器 S_WebBuffIcon 169)
  [171, () => st.buffs.has('sk171') || castWithin(171, 15)], // 屬性之火
  [175, () => st.buffs.has('sk175') || castWithin(175, 15)], // 烈焰之魂
  [176, () => st.buffs.has('sk176') || castWithin(176, 15)], // 能量激發
  [134, () => castWithin(134, 26)], // 鏡反射:伺服器沒送狀態圖示(S_WebBuffIcon 沒有 134),照效果時間 16 秒計時(castWithin 會提早 10 秒,所以給 26)
  [158, () => st.buffs.has('sk158') || castWithin(158, 15)], // 生命之泉:看狀態圖示(伺服器 S_WebBuffIcon 158);剛放完 5 秒內等圖示
  // 妖精精靈魔法(要精靈玉,潘朵拉有賣):都看狀態圖示(伺服器 S_WebBuffIcon)
  [129, () => st.buffs.has('sk129') || castWithin(129, 15)], // 魔法防禦
  [137, () => st.buffs.has('sk137') || castWithin(137, 15)], // 淨化精神
  [138, () => st.buffs.has('sk138') || castWithin(138, 15)], // 屬性防禦
  [147, () => st.buffs.has('sk147') || castWithin(147, 15)], // 單屬性防禦(要有精靈屬性)
  // 火焰武器、風之神射、暴風之眼、暴風神射:伺服器同一組互相取代(還有烈炎氣息、烈炎武器),身上有任何一個就不放,不然開兩個會一直互蓋
  [148, () => elfWeaponBuff() || castWithin(148, 15)],
  [149, () => elfWeaponBuff() || castWithin(149, 15)],
  [155, () => elfWeaponBuff() || castWithin(155, 15)], // 烈炎氣息
  [156, () => elfWeaponBuff() || castWithin(156, 15)], // 暴風之眼(使用者 10/18 要加進自動喝水;圖示是 S_SkillIconAura 155 → sk156)
  [166, () => elfWeaponBuff() || castWithin(166, 15)],
  [163, () => elfWeaponBuff() || castWithin(163, 15)], // 烈炎武器(妖精 50 等火屬性;10/31 使用者「要放進去」):同屬性武器組,伺服器 S_SkillIconAura 162 → sk163
  // 武器 / 盔甲類看 S_WebBuffIcon;剛送出後保留 5 秒等待狀態
  [8, () => st.buffs.has('sk8') || castWithin(8, 15)],
  [48, () => st.buffs.has('sk48') || castWithin(48, 15)],
  // 擬似魔法武器、鎧甲護持:網頁版改成掛在角色身上(伺服器送 S_WebBuffIcon 狀態圖示 sk12 / sk21),看圖示;剛放完 5 秒內等圖示
  [12, () => st.buffs.has('sk12') || castWithin(12, 15)],
  [21, () => st.buffs.has('sk21') || castWithin(21, 15)],
  // 衝擊士氣(王族):狀態圖示走 S_SkillIconAura(sk117);剛放完 5 秒內等圖示
  [117, () => st.buffs.has('sk117') || castWithin(117, 15)],
  [119, () => st.buffs.has('sk119') || castWithin(119, 15)], // 勇猛意志獨立狀態
  // 騎士自身 buff(使用者 11/07「增幅防禦…也要加入自動施放」):伺服器 S_WebBuffIcon 88 / 89 / 90 狀態圖示(同日加);剛放完 5 秒內等圖示
  [88, () => st.buffs.has('sk88') || castWithin(88, 15)], // 增幅防禦
  [89, () => st.buffs.has('sk89') || castWithin(89, 15)], // 尖刺盔甲
  [90, () => st.buffs.has('sk90') || castWithin(90, 15)], // 堅固防護
  // 狂暴術(法師,使用者 10/31「狂暴術要能夠支持自動施放」):伺服器 S_WebBuffIcon 55 有狀態圖示;一律放自己(AC +10、額外傷害 +5、命中 +2,效果中不會自然回血)
  [55, () => st.buffs.has('sk55') || castWithin(55, 15)],
  // 靈魂昇華(法師):伺服器沒送狀態圖示,照效果時間 30 分鐘計時(同神聖武器 / 祝福魔法武器)
  [79, () => castWithin(79, 1800)],
  // 召喚術:身邊沒有自己的召喚獸才放;剛放完 5 秒內等召喚獸出來;戴召喚控制戒指時要選種類(會跳選單),不自動放
  [51, () => summonSkip()], // 可召喚數 < 1(帶寵物佔滿名額)就不放:伺服器照扣寶石 / MP 卻召不出來
];
// 上次施放後還在持續時間內(提早 10 秒重放)
const castWithin = (id, sec) => lastCast[id] != null && performance.now() - lastCast[id] < sec * 1000 - 10000;
// 火焰武器 / 風之神射 / 烈炎氣息 / 暴風之眼 / 烈炎武器 / 暴風神射 同一組(伺服器 deleteRepeatedSkills):身上有任何一個的狀態圖示
const elfWeaponBuff = () => [148, 149, 155, 156, 163, 166].some((id) => st.buffs.has(`sk${id}`));
// 召喚獸和寵物在網頁上都只看得到「有主人」:記下放召喚術後 5 秒內出現的自己的寵物名稱,當成召喚獸(存在瀏覽器)
const SUMMON_NAMES = new Set(['食人妖精', '食人妖精王', ...(store.get('summonNames') || [])]);
function hasMySummon() {
  const me = self();
  const mine = [...st.objects.values()].filter((o) => isMyPet(o) && !o.dead);
  if (lastCast[51] != null && performance.now() - lastCast[51] < 5000) {
    let added = false;
    for (const o of mine) if (!SUMMON_NAMES.has(o.name)) { SUMMON_NAMES.add(o.name); added = true; }
    if (added) store.set('summonNames', [...SUMMON_NAMES].slice(-30));
  }
  return mine.some((o) => SUMMON_NAMES.has(o.name));
}
// 召喚術要不要跳過(true = 不放):身邊有自己的召喚獸 / 剛放完 5 秒內等召喚獸出來 / 戴召喚控制戒指 / 名額不夠 / 退避中
// 看到有自己的召喚獸時記下「這次施放成功」(summonOkFor):之後召喚獸死掉,不會被當成「沒召出來」而擋 60 秒
let summonOkFor = null;
function summonSkip() {
  if (hasMySummon()) { summonOkFor = lastCast[51]; return true; }
  return castWithin(51, 15) || wearsSummonRing() || summonSlots() < 1 || summonBlocked();
}
// 放完召喚術 5 秒內沒出現自己的召喚獸(名額不夠 / 地圖不能召喚 / 其他伺服器端原因,伺服器照扣寶石和 MP):60 秒內不再放(以前約每 5 秒重放一次)
let summonBlockUntil = 0;
let summonJudgedAt = null;
function summonBlocked() {
  const now = performance.now();
  const t = lastCast[51];
  if (t != null && t !== summonOkFor && t !== summonJudgedAt && now - t >= 5000) { // 每次施放只判斷一次;已經看到召喚獸的那次不判
    summonJudgedAt = t;
    summonBlockUntil = now + 60000; // 走到這裡 = 沒有自己的召喚獸(summonSkip 先看過)
  }
  return now < summonBlockUntil;
}
// 這次召喚術召得出幾隻(同伺服器 L1BuffUtil SUMMON_MONSTER 非戒指非黑豹那段):(max(min(魅力,34)+6, SummonMinCount 2 × 6) − 6 × 現有寵物數) / 6;網頁拿不到魅力時當作還有名額
function summonSlots() {
  const cha = st.me?.cha;
  if (!(cha >= 0)) return 99;
  const me = self();
  const pets = [...st.objects.values()].filter((o) => isMyPet(o) && !o.dead && o.hpRatio >= 0).length; // 有 hpRatio = 寵物 / 召喚獸(S_PetPack 帶血量);魔法娃娃(S_DollPack)沒有,伺服器也不算進寵物名單
  return Math.floor((Math.max(Math.min(cha, 34) + 6, 12) - 6 * pets) / 6);
}
const wearsSummonRing = () => [...st.inv.values()].some((it) => isEquipped(it) && /召喚控制戒指/.test(it.name));
// 學會 / 忘記魔法時,設定面板的 Buff 分頁要跟著更新
function renderSupport() {
  if (panel.name === 'settings' && panel.tab === 'potion') renderPanel();
}
let nextSupportCast = 0;
let nextAutoScroll = 0; // delay_id 5:補血與輔助卷軸共用
tickEvery(() => { // 背景分頁也照跑(app.js runTick)
  if (typeof unifiedPassive === 'function' && unifiedPassive()) return;
  if (srvActive()) return;
  const me = self();
  if (!st.inGame || !me || me.dead || !st.me) return;
  if (document.visibilityState === 'hidden' && serverHunting()) return; // 在背景、個人獵場:伺服器在代打
  const now = performance.now();
  if (now < nextSupportCast) return;
  for (const [id, active] of SUPPORT_SKILLS) {
    if (srvActive() && scrollKindForSkill(id)) continue;
    if (!settings.autoSkills?.includes(id) || active()) continue;
    const sk = st.game.skills?.[id];
    if (!sk) continue;
    const kind = scrollKindForSkill(id);
    if (kind && autoScrollInBag(kind)) {
      if (autoScrollActive(id)) continue;
      if (tryAutoScroll(id) === 1) { nextSupportCast = now + 1500; return; }
      continue; // 有卷軸但仍在冷卻 / 動作鎖:等待,不改耗 MP。
    }
    if (!st.skills.has(id) || st.me.mp < skillMp(id)) continue;
    if (id === 51) { // 召喚術一次用 3 個魔法寶石:不夠就先付費補(伺服器 C_WebAutoBuy,一個 1200),下一輪再放
      const gems = [...st.inv.values()].filter((it) => baseName(it) === '魔法寶石').reduce((n, it) => n + it.count, 0);
      if (gems < 3) {
        if (now - (st.lastGemBuy || 0) < 10000) continue; // 買過還是不夠(金幣不足):10 秒內不再試
        st.lastGemBuy = now;
        send({ t: 'paidarrow', item: 40318, count: 3 - gems });
        nextSupportCast = now + 1500;
        return;
      }
    }
    if (sk.mat?.[0] === ORB_ID) { // 耗精靈玉(40319)的魔法(淨化精神、水之元氣…,看 game.json 的 mat 耗材欄,不列舉編號):不夠就先付費補(伺服器 C_WebAutoBuy,一個 350),下一輪再放;買不起 / 這站不能買就不放,也不一直送封包
      const orbs = [...st.inv.values()].filter((it) => baseName(it) === '精靈玉').reduce((n, it) => n + it.count, 0);
      const orbNeed = sk.mat[1] || 1;
      if (orbs < orbNeed) {
        if (!st.paidBuy?.has(ORB_ID) || now - (st.lastOrbBuy || 0) < 10000) continue; // 這站不能買 / 10 秒內買過還是沒有(金幣不足):先看下一個魔法
        const orbBuy = orbNeed - orbs;
        if (adena() < orbBuy * ORB_PRICE) {
          st.lastOrbBuy = now;
          if (!poorWarned.has(ORB_ID)) { poorWarned.add(ORB_ID); log(`${sk.name}:精靈玉不夠,金幣不足 ${fmt(orbBuy * ORB_PRICE)},買不起。`, 'sys'); }
          continue;
        }
        poorWarned.delete(ORB_ID);
        st.lastOrbBuy = now;
        send({ t: 'paidarrow', item: ORB_ID, count: orbBuy });
        nextSupportCast = now + 1500;
        return;
      }
    }
    castSkill(id, true, null, false, true); // 一律放自己(效果看的是自己身上的;選了隊友也不放到隊友身上)
    nextSupportCast = now + 1500; // 一次放一個,等伺服器回狀態
    return;
  }
  if (settings.petHaste && canPetHaste() && st.me.mp >= skillMp(43) && !me.anim && !(me.lunge && now < me.lunge + (me.lungeMs || 0))) {
    for (const o of st.objects.values()) {
      if (!isMyPet(o) || o.dead || o.dying || o.speed === 1) continue;
      if (now - (petHasteAt.get(o.id) || 0) < 5000) continue; // 剛放過,等伺服器回狀態
      if (Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) > 10 || !clearLine(me.x, me.y, o.x, o.y)) continue;
      petHasteAt.set(o.id, now);
      startCast(me, st.game.skills[43], o);
      send({ t: 'useskill', skill: 43, target: o.id, x: o.x, y: o.y });
      nextSupportCast = now + 1500;
      return;
    }
  }
}, 500);
// 寵物 / 召喚獸自動加速:要自己學會加速術(法師、妖精);騎士戴魔法頭盔得到的加速術不算
const canPetHaste = () => st.skills.has(43) && (CLASS_SKILLS[st.myType]?.[0] ?? 10) >= 6;
const petHasteAt = new Map(); // 寵物編號 -> 上次對牠放加速術的時間

// ---- 設定 ----
// 設定和快捷欄每個角色各自一份(存在瀏覽器,鍵值帶角色名稱);進入遊戲時 loadCharPrefs() 換成該角色的
const DEFAULT_SETTINGS = () => ({
  itemBlessNotice: true, // 11/02 #43 獲得道具時在對話框標示祝福 / 詛咒(設定 → 訊息過濾 可關)
  msgHide: { 77: true }, // 11/02 #44 訊息過濾:要隱藏的系統訊息編號(77 = 你覺得舒服多了,預設隱藏);其他預設顯示
  hotkeyCooldown: true, // 每角色儲存，預設顯示
  walkHint: true, // 每角色儲存;舊設定缺欄位時預設開啟
  escape: { on: false, hp: 20 },
  potion: { on: true, hp: 60 },
  atkSkill: { on: false, id: 0, mp: 30 }, // 自動魔法攻擊:MP 高於 mp% 時用魔法打
  openSkill: { on: false, id: 0, mp: 0 }, // 開怪技能:每隻怪第一下用的魔法(MP 高於 mp% 時)
  healSkill: { on: false, id: 0, hp: 50 }, // 自動技能補血:HP 低於 hp% 時對自己放
  petHeal: { on: false, id: 0, hp: 50 }, // 寵物 / 召喚獸自動補血:牠的 HP 低於 hp% 時對牠放
  aoeSkill: { on: false, id: 0, count: 3, mp: 0 }, // 範圍技能:周圍 3 格內的怪超過 count 隻、MP 高於 mp% 時用這個魔法
  arrows: { on: true, below: 100, kind: 40744 }, // 自動購買箭矢(預設開:弓沒箭會一直 Miss;kind 銀箭 / 奧里哈魯根箭)
  cure: { on: false, kind: 40017 }, // 自動解毒(翡翠藥水 / 安特之樹枝),預設關
  med: { on: true }, // 冥想術只對法師生效,施法與材料購買由伺服器處理
  cm: { on: false, kind: 40889 }, // 自動魔法屏障(卷軸 / 技能),預設關
  mpWash: { on: false, id: 0, mp: 50, hp: 70 }, // 自動洗 MP:MP 低於 mp%、HP 高於 hp% 時放心靈轉換 / 魂體轉換(扣血換魔)
  poly: { on: false, kind: 0 }, // 自動變身:沒在變身時用變身卷軸(潘朵拉有賣的三種);預設關、沒選卷軸
  haste: false,
  brave: false,
  doll: { on: false, itemId: 0 },
  windWalk: false, // 風之疾走獨立開關:舊設定缺欄位時關閉
  whet: false, // 自動磨刀石:揮舞中的武器有損傷就用(背包沒有就付費買一個);預設關
  petResurrect: false, // 只由伺服器在 AUTO / 離線掛機中使用背包卷軸
  petHaste: false, // 寵物 / 召喚獸自動加速(要學會加速術)
  patrol: { range: 0 },
  idleTp: { on: false, sec: 5 }, // 沒怪瞬移:AUTO 時 sec 秒附近都沒有怪就用瞬間移動卷軸(不用祝福的,沒有就付費買);跟定點巡邏擇一
  tpSkill: false, // 瞬移(沒怪瞬移 / 低血逃跑)優先用「指定傳送」技能(5):預設關(使用者 10/20,玩家自己開);開了且學會、MP 夠、不在冷卻就放技能,否則用卷軸
});
const charKey = (k) => `${k}:${st.myName || '_'}`;
const settings = DEFAULT_SETTINGS();
// 舊版存檔沒有這些欄位時補上預設值
settings.potion.kind ??= 40010;
  if (![40010, 40011, 40012].includes(settings.potion.kind)) { settings.potion.kind = 40010; settings.potion.on = false; }
// 自動戰鬥設定同步給伺服器:在個人獵場開著 AUTO 關掉網頁時,伺服器照這份設定離線掛機
function syncDollSettings(explicit = false) {
  if (!st.inGame || !st.magicDoll?.enabled) return;
  // Avoid spending from stale localStorage before the persisted settings snapshot arrives.
  if (!explicit && st.charSettingsServer !== false && !srvSet.loaded) return;
  send({ t: 'dollsettings', on: settings.doll?.on === true, itemId: settings.doll?.itemId || 0 });
}
function syncAutoHunt() {
  syncDollSettings();
  polyMigrate(); // 網頁版 11/05 polymenu：先遷移再送 JSON 或 footer。
  if (typeof unifiedSync === 'function' && unifiedSync()) return;
  huntExpSync();
  if (!st.inGame) return;
  const supplyNow = performance.now();
  const supplyWait = [auto.nextPotion, auto.nextHeal, auto.nextBuff, auto.nextCure, auto.nextCm,
    nextAutoScroll, nextSupportCast, auto.nextWash || 0].map((at) => Math.min(65535, Math.ceil(Math.max(0, (at || 0) - supplyNow))));
  send({
    t: 'autohunt', on: auto.on,
    potionOn: settings.potion.on, hp: settings.potion.hp, potionKind: settings.potion.kind,
    haste: settings.haste, hasteKind: settings.hasteKind ?? 40013, brave: settings.brave, windWalk: !!settings.windWalk,
    arrowOn: settings.arrows.on, arrowBelow: settings.arrows.below, arrowKind: arrowKind(),
    // 其餘 AUTO 設定也給伺服器,代打時照同樣的規則(L1OfflineHunt)
    escapeOn: settings.escape.on, escapeHp: settings.escape.hp, blue: !!settings.blue, wis: !!settings.wis,
    healOn: settings.healSkill.on, healId: settings.healSkill.id, healHp: settings.healSkill.hp,
    atkOn: settings.atkSkill.on, atkId: settings.atkSkill.id, atkMp: settings.atkSkill.mp,
    openOn: settings.openSkill.on, openId: settings.openSkill.id, openMp: settings.openSkill.mp,
    patrol: settings.patrol.range, anchorX: auto.anchor?.x || 0, anchorY: auto.anchor?.y || 0,
    support: srvSup.v >= 2 ? [
      ...SUPPORT_SKILLS.filter(([id]) => settings.autoSkills?.includes(id)).map(([id]) => id),
      ...PolyMenu.footer(settings.poly, supplyWait, (settings.poly.on ? 1 : 0) | (medEnabled() ? 2 : 0), PolyMenu.active(polyMenuData)),
    ] : (settings.autoSkills || []),
    petHaste: !!settings.petHaste && canPetHaste(),
    petHealOn: settings.petHeal.on, petHealId: settings.petHeal.id, petHealHp: settings.petHeal.hp,
    aoeOn: settings.aoeSkill.on, aoeId: settings.aoeSkill.id, aoeCount: settings.aoeSkill.count, aoeMp: settings.aoeSkill.mp,
    cureOn: settings.cure.on, cureKind: settings.cure.kind,
    medOn: medEnabled(),
    cmOn: !!settings.cm?.on, cmKind: settings.cm?.kind || CM_SCROLL,
    mwOn: !!settings.mpWash?.on, mwId: settings.mpWash?.id || 0, mwMp: settings.mpWash?.mp ?? 50, mwHp: settings.mpWash?.hp ?? 70,
    whetOn: !!settings.whet && st.paidBuy?.has(WHET_KIND),
    idleTpOn: !!settings.idleTp?.on && !settings.patrol.range, idleTpSec: settings.idleTp?.sec || 5,
    tpSkill: !!settings.tpSkill,
    petResurrect: !!settings.petResurrect,
    srvSupply: srvActive(), // 伺服器在補給、網頁不喝(autosupply 事件);0 = 照舊網頁自己喝
  });
}
const saveSettings = () => { store.set(charKey('settings'), settings); syncAutoHunt(); srvSetDirty(); };
// ---- 設定存伺服器(DESIGN §7;altsettings CharSettingsServerEnabled,關著 / 舊 gateway 不會送 settings → 全部不動,照原本只存 localStorage)----
// 進遊戲、背包送完後 gateway 送 {t:'settings',ver,json}(ver 0 = 伺服器沒有;err = 讀取失敗,只用 localStorage 快取、不上傳);
// 改動 2 秒後 settingsave 上傳(ver = 我認為伺服器現在的版本),成功回 settingsack(新 ver),別台裝置先存了回 settings(conflict):用伺服器那份覆蓋
const srvSet = { ver: -1, loaded: false, inflight: 0, dirty: false, timer: 0, getTimer: 0, getN: 0 };
function srvSetReset() { srvSet.ver = -1; srvSet.loaded = false; srvSet.inflight = 0; srvSet.dirty = false; clearTimeout(srvSet.timer); srvSet.timer = 0; clearTimeout(srvSet.getTimer); srvSet.getTimer = 0; srvSet.getN = 0; }
function srvSetDirty() {
  if (!srvSet.loaded) return;
  srvSet.dirty = true;
  clearTimeout(srvSet.timer);
  srvSet.timer = setTimeout(srvSetFlush, 2000);
}
function srvSetFlush() {
  srvSet.timer = 0;
  if (!srvSet.loaded || !srvSet.dirty || !st.inGame) return;
  if (srvSet.inflight) { // 上一份還沒回:等 ack(15 秒沒回就當沒送到,重送)
    if (Date.now() - srvSet.inflight < 15000) { srvSet.timer = setTimeout(srvSetFlush, 2000); return; }
    srvSet.inflight = 0;
  }
  const json = JSON.stringify(settings);
  if (new TextEncoder().encode(json).length > 15000) return; // gateway 上限 16 KB:太大不傳(設定正常 < 1 KB)
  srvSet.dirty = false;
  srvSet.inflight = Date.now();
  send({ t: 'settingsave', ver: srvSet.ver, json });
}
// 伺服器送來的設定套到 settings(正規化同 loadCharPrefs)
function srvSetApply(obj) {
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, DEFAULT_SETTINGS(), obj);
  settings.potion.kind ??= 40010;
  if (![40010, 40011, 40012].includes(settings.potion.kind)) { settings.potion.kind = 40010; settings.potion.on = false; }
  settings.hasteKind ??= 40013;
  settings.autoSkills ??= [];
  const d = DEFAULT_SETTINGS();
  for (const k of ['atkSkill', 'openSkill', 'healSkill', 'petHeal', 'aoeSkill', 'arrows', 'cure', 'poly', 'cm', 'med', 'mpWash', 'msgHide', 'doll']) settings[k] = { ...d[k], ...settings[k] };
  polyMigrate(); // 網頁版 11/05 polymenu：伺服器舊設定也保留原外型。
  store.set(charKey('settings'), settings); // localStorage 只當快取
  renderHomeBtn();
  rebuildHotbarCooldownMasks();
  syncAutoHunt();
  if (panel.name) renderPanel();
}
function srvSetOnEvent(ev) {
  if (ev.err) { // 讀取失敗:不上傳(送 ver 0 會誤觸遷移把伺服器那份蓋掉);30 秒後請 gateway 重讀(最多 6 次)
    srvSet.loaded = false;
    clearTimeout(srvSet.getTimer);
    if (srvSet.getN++ < 6) srvSet.getTimer = setTimeout(() => { if (st.inGame && !srvSet.loaded) send({ t: 'settingsget' }); }, 30000);
    return;
  }
  srvSet.getN = 0; // 讀取失敗:不上傳(送 ver 0 會誤觸遷移把伺服器那份蓋掉)
  const ver = ev.ver | 0;
  if (ver > 0 && typeof ev.json === 'string') {
    if (srvSet.loaded && ver === srvSet.ver && !ev.conflict) return; // 接回重送的同一版:沒有新東西,不蓋掉還沒上傳的修改
    let obj = null;
    try { obj = JSON.parse(ev.json); } catch { /* 壞資料 */ }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    srvSetApply(obj);
    srvSet.ver = ver; srvSet.loaded = true; srvSet.inflight = 0; srvSet.dirty = false;
    syncDollSettings();
    return;
  }
  const had = srvSet.loaded;
  srvSet.ver = 0; srvSet.loaded = true; srvSet.inflight = 0;
  syncDollSettings();
  // 一次性遷移:伺服器沒有、這台裝置的 localStorage 有 → 上傳(之後 localStorage 只當快取)
  if (!had && store.get(charKey('settings'), null) != null) { srvSet.dirty = true; clearTimeout(srvSet.timer); srvSet.timer = setTimeout(srvSetFlush, 500); }
}
function srvSetAck(ev) {
  srvSet.inflight = 0;
  if (ev.err === 2) { srvSet.dirty = false; return; } // 這份存檔不合格(永久錯誤):不重送,下次改動再傳
  if (ev.err) { if (srvSet.loaded) { srvSet.dirty = true; clearTimeout(srvSet.timer); srvSet.timer = setTimeout(srvSetFlush, 10000); } return; } // 伺服器放棄這次存檔:10 秒後再傳
  srvSet.ver = ev.ver | 0;
  if (srvSet.dirty) { clearTimeout(srvSet.timer); srvSet.timer = setTimeout(srvSetFlush, 2000); }
}
// ---- AUTO 補給交給伺服器(DESIGN §3):autosupply on = 伺服器補給,網頁停掉自己的喝水 / 解毒 / 屏障 / 加速 / 勇敢 / 藍水 / 慎重,autohunt 帶 srvSupply = 1;
// off / 沒收到(舊伺服器)= 照舊自己喝。背景分頁時 autohunt 照樣先送(on = true),不會送 on = false
const srvSup = { on: false, v: 0, petHealPriority: false };
const srvActive = () => srvSup.on && srvSup.v >= 2;
function srvSupplyEvent(ev) {
  const wasActive = srvActive();
  srvSup.petHealPriority = ev.petHealPriority === true;
  srvSup.on = !!ev.on;
  srvSup.v = Number(ev.v) || 0;
  if (Array.isArray(ev.wait) && ev.wait.length === 8) {
    const now = performance.now();
    const wait = ev.wait.map((ms) => now + Math.max(0, Math.min(65535, Number(ms) || 0)));
    for (const [i, key] of ['nextPotion', 'nextHeal', 'nextBuff', 'nextCure', 'nextCm'].entries()) auto[key] = Math.max(auto[key] || 0, wait[i]);
    nextAutoScroll = Math.max(nextAutoScroll, wait[5]);
    nextSupportCast = Math.max(nextSupportCast, wait[6]);
    auto.nextWash = Math.max(auto.nextWash || 0, wait[7]);
  }
  if (!wasActive && srvActive() && st.pendingCastSupply) {
    st.pendingCast = null; st.pendingCastHeal = null; st.pendingCastWindWalk = false;
    st.pendingCastSupply = false;
  }
  syncAutoHunt(); // Also resend on repeated login/reconnect mode events, with AUTO off too.
}
function srvSpentEvent(ev) {} // 花費只讀伺服器收益帳。
function loadCharPrefs() {
  if ($('#itemsheet').classList.contains('poly-sheet')) closeItemSheet();
  resetHotbarCooldown();
  srvSetReset(); // 換角色:伺服器設定版本重來(進遊戲後 gateway 會再送)
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, DEFAULT_SETTINGS(), store.get(charKey('settings'), {}));
  settings.potion.kind ??= 40010;
  if (![40010, 40011, 40012].includes(settings.potion.kind)) { settings.potion.kind = 40010; settings.potion.on = false; }
  settings.hasteKind ??= 40013;
  settings.autoSkills ??= [];
  const d = DEFAULT_SETTINGS();
  for (const k of ['atkSkill', 'openSkill', 'healSkill', 'petHeal', 'aoeSkill', 'arrows', 'cure', 'poly', 'cm', 'med', 'mpWash', 'msgHide', 'doll']) settings[k] = { ...d[k], ...settings[k] };
  polyMigrate(); // 網頁版 11/05 polymenu：每個角色各自遷移。
  if (!settings.cureDefaultOff) { settings.cure.on = false; settings.cureDefaultOff = true; store.set(charKey('settings'), settings); } // 自動解毒改成預設關:舊存檔也關一次(之後照玩家自己的設定)
  if (!settings.arrowsDefaultOn) { settings.arrows.on = true; settings.arrowsDefaultOn = true; store.set(charKey('settings'), settings); } // 舊存檔也打開一次(之後照玩家自己的設定)
  renderHomeBtn();
  huntLoad(); // 這個角色的掛機統計
  st.hotbarLock = !!store.get(charKey('hotbarLock'), false); syncHotbarLock();
  st.hotbar = store.get(charKey('hotbar'), [null, null, null, null, null])
    .map((v) => (typeof v === 'string' && !isHotbarItem(v) ? null : v)); // 以前放的非藥水道具拿掉
  renderHotbar();
  if (panel.name) renderPanel();
}

// 自動喝水可選的藥水;背包沒有時「付費喝水」:直接扣一瓶的商店售價並喝下(伺服器 C_WebAutoBuy)
// 魔法卷軸:只用背包裡的卷軸,刻印優先。
const AUTO_SCROLLS = {
  40859: [1, '魔法卷軸 (初級治癒術)', 0],
  40861: [3, '魔法卷軸 (保護罩)', 1800],
  40866: [8, '魔法卷軸 (神聖武器)', 1200],
  40870: [12, '魔法卷軸 (擬似魔法武器)', 1800],
  40872: [14, '魔法卷軸 (負重強化)', 1800],
  40877: [19, '魔法卷軸 (中級治癒術)', 0],
  40879: [21, '魔法卷軸 (鎧甲護持)', 1800],
  40884: [26, '魔法卷軸 (通暢氣脈術)', 1200],
  40893: [35, '魔法卷軸 (高級治癒術)', 0],
  49281: [42, '魔法卷軸 (體魄強健術)', 1800],
  49282: [48, '魔法卷軸 (祝福魔法武器)', 1800],
  49284: [52, '魔法卷軸 (神聖疾走)', 1800],
  49285: [54, '魔法卷軸 (強力加速術)', 1800],
  49286: [57, '魔法卷軸 (全部治癒術)', 1800],
};
function autoScrollInBag(kind) {
  const name = AUTO_SCROLLS[kind]?.[1];
  if (!name) return null;
  let found = null;
  for (const it of st.inv.values()) {
    if (it.count <= 0) continue;
    const n = it.name.replace(/^\+\d+\s*/, '');
    if (n !== name && !n.startsWith(`${name} (`) && !n.startsWith(`${name}(`)) continue;
    if (it.bless >= 128) return it;
    found ??= it;
  }
  return found;
}
const scrollKindForSkill = (id) => +Object.keys(AUTO_SCROLLS).find((kind) => AUTO_SCROLLS[kind][0] === id) || 0;
// 有對應卷軸的魔法可保留未學會的選項;寵物補血仍只看已學會。
const autoSkillVisible = (id, selected) => st.skills.has(id)
  || !!(scrollKindForSkill(id) && (autoScrollInBag(scrollKindForSkill(id)) || selected));
const autoScrollEmpty = (id) => !!scrollKindForSkill(id) && !st.skills.has(id) && !autoScrollInBag(scrollKindForSkill(id));
const selfHealReady = (id) => !!autoScrollInBag(scrollKindForSkill(id))
  || (st.skills.has(id) && st.me.mp >= skillMp(id));
// 0 = 無卷軸;1 = 已送出;2 = 有卷軸但需等待。僅供已驗證的自我自動魔法使用。
function tryAutoScroll(id) {
  const kind = scrollKindForSkill(id);
  const scroll = kind && autoScrollInBag(kind);
  if (!scroll) return 0;
  const now = performance.now(), me = self();
  if (!me || me.dead || st.para || now < nextAutoScroll || me.anim
      || (me.lunge && now < me.lunge + (me.lungeMs || 0)) || now < (st.castLockUntil || 0)) return 2;
  send({ t: 'useitem', id: scroll.id, target: st.selfId });
  lastCast[id] = now;
  nextAutoScroll = now + AUTO_SCROLLS[kind][2] + 50;
  return 1;
}
function autoScrollActive(id) {
  if (id === 52) return !!self()?.brave || st.buffs.has('brave') || castWithin(id, 15);
  if (id === 54) return self()?.speed === 1 || castWithin(id, 15);
  if (id === 14) return st.buffs.has('sk14') || castWithin(id, 15);
  return SUPPORT_SKILLS.find(([skill]) => skill === id)?.[1]() || castWithin(id, 15);
}
const POTION_KINDS = { 40010: ['治癒藥水', 44], 40011: ['強力治癒藥水', 238], 40012: ['終極治癒藥水', 714] };
// 治癒藥水的使用延遲(etcitem.delay_time,毫秒):自動喝水照這個間隔喝,和手動按一樣快
const POTION_DELAY = { 40010: 500, 40011: 1000, 40012: 1000 };
// 強化綠色藥水(背包顯示「強化 自我加速藥水」= $1652 $264,名稱要跟背包一樣才找得到)付費喝不划算:背包沒有就改喝自我加速藥水(沒有再付費喝),第三欄是選藥水時的說明
const HASTE_KINDS = { 40013: ['自我加速藥水', 200], 40018: ['強化 自我加速藥水', 1500, '沒有時自動購買自我加速藥水'] };
const BRAVE_KIND = 40014; // 勇敢藥水 800 金幣,只有騎士能喝
const MEDITATION = 32; // 冥想術:法師以外學得到的職業(例如妖精)也能自動施放(11/06)
const medAvailable = () => !!st.skills?.has(MEDITATION);
const medKey = () => (st.myType === 3 ? 'on' : 'other'); // 法師預設開(沿用舊設定);其他職業預設關,要自己點開
const medEnabled = () => medAvailable() && settings.med?.[medKey()] === true;
const WIND_WALK = 150; // 風之疾走(妖精技能,獨立勾選優先施放,未勾時保留餅乾備案)
const WAFFLE_KIND = 40068; // 精靈餅乾 800 金幣:妖精的二段加速
const DEVIL_KIND = 40031; // 惡魔之血 800 金幣(使用者 11/16 13:1x 由 1600 改,同商店價):王族的二段加速(效果同勇敢藥水,10 分鐘)
const BLUE_KIND = 40015; // 藍色藥水 1,000 金幣:魔力恢復加快
const WIS_KIND = 40016; // 慎重藥水 600 金幣,只有法師能喝
// 自動解毒:中毒(含麻痺毒、沉默毒)時喝。翡翠藥水背包沒有就付費喝;安特之樹枝買不到,只用背包裡的(用完改喝翡翠藥水)
const CURE_JADE = 40017;
const CURE_ANT = 40507;
// 解毒術(魔法 9):學會才列出來;MP 不夠時改喝翡翠藥水
const CURE_SKILL = 9;
const CURE_KINDS = { [CURE_JADE]: ['翡翠藥水', 70], [CURE_ANT]: ['安特之樹枝', 0, '沒有時自動購買翡翠藥水'],
  [CURE_SKILL]: ['解毒術', 0, 'MP 不足時改喝翡翠藥水'] };
const cureKinds = () => Object.fromEntries(Object.entries(CURE_KINDS).filter(([id]) => +id !== CURE_SKILL || st.skills.has(CURE_SKILL)));
// 解毒的圖示:解毒術畫魔法圖示,其他畫道具圖示
function cureIcon(kind, px) {
  if (kind !== CURE_SKILL) return iconCanvas({ name: CURE_KINDS[kind][0] }, px);
  const c = el('canvas', 'icon');
  c.width = c.height = px * DPR;
  c.style.width = c.style.height = `${px}px`;
  const draw = () => { if (!GDX.drawNamed(c.getContext('2d'), CURE_KINDS[kind][0], 0, 0, c.width)) setTimeout(draw, 500); };
  draw();
  return c;
}
// 自動魔法屏障:身上沒有魔法屏障(伺服器 S_WebBuffIcon 31 → buff 'sk31')就用。
// 卷軸只用背包裡的(買不到);選技能時學會、MP 夠就對自己放,不然改用卷軸
const CM_SCROLL = 40889;
const CM_SKILL = 31;
const CM_KINDS = { [CM_SCROLL]: ['魔法卷軸 (魔法屏障)', 0, '只用背包裡的卷軸'], [CM_SKILL]: ['魔法屏障', 0, 'MP 不足時改用卷軸'] };
const cmKinds = () => Object.fromEntries(Object.entries(CM_KINDS).filter(([id]) => +id !== CM_SKILL || st.skills.has(CM_SKILL)));
// 圖示:原版「魔法屏障」魔法圖示;選卷軸時右下角疊一張小的魔法卷軸(原版道具圖 invgfx 863)
function cmIcon(kind, px) {
  const c = el('canvas', 'icon');
  c.width = c.height = px * DPR;
  c.style.width = c.style.height = `${px}px`;
  const g = c.getContext('2d');
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height);
    if (!GDX.drawNamed(g, '魔法屏障', 0, 0, c.width)) { setTimeout(draw, 500); return; }
    if (kind === CM_SCROLL) {
      const s = Math.round(c.width * 0.55);
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(c.width - s, c.height - s, s, s);
      GDX.drawIcon(g, { name: '魔法卷軸 (魔法屏障)', gfx: 863 }, c.width - s, c.height - s, s);
    }
  };
  draw();
  return c;
}
// 背包裡的魔法屏障卷軸(名稱帶括號,baseName 會去掉,這裡比對完整名稱;刻印的優先)
function cmScrollInBag() {
  let found = null;
  for (const it of st.inv.values()) {
    if (!/^魔法卷軸\s*\(魔法屏障\)/.test(it.name)) continue;
    if (it.bless >= 128) return it;
    found ??= it;
  }
  return found;
}
// 自動變身:潘朵拉賣的變身卷軸。背包沒有就付費買一張(扣商店售價,伺服器 C_WebAutoBuy.buyArrows)再用;
// 伺服器 altsettings PaidArrowItemIds 有列的才能買(config.json paidBuyIds),沒列就不顯示這個功能
// 自動磨刀石:揮舞中的武器有損傷(伺服器物品狀態的損傷度,protocol.js readItem 的 wdmg)就對它用一個;
// 背包沒有就付費買一個(潘朵拉售價),伺服器 PaidArrowItemIds 有列 40317 才顯示這個功能
const CM_PRICE = 3000; // 魔法卷軸 (魔法屏障) 付費買一張(伺服器 PaidPotionPrices 40889:3000)
const WHET_KIND = 40317;
const POLY_KINDS = { 49401: ['變身卷軸(死亡騎士)', 12000], 49402: ['變身卷軸(黑暗精靈)', 12000], 99215: ['夏娜的變形卷軸', 3600] };
const ALL_POTIONS = { ...POTION_KINDS, ...HASTE_KINDS, [BRAVE_KIND]: ['勇敢藥水', 800], [WAFFLE_KIND]: ['精靈餅乾', 800], [DEVIL_KIND]: ['惡魔之血', 800],
  [BLUE_KIND]: ['藍色藥水', 1000], [WIS_KIND]: ['慎重藥水', 600], ...CURE_KINDS, ...POLY_KINDS, [WHET_KIND]: ['磨刀石', 150] };
const polyKinds = () => Object.fromEntries(Object.entries(POLY_KINDS).filter(([id]) => st.paidBuy?.has(+id)));
// 網頁版 11/05 polymenu：一份選單資料供背包、快捷欄與自動設定使用。
let polyMenuData = PolyMenu.empty();
function polyMigrate() {
  // 11/14:雷電死亡騎士 12230 於 11/13 換成 13790;舊設定對照過來(否則書模式找不到外型)。
  if (+settings.poly.form === 12230) { settings.poly.form = 13790; store.set(charKey('settings'), settings); }
  if (PolyMenu.migrate(settings.poly, polyMenuData)) store.set(charKey('settings'), settings);
}
async function refreshPolyMenu() {
  let next = PolyMenu.empty();
  try {
    const res = await fetch('/poly-menu', { cache: 'no-store' });
    if (res.ok) { const data = await res.json(); if (PolyMenu.active(data)) next = data; }
  } catch { /* 讀取失敗維持舊功能 */ }
  const changed = JSON.stringify(next) !== JSON.stringify(polyMenuData);
  polyMenuData = next;
  if (changed) {
    polyMigrate();
    if ($('#itemsheet').classList.contains('poly-sheet')) closeItemSheet();
    if (st.inGame) { syncAutoHunt(); renderHotbar(); }
    if (panel.name) renderPanel();
  }
}
function polyPortrait(gfx, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.className = 'poly-portrait'; canvas.width = size + 16; canvas.height = size + 8;
  let tries = 0;
  const paint = () => {
    if (!canvas.isConnected || canvas.closest('.hidden')) return;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 主導 11/05:有些外型沒有空手站立的動作(例:銀光巡守 3145 只有拿弓的),依序試各種武器的站立 / 走路動作;一直畫不出來最多重試 15 秒就停
    for (const weapon of [0, 20, 4, 50, 24, 40, 46, 54, 58, 62]) if (L1S.drawFigure(ctx, { gfx, kind: 'pc', weapon }, canvas.width / 2, size + 4, size)) return;
    if (++tries < 60) setTimeout(paint, 250);
  };
  setTimeout(paint, 0); return canvas;
}
function polyHotbarEntry(item) {
  if (!item || typeof item === 'string') return null;
  const tier = PolyMenu.tierForItem(polyMenuData, item);
  const row = tier?.items.find(i => PolyMenu.matches(item, i));
  return row ? { polyItem: row.item_id, name: row.name } : null;
}
function polyRemember(tier, form) {
  settings.polyLast ??= {};
  settings.polyLast[tier.tier] = form.poly_id;
}
let polyRequest = Date.now() % 2147483646;
function nextPolyRequest() { polyRequest = polyRequest % 2147483646 + 1; return polyRequest; }
function sendPolyBook(item, form, character) {
  const submit = () => {
    if (character !== st.myName) return;
    const book = st.inv.get(item.id), latest = PolyMenu.bookTier(polyMenuData)?.forms.find(f => f.poly_id === form.poly_id);
    const reason = PolyMenu.problem(PolyMenu.bookTier(polyMenuData), latest, st.me?.level ?? 0);
    if (!book || !PolyMenu.tierForItem(polyMenuData, book)?.book) { toast('背包沒有這本變身書'); return; }
    if (reason || latest.price !== form.price) { toast(reason || '價格已更新，請重新選擇外型'); return; }
    send({ t: 'useitem', id: book.id, form: form.poly_id, request: nextPolyRequest() });
    polyRemember(PolyMenu.bookTier(polyMenuData), latest); saveSettings(); closeItemSheet(); closeDialog();
  };
  const seconds = Math.max(0, ((st.buffs.get('poly')?.until ?? 0) - performance.now()) / 1000);
  const text = PolyMenu.confirmText(seconds, form, adena());
  if (!text) { submit(); return; }
  closeItemSheet(); showDialog('變身書', '');
  const box = el('div', 'tp-confirm'), row = el('div', 'tp-row');
  box.append(el('p', 'tp-q', text));
  const yes = el('button', 'menu-btn tp-yes', '確定變身'), no = el('button', 'menu-btn', '取消');
  yes.onclick = () => { yes.disabled = true; submit(); }; no.onclick = closeDialog;
  row.append(yes, no); box.append(row); $('#dlg-body').append(box);
}
function openPolyPicker(item = null) {
  if (!PolyMenu.active(polyMenuData)) return false;
  const tier = item && PolyMenu.tierForItem(polyMenuData, item), character = st.myName;
  if (item && !tier) return false;
  closeItemSheet();
  $('#itemsheet').classList.add('poly-sheet');
  $('#is-title').textContent = item ? `選擇變身 · ${tier.label} · 30 分鐘` : '自動變身 · 選擇外型';
  const current = PolyMenu.selection(settings.poly, polyMenuData);
  PolyMenu.render($('#is-body'), {
    mode: item ? 'use' : 'setting', tiers: item ? [tier] : polyMenuData.bookEnabled ? [PolyMenu.bookTier(polyMenuData)] : polyMenuData.tiers,
    gold: adena(),
    level: st.me?.level ?? 0, last: settings.polyLast, selected: item ? settings.polyLast?.[tier.tier] : current.form?.poly_id,
    inventory: [...st.inv.values()], portrait: polyPortrait, shanaPortrait: () => iconCanvas({ name: '變形卷軸' }, 36), message: toast,
    selectShana: () => { if (character !== st.myName) return; settings.poly.kind = 99215; delete settings.poly.form; saveSettings(); closeItemSheet(); renderPanel(); },
    select: (chosenTier, chosenForm) => {
      if (character !== st.myName || !PolyMenu.active(polyMenuData)) return;
      const latest = PolyMenu.tierForKind(polyMenuData, chosenTier.buy_item);
      const form = latest?.forms.find(f => f.poly_id === chosenForm.poly_id);
      const error = PolyMenu.problem(latest, form, st.me?.level ?? 0);
      if (error) { toast(error); return; }
      if (item) {
        const scroll = st.inv.get(item.id);
        if (!scroll || PolyMenu.tierForItem(polyMenuData, scroll)?.tier !== latest.tier) { toast('背包已沒有這張卷軸'); return; }
        if (latest.book) { sendPolyBook(scroll, form, character); return; }
        send({ t: 'useitem', id: scroll.id, form: form.poly_id });
      } else { settings.poly.kind = latest.book ? 99247 : latest.buy_item; settings.poly.form = form.poly_id; }
      polyRemember(latest, form); saveSettings(); closeItemSheet(); if (panel.name) renderPanel();
    },
  });
  $('#itemsheet').classList.remove('hidden'); return true;
}
function renderPolySetting(body) {
  polyMigrate();
  const picked = PolyMenu.selection(settings.poly, polyMenuData), shana = settings.poly.kind === 99215;
  const row = el('div', 'set-row'), ico = el('span', 'set-ico pick'), mid = el('div', 'set-mid'), lab = el('div', 'set-label');
  ico.appendChild(picked.form ? polyPortrait(picked.form.poly_id, 36) : iconCanvas({ name: '變形卷軸' }, 36));
  ico.onclick = () => openPolyPicker(); row.appendChild(ico);
  lab.appendChild(el('b', '', '自動變身'));
  const description = polyMenuData.bookEnabled && picked.form ? `${picked.form.name} · ${fmt(picked.form.price)} 金幣 · 變了才扣金幣`
    : polyMenuData.bookEnabled && picked.tier && picked.tier.price == null ? '原外型已移除 · 點圖示重新選擇' : picked.tier ? `${picked.form?.name || '原外型已移除'} · ${picked.tier.buy_name} · 沒有時買一張(${fmt(picked.tier.price)} 金幣)`
    : shana ? '夏娜的變形卷軸 · 沒有時買一張(3,600 金幣)' : settings.poly.kind ? '原階級已移除 · 自動變身暫停' : '點圖示選擇變身外型';
  lab.appendChild(el('em', '', description)); mid.appendChild(lab); row.appendChild(mid);
  row.appendChild(toggleButton(settings.poly, 'on', () => {
    if (settings.poly.on && !settings.poly.kind) { settings.poly.on = false; saveSettings(); openPolyPicker(); return; }
    toast(`自動變身：${settings.poly.on ? '開啟' : '關閉'}`); renderPanel();
  }));
  body.appendChild(row);
}
function autoMenuPoly(now) {
  if (!settings.poly.on || now <= auto.nextPoly || st.buffs.has('poly') || st.buffs.has('shana')) return;
  auto.nextPoly = now + 5000;
  if (polyMenuData.bookEnabled) {
    const plan = PolyMenu.bookAuto(settings.poly, polyMenuData, st.inv.values(), st.me?.level ?? 0, adena());
    if (plan.error) {
      const key = 'polymenu:' + plan.error;
      if (!poorWarned.has(key)) { poorWarned.add(key); log(plan.error, 'sys'); }
      return;
    }
    for (const key of poorWarned) if (typeof key === 'string' && key.startsWith('polymenu:')) poorWarned.delete(key);
    send({ t: 'useitem', id: plan.item.id, form: plan.form.poly_id, ...(plan.action === 'book' ? { request: nextPolyRequest() } : {}) });
    return;
  }
  const { tier, form } = PolyMenu.selection(settings.poly, polyMenuData);
  let error = PolyMenu.problem(tier, form, st.me?.level ?? 0);
  const scroll = !error && PolyMenu.scrolls(tier, st.inv.values())[0];
  if (!error && !scroll) {
    if (!st.paidBuy?.has(tier.buy_item)) error = '這一階卷軸目前無法自動購買，自動變身先暫停';
    else if (tier.price <= 0 || adena() < tier.price) error = '金幣不足或卷軸未販售，自動變身先暫停';
  }
  if (error) {
    const key = 'polymenu:' + error;
    if (!poorWarned.has(key)) { poorWarned.add(key); log(error, 'sys'); }
    return;
  }
  for (const key of poorWarned) if (typeof key === 'string' && key.startsWith('polymenu:')) poorWarned.delete(key);
  if (scroll) send({ t: 'useitem', id: scroll.id, form: form.poly_id });
  else send({ t: 'paidarrow', item: tier.buy_item, count: 1 });
}
setTimeout(refreshPolyMenu, 0);
setInterval(refreshPolyMenu, 30000);

// 二段加速:騎士喝勇敢藥水、妖精吃精靈餅乾(伺服器 brave 等級 1 / 3);其他職業沒有
const braveKind = () => ({ 0: DEVIL_KIND, 1: BRAVE_KIND, 2: WAFFLE_KIND }[st.myType] ?? null);
settings.hasteKind ??= 40013;

function sliderRow(icon, title, labelFn, cfg, key, max, onToggle) {
  const row = el('div', 'set-row');
  row.appendChild(el('span', 'set-ico', icon));
  if (String(icon).startsWith('assets/')) { const sp = row.lastChild; sp.textContent = ''; const im = el('img', 'set-img'); im.src = icon; im.alt = ''; sp.appendChild(im); } // 圖片圖示(定點巡邏)
  const mid = el('div', 'set-mid');
  const lab = el('div', 'set-label');
  lab.appendChild(el('b', '', title));
  const val = el('em', '', labelFn(cfg[key]));
  lab.appendChild(val);
  mid.appendChild(lab);
  const range = el('input');
  range.type = 'range';
  range.min = 0; range.max = max; range.value = cfg[key];
  range.oninput = () => { cfg[key] = +range.value; val.textContent = labelFn(cfg[key]); saveSettings(); };
  mid.appendChild(range);
  row.appendChild(mid);
  if (onToggle !== null) row.appendChild(toggleButton(cfg, 'on', onToggle));
  return row;
}
// 設定面板「高寵」分頁:設定存在伺服器(L1HighPet,跟著契約證的綁定),選項只列高寵學會的魔法
// 打開分頁時跟伺服器要一次(highpet op 10),改了就送回去(op 11:補血 %,補血魔法,藍水 %,輔助魔法;…)
let highPetSave = null;
function renderHighPetSettings(body, skills) {
  const cfg = st.highPetCfg;
  if (!cfg || Date.now() - (panel.highPetAskedAt || 0) > 5000) { panel.highPetAskedAt = Date.now(); send({ t: 'highpet', cert: 0, op: 10 }); } // 狀態可能變了:隔一陣子打開就重抓
  if (!cfg) { body.appendChild(el('p', 'hint', '讀取中…')); return; }
  if (cfg.none) {
    body.appendChild(el('p', 'hint', '還沒有綁定高寵。高寵只能是同帳號的法師角色:到潘朵拉買「高寵契約證」,和同帳號的法師組隊、站在一起,在背包使用契約證綁定。'));
    return;
  }
  const STATUS = { active: '啟用中', standby: '待命中', idle: '未啟用' };
  body.appendChild(el('p', 'hint', `高寵:${cfg.pet}(${STATUS[cfg.status] || cfg.status})。設定會立刻套用,換裝置也會保留。`));
  if (cfg.unbind) { // 11/08 解除高寵(伺服器開關 HighPetUnbindEnabled 開著才帶 unbind):按兩下確認;契約證保留
    const ub = el('button', 'clan-btn danger', '解除高寵');
    ub.type = 'button';
    let armed = 0;
    ub.onclick = () => {
      if (Date.now() - armed > 4000) { armed = Date.now(); ub.textContent = `再按一次解除 ${cfg.pet}`; return; }
      armed = 0; st.highPetCfg = null; send({ t: 'highpet', cert: 0, op: 12 }); renderPanel();
    };
    body.appendChild(ub);
    body.appendChild(el('p', 'hint', '解除後契約證保留,剩下的天數內可以再綁定其他法師。'));
  }
  const push = () => {
    clearTimeout(highPetSave);
    highPetSave = setTimeout(() => send({ t: 'highpet', cert: 0, op: 11, arg: `${cfg.healPct},${cfg.healSkill},${cfg.bluePct},${cfg.buffs.join(';')}` }), 400);
  };
  // 補血:主人血量低於幾 % 就補;點圖示選補血魔法(不選 = 自動挑學會的最好的)
  const heal = sliderRow('✨', '幫主人補血', (v) => `血量低於 ${v}% · ${cfg.healSkill ? skills[cfg.healSkill]?.name : '自動選補血魔法'}`, cfg, 'healPct', 100, null);
  const ico = heal.querySelector('.set-ico');
  ico.textContent = '';
  ico.classList.add('pick');
  if (cfg.healSkill && skills[cfg.healSkill]) ico.appendChild(skillIcon(skills[cfg.healSkill].name, 'icon set-skill')); else ico.textContent = '+';
  ico.onclick = () => openSkillChoice('高寵補血:選擇魔法', cfg.heals, (id) => { cfg.healSkill = cfg.healSkill === id ? 0 : id; push(); renderPanel(); }, cfg.healSkill);
  heal.querySelector('input').addEventListener('change', push);
  body.appendChild(heal);
  const blue = sliderRow('🧪', '高寵喝藍水', (v) => `高寵魔力低於 ${v}%(花高寵自己的金幣)`, cfg, 'bluePct', 100, null);
  const bico = blue.querySelector('.set-ico');
  bico.textContent = '';
  bico.appendChild(iconCanvas({ name: '藍色藥水' }, 36));
  blue.querySelector('input').addEventListener('change', push);
  body.appendChild(blue);
  // 輔助魔法:點一下開 / 關;主人身上沒有就補(照這裡的順序)
  body.appendChild(el('p', 'hint', '輔助魔法(點一下開 / 關,高寵會幫你維持):'));
  const grid = el('div', 'buff-grid items');
  for (const id of cfg.buffOptions) {
    const on = cfg.buffs.includes(id);
    const b = el('button', `buff-cell${on ? ' on' : ''}`);
    b.type = 'button';
    b.title = `${skills[id]?.name || id}:${on ? '開' : '關'}`;
    b.appendChild(skillIcon(skills[id]?.name || '', 'icon'));
    b.onclick = () => { cfg.buffs = on ? cfg.buffs.filter((x) => x !== id) : [...cfg.buffs, id]; push(); renderPanel(); };
    grid.appendChild(b);
  }
  if (!cfg.buffOptions.length) grid.appendChild(el('p', 'hint', '高寵還沒學會可以給你的輔助魔法'));
  body.appendChild(grid);
  body.appendChild(el('p', 'hint', '補血魔法再點一次同一個,就改回「自動選補血魔法」。'));
}
function toggleButton(obj, key, after) {
  const b = el('button', `toggle${obj[key] ? ' on' : ''}`, obj[key] ? 'On' : 'Off');
  b.type = 'button';
  b.onclick = () => {
    obj[key] = !obj[key];
    saveSettings();
    b.classList.toggle('on', obj[key]);
    b.textContent = obj[key] ? 'On' : 'Off';
    after?.();
  };
  return b;
}

// 和 index.html 一樣只使用同源 desk 外框;觸控裝置仍由外框自動轉向。
function deskModeHost() {
  try {
    return window.top !== window && !matchMedia('(pointer: coarse)').matches && typeof parent.setDeskMode === 'function' ? parent : null;
  } catch (e) { return null; }
}
addEventListener('resize', () => {
  const row = $('#desk-mode-row');
  if (!row) return;
  const host = deskModeHost();
  row.hidden = !host;
  if (host) row.querySelector('select').value = host.deskMode;
  const resRow = $('#desk-res-row');
  if (resRow) {
    resRow.hidden = !host;
    if (host) {
      const select = resRow.querySelector('select');
      select.value = host.deskRes;
      select.disabled = host.deskMode !== 'land';
    }
  }
});

// ---- 11/02 #44 訊息過濾:玩家可勾選不顯示的系統訊息(S_ServerMessage 編號);存在 settings.msgHide(跟著其他設定存伺服器)----
// 重要訊息不能被過濾:固定編號 + 文字含這些關鍵字的一律照常顯示(死亡、背包已滿、交易、封鎖、驗證碼、金幣不足、無法…)
const MSG_PROTECTED = new Set([263, 82, 110, 189, 337, 276, 79, 210, 698, 143, 403, 81, 357, 1155]);
const MSG_PROTECT_RE = /死亡|交易|封鎖|驗證|OTP|背包|不足|無法|禁止|伺服器|請先|關閉|重複登入/;
const MSG_KNOWN = { 77: '你覺得舒服多了(喝水 / 補血)', 184: '你的動作突然變快(加速)', 211: '解除毒氣(解毒)', 277: '你感到動作突然變慢', 1007: '你感覺到魔力恢復速度加快' };
const msgSeenMap = new Map(); // 編號 -> { text, n }(這次登入看過的系統訊息,「訊息過濾」頁列出出現最多的)
function msgSeen(ev) {
  try {
    if (!ev || !Number.isFinite(ev.id)) return;
    let r = msgSeenMap.get(ev.id);
    if (!r) { if (msgSeenMap.size >= 300) return; r = { text: '', n: 0 }; msgSeenMap.set(ev.id, r); }
    r.n++;
    if (!r.text) r.text = String(MSG_KNOWN[ev.id] || (typeof serverMsg === 'function' ? serverMsg(ev) : '') || '').replace(/^\u005cf\d/, '').slice(0, 40);
  } catch (e) { /* 統計不能影響訊息顯示 */ }
}
function msgHidden(ev) {
  try {
    if (!ev || MSG_PROTECTED.has(ev.id) || !settings.msgHide || settings.msgHide[ev.id] !== true) return false;
    const r = msgSeenMap.get(ev.id);
    return !(r && MSG_PROTECT_RE.test(r.text));
  } catch (e) { return false; }
}
function renderMsgFilter(body) {
  { // 11/02 #43:獲得道具時的祝福 / 詛咒標示開關
    const row = el('div', 'set-row'), mid = el('div', 'set-mid'), lab = el('div', 'set-label');
    lab.appendChild(el('b', '', '獲得道具時顯示祝福 / 詛咒'));
    lab.appendChild(el('em', '', '例:獲得 祝福的對武器施法的卷軸 ×3(金色)、受詛咒的(紫色)'));
    mid.appendChild(lab); row.appendChild(mid);
    row.appendChild(toggleButton(settings, 'itemBlessNotice'));
    body.appendChild(row);
  }
  body.appendChild(el('p', 'hint', '打開(On)的訊息不會顯示在對話框裡;死亡、背包已滿、交易、封鎖、驗證碼這類重要訊息不能被隱藏。下面是這次登入出現最多的系統訊息。'));
  const ids = new Set(Object.keys(MSG_KNOWN).map(Number));
  for (const [id, r] of [...msgSeenMap].sort((a, b) => b[1].n - a[1].n)) {
    if (ids.size >= 14) break;
    if (r.n >= 3 && !MSG_PROTECTED.has(id) && !MSG_PROTECT_RE.test(r.text) && r.text) ids.add(id);
  }
  for (const id of ids) {
    const r = msgSeenMap.get(id);
    const row = el('div', 'set-row');
    const mid = el('div', 'set-mid'), lab = el('div', 'set-label');
    lab.appendChild(el('b', '', MSG_KNOWN[id] || r?.text || `系統訊息 #${id}`));
    lab.appendChild(el('em', '', `編號 ${id}${r ? ` · 這次登入出現 ${r.n} 次` : ''}`));
    mid.appendChild(lab); row.appendChild(mid);
    row.appendChild(toggleButton(settings.msgHide, id));
    body.appendChild(row);
  }
}
function renderSettings(body) {
  // 自動喝水:不用開 AUTO 也會生效(喝水、逃跑、補血、Buff、買箭);自動戰鬥:只有開 AUTO 才生效(用魔法打怪、開怪、巡邏)
  const tabs = [['potion', '自動喝水'], ['combat', '自動戰鬥'], ...(st.highPet ? [['highpet', '高寵']] : []), ['sound', '設定'], ['msgfilter', '訊息過濾'], ['whisper', '密語'], ['query', '查詢']];
  if (!tabs.some(([k]) => k === panel.tab)) panel.tab = 'potion';
  setTabs(tabs);
  if (panel.tab === 'whisper') { renderWhisperSettings(body); return; }
  if (panel.tab === 'msgfilter') { renderMsgFilter(body); return; }
    const skills = st.game.skills || {};
    const skillRow = (title, cfg, key, labelFn, ids, pickTitle, max = 100, selfScroll = false) => {
      const row = sliderRow('✨', title, labelFn, cfg, key, max);
      const ico = row.querySelector('.set-ico');
      ico.textContent = '';
      ico.classList.add('pick');
      if (cfg.id && skills[cfg.id]) ico.appendChild(skillIcon(skills[cfg.id].name, 'icon set-skill'));
      else ico.textContent = '+';
      if (selfScroll && autoScrollEmpty(cfg.id)) {
        ico.style.opacity = '.45';
      }
      ico.onclick = () => openSkillChoice(pickTitle, ids, (id) => { cfg.id = selfScroll && cfg.id === id ? 0 : id; saveSettings(); renderPanel(); }, cfg.id, selfScroll);
      body.appendChild(row);
    };
  if (panel.tab === 'potion') {
    const escapeRow = sliderRow('📜', '瞬間移動', (v) => `血量低於 ${v}%(沒開 AUTO 時才會)`, settings.escape, 'hp', 100);
    const eico = escapeRow.querySelector('.set-ico'); // 圖示用瞬間移動卷軸的道具圖
    eico.textContent = '';
    eico.appendChild(iconCanvas({ name: '瞬間移動卷軸' }, 36));
    body.appendChild(escapeRow);
    const potionRow = sliderRow('🧪', '自動喝水', (v) => `血量低於 ${v}% · ${POTION_KINDS[settings.potion.kind][0]}`, settings.potion, 'hp', 100);
    // 圖示換成目前選的藥水,點一下可以換
    const ico = potionRow.querySelector('.set-ico');
    ico.textContent = '';
    ico.classList.add('pick');
    ico.appendChild(iconCanvas({ name: POTION_KINDS[settings.potion.kind][0] }, 36));
    ico.onclick = () => openPotionPicker();
    body.appendChild(potionRow);
    const healIds = HEAL_SKILLS.filter((id) => skills[id] && autoSkillVisible(id, settings.healSkill.id === id));
    const petHealIds = HEAL_SKILLS.filter((id) => skills[id] && st.skills.has(id));
    skillRow('自動技能補血', settings.healSkill, 'hp',
      (v) => `血量低於 ${v}% · ${skills[settings.healSkill.id]?.name || '點圖示選魔法'}`, healIds, '自動技能補血:選擇魔法', 100, true);
    skillRow('寵物自動補血', settings.petHeal, 'hp',
      (v) => `寵物 / 召喚獸血量低於 ${v}% · ${skills[settings.petHeal.id]?.name || '點圖示選魔法'}`, petHealIds, '寵物自動補血:選擇魔法');
    // 自動洗 MP(妖精):只列學會的心靈轉換 / 魂體轉換;上面的拉桿 = MP 低於多少開始洗,下面 = HP 低於多少就停
    const washIds = MP_WASH_SKILLS.filter((id) => st.skills.has(id) && skills[id]);
    if (washIds.length) {
      settings.mpWash ??= { on: false, id: 0, mp: 50, hp: 70 };
      if (settings.mpWash.id && !washIds.includes(settings.mpWash.id)) settings.mpWash.id = 0;
      skillRow('自動洗 MP', settings.mpWash, 'mp',
        (v) => `魔力低於 ${v}% 時放 · ${skills[settings.mpWash.id]?.name || '點圖示選魔法'}`, washIds, '自動洗 MP:選擇魔法');
      { // 同一格第二條:保留血量(和範圍技能的 MP 門檻同樣做法)
        const mid = body.lastChild.querySelector('.set-mid');
        const c = settings.mpWash;
        const fmtHp = (v) => `扣完血低於 ${v}% 就不洗`;
        const val = el('em', '', fmtHp(c.hp));
        const lab = el('div', 'set-label');
        lab.appendChild(val);
        const range = el('input');
        range.type = 'range';
        range.min = 0; range.max = 100; range.value = c.hp;
        range.oninput = () => { c.hp = +range.value; val.textContent = fmtHp(c.hp); saveSettings(); };
        mid.appendChild(lab);
        mid.appendChild(range);
      }
    }
    // 自動購買銀箭:裝備弓的時候,銀箭少於設定數量就付費買一批
    const arrowRow = sliderRow('🏹', '自動購買箭矢', (v) => `身上的箭少於 ${v} 支時買 ${ARROW_BUY} 支${ARROW_KINDS[arrowKind()][0]}(${fmt(arrowCost())} 金幣)· 點圖示換箭`, settings.arrows, 'below', 500);
    const aico = arrowRow.querySelector('.set-ico');
    aico.textContent = '';
    aico.appendChild(iconCanvas({ name: ARROW_KINDS[arrowKind()][0] }, 36));
    aico.style.cursor = 'pointer'; aico.onclick = () => openArrowPicker(); // 11/07 點圖示選要買的箭
    body.appendChild(arrowRow);
    // 自動變身:點圖示選卷軸(只選,不會開),右邊開關才開始自動用;沒選卷軸時按 On 會先叫出選單
    const pks = polyKinds();
    if (PolyMenu.active(polyMenuData)) renderPolySetting(body);
    else if (Object.keys(pks).length) {
      // 網頁版 11/05 polymenu：端點暫時不可用時保留已選中階，不因顯示舊選單而清掉設定。
      const pendingPoly = settings.poly.form != null && settings.poly.kind && !pks[settings.poly.kind];
      if (!pendingPoly && settings.poly.kind && !pks[settings.poly.kind]) { settings.poly.kind = 0; settings.poly.on = false; }
      const pk = pendingPoly ? 0 : settings.poly.kind;
      const pick = () => openPotionPicker('自動變身:選擇變身卷軸', pks, pk, (id) => { settings.poly.kind = id; delete settings.poly.form; });
      const row = el('div', 'set-row');
      const pico = el('span', 'set-ico pick');
      pico.appendChild(iconCanvas({ name: '變形卷軸' }, 36));
      pico.onclick = pick;
      row.appendChild(pico);
      const mid = el('div', 'set-mid');
      const lab = el('div', 'set-label');
      lab.appendChild(el('b', '', '自動變身'));
      lab.appendChild(el('em', '', pendingPoly ? '選單暫時無法使用，保留原外型選擇' : pk ? `${POLY_KINDS[pk][0]} · 沒有時買一張(${fmt(POLY_KINDS[pk][1])} 金幣)` : '點圖示選擇變身卷軸'));
      mid.appendChild(lab);
      row.appendChild(mid);
      const tb = toggleButton(settings.poly, 'on', () => {
        if (settings.poly.on && (!settings.poly.kind || pendingPoly)) { settings.poly.on = false; saveSettings(); pick(); return; }
        toast(`自動變身:${settings.poly.on ? POLY_KINDS[pk][0] : '關閉'}`);
        renderPanel();
      });
      row.appendChild(tb);
      body.appendChild(row);
    }
    if (st.magicDoll?.enabled) {
      settings.doll ??= { on: false, itemId: 0 };
      const choices = [...st.inv.values()].filter(it => st.magicDoll.itemIds?.includes(dollItemId(it)) && it.count > 0);
      const selected = choices.find(it => dollItemId(it) === settings.doll.itemId);
      const pick = () => {
        if (!choices.length) { toast('背包裡沒有可用的魔法娃娃'); return; }
        openDollPicker(choices);
      };
      const row = el('div', 'set-row'), ico = el('span', 'set-ico pick');
      ico.appendChild(iconCanvas(selected || { name: '魔法娃娃：肥肥', itemId: 41248 }, 36)); ico.onclick = pick; row.appendChild(ico);
      const mid = el('div', 'set-mid'), lab = el('div', 'set-label');
      lab.appendChild(el('b', '', '自動召喚魔法娃娃'));
      lab.appendChild(el('em', '', `${selected ? baseName(selected) : '點圖示選擇背包裡的娃娃'} · ${dollFeeText(selected ? dollItemId(selected) : 0)}；不需 AUTO；安全區只隱藏外觀，能力與時間照常`));
      lab.appendChild(el('em', '', '開啟期間收回會立刻再召喚並扣費'));
      mid.appendChild(lab); row.appendChild(mid);
      row.appendChild(toggleButton(settings.doll, 'on', () => {
        if (settings.doll.on && !selected) { settings.doll.on = false; saveSettings(); pick(); return; }
        syncDollSettings(true);
        renderPanel();
      })); body.appendChild(row);
    }
    const prRow = el('div', 'set-row');
    const prIco = el('span', 'set-ico'); // 10/28 使用者:圖示用復活卷軸
    prIco.appendChild(iconCanvas({ name: '復活卷軸', gfx: 471, itemId: 40089 }, 36));
    prRow.appendChild(prIco);
    const prMid = el('div', 'set-mid');
    const prLab = el('div', 'set-label');
    prLab.appendChild(el('b', '', '自動復活寵物(復活卷軸)'));
    prLab.appendChild(el('em', '', '寵物死亡時自動使用身上的復活卷軸(先用祝福的);不會自動購買'));
    prMid.appendChild(prLab);
    prRow.appendChild(prMid);
    prRow.appendChild(toggleButton(settings, 'petResurrect'));
    body.appendChild(prRow);
    // 上:自動使用的道具;下:自動施放的輔助魔法(學會、有卷軸或已勾選才顯示)。點圖示切換開 / 關
    const grid = (cls) => body.appendChild(el('div', `buff-grid ${cls}`));
    const cell = (g, title, on, draw, onTap, onHold) => {
      const b = el('button', `buff-cell${on ? ' on' : ''}`);
      b.type = 'button';
      b.title = `${title}:${on ? '自動中' : '關閉'}`;
      b.appendChild(draw());
      let hold = null;
      b.onpointerdown = () => { if (onHold) hold = setTimeout(() => { hold = 'done'; onHold(); }, 550); };
      b.onpointerup = b.onpointerleave = () => { if (hold && hold !== 'done') clearTimeout(hold); };
      b.onclick = () => { if (hold === 'done') { hold = null; return; } onTap(); };
      g.appendChild(b);
      return b;
    };
    const items = grid('items');
    body.appendChild(el('p', 'hint', '自動輔助與自動技能補血:先用對應卷軸,沒有且已學會才放魔法;只用背包裡的卷軸。'));
    const potion = (kind) => () => iconCanvas({ name: ALL_POTIONS[kind][0] }, 40);
    const toggle = (key, label) => () => { settings[key] = !settings[key]; saveSettings(); toast(`${label}:${settings[key] ? '自動' : '關閉'}`); renderPanel(); };
    cell(items, HASTE_KINDS[settings.hasteKind][0], settings.haste, potion(settings.hasteKind), toggle('haste', '自動加速'),
      () => openPotionPicker('自動加速:選擇藥水', HASTE_KINDS, settings.hasteKind, (id) => { settings.hasteKind = id; }));
    const bk = braveKind();
    // 按住:看背包有幾瓶、沒有時付費喝要扣多少(只有一種可選)
    const info = (kind) => () => openPotionPicker(ALL_POTIONS[kind][0], { [kind]: ALL_POTIONS[kind] }, kind, () => {});
    if (bk) cell(items, ALL_POTIONS[bk][0], settings.brave, potion(bk), toggle('brave', ALL_POTIONS[bk][0]), info(bk));
    if (st.myType === 2 && st.skills.has(WIND_WALK)) cell(items, '風之疾走', settings.windWalk,
      () => { const c = skillIcon('風之疾走'); c.style.width = c.style.height = '40px'; return c; }, toggle('windWalk', '風之疾走'),
      () => toast('風之疾走優先施放;MP 不足時,只有同時勾選精靈餅乾才會吃餅乾。'));
    cell(items, '藍色藥水', settings.blue, potion(BLUE_KIND), toggle('blue', '藍色藥水'), info(BLUE_KIND));
    if (st.myType === 3) cell(items, '慎重藥水', settings.wis, potion(WIS_KIND), toggle('wis', '慎重藥水'), info(WIS_KIND));
    // 自動解毒:點一下開 / 關,按住選翡翠藥水或安特之樹枝
    if (!cureKinds()[settings.cure.kind]) settings.cure.kind = CURE_JADE; // 選了解毒術但這隻角色沒學會
    const ck = settings.cure.kind;
    cell(items, `自動解毒(${CURE_KINDS[ck][0]})`, settings.cure.on, () => cureIcon(ck, 40),
      () => { settings.cure.on = !settings.cure.on; saveSettings(); toast(`自動解毒:${settings.cure.on ? CURE_KINDS[ck][0] : '關閉'}`); renderPanel(); },
      () => openPotionPicker('自動解毒:選擇藥水或魔法', cureKinds(), ck, (id) => { settings.cure.kind = id; }));
    // 自動魔法屏障:點一下開 / 關,按住選卷軸或技能(技能要學會)
    if (!cmKinds()[settings.cm.kind]) settings.cm.kind = CM_SCROLL;
    const cmk = settings.cm.kind;
    cell(items, `自動魔法屏障(${cmk === CM_SKILL ? '技能' : '卷軸'})`, settings.cm.on, () => cmIcon(cmk, 40),
      () => { settings.cm.on = !settings.cm.on; saveSettings(); toast(`自動魔法屏障:${settings.cm.on ? CM_KINDS[cmk][0] : '關閉'}`); renderPanel(); },
      () => openPotionPicker('自動魔法屏障:選擇卷軸或技能', cmKinds(), cmk, (id) => { settings.cm.kind = id; }));
    if (st.paidBuy?.has(WHET_KIND)) cell(items, '自動磨刀石', settings.whet, potion(WHET_KIND), toggle('whet', '自動磨刀石'), info(WHET_KIND));
    const learned = SUPPORT_SKILLS.filter(([id]) => st.game.skills?.[id] && autoSkillVisible(id, settings.autoSkills?.includes(id)));
    if (learned.length || medAvailable()) { // 11/06:只學會冥想術也要有這一格
      const skills = grid('skills');
      settings.autoSkills ??= [];
      for (const [id] of learned) {
        const sk = st.game.skills[id];
        const empty = autoScrollEmpty(id); // 沒學會、身上也沒卷軸:不框、不給選(勾選紀錄留著,買回卷軸自動恢復)
        const on = settings.autoSkills.includes(id) && !empty;
        const b = cell(skills, sk.name, on, () => {
          const c = el('canvas', 'icon');
          c.width = c.height = 40 * DPR;
          c.style.width = c.style.height = '40px';
          const draw = () => { if (!GDX.drawNamed(c.getContext('2d'), sk.name, 0, 0, c.width)) setTimeout(draw, 500); };
          draw();
          return c;
        }, () => {
          if (empty) return;
          const i = settings.autoSkills.indexOf(id);
          if (i >= 0) settings.autoSkills.splice(i, 1); else settings.autoSkills.push(id);
          saveSettings();
          toast(`${sk.name}:${i >= 0 ? '關閉' : '自動施放'}`);
          renderPanel();
        });
        if (empty) b.style.opacity = '.45';
      }
      if (medAvailable()) { // 11/06 使用者:冥想術放在自動喝水這裡,學會就看得到(不限法師)
        settings.med ??= { on: true };
        const mk = medKey();
        cell(skills, '自動冥想術', settings.med[mk] === true, () => { const c = skillIcon('冥想術'); c.style.width = c.style.height = '40px'; return c; },
          () => { settings.med[mk] = settings.med[mk] !== true; saveSettings(); toast(`冥想術:${settings.med[mk] ? '自動施放' : '關閉'}`); renderPanel(); },
          () => toast('開 AUTO 時沒有冥想效果就自動施放;沒魔法寶石會自動購買(每顆 1,200)'));
      }
      if (canPetHaste()) {
        cell(skills, '寵物 / 召喚獸加速', !!settings.petHaste, () => {
          const w = el('span', 'pet-haste');
          w.style.cssText = 'position:relative;display:inline-block;width:40px;height:40px';
          const c = el('canvas', 'icon');
          c.width = c.height = 40 * DPR;
          c.style.width = c.style.height = '40px';
          const draw = () => { if (!GDX.drawNamed(c.getContext('2d'), '加速術', 0, 0, c.width)) setTimeout(draw, 500); };
          draw();
          w.appendChild(c);
          const tag = el('b', '', '寵');
          tag.style.cssText = 'position:absolute;right:-4px;bottom:-4px;font-size:11px;line-height:14px;padding:0 3px;border-radius:4px;background:#2b6cb0;color:#fff';
          w.appendChild(tag);
          return w;
        }, toggle('petHaste', '寵物 / 召喚獸加速'));
      }
    }
  } else if (panel.tab === 'combat') {
    const atkIds = Object.keys(skills).map(Number).filter((id) => skills[id].hostile && st.skills.has(id));
    skillRow('範圍技能', settings.aoeSkill, 'count',
      (v) => `周圍 3 格內的怪超過 ${v} 隻時用 · ${skills[settings.aoeSkill.id]?.name || '點圖示選魔法'}`, atkIds, '範圍技能:選擇魔法', 10);
    { // 同一格第二條:MP 門檻
      const mid = body.lastChild.querySelector('.set-mid');
      const c = settings.aoeSkill;
      const fmtMp = (v) => (v ? `MP ${v}% 以上才用` : 'MP 不限(夠放就用)');
      const val = el('em', '', fmtMp(c.mp || 0));
      const lab = el('div', 'set-label');
      lab.appendChild(val);
      const range = el('input');
      range.type = 'range';
      range.min = 0; range.max = 100; range.value = c.mp || 0;
      range.oninput = () => { c.mp = +range.value; val.textContent = fmtMp(c.mp); saveSettings(); };
      mid.appendChild(lab);
      mid.appendChild(range);
    }
    skillRow('開怪技能', settings.openSkill, 'mp',
      (v) => `每隻怪第一下,MP ${v}% 以上用 · ${skills[settings.openSkill.id]?.name || '點圖示選魔法'}`, atkIds, '開怪技能:選擇魔法');
    skillRow('自動魔法攻擊', settings.atkSkill, 'mp',
      (v) => `開 AUTO 時,MP ${v}% 以上用 · ${skills[settings.atkSkill.id]?.name || '點圖示選魔法'}`, atkIds, '自動魔法攻擊:選擇魔法');
    // 定點巡邏 / 沒怪瞬移只能擇一:開了一個就把另一個關掉
    const patrolRow = sliderRow('assets/ui182/i_patrol.webp?v=1', '定點巡邏', (v) => (v ? (AUTO_PATROL_WALK_BOUND ? `移動 ${v} 格 · 可打圈外` : `巡邏範圍 ${v} 格`) : '不限範圍'), settings.patrol, 'range', 30, null);
    const tpLabel = (v) => `${v} 秒沒有怪就用瞬間移動卷軸`;
    const tpRow = sliderRow('📜', '沒怪瞬移', tpLabel, settings.idleTp, 'sec', 10, () => {
      if (settings.idleTp.on && settings.patrol.range) { settings.patrol.range = 0; patrolRange.value = 0; patrolRange.oninput(); }
    });
    const patrolRange = patrolRow.querySelector('input');
    const tico = tpRow.querySelector('.set-ico'); // 圖示用瞬間移動卷軸的道具圖(跟「瞬間移動」那列一樣)
    tico.textContent = '';
    tico.appendChild(iconCanvas({ name: '瞬間移動卷軸' }, 36));
    const tpRange = tpRow.querySelector('input');
    tpRange.min = 3;
    const tpToggle = tpRow.querySelector('button.toggle');
    patrolRange.addEventListener('input', () => {
      if (settings.patrol.range && settings.idleTp.on) { settings.idleTp.on = false; tpToggle.classList.remove('on'); tpToggle.textContent = 'Off'; saveSettings(); }
    });
    body.appendChild(patrolRow);
    body.appendChild(tpRow);
    // 瞬移優先用「指定傳送」技能(沒怪瞬移 / 低血逃跑都適用;沒學會或 MP 不夠自動用卷軸)
    const tsRow = el('div', 'set-row');
    tsRow.appendChild(el('span', 'set-ico', '✨'));
    const tsMid = el('div', 'set-mid');
    const tsLab = el('div', 'set-label');
    tsLab.appendChild(el('b', '', '優先用瞬間移動技能'));
    tsLab.appendChild(el('em', '', '學會指定傳送且 MP 夠就用技能,否則用卷軸'));
    tsMid.appendChild(tsLab);
    tsRow.appendChild(tsMid);
    tsRow.appendChild(toggleButton(settings, 'tpSkill'));
    body.appendChild(tsRow);
    body.appendChild(el('p', 'hint', '按右上角 AUTO 開始自動狩獵:自動攻擊附近的怪物。設定巡邏範圍後,只打開啟 AUTO 位置附近的怪,沒怪時會走回原點。沒怪瞬移和定點巡邏只能開一個。'));
  } else if (panel.tab === 'highpet') {
    renderHighPetSettings(body, skills);
  } else if (panel.tab === 'query') {
    // 查詢:另開分頁的公開網頁(使用者 10/17:入口放設定 → 查詢;要先講會跳離遊戲畫面)
    const tip = el('p', 'hint', '點下去會另外開一個網頁,遊戲畫面會暫時跳開。角色不會馬上下線,看完切回遊戲的分頁就能繼續玩。');
    tip.style.margin = '2px 2px 10px';
    body.appendChild(tip);
    for (const [ico, title, desc, url] of [
      ['👹', 'BOSS 重生時間', '看各 BOSS 上次死亡時間和預計重生時間', 'bosses.html'],
      ['💰', '掉落查詢', '查怪物會掉什麼、想要的道具哪隻怪會掉', 'drops.html'], // 使用者 10/18
      ['📜', '改版資訊', '看每一次改版的內容,可以用關鍵字和分類找', 'changelog.html'],
      ['🎁', '推廣禮包申請', '用 Google 帳號登入,上傳圖片領推廣禮包', 'promo.html'],
    ]) {
      const row = el('div', 'set-row query-row');
      const mid = el('div', 'set-mid');
      const lab = el('div', 'set-label');
      lab.append(el('b', '', title), el('em', '', '另開網頁 ›'));
      const d = el('div', '', desc);
      d.style.cssText = 'font-size:12px;opacity:.75;margin-top:4px'; // 不動 style.css,少一個要上的檔
      mid.append(lab, d);
      row.style.cursor = 'pointer';
      row.append(el('div', 'set-ico', ico), mid);
      row.onclick = () => window.open(url, '_blank');
      body.appendChild(row);
    }
  } else {
    const desk = deskModeHost();
    if (desk) {
      const row = el('div', 'set-row');
      row.id = 'desk-mode-row';
      row.appendChild(el('span', 'set-ico', '▣'));
      const mid = el('div', 'set-mid');
      const lab = el('div', 'set-label');
      lab.appendChild(el('b', '', '電腦版畫面'));
      lab.appendChild(el('em', '', '這台電腦共用,切換立即生效'));
      mid.appendChild(lab);
      row.appendChild(mid);
      const select = el('select', 'au-sel');
      select.setAttribute('aria-label', '電腦版畫面');
      for (const [value, label] of [['land', '新版橫式'], ['port', '舊版直式']]) {
        const option = el('option', '', label); option.value = value; select.appendChild(option);
      }
      select.value = desk.deskMode;
      select.onchange = () => { desk.setDeskMode(select.value); select.value = desk.deskMode; };
      row.appendChild(select);
      body.appendChild(row);
      if (typeof desk.setDeskRes === 'function') {
        const resRow = el('div', 'set-row');
        resRow.id = 'desk-res-row';
        const resMid = el('div', 'set-mid');
        const resLab = el('div', 'set-label');
        resLab.append(el('b', '', '畫面解析度'), el('em', '', '僅電腦橫式生效,立即套用'));
        resMid.appendChild(resLab);
        const resSelect = el('select', 'au-sel');
        resSelect.setAttribute('aria-label', '畫面解析度');
        for (const [value, label] of [['800x600', '800×600'], ['1024x768', '1024×768']]) {
          const option = el('option', '', label); option.value = value; resSelect.appendChild(option);
        }
        resSelect.value = desk.deskRes;
        resSelect.disabled = desk.deskMode !== 'land';
        resSelect.onchange = () => { desk.setDeskRes(resSelect.value); resSelect.value = desk.deskRes; };
        resRow.append(el('span', 'set-ico', '▣'), resMid, resSelect);
        body.appendChild(resRow);
      }
    }
    // 音效開關 / 音量(存在這台裝置,不分角色;sound.js)
    const row = sliderRow('🔊', '音效', (v) => `音量 ${v}%`, SFX.settings, 'vol', 100, () => SFX.setOn(SFX.settings.on));
    row.querySelector('input').addEventListener('input', () => SFX.setVolume(SFX.settings.vol));
    body.appendChild(row);
    // 背景音樂(原版 music.def:依地圖 / 村莊範圍換曲)
    const mrow = sliderRow('🎵', '背景音樂', (v) => `音量 ${v}%`, MUSIC.cfg, 'vol', 100, () => MUSIC.setOn(MUSIC.cfg.on));
    mrow.querySelector('input').addEventListener('input', () => MUSIC.setVolume(MUSIC.cfg.vol));
    body.appendChild(mrow);
    // 戰鬥音樂:開(預設)= 戰鬥時切換成戰鬥音樂;關 = 戰鬥中也繼續播背景音樂
    const brow = el('div', 'set-row');
    brow.appendChild(el('span', 'set-ico', '⚔'));
    const bmid = el('div', 'set-mid');
    const blab = el('div', 'set-label');
    blab.appendChild(el('b', '', '戰鬥音樂'));
    blab.appendChild(el('em', '', '戰鬥時切換成戰鬥音樂'));
    bmid.appendChild(blab);
    brow.appendChild(bmid);
    brow.appendChild(toggleButton(MUSIC.cfg, 'battle', () => MUSIC.setBattle(MUSIC.cfg.battle)));
    body.appendChild(brow);
    // 畫面:流暢模式(原本獨立的「畫面」分頁,10/21 使用者要求併進「設定」)
    // 流暢模式(使用者 10/20:部分 Android 看大型怪物會卡;存在這台裝置,不分角色;l1spr.js L1S.setFlow):
    // 開 = 取樣品質降一級、大型外型(飛龍、巴拉卡斯、安塔瑞斯、法利昂等)改用縮小圖、圖集記憶體上限降低。預設關。
    const fobj = { flow: typeof L1S.flow === 'function' ? L1S.flow() : false };
    const frow = el('div', 'set-row');
    frow.appendChild(el('span', 'set-ico', '🐉'));
    const fmid = el('div', 'set-mid');
    const flab = el('div', 'set-label');
    flab.appendChild(el('b', '', '流暢模式'));
    flab.appendChild(el('em', '', '看大型怪物會卡時開:畫質稍降、大型怪物改用縮小圖(切換時大型怪物會重新載入,閃一下)'));
    fmid.appendChild(flab);
    frow.appendChild(fmid);
    frow.appendChild(toggleButton(fobj, 'flow', () => { if (typeof L1S.setFlow === 'function') L1S.setFlow(fobj.flow); toast(`流暢模式:${fobj.flow ? '開' : '關'}`); }));
    body.appendChild(frow);
    // 隱藏他人寵物 / 召喚(使用者 10/23;預設關):開 = 別人的寵物、召喚不畫、不擋你的尋路 / 點選;自己的永遠顯示,玩家照舊
    const hobj = { hide: !!st.hideOthersPets };
    const hrow = el('div', 'set-row');
    hrow.appendChild(el('span', 'set-ico', '🐕'));
    const hmid = el('div', 'set-mid');
    const hlab = el('div', 'set-label');
    hlab.appendChild(el('b', '', '隱藏他人寵物'));
    hlab.appendChild(el('em', '', '村莊人多卡頓或被擋路時開:安全區裡別人的寵物、召喚不畫也不擋路;出了安全區自動顯示(自己的一直顯示,玩家照舊)'));
    hmid.appendChild(hlab);
    hrow.appendChild(hmid);
    hrow.appendChild(toggleButton(hobj, 'hide', () => { setHideOthersPets(hobj.hide); toast(`隱藏他人寵物:${hobj.hide ? '開' : '關'}`); }));
    body.appendChild(hrow);
    // 顯示其他玩家名字(使用者 10/29;預設關):關 = 其他玩家名字點了(8 秒)/ 選為目標才顯示,宣戰盟成員一直顯示;開 = 全部一直顯示
    const nobj = { show: !!st.showPcNames };
    const nrow = el('div', 'set-row');
    nrow.appendChild(el('span', 'set-ico', '🏷'));
    const nmid = el('div', 'set-mid');
    const nlab = el('div', 'set-label');
    nlab.appendChild(el('b', '', '顯示其他玩家名字'));
    nlab.appendChild(el('em', '', '關:其他玩家名字點了或選為目標才顯示(宣戰血盟一直顯示);開:全部一直顯示(人多時可能較卡)'));
    nmid.appendChild(nlab);
    nrow.appendChild(nmid);
    nrow.appendChild(toggleButton(nobj, 'show', () => { st.showPcNames = nobj.show; store.set('showPcNames', st.showPcNames); toast(`顯示其他玩家名字:${nobj.show ? '開' : '關'}`); }));
    body.appendChild(nrow);
    if (WALK_HINT) {
      const wrow = el('div', 'set-row');
      const wmid = el('div', 'set-mid');
      const wlab = el('div', 'set-label');
      wlab.append(el('b', '', '標示不可走的地面'), el('em', '', '地形障礙與未開放區加上暗色提示;每角色儲存,立即生效'));
      wmid.appendChild(wlab);
      wrow.append(el('span', 'set-ico', '▧'), wmid, toggleButton(settings, 'walkHint'));
      body.appendChild(wrow);
    }
    const cobj = { select: !!st.clickSelect };
    const crow = el('div', 'set-row');
    crow.appendChild(el('span', 'set-ico', '◎'));
    const cmid = el('div', 'set-mid');
    const clab = el('div', 'set-label');
    clab.appendChild(el('b', '', '點擊目標:先選取,再點一次才攻擊'));
    clab.appendChild(el('em', '', '這台裝置共用:第一下只選怪 / 敵人,再點同一目標才攻擊;快捷欄攻擊魔法原地施放,太遠或有障礙會提示。AUTO 不受影響'));
    cmid.appendChild(clab);
    crow.appendChild(cmid);
    crow.appendChild(toggleButton(cobj, 'select', () => { setClickSelect(cobj.select); toast('點擊先選取:' + (cobj.select ? '開' : '關')); }));
    body.appendChild(crow);
    // 畫質(效能自動調整,app.js PERF):自動 = 卡才降(30fps → 解析度 1.5 → 解析度 1 + 流暢模式)、順了升回;高 = 不降;中 = 固定 30fps;低 = 30fps + 解析度 1 + 流暢模式
    const qrow = el('div', 'set-row');
    qrow.appendChild(el('span', 'set-ico', '🎞'));
    const qmid = el('div', 'set-mid');
    const qlab = el('div', 'set-label');
    qlab.appendChild(el('b', '', '畫質'));
    qlab.appendChild(el('em', '', '自動:畫面卡了才自動降低(30fps、降解析度),順了再升回;卡的話可鎖「中」或「低」'));
    qmid.appendChild(qlab);
    qrow.appendChild(qmid);
    const qsel = el('select', 'au-sel');
    for (const [v, t] of [['auto', '自動'], ['high', '高'], ['mid', '中'], ['low', '低']]) { const o = el('option', '', t); o.value = v; qsel.appendChild(o); }
    qsel.value = PERF.mode;
    qsel.onchange = () => { perfSetMode(qsel.value); toast(`畫質:${qsel.options[qsel.selectedIndex].text}`); };
    qrow.appendChild(qsel);
    body.appendChild(qrow);
    const drow = el('div', 'set-row');
    drow.appendChild(el('span', 'set-ico', '📈'));
    const dmid = el('div', 'set-mid');
    const dlab = el('div', 'set-label');
    dlab.appendChild(el('b', '', '效能診斷'));
    dlab.appendChild(el('em', '', `繪圖後端 ${worldBackendStats().name}${worldBackendStats().reason ? ' / ' + worldBackendStats().reason : ''}`));
    dlab.appendChild(el('em', '', '畫面卡的時候按一下,把結果複製給管理員(幀時間、畫質等級、螢幕、顯示卡)'));
    dmid.appendChild(dlab);
    drow.appendChild(dmid);
    const dbtn = el('button', 'learn', '診斷');
    dbtn.type = 'button';
    dbtn.onclick = () => {
      const text = perfDiagText();
      showDialog('效能診斷', '最近幾秒的畫面資料;按「複製」貼給管理員。');
      const dbody = $('#dlg-body');
      const ta = el('textarea');
      ta.readOnly = true; ta.value = text; ta.style.cssText = 'width:100%;height:150px;box-sizing:border-box;font-size:12px';
      const cp = el('button', 'learn', '複製'); cp.type = 'button';
      cp.onclick = async () => { try { await navigator.clipboard.writeText(text); toast('已複製'); } catch (e) { ta.select(); document.execCommand?.('copy'); toast('已選取,請手動複製'); } };
      dbody.append(ta, cp);
    };
    drow.appendChild(dbtn);
    body.appendChild(drow);
  }
}

// ---------------- 裝備素質(export-data.js itemStats)----------------
const W_TYPE = { sword: '單手劍', dagger: '匕首', tohandsword: '雙手劍', bow: '弓', spear: '矛', blunt: '單手鈍器', staff: '魔杖', tohandblunt: '雙手鈍器',
  tohandstaff: '雙手魔杖', claw: '鋼爪', edoryu: '雙刀', gauntlet: '鐵手甲', singlebow: '弓', singlespear: '單手矛', throwingknife: '飛刀', kiringku: '奇古獸', chainsword: '鎖鏈劍' };
const A_TYPE = { helm: '頭盔', armor: '盔甲', T: '內衣', cloak: '斗篷', glove: '手套', boots: '靴子', shield: '盾牌', amulet: '項鍊', ring: '戒指',
  belt: '腰帶', earring: '耳環', guarder: '臂甲' };
const MAT = { iron: '鐵', silver: '銀', mithril: '米索莉', wood: '木', leather: '皮', cloth: '布', bone: '骨', oriharukon: '奧里哈魯根', gold: '金',
  platinum: '白金', glass: '玻璃', mineral: '礦石', dragonscale: '龍鱗', vegetation: '植物', animalmatter: '動物', paper: '紙', copper: '銅', blackmithril: '黑色米索莉', liquid: '液體', wax: '蠟', gemstone: '寶石' };
const ACCESSORY = new Set(['amulet', 'ring', 'belt', 'earring']);
const sgn = (v) => (v > 0 ? `+${v}` : `${v}`);
function itemStatsBlock(it) {
  const s = byName(st.game.itemStats, it);
  if (!s) return null;
  const enchant = +(it.name.match(/^([+-]\d+)\s/)?.[1] || 0);
  const box = el('div', 'is-stats');
  const row = (label, value, cls = '') => { const r = el('div', `row ${cls}`); r.append(el('span', '', label), el('b', '', value)); box.appendChild(r); };
  if (s.k === 'arrow') {
    row('種類', s.type === 'sting' ? '飛刀(鐵手甲用)' : '箭(弓用)');
    row('傷害(小/大)', `${s.dmg[0]} / ${s.dmg[1]}`);
  } else if (s.k === 'w') {
    row('種類', `${W_TYPE[s.type] || s.type}${s.range > 1 ? `(射程 ${s.range})` : ''}`);
    row('傷害(小/大)', `${s.dmg[0]} / ${s.dmg[1]}`);
    if (s.hit) row('命中', sgn(s.hit));
    if (s.dmgMod) row('額外傷害', sgn(s.dmgMod));
    if (s.mdmg) row('魔法傷害', sgn(s.mdmg));
    if (enchant) row(`強化 ${sgn(enchant)}`, `傷害 ${sgn(enchant)}、命中 ${sgn(Math.trunc(enchant / 2))}`, 'up');
    if (it.wdmg > 0) row(`損傷度 ${it.wdmg}`, `傷害 -${it.wdmg}(用磨刀石修復)`, 'down');
  } else {
    row('種類', A_TYPE[s.type] || s.type);
    if (s.ac) row('防禦', `AC ${s.ac}`);
    if (enchant && !ACCESSORY.has(s.type)) row(`強化 ${sgn(enchant)}`, `AC ${-enchant}`, 'up');
    if (s.hit) row('近戰命中', sgn(s.hit));
    if (s.dmgMod) row('近戰傷害', sgn(s.dmgMod));
    if (s.bowHit) row('遠程命中', sgn(s.bowHit));
    if (s.bowDmg) row('遠程傷害', sgn(s.bowDmg));
    if (s.dr) row('傷害減免', s.dr);
    const el4 = Object.entries(s.elem || {}).map(([k, v]) => `${k} ${sgn(v)}`).join('、');
    if (el4) row('屬性抗性', el4);
  }
  const adds = Object.entries(s.add || {}).map(([k, v]) => `${k} ${sgn(v)}`).join('、');
  if (adds) row('附加', adds);
  if (s.haste) row('特殊', '加速效果');
  if (s.safe != null) row('安定值', s.safe);
  row('材質 / 重量', `${MAT[s.mat] || s.mat} / ${s.w}`);
  if (s.cls) row('可用職業', s.cls.length >= 5 ? '全職業' : s.cls.join('、') || '-');
  if (s.lv) row('等級限制', `${s.lv} 級以上`);
  return box;
}

// ---------------- 道具選單 / 快捷欄 ----------------
// 快捷欄能放藥水類(治癒 / 勇敢 / 藍色 / 慎重 / 綠色藥水…、精靈餅乾)、瞬間移動卷軸和裝備(武器 / 防具),其他道具不出現「放到快捷欄」
const isHotbarItem = (it) => !!polyHotbarEntry(it) || !!blankScrollKey(it) || /藥水|精靈餅乾|瞬間移動卷軸|復活卷軸|^戰鬥強化卷軸$|(^|\s)安特之樹枝$|^烏木魔杖$/.test(typeof it === 'string' ? it : baseName(it)) || (typeof it === 'string' ? CM_HOTBAR_RE.test(it) : isCmScroll(it)); // 魔法屏障卷軸(使用者 10/24,完整名稱比對,別種魔法卷軸不算);安特之樹枝(使用者 10/20,解毒;名稱完全相符,不含黑暗安特的樹枝 / 污濁安特的樹枝)、復活卷軸(使用者 10/20):快捷欄按下 = 跟背包使用一樣,開選目標視窗(死掉的寵物 / 附近死亡的玩家)
// 裝備用道具 id 記(同名的 +0 / +7 長劍要分得出來):{ gear: id, name: 顯示用名稱(含強化值、不含「(揮舞)」和疊在一起的「(數量)」) }
// 掉落的普通裝會疊在同一格(長劍 (2)),穿上時伺服器拆出一把新 id 的 → 找不到 id 時用名稱對(slotItem)
const gearLabel = (it) => itemLabel(it).replace(/\s*\((揮舞|穿戴|\d+)\)/g, '');
const gearEntry = (it) => ({ gear: it.id, name: gearLabel(it) });
// 10/28 使用者:實用商人賣的道具要有說明(背包點開也看得到);鍵 = 括號前的名稱(baseName)
function openDollPicker(choices) {
  const body = $('#is-body'); body.innerHTML = ''; $('#is-title').textContent = '自動召喚魔法娃娃：選擇背包道具';
  for (const it of choices) {
    const b = el('button', `potion-pick${dollItemId(it) === settings.doll.itemId ? ' on' : ''}`); b.type = 'button';
    b.appendChild(iconCanvas(it, 36)); b.appendChild(el('span', 'nm', baseName(it)));
    b.appendChild(el('small', '', `背包 ${fmt(it.count)} 個 · ${dollFeeText(dollItemId(it))}`));
    b.onclick = () => { settings.doll.itemId = dollItemId(it); saveSettings(); syncDollSettings(true); closeItemSheet(); renderPanel(); };
    body.appendChild(b);
  }
  $('#itemsheet').classList.remove('hidden');
}
// 背包封包沒有道具編號(只有名稱):用名稱對回編號(11/16 使用者:自動召喚顯示「背包沒有娃娃」)
const DOLL_NAME_IDS = { '魔法娃娃：肥肥': 41248, '魔法娃娃：小思克巴': 41249, '魔法娃娃：野狼寶寶': 41250, '魔法娃娃：希爾黛斯': 47105, '魔法娃娃：蛇女': 47106, '魔法娃娃：雪怪': 47107, '魔法娃娃：亞力安': 47108, '魔法娃娃：史巴托': 47109, '魔法娃娃：長老': 49037, '魔法娃娃：奎斯坦修': 49038, '魔法娃娃：石頭高崙': 49039, '魔法娃娃：稻草人': 47115, '魔法娃娃：雪人': 47116, '魔法娃娃：美人魚': 47117, '魔法娃娃：獨眼巨人': 47118, '魔法娃娃：飛龍': 47119, '魔法娃娃：肥肥王': 47120, '魔法娃娃：巨人': 47121, '魔法娃娃：黑長者': 47122, '魔法娃娃：魅魔女王': 47123, '魔法娃娃：鑽石高崙': 47124 };
function dollItemId(it) { return it?.itemId || (typeof it?.name === 'string' ? DOLL_NAME_IDS[baseName(it).replace(/:/g, '：').replace(/\s+/g, '')] : 0) || 0; }
const DOLL_EFFECTS = {
  41248: '體力回復量 +3。', 41249: '每 64 秒回復 MP 15。', 41250: '近距離、遠距離傷害 +1。',
  47105: '每 64 秒回復 HP 40。', 47106: '攻擊有 4% 機率使目標中毒（每 3 秒 HP −5）。',
  47107: '防禦 AC +1。', 47108: '遠距離傷害 +1、遠距離命中 +1。', 47109: '近距離傷害 +2、昏迷耐性 +10。',
  49037: '每 64 秒回復 MP 6、SP +1。', 49038: '近距離、遠距離命中 +1。', 49039: '最大 HP +50。', 47115: '最大 MP +30。',
  47116: '近距離傷害 +1、近距離命中 +1。',
  47117: '防禦 AC +2、最大 HP +30。',
  47118: '傷害減免 +1。',
  47119: '遠距離傷害 +2、遠距離命中 +2。',
  47120: '近距離傷害 +2、近距離命中 +2。',
  47121: '防禦 AC +3、最大 HP +50、最大 MP +20。',
  47122: '每 64 秒回復 MP 15，攻擊時有 5% 機率發動召喚雷電。',
  47123: '每 64 秒回復 MP 15、SP +1。',
  47124: '傷害減免 +2。',
};
// 使用者 11/17「自動召喚魔法娃娃那邊敘述錯了 是按階級收費 目前是寫死10000」:沒選娃娃(或不在階級名單)時改成列出一階 / 二階 / 三階的價格
const dollTierFees = () => { const md = st.magicDoll || {}, f = [md.tier1Cost, md.tier2Cost, md.tier3Cost]; if (f.every(Number.isFinite)) return f;
  const v = [...new Set(Object.values(md.costById || {}))].filter(Number.isFinite).sort((x, y) => x - y); return v.length === 3 ? v : null; };
const dollFeeText = (id) => { const md = st.magicDoll || {}, c = md.costById?.[id], t = dollTierFees();
  if (c == null && t) return `召喚 ${md.minutes ?? 30} 分鐘，依階級收費：一階 ${fmt(t[0])}／二階 ${fmt(t[1])}／三階 ${fmt(t[2])} 金幣`;
  return `召喚 ${md.minutes ?? 30} 分鐘，花費 ${fmt(c ?? md.goldCost ?? 10000)} 金幣`; };
const dollDescription = it => st.magicDoll?.enabled && DOLL_EFFECTS[dollItemId(it)] ? `${dollSynthTierText(dollItemId(it))}${DOLL_EFFECTS[dollItemId(it)]} ${dollFeeText(dollItemId(it))}。` : '';
const ITEM_DESC = {
  獵場通行證: '刻印道具:不能交易、給予或賣出。說話之島的獵場總管傳送到個人獵場要有通行證;限時通行證取得後開始計時,到期自動消失。',
  改名卡: '刻印道具:不能交易、給予或賣出。使用後輸入新名稱(最多 12 字)改名,改名後會登出;3 天內不能再改,舊名稱保留 24 小時。',
  回憶蠟燭: '重新分配能力值:初始能力、萬能藥點數、50 級以後的升級加點都可以重新分配(每項最高 35)。確定後消耗 1 個。',
  高寵契約證: '刻印道具:不能交易、給予或賣出。取得後開始計時 7 天,到期自動消失。和同帳號的法師組隊、站在一起使用 → 綁定成高寵,會跟著你補血、上輔助魔法。',
  贖罪聖書: '使用後正義值 +3000(最高 32767),每次消耗 1 本;正義值已滿時不會消耗。不能交易。',
  贖罪卷軸: '使用後 PK 次數 −1、正義值 +500(最高 32767),每次消耗 1 張;PK 次數為 0 時不會消耗。不能交易。',
  地監記憶書: '刻印道具:不能交易、給予或賣出。永久使用、不會消耗:點開選地監樓層直接傳送,每次先扣 1 張地監免費傳送券,沒有就扣 10 萬金幣。',
};
const itemDescKey = (it) => (typeof it?.name === 'string' ? baseName(it).replace(/\s*\[.*$/, '') : ''); // 限時道具背包名稱後面有「[剩 N 天]」
const itemHasDesc = (it) => !!dollDescription(it) || !!ITEM_DESC[itemDescKey(it)] || [typeof isTishaGuard, typeof isNoDeathExp, typeof isBattleScroll].some((t, i) => t === 'function' && [() => isTishaGuard(it), () => isNoDeathExp(it), () => isBattleScroll(it)][i]());
function appendItemDescription(body, it, owned = true) {
  const nm = it.count > 1 ? itemLabel(it).replace(/\s*\(\d+\)$/, '') : itemLabel(it); // 堆疊道具的名稱本身帶「(數量)」,只顯示一次「× 數量」;單個道具的「(n)」是剩餘次數,保留
  const head = el('div', 'is-head');
  head.appendChild(iconCanvas(it, 44));
  head.appendChild(el('span', '', it.count > 1 ? `${nm} × ${it.count}` : nm));
  if (owned && isLocked(it)) head.appendChild(el('b', 'sealed-tag', '已上鎖'));
  if (it.bless >= 128) head.appendChild(el('b', 'sealed-tag', '刻印')); // 不能交易 / 給予 / 賣,可以使用、丟棄(10/19 起;cant_delete 的道具伺服器照樣擋)
  body.appendChild(head);
  if (it.bless >= 128 && !isNoDeathExp(it) && !isTishaGuard(it) && !ITEM_DESC[itemDescKey(it)]) body.appendChild(el('p', 'hint', '刻印道具:不能交易、給予或賣出;可以正常使用,也可以丟棄(部分道具除外)。'));
  if (/^永久 /.test(baseName(it))) body.appendChild(el('p', 'hint', '永久道具:使用後不會消耗,可以一直使用;自動喝水 / 離線掛機會優先使用。'));
  if (baseName(it) === '經驗獵場卷軸') body.appendChild(el('p', 'hint', '進入經驗獵場或在裡面滿 1 小時要付費時,自動使用 1 張(每張 1 小時),沒有才扣金幣。')); // 11/07 經驗獵場卷軸(伺服器 L1EventHunt)
  if (/^(經驗加倍護符|永久經驗項鍊)/.test(baseName(it))) body.appendChild(el('p', 'hint', `放在背包裡就有效:打怪經驗 +${/7\s*(日|天)/.test(it.name) ? 100 : 0}%(帶多個只算一次,不用使用)。`)); // 11/07 經驗加倍護符(伺服器 L1ExpCharm)
  if (/^7日 /.test(baseName(it))) body.appendChild(el('p', 'hint', '7 日道具:取得後 7 天內使用不會消耗,到期自動消失;自動喝水 / 離線掛機會優先使用。'));
  if (/^(地監)?免費傳送券/.test(baseName(it))) body.appendChild(el('p', 'hint', '需搭配地監記憶書使用,每次傳送扣 1 張(沒有券扣 10 萬金幣)。')); // 99241(10/24 維修後叫「地監免費傳送券」)
  if (dollDescription(it)) body.appendChild(el('p', 'hint', dollDescription(it)));
  if (ITEM_DESC[itemDescKey(it)]) body.appendChild(el('p', 'hint', ITEM_DESC[itemDescKey(it)]));
  if (isTishaGuard(it)) body.appendChild(el('p', 'hint', TISHA_GUARD_DESCRIPTION));
  if (isNoDeathExp(it)) body.appendChild(el('p', 'hint', NODEATH_DESCRIPTION));
  if (isBattleScroll(it)) body.appendChild(el('p', 'hint', BATTLE_SCROLL_DESCRIPTION));
  const stats = itemStatsBlock(it);
  if (stats) body.appendChild(stats);
  return nm;
}
function openItemSheet(it, title) {
  const body = $('#is-body');
  body.innerHTML = '';
  const nm = appendItemDescription(body, it);
  $('#is-title').textContent = title || nm;
  const actions = el('div', 'is-actions');
  const btn = (text, fn, cls) => { const b = el('button', cls || '', text); b.type = 'button'; b.onclick = fn; actions.appendChild(b); };
  btn(isGear(it) ? (isEquipped(it) ? '解除裝備' : '裝備') : '使用', () => { if (useItem(it) !== true) closeItemSheet(); });
  // 上鎖 / 解鎖(免費):鎖住的道具不能賣、拍賣、丟棄、交易(伺服器也擋);只有 config.json itemLock 開著才有這個按鈕
  if (st.itemLock) btn(isLocked(it) ? '解鎖' : '上鎖', () => { send({ t: 'itemlock', id: it.id, lock: !isLocked(it) }); closeItemSheet(); toast(isLocked(it) ? '已解鎖' : '已上鎖'); });
  // 丟棄:直接從背包刪除(不會掉在地上);按一下後再確認
  btn('丟棄', () => {
    if (isEquipped(it)) { toast('請先解除裝備'); return; }
    if (isLocked(it)) { toast('這個道具已上鎖,請先解鎖'); return; }
    actions.innerHTML = '';
    const del = (count) => { send({ t: 'delitem', id: it.id, count }); closeItemSheet(); toast(`已丟棄 ${nm}${count > 1 ? ` × ${count}` : ''}`); };
    if (it.count > 1) btn('丟棄 1 個', () => del(1), 'danger');
    btn(it.count > 1 ? `全部丟棄(${it.count})` : '確定丟棄', () => del(Math.max(1, it.count)), 'danger');
    btn('取消', () => openItemSheet(it, title));
  }, 'danger');
  body.appendChild(actions);
  mountBoxBatch(body, it); // BEGIN BOXBATCH / END BOXBATCH
  if (!isHotbarItem(it) && !isGear(it)) { $('#itemsheet').classList.remove('hidden'); return; } // 只有藥水 / 卷軸 / 裝備能放快捷欄
  // 快捷:關掉說明,直接點畫面上的快捷欄格子放進去
  const hb = el('div', 'is-hotbar');
  const qb = el('button', 'slot-pick quick', '快捷');
  qb.type = 'button';
  qb.onclick = () => startHotbarPick(polyHotbarEntry(it) || (isGear(it) ? gearEntry(it) : hotbarName(it))); // 網頁版 11/05 polymenu：以道具編號記住階級快捷。
  hb.appendChild(qb);
  body.appendChild(hb);
  $('#itemsheet').classList.remove('hidden');
}

// ---- 選快捷欄格子:格子會亮起來,點哪一格就放哪一格;點其他地方取消 ----
const hotbarPick = { entry: null };
function startHotbarPick(entry) {
  closeItemSheet();
  if (panel.name) closePanel();
  hotbarPick.entry = entry;
  $('#hotbar').classList.add('picking');
  $('#hotbar-pick-hint').classList.remove('hidden');
}
function endHotbarPick() {
  hotbarPick.entry = null;
  $('#hotbar').classList.remove('picking');
  $('#hotbar-pick-hint').classList.add('hidden');
}
// 點快捷欄以外的地方:取消(capture,在其他點擊處理之前)
document.addEventListener('pointerdown', (e) => {
  if (hotbarPick.entry == null) return;
  if (e.target.closest?.('#hotbar .slot[data-slot]')) return;
  endHotbarPick();
  toast('已取消');
}, true);
function openPotionPicker(title = '自動喝水:選擇藥水', kinds = POTION_KINDS, current = settings.potion.kind, onPick = (id) => { settings.potion.kind = id; }) {
  const body = $('#is-body');
  body.innerHTML = '';
  $('#is-title').textContent = title;
  for (const [id, [name, price]] of Object.entries(kinds)) {
    const have = potionInBag(+id)?.count ?? 0;
    const b = el('button', `potion-pick${+id === current ? ' on' : ''}`);
    b.type = 'button';
    if (CURE_KINDS[id]) b.appendChild(cureIcon(+id, 36)); // 自動解毒:解毒術畫魔法圖示
    else if (CM_KINDS[id]) b.appendChild(cmIcon(+id, 36)); // 自動魔法屏障
    else b.appendChild(iconCanvas({ name: POLY_KINDS[id] ? '變形卷軸' : name }, 36)); // 變身卷軸都用變形卷軸的圖示
    b.appendChild(el('span', 'nm', name));
    if (+id === CURE_SKILL) { // 魔法:顯示 MP,不顯示背包數量
      b.appendChild(el('small', '', `MP ${skillMp(CURE_SKILL)} · ${kinds[id][2]}`));
      b.onclick = () => { onPick(+id); saveSettings(); closeItemSheet(); renderPanel(); };
      body.appendChild(b);
      continue;
    }
    const note = kinds[id][2] || (POLY_KINDS[id] ? `沒有時自動購買一張(${fmt(price)} 金幣)` : price ? `沒有時每次扣 ${price} 金幣` : '沒有時自動購買翡翠藥水');
    b.appendChild(el('small', '', `背包 ${have} ${/卷軸/.test(name) ? '張' : price ? '瓶' : '個'} · ${note}`));
    b.onclick = () => { onPick(+id); saveSettings(); closeItemSheet(); renderPanel(); };
    body.appendChild(b);
  }
  $('#itemsheet').classList.remove('hidden');
}
function openArrowPicker() { // 11/07 自動購買箭矢:選銀箭 / 奧里哈魯根箭(樣式同藥水選單)
  const body = $('#is-body'); body.innerHTML = ''; $('#is-title').textContent = '自動購買箭矢:選擇箭';
  for (const [id, [name, price]] of Object.entries(ARROW_KINDS)) {
    let have = 0; for (const it of st.inv.values()) if (baseName(it) === name) have += it.count || 1;
    const b = el('button', `potion-pick${+id === arrowKind() ? ' on' : ''}`); b.type = 'button';
    b.appendChild(iconCanvas({ name }, 36)); b.appendChild(el('span', 'nm', name));
    b.appendChild(el('small', '', `背包 ${fmt(have)} 支 · 每次買 ${ARROW_BUY} 支 ${fmt(Math.ceil(ARROW_BUY * price))} 金幣`));
    b.onclick = () => { settings.arrows.kind = +id; saveSettings(); closeItemSheet(); renderPanel(); };
    body.appendChild(b);
  }
  $('#itemsheet').classList.remove('hidden');
}
function closeItemSheet() { $('#itemsheet').classList.add('hidden'); $('#itemsheet').classList.remove('poly-sheet'); }
$('#is-close').onclick = closeItemSheet;

st.hotbar = [null, null, null, null, null]; // 進入遊戲後 loadCharPrefs() 載入該角色的
const slotSkill = (i) => (st.hotbar[i] && typeof st.hotbar[i] === 'object' ? st.hotbar[i].skill : null);
const slotGear = (i) => (st.hotbar[i] && typeof st.hotbar[i] === 'object' ? st.hotbar[i].gear : null);
const slotLabel = (i) => (typeof st.hotbar[i] === 'string' ? st.hotbar[i] : st.hotbar[i]?.name || '');
function slotItem(i) {
  const name = st.hotbar[i];
  // 網頁版 11/05 polymenu：資料未載入時保留快捷設定；同階新舊卷軸皆可使用。
  if (name?.polyItem) {
    const tier = PolyMenu.tierForKind(polyMenuData, name.polyItem);
    return tier ? PolyMenu.scrolls(tier, st.inv.values())[0] || null : null;
  }
  if (slotGear(i)) { // 裝備:同名同強化值的正穿著 → 就是這一格(疊在一起的穿上會換 id);沒穿 → 原本的 id,再找同名的;都沒有(賣掉 / 交易掉)= null
    let any = null;
    for (const it of st.inv.values()) {
      if (!isGear(it) || gearLabel(it) !== name.name) continue;
      if (isEquipped(it)) return it;
      any ??= it;
    }
    return st.inv.get(slotGear(i)) || any;
  }
  if (!name || typeof name !== 'string') return null;
  let found = null;
  for (const it of st.inv.values()) {
    if (hotbarName(it) !== name) continue;
    if (it.bless >= 128 && isCmScroll(it)) return it; // 魔法屏障卷軸:刻印的優先(同自動魔法屏障)
    found ??= it;
    if (!isCmScroll(it)) return it; // 其他道具照舊:第一個符合的
  }
  return found;
}
function setSlot(i, v) {
  if (st.hotbarLock) { toast('快捷欄已上鎖,先點快捷欄旁的鎖頭解鎖'); return false; }
  st.hotbar[i] = v;
  store.set(charKey('hotbar'), st.hotbar);
  renderHotbar();
}

// 10/28 技能說明(deploy/feature-skilldesc/skill-desc.json;依本伺服器程式與技能表,Codex skilldesc-1028)
const SKILL_DESC = {"1":"立即恢復自己或指定目標的體力，回復量依魔法能力與正義值而定；對不死怪物可造成傷害。","2":"照亮自己周圍，持續 1 小時。","3":"使自己防禦提升（防禦值降低 2），持續 30 分鐘。可與大地防護並存。","4":"對單一目標造成無屬性魔法傷害，基礎 9～18 點；實際傷害依能力與抗性變動。","5":"在同一張地圖隨機傳送;受所在地圖的傳送限制。","6":"對單一目標造成水屬性魔法傷害，基礎 11～20 點；實際傷害依能力與抗性變動。","7":"對單一目標造成風屬性魔法傷害，基礎 11～20 點；實際傷害依能力與抗性變動。","8":"使指定角色物理命中增加 1，近戰攻擊部分不死怪物額外傷害增加 1，持續 20 分鐘。","9":"解除自己或指定目標的中毒狀態。","10":"對 3 格內單一目標造成水屬性魔法傷害，並以傷害量恢復自己的體力。","11":"依魔法能力與目標魔防判定中毒；成功後每 3 秒造成 5 點傷害，最多 30 秒。","12":"使自己物理攻擊的武器傷害補正增加 2，持續 30 分鐘；換武器仍有效。","13":"解除畫面內玩家的隱身，並使附近潛藏於地面的怪物現身。","14":"提高自己的負重上限，持續 30 分鐘。","15":"對單一目標造成火屬性魔法傷害，基礎 12～30 點；實際傷害依能力與抗性變動。","16":"對單一目標造成地屬性魔法傷害，基礎 12～30 點；實際傷害依能力與抗性變動。","17":"對朝向目標的直線上敵人造成風屬性魔法傷害，基礎 4～40 點；實際傷害依能力與抗性變動。","18":"依魔法能力與目標魔防判定，有機率立即消滅可受此術影響的不死怪物。","19":"立即恢復自己或指定目標的體力，回復量依魔法能力與正義值而定；對不死怪物可造成傷害。","20":"依魔法能力與目標魔防判定，使指定玩家視野受限，持續 16 秒。","21":"使自己防禦提升（防禦值降低 3），持續 30 分鐘；不需穿鎧甲。","22":"對目標周圍 3 格敵人造成水屬性魔法傷害，基礎 8～32 點；實際傷害依能力與抗性變動。","23":"對指定怪物顯示其弱點屬性的特效；沒有對應弱點時無效。","25":"對目標周圍 3 格敵人造成火屬性魔法傷害，基礎 5～45 點；實際傷害依能力與抗性變動。","26":"使自己或指定盟友敏捷增加 5，持續 20 分鐘。","27":"依魔法能力與目標魔防判定，損傷指定玩家的武器；對怪物則降低其物理攻擊威力。","28":"對 4 格內單一目標造成水屬性魔法傷害，並以傷害量恢復自己的體力。","29":"依魔法能力與目標魔防判定，降低指定目標的移動速度，最多 64 秒；可抵消加速。","30":"對目標周圍 3 格敵人造成地屬性魔法傷害，基礎 5～40 點；實際傷害依能力與抗性變動。","31":"保護自己，抵擋一次可被屏障攔截的魔法，發動後消失；最長 16 秒。","32":"使自己的魔力自然回復增加 5，持續 20 分鐘；移動、攻擊或施放其他魔法都不會解除。","33":"依魔法能力與目標魔防判定詛咒；成功後等待 8 秒，再使指定目標麻痺 16 秒。","34":"對單一目標造成風屬性魔法傷害，基礎 45～80 點；實際傷害依能力與抗性變動。","35":"立即恢復自己或指定目標的體力，回復量依魔法能力與正義值而定；對不死怪物可造成傷害。","36":"依魔法能力與怪物魔防判定，控制可迷魅的怪物 1 小時；怪物越虛弱越容易成功，數量受魅力限制。","37":"解除自己或指定目標的中毒，以及木乃伊詛咒的麻痺與麻痺前兆。","38":"對單一目標造成水屬性魔法傷害，基礎 45～70 點；實際傷害依能力與抗性變動。","39":"依魔法能力與目標魔防判定，從指定目標奪取魔力並補充自己；奪取量依智力與對方剩餘魔力變動。","40":"依魔法能力與目標魔防判定，使指定玩家視野受限，持續 32 秒。","41":"將怪物屍體變為受自己控制的召喚物，持續 1 小時；種類依施法者等級，數量受魅力限制。","42":"使自己或指定盟友力量增加 5，持續 20 分鐘。","43":"加快自己或指定目標的移動與動作速度，最多 20 分鐘；若目標已緩速，則先抵消緩速。","44":"依魔法能力與目標魔防判定，解除指定目標多數魔法、變身與異常狀態；部分特殊狀態不受影響。","45":"對單一目標造成地屬性魔法傷害，基礎 55～65 點；實際傷害依能力與抗性變動。","46":"對 3 格內單一目標造成火屬性魔法傷害，基礎 56～120 點；實際傷害依能力與抗性變動。","47":"依魔法能力與目標魔防判定，使指定目標近戰傷害降低 5、命中降低 1，持續 64 秒。","48":"使指定角色物理命中與武器傷害補正各增加 2，持續 20 分鐘；換武器仍有效。","49":"恢復畫面內盟友及自己寵物、召喚獸的體力，不含自己；回復量依魔法能力與正義值而定。","50":"對單一目標造成水屬性魔法傷害，並依魔法能力、魔防與抗性判定冰凍，成功凍結 16 秒。","51":"在身旁召喚協助戰鬥的怪物，最多 1 小時；種類與數量依等級、魅力及召喚戒指而定。","52":"額外提高自己的移動速度，持續 32 秒；會取代勇敢、精靈餅乾等同類加速。","53":"對自己周圍 4 格敵人造成風屬性魔法傷害，基礎 25～70 點；實際傷害依能力與抗性變動。","54":"加快自己的移動與動作速度，最多 40 分鐘；若已緩速，則先抵消緩速。","55":"使自己、盟友或隊友近戰傷害增加 5、命中增加 2，防禦值增加 10，持續 320 秒；會停止體力自然回復。","56":"依魔法能力與目標魔防判定，使指定目標近戰傷害降低 6、防禦值增加 12，持續 64 秒。","57":"立即恢復自己或指定目標的體力，回復量依魔法能力與正義值而定；對不死怪物可造成傷害。","58":"朝指定地點鋪設最多 8 格火牆，持續 10 秒；每秒灼傷火牆上的目標，威力受火抗與魔防影響。","59":"對自己周圍 10 格敵人造成水屬性魔法傷害，基礎 6～33 點；實際傷害依能力與抗性變動。","60":"使自己隱身，直到解除或採取會破除隱身的行動；仍可能被偵測。","61":"復活指定的死亡玩家、寵物或可復活怪物；玩家須同意，且所在地圖須允許復活。","62":"對自己周圍 3 格敵人造成地屬性魔法傷害，基礎 46～100 點；實際傷害依能力與抗性變動。","63":"在指定地點建立治癒區域 320 秒；周圍 3 格玩家的每次自然體力回復增加 3。","64":"依魔法能力與目標魔防判定，使指定目標無法施法，持續 16 秒。","65":"對目標周圍 3 格敵人造成風屬性魔法傷害，基礎 30～75 點；實際傷害依能力與抗性變動。","66":"依魔法能力、魔防與睡眠抗性判定，使目標周圍 3 格敵人沉睡最多 32 秒；受傷會醒來。","67":"讓自己或指定玩家選擇變身外型，持續 2 小時；可選種類與裝備限制依變身規則。","68":"使自己、指定盟友或隊友受到的多數物理及魔法傷害減半，持續 32 秒。","69":"將自己及身旁 3 格內盟友傳送至記憶座標；未選記憶點則隨機傳送，受地圖限制。","70":"對自己周圍 3 格敵人造成火屬性魔法傷害，基礎 38～150 點；實際傷害依能力與抗性變動。","71":"依魔法能力與目標魔防判定，封鎖指定目標使用藥水，持續 16 秒。","72":"解除畫面內隱身，並對可受攻擊的目標造成魔法傷害；也能使潛藏於地面的怪物現身。","73":"將背包中可強化且安定值大於 0 的未強化武器，永久提升為強化等級 +1。","74":"對目標周圍 3 格敵人造成火屬性魔法傷害，基礎 58～170 點；實際傷害依能力與抗性變動。","75":"復活指定死亡玩家並恢復全部體力；符合條件時可恢復部分死亡經驗。玩家須同意復活。","76":"依魔法能力與目標魔防判定，使目標周圍 3 格敵人緩速最多 64 秒；不影響自己與自己的隨從。","77":"對單一目標造成無屬性魔法傷害，基礎 108～220 點；實際傷害依能力與抗性變動。正義值須達 500。","78":"保護自己免受多數直接攻擊傷害，最長 12 秒；期間停止自然回復，部分行動會解除。","79":"提高自己或指定玩家的體力與魔力上限，各增加其基本上限的 20%，持續 30 分鐘。","80":"對自己周圍 10 格敵人造成水屬性魔法傷害，並依魔防、能力與抗性判定冰凍；成功凍結 32 秒。","87":"攻擊近身目標，依等級差與昏迷抗性判定暈眩 1～4 秒；對已暈玩家會累加剩餘時間。需裝備雙手劍。","88":"使自己每次受到的多數物理與魔法傷害減少，持續 20 分鐘；至少減少 1，減傷隨等級提高。","89":"使自己近距離命中 +5，持續 20 分鐘。","90":"使自己的遠距離迴避增加 15，持續 64 秒。卸下盾牌會解除。","91":"保護自己 64 秒；依雙方等級判定機率抵擋近戰攻擊，持雙手劍時可反擊，威力依武器而定。","97":"使自己隱身最多 32 秒；採取會破除隱身的行動或遭偵測時解除。","98":"使自己持武器攻擊時有 10% 機率使目標中毒，持續 320 秒；毒每 3 秒傷害 5，最多 30 秒。","99":"使自己防禦提升（防禦值降低 3），持續 16 分鐘；會取代部分同類防禦魔法。","100":"對指定魔石進行升階提煉，成功機率依自己的等級與精神，以及魔石階級而定。","101":"額外提高自己的移動速度，持續 16 分鐘；會取代勇敢、精靈餅乾等同類加速。","102":"強化自己 320 秒；近戰攻擊有 33% 機率使部分傷害提高至 1.5 倍，不含部分增傷魔法加成。","103":"使指定目標陷入黑暗,一段時間內無法行動(原版說明)。","104":"使自己免受新的毒素感染，持續 320 秒。","105":"強化自己 192 秒；使用雙刀或黑暗妖精鋼爪攻擊時，有 33% 機率使武器傷害加倍。","106":"提高自己的物理閃避能力，持續 192 秒；與鏡像互相取代。","107":"使自己物理攻擊的武器傷害補正增加 5，持續 192 秒；換武器仍有效。","108":"對近身單一目標造成魔法傷害，威力依施法前剩餘魔力及目標魔防而定。","109":"使自己力量增加 2，持續 16 分鐘；與體魄強健術互相取代。","110":"使自己敏捷增加 2，持續 16 分鐘；與通暢氣脈術互相取代。","111":"使自己的遠距離迴避增加 12，持續 32 秒。","113":"標示指定目標或地點，供自己與線上盟友辨識，標記持續 5 秒。","114":"使自己與畫面內隊友的近戰、遠距命中各增加 5，魔防增加 20，持續 640 秒。","115":"使自己與畫面內盟友、隊友防禦提升（防禦值降低 8），持續 640 秒；會取代激勵士氣。","116":"呼喚指定線上盟友，對方同意後傳送到自己身旁；受雙方所在地圖與傳送規則限制。","117":"使自己與畫面內隊友的近距離、遠距離傷害各增加 3，近距離、遠距離命中各增加 3，持續 640 秒。","118":"將自己傳送到指定線上盟友身旁；對方須在允許的大陸地圖且不在攻城區域。","119":"640 秒內,自己的近距離物理攻擊有 40% 機率造成 1.3 倍傷害。","120":"被動:同血盟 16 格內有學會此技能的王族時(含自己),力量、敏捷、智力各 +1,減傷 +1,魔防 +10;多位王族不疊加。","129":"使自己的魔防增加 10，持續 20 分鐘。","130":"立即恢復自己的魔力 2 點。","131":"將自己傳送至世界樹附近；所在地圖必須允許離開。","132":"使用可施展此術的弓箭外型，對指定目標連續進行 3 次攻擊；各次傷害與命中依一般攻擊判定。","133":"依等級差判定，使指定目標對施法者所屬屬性的抗性降低 50，持續 32 秒。","134":"保護自己最多 16 秒；遭魔法攻擊時依精神判定機率反射傷害，反射成功後消失，部分怪物例外。","137":"使自己精神增加 3，持續 20 分鐘。","138":"使自己地、水、火、風四種屬性抗性各增加 10，持續 20 分鐘。","145":"嘗試將指定召喚獸遣返；成功與否受等級差及伺服器規則限制。","146":"立即恢復自己的魔力 15 點。","147":"使自己所屬屬性的抗性增加 50，持續 64 秒；未選屬性時無效。","148":"使自己或指定玩家近戰傷害增加 4，持續 16 分鐘；會取代同類屬性武器增益。","149":"使自己或指定玩家遠距離命中增加 6，持續 16 分鐘；會取代同類屬性武器增益。","150":"額外提高自己的移動速度，持續 16 分鐘；會取代勇敢、精靈餅乾等同類加速。","151":"使自己或指定玩家防禦提升（防禦值降低 6），持續 16 分鐘；可與保護罩並存。","152":"依等級差判定，使指定目標移動緩慢，最多 64 秒；遇到加速狀態會先互相抵消。","153":"依等級差判定，使指定目標魔防降為原本四分之一，最多 32 秒；再受攻擊或機率魔法時解除。","154":"在身旁召喚一隻與自己屬性相同的精靈，最多 1 小時；已有寵物或召喚獸時不能召喚。","155":"使自己與畫面內隊友近戰傷害增加 4，持續 16 分鐘；會取代同類屬性武器增益。","156":"使自己與畫面內隊友遠距離命中增加 2、傷害增加 3，持續 16 分鐘；會取代同類屬性武器增益。","157":"依等級差與束縛抗性判定，使指定目標無法行動且免受多數直接傷害，持續 16 秒。","158":"使自己或指定玩家每次自然體力回復增加 15，持續 320 秒。","159":"使自己與畫面內隊友防禦提升（防禦值降低 7），持續 16 分鐘；可與保護罩並存。","160":"使自己或指定玩家迴避率提升,持續 16 分鐘(原版說明)。","161":"依等級差判定，使畫面內符合敵對條件的目標無法施法，持續 16 秒；不影響自己。","162":"在身旁召喚一隻與自己屬性相同的強力精靈，最多 1 小時；已有寵物或召喚獸時不能召喚。","163":"使自己近戰傷害增加 6、命中增加 3，持續 16 分鐘；會取代同類屬性武器增益。","164":"立即恢復自己與畫面內隊友的體力，回復量依魔法能力與正義值而定。","165":"復活指定的死亡玩家、寵物或可復活怪物；玩家須同意復活。","166":"使自己遠距離傷害增加 5、命中降低 1，持續 16 分鐘；會取代同類屬性武器增益。","167":"依等級差判定，降低指定目標的攻擊速度，持續 16 秒。","168":"使自己防禦提升（防禦值降低 10），持續 16 分鐘；會取代保護罩與同類大地防禦增益。","169":"使自己在負重過半時仍可自然恢復體力與魔力，持續 16 分鐘；其他回復限制仍適用。","170":"使自己或指定玩家下一次接受的治癒魔法回復量加倍；使用後消失，最長 64 秒。","171":"強化自己 192 秒；近戰攻擊有 33% 機率使部分傷害提高至 1.5 倍，不含部分增傷魔法加成。","172":"提升自己的移動速度(原版說明)。","173":"依等級差判定，使指定目標接受的治癒與回復藥水效果減半，持續 192 秒。","174":"依等級差判定，使指定玩家的遠距離迴避歸零，持續 192 秒。","175":"強化自己 64 秒；近戰武器傷害骰固定取最大值，且不因攻擊硬皮怪或尖刺盔甲而損傷。","176":"使自己在負重過半時仍可自然恢復體力與魔力，持續 16 分鐘；其他回復限制仍適用。","181":"使自己每次受到的多數物理與魔法傷害減少 2，持續 20 分鐘。","182":"強化自己，讓下一次近戰攻擊傷害補正增加 10；發動後消失，最長 1 分鐘。","183":"依魔法能力與目標魔防判定，使指定目標防禦值增加 15，持續 1 分鐘，較容易受到物理攻擊。","184":"對單一目標造成火屬性魔法傷害，基礎 45 點；實際傷害依能力與抗性變動。","185":"使自己覺醒變身，體力上限增加 127、防禦值降低 12；維持至覺醒解除，再次施放可取消。","186":"額外提高自己的攻擊速度，持續 1 分鐘；會取代勇敢、精靈餅乾等同類加速。","187":"對 2 格內指定目標連續攻擊 3 次；弱點曝光第三階可提高傷害，施放後消除弱點曝光。","188":"依魔法能力與目標魔防判定，降低指定目標物理閃避能力，持續 1 分鐘。","189":"對自己周圍 2 格敵人造成風屬性魔法傷害，基礎 45 點；實際傷害依能力與抗性變動。","190":"使自己覺醒變身，魔防及四屬性抗性各增加 30；維持至覺醒解除，再次施放可取消。","191":"保護自己 5 分鐘；受到他人傷害時，有 10% 機率對攻擊者反擊 30 點傷害。","192":"對單一目標造成風屬性傷害，並有機率束縛；成功先禁錮約 0.5 秒，再維持 2 秒。","193":"依魔法能力與目標魔防判定，使指定目標力量與智力各降低 5，持續 64 秒。","194":"對朝向目標的直線敵人造成水屬性傷害，並依魔法能力、魔防及抗性判定冰凍，成功凍結 3 秒。","195":"使自己覺醒變身，六項基本能力各增加 5；維持至覺醒解除，再次施放可取消。","201":"提高自己的物理閃避能力，持續 20 分鐘；與暗影閃避互相取代。","202":"對單一目標造成無屬性魔法傷害，另有機率使指定玩家無法施法 8 秒。","203":"對近身單一目標發動物理攻擊，傷害補正增加 15；使用奇古獸類武器時改用 15 點為基礎。","204":"使自己或指定目標近戰、遠距離的命中與傷害各增加 4，持續 32 秒。","205":"在身旁建立 20 秒立方，影響周圍 3 格；友方火抗增加 30，敵方每 4 秒承受 10 點基礎傷害。","206":"使自己或指定玩家魔力自然回復增加 2，持續 5 分鐘。","207":"對單一目標造成魔法傷害；若目標魔力足夠，再破壞其 5 點魔力並依自己的精神提高傷害。","208":"對近身目標物理攻擊，傷害補正增加 10；另有機率在約 0.7 秒後使目標暈眩 1 秒。","209":"使自己或指定目標魔攻增加 2，持續 32 秒。","210":"在身旁建立 20 秒立方，影響周圍 3 格；友方地抗增加 30，敵方每 4 秒被束縛 1 秒。","211":"使自己或指定玩家每次受到的多數物理及魔法傷害減少 2，持續 10 分鐘。","212":"使指定目標陷入幻覺而睡眠,一段時間內無法行動(原版說明)。","213":"對單一目標造成無屬性魔法傷害，基礎 15 點；實際傷害依能力與抗性變動。","214":"使自己或指定目標防禦提升（防禦值降低 20），持續 32 秒。","215":"在身旁建立 20 秒立方，影響周圍 3 格；使友方風屬性抗性增加 30。","216":"使自己或指定玩家力量、體質、敏捷、精神、智力各增加 1，持續 5 分鐘。","217":"依魔法能力與目標魔防判定，使指定目標力量、體質、敏捷、精神、智力各降低 1，持續 64 秒。","218":"對 2 格內單一目標造成魔法傷害；自己損失的體力越多，威力越高，仍受目標魔防等限制。","219":"強化自己或指定目標 32 秒，物理及魔法傷害補正增加 10；玩家受到的傷害也提高至 1.2 倍。","220":"在身旁建立 20 秒立方，周圍 3 格玩家與怪物每 4 秒回復 5 點魔力、每 5 秒承受 25 點基礎傷害。"};
const SKILL_MAT_NAME = { 40318: '魔法寶石', 40321: '二級黑魔石', 40319: '精靈玉', 49157: '刻印的骨頭碎片', 49156: '屬性石' };
function appendSkillInfo(body, id) {
  const sk = st.game.skills?.[id];
  if (!sk) return;
  const cost = [`MP ${skillMp(id)}`];
  if (sk.hp) cost.push(`HP ${sk.hp}`);
  if (sk.mat) cost.push(`${SKILL_MAT_NAME[sk.mat[0]] || '材料'} ×${sk.mat[1]}`);
  const small = (p) => { p.style.setProperty('font-size', '.85em', 'important'); p.style.setProperty('line-height', '1.4', 'important'); return p; }; // 10/28 使用者:字小一點
  body.appendChild(small(el('p', 'hint', `消耗 ${cost.join(' · ')}`)));
  if (SKILL_DESC[id]) body.appendChild(small(el('p', 'hint skill-desc', SKILL_DESC[id])));
}
// 選快捷欄格子(從技能頁點魔法時)
function openSlotPicker(entry) {
  const body = $('#is-body');
  body.innerHTML = '';
  const sk = st.game.skills[entry.skill];
  $('#is-title').textContent = sk?.name || '快捷欄';
  if (sk) appendSkillInfo(body, entry.skill); // 10/28 技能說明:消耗(MP / HP / 材料)+ 說明(對象寫在說明裡)
  if (isPassiveSkill(entry.skill)) { $('#itemsheet').classList.remove('hidden'); return; }
  const hb = el('div', 'is-hotbar');
  hb.appendChild(el('span', 'hint', '放到快捷欄:'));
  for (let i = 0; i < 5; i++) {
    const b = el('button', 'slot-pick', String(i + 1));
    b.type = 'button';
    b.onclick = () => { setSlot(i, entry); closeItemSheet(); toast(`已放到快捷欄 ${i + 1}`); };
    hb.appendChild(b);
  }
  body.appendChild(hb);
  $('#itemsheet').classList.remove('hidden');
}

// 點空的快捷欄:列出已學會的魔法,也可以去背包放道具
function openHotbarPicker(i) {
  const body = $('#is-body');
  body.innerHTML = '';
  $('#is-title').textContent = `快捷欄 ${i + 1}`;
  const skills = st.game.skills || {};
  const ord = (id) => (ELF_LEARN_LV[id] ? 17 + ELF_LEARN_LV[id] / 100 : skills[id].level); // 妖精魔法照學習等級排
  const ids = [...st.skills].filter((id) => skills[id] && !isPassiveSkill(id)).sort((a, b) => ord(a) - ord(b) || a - b);
  if (ids.length) {
    body.appendChild(el('p', 'hint', '選一個魔法放進這一格:'));
    const grid = el('div', 'skill-pick-grid');
    for (const id of ids) {
      const b = el('button', 'skill-pick');
      b.type = 'button';
      b.appendChild(skillIcon(skills[id].name));
      const txt = el('span', 'txt');
      txt.append(el('span', 'nm', skills[id].name), el('small', '', `MP ${skillMp(id)}`));
      b.appendChild(txt);
      b.onclick = () => { setSlot(i, { skill: id }); closeItemSheet(); toast(`已放到快捷欄 ${i + 1}`); };
      grid.appendChild(b);
    }
    body.appendChild(grid);
  } else body.appendChild(el('p', 'hint', '還沒有學會魔法(說話之島的吉倫可以學)。'));
  const actions = el('div', 'is-actions');
  const inv = el('button', '', '放藥水 / 裝備(開背包)');
  inv.type = 'button';
  inv.onclick = () => { closeItemSheet(); openPanel('inv'); toast('點藥水或裝備後選「快捷」'); };
  actions.appendChild(inv);
  body.appendChild(actions);
  $('#itemsheet').classList.remove('hidden');
}

// 施放魔法:攻擊 / 詛咒類對目前攻擊的怪物(沒有就找最近的),其他對自己
// 對道具施放的輔助魔法:擬似魔法武器 → 裝備中的武器、鎧甲護持 → 穿著的盔甲(不用再點選目標)
// 網頁版:擬似魔法武器、鎧甲護持改成掛在角色身上(伺服器 L1SkillUse),不用指定武器 / 鎧甲,當一般對自己的魔法放
const ITEM_TARGET_SKILLS = {};
function equippedTarget(id) {
  const kind = ITEM_TARGET_SKILLS[id];
  if (!kind) return null;
  for (const it of st.inv.values()) {
    if (!isEquipped(it)) continue;
    if (kind === 'weapon' ? /\(揮舞\)/.test(it.name) : it.useType === 2) return it;
  }
  return null;
}
const lastCast = {}; // skill id -> 施放時間(沒有狀態圖示的輔助魔法用來計時)

// 施法動作:有向(18)/ 無向(19)施法,時間照速度表;播完前不能走、不能攻擊、不能再施法
function startCast(me, sk, target) {
  const now = performance.now();
  const act = sk?.action === 18 ? 18 : 19;
  if (target && act === 18) faceTo(me, target.x, target.y);
  if (sk && sk === st.game.skills[132]) { // 三重矢:不播施法動作;10/28 送出就先播 3 下拉弓(和普攻一樣不等伺服器),伺服器的三箭回來只放箭和傷害、不重播(app.js onAttack)
    const ms = actionMs(me, 'attack'), seg = ms / 3;
    if (target) faceTo(me, target.x, target.y);
    st.tripleLocal = { at: now, until: now + ms + 1500 };
    for (let i = 0; i < 3; i++) later(i * seg, () => { me.lunge = performance.now(); me.lungeMs = seg; me.lungeAct = null; });
    st.nextAttackAt = Math.max(st.nextAttackAt || 0, now + ms);
    return;
  }
  me.lunge = now; me.lungeMs = actionMs(me, `spell${act}`); me.lungeAct = act;
  st.nextAttackAt = Math.max(st.nextAttackAt || 0, now + me.lungeMs);
  // 冷卻在動作播完後才算(伺服器 SkillDelayAfterAnim):這段時間不能再施法(可以走路、攻擊),多留 50ms 給網路
  if (st.skillDelayAfterAnim && sk?.delay > 0) st.castLockUntil = now + me.lungeMs + sk.delay + 50;
}

// 可以放在隊友身上的輔助魔法(skills 表 target_to 含玩家、type 2 輔助 / 16 治癒 / 32 復活;變形術要選外型,不算)
// 狂暴術 55、聖結界 68:同隊伍或同血盟;通暢氣脈術 26、體魄強健術 42:只限同血盟(不同血盟伺服器會擋)
// 在組隊欄點選隊友(st.allyTarget)後,快捷欄放這些魔法就對他放;太遠先走過去
const ALLY_SKILLS = new Set([1, 8, 9, 19, 26, 35, 37, 42, 43, 48, 55, 57, 61, 68, 75, 79, 148, 149, 151, 158, 160, 170]);
const ALLY_REACH = 6;

// 手動選取後的攻擊 / 詛咒魔法只在原地施放;不建立 castOnce 追擊。
function castPickedSkill(id, me, sk, t) {
  if (id === 121 && royalSwordCooling()) { toast('技能冷卻中。'); return false; }
  st.target = null;
  st.path = [];
  press = null; // 按住地面時也不要在下個 tick 再產生走路路徑
  st.pendingCast = null;
  st.pendingPickedCast = false;
  // 沿用攻擊魔法的玩家限制:迷魅術不能對玩家、不能攻擊隊友。
  if (t.kind === 'pc' && (id === 36 || !(st.forceAttack || inArenaEvent()) || (st.party || []).some((m) => m.id === t.id))) {
    toast('這個魔法不能對選取目標施放'); return false;
  }
  const d = Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y));
  if (d > skillReach(id)) { toast('選取目標超出施法射程'); return false; }
  if (!clearLine(me.x, me.y, t.x, t.y)) { toast('與選取目標之間有障礙'); return false; }
  const now = performance.now();
  if (me.anim || (me.lunge && now < me.lunge + (me.lungeMs || 0)) || now < (st.castLockUntil || 0)) {
    st.pendingCast = id; st.pendingCastSelf = false; st.pendingCastHeal = null; st.pendingCastWindWalk = false; st.pendingPickedCast = true; st.pendingCastSupply = false;
    return true;
  }
  startCast(me, sk, t);
  lastCast[id] = now;
  send({ t: 'useskill', skill: id, target: t.id, x: t.x, y: t.y });
  return true;
}

const SELF_HEAL_EMERGENCY_HP = 30;
function preferPetHeal(selfNeeds, selfHp, petHp) {
  return petHp >= 0 && (!selfNeeds || (selfHp >= SELF_HEAL_EMERGENCY_HP && petHp < selfHp));
}
function healPet() {
  const ph = settings.petHeal, me = self();
  if (!me || !ph.on || !st.game.skills?.[ph.id] || !st.skills.has(ph.id) || st.me.mp < skillMp(ph.id)) return null;
  let low = null;
  for (const o of st.objects.values()) {
    if (!isMyPet(o) || o.dead || o.dying || !(o.hpRatio >= 0) || o.hpRatio >= ph.hp) continue;
    if (Math.max(Math.abs(o.x-me.x), Math.abs(o.y-me.y)) > 10 || !clearLine(me.x,me.y,o.x,o.y)) continue;
    if (!low || o.hpRatio < low.hpRatio) low = o;
  }
  return low;
}
function petFirst() {
  const hs = settings.healSkill, pet = healPet();
  const selfNeeds = hs.on && st.game.skills?.[hs.id] && st.me.hp*100 < hs.hp*st.me.maxHp && selfHealReady(hs.id);
  return preferPetHeal(selfNeeds, 100*st.me.hp/st.me.maxHp, pet ? pet.hpRatio : -1);
}
function castSkill(id, onSelf = false, heal = null, autoWindWalk = false, automaticSupply = false) { // onSelf:快捷欄快速點兩下,輔助魔法強制放自己(不管選了哪個隊友)
  if (isPassiveSkill(id)) return false;
  if (srvActive() && (automaticSupply || heal || autoWindWalk)) return false;
  if (id === 87 && !wieldsTwoHand()) { toast('衝擊之暈需要裝備雙手劍'); return false; } // #47
  if (paraBlocked('麻痺中無法施法')) return;
  const me = self();
  if (!me || me.dead) return false;
  // 自動風之疾走排隊後,效果 / MP / 開關可能已變;送出前再檢查,手動施法照舊。
  if (autoWindWalk && (srvActive() || autoBraveAction(me) !== -WIND_WALK || castWithin(WIND_WALK, 13))) return false;
  const sk = st.game.skills[id];
  if (id === 121 && !st.royalSword) { toast('王者之劍尚未開放'); return false; }
  if (id === 121 && royalSwordCooling()) { toast('技能冷卻中。'); return false; }
  if (!st.skills.has(id) && !heal) { toast(`還沒學會${sk?.name || '這個魔法'}`); return false; }
  // Self heal (2) > pet heal (1) > other queued spells (0).
  const priority = heal?.priority || 0;
  if (!(srvSup.petHealPriority && heal) && st.pendingCast && (st.pendingCastHeal?.priority || 0) > priority) return false;
  if (heal) {
    const hs = settings.healSkill;
    const selfNeedsHeal = hs.on && st.game.skills?.[hs.id]
      && st.me.hp * 100 < hs.hp * st.me.maxHp && selfHealReady(hs.id);
    // HP can change between the AUTO tick and the attack gap.
    if (srvSup.petHealPriority) {
      const pet = healPet(), first = petFirst();
      if (first && (heal.petId == null || heal.petId !== pet.id)) return castSkill(settings.petHeal.id, false, { priority: 2, petId: pet.id });
      if (!first && heal.petId != null) return selfNeedsHeal ? castSkill(hs.id, true, { priority: 2 }) : false;
    }
    if (!srvSup.petHealPriority && heal.petId != null && selfNeedsHeal) return castSkill(hs.id, true, { priority: 2 });
    if (heal.petId == null && (!selfNeedsHeal || hs.id !== id)) return false;
    if (!sk || performance.now() <= auto.nextHeal) return false;
    if (heal.petId == null && srvActive() && scrollKindForSkill(id)) return false;
    if (heal.petId == null) {
      const result = tryAutoScroll(id);
      if (result) {
        if (result === 1) auto.nextHeal = performance.now() + 1500;
        return result === 1;
      }
    }
    if (!st.skills.has(id) || st.me.mp < skillMp(id)) return false;
    if (heal.petId != null) {
      const pet = st.objects.get(heal.petId);
      const ph = settings.petHeal;
      if (!ph.on || ph.id !== id || !pet || !isMyPet(pet) || pet.dead || pet.dying || !(pet.hpRatio >= 0) || pet.hpRatio >= ph.hp
        || Math.max(Math.abs(pet.x - me.x), Math.abs(pet.y - me.y)) > 10 || !clearLine(me.x, me.y, pet.x, pet.y)) return false;
    }
  }
  if (st.clickSelect && !auto.on && st.picked && sk?.hostile && !sk.area && !ITEM_TARGET_SKILLS[id] && id !== 5 && id !== 69
    && !(stunPvpOnly(id) && !stunTarget(pickedTarget()))) { // 11/06:衝擊之暈點選的不是可打玩家 / BOSS → 走下面找附近的
    const t = pickedTarget();
    if (!t) { toast('選取目標已不在附近'); return false; }
    return castPickedSkill(id, me, sk, t);
  }
  if (st.clickSelect && st.pendingPickedCast) { st.pendingCast = null; st.pendingPickedCast = false; }
  // 還在走這一步 / 上一個動作還沒播完:先記著,動作結束再放(app.js step)
  const now = performance.now();
  if (me.anim || (me.lunge && now < me.lunge + (me.lungeMs || 0)) || now < (st.castLockUntil || 0)) { st.pendingCast = id; st.pendingCastSelf = onSelf; st.pendingCastHeal = heal; st.pendingCastWindWalk = autoWindWalk; st.pendingCastSupply = automaticSupply || !!heal || autoWindWalk; return true; }
  if (heal) {
    const target = heal.petId != null ? st.objects.get(heal.petId) : me;
    startCast(me, sk, target);
    lastCast[id] = now;
    send({ t: 'useskill', skill: id, target: target.id, x: target.x, y: target.y });
    auto.nextHeal = now + 1500; // Start the shared heal interval when sent, not when queued.
    return true;
  }
  if (autoWindWalk) auto.nextBuff = now + 3000; // 真正送出時重新起算,長動作排隊也不會連放
  if (ITEM_TARGET_SKILLS[id]) {
    const it = equippedTarget(id);
    if (!it) { toast(ITEM_TARGET_SKILLS[id] === 'weapon' ? '沒有裝備武器' : '沒有穿盔甲'); return false; }
    send({ t: 'useskill', skill: id, target: it.id, x: me.x, y: me.y });
    startCast(me, sk, null);
    lastCast[id] = performance.now();
    return true;
  }
  // 指定傳送:直接在同一張地圖隨機傳送(不開記憶座標選單,那是祝福的瞬間移動卷軸)
  if (id === 5) { startCast(me, sk, null); lastCast[id] = performance.now(); send({ t: 'useskill', skill: id, bookmark: null }); return true; }
  if (id === 69) { openTeleportSheet(null, id); return true; } // 集體傳送術:先選地點
  if (id === 41) { // 造屍術:對怪物屍體放(技能表是 buff,不能放自己;10/28 使用者:施展了沒有殭屍)
    const corpse = (o) => o && o.kind === 'monster' && o.dead;
    let t = st.target ? st.objects.get(st.target.id) : null;
    if (!corpse(t) && st.picked) t = st.objects.get(st.picked.id);
    if (!corpse(t) || !clearLine(me.x, me.y, t.x, t.y)) {
      t = null;
      let bd = Infinity;
      for (const o of st.objects.values()) {
        if (!corpse(o) || !clearLine(me.x, me.y, o.x, o.y)) continue;
        const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
        if (d <= 12 && d < bd) { t = o; bd = d; }
      }
    }
    if (!t) { toast('附近沒有怪物屍體(造屍術要對屍體施放)'); return false; }
    lastCast[id] = performance.now();
    startCast(me, sk, t);
    send({ t: 'useskill', skill: id, target: t.id, x: t.x, y: t.y });
    return true;
  }
  lastCast[id] = performance.now();
  if (sk?.area) { // 以自己為中心的範圍攻擊:不用目標,直接放
    startCast(me, sk, null);
    send({ t: 'useskill', skill: id, target: st.selfId, x: me.x, y: me.y });
  } else if (sk?.hostile) {
    // 有選定目標(正在走過去 / 正在打的那隻)就對牠放;沒有才找畫面上最近的一隻
    const stunOnly = stunPvpOnly(id); // 11/06:衝擊之暈只對 PvP 玩家與 BOSS
    const alive = (o) => (stunOnly ? stunBoss(o) : o && !o.dead && !o.dying && o.kind === 'monster');
    // 開 PvP 時鎖定的敵人玩家(敵人清單 / 點地圖上的玩家)也可以放:非自己、非隊友
    // 迷魅術(36)只能對怪物放
    const enemyPc = (o) => stunOnly ? stunEnemy(o) : id !== 36 && st.forceAttack && o && !o.dead && !o.dying && o.kind === 'pc' && o.id !== st.selfId && !(st.party || []).some((m) => m.id === o.id);
    // 寵物 / 召喚獸:PvP 開著、而且是點選鎖定的才打(自己的也可以)
    const enemyPet = (o) => !stunOnly && id !== 36 && st.forceAttack && o && !o.dead && !o.dying && o.kind === 'pet';
    let t = st.target?.mode === 'attack' ? st.objects.get(st.target.id) : null;
    if (stunOnly && !stunTarget(t) && st.picked && stunTarget(pickedTarget())) t = pickedTarget(); // 點選的玩家 / BOSS 優先
    if (!alive(t) && !enemyPc(t) && !enemyPet(t)) {
      t = null;
      let bd = Infinity;
      const W = canvas.width / (DPR * ZOOM);
      const H = canvas.height / (DPR * ZOOM);
      for (const o of st.objects.values()) {
        if (stunOnly ? !stunTarget(o) : !alive(o)) continue;
        const p = toScreen(o.px, o.py);
        if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) continue; // 只找畫面上的
        const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
        if (d < bd) { t = o; bd = d; }
      }
    }
    if (!t) { toast(stunOnly ? '附近沒有可以打的玩家或 BOSS(衝擊之暈只對 PvP 玩家與 BOSS)' : '畫面上沒有可以施放的目標'); return false; }
    const range = skillReach(id);
    const d = Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y));
    if (d > range || !clearLine(me.x, me.y, t.x, t.y)) {
      // 太遠 / 中間有障礙:先走過去,到了射程再放(app.js 追目標那段)
      // 原本就在打牠的話,放完繼續打;只為了施法才走過去的,放完就停
      const keep = st.target?.mode === 'attack' && st.target.id === t.id && !st.target.castOnly;
      st.target = { id: t.id, mode: 'attack', castOnce: id, castOnly: !keep };
      st.path = [];
      return true;
    }
    if (st.target?.castOnce === id) {
      if (st.target.castOnly) st.target = null;
      else delete st.target.castOnce;
    }
    startCast(me, sk, t);
    send({ t: 'useskill', skill: id, target: t.id, x: t.x, y: t.y });
  } else if (ALLY_SKILLS.has(id) && st.allyTarget && !onSelf) {
    const t = st.objects.get(st.allyTarget);
    const revive = id === 61 || id === 75; // 返生術:對倒下的隊友放
    if (!t || t.dying || (t.dead && !revive)) { toast('選定的隊友不在附近'); return false; }
    const d = Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y));
    if (d > ALLY_REACH) {
      if (t.dead) { toast('隊友太遠了'); return false; }
      st.target = { id: t.id, mode: 'ally', castOnce: id }; // 先走過去,到了再放(app.js 追目標那段)
      st.path = [];
      return true;
    }
    startCast(me, sk, t);
    send({ t: 'useskill', skill: id, target: t.id, x: t.x, y: t.y });
  } else {
    startCast(me, sk, null);
    send({ t: 'useskill', skill: id, target: st.selfId, x: me.x, y: me.y });
  }
  return true;
}
// 快捷欄共用冷卻：伺服器時間已含動作；只更新顯示，不改施法鎖。
function skillCooldownRemaining(sharedUntil, individualUntil, now) {
  return Math.max(0, Math.max(sharedUntil || 0, individualUntil || 0) - now);
}
function skillCooldownText(ms) {
  if (ms < 300) return '';
  if (ms >= 60000) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  if (ms >= 10000) return String(Math.ceil(ms / 1000));
  return (Math.ceil(ms / 100) / 10).toFixed(1);
}
function skillCooldownOpacity(ms, total) {
  return ms < 300 ? 0 : 0.15 + 0.55 * Math.min(1, Math.max(0, ms / Math.max(1, total)));
}
function skillCooldownDeadline(current, now, ms, enabled) {
  return enabled && Number.isSafeInteger(ms) && ms >= 300 ? Math.max(current || 0, now + ms) : current;
}
const hotbarCooldown = { frame: 0, masks: [] };
function hotbarCooldownEnabled() {
  return !!st.webHotkeyCooldownEnabled; // 11/05 使用者「設定裡面的顯示快捷欄 CD 不要顯示,直接讓所有人開啟」:不看個人設定(舊存檔關過的也開)
}
function clearHotbarCooldown() {
  cancelAnimationFrame(hotbarCooldown.frame);
  hotbarCooldown.frame = 0;
  for (const mask of hotbarCooldown.masks) mask.remove();
  hotbarCooldown.masks = [];
}
function resetHotbarCooldown() {
  clearHotbarCooldown();
  st.skillCdUntil = st.skillCdFrom = 0;
  st.royalSwordCdUntil = st.royalSwordCdFrom = 0;
}
function syncHotbarCooldown() {
  const now = performance.now();
  if (!st.inGame) { clearHotbarCooldown(); return; }
  let active = false;
  for (const mask of hotbarCooldown.masks) {
    const royal = +mask.dataset.skill === 121;
    const shared = hotbarCooldownEnabled() ? st.skillCdUntil || 0 : 0;
    const individual = royal && st.royalSword ? st.royalSwordCdUntil || 0 : 0;
    const ms = skillCooldownRemaining(shared, individual, now);
    mask.style.display = ms >= 300 ? 'flex' : 'none';
    if (ms < 300) continue;
    active = true;
    const from = individual > shared ? st.royalSwordCdFrom : st.skillCdFrom;
    mask.style.backgroundColor = `rgba(0,0,0,${skillCooldownOpacity(ms, Math.max(shared, individual) - (from || now))})`;
    const text = skillCooldownText(ms);
    if (mask.firstChild.textContent !== text) mask.firstChild.textContent = text;
  }
  if (!active) { clearHotbarCooldown(); return; }
  if (!hotbarCooldown.frame) hotbarCooldown.frame = requestAnimationFrame(() => { hotbarCooldown.frame = 0; syncHotbarCooldown(); });
}
function rebuildHotbarCooldownMasks() {
  clearHotbarCooldown();
  if (!st.inGame) return;
  const now = performance.now();
  for (const b of document.querySelectorAll('#hotbar .slot[data-slot], .skill[data-skill="121"]')) {
    const id = b.dataset.skill ? +b.dataset.skill : slotSkill(+b.dataset.slot);
    if (!id) continue;
    const shared = hotbarCooldownEnabled() ? st.skillCdUntil : 0;
    const individual = id === 121 && st.royalSword ? st.royalSwordCdUntil : 0;
    if (skillCooldownRemaining(shared, individual, now) < 300) continue;
    const mask = el('span', 'skill-cooldown'); mask.dataset.skill = id;
    mask.setAttribute('aria-hidden', 'true');
    // Same existing countdown mask; also fits the RoyalSword cell in the skill panel.
    mask.style.cssText = 'position:absolute;inset:0;border-radius:inherit;z-index:2;pointer-events:none;display:flex;align-items:center;justify-content:center';
    const left = el('i', 'left');left.style.cssText = 'font-size:10px;line-height:11px;font-style:normal;font-weight:bold;color:white;text-shadow:0 1px 2px black';
    mask.appendChild(left); b.appendChild(mask); hotbarCooldown.masks.push(mask);
  }
  syncHotbarCooldown();
}
function royalSwordCooling() { return !!st.royalSword && performance.now() < (st.royalSwordCdUntil || 0); }
function confirmRoyalSwordCooldown(ms) {
  if (!st.inGame || !st.royalSword || !Number.isSafeInteger(ms) || ms < 0 || ms > 600000) return;
  const now = performance.now();
  st.royalSwordCdFrom = now; st.royalSwordCdUntil = ms ? now + ms : 0;
  rebuildHotbarCooldownMasks(); // Never changes shared castLockUntil or skillCdUntil.
}
function setSkillCooldown(ms) {
  if (!st.inGame || !hotbarCooldownEnabled()) return;
  const now = performance.now();
  const until = skillCooldownDeadline(st.skillCdUntil, now, ms, true);
  if (until === st.skillCdUntil || !(until > now)) return;
  st.skillCdFrom = now;
  st.skillCdUntil = until;
  rebuildHotbarCooldownMasks();
}
// 11/05 主導:網頁先開始的倒數只是暫定;1.2 秒內沒收到伺服器 ##SKILLCD##(材料不足、冷卻中、目標無效…伺服器沒真的施法)就撤回到已確認的冷卻
const skillCdConfirm = { until: 0, seq: 0, pending: 0 };
function confirmSkillCooldown(ms) {
  skillCdConfirm.pending = 0;
  if (!st.inGame || !hotbarCooldownEnabled()) return;
  const now = performance.now();
  if (!(st.skillCdUntil > skillCdConfirm.until)) { setSkillCooldown(ms); skillCdConfirm.until = st.skillCdUntil; return; }
  st.skillCdUntil = Math.max(skillCdConfirm.until, now); // 撤掉本機暫定,改用伺服器時間(含施法動作)
  setSkillCooldown(ms);
  skillCdConfirm.until = st.skillCdUntil;
}
function hotbarCooldownSent(id) {
  if (!st.inGame || !hotbarCooldownEnabled()) return;
  const me = self(), now = performance.now();
  // 某些路徑先 send 再 startCast，同一輪結束後讀取動作。
  queueMicrotask(() => {
    if (!me || self() !== me || !st.inGame || !hotbarCooldownEnabled()) return;
    const delay = st.game.skills[id]?.delay || 0;
    const animationUntil = (me.lunge || 0) + (me.lungeMs || 0);
    const until = Math.max(st.castLockUntil || 0, animationUntil,
      now + delay + (st.skillDelayAfterAnim && delay > 0 ? Math.max(0, animationUntil - now) : 0));
    setSkillCooldown(Math.ceil(Math.max(0, until - performance.now())));
    const token = ++skillCdConfirm.seq; skillCdConfirm.pending = token;
    setTimeout(() => {
      if (skillCdConfirm.pending !== token) return;
      skillCdConfirm.pending = 0;
      const n = performance.now();
      st.skillCdUntil = skillCdConfirm.until > n ? skillCdConfirm.until : 0;
      if (!st.skillCdUntil) st.skillCdFrom = 0;
      rebuildHotbarCooldownMasks();
    }, 1200);
  });
}

function renderHotbar() {
  document.querySelectorAll('#hotbar .slot[data-slot]').forEach((b) => {
    const i = +b.dataset.slot;
    b.innerHTML = '';
    b.classList.remove('equipped'); // 清掉 / 換成魔法時,舊的金框也要拿掉
    const name = st.hotbar[i];
    b.classList.toggle('skill', !!slotSkill(i));
    if (!name) { b.classList.add('empty'); return; }
    b.classList.remove('empty');
    if (slotSkill(i)) {
      const sk = st.game.skills[slotSkill(i)];
      // 魔法圖示;圖示還沒載入 / 沒有時先顯示名稱
      const c = el('canvas', 'icon fill'); // 魔法圖示填滿整個格子
      c.width = c.height = 64 * DPR;
      if (sk && GDX.drawNamed(c.getContext('2d'), sk.name, 0, 0, c.width)) b.appendChild(c);
      else {
        b.appendChild(el('span', 'sk', sk ? sk.name.slice(0, 4) : '魔法'));
        if (GDX.hasIcon({}) === undefined) setTimeout(renderHotbar, 800); // 圖示還在載入
      }
      if (sk) b.appendChild(el('b', 'count', skillMp(slotSkill(i))));
      return;
    }
    const it = slotItem(i);
    b.classList.toggle('equipped', !!(it && slotGear(i) && isEquipped(it))); // 裝備中的那格加金框(跟背包一樣)
    if (it) {
      b.appendChild(iconCanvas(it, 42)); // 道具圖示放大,填滿格子
      if (it.count > 1 && !slotGear(i)) b.appendChild(el('b', 'count', it.count)); // 裝備疊在一起不顯示數量,只顯示強化值
      const en = slotGear(i) && /^([+-]\d+)/.exec(it.name);
      if (en && en[1] !== '+0') b.appendChild(el('b', 'count', en[1])); // 裝備顯示強化值,分得出 +0 / +7
    } else b.appendChild(el('span', 'gone', slotLabel(i).slice(0, 4)));
  });
  rebuildHotbarCooldownMasks();
}
// 選了隊友時,快捷欄的輔助魔法:點一下對隊友放,快速點兩下對自己放(點一下要等一下確定不是第二下)
let slotTap = null;
function useSlot(i) {
  if (typeof tpTag === 'function') tpTag('hotkey' + (i + 1)); // 11/17 tpsource
  const sid = slotSkill(i);
  if (sid && ALLY_SKILLS.has(sid) && st.allyTarget) {
    if (slotTap && slotTap.i === i) { clearTimeout(slotTap.timer); slotTap = null; castSkill(sid, true); return; }
    if (slotTap) { clearTimeout(slotTap.timer); const prev = slotTap.sid; slotTap = null; castSkill(prev); }
    slotTap = { i, sid, timer: setTimeout(() => { slotTap = null; castSkill(sid); }, DOUBLE_TAP_MS) };
    return;
  }
  if (sid) { castSkill(sid); return; }
  const it = slotItem(i);
  if (it) useItem(it); // 10/28 使用者:裝備中再按一下 = 脫下(伺服器 C_ItemUSe 對穿著的裝備就是脫下);沒穿 = 換上(equipSwap) // 裝備:同一格的舊裝備先脫再換上(equipSwap)
  else if (st.hotbar[i]) toast(`身上沒有${slotLabel(i)}`);
}
document.querySelectorAll('#hotbar .slot[data-slot]').forEach((b) => {
  const i = +b.dataset.slot;
  let timer = null;
  let long = false;
  b.addEventListener('pointerdown', () => {
    long = false;
    timer = setTimeout(() => { long = true; if (st.hotbar[i] && setSlot(i, null) !== false) toast('已清除快捷欄'); }, 600);
  });
  const cancel = () => clearTimeout(timer);
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    if (hotbarPick.entry != null) { const ok = setSlot(i, hotbarPick.entry) !== false; endHotbarPick(); if (ok) toast(`已放到快捷欄 ${i + 1}`); return; }
    if (long) return;
    if (st.hotbar[i]) useSlot(i);
    else if (st.hotbarLock) toast('快捷欄已上鎖,先點快捷欄旁的鎖頭解鎖');
    else openPanel('skill', null, i); // 空格:直接用技能頁選魔法
  });
});
renderHotbar();
// 快捷欄上鎖(10/28 使用者):右上角小鎖頭,點一下切換;每個角色各自記住
function syncHotbarLock() {
  let b = document.getElementById('hotbar-lock');
  const hb = document.getElementById('hotbar');
  if (!hb || !hb.parentElement) return;
  if (!b) {
    b = el('button', ''); b.id = 'hotbar-lock'; b.type = 'button';
    b.style.cssText = 'position:absolute;z-index:5;width:24px;height:20px;min-height:0;padding:0;font-size:12px;line-height:1;background:rgba(40,28,12,.85);border:1px solid #6e5a30;border-radius:5px';
    b.onclick = () => { st.hotbarLock = !st.hotbarLock; store.set(charKey('hotbarLock'), st.hotbarLock); toast(st.hotbarLock ? '快捷欄已上鎖:不會被長按清除或換掉' : '快捷欄已解鎖'); syncHotbarLock(); };
    hb.parentElement.appendChild(b);
    window.addEventListener('resize', () => syncHotbarLock());
    setInterval(() => syncHotbarLock(), 1000);
  }
  if (!st.inGame || !hb.offsetParent) { b.style.display = 'none'; return; }
  b.style.display = 'block';
  // 10/28 使用者:手機上 emoji 開鎖 / 閉鎖看起來一樣 → 自己畫:上鎖 = 金色閉鎖,解鎖 = 灰色、鎖環打開
  const on = !!st.hotbarLock;
  if (b.dataset.on !== String(on)) {
    b.dataset.on = String(on);
    const c = on ? '#f0c860' : '#9a927e';
    b.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" style="display:block;margin:auto"><path d="${on ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 6 0'}" fill="none" stroke="${c}" stroke-width="1.8" transform="${on ? '' : 'translate(3 -2) rotate(20 8 5)'}"/><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="${c}"/></svg>`;
    b.setAttribute('aria-label', on ? '快捷欄已上鎖' : '快捷欄未上鎖');
  }
  b.style.borderColor = on ? '#e0b85a' : '#6e5a30';
  b.style.background = on ? 'rgba(90,64,16,.95)' : 'rgba(40,28,12,.85)';
  // 10/28 使用者:放在裝備組「1」「2」旁邊(放進同一個 #equip-quick 盒子,跟著它的位置 / 排列);這個站沒開裝備組才自己找位置
  const eq = document.getElementById('equip-quick');
  if (eq && eq.style.display !== 'none') {
    if (b.parentElement !== eq) { eq.appendChild(b); b.style.position = 'static'; b.style.width = '22px'; }
    return;
  }
  if (b.parentElement !== hb.parentElement) { hb.parentElement.appendChild(b); b.style.position = 'absolute'; b.style.width = '24px'; }
  // 放在最上面一格的右上角(手機橫排 = 最右邊那格;電腦版直排 = 最上面那格),不壓到裝備組「1」「2」和右上的按鈕
  const slots = [...hb.querySelectorAll('.slot[data-slot]')].filter((x) => x.offsetParent);
  const s0 = slots.sort((a, c) => a.offsetTop - c.offsetTop || c.offsetLeft - a.offsetLeft)[0];
  const sx = s0 && s0.offsetParent === hb ? s0.offsetLeft : 0, sy = s0 && s0.offsetParent === hb ? s0.offsetTop : 0;
  b.style.left = `${hb.offsetLeft + sx + (s0 ? s0.offsetWidth : hb.offsetWidth) - 24}px`;
  b.style.top = `${hb.offsetTop + sy - 24}px`;
}

// 回城:不用卷軸,伺服器直接傳回最近的村莊(C_WebHome;地監等禁止傳送的地方會被擋)
// 每 3 秒只能按一次;按了會關掉自動狩獵
const HOME_COOLDOWN = 3000;
let lastHome = 0;
// 長按回城:選回哪個村莊(每個角色各自記住;預設最近的村莊)
// 只列開放區域的村莊(伺服器 C_WebHome 也只接受落點在開放區域的村莊);第三欄 = 大陸上的位置,要看開放區域遮罩
const ALL_HOME_TOWNS = [[0, '最近的村莊'], [1, '說話之島'], [3, '古魯丁村莊'], [2, '銀騎士村'], [6, '肯特村莊'], [5, '風木村莊'], [11, '妖精森林'], [4, '燃柳村莊'],
  [7, '奇岩村莊', [33430, 32815]], [8, '海音村莊', [33604, 33237]], [9, '威頓村莊', [33722, 32496]], [10, '歐瑞村莊', [34053, 32284]]]; // 10/30 威頓開放(開放遮罩含該座標才列出)
const homeTowns = () => ALL_HOME_TOWNS.filter(([, , p]) => !p || (OPEN4.open && OPEN4.open[(p[1] - OPEN4.y0) * OPEN4.w + (p[0] - OPEN4.x0)]));
const homeTown = () => (homeTowns().some(([id]) => id === settings.homeTown) ? settings.homeTown : 0); // 以前選的村莊沒開放就改回最近的
function renderHomeBtn() {
  const t = homeTowns().find(([id]) => id === homeTown());
  $('#btn-home').innerHTML = homeTown() ? `回城<small>${t[1].replace('村莊', '')}</small>` : '回城';
}
// ORENGATE_1119: values are authoritative server snapshots, never UI combat AC.
function orenGateReason() {
  const g = window.__orenGate;
  if (!g || !g.enabled || g.allowed) return '';
  const missing = [];
  if (g.level < g.minLevel) missing.push('需要 ' + g.minLevel + ' 級以上（目前 ' + g.level + ' 級）');
  if (g.ac > g.maxAc) missing.push('不含輔助魔法的防禦需 ' + g.maxAc + ' 以下（目前 ' + g.ac + '）');
  if ((g.minCollections ?? 0) > 0 && (g.collections ?? 0) < g.minCollections)
    missing.push('收藏需完成 ' + g.minCollections + ' 個（目前 ' + (g.collections ?? 0) + '）');
  return missing.join('；') || '高寵須跟隨在線且留在歐瑞的合格主人';
}
function orenGateEvent(ev) {
  window.__orenGate = ev;
  if (typeof st !== "undefined") st.path = []; // ORENGATE_FOLLOWUP1: replan on eligibility change
  if (!$('#itemsheet').classList.contains('hidden') && $('#is-title').textContent === '回城地點') openHomePicker();
}
function openHomePicker() {
  const body = $('#is-body');
  body.innerHTML = '';
  $('#is-title').textContent = '回城地點';
  for (const [id, name] of homeTowns()) {
    const gateReason = id === 10 ? orenGateReason() : '';
    const b = el('button', `home-pick${id === homeTown() && !gateReason ? ' on' : ''}`);
    b.type = 'button';
    b.appendChild(el('span', 'nm', name));
    if (gateReason) {
      b.classList.add('oren-locked');
      b.setAttribute('aria-disabled', 'true');
      b.title = gateReason;
      b.appendChild(el('small', 'oren-lock', '鎖定'));
      b.appendChild(el('span', 'oren-gate-note', gateReason));
    }
    if (id === homeTown() && !gateReason) b.appendChild(el('small', '', '目前'));
    b.onclick = () => {
      if (id === 10 && orenGateReason()) { toast(orenGateReason()); return; }
      settings.homeTown = id; saveSettings(); renderHomeBtn(); closeItemSheet(); toast(`回城設為:${name}`); };
    body.appendChild(b);
  }
  $('#itemsheet').classList.remove('hidden');
}
{
  let timer = null;
  let long = false;
  const b = $('#btn-home');
  b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; openHomePicker(); }, 600); });
  const cancel = () => clearTimeout(timer);
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { if (long) { e.stopImmediatePropagation(); long = false; } }, true);
}
$('#btn-home').onclick = () => {
  const me = self();
  if (!me || me.dead) return;
  if (paraBlocked('麻痺中無法回城')) return; // 全鎖(麻痺 / 睡眠 / 冰凍 / 昏迷)
  const now = performance.now();
  const left = HOME_COOLDOWN - (now - lastHome);
  if (left > 0) { homeCoolToast(); return; }
  clearInterval(homeCoolToast.iv);
  if ($('#toast').textContent.startsWith('回城冷卻中')) $('#toast').style.opacity = 0;
  lastHome = now;
  $('#btn-home').classList.add('cool');
  setTimeout(() => $('#btn-home').classList.remove('cool'), HOME_COOLDOWN);
  stopAuto('回城鈕');
  st.target = null;
  st.path = [];
  if (typeof tpTag === 'function' && performance.now() - TPSIG.tagAt > 80) tpTag('btn-home'); // 11/17 tpsource
  send({ t: 'home', town: homeTown() });
};

// 冷卻提示的秒數會跟著倒數(以前只寫一次,看起來像「倒數卡住」);被別的提示蓋掉就停
function homeCoolToast() {
  clearInterval(homeCoolToast.iv);
  let shown = '';
  const tick = () => {
    const l = HOME_COOLDOWN - (performance.now() - lastHome);
    const t = $('#toast');
    if (l <= 0 || (shown && t.textContent !== shown)) { clearInterval(homeCoolToast.iv); if (l <= 0 && t.textContent === shown) t.style.opacity = 0; return; }
    shown = `回城冷卻中(${Math.ceil(l / 1000)} 秒)`;
    toast(shown);
  };
  tick();
  homeCoolToast.iv = setInterval(tick, 250);
}

// ---------------- AUTO / PvP ----------------
const auto = { on: false, anchor: null, hitBy: new Map(), homing: false, nextPotion: 0, nextEscape: 0, nextBuff: 0, nextHeal: 0, nextArrow: 0, nextCure: 0, nextPoly: 0, nextWhet: 0, nextCm: 0 };
$('#btn-auto').onclick = () => {
  if (!auto.on && inArenaEvent()) { toast('血流成河場內不能自動狩獵'); return; } // 使用者 10/16:場內禁止 AUTO(會一直走動,繞過掛機不加分)
  auto.on = !auto.on;
  if (st.clickSelect && auto.on) clearPicked(); // AUTO 自己選怪,不沿用手動選取或排隊施法
  const me = self();
  auto.anchor = me ? { x: me.x, y: me.y } : null;
  auto.lastMobAt = performance.now(); // 沒怪瞬移:從按下 AUTO 開始算
  $('#btn-auto').classList.toggle('on', auto.on);
  $('#btn-auto').setAttribute('aria-pressed', auto.on);
  toast(auto.on ? '自動狩獵:開啟' : '自動狩獵:關閉');
  if (!auto.on) { st.target = null; st.path = []; }
  syncAutoHunt();
  if (!auto.on) autoStopNote('玩家按 AUTO 鈕');
};
// 關掉自動狩獵(回城、自己點地板走路時);本來就沒開什麼都不做
function stopAuto(reason) {
  if (!auto.on) return;
  auto.on = false;
  $('#btn-auto').classList.remove('on');
  $('#btn-auto').setAttribute('aria-pressed', false);
  toast('自動狩獵:關閉');
  syncAutoHunt();
  autoStopNote(reason);
}
let lastAutoStopNoteAt = -Infinity;
function autoStopNote(reason) {
  try {
    reason = reason === undefined ? '未標示' : String(reason);
    log('AUTO 已關閉:' + reason, 'sys');
    const now = Date.now();
    if (now - lastAutoStopNoteAt < 1000) return;
    lastAutoStopNoteAt = now;
    send({ t: 'autooff', why: String(reason).slice(0, 60), map: st.mapId, x: self()?.x ?? 0, y: self()?.y ?? 0, ax: auto.anchor?.x ?? 0, ay: auto.anchor?.y ?? 0, range: settings.patrol.range | 0, vis: document.visibilityState, away: !!webAway });
  } catch (e) { console.warn('AUTO 關閉記錄失敗', e); }
}
// 定點掛機(有設巡邏範圍)只要被瞬間移動就關 AUTO(使用者 10/24):不管是自己用卷軸 / 傳送技能、被別人傳、死亡回村,
// 只看位置:換地圖、或 300 ms 內跳超過 8 格(走路一個 tick 最多 2~3 格);沒設範圍時行為不變
// 不判斷(只更新記錄)的情況,免得背景代打回前景被誤關:個人獵場由伺服器代打(webAway)、分頁在背景、回前景後 5 秒內、
// tick 間隔 > 3 秒(分頁被凍結 / 節流,排隊的位置封包一次湧進來)、連線不在線上(斷線重連)
const AUTO_TP_JUMP = 8;
const autoPos = { map: -1, x: 0, y: 0, at: 0, quiet: 0 };
document.addEventListener('visibilitychange', () => { autoPos.quiet = performance.now() + 5000; });
tickEvery(() => { // 背景分頁也照跑(app.js runTick)
  if (typeof unifiedPassive === 'function' && unifiedPassive()) return;
  const me = self();
  const now = performance.now();
  const gap = now - autoPos.at;
  autoPos.at = now;
  if (!st.inGame || !me) { autoPos.map = -1; return; }
  if (!st.ws || st.ws.readyState !== 1) autoPos.quiet = now + 5000; // 斷線中:接回後 5 秒內也不判斷(伺服器代打走遠,接回時重播的位置封包一次湧進來)
  const skip = webAway || document.visibilityState !== 'visible' || now < autoPos.quiet || gap > 3000 || !st.ws || st.ws.readyState !== 1;
  const mapChanged = autoPos.map !== -1 && autoPos.map !== st.mapId;
  const jumped = !skip && autoPos.map !== -1 && (mapChanged || Math.max(Math.abs(me.x - autoPos.x), Math.abs(me.y - autoPos.y)) > AUTO_TP_JUMP);
  const jump = Math.max(Math.abs(me.x - autoPos.x), Math.abs(me.y - autoPos.y));
  autoPos.map = st.mapId; autoPos.x = me.x; autoPos.y = me.y;
  // 10/25:被伺服器拉回(走路被擋、座標修正)也會一次跳好幾格,落點還在巡邏範圍附近;只有換地圖或跳到離掛機中心超過「範圍 + 8 格」才算真的被傳走
  const away = mapChanged || !auto.anchor || Math.max(Math.abs(me.x - auto.anchor.x), Math.abs(me.y - auto.anchor.y)) > settings.patrol.range + AUTO_TP_JUMP;
  if (jumped && away && auto.on && settings.patrol.range > 0) { log('定點掛機:已瞬間移動,AUTO 已關閉', 'sys'); stopAuto(`定點掛機被瞬移 jump=${jump} 離anchor=${auto.anchor ? Math.max(Math.abs(me.x - auto.anchor.x), Math.abs(me.y - auto.anchor.y)) : 0} range=${settings.patrol.range} 換圖=${mapChanged ? 1 : 0}`); }
}, 300);
// app.js 綁的是 #btn-pvp 的 onclick;這裡只同步按鈕外觀
new MutationObserver(() => $('#btn-pvp').setAttribute('aria-pressed', $('#btn-pvp').classList.contains('on'))).observe($('#btn-pvp'), { attributes: true, attributeFilter: ['class'] });

// 永久藥水 / 7 日藥水(獎勵,不會消耗;伺服器 L1PermPotion):自動喝水時背包有就優先用
const PERM_POTIONS = { 40013: '永久 綠色藥水', 40018: '永久 綠色藥水', [BRAVE_KIND]: '永久 勇敢藥水', [DEVIL_KIND]: '永久 惡魔之血', [WAFFLE_KIND]: '永久 精靈餅乾', [WIS_KIND]: '永久 慎重藥水' }; // 慎重藥水只有 7 日版 // 11/07:不消耗的治癒藥水 99250 名稱就叫「治癒藥水」(使用者:喝水部分不能出現「永久」),不在這張表;一般名稱比對就找得到,伺服器補給優先用它
// 只找名稱完全相同的藥水(避免喝到「象牙塔治癒藥水」這類任務道具)
function potionInBag(kind) {
  if (PERM_POTIONS[kind]) {
    for (const it of st.inv.values()) if (baseName(it) === PERM_POTIONS[kind]) return it;
    // 7 日版(禮包碼送,伺服器 L1PermPotion;名稱後面接剩下的時間「[剩 6 天 …]」)
    const days7 = PERM_POTIONS[kind].replace(/^永久 /, '7日 ');
    for (const it of st.inv.values()) if (baseName(it).replace(/\s*\[.*$/, '') === days7 && !/已到期/.test(it.name)) return it;
  }
  const name = ALL_POTIONS[kind][0];
  if (POLY_KINDS[kind]) { // 變身卷軸的名稱帶括號(死亡騎士 / 黑暗精靈),baseName 會把括號去掉,改比對完整名稱(後面可以接數量)
    let found = null; // 刻印的(不能交易)優先用掉
    for (const it of st.inv.values()) {
      const n = it.name.replace(/^\+\d+\s*/, '');
      if (n === name || n.startsWith(`${name} (`) || n.startsWith(`${name}(`)) {
        if (it.bless >= 128) return it;
        found ??= it;
      }
    }
    return found;
  }
  for (const it of st.inv.values()) if (baseName(it) === name) return it;
  return null;
}
// 回傳道具編號、負的技能編號或 0;和 L1AutoSupply.braveAction 同一優先順序。
function autoBraveAction(me) {
  if (castWithin(52, 15)) return 0; // 等待神聖疾走卷軸的狀態回報
  const bk = braveKind();
  const wind = bk === WAFFLE_KIND && st.windWalkAuto;
  const learned = st.skills.has(WIND_WALK) && st.game.skills?.[WIND_WALK];
  const wb = st.buffs.get('brave');
  const windWalking = wb?.label === '風之疾走' && Number.isFinite(wb.until) && wb.until > performance.now();
  if (wind && settings.windWalk && learned) {
    if (me.brave || windWalking) return 0; // 任何勇敢類效果都不覆蓋
    if (st.me.mp >= skillMp(WIND_WALK)) return -WIND_WALK;
    return settings.brave ? bk : 0; // MP 不夠時只有勾餅乾才吃
  }
  if (!settings.brave || !bk || me.brave || st.buffs.has('brave')) return 0;
  if (wind) {
    if (windWalking) return 0;
    const cookieOk = potionInBag(bk) || (st.paidBuy?.has(bk) && adena() >= ALL_POTIONS[bk][1]);
    if (!cookieOk && learned) {
      // 舊餅乾備案:保留速度 4 卡住時的恢復;其餘勇敢效果不重放風之疾走。
      return (!me.brave || me.brave === 4) && st.me.mp >= skillMp(WIND_WALK) ? -WIND_WALK : 0;
    }
  }
  return bk;
}
function autoBraveSupply(now, me, drink) {
  if (srvActive() || now <= auto.nextBuff) return;
  // 已排隊的風之疾走交給 castSkill 重新檢查,不要同時吃餅乾或覆蓋其他排隊魔法。
  if (st.pendingCast === WIND_WALK) return;
  const action = autoBraveAction(me);
  if (action > 0) drink(action);
  else if (action === -WIND_WALK && !st.pendingCast && !castWithin(WIND_WALK, 13)) {
    if (castSkill(WIND_WALK, true, null, true)) auto.nextBuff = now + 3000;
  }
}
// 付費喝:錢不夠就不送(不然伺服器每幾秒回一次「金幣不足」洗版),只在日誌提示一次,錢夠了再恢復
const poorWarned = new Set();
function payPotion(kind) {
  const [name, price] = ALL_POTIONS[kind];
  if (adena() < price) {
    if (!poorWarned.has(kind)) { poorWarned.add(kind); log(`背包沒有${name},金幣不足 ${fmt(price)},自動${name}先暫停。`, 'sys'); }
    return;
  }
  poorWarned.delete(kind);
  send({ t: 'paidpotion', item: kind });

}
tickEvery(() => { // 背景分頁也照跑(app.js runTick)
  if (typeof unifiedPassive === 'function' && unifiedPassive()) return;
  const me = self();
  const m = st.me;
  if (!st.inGame || !me || me.dead || !m || !m.maxHp) return;
  if (document.visibilityState === 'hidden' && serverHunting()) return; // 在背景、個人獵場:伺服器在代打,網頁不要插手
  const now = performance.now();
  const hpPct = (100 * m.hp) / m.maxHp;
  if (!srvActive()) {

    // 10/25:低血逃跑只在沒開 AUTO 時執行(使用者:AUTO 時不會瞬移;離線掛機也不逃,L1OfflineHunt 同步改)
    if (!auto.on && settings.escape.on && settings.escape.hp > 0 && hpPct < settings.escape.hp && now > auto.nextEscape) {
      if (typeof tpTag === 'function') tpTag('auto-flee'); // 11/17 tpsource
      if (tpSkillReady()) { tpSkillCast(); auto.nextEscape = now + tpSkillGap(); return; } // 學會指定傳送且 MP 夠:直接放技能逃跑
      // 只用一般 / 象牙塔的瞬間移動卷軸:祝福的留給玩家用記憶點(使用者 10/15),固定地點的(妖精森林 / 歐瑞村莊…)會傳去別的地方
      const scroll = [...st.inv.values()].find((it) => ['瞬間移動卷軸', '象牙塔瞬間移動卷軸'].includes(baseName(it)) && !isBlessed(it));
      if (scroll) { if (auto.tpBag) { auto.tpBag.n = 0; auto.tpBag.warned = false; } if (typeof tpTag === 'function') tpTag('auto-flee'); send({ t: 'useitem', id: scroll.id }); auto.nextEscape = now + 3000; return; } // 逃跑:直接隨機傳送,不跳選單
      // 背包沒有:付費買一張(同沒怪瞬移;使用者 10/19「要改成自己買」),買進背包後下一輪(0.6 秒)再用;金幣不足或這站不能買就只提示一次
      if (st.paidBuy?.has(TP_KIND)) {
        if (tpBagFull(now)) return; // 背包滿:退避,不要每 0.6 秒重買
        if (adena() >= TP_PRICE) { poorWarned.delete(TP_KIND); send({ t: 'paidarrow', item: TP_KIND, count: 1 }); auto.tpBuyAt = now; auto.nextEscape = now + 600; return; }
        if (!poorWarned.has(TP_KIND)) { poorWarned.add(TP_KIND); log(`血量低逃跑:背包沒有瞬間移動卷軸,金幣不足 ${fmt(TP_PRICE)},買不起。`, 'sys'); }
      } else if (!poorWarned.has('tp-nobuy')) { poorWarned.add('tp-nobuy'); log('血量低逃跑:背包沒有瞬間移動卷軸(這裡不能付費購買)。', 'sys'); }
    }
    // 自動喝水:先喝背包裡的;沒有就付費喝(扣一瓶的售價,金幣不足伺服器會拒絕)
    if (!srvActive() && settings.potion.on && hpPct < settings.potion.hp && now > auto.nextPotion) {
      const potion = potionInBag(settings.potion.kind);
      if (potion) useItem(potion); else payPotion(settings.potion.kind);
      auto.nextPotion = now + (POTION_DELAY[settings.potion.kind] || 1000) + 50;
    }
    // 自動解毒:中毒就喝;選安特之樹枝時先用背包的,沒有再喝翡翠藥水(背包沒有就付費喝)
    if (!srvActive() && settings.cure.on && st.buffs.has('poison') && now > auto.nextCure) {
      // 解毒術:學會、MP 夠就對自己放;不然照翡翠藥水的規則
      const cast = settings.cure.kind === CURE_SKILL && st.skills.has(CURE_SKILL) && m.mp >= skillMp(CURE_SKILL) && castSkill(CURE_SKILL, true, null, false, true);
      const own = !cast && ((settings.cure.kind === CURE_ANT && potionInBag(CURE_ANT)) || potionInBag(CURE_JADE));
      if (cast) { /* 已經放了解毒術 */ } else
      if (own) useItem(own);
      else payPotion(CURE_JADE);
      auto.nextCure = now + 2000;
    }
    // 自動魔法屏障:身上沒有就放(技能:學會、MP 夠;不然用背包的卷軸;都沒有只提示一次)
    if (!srvActive() && settings.cm?.on && now > auto.nextCm && !st.buffs.has(`sk${CM_SKILL}`)) {
      const cast = settings.cm.kind === CM_SKILL && st.skills.has(CM_SKILL) && m.mp >= skillMp(CM_SKILL) && castSkill(CM_SKILL, true, null, false, true);
      const sc = !cast && cmScrollInBag();
      if (cast) { /* 已經放了魔法屏障 */ } else if (sc) { useItem(sc); poorWarned.delete(CM_SCROLL); }
      else if (st.paidBuy?.has(CM_SCROLL) && adena() >= CM_PRICE) { send({ t: 'paidarrow', item: CM_SCROLL, count: 1 }); poorWarned.delete(CM_SCROLL); } // 背包沒有就付費買一張(潘朵拉售價),下一輪再用
      else if (!poorWarned.has(CM_SCROLL)) {
        poorWarned.add(CM_SCROLL);
        log(settings.cm.kind === CM_SKILL ? '自動魔法屏障:MP 不足,背包也沒有魔法屏障卷軸。' : '自動魔法屏障:背包沒有魔法卷軸 (魔法屏障)。', 'sys');
      }
      auto.nextCm = now + 3000;
    }
    // 自動變身:沒在變身(夏娜也算)就用背包的變身卷軸;沒有就付費買一張進背包,下一輪再用
    const pk = settings.poly.kind;
    if (PolyMenu.active(polyMenuData) && pk !== 99215) autoMenuPoly(now);
    else if (settings.poly.on && POLY_KINDS[pk] && st.paidBuy?.has(pk) && now > auto.nextPoly && !st.buffs.has('poly') && !st.buffs.has('shana')) {
      const sc = potionInBag(pk);
      if (sc) { useItem(sc); auto.nextPoly = now + 5000; } else {
        const [name, price] = POLY_KINDS[pk];
        if (adena() < price) {
          if (!poorWarned.has(pk)) { poorWarned.add(pk); log(`背包沒有${name},金幣不足 ${fmt(price)},自動變身先暫停。`, 'sys'); }
        } else { poorWarned.delete(pk); send({ t: 'paidarrow', item: pk, count: 1 }); }
        auto.nextPoly = now + 2000;
      }
    }
    // 自動磨刀石:揮舞中的武器有損傷就用背包的磨刀石;沒有就付費買一個進背包,下一輪再用
    if (settings.whet && st.paidBuy?.has(WHET_KIND) && now > auto.nextWhet) {
      const w = [...st.inv.values()].find((it) => /\(揮舞\)/.test(it.name) && it.wdmg > 0);
      if (w) {
        const ws = potionInBag(WHET_KIND);
        if (ws) { send({ t: 'useitem', id: ws.id, target: w.id }); auto.nextWhet = now + 1000; } else {
          const [name, price] = ALL_POTIONS[WHET_KIND];
          if (adena() < price) {
            if (!poorWarned.has(WHET_KIND)) { poorWarned.add(WHET_KIND); log(`背包沒有${name},金幣不足 ${fmt(price)},自動磨刀石先暫停。`, 'sys'); }
          } else { poorWarned.delete(WHET_KIND); send({ t: 'paidarrow', item: WHET_KIND, count: 1 }); }
          auto.nextWhet = now + 2000;
        }
      }
    }
    // 自動 Buff:效果消失時先喝背包的,沒有就付費喝(勇敢藥水只有騎士能喝)
    const drink = (kind) => {
      const p = potionInBag(kind);
      if (p) useItem(p);
      else payPotion(kind);
      auto.nextBuff = now + 3000;
    };
    if (!srvActive() && now > auto.nextBuff && settings.haste && me.speed !== 1 && !castWithin(54, 15)) drink(settings.hasteKind === 40018 && !potionInBag(40018) ? 40013 : settings.hasteKind);
    // 自動技能補血:HP 低於設定值就對自己放(施法動作中會排隊,播完才放)
    const hs = settings.healSkill;
    const hsk = st.game.skills?.[hs.id];
    const priorityPet = srvSup.petHealPriority && petFirst();
    if (!priorityPet && !(srvActive() && scrollKindForSkill(hs.id)) && hs.on && hsk && hpPct < hs.hp && selfHealReady(hs.id) && now > auto.nextHeal) {
      castSkill(hs.id, true, { priority: 2 });
    }
    const healFirst = hs.on && hsk && hpPct < hs.hp && selfHealReady(hs.id);
    // 寵物 / 召喚獸自動補血:自己的寵物血量(伺服器送的百分比)低於設定值,就對牠放補血魔法
    const ph = settings.petHeal;
    // Queue during attacks and cast locks; step casts before the next attack.
    if (ph.on && st.game.skills?.[ph.id] && st.skills.has(ph.id) && m.mp >= skillMp(ph.id) && now > auto.nextHeal && (srvSup.petHealPriority ? priorityPet : !healFirst)) {
      let low = null; // 血量最低的那隻先補
      for (const o of st.objects.values()) {
        if (!isMyPet(o) || o.dead || o.dying || !(o.hpRatio >= 0) || o.hpRatio >= ph.hp) continue;
        if (Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) > 10 || !clearLine(me.x, me.y, o.x, o.y)) continue;
        if (!low || o.hpRatio < low.hpRatio) low = o;
      }
      if (low) {
        castSkill(ph.id, false, { priority: 1, petId: low.id });
      }
    }
    // 自動洗 MP:MP 低於設定、扣完血後 HP 還在設定以上,就放心靈轉換(HP 8 → MP 2)/ 魂體轉換(HP 50 → MP 15)
    const mw = settings.mpWash;
    const mwSk = mw?.on && MP_WASH_SKILLS.includes(mw.id) && st.skills.has(mw.id) ? st.game.skills?.[mw.id] : null;
    // 自動技能補血優先:補血開著、血量已經低於補血的設定,而且魔力夠放補血,就先不洗,讓補血先放
    // 魔力不夠放補血時要先洗(以前這裡不看魔力:補血放不出來、洗 MP 又被擋,兩邊卡住;10/17 使用者發現)
    // 攻擊動作中不擋:連續普攻時動作幾乎沒有空檔,擋了打怪時就洗不到;castSkill 會排隊,這一下打完、下一下之前放(跟自動補血一樣);已經有排著的魔法(補血、輔助…)就不排,不蓋掉別人
    if (mwSk && !healFirst && !(srvSup.petHealPriority && healPet()) && !st.pendingCast && m.maxMp && (100 * m.mp) / m.maxMp < mw.mp && (100 * (m.hp - (mwSk.hp || 0))) / m.maxHp >= mw.hp && m.hp > (mwSk.hp || 0) && now > (auto.nextWash || 0)) {
      castSkill(mw.id, true, null, false, true);
      auto.nextWash = now + (mw.id === 146 ? 1300 : 600);
    }
    // 自動購買銀箭:裝備弓、銀箭少於設定數量就買一批(扣金幣直接進背包)
    if (settings.arrows.on && now > auto.nextArrow && weaponRange() === -1) {
      let n = 0;
      for (const it of st.inv.values()) if (ARROW_NAMES.has(baseName(it))) n += it.count;
      auto.nextArrow = now + 5000; // 10/29:箭夠時也 5 秒才再掃一次背包(原本只在要買時才設,箭夠時每 300 ms 掃一次)
      if (n < settings.arrows.below) {
        if (adena() < arrowCost()) {
          if (!poorWarned.has(arrowKind())) { poorWarned.add(arrowKind()); log(`自動購買箭矢:買 ${ARROW_BUY} 支${ARROW_KINDS[arrowKind()][0]}要 ${fmt(arrowCost())} 金幣,金幣不足先暫停(設定 → 自動戰鬥可以關掉)。`, 'sys'); }
        } else { poorWarned.delete(arrowKind()); send({ t: 'paidarrow', item: arrowKind(), count: ARROW_BUY }); }
        auto.nextArrow = now + 5000;
      }
    }
    autoBraveSupply(now, me, drink);
    if (!srvActive() && now > auto.nextBuff && settings.blue && !st.buffs.has('blue')) drink(BLUE_KIND);
    if (!srvActive() && now > auto.nextBuff && settings.wis && st.myType === 3 && !st.buffs.has('wis')) drink(WIS_KIND);
  }

  // 走過去的路上(目前目標還打不到)/ 找下一隻:照「實際要走幾步才打得到」比(autoCosts,2026-10-15)
  //  以前用直線距離比:地監裡牆後的怪直線近、繞路遠,兩隻輪流搶目標 → 人物原地折返
  //  1. 走不到(附近方塊內沒有路)或走過去途中會離開畫面的怪不選
  //  2. 換目標要明顯比較近(少 max(3, 1/3) 步)
  //  3. 打自己的怪算近 3 步(不再是無條件優先;走不到的照樣不選)
  let costs = null;
  const costCands = () => { if (!costs) { const c = autoCandidates(me); costs = { c, m: autoCosts(me, c, st.target && st.objects.get(st.target.id)) }; } return costs; };
  if (auto.on && st.target?.mode === 'attack' && !st.target.castOnce) {
    const cur = st.objects.get(st.target.id);
    // 目標剛死 / 被移出畫面:這一輪就接著找下一隻(不用等 step() 清掉再等 0.3 秒)
    if (!cur && st.target.goal && st.path.length && now < st.target.goalUntil) { /* 擴大搜尋:怪暫時出畫面,照記住的路走到攻擊位置 */ }
    else if (!cur || cur.dead || cur.dying || cur.id === st.selfId) { st.target = null; st.path = []; }
    // 自己點的怪 / PvP 鎖定的人(沒有 auto 標記):不換、不放掉,交給 step() 原本「連續走不到 3 次才放棄」的規則
    else if (!st.target.auto) { /* 玩家自己選的目標 */ }
    else if (!autoPatrolTarget(me, cur)) { st.target = null; st.path = []; auto.costMiss = null; }
    else if (autoCanHit(me, cur) || autoCanHitAt(me, cur, autoReach(cur))) auto.costMiss = null; // 打得到了:「走不到」的次數歸零
    else {
      const { c } = costCands();
      if (!c.includes(cur)) { c.push(cur); costs = { c, m: autoCosts(me, c, cur) }; }
      let k = costs.m.get(cur.id);
      if (k == null && st.target.wide && AUTO_WIDE_SEARCH) k = autoCosts(me, [cur], cur, true).get(cur.id); // 擴大搜尋選到的目標:追擊途中也用同樣的範圍判斷,不然下一輪就被當走不到放掉
      if (k == null) {
        // 目前的目標走不到了(跑到牆後 / 太遠):連續 2 次(0.6 秒)才放掉,8 秒內不選
        if (auto.costMiss?.id !== cur.id) auto.costMiss = { id: cur.id, n: 0 };
        if (++auto.costMiss.n >= 2) { auto.unreach.set(cur.id, now + 8000); st.target = null; st.path = []; auto.costMiss = null; costs = null; }
      } else {
        auto.costMiss = null;
        // 已經出過手(開怪)的怪:不換目標,走過去打到死再開下一隻
        // 近戰:目標還在 3 格內(被擊退 / 退一步 / 寵物擋住)就繼續追,不換去貼著自己的別隻(不然怪沒打死就走掉,白白挨打還拖一串)
        const sticky = weaponRange() === 1 && Math.max(Math.abs(cur.x - me.x), Math.abs(cur.y - me.y)) <= 3;
        const best = (st.opened.has(cur.id) || sticky) ? null : autoCheapest(me, costs.c, costs.m, cur);
        const curScore = k - (autoChasing(me, cur) ? 3 : 0);
        // 別隻現在站的位置就打得到(0 步):直接換(馬上開打,不會來回換);否則要少走 max(3, 1/3) 步以上才換
        if (best && best.s + (best.d === 0 ? 0 : Math.max(3, Math.ceil(k / 3))) <= curScore) autoSetTarget(best.o, now);
      }
    }
  }
  if (auto.on && st.target) auto.lastMobAt = performance.now();
  if (!auto.on || st.target || (st.path.length && !auto.wander && !auto.homing)) return; // 隨機走 / 走回巡邏中心的路上看到(走得到的)怪就改去打
  if (!st.path.length) { auto.wander = false; auto.homing = false; }
  const range = settings.patrol.range;
  const { c: cands, m: cmap } = costCands();
  let best = cands.length ? autoCheapest(me, cands, cmap, null) : null;
  let wide = false;
  if (!best && cands.length && AUTO_WIDE_SEARCH && now > (auto.nextWide || 0)) { // 附近有怪但 16 格內都算不到路:探索前先擴大找一次(60 步上限、巡邏圈內)
    auto.nextWide = now + AUTO_WIDE_EVERY;
    best = autoCheapest(me, cands, autoCosts(me, cands, null, true), null);
    wide = !!best;
  }
  if (best) {
    autoSetTarget(best.o, now); auto.lastMobAt = performance.now();
    if (wide) { // 擴大搜尋選到的:先把整條路算好、記住攻擊位置;途中怪被伺服器移出畫面(曼哈頓 > 18)也照走,走到再看牠在不在
      st.target.wide = true;
      const r = autoReach(best.o);
      const p = findPath(me.x, me.y, best.o.x, best.o.y, r > 1 ? r : true, autoPatrolBounds());
      if (p && p.length) { st.path = p; st.target.goal = p[p.length - 1]; st.target.goalUntil = now + p.length * 700 + 3000; st.target.lastX = best.o.x; st.target.lastY = best.o.y; }
    }
  }
  else if (idleTeleport()) { /* 沒怪瞬移:用了卷軸(或剛買一張) */ }
  else if (st.path.length) { /* 還在隨機走 */ }
  else if (range && auto.anchor && Math.max(Math.abs(me.x - auto.anchor.x), Math.abs(me.y - auto.anchor.y)) > range) {
    st.path = findPath(me.x, me.y, auto.anchor.x, auto.anchor.y, true, autoPatrolBounds()) || [];
    auto.homing = st.path.length > 0;
  } else if (performance.now() > auto.nextExplore) {
    // 附近沒有怪:去別的地方找(autoExplore);有巡邏範圍就只在範圍內找。找不到路就隔 1.5 秒再算(整張地圖 BFS 不要每 0.3 秒跑)
    const p = autoExplore(me, range && auto.anchor ? auto.anchor : null, range);
    if (p && p.length) { st.path = p; auto.wander = true; } else auto.nextExplore = performance.now() + 1500;
  }
}, 300, 'autoMain');

// 沒怪瞬移(使用者 10/16):AUTO 時 settings.idleTp.sec 秒(3~10)附近都沒有怪,就用一般 / 象牙塔的瞬間移動卷軸(祝福的留給記憶點);
// 背包沒有就付費買一張一般的(伺服器 PaidArrowItemIds 有列 40100 才買),下一輪再用。跟定點巡邏擇一(有巡邏範圍就不瞬移)
// 離線掛機照同樣的規則(L1OfflineHunt.idleTeleport)
const TP_KIND = 40100;
const TP_PRICE = 70; // 伺服器 altsettings PaidPotionPrices 40100:70
const ORB_ID = 40319, ORB_PRICE = 350; // 精靈玉(淨化精神用):伺服器 PaidArrowItemIds / PaidPotionPrices 40319:350
// 瞬移優先用「指定傳送」技能(skill 5,MP 10):設定開(預設)、學會、MP 夠、麻痺鎖沒有、不在施法動作 / 魔法冷卻中 → 放技能(不帶記憶點 = 同圖隨機傳送);
// 任何一項不符回 false,呼叫端馬上走原本的卷軸 / 付費買流程(逃跑不等)
// 回 'ok'(可以放)/ 'busy'(暫時忙:正在走路、施法動作中、冷卻中,等一下就能放)/ 'no'(不用技能:設定關、沒學會、MP 不夠、麻痺、剛失敗)
function tpSkillState() {
  if (!settings.tpSkill || !st.skills.has(5)) return 'no';
  const sk = st.game.skills?.[5];
  const me = self();
  const now = performance.now();
  if (!sk || !me || me.dead || !st.me || st.me.mp < skillMp(5)) return 'no';
  // 上一次放了技能 1.2 秒後位置 / 地圖都沒變 = 傳送沒發生(被沉默 / 魔法封印 / 這張地圖不能傳送):30 秒內不再用技能,馬上改用卷軸(卷軸沉默時也能用)
  const c = auto.tpCast;
  if (c && now - c.t >= 1200) {
    auto.tpCast = null;
    if (me.x === c.x && me.y === c.y && st.mapId === c.map) auto.tpSkillFailUntil = now + 30000;
  }
  if (now < (auto.tpSkillFailUntil || 0)) return 'no';
  if (st.para && paraState() === 'full') return 'no';
  if (me.anim || (me.lunge && now < me.lunge + (me.lungeMs || 0)) || now < (st.castLockUntil || 0)) return 'busy';
  if (lastCast[5] != null && now - lastCast[5] < (sk.delay || 0) + 150) return 'busy'; // 技能冷卻中
  return 'ok';
}
const tpSkillReady = () => tpSkillState() === 'ok'; // 低血逃跑:忙也當作不能用,馬上改卷軸(不等)
function tpSkillCast() { // 放技能並記下當時的位置 / 地圖,之後 tpSkillReady 用來判斷有沒有傳成功
  const me = self();
  castSkill(5);
  auto.tpCast = { t: performance.now(), x: me.x, y: me.y, map: st.mapId };
}
const tpSkillGap = () => Math.max(1500, (st.game.skills?.[5]?.delay || 0) + 400); // 放完技能後下一次瞬移最少隔多久(等傳送完成、冷卻過)
// 買瞬移卷軸後伺服器回「背包已滿 / 太重」(app.js 記在 st.bagFullAt):退避 5 → 15 → 60 秒,換地圖或背包有卷軸就重置;只提示一次
const TP_BACKOFF = [5000, 15000, 60000];
function tpBagFull(now) {
  const bf = auto.tpBag || (auto.tpBag = { n: 0, seen: 0, map: null, warned: false });
  if (bf.map !== st.mapId) { bf.map = st.mapId; bf.n = 0; bf.warned = false; }
  if (auto.tpBuyAt && st.bagFullAt && st.bagFullAt > bf.seen && st.bagFullAt - auto.tpBuyAt <= 2000 && st.bagFullAt >= auto.tpBuyAt) {
    bf.seen = st.bagFullAt;
    const wait = TP_BACKOFF[Math.min(bf.n, TP_BACKOFF.length - 1)];
    bf.n++;
    auto.nextEscape = now + wait;
    if (!bf.warned) { bf.warned = true; log('血量低逃跑:背包已滿,買不了瞬間移動卷軸,先稍後再試(請清出空位)。', 'sys'); }
    return true;
  }
  return false;
}
function idleTeleport() {
  const t = performance.now();
  const cfg = settings.idleTp;
  if (!cfg?.on || settings.patrol.range || t < auto.nextEscape) return false;
  if (t - (auto.lastMobAt || 0) < Math.min(10, Math.max(3, cfg.sec || 5)) * 1000) return false;
  const tps = tpSkillState();
  if (tps === 'busy') { // 暫時忙(正在走路 / 施法動作 / 冷卻):停下目前的路,等下一個 tick 再放技能,不要馬上去買 / 用卷軸;最多等 3 秒,還是忙就交給技能施法佇列
    if (!auto.tpBusySince) auto.tpBusySince = t;
    if (t - auto.tpBusySince < 3000) { st.path = []; auto.wander = false; auto.homing = false; return true; }
  } else auto.tpBusySince = 0;
  if (tps === 'ok' || tps === 'busy') { // 學會指定傳送且 MP 夠:放技能(沒學會 / MP 不夠 / 設定關 / 剛失敗就往下用卷軸)
    auto.tpBusySince = 0;
    st.path = []; auto.wander = false; auto.homing = false;
    if (typeof tpTag === 'function') tpTag('auto-nomob'); // 11/17 tpsource
    tpSkillCast();
    auto.lastMobAt = t; auto.nextEscape = t + tpSkillGap();
    return true;
  }
  const scroll = [...st.inv.values()].find((it) => ['瞬間移動卷軸', '象牙塔瞬間移動卷軸'].includes(baseName(it)) && !isBlessed(it));
  if (scroll) {
    st.path = []; auto.wander = false; auto.homing = false;
    if (auto.tpBag) { auto.tpBag.n = 0; auto.tpBag.warned = false; }
    if (typeof tpTag === 'function') tpTag('auto-nomob'); // 11/17 tpsource
    send({ t: 'useitem', id: scroll.id });
    auto.lastMobAt = t; auto.nextEscape = t + 3000;
    return true;
  }
  if (!st.paidBuy?.has(TP_KIND)) return false;
  if (adena() < TP_PRICE) {
    if (!poorWarned.has(TP_KIND)) { poorWarned.add(TP_KIND); log(`沒怪瞬移:背包沒有瞬間移動卷軸,金幣不足 ${fmt(TP_PRICE)},先改成走路找怪。`, 'sys'); }
    auto.nextEscape = t + 5000;
    return false;
  }
  if (tpBagFull(t)) return false;
  poorWarned.delete(TP_KIND);
  send({ t: 'paidarrow', item: TP_KIND, count: 1 }); auto.tpBuyAt = t;
  auto.nextEscape = t + 1500; // 買進背包後下一輪再用
  return true;
}

// ---- AUTO 附近沒怪時去哪裡找(2026-10-12 改,原本只在自己周圍 12 格隨機走,地監裡會在空走廊來回走)----
// 1. 這張地圖有刷怪點(gateway /api/dex/spawnpts:伺服器 spawnlist 每 8×8 格併成一點):
//    走去走得到、最近、EXPLORE_REVISIT_MS 內沒去過的刷怪點(走到 8 格內算去過)
// 2. 沒有刷怪點(個人獵場副本等)或都去過了:走去 EXPLORE_MIN 步以外、最久沒去過的區塊(8×8 格;走過的位置周圍 3×3 區塊算去過)
// 距離和路徑用整張地圖的 BFS(最多 EXPLORE_BFS 格,不踩傳點、繞過有人 / 怪站的格子),遠的點也走得到(findPath 只搜 4000 步)
const EXPLORE_REVISIT_MS = 120000;
const EXPLORE_BFS = 40000;
const EXPLORE_MIN = 12;
const AUTO_EXPLORE_PETS = true; // 與 occupied / findPath 相同:隱藏寵物不佔格
const AUTO_EXPLORE_BOUND = true; // 巡邏探索的整條路都留在範圍內,不只限制終點
auto.nextExplore = 0;
auto.pts = { map: -1, list: [], seen: new Map() };
auto.cells = { map: -1, seen: new Map() };
function loadSpawnPts() {
  const map = st.mapId;
  if (auto.pts.map === map) return;
  auto.pts = { map, list: [], seen: new Map() };
  fetch(`/api/dex/spawnpts?map=${map}`).then((r) => r.json()).then((j) => { if (auto.pts.map === map) auto.pts.list = j.pts || []; }).catch(() => {});
}
function autoExplore(me, center, range) {
  loadSpawnPts();
  const inRange = (x, y) => !center || Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) <= range;
  const W = 65536;
  const key = (x, y) => x * W + y;
  const start = key(me.x, me.y);
  const prev = new Map([[start, -1]]);
  const dist = new Map([[start, 0]]);
  const q = [start];
  const portals = portalSet();
  const occ = new Set(); // 有人站的格子(同 findPath):不繞開的話第一步被擋就會一直重算同一條路、站著不動
  for (const o of st.objects.values()) {
    if (o.kind === 'door' && o.status !== 29) continue;
    if (AUTO_EXPLORE_PETS && isHiddenPet(o)) continue;
    if (o.id !== st.selfId && o.kind !== 'item' && !o.dead && !(o.kind === 'pc' && passThroughPc())) occ.add(key(o.x, o.y));
  }
  for (let i = 0; i < q.length && q.length < EXPLORE_BFS; i++) {
    const k = q[i];
    const x = Math.floor(k / W);
    const y = k % W;
    for (let h = 0; h < 8; h++) {
      if (AUTO_EXPLORE_BOUND && center && !inRange(x + DX[h], y + DY[h])) continue;
      const nk = key(x + DX[h], y + DY[h]);
      if (dist.has(nk) || portals.has(nk) || occ.has(nk) || !passable(x, y, h)) continue;
      dist.set(nk, dist.get(k) + 1);
      prev.set(nk, k);
      q.push(nk);
    }
  }
  const pathTo = (k) => { const out = []; for (; prev.get(k) !== -1; k = prev.get(k)) out.unshift({ x: Math.floor(k / W), y: k % W }); return out; };
  const now = performance.now();
  // 1. 刷怪點(點本身可能在牆上:取周圍 3 格內走得到、最近的格子)
  let best = null;
  auto.pts.list.forEach(([x, y], i) => {
    if (now - (auto.pts.seen.get(i) ?? -Infinity) < EXPLORE_REVISIT_MS || !inRange(x, y)) return;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (AUTO_EXPLORE_BOUND && center && !inRange(x + dx, y + dy)) continue;
        const d = dist.get(key(x + dx, y + dy));
        if (d != null && d >= 3 && (!best || d < best.d)) best = { k: key(x + dx, y + dy), d };
      }
    }
  });
  if (best) return pathTo(best.k);
  // 2. 最久沒去過的區塊(一樣久就挑近的)
  const cellSeen = auto.cells.map === st.mapId ? auto.cells.seen : new Map();
  for (const [k, d] of dist) {
    if (d < (center ? Math.min(EXPLORE_MIN, Math.max(3, Math.ceil(range / 2))) : EXPLORE_MIN)) continue; // 巡邏範圍小於 ~12 格時,最小步數跟著縮(否則範圍內沒有 12 步以外的格子 → 站著不動)
    const x = Math.floor(k / W);
    const y = k % W;
    if (!inRange(x, y)) continue;
    const t = cellSeen.get(key(x >> 3, y >> 3)) ?? -Infinity;
    if (!best || t < best.t || (t === best.t && d < best.d)) best = { k, d, t };
  }
  return best ? pathTo(best.k) : null;
}
// 最近走過的位置(每 2 秒記一次,留 30 個):隨機找怪時往沒去過的地方走
auto.trail = [];
auto.unreach = new Map(); // 走不到的怪 -> 跳過到什麼時候
tickEvery(() => { // 背景分頁也照跑(app.js runTick)
  if (typeof unifiedPassive === 'function' && unifiedPassive()) return;
  const me = self();
  if (!auto.on || !me) { auto.trail.length = 0; return; }
  auto.trail.push({ x: me.x, y: me.y });
  if (auto.trail.length > 30) auto.trail.shift();
  const now = performance.now();
  // 找怪用:記下去過的區塊(自己周圍 3×3 個 8×8 區塊)和刷怪點(8 格內),換地圖就重來
  if (auto.cells.map !== st.mapId) auto.cells = { map: st.mapId, seen: new Map() };
  for (let cx = -1; cx <= 1; cx++) for (let cy = -1; cy <= 1; cy++) auto.cells.seen.set(((me.x >> 3) + cx) * 65536 + (me.y >> 3) + cy, now);
  if (auto.pts.map === st.mapId) auto.pts.list.forEach(([x, y], i) => { if (Math.max(Math.abs(x - me.x), Math.abs(y - me.y)) <= 8) auto.pts.seen.set(i, now); });
  for (const [id, until] of auto.unreach) if (until < now) auto.unreach.delete(id);
  for (const [id, at] of auto.hitBy) if (now - at > 8000) auto.hitBy.delete(id);
}, 2000);
// AUTO 找怪:有巡邏範圍時只找範圍內(以按下 AUTO 的位置為中心),否則自己周圍 15 格;回傳離自己最近的 { o, d, id }
function autoNearest(me) {
  let best = null;
  for (const o of autoCandidates(me)) {
    const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
    const c = autoChasing(me, o); // 打自己的怪優先(不然走去別的地方,後面拖一串)
    if (!best || (c && !best.c) || (c === best.c && d < best.d)) best = { o, d, id: o.id, c };
  }
  return best;
}
// 這隻怪 8 秒內打過自己,而且在 15 格內:成本優先,但新巡邏規則不讓反擊越界追人。
function autoChasing(me, o) {
  return performance.now() - (auto.hitBy.get(o.id) ?? -Infinity) < 8000 && Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) <= 15;
}
// 巡邏限制人物走路,不限制怪物站位。關閉即恢復舊的選怪／追擊邊界規則。
const AUTO_PATROL_WALK_BOUND = true;
function autoPatrolBounds() {
  const a = auto.anchor, r = settings.patrol.range;
  return AUTO_PATROL_WALK_BOUND && auto.on && a && r > 0 ? { x: a.x, y: a.y, range: r } : null;
}
function autoPatrolDistance(b, x, y) {
  return Math.max(Math.abs(x - b.x), Math.abs(y - b.y));
}
function autoPatrolStep(b, x, y, nx, ny) {
  // 被擊退／手動走出圈後只准同距離或靠近中心;一旦回圈就不再走出去。
  return !b || autoPatrolDistance(b, nx, ny) <= Math.max(b.range, autoPatrolDistance(b, x, y));
}
function autoPatrolTarget(me, o, b = autoPatrolBounds()) {
  if (!b) return true;
  // 圈外復歸途中只原地反擊,不讓新目標／已開怪拖住回程或把人拉遠。
  if (autoPatrolDistance(b, me.x, me.y) > b.range) return autoChasing(me, o) && autoCanHitAt(me, o, autoReach(o));
  return autoPatrolDistance(b, o.x, o.y) <= b.range + autoReach(o);
}
function openNeighbor(x, y) { for (let h = 0; h < 8; h++) if (!isClosedArea(x + DX[h], y + DY[h])) return true; return false; }
// AUTO 可以打的怪:狀態合法,新巡邏允許圈內走到射程內的圈外怪;無巡邏照舊。
function autoCandidates(me) {
  const range = settings.patrol.range;
  const center = range && auto.anchor ? auto.anchor : me;
  const limit = range || 15;
  const now = performance.now();
  const bounds = autoPatrolBounds();
  const out = [];
  for (const o of st.objects.values()) {
    if (o.kind !== 'monster' || o.dead || o.dying) continue;
    if (o.id === st.selfId || o.pcFlag) continue; // 自己 / 玩家封包(pcFlag,10/23 起 gateway 解出)不是怪:角色名和怪物同名時被標成怪(10/22 安塔瑞斯)
    if (o.buried) continue; // 鑽在土裡的怪打不到(要有人走到 2 格內才出來)
    if ((auto.unreach.get(o.id) || 0) > now) continue; // 剛才走不到的怪先跳過
    if (isClosedArea(o.x, o.y) && !openNeighbor(o.x, o.y)) continue; // 未開放區域裡的怪:走不進去(伺服器會一直把人拉回來);10/30:怪站在遮罩邊緣、旁邊就有開放格可站的照打(成本 BFS 只走開放格)
    const oc = Math.max(Math.abs(o.x - center.x), Math.abs(o.y - center.y));
    // 走回中心的途中:離自己 ≤ 3 格、而且不比自己離中心更遠(只打前方 / 旁邊,不打背後,不會越打越遠)的怪也打
    const onWay = auto.homing && range && auto.anchor && Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) <= 3 && oc <= Math.max(Math.abs(me.x - center.x), Math.abs(me.y - center.y));
    if (bounds ? !autoPatrolTarget(me, o, bounds) : oc > limit && !onWay && !autoChasing(me, o)) continue;
    out.push(o);
  }
  return out;
}
// 現在站的位置就打得到這隻嗎(照這隻會用的魔法 / 武器射程;2 格以上中間不能有牆,同伺服器 glanceCheck)
function autoCanHit(me, o) {
  const spell = autoSpellFor(o.id);
  const r = weaponRange();
  const reach = spell ? skillReach(spell) : r === -1 ? RANGED_REACH : r;
  const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
  return d <= reach && (reach <= 1 || clearLine(me.x, me.y, o.x, o.y));
}
function autoCanHitAt(me, o, reach) {
  const d = Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y));
  return d <= reach && (reach <= 1 || clearLine(me.x, me.y, o.x, o.y));
}
// AUTO 選怪用的射程:同 autoCanHit,但不管 AUTO_SPELL_GAP(兩次魔法之間射程會暫時變 1,選怪成本會跟著跳)
function autoReach(o) {
  const spell = autoSpellFor(o.id) || autoAttackSkill(true);
  const r = weaponRange();
  return spell ? skillReach(spell) : r === -1 ? RANGED_REACH : r;
}
// ---- AUTO 選怪成本:實際要走幾步才打得到(2026-10-15)----
// 以自己為中心 (2R+1)² 方塊做一次 BFS(只看地形,不踩傳點;怪會動,佔格交給 findPath);BFS 佇列本來就照步數排好,
// 每隻怪第一個「打得到牠」的格子就是最近的(近戰:旁邊一格;弓 / 魔法:射程內而且 clearLine 沒擋,同伺服器 glanceCheck)
const AUTO_COST_R = 16;
const AUTO_COST_SIDE = 2 * AUTO_COST_R + 1;
const AUTO_COST_CL = 48; // 遠程:每隻怪最多試 48 個位置的 clearLine,都被擋就當這次走不到
const AUTO_SCREEN = 18; // 伺服器 Point.isInScreen:曼哈頓 <=18 一定在畫面內(19 看斜角,>19 移除)→ 10/30 由 17 改 18(火龍窟實測 8 個 23~39 步可到的怪有 4 個路上最遠剛好 18,被 17 擋掉)
const AUTO_COST_DIRECT = true; // 原地可出手的候選先回傳;其餘保留 16 格 / 48 次上限
const makeCostField = (R) => ({ R, S: 2 * R + 1, dist: new Int16Array((2 * R + 1) ** 2), prev: new Int32Array((2 * R + 1) ** 2), q: new Int32Array((2 * R + 1) ** 2), n: 0, ox: 0, oy: 0 });
const autoField = makeCostField(AUTO_COST_R);
// 擴大搜尋(10/30,使用者「明明走幾步就到還是不去打」):平常 16 格;只在「附近有怪、但一隻都算不到路、要開始探索」時,多做一次 32 格 / 60 步上限的搜尋(每 1.5 秒最多一次)。
// 火龍窟全區掃描:10 格內的怪約 1% 真路 30~60 步但 16 格方塊找不到。巡邏圈限制照樣套用(路每一步都在圈內)
const AUTO_WIDE_SEARCH = true;
const AUTO_WIDE_R = 32, AUTO_WIDE_STEPS = 60, AUTO_WIDE_EVERY = 1500;
const autoFieldWide = makeCostField(AUTO_WIDE_R);
function autoCostField(me, wide = false) {
  const F = wide ? autoFieldWide : autoField;
  const R = F.R, S = F.S, maxSteps = wide ? AUTO_WIDE_STEPS : Infinity;
  const bounds = autoPatrolBounds();
  F.dist.fill(-1);
  F.ox = me.x - R; F.oy = me.y - R;
  const portals = portalSet();
  const doors = closedDoors(); // 關著的門擋路(同 findPath)
  const s0 = R * S + R;
  F.dist[s0] = 0; F.prev[s0] = -1; F.q[0] = s0;
  let tail = 1;
  for (let head = 0; head < tail; head++) {
    const i = F.q[head];
    if (F.dist[i] >= maxSteps) continue;
    const lx = i % S; const ly = (i / S) | 0;
    const x = F.ox + lx; const y = F.oy + ly;
    for (let h = 0; h < 8; h++) {
      const nlx = lx + DX[h]; const nly = ly + DY[h];
      if (nlx < 0 || nly < 0 || nlx >= S || nly >= S) continue;
      const ni = nly * S + nlx;
      if (bounds && !autoPatrolStep(bounds, x, y, x + DX[h], y + DY[h])) continue;
      if (F.dist[ni] >= 0 || portals.has((x + DX[h]) * 65536 + y + DY[h]) || doors.has((x + DX[h]) * 65536 + y + DY[h]) || !passable(x, y, h)) continue;
      F.dist[ni] = F.dist[i] + 1; F.prev[ni] = i; F.q[tail++] = ni;
    }
  }
  F.n = tail;
  return F;
}
// list 裡每隻怪 -> 要走幾步才打得到;走不到 / 會離開畫面的不在回傳的 Map 裡(keep = 目前目標,不做離開畫面檢查)
function autoCosts(me, list, keep, wide = false) {
  const out = new Map();
  if (!list.length) return out; // 沒有候選:不用跑 BFS(探索中每 0.3 秒都會進來)
  const bounds = autoPatrolBounds();
  const outside = bounds && autoPatrolDistance(bounds, me.x, me.y) > bounds.range;
  const left = list.filter((o) => autoPatrolTarget(me, o, bounds)).map((o) => ({ o, r: autoReach(o), n: 0 }));
  if (AUTO_COST_DIRECT) {
    for (let j = left.length - 1; j >= 0; j--) {
      const e = left[j];
      if (Math.max(Math.abs(e.o.x - me.x), Math.abs(e.o.y - me.y)) > e.r) continue;
      if (e.r > 1 && !clearLine(me.x, me.y, e.o.x, e.o.y)) { e.n++; continue; }
      out.set(e.o.id, 0); left.splice(j, 1);
    }
    if (!left.length) return out;
  }
  if (outside) { // 不依賴 AUTO_COST_DIRECT 開關:圈外反擊成本只可能為 0。
    for (const e of left) if (autoCanHitAt(me, e.o, e.r)) out.set(e.o.id, 0);
    return out;
  }
  if (!left.length) return out;
  const F = autoCostField(me, wide);
  const S = F.S;
  const s0 = F.R * S + F.R;
  for (let k = AUTO_COST_DIRECT ? 1 : 0; k < F.n && left.length; k++) {
    const i = F.q[k];
    const x = F.ox + (i % S); const y = F.oy + ((i / S) | 0);
    for (let j = left.length - 1; j >= 0; j--) {
      const e = left[j]; const o = e.o;
      if (Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) > e.r) continue;
      if (e.r > 1 && !clearLine(x, y, o.x, o.y)) { if (++e.n >= AUTO_COST_CL) left.splice(j, 1); continue; }
      left.splice(j, 1);
      // 走過去的路上(不含現在站的格子)離怪比「現在」更遠、而且超過 AUTO_SCREEN:保守避開可能移出畫面的路
      // (只看現在的距離會把畫面邊緣、直直走過去就打得到的怪也排除掉:野外弓 / 魔法會少打)
      let off = false;
      if (o !== keep && F.dist[i] > 0 && !wide) { // 擴大搜尋(wide):允許繞路時怪暫時出畫面,走到記住的位置再重新鎖定(st.target.goal)
        const lim = Math.max(AUTO_SCREEN, Math.abs(me.x - o.x) + Math.abs(me.y - o.y));
        for (let p = i; p !== s0 && !off; p = F.prev[p]) off = Math.abs(F.ox + (p % S) - o.x) + Math.abs(F.oy + ((p / S) | 0) - o.y) > lim;
      }
      if (!off) out.set(o.id, F.dist[i]);
    }
  }
  return out;
}
// 成本最低的(打自己的怪算近 3 步;一樣就挑直線近的)
function autoCheapest(me, list, costs, skip) {
  let best = null;
  for (const o of list) {
    if (o === skip) continue;
    const d = costs.get(o.id);
    if (d == null) continue;
    const s = d - (autoChasing(me, o) ? 3 : 0) + Math.max(Math.abs(o.x - me.x), Math.abs(o.y - me.y)) * 0.01;
    if (!best || s < best.s) best = { o, s, d };
  }
  return best;
}
function autoSetTarget(o, now) {
  st.target = { id: o.id, mode: 'attack', auto: true }; st.path = []; // auto:AUTO 自己挑的(只有這種會被換掉 / 放掉)
  auto.wander = false; auto.homing = false;
  auto.costMiss = null;
}

// ---------------- 狀態列(頭像下方)----------------
// key -> { label, until(ms;Infinity = 沒有時限,例如中毒) }
st.buffs = new Map();
// 圖示對照 Flare icons:藥水類用藥水圖,魔法類用技能圖
const BUFF_ICON = {
  haste: 80, brave: 82, blue: 65, shield: 4, str: 31, dex: 13, eva: 25, poly: 29, poison: 27, sk20052: 4,
};
// gamedex 圖示:先找狀態名稱本身(保護罩、勇敢藥水…),找不到用這裡的預設名稱
const BUFF_GDX = {
  haste: '自我加速藥水', brave: '勇敢藥水', blue: '藍色藥水', wis: '慎重藥水', shield: '保護罩', str: '體魄強健術', dex: '通暢氣脈術',
  poly: '變形卷軸', poison: '毒咒',
};
// 狀態圖示用「同樣效果的魔法圖示」(原版狀態列就是魔法圖示),不要用藥水 / 道具本身的圖
const BUFF_SKILL_ICON = {
  加速: '加速術', 緩速術: '緩速術', 勇敢藥水: '勇敢靈氣', 勇敢: '勇敢靈氣', 精靈餅乾: '風之疾走', 神聖疾走: '神聖疾走',
  超級加速: '強力加速術', 血之渴望: '狂暴術', 藍色藥水: '冥想術', 慎重藥水: '淨化精神', 影之防護: '保護罩', 防禦提升: '保護罩',
  中毒: '毒咒', 麻痺毒: '毒咒', 勇猛意志: '衝擊士氣', 三角色52級: '保護罩',
};
// 原版狀態圖(tools/build_buff_icons.py 從客戶端 .tbt 取出):加速 481、二段加速 486、緩速 480
const BUFF_IMG = { 加速: 'st_481', 勇敢藥水: 'st_486', 勇敢: 'st_486', 精靈餅乾: 'st_486', 緩速術: 'st_480', 藍色藥水: 'st_5399', 慎重藥水: 'st_484g', 變身: 'st_1477', 夏娜的變形卷軸: 'st_1477' }; // 客戶端 .tbt 原版狀態圖(編號)
const buffImgs = {};
function buffImg(name) {
  if (!buffImgs[name]) { const im = new Image(); im.src = `assets/ui182/${name}.webp?v=${window.AV?.ui?.[name] ?? 1}`; buffImgs[name] = im; }
  return buffImgs[name];
}
let buffTip = null; // { key, until }

// seconds:剩餘秒數;0 = 解除;-1 = 沒有時限
// 藥水類 buff 可能的完整時間(秒;伺服器 model/item/action/Potion.java 的各種藥水)
const POTION_DURS = {
  戰鬥強化卷軸: [1800],
  加速: [300, 350, 600, 900, 1200, 1800, 2100], 勇敢藥水: [300, 350, 480, 600, 700, 1200, 1800, 1920], 勇敢: [300, 350, 480, 600, 700, 1200, 1800, 1920],
  精靈餅乾: [300, 350, 480, 600, 700, 1200, 1800, 1920], 藍色藥水: [600, 700, 2400], 慎重藥水: [300, 360, 1000], 變身: [1800], 夏娜的變形卷軸: [1800],
};
// 圖示從上往下變淡要知道「完整時間」:剛放 / 重放時記下來(存在瀏覽器,重登後剩餘時間比較短也接得上)
function isEventHuntCountdown(key) { return key === 'sk10101' || key === 'sk10102'; }
function eventHuntCountdownText(key, ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  const time = seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(minutes % 60).padStart(2, '0')}:${tail}` : `${String(minutes).padStart(2, '0')}:${tail}`;
  return `${key === 'sk10102' ? '活動結束' : '下次扣款'} ${time}`;
}
// 經驗獵場獨立計時框：沿用封包，不加入 buff 狀態。
function clearEventHuntTimer() {
  st.ehTimer = null;
  if (typeof clearCatchup === 'function' && !st.inGame) clearCatchup(); // 不在獵場(沒有倒數)時每秒都會進來:只有離開遊戲才關追趕視窗
  const box = $('#eh-timer');
  if (box) box.hidden = true;
  document.documentElement.classList.remove('eh-timer-active');
  document.documentElement.style.removeProperty('--eh-minimap-shift');
}
function setEventHuntTimer(key, seconds) {
  if (!isEventHuntCountdown(key)) return;
  if (!(seconds > 0)) {
    // 伺服器先清除另一種 ID，不能因此清掉目前仍有效的倒數。
    if (st.ehTimer?.key === key) clearEventHuntTimer();
    return;
  }
  st.ehTimer = { key, until: performance.now() + seconds * 1000 };
  renderEventHuntTimer();
}
function renderEventHuntTimer() {
  const state = st.ehTimer;
  const left = state ? state.until - performance.now() : 0;
  if (!st.inGame || !st.ws || st.ws.readyState !== 1 || left <= 0) {
    clearEventHuntTimer();
    return;
  }
  const plate = $('#map-plate');
  if (!plate) return;
  let box = $('#eh-timer');
  if (!box) {
    const css = el('style');
    css.textContent = `
#eh-timer{position:fixed;z-index:6;display:flex;align-items:center;justify-content:center;gap:4px;padding:2px;border-radius:5px;min-height:24px;
background:linear-gradient(180deg,rgba(40,30,16,.92),rgba(22,18,12,.92));border:1px solid #8a6d3b;color:#e8d6a8;font:11px/18px "Microsoft JhengHei",sans-serif;
box-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:auto;white-space:nowrap;box-sizing:border-box;cursor:pointer}
#eh-timer[hidden]{display:none}
#eh-timer b{color:#ffd56b;font:700 12px/18px monospace;font-variant-numeric:tabular-nums}
#eh-timer.soon{border-color:#d9583b}#eh-timer.soon b{color:#ff8f6b}
html.eh-timer-active #minimap-box,html.eh-timer-active #side-buttons{translate:0 var(--eh-minimap-shift,0px)}
html.land.eh-timer-active #hotbar{top:calc(154px + var(--sat, 0px) + var(--eh-minimap-shift,0px))}
`;
    document.head.appendChild(css);
    box = el('button'); box.id = 'eh-timer'; box.type = 'button';
    box.appendChild(el('span')); box.appendChild(el('b'));
    box.onclick = () => {
      if (!st.ehTimer) return;
      toast(`經驗獵場 · ${eventHuntCountdownText(st.ehTimer.key, st.ehTimer.until - performance.now())}${st.ehTimer.key === 'sk10102' ? '，本付費時段內不會再扣款' : ''}`);
    };
    plate.parentNode.appendChild(box);
  }
  const text = eventHuntCountdownText(state.key, left);
  const split = text.lastIndexOf(' ');
  box.querySelector('span').textContent = text.slice(0, split);
  box.querySelector('b').textContent = text.slice(split + 1);
  box.setAttribute('aria-label', text);
  box.classList.toggle('soon', left <= 300000);
  box.hidden = false;
  // 使用 viewport 座標，避免 offsetParent 和 html.land 的右側定位不同。
  const rect = plate.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  box.style.left = 'auto';
  box.style.right = `max(calc(var(--sar, 0px) + 6px), ${Math.max(0, viewportWidth - rect.right)}px)`;
  box.style.top = `max(var(--sat, 0px), ${rect.bottom + 3}px)`;
  box.style.width = `min(${rect.width}px, calc(100vw - var(--sar, 0px) - var(--sal, 0px) - 12px))`;
  // 追趕加成狀態:疊在倒數框正下方、同寬,小地圖與右側按鈕一起往下讓
  const cu = $('#catchup-status'); let low = box;
  if (cu && !cu.hidden) { cu.style.right = box.style.right; cu.style.width = 'auto'; cu.style.minWidth = box.style.width; cu.style.top = `${box.getBoundingClientRect().bottom + 2}px`; low = cu; }
  const mini = $('#minimap-box'), html = document.documentElement;
  if (mini) {
    // 減去前一次平移再計算，避免每秒累加；一起移動下方按鈕以維持間距。
    const previous = html.classList.contains('eh-timer-active') ? parseFloat(html.style.getPropertyValue('--eh-minimap-shift')) || 0 : 0;
    const m = mini.getBoundingClientRect(), b = low.getBoundingClientRect();
    const overlapsX = b.left < m.right && b.right > m.left;
    const shift = overlapsX ? Math.max(0, b.bottom + 4 - (m.top - previous)) : 0;
    html.style.setProperty('--eh-minimap-shift', `${shift}px`);
    html.classList.add('eh-timer-active');
  }
}
setInterval(renderEventHuntTimer, 1000);
window.addEventListener('resize', renderEventHuntTimer);
window.addEventListener('orientationchange', renderEventHuntTimer);
window.visualViewport?.addEventListener('resize', renderEventHuntTimer);
function setBuff(key, label, seconds) {
  if (isEventHuntCountdown(key)) { setEventHuntTimer(key, seconds); return; }
  if (key === 'sk20106') { label = '殺人榜'; if (seconds) seconds = -1; }
  if (key === 'sk120') { label = '王者加護'; if (seconds) seconds = -1; } // 直到伺服器送解除
  if (key === 'sk20052') { label = '三角色52級'; if (seconds) seconds = -1; } // 帳號被動,直到伺服器送解除
  // 大地的祝福(S_SkillIconShield 種類 7,gateway 給 key 'shield')改放 'earth' 欄:能和保護罩並存、和大地防護互斥(同一欄);解除時 earth 欄已經是別的就不清
  if (key === 'shield' && label === '大地的祝福') {
    key = 'earth';
    if (!seconds && st.buffs.get('earth') && st.buffs.get('earth').label !== '大地的祝福') return;
  }
  if (!seconds) st.buffs.delete(key);
  else {
    const tKey = `buffTotal:${st.myName || st.selChar?.name || '_'}`; // 登入時 buff 比角色名稱先到,先用選的角色
    const totals = store.get(tKey, {});
    const prev = st.buffs.get(key);
    let total = seconds;
    if (seconds > 0 && !prev && totals[key] >= seconds) total = totals[key]; // 登入時補回的 buff:用之前記的完整時間
    else if (seconds > 0 && !prev) { // 沒記過:魔法用本身的效果時間;藥水挑「≥ 剩餘時間」最短的那種(伺服器 Potion.java)
      const sk = Object.values(st.game.skills || {}).find((x) => x.name === label);
      const opts = sk?.dur ? [sk.dur] : POTION_DURS[label];
      const full = opts?.filter((d) => d >= seconds).sort((a, b) => a - b)[0];
      if (full) total = full;
    }
    if (seconds > 0 && total === seconds) { totals[key] = seconds; store.set(tKey, totals); }
    st.buffs.set(key, { label, until: seconds < 0 ? Infinity : performance.now() + seconds * 1000, total: total * 1000 });
  }
  renderBuffs();
}

// 免掉%證:到期時間用伺服器給的 epoch 秒,換算成這個瀏覽器的剩餘毫秒後自己倒數(不靠伺服器重送);who = 哪隻角色的(換角就清)
function setTishaGuard(sec) {
  const ms = sec * 1000 - Date.now();
  if (!(sec > 0) || ms <= 0) st.buffs.delete('tishaguard');
  else st.buffs.set('tishaguard', { label: TISHA_GUARD_NAME, until: performance.now() + ms, total: Math.max(ms, 30 * 86400000), who: st.myName, epoch: sec });
  renderBuffs();
}
function setHighPet(sec, status, pet) {
  const ms = sec * 1000 - Date.now();
  st.highPetUntil = sec > 0 && ms > 0 ? { sec, who: st.myName } : null;
  if (!(sec > 0) || ms <= 0) st.buffs.delete('highpet');
  else st.buffs.set('highpet', { label: '高寵契約', until: performance.now() + ms, total: Math.max(ms, 7 * 86400000), who: st.myName, pet, status });
  renderBuffs();
}
// 全服經驗加倍(gateway /api/expevent,30 秒快取):進遊戲後每分鐘問一次;進行中顯示綠色 XP BUFF,點了看倍率 / 對象 / 結束時間
let expPollAt = 0, expPollWho = null;
async function pollExpEvent() {
  if (!st.inGame) return;
  if (expPollWho === st.myName && Date.now() - expPollAt < 60000) return; // 換角 / 剛進遊戲馬上問,之後每分鐘
  expPollAt = Date.now(); expPollWho = st.myName;
  try {
    const r = await (await fetch('/api/expevent', { cache: 'no-store' })).json();
    if (r.on) st.buffs.set('expevent', { label: '經驗加倍', until: r.end ? performance.now() + (r.end - Date.now()) : Infinity, total: 0, who: st.myName, rate: r.rate, online: r.online, end: r.end });
    else st.buffs.delete('expevent');
    renderBuffs();
  } catch {}
}
setInterval(pollExpEvent, 3000);
function setNoDeathExp(sec) {
  const ms = sec * 1000 - Date.now();
  if (!(sec > 0) || ms <= 0) st.buffs.delete('nodeathexp');
  else st.buffs.set('nodeathexp', { label: NODEATH_NAME, until: performance.now() + ms, total: Math.max(ms, 3 * 86400000), who: st.myName, epoch: sec });
  renderBuffs();
}
function setNoDeathCd(sec) { // 11/05 使用者:冷卻中 BUFF 也要寫冷卻中 + 倒數
  const ms = sec * 1000 - Date.now();
  if (!(sec > 0) || ms <= 0) st.buffs.delete('nodeathcd');
  else st.buffs.set('nodeathcd', { label: '免掉經驗證冷卻', until: performance.now() + ms, total: ms, who: st.myName, cdEpoch: sec });
  renderBuffs();
}
function fmtNoDeath(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}天${h}時` : h ? `${h}時` : `${m}分`;
}
function fmtLeft(ms) {
  if (ms === Infinity) return '持續中';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
}

// 10/29 使用者給的 勇猛意志 技能圖 / buff 圖(96×96 webp)
const VALOR_ICON = 'data:image/webp;base64,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';
let valorIconImg = null;
function valorIconImage() { if (!valorIconImg) { valorIconImg = new Image(); valorIconImg.src = VALOR_ICON; } return valorIconImg; }
// 10/29 使用者給的 王者加護 技能圖 / buff 圖(96×96 webp)
const AEGIS_ICON = 'data:image/webp;base64,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';
let aegisIconImg = null;
function aegisIconImage() { if (!aegisIconImg) { aegisIconImg = new Image(); aegisIconImg.src = AEGIS_ICON; } return aegisIconImg; }
const CUSTOM_SKILL_ICON = { 勇猛意志: valorIconImage, 王者加護: aegisIconImage };
// 用名稱畫技能圖的地方(快捷欄、AUTO 輔助、狀態列、技能面板)都走 GDX.drawNamed:勇猛意志 改畫上面那張圖;圖還沒載好回 false,呼叫端會自己重試
if (typeof GDX !== 'undefined' && !GDX.valorHooked) { // GDX 是 gamedex.js 的頂層 const,不在 window 上
  const drawNamed0 = GDX.drawNamed;
  GDX.drawNamed = (ctx, name, x, y, size) => {
    if (name === '王者之劍' && RoyalFX.enabled()) return RoyalFX.named(ctx,x,y,size);
    if (name === '王者之劍') return drawNamed0(ctx, '究極光裂術', x, y, size);
    if (!CUSTOM_SKILL_ICON[name]) return drawNamed0(ctx, name, x, y, size);
    const im = CUSTOM_SKILL_ICON[name]();
    if (!im.complete || !im.naturalWidth) return false;
    ctx.drawImage(im, x, y, size, size);
    return true;
  };
  GDX.valorHooked = true;
  for (const f of Object.values(CUSTOM_SKILL_ICON)) f().addEventListener('load', () => { try { renderHotbar(); } catch {} }); // 快捷欄第一次畫時圖可能還沒解碼完:載好再畫一次
}
const NODEATH_BUFF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAA6UElEQVR4nO29d3xc1bU/evbpZbpGXbYkW5Yl27LlCsYYUwzEQAiBhBISEkhoCaETSAgQSMFAQkgIJOAbQklILhBaSEINxQ13y7asbsmyujQjTT99v8/aZ2Y0I8nw7vu83/vjfe75yNbMmTPn7L32qt+11hY6qaHc7+I13USI+t8je2BMCTw7HtdZv4v/zpeXeH0uGs7/L5GcA9sUFZmI/9drTayum16f61DXaHdvSBBYClP/fzsQ9T+bFKI0zayeXbBobqGumyyFKJpCPcdCz7xxkBc4isKTXIQmxc55heHr5CVyXqdZDqfPZd7mfCVnmDm//h8wK57+Mm/emLzLDsAZHrYxxhjRyHlLYecjmKNz/eSNMu8xQrpmfPtLDYvnFlGIYp2zAs8JAscJHILrMIVA4FA+dZwTmX/kVs7J3I/Tr+BhKH0in07HpcuMqzzz1blzm5xgeuKTpzCmWIbiOTqZAg2LnbsRGpHDhoHmEjszd0QI4pwnmgc+wnB7+IXhRvCOvHQelH7p/HOuhSXBDiWct+RsevEwIjdzZpI5OXmrzB1yf9L8l/+Tc0HuMe2eztBQ7lMQhW3b9nuExbUB08YgDJkHkxHCJelZZcdDyAP6J/2UHAJlFgvnilXOkRGhHDlKf5DzKvM6w1CTvJV3ffqHRjRDMwzNsOSHQdN/aIZGNA0rishxHI7KeVDmEviNbJsqKhBXNQRVzcqezh8tmVbOTadcRVEZEct8Tmd5LvtIlPOV3PvN+LB8SuXOgUwPURQNvG7b2LKwbTsqAtvpNcsIJk3RiJAFiINomqLp9A2yTJy9M56mJR2NyCBkY1xRLC+ZHzANG9sUommHbdKXOePERD1lJGH6wuYTKP9h1HTqTCNN7n8z8gsFM4TZmhZOpCyMscDRLEMHPHxZkVxSKBX5RZ+HlwRWEGiaRpaNVdWKJ41QRB8eSw2OJIfDqqZbum6ZFuZZmuNpikI2kDbziKw8ZFSkI7K2jStLldJCqcDPa7ol8qxJiEGBAGYom36VdyL3yCEQWaMc9TeFLSavyZ6aRropX6ZgxjSVVC1VNUuC0uJa/4I5vsYFgQVzvJXliiKxYA2cSwlPWZZtwP9pbsIYmyYeGVe7emPNXRNNreM9fbH+0aRlUorM0gxlWw7XoUm+yCwsoijLxjWzvRXFSm2l+9MDY5LAOaSbQqPMC3KXHFM4lUDoOLyDpp7Ins/9ZBodyVg0w7IsvKw+cNoJJYtr/V4Pr2pWaELb1xretm/EsCyGRqLAKBLr8wiFfrHQLwZ8Ascgw7QtEEDEsFRFsVxV5vrC2nLdsDt6onsPj23eM7Jt/0g8Yckiw9AgSo6FynITQpRl4eoyZX612+MXli8MfrxnGCxzWhcRKSQ0coxx1gOYLgTHEbGZ9BWayjgzUSfz3jCwKNBL64KnnlAccItHB+NPv9LR1RsdHEskUoZp2sAmFKYR4jha4GhJYBWZdUlcRYlSV+1dWh9cWl9QWCAJHIMpKpE07CRmWbqm0tNQ67tgfWVzx8SbH/a+vXVwPKKxDOJYelJ3YopjUWhCu+isyrmzPbGIdv7ps//6r27DtGiatu2MRDlrmDt6wlVTaJRHoMxXpqlZlOMxzkCNvPfE+0Bzq1wrGoI8S7+zdaC9OxqeUJOqIQiMwNE+lwhGiqad5xHDi03LjsaskZDe3hv7aNcQg9rcLn7ZgoLTTig9aUlRTaVXFtloQlc1U9MQw6IVDQXLFgS+uqH6+Te6dh4Ym4hqaQcHAXUSKau20vONL9UghFKquWxB8NJz5jzxYmtJgWRQoJtyJ5wva1NplCNiDp/lzBpNk6xpMjeVVAhRHI3KS2S/V/ho51B3X8zx3iSJ9bp5lmVyXdacu9Acw1AC5ck8wrRszbC27h19e0t/SYG4ZlnxOafMOnN1ucfFJVXLtnBKtRCFVi0MLpnnf/T55ude7yI2Dls2jsSM6nLXL25ZVlvpSaQMnqPjSfOWKxYOjCT/+fGALIJL4VxMfL8cGiHHr6M/Q8SIEc4XLpRHnTzSzGD4MWXT1HBYbT8awxiLAugIhqVtm9J0i6Jshnj9uaw5GZ1kfUYYNpIE1iXxBT5J061/fTLw3vbBhXO9V11Ye/bJFbLEJlIGTaOX3+n+7Z+b+0cS8YTFcSzL0i6J/dJp1VdeWDOv0pNIGizjGHDwp395x8oVC3v+/FZX/3ACXEcKscTNmkKjtLs4nUC5Vm66zUKTMzo+dchLm9hpSWAcgVV1W0vo5cXK/CqPbVPHhhKabjPwoWOPMbaB9gwNF9vg8mbGgynDshFFcRxTElRMC7d1x299aOea945+77K6U1aUHumLXX3f5qRqel3C/Crf6qXFy+oDS+oCFSUyTaFE0mQc6pAx2jaosG9dUPOlM2Z3Ho02tYX3Hg61HImMhtX0FVkHMF/z5nrS6bGlp50lBcrKWT51Mg5V+o4Z0wYOMENbNk6kTERRJy8t/OmNS+++dvGyBQU2xsSCY92w4kkzEjMME3McYmgqFjd0w0ZAqfRTwKkkD7JtbJg2RWG3wgd88q6D4e/cs/2+3+11K9y9310qi3zAKxf4JZfMCjwji6wksLmEzo7WsjDH0ZZp94/EQ+Oqc8/JkDvrqaPPMPM5jtDnSxY5cj1JCAwoOqmbNKLKi5Wz1pRuOLl8VqnywfbBZ1/rPNgRjsR1UWCCPqlhnn9pfaC6wlUUEGUJMJa9LaF/fdLf2h1RNVPgGYYBj3Hy3iR+InaPciu8ZdvPvNq1bf/oPdcv3vTAyY88c2j7/tFPm0YwxqWF4tlryq65uL68WE6p4EY4N7AxOJnPvtb+5N9aWo9MaIYlsIwic6LIcSw47ek5TM5qBkdxykfH+cZ05e3ciKZ10zZMY8Fc7/mnzT7/tIryIuWTPUPfvmfrzgOjsYQuCUxjffCLp846c3VZRYnMsTQLI0uzdn2N98vrZ+88OPba+8e27x9JpCxFZtJ+YP7YTAsYrcAnHulLXH3v9mu+Ou+Zn5706HMtH+4akkVmImY8+/qR97YN/uSGpWetKXdoZNlY4JifPbX3V39q5ljK6xIkiWMg8nAwAGqK4c/VklN0EASr+eyD0i+nKaHsdRAoUSieNMtLpK+dO+dLp8+qrPT098XvfHTX8292xpM6jVB9te/ai+vOO21WcVBMqZZtY92wNcPOsi2mKI6lT1tVum5lyZY9wy+82b1137AicqCj8gIB4t1hyjBtRWQxRT3yzOE9zeELzpjd2RsZHFMViXPL/ETMuOtXe4N+afnCQCxu+j388292/uq5ZpfCygIvCGxW55ApZgN5Yh1yQZMpIpYXaswkXCiPicj3GVo3INa88KzZV11YU1fl5Xn6P5v77nl87+5Doy4FLNG5p8y+9VsL51d5UhroHQYcIDAfzq1IyAoPNrGtGxam0NrlxcsWBJ59vWvTyx08x0CIOWlXHKgJ5mATBigpkLfvD3X0Ri3b1nWLoWnTthWZG4/oL/27Z3Gtj2HQ4GjyiRcPMzQli7wk8hAlZ3yMbGyRG559RqgxVXComfyd7AUsg1Ipq6RQvOkbC85dV8GySNPtp19pe2hTUziqBbyiwHHf+UrtjVfUMzSKJAyahq9kGda2YEQ8uNEMw9KWZdsQc8OwLYv93mV1Ak//9s9tksBkZpS1wI55gjemZbtdbCJpa4aZxjlJnCFL7MGO8WODyQW1/lfe6W7tnvAqgiQAS+ZEXdNoM5U+U+GOdNSX9QnRcagD2hiheMJcu6L47msWz5nlNk07ljB++vv9f/x7myAwQb/IMty1l8y/6fJ61bBM054kDYbFZ2ikSCyiqfaeaFv3RP9IcngslVItSWKDPuHcdbPKCuUrL6gZGEm9/M5RRWJNywkEcsbjSBsx4cAdApdlDDDqDOrpjw+NpebN8W7bP5LSrMIAB8Qh/kRO0JB1WCd96lwTmKOD8gL1aZyEJt+Cc0VRyZT1tfPm3PatBWT0diSm3fzQjjc+OOp1825FoBB9wRmzv/+1OlWDmU1aExsWUJHY8Yj21sfH/vFR757msaGxZDxpOhioA6W9/p+jv/vR6rmzPDdcXne4c6KtJ8aztJ0NLycXPz3D9Lwm4XBYWlWzjw0lBocSBzvCksj5PILIMSMhlWGBDXIuzqPVFD9opmB1mpyhnBcIomeQjtuvXHjVRfN03aIQGgunrv3J1k92D/q9glsWWZapLFNuuWJBNiJ1vmsSa2JY9t/f63nyry07Doyall1erDTMK5hV4gp4RYqionFjYDR5uDPykycP/PZHK4sKpOsunX/jz3cgnkEEV8uOJzupdISQeZUJrBDLUv0jqdFx9Wh/3KNw8YR5xmmlLd2R5s4JnqNhoXKApElpyz+mKeks1D6TcNEEW2AY+t7rl1yyoTISMxSZHRxNfvvuzTsOjnrcglviJYnVdfv7l9cVBYSEakJQSg7Dsl0yNzSauv/3e//y1hHbxqeuLN2wtuLEJUVzKtweF8dzwCMpzeofSv7+b+0vv93z/BtHbvpG/dplxV9YW/bmh/2Ffgg7HCWSC1ZMqm6HRhnXgabpwZHkaFiNJozyIsEwcWdv7LpL5t/92N6USoCPjDIiEEDazk/hjimY9Ex+EEqfo2lw1RgaPXDD0svOqYrGDElgx8LqNfdu+fTgiMfFu2VBkflo3Fy/uuy0E0pSmp2ljkm0Ztex2Lfu/uRPr7XVzPZseuDkFzauu/kbC5fWBySR0XQrGjfiSdOycFWF677vLr703Or/eqVz18Ext5u/ZEO1S2bCUY1g1U6KM8fbmOkXxoC6jo5rR/riLAOuiEtidxwYY2l0w9fmRxI6x850nyxvTidQHq9Ns+t0msbUfd9tvHD9rImYzrJ0SjVu3vjp1v0jXkIdkWd10y7w8peeU8UxoCmd79oYSwLTP5T8zj2bP9o1ePHZNX9/7PSvnTNXltjxqJ7SQA4RTYB6Ej2mVIvj6Pu+t/iCMyoe+mPz0Fhy5aLC2761YFGNF7BXAyLeqWFgZtQ5iANGNBWOal29MQkcH2RTlCQyz73RddGZVaeuKI7FddaJAKfOPe/MJIHSTDpFA6EM+yCkavYdVy386tmVkZiOECCBP9/U9NbHxzwK55IEcFgYpGrWuhXFJzQE4ymIFR3q0AglksZtj+zc3jR83cV1m+4/eVaJEksYJIAEojgIaXa2LAOCTCP0kxsaVzYEn321Szesy8+t+dPP19z1nUWFfkE3bOKdTosHnYmkgXkYczRmdPXFRZ5EzrbNcfT+1vGRsHrblQslkQanPOuPZeaaTi58JgdNZR+ORbGU8a0Laq44f240YVAU8ri4V9/r3vRym0fhFIkXBI5h6JRq1VX5rr9svm7aaUEAs0UJPPPYC81vftj9rS/VPnLHKkRjzbBZWNTjPpomysG28G3fql+6IDAW1pKaSSP09S/O+c0PV84uU3Tddr6fx0o0RKSzS+WSoGTamGFQLGF098V5nnUyIgyAudZr7/eeuLL0/NNnJVNGhswzzjufQGQZpztKFMugRMo8dWXJjZfXaboNaViB7uqN/uLpJhpRsgS+KQ3IvDm3wvXIHctmlyqmSWIIYtRlid26d/jXLzSffkL5w7evwhgbhk2CMGe1gcUsgtibZp5RAQVK7nDK8iKvh/conMAzo+Paolr/j65eJIlphZpLI5amEqqxYlHBsvqAaYLKBexFsziWSVMTgw+5pzkUG1evvbjO7+UgJM6DKI5PoBnYB4Fbqxu4uEC66+oGRQYYwQkvHnuhua074lZ4mVAnnjSX1hX89ser5lV5kqqZZVtEo3jCuO+JvQGPsPHWVYrMGgYYwSwdGAYwaUlgXDIb8AoAp+XRCP7TdFs37Dc/PNZ+NFJcICaSxurGwjNPKh2P6RyXHj/hAwg+WYZesbDg1FXFsaQOSw4OLRhfJ7Nm25jnmb6R5KGO8ZpK7yUbqiciKgfMflxunkKgqeUKCOypfcPldfMrYeYUomSRfW97/0tvH/G4CXUQFUuYG06ueOxHK2eXKomUSZ4Hh2HaLon902vtnzaN3H3NkqV1gZSaVkzZY2xcbemMvL25//cvtV51z+Z/fNTLAfyYExGSy2WR8Xv4H/56980bPx0OqYLAuGU2ElMhsMzcj6axZtoXnTl73YqSkxqLzlpdkkhZeeqN6FmepUdC6uHOCM3R562bXRwUNd2iM9BaLnt8XlaDLG8yaa4/qfTCMyrjKZNlwE+Jp8zHnj+kalbQJws8S9Poe1+rufqiWpaFuCwNcUJWw1YUrrM3+rsXD69fXf71L9bEE0bW6jvKm2Xo/3ql7fEXD4s8Y9k4njAvPrua52nNsPIXDdLla1eUKDL3jTs/CXjE+25cphmWqpuWnbYpGFPzq73f+eq801aUJFUTIfT0/Wte/+DY828eOTYUzwHCwQHQDKu1O5qIavVzfetXl73w5pGSoGxbM5dP5HJQvveMwF32uvlrL57PsPCRadoehX/57SPb94+4Xbwic0nVrJ/jvenr9SRoBKXofNeysSSylmVv3HQgHNF+ePViFgKFPD7GmBJ5ZvnCAsvCAa9cHHAtrAmWFslOBDt1wWhqPKKtWlp0yYaqiZgB3rydyRdnTFloQnt/68Cug6M8Bzn97U0jb3zYMziaAIU4mcUA8ETkme7+6GgY8kUb1pZ7FPBOSK47PfGZHcX8EYFXkkiZX14/u9ERDRrxPHNsKPHs6x2E54F5MPEAwSvN+LXOIYns4a7xr9/58XNvdlx2ztwViwpVbapwOZFPaVDxunmR52SJlyXO8dSzdLRI6t55DbiXDskccAIMgNJI3c+k3zw0lvrrv3pufHDngfbwYCj17Xs2v/zOkf6RuO4A9JnHYpviOLp3MBlNGppmndRYXFvtTiR0GhIuMxzHFTFNtyuK5YvOnE00AtjLgE/85yfH9h4OFQZEngWwChFFY1kAwjtfBP+FRn/7V9d9v9t3bCh+yoqSm69YSPCeGZ5hmrbLxXlcnKqZMs3zHM0S9M8BNxCiAF0mVs/hEVU1F87zj02ohpGBGuGDdD0UQ6OSoDQwnNzbHDZtc2gsNavUowgC8ECeNwih/1hYDU9oNbPdHEevW1nS1DIxU8nFtFBjMv6ikWXitSuKF9T4TMvu6Y8d6AinUsaml1slgZbAKYTIkSYlJgZoAuK6YuJPqtbLb3cPjia/d+mCvz5y2pwKt2GCX5ctasrWHhmmLQls0CfqlkXTAAxxLPxIAutxcaLI7mkePToQY1kQEaeuoSQo1VZ6MaYsGyD3nPAI/jNMW+SZ1p7o7kNhgWNEjmVYRxBzsFES6qu6NTiWQhSlataZq8sZltJNmMX0uGMGDgKwzsayyFx0ZqVhQDXBy+90f3l91dtb+tt7JrwugWVZUkcCD7VtO43UELjStrEgMAV+URLZK740L+AVEikDPHpnNZzyCOI90DT40CVBsTQodfclMAWBvmXjrt7YvtbQwfZw65HI9qaR3/zwhJrZHt0AGccYhHd+tQ8k0cqrYXPiVIQoUWSa2iZ03VQkjmUAacsBfSYPhkHhiOYkmmpme6rLlO6BlFvhp2vAGQhE00g3cWNdoK7aS9OoqSW0vy10/w3LfvaHJkwhERwf54kwLpu4Xo4dcc46iXbTwEcHEgvn+XLd1JRqmgAbYlWzU5ppGHY8ZcRTpkW0xEhYvf3hvUf6xofGEpYN1NRNCNKmJNADXj4L3dM5k6dpSicZt9C4ijGlyMJkbD6tjAMhFInrJBMLOntFQ7C5q8vj4tOh1swEypEvVTO/cHIZx9E8x2x6pbW63N3cOdHUFlIklucAbnLUHsT3tq1pVtZMYMiuMD4XZ1rW2ASYCY185OQV3tnS86fXOziWmYjpsYQeS5iJlIFt7FYETGD8/tEURTGFBS6BY0WeSaRMmpQC5Y7YhoIrG5YapCc9afBIVKu6QhkeSxkm6EGeY6bzTvotqAIqmTRBTCnMc8yS+QW60eGAsVO4baoVg0oniMiFxvkBkWe6jkX3toTWrSzZ0TQ2MJxUJB6ipMzFZHwQtTo6i5wC8+d185aNh8dSWeGCpWBRUrM+2jXU3BnpH0mlVCyLfHmhp6LY4/VIaS1mY5pmOJbDGKk6FFzFU9PNPsgawKzpd4hl6JRm1cx2P3rnyusumZ/SIGGZDQaPd+iG7agFClG1VV6XzED5x2QAM52D0o8DLbus3lsYEDmOfn97//BYqrzI9e6WTp6nRaj9zFaLQpg2HtU+2DF0wemznLICB3TyunmE0HAo5ST/Mnem/B7BJfMVRW5E05YNFTCqDtiFKDBQC4SoshLZpXCSwIg8LYtsKKK7Ib7JY3snwnJEDAJpBsWTRvUs989uaqwuV2aVVCc188kX20QBQKA092WR+YxucPwYxwk1LbvQL5YVySNhg1emWvvpBAKrNK/KXRKUInF9895hJ4m8vy0kieA3px/g2CyaSqbMjU8f+vfmvqu+XLNmWRFJ20D4TiM0Glah/jbHTroVSCpEEzpF0bLEzipV5lV6BkaSLZ0RlkWCwNx93aLFtX4bY44AY6aFVc20rIwRJObPsjAr0TzPUBTwTmhCW1zru/+GJfOqPCQfT13z1Vqvi/vtC60pzRI4OlOuln9gyqNwjmtomLbXzZcVK0cHRr0ufooSmkog28Yiz9TM9goK29Y8sfvQaFFA7DwaGxhJSAKABnmQOUHteIHe2RTqPBr93Y9PWFwb0FSrtFB2KezAaLJnID6v0gO4NTFhoJ48wtknl69qCM6d7fZ7+JpZrmdeO7LvcNgn8paJgbI0lUpaBtgsYqgc3INoDpahBR7qqUZC6sBokmFRUjU3nFJ+6zfrigukFEQYlI0pXbcuP29OVZlr46ZDnb1RWWJpBtlWnjdmkiDBkScblCBXHBDV/BBnBgIRXJ3yefjKUoXC6Mix+JG+6MKaYHtPBEMFyQzOJjjTNg76xXBE23UovHpJ0eiEdsaJpfdct/SXfzq8fd9owzyfqloMgzTdqip3vfH4+vo5XvDWGDqZsogLqg2HY15XgWHaEA8TI+OUMzvhOMcwogCPDkXU1u7IRzsH/vxWV0vXRP0c/61X1F901mzHr0EU5XFzpgn8nkiZa5YVP3Gv8vRLHe9sG4jGdJfMgu9GHEwCDFHzKj08x6RUS7ewS+I8Cq8bkICYYsem5MXAZntdXHmxbKjG/tYQheGmhzojPMeA2kNUaaE0EdOTKXDtssk8x8tq6YoABMEgFUD7BUcHEjsOjF12bhUUu5AMX3GBVFooQfoUvkkcKKgFocjIsGHZKsTfMAwwlyytGfZEVOsGTkw0d47vbh7beWB0cCxeWeq5+esLv3lBbd0cbyIF5YwUolwK98rbPRUl8pqlJeGoGk8axUHpp99vXH9S6cvv9GzbO5rSTZ4UZNOI8rr4iZg+Oq763DzDIo5nBJ4GPfi5HGRZtkviCv1CUrX2t4ZEgdUMPDCS4EBgQZ80zPMf7JiIxhPZVJej90SB7u6PjY1r5UVSiuBqa5cXPvpcS0qzFYkhsSUYe9MG/9vRrzRRzDBokmizLCoBah54/vd/az3UOT42rvYNJ8ITWmhCS6RMkWeW1AVuumLR2SeV183xYoxjCQPYgUayxD7/Rucdj+wsKhAfvfOE9avLUilSOUzbp64sXrWooKl1/IMdgx/vGh4Jq7plGYb9kyeaPC7WozBV5a5f3LxSkTmSmPtMAjmKkONol8KNR7TOYxGe0IUYC8ioMwxa1RDsGYgnVUPkxaz2c5TRSEiLJQyGUSgMjOBWuFAkFYlpHsVlg+frmNRc/C4vHYAQhroxhKJx4/k3O5o7I34373JxRQFpdWPxsvrgyoZgXbXHrXAIoWTKJGEt8ri5SEz/2R/2Pf7iYQahWMK881f7vnH+xLcuqPF7hWjMiCXAlT+xsXBFQ8G1F9c2tY3vawm3dEX6hhPDoVTLkeT2/aM3fG2BANjbDDHjVBHDJG7mOWY4rI2EVJ4FjgTHkIQRksAuX1jw7tZ+TTdpmiL+vuOYYIahYkkjNKESigL0WxSQEKbGo9rcWR7dILIz05EtvkMwPQCJk6qlG7iu2v/T7y+trnAFfWLQD26xptuWDXoK24hhIJTlWHrr3uFfPXfw3a39BB0XPIqIaOqJF9t3N49d85XaU1aUOuWO8QTYU4+bP21VydlrygwTD40l+0dST7zYtnXfMDjsIBBTYLOZOMjxhhGiRkJJw4SILE0DBIWVhX6hqsJVU+kmDqdDuGyiE1mWPR7VIRRH2DBwwCtIEhua0AFFmymed05CTwKU4YGZm4iZFEUlVSORNGaViKesKOY42jCsKKRAgGNYFmoXaRqZpn2wbfy5Nzve/M/R8agWAA9LlEUeABIb+z3C3uaJG9p3rltZdMUXaxbXBWQBit5SmqVaEM0jGgW8QmmR7HExkZhmGKDHJsd0XAI5IyaxdmhCdZKoELsStjIte/1JZQLHnL2m/OmXWi3bBoAwL1CCKiEnPLRs7HfzpUFxcCw5NVmZ/0Q9g9UjClAxiNSJSYYEGaTMCAoOIT6kXiMxvWcgfqAt/OaHRz/ZPRyJ6TzPlBQoEgAwoGWdu5qWrcgsxtS7W4be2zpw4pLguetmLa0vmF3qcklcPGmYFviHtkrFE3pS1S0bOyb18zmIpgB/UTU7kTId/YdoisHUeERftSRI0s1awzz/FV+at+mVjpKgQop0nMCVohkUiRrYgvjFwrbHJZQE5b6hZK4/nXs4+kjTgKYADtBUOKLBxXBLm2YQB+YPNFdKNbbuGWrpjhxoC+9rCXX2RlmW4jnW6xZ9HoGlGQdZcx7jkBtjrOm2LIJ137Jn7O0tA7NLleULAqsaCs9aUxHwCghBbSQMm6YNE8wlTBV/JoEAdiHprWhcN0AJYtsGwJChqTPXlN597WK3whmGrVv2rd9cSDINfZaNoZiWZcCxpaiJOCTPnaYrmmeCAbFvOG6ZM5hP57DJNCib9J4hKhIHqwT9G5kac8uGSe45PHHTg58eG4ojRLsVrrxYsW20uDZQWep+Z9sAz2a1YTrBztCgrU9ZUdw/kujojRX4JK9biCWNN/7T9/oHx0qC8pknlRsq4KymZXEsZRjW0FiKVPV/HtwBOZyUMTquAeUReFOnn1C2Zlnh4lo/wyCTBMrYphiWvu+7jZedO2fL3pEte0baeqKOlo3EAENwWjUoGxcHpMOdEwTxnYlExC0HUWUgtqRtezQM/oskMCxoGWxYmERUkIzWDGtWicclQ+V1SjXr5ngfum2p38MnVOOT3cNQguNEyyRCjMSMU1eVbLx1Wc9A/LaHdw8MJ0WI71iliLMBCeGdQZqWrao2z9GJlHVsOCkIM3BQfsiLIfaLxIy+4YTfwztAs4Orsiz0MGXseroSZ3gsNTSa1AwQZ8fxjcbNNEaFkGVYpUFpIq7rxmS16eSjCMuomjUwmkyqUJpHQlDc1h1VZI7jGN2wVUixORfDkyG5zTCaZjXU+h65Y1lZIVSC3nv94oZaX1KF1A2EIyyKxI2TlhX99KZGgacXzfNtvGVZWbEMmBPGOpgQrEgs6DgEAX0sabhkLhzRBkYSIs99pg4i7MUw9HhU7x2IL5rno2mqtTvS1DYhCNSKhQX3XLekfo5fhTpAMCL3P7n/2TfaYwndowgeF+9SBJrYaceRtzFkfkqLZF0Hr0zkGWhpy6cSx9BjxJe96ztLli8sKiuUPC4u6BNMy5ZEJqUaSc0qcLJ9UJOKbAoMZXGh+NBtyyCDCN48KvSLP7+p8Yaf7eoDNAaqIVYuDP7ipkaPwlkWTiTN1Y2F3798/r2PNxEcEiTArQAmQThRm4jpBV6xfziZhLpaoMYUKZsBNME27jgaC3hEjjjmxQVgPnceCH/vp59298cdL+n3/936+IuHBI6uKveWF7ndMogCRUHml+RygRSGBSlZigLNksmp5IgXBJbY4+Lvvqbxx9cuOW9d2fKFUDktS4xLYT0Kl0hZsTggrZaNFVIkTgr3qPCE9tZHfZBlIn16CdWoKnf/4uZGn4cLjauNdf6f39xY4BNMYGWsSExnb/SPr7aNhONQA4mxR+b8Ht62SYGlao1PaH6P0Hk0SvoaP1fEiJsviWxT+7gJHbG8bkCfH4WpgE8YHtNffOuIx8V39kafeqnV5xbciqSIYA4cnUMhqMvLpP1gtYN+UeCZkVAqg9lPPQA2pZFu2EnVSqZMYDcTu2SuOCjFUgYpsoF6BL9bkAQAtIi3hZ/4a/uf/9ENUIYFIX4sYTTWFfzo6kXLGwoeuKGxvFiG2JCiRI4ZGE1d+5MtH2wfgMp0E9yAwgJRhqpQSFKDZxtVEU219UShnHwmPTmNQJgSBKblSGQ4lKqr8kFCgkCIJimm29caVjXrX58cC0egIlnkIVufhVudqaZIhtqBq31uXhKYvpEESXjl82nuIAiAn86gE4+xolhJJo2xcZVjaQMILSgyaB/HKvMc/fifW156u1sSGWgwYOl4CmzW4z9aNatU1nToUOU5ZmAsefW9W7buHQ76BY9L4nnGtu2qMoWGMn6Ib/uHE/GkMRpWR8IqxOLIKYM8TvFCuu87XUZr7zs83lhfAIvmlP1haAYJR7ThsdSB9rBhYEngcqt6HMU0ElYTSdKkjimw7jTyKNyxwQS2KdMkJRyk4xI0pp0u6pgCOZMULoayWQv3DkBbjo0BiiwNyk52wIECWIb+5bMtb354jDiEGAI6DHUD0B9MUaLAjIRT196/ZeveoYBPdMmiwDIk0YRrqzw8B6JkWnZnbwRB7RK0RUIByEw7FswQaoBSZOn3Ph049+QyjCnTBiOddm1Vq7M3Go7oUJUBjwS5YsBvtqMpq6pMOWN1KTF/BFQUKNbDzyp2hSOq6OUZDkFTGAYXFrKDFpCPdbovCcmyS2Za9vxqL8dR3YOxeAI6PxBNza/ybtk7mjaiNkmqWtTGTc0cQ69fU5rG8NO4Guruj9368I5Pdg0VeEWXLPAcC2RGiOfo+jk+x/s1DPtgx4RA1D+B/adXm00lUE5ozqCj/fHhsFZd7hqPGYrAOaGKadpNbeMp1SLV/OnGfE23A37hukuqz1kLrSuGaauaeWwo+emBkfaeyH92DBT4xF8/fbDlSHg8osWSBoGugdyyyNTP8Z24pGhpXQEJR2GgNAlTaqu8RQGp/Uh0PKIXBgRNt5cuCKLXOk0DgDF4KlnFWNL846tdKxoK/B7eImiXaQGW9Op7Pe9t7S8plCWBFzjIjiEaVqJmtnt2qawbNsswSdXc3xoCFBCTwv2sC5Nvxo7bFq5q1r7WcGmhMhIKYyGNeNuYajkSSaqWSFpJnc7ik1cU3XHlwuoKl2VDGdWBttAL/+jaeziUSJoEIaQsG735wbGkros8XRyU5lVKJUGpNCgX+ISkZsUSRkdvVJICbgkqwR1M3uviFtX4dxwIDY2lykskXbeX1hUoEqPqliiATDEIaYYd8HK3frO+wAcUBA+WdIMmVfPai+s6e2Pvbx9yydAQ7rTrJ1Pm4vn+0kI5qZqSwLYemegficMWFMcvdJtOoBwmolHvQMLr4nioTbEgSUeSLe090UTKEKCoLS3t3/jinLo53hDJgjE0KgpI13y1jicmRjdsqBKSuYBP8LmhSowhxZ3OTyZogjSBadpmBpyH4hCBOXFJ4b+3DDS1jTfW+y2LKgqIS+oKdh8aB2TLBJHkWHTPdYtPXVUcjQOKROAKJ42BFZn79Z0n3Prwro92DXsUqNrCmHLJ7KqGoMAz8aQh8PTmPYO6YXsUNreb7nMJlHZw00ykW/o4aaJ0knQkITUcSjnde05yiucYUu4KxRvO9CrLXaSBBswB6Yon9QjQZ4qjcaj6MixYf+cppPcbexQwdhhTKR3SrYikuk5cUuiSmc17hi//YjWk93h2/YmlH+0YLvLLBtE1P7q24ayTyyZiQB2WRaFxKBL2e6DEU9MtnqM33rLslod2bd8/5la4ZMqsqXSf1FhEID0AyCFhY4Gyz2ONfEb5rBI8MgZskWrTPO+SeC6Ao5HJiwLjBcd00ocwyPhIt5OV0qykZoIzlYbcwGlUJOJUgihRLokL+sSD7eFHnjn41sfHDN32uQWKouJJY3apu67as+dw6NhggmWBNU5aWlwSFKGr3LJvv3LBBafPAt4B5wCSzjc+uO2qH38SS4DrxEDa2nbJ/MO3r1ixKJDSIGF3+qqS4gIR+qgkbm/LWNuRCSXdNZa318WUI8fMZ3rLpuTCqfS+IpMtZY5To+t2SodUpCyzpNYi8xVnLwryAx296f1JgI9kmX3xn10vvNEFHdAM7ffw7UcjNz346Q0/377z4Oh37t38lVv+88q73SwDGPOcSs/Za8pHQqn3tg3KAptImnXVvnWrisNR9SffW3zxF6rjSYNJZ8DRHb/c8e8tfVv3jzzw+wOk/wEgYN20fG7+sbtW1Va5PW7+4g1VhFJQRvLhjsG+kYQiAXqbtxOIg28eV8TSQWimBJWa7IpwqnBYGvR0ImUWBcTKUiWaMKrKXS4CTX1WUW/62cCMddXe2x7eiRFat6J40yvtf/1n55wK9+N3r26cH9jeNPrUf7ff8cjuv7zVtXZ58cJ5gdIixetiP9w59LVzq3gCDl20vur9bYM8x5DmeMAeFIH54WO7/vLPLq9L8LvFf28eKCqQ7rhqoaqBO8bQ6KNdA3sPD9/6zcUVxUo0AT2hRwfi//ykT+RZjoXwJUuSyZarGf2gKbX4k3W6KB3Tk0yWwXHMl8+YdfVXayuKZceyOtVTx4WcSTrUCdB03dywdtZvXmje+F+HHvnjwZFQ8obL639w1RJJZOIp84TFwVUNwXe3DT37Wsdf/tEzOn44GtcxRTV3jf9nx9BXv1AVjminrChZs7Totod32zb+4qkViEEbNzU99VKrmwDSPMfxHPX8G51BH3/1xbWWiZ99veOmBz9tqPVfdk61qkOan+fozXuH9h0eC/hECL6mRUCZ3qEZOSh7TcbhxkQIneKlRNRYUu/79ldqzz2lwiKdyBzZLeR44utkHaBikIGcqmZYvYPxj3cPDY6mDN2qrvQ/fPuKC06vjCeNFKkcdhpMvnBy6RknFh8dSPT0xTuPQWfOO1uG3vjg2OknlooCo+n2Ld9c+OmBj3/82/2maUXi2iN/PCgIjCwKsgjNvgghgWce/3Or3yeMjCXv/u1uRWIe+N6ykqAM/RkEq/jD31o4DkGZSt7GMZNzz13rqX3zGfg0zToMWGWImAt84tVfmXf5edVFASmWhPIJ8MqI2zKpo3IOwwQkEFO4uy/W1B7evn+kqS00Nq4Nh5LRuFlf7f/lD5Y31gdC4xrPwx4xTtkNIPYpk0KoslSprfKcy1VEY4au73xv++A7WwYu3VAVTRj1c323XLHg/icPPPTHw+FYiqIpRRRckgABWHbCNNr49KF4UjNN+66rlpx5UnksYVAYVNvTL7ftbRnzKALLgis3WamSUb9T6l/yCJRXSkMEOJE0OY5ef2Lpdy+tWzTPr+nWRNzgWagscHSwYdoQZJGcpAOVgkzZOOATD3eEn3m1I6WaGuwqgk5cUlQYkIoD0q6DY+9sG3zyr20/vrahpFCGrHFubwTxKsAd10H1uxT28vOqPto1+MyrnauXBkuDcixhXnbunNaeyKvv9XlcAsJI4MF1nOQA4hYS6J76xvnzb75ioaObFZk51DH+h78d5lha4KEKAFpAJ6kz8zGTiMEToPRK1awVCwuuvHDeOWvLOZ7WNdvj4m0b8pnhSCo0oUUTRmmhXFmqiCIHnp6NLZMUAyPqpX8deeD3+75ydvUjt690WMPxm2wbf/XsqlM/6X9w08Fr79/+8O3L51dBD0/exkTkJdTEYBjD6saiC9bPeu61rqf+1vHA9xudAPDObzdE4+aHO4bdCm8QtDBLHackNhLXTl5a/ODNy52dliDUMOwHn97fOxQv8MuALuVY3kkZmlZilqOkM+4Acfap4gLxkg1zzltXgTF+d/tA/3Cyfzg+HEr1DSX6RxIOfKPplsfFzalwz6/2LajxLaoJzK/yRuP6Q3888Nzr7d+9bMG91zdGISAnYp2eAizveadWLK0P/Oypg3c/tu+3d68q8kuO+nBGYpOIoW8o4VY40r5I3/Xtxc0dEy+/27NsYeCSDVXjEc0t8w98v/Fequn97YNuGWKULO7Ckh6WlYsKH759mSxCg6ONsVvinnix+R8f9XpcAqlyyqFLvvFKbxt3PA7Kbj/IsTTpX+8cHkumwNUDJ96woJa80C9yDB30w6YFpmHvOjS++3DY2SSgJChZNm45Ev7yGXN/euNy0omKAagjqwUZJEKFeMIoK5Lv++7iC274T+uRaNkqWdUxyxAk24bQ5K//7Lr7N7s9br6yzFVV5jp5WckXTi470t/+m+db51S4l9YHYknDq/C/uHlpwMO99HYv1LgQS8LSVCxhnLC48Jd3LA94RR2Qbux18e9vH3hwUxPpsOY40jIwyTXThGxmJW1n6OMgG8eGkj39cSi6xFjiOVZGJDOHyovlJ+9dDdU0GsgFTVPPvd71zGudAg+IXzRuTcS080+d8+u7TnAWBZC6tOcNcBpsrWRjmoSUPjfvdbM9/TGpsNoaSdJEo/kU4ZPdQ3c+uiuRghr5SHRi18Hw8290FReIpkWNTaTuf7LpsbtWzipRVM2SBPae6xsrSpQ/vNRuWZjn6GjcWLeyeOOtyz0uTjMgA+lW+ObO8Zs2bk+qpkcRRFJ7PU2ucvgjXyFNyYs51aoEHwEdTEPxgqNCiGFDLH20P/HY882P/mClKAKMwLH0Td+sZ1jqqZc6WIaWRPbCs6p+9v2lkshAop1CoYjW3Rc72D4eiqhnnFDaMC8gi2BfYwlD5JkNayue+Xt7SscST1VXuKvK3KJA/+ypfdGYXhiQ3RCVQBCIYc8Bm6Igwmrrid792N5H71pJgniLRvR1l8yvKnf//A9NfcPJc9aVb7x5uSgwBuEdl8z1DMSuuW/LsYG4xyXIIjedZ7IkmpGbZnIUnZT75J4ENiGc01RiiyLz9ub+4gLpx9ct1kwAgxga3fj1BQVe8ZFnmi84ffb1l84/2DF+sCPc3DHe3DV+5FhsPKoBYoupp15qbZxf8IW15acsL6kqd8te4dRVJb9+rvmJvxxOqBq2sSiyAkcPh1IuFyeJHAS5mV3HnL0+sI0Vkd7dHL7z0T0P3bos6BdVzY4njS+eVqFIzKvv995z7WLSVQwAnAeok7jy7s0H28MumZdFCCym2at8+IfM/TiOYoaKaAafEee41tgFIdWRQr9w/aWkLR5D3cVl51bPr/b848O+S2//pHcwOhpOIhoJHMNxtMizPOw+BRFqc1d02/7RogJx5aLg+tVlKxYGVzYUNLVMlBS4UpplmpahUz6XSPI8ALBkVyq7z4lpYbeL3bZv9NaNu39x87LKciWRsiai+kmNRWuXF6uapRsQjXkV/vCRiavv23KgLeRSOEXkoU9tKnnyhCu3JWgGAuVyWqZug0I5NMo2rNikmuC3f27lOebbF85TdegkMgxqVUPQRzK8XX2RQp/icnMAgztlWxkLJfCM1wWi8d62wfe2DcyZ7ZqIqmTbGIqhaS6zLdPkXqH5U4LiK5rSoCiL3XUodOODO35x87IltYFIQic7XIGat23gnW37R67/6dbuY1G3zIEbwk5mDXKqmqYIV4YR8MygfT59p2oyKhdOg9ZbFv3yT81P/ncL7MMFbWJQIDGv0v2rH6zcdP/JyxYGNQ0nSZsQKLHMNqyQ2jcslqFLgkpRQBkeNeIJ2PfIoYeNoQQt49VMHk7IzoCatyIx3a1AYtylsO09se/9bMeHu4a8mSJ5h8Ff/+Do5T/4qKc/ChlNWSBdwp9HnclqsON40rkhfIaQmBRa55A2c8q2YVMtlqV/80JrOKLfeVUDz9GaDlX3NkVtOLlsVUPBvz7u/8dHx/a1hEGDQIkjWf90n6ptGcBVUH+EIEs1ZRgO9zrPdvplTM02DFxb7VlWHxgOqQfax3XdFgVmNKzd/ODO269ccMmGOYaJeQ79/r9b7n18r2VjjyLKAgfdhDNKVr7qyf3sOKGGs4Rp7DCPRlR6VwMnTEvLmnOpwEMneu9A4sfXL64sdUMtLkXFU6Ysst/88twNa8v3HB57b9vgpwfGxiO6bllg42HvxMmKLgTle5nmz0z07zjlFnQlwuN9XmH14uCpq0pYlv7XJ30H2sZjKcPJ07AsMiz73ieajg0nv3tJ3cPPHHr0uUMsizyknzbbTTYj5jONmdL6JbfafoqjmI1Sc7gG57QKTspodlmwIgJk03E0cue3G85ZN0s3YIsyjKlIzHAp3JknlZ26qjQc0fa1hA+0jbd2R0ZCajwFeL6mWYaBwQOFZBZwJuf0+IqwFZkisWVF0oI5vhMbi2pmu8cmtH9+1PfKuz39IwkaYWBJDoJhKDWhkcQzz7zS8e7W/gPtIZ6lXTIPO+HMkMz9HOpkeGMmDsp3uvPzi3gGWcsGJxhD7/fAqHrLQ7s+2Tv83Uvr5s7yRONQbWhZdpJgRgGvcNZJZeetqzAsPBZWh0Op8ageSxgpYnSchnAaehJoZ9vSooBYVij5C6SR4eTWfcMPbjry7839I6EUxwHIKwocTxKBTn7NRJilaY5n+kdUryLAfrqEOpPihD9LsvKunOYqzgzaO99Dk5uOT5M10v/p/HaK5gToDaBefKt7296RKy+suXB9tdfN6YYNOwDQcIEJ+TII3D1uLuAFxUlDFsQpGSDVKBzjlLKrCaPzWOyN//Ru3jO0ryXU3R9LaZZH4QJenodOUNo07UgMdpB0yWxhsShCdjupQtsxYmjYMi4fxJhKiePxTr6tn0ag3JumcxgUdVxZm8ZKFlSWQJX+UEi793f7X36n54rza04/sayiSElqpqabsJeGg4fYlG5ZmjGpHRCpot95cLSpNdTaHWk/GukdjOsmcIfAg7wEvByiaFXDqm7KIlMSlCrLXDWVHrfMdfXFmlpCKRL0ORFfPmmmucnHpc4kf8xMoGngWq6unqazM4KYqR0mattOp60FXmjvid28cefi+b5zTqk444Tyhlo/RWqDSYGmo+5BppwnOcgc6CAOYmCeo2eXujXN2VaREXhGkVkvFEyLELuWuwr8Qv9wcseBsTc+OHqkP+akBgCiynTZ5ItE3pSm8VNOhDGFiFMJNJUjs8nuzK6ZzmSye4lm14a8ysoigGeYEgVWlriOnvhDbYee+XtHQ63/rDXla5eVlBXJPMfA/kaw3SRk5cHrgc5w8StnVV1+3lxNsxIpM6UBKUlxDDiQDJMOd9t7Yu9/OrB1z9ChjomRcFKWGAGgQQgbs9uLZef4OWJ1HMmaImZTM6u5LIbTb7Iyl3dhLis5FMqloVO24VI4j4tPaeZHu4Y/2jUkCcyief7lCwoW1wbmzHYHPKLXzbkk2JSD9CbDkwDDZjlZYpOqGUsYIdg/KtHWE21qDe1rCfWPJGCDegqamQJ+AercSSydLU3JX+f/MXVyv51HoHRzPlTVk43Epm5RgR2fO0OSDLfMuB0I+BFpd88EfBmaNEUvi+EPelh7msOb9wzbNi70C2XFSlmRXOgT3QrHssjJMZimlVItUrSvDY4mB4aTI+PQ1cpzUIUp8lD6yzI0JPwy00lvfeaE/VmWn8r1+cohPc60AnW+4JAqvR9M5h5pAmm6oWmQ0c3sgpc3bZT+/uRup1P+6kjW/c0YuDyCTb4irrMiQXezplstneN7msegBGmmLhKKglyIKDB+ss+y0wLj8IthWgZ4kbnufy5T5HLD5L5w+X97JE29GSQLIaCGbmQIBCuAq2YVXHV+w/93f7oGkbBjcnekabFAxsDlWo58Cfk/ODZNM6tmFRDvlQIgIjIRXzS3cPHcwuN3DPyfONLc9j+5+P/+9f/v/PEjnmfR//75LGpGCmX+fNb/BWXxPEbu0JwoAAAAAElFTkSuQmCC'; // 10/27 免掉%證 BUFF 圖示(deploy/hotfix-20261027-nodeathicon/nodeath-gold-96.png)
function renderBuffs() {
  const bar = $('#buffbar');
  const now = performance.now();
  for (const [k, b] of st.buffs) if (b.until <= now || (b.who && b.who !== st.myName)) st.buffs.delete(k);
  // 只在項目變動時重建圖示,倒數只更新文字
  const keys = [...st.buffs].map(([k, b]) => `${k}:${b.label}`).join(','); // 名稱也算:同一格換成別的效果(神聖疾走 → 風之疾走)要重畫圖示
  if (bar.dataset.keys !== keys) {
    bar.dataset.keys = keys;
    bar.innerHTML = '';
    for (const [k, b] of st.buffs) {
      const btn = el('button', `buff${k === 'poison' ? ' bad' : ''}`);
      btn.type = 'button';
      btn.title = b.label;
      btn.dataset.key = k;
      const c = el('canvas');
      c.width = c.height = 26 * DPR;
      const g = c.getContext('2d');
      const draw = () => {
        g.clearRect(0, 0, c.width, c.height);
        if (k === 'sk20106') {
          g.fillStyle = '#8b1515'; g.fillRect(0, 0, c.width, c.height);
          g.fillStyle = '#ffded2'; g.font = `${c.width * 0.8}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('☠', c.width / 2, c.height / 2); return;
        }
        if (k === 'sk10100') {
          if (!drawBattleScrollIcon(g, 0, 0, c.width)) setTimeout(draw, 300);
          return;
        }
        if (k === 'doll') {
          const key = st.magicDoll?.buffIcon;
          if (key) { const im = buffImg(key); if (im.complete && im.naturalWidth) g.drawImage(im, 0, 0, c.width, c.height); else setTimeout(draw, 300); }
          return;
        }
        if (BUFF_IMG[b.label]) {
          const im = buffImg(BUFF_IMG[b.label]);
          if (im.complete && im.naturalWidth) g.drawImage(im, 0, 0, c.width, c.height); else setTimeout(draw, 300);
          return;
        }
        if (k === 'sk119' || k === 'sk120') { const im = k === 'sk120' ? aegisIconImage() : valorIconImage(); if (im.complete && im.naturalWidth) g.drawImage(im, 0, 0, c.width, c.height); else setTimeout(draw, 200); return; } // 勇猛意志:使用者給的圖
        if (k === 'expevent') { if (!drawExpBuffIcon(g, 0, 0, c.width)) setTimeout(draw, 200); return; }
        if (k === 'highpet') { if (!drawHighPetIcon(g, 0, 0, c.width)) setTimeout(draw, 200); return; }
        if (k === 'tishaguard') {
          if (!tishaBuffImage) { tishaBuffImage = new Image(); tishaBuffImage.src = TISHA_BUFF_ICON; }
          if (tishaBuffImage.complete && tishaBuffImage.naturalWidth) g.drawImage(tishaBuffImage, 0, 0, c.width, c.height); else setTimeout(draw, 200);
          return;
        }
        if (k === 'nodeathcd') { // 11/05:冷卻中 = 同款圖示變暗,上面疊分秒倒數(.left)
          if (!nodeathBuffImage) { nodeathBuffImage = new Image(); nodeathBuffImage.src = NODEATH_BUFF_ICON; }
          if (nodeathBuffImage.complete && nodeathBuffImage.naturalWidth) { g.globalAlpha = 0.35; g.drawImage(nodeathBuffImage, 0, 0, c.width, c.height); g.globalAlpha = 1; } else setTimeout(draw, 200);
          return;
        }
        if (k === 'nodeathexp') { // 10/27 使用者:免掉%證 BUFF 圖示改成「墓碑 + 盾牌」金色版(NODEATH_BUFF_ICON)
          if (!nodeathBuffImage) { nodeathBuffImage = new Image(); nodeathBuffImage.src = NODEATH_BUFF_ICON; }
          if (nodeathBuffImage.complete && nodeathBuffImage.naturalWidth) g.drawImage(nodeathBuffImage, 0, 0, c.width, c.height); else setTimeout(draw, 200);
          return;
        }
        if ((BUFF_SKILL_ICON[b.label] && GDX.drawNamed(g, BUFF_SKILL_ICON[b.label], 0, 0, c.width))
          || GDX.drawNamed(g, b.label, 0, 0, c.width) || GDX.drawNamed(g, BUFF_GDX[k], 0, 0, c.width)) return;
        // 只用圖示表裡的格子:FLARE.drawIcon 需要道具,這裡直接畫指定編號
        if (!FLARE.drawIconIndex(g, BUFF_ICON[k] ?? 0, 0, 0, c.width) || GDX.hasIcon({}) === undefined) setTimeout(draw, 500);
      };
      draw();
      btn.appendChild(c);
      btn.appendChild(el('i', 'fade')); // 已經過去的時間:從上往下蓋一層暗色
      if (k === 'doll' && !st.magicDoll?.buffIcon) { const label = el('span', '', '娃娃'); label.style.cssText = 'position:absolute;left:0;right:0;top:2px;text-align:center;font-size:10px'; btn.appendChild(label); }
      if (k === 'doll') { const t = el('i', 'left'); t.style.cssText = 'font-size:9px;white-space:nowrap;right:0'; btn.appendChild(t); }
      if (k === 'sk10100') { const t = el('i', 'left'); t.style.cssText = 'font-size:9px;white-space:nowrap;right:0'; btn.appendChild(t); }
      if (k === 'nodeathcd') { const t = el('i', 'left'); t.style.cssText = 'font-size:8px;line-height:9px;white-space:pre;left:0;right:0;text-align:center'; btn.appendChild(t); }
      btn.onclick = () => { buffTip = buffTip?.key === k ? null : { key: k, until: performance.now() + 4000 }; renderBuffs(); };
      bar.appendChild(btn);
    }
  }
  // 不顯示秒數:過去的比例從上往下變淡,剩不到 10 秒閃爍
  for (const btn of bar.children) {
    const b = st.buffs.get(btn.dataset.key);
    const left = b ? b.until - now : 0;
    const timed = left !== Infinity && b?.total > 0;
    const gone = timed ? Math.min(1, Math.max(0, 1 - left / b.total)) : 0;
    btn.querySelector('.fade').style.height = `${(gone * 100).toFixed(1)}%`;
    btn.classList.toggle('ending', timed && left < 10000);
    const lt = btn.querySelector('.left');
    if (lt && b?.epoch) lt.textContent = fmtNoDeath(left);
    else if (lt && btn.dataset.key === 'nodeathcd') {
      const seconds = Math.max(0, Math.ceil(left / 1000));
      lt.textContent = `冷卻
${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    else if (lt && (btn.dataset.key === 'sk10100' || btn.dataset.key === 'doll')) {
      const seconds = Math.max(0, Math.ceil(left / 1000));
      lt.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
  }
  // 點擊後的倒數提示
  const tip = $('#buff-tip');
  if (buffTip && (buffTip.until < now || !st.buffs.has(buffTip.key))) buffTip = null;
  if (buffTip) {
    const b = st.buffs.get(buffTip.key);
    if (buffTip.key === 'expevent') { const d = new Date(b.end), p2 = (n) => String(n).padStart(2, '0'); tip.textContent = `全服經驗加倍 +${Math.round((b.rate - 1) * 100)}% · ${b.online ? '線上角色' : '含離線掛機'} · ${b.end ? `到 ${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '持續中'}`; }
    else if (buffTip.key === 'sk20106') {
      const r = st.pkRankSelf, n = r?.rank >= 1 && r.rank <= 3 ? 4 - r.rank : 0;
      tip.textContent = r && n ? `殺人榜第 ${r.rank} 名：攻擊力 +${n}、減傷 +${n}、AC −${n}、回魔 +${n}（最近 7 天擊殺 ${r.kills}）` : '殺人榜資料更新中';
    }
    else if (buffTip.key === 'highpet') { const S = { active: '啟用中', standby: '待命中', idle: '未啟用' }; tip.textContent = `高寵契約 · ${b.pet}(${S[b.status] || '未啟用'})`; }
    else if (buffTip.key === 'sk20052') { tip.textContent = '帳號三隻角色都達 52 級:減傷 +3'; }
    else if (buffTip.key === 'tishaguard') {
      const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(b.epoch * 1000));
      const part = (type) => date.find(p => p.type === type).value;
      tip.textContent = `緹夏的守護:AC-3、減傷+1、回魔+1,到 ${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
    }
    else if (buffTip.key === 'nodeathcd') { const s = Math.max(0, Math.ceil((b.until - now) / 1000)); tip.textContent = `免掉經驗證冷卻中 · 再 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 恢復保護(冷卻中死亡會照常損失經驗)`; }
    else if (b.epoch) { const d = new Date(b.epoch * 1000), p2 = (n) => String(n).padStart(2, '0'); tip.textContent = `${b.label} · 到 ${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} 為止死亡不損失經驗(剩 ${fmtNoDeath(b.until - now)})`; }
    else tip.textContent = `${b.label} · 剩餘 ${fmtLeft(b.until - now)}`;
    tip.classList.remove('hidden');
  } else tip.classList.add('hidden');
}
setInterval(() => { if (st.inGame) renderBuffs(); }, 1000);

// ---------------- 掛機統計：只讀伺服器已入帳的本次資料 ----------------
const hunt = { api: null, base: null, resetPending: false, request: null, requestSeq: 0, askAt: 0, nextAskAt: 0,
  loc: { on: false, since: 0, offAt: 0, exp0: 0, gold0: 0 }, resetAt: 0 }; // loc:網頁本地的這次 AUTO(開始時間、經驗 / 金幣起點),第一次入帳前就能跳秒、顯示預估
const HUNT_FLUSH_MS = 300000; // 伺服器每 5 分鐘入帳一次
function huntLocalSync() { // 每秒跑(面板收起也跑):AUTO 開 / 關時記下本地起點
  try {
    const on = !!auto.on && st.inGame;
    const L = hunt.loc;
    if (on && !L.on) hunt.loc = { on: true, since: Date.now(), offAt: 0, exp0: st.me?.exp ?? 0, gold0: adena() };
    else if (!on && L.on) { L.on = false; L.offAt = Date.now(); }
  } catch (e) { console.warn('huntLocalSync', e); }
}
const huntNumber = v => Number.isFinite(v) && v >= 0;
function huntBaseValid(v) {
  return !!v && typeof v === 'object' && huntNumber(v.sessionStart) && v.sessionStart > 0
    && ['seconds', 'adena', 'spent'].every(k => huntNumber(v[k]))
    && !!v.items && typeof v.items === 'object' && !Array.isArray(v.items)
    && Object.entries(v.items).every(([id, count]) => /^[1-9]\d*$/.test(id) && huntNumber(count));
}
function huntBaseSave() {
  try { store.set(charKey('huntBase'), hunt.base); } catch (e) { console.warn('huntBaseSave', e); }
}
function huntLoad() {
  hunt.api = null; hunt.base = null; hunt.resetPending = false;
  hunt.request = null; hunt.askAt = 0; hunt.nextAskAt = 0; hunt.loc = { on: false, since: 0, offAt: 0, exp0: 0, gold0: 0 }; hunt.resetAt = 0;
  try { store.set(charKey('huntStats'), null); } catch (e) { console.warn('huntLoad legacy', e); }
  try {
    const base = store.get(charKey('huntBase'), null);
    if (huntBaseValid(base)) hunt.base = base;
  } catch (e) { console.warn('huntLoad base', e); }
}
function huntSnapshot(api) {
  const p = api.periods.session, items = {};
  for (const it of p.items) items[it.itemId] = it.count;
  return { sessionStart: api.sessionStart, seconds: p.seconds, adena: p.adena, spent: p.spent, exp: huntNumber(p.exp) ? p.exp : 0, items };
}
function huntReset() {
  try {
    hunt.base = hunt.api ? huntSnapshot(hunt.api) : null;
    hunt.resetPending = !hunt.api;
    hunt.resetAt = Date.now();
    if (hunt.loc.on) { hunt.loc.exp0 = st.me?.exp ?? 0; hunt.loc.gold0 = adena(); } // 本地預估也從現在重算
    huntBaseSave(); renderHuntStats(); toast('掛機統計已重置');
  } catch (e) { console.warn('huntReset', e); }
}
function statsEvent(ev) {
  try {
    try { if (typeof enchantResultEvent === 'function') enchantResultEvent(ev); }
    catch (e) { console.warn('statsEvent enchant', e); }
    if (!ev || !st.inGame) return;
    if (ev.t === 'attack' && ev.target === st.selfId && ev.attacker !== st.selfId) auto.hitBy.set(ev.attacker, performance.now()); // AUTO:打自己的怪優先
    if (ev.t === 'servermsg' && ev.id === 263 && !auto.on) bagFullNotice(); // 11/02 #41
    if (ev.t === 'offlinereport') return;
  } catch (e) { console.warn('statsEvent', e); }
}
let bagFullNoticeAt = 0;
function bagFullNotice() { // 伺服器回 S_ServerMessage 263(背包已滿):告訴玩家含身上裝備的實際數量(買東西按了沒反應的原因)
  const now = Date.now();
  if (now - bagFullNoticeAt < 3000) return;
  bagFullNoticeAt = now;
  toast(`背包已滿(含身上裝備 ${st.inv.size}/${st.inventoryMax || 180}),請先清出空間`);
}
function huntExpSync() {}
function huntAsk() {
  const box = $('#hunt-stats');
  if (!box || box.classList.contains('hidden') || !st.inGame || !st.selfId || !st.ws || st.ws.readyState !== 1
    || hunt.request || Date.now() < hunt.nextAskAt) return;
  hunt.askAt = Date.now(); hunt.request = `${st.selfId}:${hunt.askAt}:${++hunt.requestSeq}`;
  hunt.nextAskAt = hunt.askAt + 60000;
  send({ t: 'huntstats', request: hunt.request });
}
function huntApiResult(ev) {
  try {
    if (!ev || !hunt.request || ev.request !== hunt.request) return;
    hunt.request = null;
    const now = Date.now(), retryAt = Number(ev.retryAt);
    hunt.nextAskAt = Math.max(now + 60000, Number.isFinite(retryAt) ? retryAt : 0) + Math.floor(Math.random() * 5001);
    const p = ev.periods?.session;
    if (ev.ok && ev.charId === st.selfId && p && p.available && !p.pending && ev.sessionStart > 0
      && ['seconds', 'adena', 'spent'].every(k => huntNumber(p[k])) && Array.isArray(p.items)
      && p.items.every(it => it && Number.isSafeInteger(it.itemId) && it.itemId > 0 && huntNumber(it.count) && huntNumber(it.unit))) {
      if (hunt.base && hunt.base.sessionStart !== ev.sessionStart) { hunt.base = null; huntBaseSave(); }
      hunt.api = ev;
      if (hunt.resetPending) { hunt.base = huntSnapshot(ev); hunt.resetPending = false; huntBaseSave(); }
    } else if (ev.ok && ev.charId === st.selfId && ev.sessionStart !== hunt.api?.sessionStart) {
      // 新 session 尚未入帳時也不能繼續顯示上一輪的數字。
      hunt.api = null;
      if (hunt.base && hunt.base.sessionStart !== ev.sessionStart) { hunt.base = null; huntBaseSave(); }
    }
    renderHuntStats();
  } catch (e) { console.warn('huntApiResult', e); }
}
tickEvery(() => {
  try {
    if (hunt.request && Date.now() - hunt.askAt >= 15000) hunt.request = null;
    const box = $('#hunt-stats');
    huntLocalSync();
    if (box && !box.classList.contains('hidden')) { huntAsk(); renderHuntStats(); }
  } catch (e) { console.warn('hunt tick', e); }
}, 1000);
function renderHuntStats() {
  try {
    const box = $('#hunt-stats');
    if (!box || box.classList.contains('hidden')) return;
    const api = hunt.api, p = api?.periods.session, base = hunt.base;
    const rows = box.querySelector('.hs-rows'), items = box.querySelector('.hs-items'), state = box.querySelector('.hs-state');
    const now = Date.now(), L = hunt.loc;
    const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const nextIn = p ? api.flushedAt + HUNT_FLUSH_MS - now : L.since ? L.since + HUNT_FLUSH_MS - now : 0; // 下次入帳還有多久(第一次入帳前最晚是開 AUTO 後 5 分鐘)
    state.textContent = p
      ? `已入帳 ${new Date(api.flushedAt).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })} · ${nextIn > 0 ? `下次更新約 ${Math.max(1, Math.ceil(nextIn / 60000))} 分` : '即將更新'}`
      : L.on ? (nextIn > 0 ? `統計中…第一次更新最晚約 ${mmss(nextIn)} 後` : '統計中…等伺服器入帳') : '尚未入帳(開 AUTO 後約 5 分鐘內第一次更新)';
    state.classList.toggle('on', !!p);
    state.title = p ? `本次開始 ${new Date(api.sessionStart).toLocaleString('zh-TW')}；入帳 ${new Date(api.flushedAt).toLocaleString('zh-TW')}；估價 ${new Date(api.pricesAt).toLocaleString('zh-TW')}。只顯示已入帳資料，不累加尚未入帳部分。${p.startHourIncluded ? '包含開始的整個小時，可能含同小時前一次掛機。' : ''}${p.truncated ? '超出保留期，僅含最近 48 個完整小時與本小時。' : ''}${api.coverageStart > api.sessionStart ? '伺服器記帳開始前的資料未包含。' : ''}` : '伺服器每 5 分鐘入帳，稍後自動更新。';
    const delta = key => Math.max(0, (p?.[key] || 0) - (base?.[key] || 0));
    // 時間:AUTO 開著就用網頁本地計時(每秒跳,不等入帳);沒開就用伺服器已入帳的秒數。重置後從重置那刻重算。
    const locStart = L.since ? Math.max(L.since, hunt.resetAt || 0) : 0;
    const locSec = locStart ? Math.max(0, ((L.on ? now : L.offAt || now) - locStart) / 1000) : 0;
    const seconds = L.on ? Math.max(delta('seconds'), locSec) : (p ? delta('seconds') : locSec), sec = Math.floor(seconds), hours = seconds / 3600;
    // 預估:本地看得到的經驗 / 金幣增量(入帳前先顯示,入帳後以伺服器為準;兩者取大的那個,預估用淡色字)
    const locExp = L.since ? Math.max(0, (st.me?.exp ?? 0) - L.exp0) : 0, locGold = L.since ? adena() - L.gold0 : 0;
    const srvExp = delta('exp'), exp = Math.max(srvExp, L.on || L.offAt ? locExp : 0), expEst = exp > srvExp;
    const list = (p?.items || []).map(it => {
      const count = Math.max(0, it.count - (base?.items[it.itemId] || 0));
      return { ...it, count, value: it.unit * count };
    }).filter(it => it.count > 0).sort((a, b) => b.value - a.value || b.count - a.count);
    const income = delta('adena') + list.reduce((sum, it) => sum + it.value, 0), spent = delta('spent'), net = income - spent;
    const per = value => hours > 0 ? `${fmt(Math.round(value / hours))}/時` : '';
    rows.innerHTML = ''; items.innerHTML = '';
    const pending = !p; // 還沒有第一次入帳:收益 / 花費 / 淨收顯示「統計中…」,不顯示 0
    const netEst = pending && (L.on || L.offAt) ? locGold : null; // 入帳前:金幣淨變化(撿到 - 花掉)當預估
    const fmtSigned = (v) => (v > 0 ? `+${fmt(v)}` : fmt(v));
    for (const [label, value, rate, est] of [
      ['時間', `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`, '', false],
      ['經驗', expEst || (pending && exp > 0) ? `約 ${fmt(exp)}` : (pending && !exp ? '統計中…' : fmt(exp)), per(exp), expEst || (pending && exp > 0) || (pending && !exp)],
      ['收益', pending ? '統計中…' : fmt(income), pending ? '' : per(income), pending],
      ['花費', pending ? '統計中…' : fmt(spent), pending ? '' : per(spent), pending],
      ['淨收', pending ? (netEst === null ? '統計中…' : `約 ${fmtSigned(netEst)}`) : fmt(net), pending ? '' : per(net), pending],
    ]) {
      const row = el('div', 'hs-row');
      const v = el('span', '', value);
      if (est) { v.style.opacity = '.6'; v.title = '預估:網頁看得到的金幣 / 經驗增量;伺服器入帳後(約每 5 分鐘)以伺服器數字為準'; }
      row.append(el('b', '', label), v, el('em', '', rate)); rows.appendChild(row);
    }
    for (const it of list) items.appendChild(el('span', '', `${it.name || '#' + it.itemId} × ${fmt(it.count)} = ${fmt(it.value)}`));
  } catch (e) { console.warn('renderHuntStats', e); }
}
$('#btn-stats').onclick = () => {
  const box = $('#hunt-stats');
  box.classList.toggle('hidden');
  $('#btn-stats').classList.toggle('on', !box.classList.contains('hidden'));
  renderHuntStats();
};
$('#hunt-stats .hs-close').onclick = () => $('#btn-stats').onclick();

// 右上「更多」:統計 / 拍賣 / 死亡紀錄收在裡面(使用者 10/18;AUTO、寶藏不收),點一下展開、再點收起;點了裡面的功能就收起
function setDrawer(open) {
  $('#side-drawer').classList.toggle('hidden', !open);
  $('#btn-more').setAttribute('aria-expanded', String(open));
  $('#btn-more .more-arrow').textContent = open ? '▴' : '▾';
  syncMoreBtn();
}
// 收起來時，裡面有功能開著(例如掛機統計)→「更多」也亮著
function syncMoreBtn() {
  const open = !$('#side-drawer').classList.contains('hidden');
  $('#btn-more').classList.toggle('on', open || !!$('#side-drawer .round.on'));
}
$('#btn-more').onclick = () => setDrawer($('#side-drawer').classList.contains('hidden'));
$('#side-drawer').addEventListener('click', (e) => { if (e.target.closest('.round')) setTimeout(() => setDrawer(false), 0); });
new MutationObserver(syncMoreBtn).observe($('#side-drawer'), { subtree: true, attributes: true, attributeFilter: ['class'] });
$('#btn-deathlog').onclick = () => togglePanel('deathlog');
// 死亡紀錄:這個帳號的角色 + 寵物 / 召喚獸最近 20 筆(gateway 查 web_death_log / web_pet_death_log,噴掉的裝備查 web_item_log)
function renderDeathLog(body) {
  const list = st.deathLog;
  if (list === undefined) { body.appendChild(el('div', 'rank-empty', '讀取中…')); return; }
  if (list === null) { body.appendChild(el('div', 'rank-empty', '暫時查不到，請稍後再試')); return; }
  if (!list.length) { body.appendChild(el('div', 'rank-empty', '目前沒有死亡紀錄')); return; }
  const p2 = (n) => String(n).padStart(2, '0');
  const box = el('div', 'dl-list');
  for (const d of list) {
    const t = new Date(d.at);
    const row = el('div', `dl-row${d.pet ? ' pet' : ''}`);
    const head = el('div', 'dl-head');
    head.append(el('span', 'dl-time', `${t.getMonth() + 1}/${t.getDate()} ${p2(t.getHours())}:${p2(t.getMinutes())}`),
      el('b', '', d.pet ? `${d.pet}「${d.n}」` : d.n), el('span', 'dl-lv', `Lv.${d.lv}`));
    row.appendChild(head);
    const who = d.killer ? `被${d.pc ? '玩家「' + d.killer + '」' : ' ' + d.killer + ' '}殺死` : '死亡';
    row.appendChild(el('div', 'dl-what', `${d.place} · ${who}${d.mode ? ' · ' + d.mode : ''}${d.owner ? ' · 主人 ' + d.owner : ''}`));
    if (d.lost?.length) row.appendChild(el('div', 'dl-lost', `掉落:${d.lost.join('、')}`));
    box.appendChild(row);
  }
  body.appendChild(box);
  body.appendChild(el('div', 'rank-time', '只保留最近 20 筆(角色、寵物各最多 10 筆)'));
}
$('#hunt-stats .hs-reset').onclick = huntReset;

// ---- Ability collections: authority and eligible object IDs always come from Java. ----
const COLLECTION_REWARDS = ['傷害減免', '最大 HP', '最大 MP', '近距離命中', '遠距離命中', '魔法防禦', '魔力回復', '防禦 AC', '近距離傷害', '遠距離傷害', '昏迷耐性']; // 11/14 加第 7 種 MpRegen(Java L1Collection KINDS 同順序)
// 11/10 使用者「收藏的 UI 完全不行,大小等等都不行,難看」→ 主導重做:每組一張卡片 + 材料格(像交易格子),符合的道具自動選好,
// 不用輸入數量、不顯示物件編號;確認改遊戲內確認框。伺服器協定 / 驗證不變(Java 仍重驗全部條件)。
function collectionRewards(d) {
  return Array.isArray(d.rewards) && d.rewards.length ? d.rewards : [{ kind: d.kind, value: d.value }];
}
const collMatName = m => (m.enchant ? `${plusN(m.enchant)} ${m.name}` : String(m.name)).replace(/^祝福的 /, '祝福的'); // +0 不寫;祝福卷軸名稱不留空格
function collectionRewardChips(d) { // 11/16 使用者:「收藏是什麼能力」看不清楚 → 每項能力一個小牌
  const box = el('span', 'coll-rewards');
  for (const r of collectionRewards(d)) { const c = el('span', 'coll-reward'); c.append(el('b', '', COLLECTION_REWARDS[r.kind]), el('i', '', `+${r.value}`)); box.append(c); }
  return box;
}
function collectionRewardText(d) {
  return collectionRewards(d).map(r => `${COLLECTION_REWARDS[r.kind]} +${r.value}`).join('、');
}
const collectionUi = { enabled: false, data: null, selected: 0, mats: {}, pending: null, timer: null, msg: '', confirm: 0, requery: null };
const collectionShown = () => panel.name === 'collection' || (panel.name === 'inv' && panel.tab === 'collection');
function collectionReset() {
  clearTimeout(collectionUi.timer); clearTimeout(collectionUi.requery); clearTimeout(collectionUi.preTimer); collectionUi.preDone = new Set(); collectionUi.preRev = null; collectionUi.req = null;
  Object.assign(collectionUi, { enabled: false, data: null, selected: 0, mats: {}, pending: null, timer: null, msg: '', confirm: 0, requery: null });
  document.getElementById('btn-collection')?.remove();
  if (collectionShown()) { if (panel.name === 'inv') { panel.tab = 'all'; renderPanel(); } else closePanel(); }
}
// 背包變動:不清掉畫面(打怪喝水每秒都會變);面板開著才在 1.5 秒後重查一次材料,送出中不重查
function collectionInventoryChanged() {
  const ui = collectionUi;
  if (!ui.enabled || !collectionShown() || ui.pending) return;
  clearTimeout(ui.requery);
  ui.requery = setTimeout(() => { if (collectionShown() && !ui.pending && ui.selected > 0) collectionQuery(ui.selected); }, 1500);
  renderPanelSoon();
}
function collectionButton() {
  // Until a player chooses, prefer ability regardless of availability arrival order.
  if (!appearanceUi.subChosen) appearanceUi.sub = collectionUi.enabled || !appearanceUi.enabled ? 'ability' : 'appearance';
  document.getElementById('btn-collection')?.remove(); // 11/10:改成背包分頁,不放底部導覽列
  if (!collectionUi.enabled && !appearanceUi.enabled && panel.name === 'inv' && panel.tab === 'collection') { panel.tab = 'all'; renderPanelSoon(); }
  if (panel.name === 'inv') renderPanelSoon(); // 分頁出現 / 消失
}
// 使用者 11/17「為什麼收藏讀取材料會很久」:伺服器 500 ms / gateway 250 ms 內的第二個查詢會被直接丟掉、不回覆;
// 背景預查每 700 ms 一次,玩家點開時常常撞在 500 ms 內 → 那一組一直「讀取材料中…」。改成:所有查詢至少間隔 650 ms,
// 玩家點的那組排最前面(背景預查先停),2.5 秒沒收到材料就自動再問一次(最多 2 次)。
function collectionSendQuery(id, request) {
  const ui = collectionUi; ui.lastSend = performance.now();
  send({ t: 'collection', op: 0, id, rev: 0, request, choices: [] });
}
function collectionQuery(id = collectionUi.selected, tries = 0) {
  const ui = collectionUi; ui.selected = id;
  clearTimeout(ui.preTimer); clearTimeout(ui.qTimer); clearTimeout(ui.qRetry);
  const go = () => {
    if (ui.selected !== id) return;
    collectionSendQuery(id, ui.pending?.request || '');
    collectionPrefetchSoon(); // 玩家自己的查詢優先,背景預查往後排
    if (id > 0 && tries < 2) ui.qRetry = setTimeout(() => {
      const box = ui.mats[id], ok = box && box.slots && box.list.slice(0, box.slots).every(m => m?.ready);
      if (ui.selected === id && collectionShown() && !ui.pending && !ok) collectionQuery(id, tries + 1);
    }, 2500);
  };
  const wait = Math.max(0, (ui.lastSend || -1e9) + 650 - performance.now());
  if (wait > 0) ui.qTimer = setTimeout(go, wait); else go();
  if (collectionShown()) renderPanelSoon();
}
// 使用者 11/16:「可存入」要點開過才顯示 → 面板開著時,在背景把其他還沒完成的組各查**一次**(一次一組、間隔 700 ms,
// 伺服器 500 ms 內只收一次查詢),只為了記下「這一組要什麼材料」(collectionUi.req)。
// 使用者同日:人多會不會 lag → 之後收合的卡片一律用網頁自己手上的背包資料算(collectionLocalCount),背包變動不再問伺服器;
// 每位玩家每次登入最多問「未完成的組數」次。展開的那一組仍照舊問伺服器(要拿可扣的物件),存入時伺服器照樣全部重驗。
function collectionReq(id) { const ui = collectionUi; return ui.req && ui.req.rev === ui.data?.rev ? ui.req.map[id] : null; }
// 本機估算:背包裡符合這格材料的數量(名稱、強化值、祝福 / 一般、未裝備、未上鎖)。只用來顯示,不是存入的依據。
function collectionLocalCount(m) {
  const blessed = /^祝福的 /.test(m.name), want = m.name.replace(/^祝福的 /, '');
  let n = 0;
  for (const it of st.inv.values()) {
    if (isEquipped(it) || isLocked(it) || (it.bless ?? 1) !== (blessed ? 0 : 1) || baseName(it) !== want) continue;
    const e = /^([+-]\d+)\s/.exec(it.name);
    if ((e ? +e[1] : 0) === m.enchant) n += it.count || 1;
  }
  return n;
}
function collectionPrefetchSoon(ms = 900) {
  const ui = collectionUi; clearTimeout(ui.preTimer);
  ui.preTimer = setTimeout(collectionPrefetch, ms);
}
function collectionPrefetch() {
  const ui = collectionUi; clearTimeout(ui.preTimer);
  if (!ui.enabled || !ui.data || !collectionShown() || ui.pending) return;
  if (ui.preRev !== ui.data.rev) { ui.preRev = ui.data.rev; ui.preDone = new Set(); }
  const next = (ui.data.collections || []).find(d => !d.done && d.id !== ui.selected && !ui.preDone.has(d.id) && !collectionReq(d.id));
  if (!next) return;
  const wait = (ui.lastSend || -1e9) + 650 - performance.now();
  if (wait > 0) { ui.preTimer = setTimeout(collectionPrefetch, wait); return; }
  ui.preDone.add(next.id);
  collectionSendQuery(next.id, '');
  ui.preTimer = setTimeout(collectionPrefetch, 700);
}
function collectionEvent(ev) {
  const ui = collectionUi;
  if (ev.status === 'availability') {
    ui.enabled = ev.enabled === true; collectionButton();
    if (!ui.enabled) { ui.data = null; ui.msg = '收藏暫停開放。'; }
  } else if (ev.status === 'list') {
    ui.enabled = ev.enabled === true; collectionButton();
    if (ui.data?.rev !== ev.rev) ui.mats = {};
    ui.data = ev;
    if (ui.pending && ev.collections?.find(d => d.id === ui.pending.id)?.done) {
      clearTimeout(ui.timer); ui.pending = null; ui.msg = '已完成，未重複扣料。';
    }
    // 第一次打開:自動展開第一組還沒完成的
    if (!ui.selected) {
      const first = (ev.collections || []).find(d => !d.done) || (ev.collections || [])[0];
      if (first) { ui.selected = first.id; setTimeout(() => collectionQuery(first.id), 600); } // gateway 250 ms、伺服器 500 ms 內只收一次查詢
    } else if (ev.id === ui.selected) ui.mats[ev.id] = { slots: 0, list: [] };
  } else if (ev.status === 'material') {
    if (ev.rev !== ui.data?.rev || !Number.isInteger(ev.slot) || ev.slot < 0 || ev.slot >= 16) return;
    const box = ui.mats[ev.id] || (ui.mats[ev.id] = { slots: 0, list: [] });
    if (ev.append && box.list[ev.slot]) box.list[ev.slot].candidates.push(...ev.material.candidates);
    else box.list[ev.slot] = ev.material;
    box.list[ev.slot].ready = ev.last === true; box.slots = ev.slots;
    if (box.slots && box.list.length >= box.slots && box.list.slice(0, box.slots).every(m => m?.ready)) { // 整組到齊:記下需求(不含候選物件)
      if (!ui.req || ui.req.rev !== ev.rev) ui.req = { rev: ev.rev, map: {} };
      ui.req.map[ev.id] = box.list.slice(0, box.slots).map(m => ({ name: m.name, enchant: m.enchant, need: m.need }));
    }
  } else {
    if (ui.pending && ev.request !== ui.pending.request) return;
    ui.msg = ev.msg || '請重新查詢收藏。';
    if (ev.status === 'uncertain') { if (ui.pending) ui.pending.uncertain = true; }
    else { clearTimeout(ui.timer); ui.pending = null; }
    if (ev.status === 'completed') { ui.msg = '收藏完成！'; collectionQuery(ev.id); }
    if (ev.status === 'disabled') { ui.enabled = false; collectionButton(); }
    toast(ui.msg);
  }
  if (collectionShown()) renderPanelSoon();
}
// 每格材料自動挑:本人背包、未裝備、未上鎖的候選物件,湊到需要數量(伺服器會再驗一次)
function collectionPick(m) {
  const picks = []; let left = m.need;
  for (const c of m.candidates || []) {
    if (left <= 0) break;
    const it = st.inv.get(c.id);
    if (!it || isEquipped(it) || st.locks?.has(c.id)) continue;
    const n = Math.min(left, c.count, it.count || c.count);
    if (n > 0) { picks.push({ id: c.id, count: n }); left -= n; }
  }
  return { picks, ok: left <= 0, have: m.need - Math.max(0, left) };
}
const plusN = (n) => `${n >= 0 ? '+' : ''}${n}`;
function renderAbilityCollection(body, foot, inBag = false) {
  const ui = collectionUi, data = ui.data;
  // Collection wrapper owns the sub-tabs; ability content below is unchanged.
  if (!ui.enabled) { body.append(el('p', 'coll-empty', '收藏暫停開放。')); return; }
  const refresh = el('button', 'learn', ui.pending ? '查詢結果' : '重新整理');
  refresh.type = 'button'; refresh.onclick = () => collectionQuery(); foot.append(refresh);
  if (!data) { body.append(el('p', 'coll-empty', '正在讀取收藏…')); return; }
  const root = el('div', 'coll');
  // 目前加成
  const sum = el('div', 'coll-sum');
  const doneN = (data.collections || []).filter(d => d.done).length;
  sum.append(el('span', 'coll-sum-t', `已獲得的收藏能力(完成 ${doneN} / ${(data.collections || []).length} 組)`));
  const totals = (data.totals || []).map((v, i) => [i, v]).filter(([, v]) => v > 0);
  const grid = el('div', 'coll-sum-grid');
  if (totals.length) for (const [i, v] of totals) { const c = el('span', 'coll-chip'); c.append(el('b', '', COLLECTION_REWARDS[i]), el('i', '', `+${v}`)); grid.append(c); }
  else grid.append(el('span', 'coll-chip none', '還沒有,存入下面任一組就會獲得'));
  sum.append(grid);
  root.append(sum);
  root.append(el('p', 'coll-note', '交出整組道具換永久能力,道具會消失、不能取回。PvE / PvP 都有效。'));
  if (ui.pending) root.append(el('p', 'coll-msg warn', `結果確認中…(客服編號 ${ui.pending.request.slice(0, 8)})`));
  else if (ui.msg) root.append(el('p', 'coll-msg', ui.msg));
  // 使用者 11/16:收藏要能篩選 已完成 / 未完成(這台裝置記住上次選的)
  const all = data.collections || [], doneAll = all.filter(d => d.done).length;
  const mode = ['all', 'todo', 'done'].includes(ui.filter) ? ui.filter : (ui.filter = store.get('collFilter', 'all'));
  if (all.length) {
    const bar = el('div', 'coll-filter'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', '篩選收藏');
    for (const [id, label, n] of [['all', '全部', all.length], ['todo', '未完成', all.length - doneAll], ['done', '已完成', doneAll]]) {
      const fb = el('button', `clan-btn${mode === id ? ' on' : ''}`, `${label} ${n}`); fb.type = 'button';
      fb.setAttribute('role', 'tab'); fb.setAttribute('aria-selected', String(mode === id));
      fb.onclick = () => { ui.filter = id; store.set('collFilter', id); ui.confirm = 0; renderPanel(); };
      bar.append(fb);
    }
    root.append(bar);
  }
  const shown = all.filter(d => mode === 'all' || (mode === 'done') === !!d.done);
  for (const d of shown) root.append(collectionCard(d, data));
  if (!all.length) root.append(el('p', 'coll-empty', '目前沒有開放的收藏。'));
  else if (!shown.length) root.append(el('p', 'coll-empty', mode === 'done' ? '還沒有完成的收藏。' : '全部都完成了。'));
  body.append(root);
}
function collectionCard(d, data) {
  const ui = collectionUi, open = d.id === ui.selected, box = ui.mats[d.id];
  const mats = box && box.slots ? box.list.slice(0, box.slots) : [];
  const loaded = mats.length && mats.every(m => m?.ready);
  const picks = loaded ? mats.map(collectionPick) : [];
  const okCount = picks.filter(p => p.ok).length;
  const card = el('div', `coll-card${open ? ' open' : ''}${d.done ? ' done' : ''}${collectionRewards(d).length > 1 ? ' multi-reward' : ''}`);
  const head = el('button', 'coll-head'); head.type = 'button';
  const req = !open && !d.done ? collectionReq(d.id) : null; // 收合的卡片:用本機背包算,隨背包即時更新
  const total = req ? req.length : mats.length, okN = req ? req.filter(m => collectionLocalCount(m) >= m.need).length : okCount;
  const known = !!req || loaded;
  const status = d.done ? '✓ 已獲得' : known ? (okN === total ? '可存入' : `材料 ${okN} / ${total}`) : '';
  const top = el('span', 'coll-top');
  top.append(el('span', 'coll-name', d.name),
    el('span', `coll-status${d.done ? ' done' : known && okN === total ? ' ready' : ''}`, status), el('span', 'coll-arrow', open ? '▾' : '▸'));
  const line = el('span', 'coll-line'); line.append(el('span', 'coll-get', d.done ? '已獲得' : '存入獲得'), collectionRewardChips(d));
  head.append(top, line);
  head.onclick = () => { ui.confirm = 0; if (open) { ui.selected = -1; renderPanel(); } else collectionQuery(d.id); };
  card.append(head);
  if (!open) return card;
  if (!loaded) { card.append(el('p', 'coll-empty', '讀取材料中…')); return card; }
  // 材料格
  const grid = el('div', 'coll-slots');
  mats.forEach((m, i) => {
    const p = picks[i], cell = el('div', `coll-slot${d.done ? ' done' : p.ok ? ' ok' : ' miss'}`);
    cell.title = `${collMatName(m)}${m.need > 1 ? ` ×${m.need}` : ''}`;
    cell.append(iconCanvas(/^祝福的 /.test(m.name) ? { name: m.name.replace(/^祝福的 /, ''), gfx: m.gfx, bless: 0 } : { name: m.name, gfx: m.gfx }, 30)); // 祝福卷軸:用背包同一套金色光暈
    if (m.enchant) cell.append(el('i', 'coll-plus', plusN(m.enchant)));
    if (m.need > 1) cell.append(el('i', 'coll-cnt', `${Math.min(p.have, m.need)}/${m.need}`));
    cell.onclick = () => toast(`${cell.title}:${d.done ? '已收藏' : p.ok ? '背包有,已自動選好' : '背包沒有符合的'}`);
    const wrap = el('div', 'coll-item'); wrap.append(cell, el('span', 'coll-iname', String(m.name).replace(/^祝福的 /, '祝福的'))); grid.append(wrap);
  });
  card.append(grid);
  const ens = [...new Set(mats.filter(m => !/^祝福的 /.test(m.name)).map(m => m.enchant))]; // 祝福卷軸不算強化值條件
  card.append(el('p', 'coll-cond', `條件:${mats.some(m => /^祝福的 /.test(m.name)) ? '裝備' : ''}${ens.length === 1 ? `各 ${plusN(ens[0])}` : '強化值如格子'}、非祝福 / 詛咒`)); // 11/10 使用者:條件寫短,無屬性不用寫
  if (d.done) return card;
  const rewards = collectionRewards(d);
  const capped = rewards.find(r => (data.totals[r.kind] || 0) + r.value > (data.caps[r.kind] ?? Infinity));
  const all = picks.every(p => p.ok);
  let why = '';
  if (!all) why = `還缺:${mats.filter((m, i) => !picks[i].ok).map(m => `${collMatName(m)}`).join('、')}`;
  else if (capped) why = `${COLLECTION_REWARDS[capped.kind]}的收藏加成將超過上限。`;
  else if (!data.eligible) why = '請在安全區、關閉 AUTO,且不在交易中。';
  if (ui.confirm === d.id && !why && !ui.pending) {
    const c = el('div', 'tp-confirm coll-confirm');
    c.append(el('p', 'tp-q', `會永久消耗 ${mats.map(m => `${collMatName(m)}${m.need > 1 ? ` ×${m.need}` : ''}`).join('、')},不能取回。`),
      el('p', 'coll-after-t', '存入後你的收藏能力:'));
    const tbl = el('div', 'coll-after');
    for (const r of rewards) { const cur = data.totals[r.kind] || 0, row = el('div', 'coll-after-row'); row.append(el('span', 'k', COLLECTION_REWARDS[r.kind]), el('span', 'v', `+${cur}`), el('span', 'a', '→'), el('span', 'n', `+${cur + r.value}`)); tbl.append(row); }
    c.append(tbl);
    const row = el('div', 'coll-yn'), yes = el('button', 'learn', '確定存入'), no = el('button', 'learn', '取消');
    yes.type = no.type = 'button';
    yes.onclick = () => { yes.disabled = true; ui.confirm = 0; collectionSubmit(d, data, picks); };
    no.onclick = () => { ui.confirm = 0; renderPanel(); };
    row.append(yes, no); c.append(row); card.append(c);
    return card;
  }
  const act = el('div', 'coll-act');
  if (why) act.append(el('span', 'coll-why', why));
  const btn = el('button', 'learn coll-go', ui.pending ? '確認中…' : '存入'); btn.type = 'button';
  btn.disabled = !!why || !!ui.pending;
  btn.onclick = () => { ui.confirm = d.id; renderPanel(); };
  act.append(btn); card.append(act);
  return card;
}
function collectionSubmit(d, data, picks) {
  const ui = collectionUi;
  if (ui.pending) return;
  const choices = picks.map(p => p.picks);
  const bytes = crypto.getRandomValues(new Uint8Array(16)), request = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  ui.pending = { id: d.id, request }; ui.msg = '';
  // 11/21:gateway 250 ms 內的第二則 collection 訊息會被直接丟掉、不回覆 → 存入撞到背景查詢就永遠「結果待確認」。先停掉排隊的查詢,和上一則至少隔 400 ms 才送
  clearTimeout(ui.preTimer); clearTimeout(ui.qTimer); clearTimeout(ui.qRetry); clearTimeout(ui.requery);
  const go = () => {
    if (ui.pending?.request !== request) return;
    ui.lastSend = performance.now();
    ui.timer = setTimeout(() => { if (ui.pending?.request === request) { ui.pending.uncertain = true; ui.msg = `結果待確認,請按「查詢結果」或聯絡客服(編號 ${request.slice(0, 8)})。`; if (collectionShown()) renderPanel(); } }, 10000);
    send({ t: 'collection', op: 1, id: d.id, rev: data.rev, request, choices });
  };
  const wait = Math.max(0, (ui.lastSend || -1e9) + 400 - performance.now());
  if (wait > 0) setTimeout(go, wait); else go();
  renderPanel();
}

// ---- Appearance collection: all rights and current selection come from Java. ----
const appearanceUi = { enabled: false, sub: 'ability', subChosen: false, data: null, seq: null, pending: false,
  timer: null, dispatch: null, lastSent: 0, msg: '', blocked: false, selected: 0, effective: 0, confirm: null, levelEnabled: false, levelDirty: false };
function appearanceReset() {
  clearTimeout(appearanceUi.timer); clearTimeout(appearanceUi.dispatch);
  Object.assign(appearanceUi, { enabled: false, sub: 'ability', subChosen: false, data: null, seq: null, pending: false,
    timer: null, dispatch: null, lastSent: 0, msg: '', blocked: false, selected: 0, effective: 0, confirm: null, levelEnabled: false, levelDirty: false });
}
function collectionOpen() {
  if (appearanceUi.enabled && (appearanceUi.sub === 'appearance' || !collectionUi.enabled)) appearanceRequest(2);
  else collectionQuery(collectionUi.selected > 0 ? collectionUi.selected : 0);
}
function appearanceRequest(op, gfx = 0, price = 0) {
  const ui = appearanceUi;
  if (!ui.enabled || ui.dispatch || ((op === 3 || op === 4) && ui.pending)) return;
  if (op === 3 || op === 4) { ui.pending = true; ui.confirm = null; }
  ui.msg = op === 4 ? '正在購買外觀…' : op === 3 ? '正在更新外觀…' : '正在查詢外觀…';
  // Match the gateway limiter. A queued click is cancelled on character reset.
  const delay = Math.max(0, 275 - (Date.now() - ui.lastSent));
  ui.dispatch = setTimeout(() => {
    ui.dispatch = null; ui.lastSent = Date.now();
    send({ t: 'appearance', op, gfx, ...(op === 4 ? { price } : {}) });
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => {
      ui.msg = '尚未收到結果，請按「重新整理」查詢。';
      // Keep apply disabled until an authoritative list; never resend a mutation.
      if (collectionShown()) renderPanelSoon();
    }, 10000);
  }, delay);
  if (collectionShown()) renderPanelSoon();
}
function appearanceLevelChanged(before, level) {
  const ui = appearanceUi;
  if (before == null || before === level || !ui.enabled || !ui.levelEnabled || !collectionShown() || ui.sub !== 'appearance') return;
  if (ui.pending || ui.dispatch) ui.levelDirty = true;
  else appearanceRequest(2); // Refresh authority on level change, never grant rights in the browser.
}
function appearanceEvent(ev) {
  const ui = appearanceUi, seq = ev.seq >>> 0;
  if (ui.seq != null && ((seq - ui.seq) >>> 0) >= 0x80000000) return;
  ui.seq = seq;
  const wasEnabled = ui.enabled;
  ui.enabled = ev.enabled === true;
  if ('levelEnabled' in ev) ui.levelEnabled = ev.levelEnabled;
  if ('blocked' in ev) ui.blocked = ev.blocked;
  if ('selected' in ev) ui.selected = ev.selected;
  if ('effective' in ev) ui.effective = ev.effective;
  if (ev.status === 'list') {
    ui.data = ev.forms; ui.pending = false; ui.msg = ev.message || '';
    if (ui.confirm && !ui.data.some(f => f.gfx === ui.confirm.gfx && !f.unlocked && !f.pending && f.price === ui.confirm.price)) ui.confirm = null;
    clearTimeout(ui.timer);
  } else if (ev.status !== 'availability') {
    clearTimeout(ui.timer); ui.msg = ev.message || '外觀操作未完成。';
    // An explicit denial ends the request. Ambiguous errors require a fresh query.
    if (ev.status === 'rejected' || ev.status === 'disabled') ui.pending = false;
  }
  if (!ui.enabled) {
    clearTimeout(ui.timer); clearTimeout(ui.dispatch); ui.dispatch = null;
    ui.pending = false; ui.data = null; ui.confirm = null; ui.levelDirty = false;
  }
  if (ui.levelDirty && !ui.pending && !ui.dispatch) { ui.levelDirty = false; appearanceRequest(2); }
  collectionButton();
  if (collectionShown() || (wasEnabled !== ui.enabled && panel.name === 'inv')) renderPanelSoon();
}
function renderCollection(body, foot, inBag = false) {
  const ui = appearanceUi;
  if (!inBag) setTabs([]);
  if (!ui.enabled) return renderAbilityCollection(body, foot, inBag);
  if (!collectionUi.enabled) { ui.sub = 'appearance'; return renderAppearanceCollection(body, foot); } // 11/11 能力收藏沒開:只有外觀,不顯示子分頁
  const tabs = el('div', 'coll-subtabs'); tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '收藏種類');
  for (const [id, label] of [['ability', '能力'], ['appearance', '外觀']]) {
    const b = el('button', `clan-btn${ui.sub === id ? ' on' : ''}`, label);
    b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(ui.sub === id));
    b.onclick = () => {
      ui.subChosen = true;
      if (ui.sub === id) return;
      ui.sub = id;
      if (id === 'appearance') appearanceRequest(2); else collectionQuery(collectionUi.selected > 0 ? collectionUi.selected : 0);
      renderPanelSoon();
    };
    tabs.append(b);
  }
  body.append(tabs);
  if (ui.sub === 'appearance') renderAppearanceCollection(body, foot);
  else renderAbilityCollection(body, foot, inBag);
}
// 外觀立繪(11/11):有高解析圖的外觀顯示 assets/appearance/<gfx>.webp(本地 ComfyUI 以原圖重繪,384×384);沒有圖或載入失敗就退回即時畫的待機動畫。
const APPEARANCE_ART = new Set([7847, 8913, 12331, 12337]);
function appearancePortrait(gfx) {
  if (!APPEARANCE_ART.has(gfx)) return appearanceSprite(gfx);
  const img = new Image();
  img.className = 'appearance-portrait appearance-art'; img.alt = '外觀預覽'; img.decoding = 'async'; img.width = 112; img.height = 112;
  img.onerror = () => { if (img.isConnected) img.replaceWith(appearanceSprite(gfx)); };
  img.src = `assets/appearance/${gfx}.webp?v=1`;
  return img;
}
function appearanceSprite(gfx) {
  const canvas = document.createElement('canvas');
  canvas.className = 'appearance-portrait'; canvas.width = 112; canvas.height = 112;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', '外觀動畫預覽');
  let last = 0, failures = 0;
  const paint = now => {
    if (!canvas.isConnected || canvas.closest('.hidden')) return;
    if (now - last >= 100 && !document.hidden) {
      last = now;
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 112, 112);
      let drawn = false;
      for (const weapon of [0, 20, 4, 50, 24, 40, 46, 54, 58, 62]) {
        if (L1S.drawFigure(ctx, { gfx, kind: 'pc', weapon }, 56, 106, 94, now)) { drawn = true; break; }
      }
      if (!drawn) {
        ctx.fillStyle = '#b6a27a'; ctx.textAlign = 'center'; ctx.font = '12px sans-serif';
        ctx.fillText(++failures >= 150 ? '預覽暫時無法載入' : '載入預覽…', 56, 58);
        if (failures >= 150) return;
      } else failures = 0;
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint); return canvas;
}
function renderAppearanceCollection(body, foot) {
  const ui = appearanceUi, root = el('div', `coll appearance-collection${ui.levelEnabled || ui.data?.some(f => f.price > 0) ? ' appearance-expanded' : ''}`);
  const refresh = el('button', 'learn', '重新整理'); refresh.type = 'button';
  refresh.onclick = () => appearanceRequest(2); foot.append(refresh);
  const restore = el('button', 'learn', '還原'); restore.type = 'button'; restore.disabled = ui.pending;
  restore.onclick = () => appearanceRequest(3, 0); foot.append(restore);
  root.append(el('p', 'coll-note', '只改外觀，速度與能力依照實際變身。解鎖資格綁定角色。'));
  if (ui.blocked) root.append(el('p', 'coll-msg warn', '這裡不能更換外觀；可以查看收藏或還原。'));
  if (ui.msg) { const msg = el('p', 'coll-msg'); msg.setAttribute('role', 'status'); msg.textContent = ui.msg; root.append(msg); }
  if (!ui.data) root.append(el('p', 'coll-empty', '正在讀取外觀收藏…'));
  else {
    root.append(el('div', 'coll-sum', `已解鎖 ${ui.data.filter(f => f.unlocked).length} / ${ui.data.length}`));
    const grid = el('div', 'appearance-grid');
    for (const form of ui.data) {
      const selected = ui.selected === form.gfx, active = ui.effective === form.gfx;
      const card = el('div', `coll-card appearance-card${selected ? ' open' : ''}`);
      card.append(appearancePortrait(form.gfx), el('b', 'appearance-name', form.name));
      card.append(el('span', 'appearance-state', active ? '穿著中' : selected ? '已選擇（暫停顯示）' : form.pending ? '解鎖待確認' : form.unlocked ? '已解鎖' : form.unlockType === 'level' ? `Lv ${form.minLevel} 解鎖` : '未解鎖'));
      if (form.unlocked) {
        const apply = el('button', 'clan-btn', selected ? '已套用' : '套用'); apply.type = 'button';
        apply.disabled = ui.pending || ui.blocked || selected;
        apply.onclick = () => appearanceRequest(3, form.gfx); card.append(apply);
      } else if (form.unlockType === 'level') {
        card.append(el('span', 'coll-note', '達到等級自動解鎖'));
      } else if (!form.pending && Number.isInteger(form.price) && form.price > 0) {
        card.append(el('span', 'appearance-price', `${form.price.toLocaleString('zh-TW')} 金幣`));
        const confirming = ui.confirm?.gfx === form.gfx && ui.confirm.price === form.price;
        if (confirming) card.append(el('span', 'coll-note', '確認購買並解鎖此角色？'));
        const actions = el('div', 'appearance-actions');
        const buy = el('button', 'clan-btn', confirming ? '確認購買' : '購買'); buy.type = 'button'; buy.disabled = ui.pending;
        buy.onclick = () => {
          if (ui.pending) return;
          if (confirming) appearanceRequest(4, form.gfx, form.price);
          else { ui.confirm = { gfx: form.gfx, price: form.price }; renderPanelSoon(); }
        };
        actions.append(buy);
        if (confirming) {
          const cancel = el('button', 'clan-btn', '取消'); cancel.type = 'button';
          cancel.onclick = () => { ui.confirm = null; renderPanelSoon(); }; actions.append(cancel);
        }
        card.append(actions);
      } else card.append(el('span', 'coll-note', form.pending ? '請聯絡 GM 查核解鎖結果' : '用外觀解鎖卡解鎖'));
      grid.append(card);
    }
    if (!ui.data.length) root.append(el('p', 'coll-empty', '目前沒有開放的外觀。'));
    root.append(grid);
  }
  body.append(root);
}

// Catchup uses numeric-only ##CATCHUP## snapshots from Java; no user content is interpreted as HTML.
let catchupInfo = null, catchupAt = 0, catchupPending = false, catchupTimeout = null, catchupRateAt = -1e9, catchupRateTimer = null, catchupLockUntil = 0;
function catchupTime(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`; // 使用者 11/15:「70:04」看不出單位
}
function catchupBalance() {
  const j = catchupInfo;
  return j ? Math.max(0, j.balance - (j.active ? (performance.now() - catchupAt) * Math.max(0, j.rate - 2) : 0)) : 0;
}
function catchupRate() {
  const j = catchupInfo;
  return j && j.chosen >= 3 && j.max >= 3 ? Math.min(j.chosen, j.max) : 0;
}
function catchupLeft() {
  const rate = catchupRate();
  return rate >= 3 ? catchupBalance() / (rate - 2) : 0;
}
function catchupPoints(balance) { return (balance / 3600000).toFixed(2).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'); }
function clearCatchup() {
  catchupInfo = null; catchupPending = false; clearTimeout(catchupTimeout);
  const status = $('#catchup-status'), dialog = $('#catchup-dialog');
  if (status) status.hidden = true;
  if (dialog) dialog.hidden = true;
}
function openCatchup() {
  if (!st.eventHunt?.catchup || !st.inGame) return;
  $('#catchup-dialog').hidden = false;
  $('#catchup-body').textContent = '讀取追趕加成…';
  $('#catchup-close').focus();
  send({ t: 'catchup', op: 0 });
  clearTimeout(catchupTimeout);
  catchupTimeout = setTimeout(() => { if (!$('#catchup-dialog').hidden) { catchupPending = false; $('#catchup-body').textContent = '沒有收到回應，請關閉後稍後再試。'; } }, 8000);
}
function onCatchup(j) {
  if (!j || !st.inGame || !st.eventHunt?.catchup || j.id !== st.selfId) return;
  if (!Number.isSafeInteger(j.balance) || j.balance < 0 || !Number.isInteger(j.max) || j.max > 255 || !Number.isInteger(j.level)) return;
  catchupInfo = { ...j, who: st.myName }; catchupAt = performance.now();
  catchupPending = false; clearTimeout(catchupTimeout);
  if (j.popup) $('#catchup-dialog').hidden = false;
  if (!$('#catchup-dialog').hidden) renderCatchup();
  renderCatchupStatus();
}
function catchupLockHint(text) { const c = $('#catchup-cool'); if (c) { c.textContent = text; c.classList.add('catchup-note'); catchupLockUntil = performance.now() + 4000; } toast(text); } // toast 在視窗底下會被遮住,所以也寫在按鈕下面那一行
function catchupCooling() { return performance.now() - catchupRateAt < 3200; }
function catchupCoolText() {
  const c = $('#catchup-cool'); if (!c) return;
  if (performance.now() < catchupLockUntil) return; c.classList.remove('catchup-note');
  const left = Math.ceil((3200 - (performance.now() - catchupRateAt)) / 1000);
  c.textContent = left > 0 ? `已更換倍率，${left} 秒後才能再更換` : '更換倍率後要等 3 秒才能再更換';
}
function catchupRequest(action) {
  if (catchupPending) return;
  catchupPending = true;
  for (const tag of ['button', 'input', 'select']) $('#catchup-body').querySelectorAll(tag).forEach(e => { e.disabled = true; });
  send(action); clearTimeout(catchupTimeout);
  catchupTimeout = setTimeout(() => { catchupPending = false; send({ t: 'catchup', op: 0 }); }, 8000);
}
function renderCatchupStatus() {
  const b = $('#catchup-status'), j = catchupInfo;
  if (!b) return;
  b.hidden = !j || !j.inside || !st.inGame || j.who !== st.myName || !st.eventHunt?.catchup;
  if (!j) return;
  const balance = catchupBalance(), rate = catchupRate();
  b.textContent = rate >= 3 && balance > 0 ? `追趕 +${(rate - 1) * 100}% ${catchupTime(catchupLeft()).replace(/ 小時 /, '時').replace(/ 分$/, '分')}` : '追趕加成';
  if (!$('#catchup-dialog').hidden) {
    const points = $('#catchup-points'); if (points) points.textContent = `追趕點數 ${catchupPoints(balance)} 點（上限 ${j.maxPoints}）`;
    const clock = $('#catchup-remaining');
    if (clock) clock.textContent = rate >= 3 && balance > 0
      ? `目前 經驗 +${(rate - 1) * 100}%（含經驗獵場），每小時扣 ${rate - 2} 點，約可用 ${catchupTime(catchupLeft())}${j.active ? '' : '（暫停）'}`
      : (j.chosen < 3 ? '目前不開，不扣點' : balance <= 0 ? '點數用完，加成停止' : '目前等級無追趕資格，不扣點');
  }
}
function renderCatchup() {
  const j = catchupInfo, body = $('#catchup-body');
  if (!j || !body) return;
  body.textContent = '';
  body.append(el('p', '', `標竿 ${j.benchmark} 級 · 你 ${j.level} 級 · 落後 ${Math.max(0, j.benchmark - j.level)} 級`));
  const points = el('p', 'catchup-points'); points.id = 'catchup-points'; body.append(points);
  const clock = el('p'); clock.id = 'catchup-remaining'; body.append(clock);
  const choices = el('div', 'catchup-choices');
  for (const rate of [2, 3, 4, 5]) {
    const b = el('button', rate === j.chosen ? 'selected' : '', rate === 2 ? '不開' : `經驗 +${(rate - 1) * 100}%`);
    b.appendChild(el('small', 'catchup-cost', rate === 2 ? '不扣點' : `每小時 ${rate - 2} 點`)); // 使用者 11/16:沒開、在獵場外也要看得到每個倍率扣幾點
    // 沒資格全部鎖住;超過目前等級可開的倍率也不能選,但點下去要有提示(使用者 11/15)→ 用 locked 樣式而不是 disabled
    const locked = j.max < 3 || rate > j.max;
    b.type = 'button'; b.disabled = !locked && (catchupPending || !j.ready || catchupCooling());
    b.classList.toggle('locked', locked);
    b.setAttribute?.('aria-pressed', String(rate === j.chosen));
    // 伺服器 3 秒內只收一次換倍率:換完鎖 3 秒並顯示倒數(使用者 11/15:要顯示 3 秒後才能再更換)
    b.onclick = () => {
      if (b.classList.contains('locked')) {
        const gap = Math.max(0, j.benchmark - j.level);
        catchupLockHint(j.max < 3 ? `你只落後標竿 ${gap} 級(標竿 ${j.benchmark} 級),不能使用追趕加成;點數會保留` : `你落後標竿 ${gap} 級,目前最高只能開到 經驗 +${(j.max - 1) * 100}%`);
        return;
      }
      if (catchupPending || catchupCooling()) return;
      catchupRateAt = performance.now();
      catchupRequest({ t: 'catchup', op: 3, rate });
      clearTimeout(catchupRateTimer);
      catchupRateTimer = setTimeout(() => { if (!$('#catchup-dialog').hidden) renderCatchup(); }, 3250);
    };
    choices.append(b);
  }
  body.append(choices);
  { const cool = el('p', 'hint'); cool.id = 'catchup-cool'; body.append(cool); catchupCoolText(); }
  if (j.max >= 3 && j.max < j.chosen && j.chosen >= 3) body.append(el('p', 'catchup-note', `目前等級最高只能到 經驗 +${Math.max(0, (Math.max(2, j.max) - 1) * 100)}%`));
  const itemName = j.itemId === 40048 ? '品質鑽石' : `道具 ${j.itemId}`;
  body.append(el('p', '', `身上${itemName} ${fmt(j.items)}(不含刻印) · 金幣 ${fmt(j.gold)}`));
  if (j.sealedOnly) body.append(el('p', 'catchup-note', '刻印的品質鑽石不能用來付款。'));
  const renewRow = el('div', 'catchup-renew'), renewLabel = el('label'), renewCheck = el('input');
  renewCheck.type = 'checkbox'; renewCheck.checked = !!j.autoRenew;
  renewLabel.append(renewCheck, el('span', '', '自動續費')); renewRow.append(renewLabel);
  const renewSelect = el('select');
  ['只用品質鑽石', '只用金幣', '品質鑽石優先'].forEach((name, value) => {
    const option = el('option', '', name); option.value = String(value); renewSelect.append(option);
  });
  renewSelect.value = String(j.renewPay || 0); renewSelect.setAttribute?.('aria-label', '自動續費付款方式');
  renewRow.append(renewSelect); body.append(renewRow);
  renewCheck.onchange = renewSelect.onchange = () => catchupRequest({ t: 'catchup', op: 2, autoRenew: renewCheck.checked ? 1 : 0, renewPay: Number(renewSelect.value) });
  if (!j.ready || !j.benchmark) body.append(el('p', 'catchup-note', '追趕加成目前無法使用。'));
  else if (j.max < 3) body.append(el('p', 'catchup-note', '目前接近標竿，無追趕資格；點數保留。'));
  else if (!j.inside) body.append(el('p', 'catchup-note', '請進入經驗獵場購買；場外不扣點。'));
  const purchases = el('div', 'catchup-purchases');
  for (const units of [1, 2, 3]) {
    const row = el('div', 'catchup-purchase-row'), gained = units * j.pointsPerUnit, after = catchupBalance() / 3600000 + gained;
    row.append(el('span', '', `買 ${units} 份（${gained} 點）\n${after > j.maxPoints ? `超過上限 ${j.maxPoints} 點` : `買後 ${catchupPoints(after * 3600000)} 點`}`));
    for (const pay of [0, 1]) {
      const price = units * (pay ? j.goldPrice : j.itemCount);
      const b = el('button', '', pay ? `${fmt(price)} 金幣` : `${fmt(price)} ${itemName}`); b.type = 'button';
      b.disabled = !j.ready || j.max < 3 || !j.inside || catchupPending || after > j.maxPoints || (pay ? j.gold : j.items) < price;
      b.onclick = () => {
        if (catchupPending) return;
        if (!window.confirm(`購買 ${units} 份追趕點數（${gained} 點），支付 ${fmt(price)} ${pay ? '金幣' : itemName}？`)) return;
        catchupRequest({ t: 'catchup', op: 1, units, pay });
      };
      row.append(b);
    }
    purchases.append(row);
  }
  body.append(purchases);
  const details = el('details'), summary = el('summary', '', '說明'); details.append(summary);
  details.append(el('p', '', `每份 ${j.pointsPerUnit} 點。追趕多加 +100% 每小時用 1 點；場外、無資格或不開皆暫停。倍率可預選，等級限制自動調整；切換每 3 秒一次。自動續費在場內點數用完時買 1 份，品質鑽石優先不足則整筆付金幣。入場費另計。`));
  body.append(details); renderCatchupStatus();
}
$('#catchup-status').onclick = openCatchup;
$('#catchup-close').onclick = () => { $('#catchup-dialog').hidden = true; clearTimeout(catchupTimeout); };
$('#catchup-dialog').addEventListener('click', (ev) => { if (ev.target === $('#catchup-dialog')) $('#catchup-dialog').hidden = true; });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') $('#catchup-dialog').hidden = true; });
setInterval(renderCatchupStatus, 1000);
setInterval(catchupCoolText, 250);

// Runtime settings override exported DB defaults; default AUTO selections are untouched.
function syncRoyalSwordData() {
 if (!st.game?.skills) return;
 const c = st.royalSword;
 if (!c) { delete st.game.skills[121]; return; }
 st.game.skills[121] = { name: '王者之劍', level: 16, mp: c.mp, hostile: true,
  range: c.range, area: false, gfx: c.gfx, dur: 0, delay: 1500, ownDelay: c.delay, action: 19 };
 SKILL_DESC[121] = `王族 Lv${c.learnLevel}。對 ${c.range} 格內單一敵人造成${c.damageMode === "fixed" ? `${c.dmgMin}～${c.dmgMax} 點固定基礎傷害` : "同普通攻擊的傷害(不另擲普攻命中)"}，不套魔防；沿用衝擊之暈命中判定，暈眩 ${c.stunMin/1000}～${c.stunMax/1000} 秒；新暈加在剩餘時間上${c.stunStackMax > 0 ? `，王者疊暈上限 ${c.stunStackMax/1000} 秒(不縮短既有暈)` : "，預設不限疊暈上限"}。一般怪物能否暈眩依伺服器規則。MP ${c.mp}，獨立冷卻 ${c.delay/1000} 秒；共用施法延遲 1.5 秒(另計施法動作)。`;
}
