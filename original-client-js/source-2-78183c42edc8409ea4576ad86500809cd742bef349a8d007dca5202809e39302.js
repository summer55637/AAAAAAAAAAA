'use strict';
// Server owns assignment/count/claim. Only the open panel polls (3 s); no per-kill websocket traffic.
const dailyQuestUi = { enabled: false, data: null, message: '', pending: false, poll: null, timeout: null };
// 11/19 使用者:金額用「50萬」寫法(整萬才用萬,其他照千分位)
function dqWan(n) { return n >= 10000 && n % 10000 === 0 ? `${(n / 10000).toLocaleString()}萬` : n.toLocaleString(); }
function dailyQuestReset() {
  dailyQuestClose(); dailyQuestDismissReroll(); dailyQuestDismissSkip(); delete dailyQuestUi.skipRequest; delete dailyQuestUi.rerollRequest; clearTimeout(dailyQuestUi.timeout);
  Object.assign(dailyQuestUi, { enabled: false, data: null, message: '', pending: false, timeout: null });
  document.getElementById('btn-dailyquest')?.classList.add('hidden');
  if (panel.name === 'dailyquest') closePanel();
}
function dailyQuestClose() { clearInterval(dailyQuestUi.poll); dailyQuestUi.poll = null; }
function dailyQuestQuery() { if (dailyQuestUi.enabled) send({ t: 'dailyquest', op: 0 }); }
function dailyQuestOpen() {
  dailyQuestClose(); dailyQuestQuery();
  dailyQuestUi.poll = setInterval(() => {
    if (panel.name !== 'dailyquest' || !dailyQuestUi.enabled) return dailyQuestClose();
    if (!dailyQuestUi.pending) dailyQuestQuery();
  }, 3000);
}
function dailyQuestEvent(ev) {
  const ui = dailyQuestUi;
  if (ev.skip && ui.data?.skip && (ev.day < ui.data.day || (ev.day === ui.data.day && ev.skip.seq < ui.data.skip.seq))) return;
  if (ui.skipRequest && ev.day === ui.skipRequest.day && ev.skip?.seq === ui.skipRequest.seq && ev.status === 'progress' && !ev.message) return;
  delete ui.skipRequest;
  if (ev.reroll && ui.data?.reroll && (ev.day < ui.data.day || (ev.day === ui.data.day && ev.reroll.seq < ui.data.reroll.seq))) return;
  if (ui.rerollRequest && ev.day === ui.rerollRequest.day && ev.reroll?.seq === ui.rerollRequest.seq && !ev.message) return;
  delete ui.rerollRequest;
  ui.enabled = ev.enabled === true;
  document.getElementById('btn-dailyquest')?.classList.toggle('hidden', !ui.enabled);
  if (!ui.enabled) { dailyQuestReset(); return; }
  if (Number.isInteger(ev.day)) ui.data = ev;
  ui.message = ev.message || '';
  ui.pending = false; clearTimeout(ui.timeout); ui.timeout = null;
  if (panel.name === 'dailyquest') renderPanelSoon();
}
function dailyQuestClaim() {
  const ui = dailyQuestUi, data = ui.data;
  if (!ui.enabled || ui.pending || data?.status !== 'ready') return;
  ui.pending = true; ui.message = '正在確認領取結果…'; renderPanel();
  send({ t: 'dailyquest', op: 1, day: data.day });
  ui.timeout = setTimeout(() => {
    ui.pending = false; ui.message = '尚未收到結果，正在重新查詢…';
    dailyQuestQuery(); if (panel.name === 'dailyquest') renderPanelSoon();
  }, 8000);
}
function renderDailyQuest(body, foot) {
  const ui = dailyQuestUi, data = ui.data;
  const root = el('div', 'dq'); body.append(root);
  if (!ui.enabled) { root.append(el('p', 'dq-note', '每日任務尚未開放。')); return; }
  const refresh = el('button', 'secondary', '更新進度'); refresh.type = 'button'; refresh.onclick = dailyQuestQuery; foot.append(refresh);
  if (!data) { root.append(el('p', 'dq-note', ui.message || '正在讀取今日任務…')); return; }
  const labels = { progress: '進行中', ready: '可領取', claimed: '已領取', review: '待確認' };
  const hero = el('div', 'dq-card'); root.append(hero);
  const top = el('div', 'dq-top'); top.append(el('span', 'dq-kicker', '今日狩獵目標'), el('span', `dq-state dq-status-${data.status}`, labels[data.status] || '讀取中')); hero.append(top);
  hero.append(el('h3', 'dq-target', data.name));
  const numbers = el('div', 'dq-numbers'); numbers.append(el('b', '', data.count.toLocaleString()), el('span', '', ` / ${data.need.toLocaleString()} 隻`)); hero.append(numbers);
  const progress = document.createElement('progress'); progress.className = 'dq-progress'; progress.max = data.need; progress.value = data.count;
  progress.setAttribute('aria-label', `${data.name}狩獵進度`); hero.append(progress);
  const reward = el('div', 'dq-reward'); // 主導 11/15:使用者「要用真實圖片」→ 用背包同一套道具圖示(伺服器回 rewardGfx);沒有圖號才退回菱形
  const rewardIcon = Number.isInteger(data.rewardGfx) && data.rewardGfx > 0 && typeof iconCanvas === 'function' ? iconCanvas({ name: data.rewardName, gfx: data.rewardGfx }, 40) : el('span', 'dq-gem', '◆');
  rewardIcon.classList.add('dq-icon');
  reward.append(rewardIcon, el('div', '', `刻印的${data.rewardName} × ${data.rewardCount}`)); hero.append(reward);
  const claim = el('button', 'dq-claim', ui.pending ? '確認中…' : data.status === 'claimed' ? '今日已領取' : data.status === 'review' ? '領取結果待確認' : '領取獎勵');
  claim.type = 'button'; claim.disabled = ui.pending || data.status !== 'ready'; claim.onclick = dailyQuestClaim; hero.append(claim);
  if (data.skip) {
    const payments = el('div', 'dq-payments'); hero.append(payments);
    if (data.reroll) renderDailyQuestReroll(payments, data);
    renderDailyQuestSkip(payments, data);
  } else if (data.reroll) renderDailyQuestReroll(hero, data);
  if (ui.message) { const message = el('p', 'dq-message', ui.message); message.setAttribute('role', 'status'); root.append(message); }
  const notes = el('div', 'dq-notes');
  notes.append(el('p', '', `每日 ${data.reset}（台灣時間）重置，未領取的獎勵會作廢。`));
  notes.append(el('p', '', data.reroll ? '每個帳號每日領獎一次，角色共用進度；重骰只更換目標並將進度歸零。' : '每個帳號每日一次，角色共用進度；今日目標無法更換。'));
  notes.append(el('p', '', '獵場或野外都算，離線掛機也計入。'));
  root.append(notes);
}
document.getElementById('btn-dailyquest').onclick = () => { if (dailyQuestUi.enabled) togglePanel('dailyquest'); };

// DailyQuestReroll: a confirmation captures the displayed day + revision, never only the monster name.
function dailyQuestRerollReason(data) {
  if (dailyQuestUi.pending) return '正在確認結果，請稍候。';
  const r = data.reroll;
  if (!r) return '重骰尚未開放。';
  const reasons = { locked: '金幣已上鎖，請先解鎖金幣。', gold: '金幣不足。', complete: data.status === 'claimed' ? '今日獎勵已領取，不能重骰。' : '任務已達成，不能重骰。',
    limit: '已達今日重骰次數上限。', pool: '目前沒有其他可選任務。', unavailable: '請連線並結束交易、商店或死亡狀態。', review: '重骰結果待確認，請聯絡管理員。' };
  if (r.reason) return reasons[r.reason] || '目前無法重骰。';
  if (data.status !== 'progress') return data.status === 'review' ? '領取結果待確認，不能重骰。' : reasons.complete;
  if (r.max > 0 && r.used >= r.max) return reasons.limit;
  if (r.gold < r.price) return reasons.gold;
  return '';
}
function renderDailyQuestReroll(hero, data) {
  const box = el('div', 'dq-reroll-box'), r = data.reroll;
  const reason = dailyQuestRerollReason(data);
  const button = el('button', 'secondary dq-reroll', `重骰任務 · ${dqWan(r.price)}金幣`);
  button.type = 'button'; button.disabled = !!reason; button.onclick = dailyQuestConfirmReroll;
  button.setAttribute('aria-describedby', 'dq-reroll-reason'); box.append(button);
  const note = el('p', 'dq-reroll-note', reason || `今日已重骰 ${r.used} 次${r.max ? `，上限 ${r.max} 次` : '，次數不限'}。`);
  note.id = 'dq-reroll-reason'; note.setAttribute('role', 'status'); box.append(note); hero.append(box);
}
function dailyQuestDismissReroll() {
  const modal = document.getElementById('dq-reroll-dialog');
  if (modal) { if (typeof modal.close === 'function') modal.close(); modal.remove(); }
}
function dailyQuestConfirmReroll() {
  const data = dailyQuestUi.data;
  if (!data?.reroll || dailyQuestRerollReason(data)) return;
  dailyQuestDismissReroll();
  const day = data.day, seq = data.reroll.seq, price = data.reroll.price;
  // Native confirm is available on Safari versions without HTMLDialogElement.showModal.
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') {
    if (window.confirm(`將扣除這個角色背包的 ${dqWan(price)}金幣，改抽不同怪物，目前 ${data.count.toLocaleString()} 隻進度會歸零。獎勵不變。`)) dailyQuestSubmitReroll(day, seq, price);
    return;
  }
  const modal = document.createElement('dialog'); modal.id = 'dq-reroll-dialog'; modal.className = 'dq-confirm';
  modal.setAttribute('aria-labelledby', 'dq-confirm-title'); modal.setAttribute('aria-describedby', 'dq-confirm-copy');
  const title = el('h3', '', '更換今日任務？'); title.id = 'dq-confirm-title';
  const copy = el('p', '', `將扣除這個角色背包的 ${dqWan(price)}金幣，改抽不同怪物，目前 ${data.count.toLocaleString()} 隻進度會歸零。獎勵不變。`); copy.id = 'dq-confirm-copy';
  const actions = el('div', 'dq-confirm-actions');
  const cancel = el('button', 'secondary', '取消'), confirm = el('button', '', `確認扣除 ${dqWan(price)}金幣`);
  cancel.type = confirm.type = 'button'; cancel.autofocus = true;
  cancel.onclick = dailyQuestDismissReroll;
  modal.addEventListener('cancel', e => { e.preventDefault(); dailyQuestDismissReroll(); });
  confirm.onclick = () => dailyQuestSubmitReroll(day, seq, price);
  actions.append(cancel, confirm); modal.append(title, copy, actions); document.body.append(modal); modal.showModal();
}

function dailyQuestSubmitReroll(day, seq, price) {
    const current = dailyQuestUi.data;
    dailyQuestDismissReroll();
    if (panel.name !== 'dailyquest' || !current?.reroll || dailyQuestRerollReason(current)) return;
    if (current.day !== day || current.reroll.seq !== seq || current.reroll.price !== price) {
      dailyQuestUi.message = '任務資料已更新，請重新確認。'; renderPanelSoon(); return;
    }
    dailyQuestUi.pending = true; dailyQuestUi.rerollRequest = { day, seq };
    dailyQuestUi.message = '正在確認重骰結果…'; renderPanel();
    send({ t: 'dailyquest', op: 4, day, seq });
    clearTimeout(dailyQuestUi.timeout);
    dailyQuestUi.timeout = setTimeout(() => {
      delete dailyQuestUi.rerollRequest; dailyQuestUi.pending = false; dailyQuestUi.timeout = null;
      dailyQuestUi.message = '尚未收到結果，正在重新查詢；不會自動再次扣款。';
      dailyQuestQuery(); if (panel.name === 'dailyquest') renderPanelSoon();
    }, 8000);
}

// DailyQuestSkip: account/day is the durable once-per-day payment key.
function dailyQuestSkipReason(data) {
  if (dailyQuestUi.pending) return '正在確認結果，請稍候。';
  if (!data?.skip) return '直接完成尚未開放。';
  const reasons = { gold: '金幣不足。', locked: '金幣已上鎖，請先解鎖金幣。', complete: '任務已達成或已領取，不能再次付費完成。', unavailable: '請連線並結束交易、商店或死亡狀態。', review: '任務或付款結果確認中，請更新進度。' };
  if (data.skip.reason) return reasons[data.skip.reason] || '目前無法直接完成。';
  if (data.status !== 'progress') return data.status === 'review' ? reasons.review : reasons.complete;
  if (data.skip.gold < data.skip.price) return reasons.gold;
  return '';
}
function renderDailyQuestSkip(hero, data) {
  const box = el('div', 'dq-skip-box'), reason = dailyQuestSkipReason(data);
  const button = el('button', 'secondary dq-skip', `直接完成 · ${dqWan(data.skip.price)}金幣`);
  button.type = 'button'; button.setAttribute('aria-disabled', String(!!reason)); button.setAttribute('aria-describedby', 'dq-skip-reason');
  button.onclick = () => { const why = dailyQuestSkipReason(dailyQuestUi.data); if (why) { dailyQuestUi.message = why; renderPanelSoon(); } else dailyQuestConfirmSkip(); };
  const note = el('p', 'dq-reroll-note', reason || '直接達成後，再按「領取獎勵」。'); note.id = 'dq-skip-reason'; note.setAttribute('role', 'status');
  box.append(button, note); hero.append(box);
}
function dailyQuestDismissSkip() {
  const modal = document.getElementById('dq-skip-dialog');
  if (modal) { if (typeof modal.close === 'function') modal.close(); modal.remove(); }
}
function dailyQuestConfirmSkip() {
  const data = dailyQuestUi.data;
  if (dailyQuestSkipReason(data)) return;
  dailyQuestDismissReroll(); dailyQuestDismissSkip();
  const day = data.day, seq = data.skip.seq, price = data.skip.price;
  const copyText = `將扣除這個角色背包的 ${dqWan(price)}金幣，今日任務會直接達成。之後請按「領取獎勵」，完成後不能重骰。`;
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') {
    if (window.confirm(copyText)) dailyQuestSubmitSkip(day, seq, price); return;
  }
  const modal = document.createElement('dialog'); modal.id = 'dq-skip-dialog'; modal.className = 'dq-confirm';
  modal.setAttribute('aria-labelledby', 'dq-skip-title'); modal.setAttribute('aria-describedby', 'dq-skip-copy');
  const title = el('h3', '', '直接完成今日任務？'); title.id = 'dq-skip-title';
  const copy = el('p', '', copyText); copy.id = 'dq-skip-copy';
  const actions = el('div', 'dq-confirm-actions'), cancel = el('button', 'secondary', '取消'), confirm = el('button', '', `確認扣除 ${dqWan(price)}金幣`);
  cancel.type = confirm.type = 'button'; cancel.autofocus = true; cancel.onclick = dailyQuestDismissSkip;
  modal.addEventListener('cancel', e => { e.preventDefault(); dailyQuestDismissSkip(); });
  confirm.onclick = () => dailyQuestSubmitSkip(day, seq, price);
  actions.append(cancel, confirm); modal.append(title, copy, actions); document.body.append(modal); modal.showModal();
}
function dailyQuestSubmitSkip(day, seq, price) {
  const data = dailyQuestUi.data; dailyQuestDismissSkip();
  if (panel.name !== 'dailyquest' || dailyQuestSkipReason(data)) return;
  if (data.day !== day || data.skip.seq !== seq || data.skip.price !== price) { dailyQuestUi.message = '任務資料已更新，請重新確認。'; renderPanelSoon(); return; }
  dailyQuestUi.pending = true; dailyQuestUi.skipRequest = { day, seq };
  dailyQuestUi.message = '正在確認付款與任務結果…'; renderPanel(); send({ t: 'dailyquest', op: 5, day, seq });
  clearTimeout(dailyQuestUi.timeout);
  dailyQuestUi.timeout = setTimeout(() => {
    delete dailyQuestUi.skipRequest; dailyQuestUi.pending = false; dailyQuestUi.timeout = null;
    dailyQuestUi.message = '尚未收到結果，正在重新查詢；不會自動再次扣款。'; dailyQuestQuery(); if (panel.name === 'dailyquest') renderPanelSoon();
  }, 8000);
}
