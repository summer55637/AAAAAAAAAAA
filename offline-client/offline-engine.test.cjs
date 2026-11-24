'use strict';

const assert = require('node:assert/strict');
const { LocalGameEngine, createWalkMap } = require('./offline-engine.js');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const events = [];
const engine = new LocalGameEngine((event) => events.push(event), {
  storage,
  enableTimers: false,
  gameData: { expTable: [0, 125, 300, 500, 750] }
});

engine.command({ t: 'hello' });
assert.equal(events.at(-1).t, 'serverversion');

engine.command({ t: 'localLogin' });
assert.ok(events.some((event) => event.t === 'loginresult' && event.reason === 0));
assert.ok(events.some((event) => event.t === 'charamount' && event.max === 3));

engine.command({
  t: 'newchar', name: '離線測試', type: 1, sex: 0,
  str: 16, dex: 12, con: 14, wis: 9, cha: 12, int: 8
});
assert.ok(events.some((event) => event.t === 'newchar' && event.char.name === '離線測試'));
assert.equal(engine.snapshot().characters.length, 1);

engine.command({ t: 'enter', name: '離線測試' });
assert.ok(events.some((event) => event.t === 'logintogame'));
assert.ok(events.some((event) => event.t === 'mapid' && event.map === 0));
assert.ok(events.some((event) => event.t === 'inventory'));
assert.ok(events.some((event) => event.t === 'settings' && event.ver === 1));
assert.ok(events.some((event) => event.t === 'bookmarks' && Array.isArray(event.list)));
assert.ok(events.some((event) => event.t === 'object' && event.kind === 'monster'));
assert.equal(engine.snapshot().activeCharacter, '離線測試');

// 原版 C_Move: x/y 是送出前座標，heading 表示移動方向。
engine.command({ t: 'move', x: 32, y: 32, heading: 2 });
engine.command({ t: 'move', x: 33, y: 32, heading: 2 });
assert.equal(engine.snapshot().player.x, 34);

const monster = engine.snapshot().monsters[0];
engine.command({ t: 'attack', id: monster.id });
engine.command({ t: 'attack', id: monster.id });
engine.command({ t: 'attack', id: monster.id });
engine.command({ t: 'attack', id: monster.id });
assert.ok(events.some((event) => event.t === 'action' && event.id === monster.id && event.action === 8));
assert.equal(engine.snapshot().characters[0].exp, 10);

const drop = engine.snapshot().drops[0];
engine.command({ t: 'pickup', id: drop.id });
assert.ok(engine.snapshot().inventory.some((item) => item.name === '金幣' && item.count >= 1005));

const potion = engine.snapshot().inventory.find((item) => item.name === '紅色藥水');
engine.character.hp = 1;
engine.command({ t: 'useitem', id: potion.id });
assert.ok(events.some((event) => event.t === 'hp' && event.hp > 1));
engine.command({ t: 'settingsave', ver: 1, json: JSON.stringify({ auto: { enabled: true } }) });
assert.ok(events.some((event) => event.t === 'settingsack' && event.ver === 1));
engine.command({ t: 'bookmark', name: '測試點' });
assert.ok(events.some((event) => event.t === 'bookmark' && event.name === '測試點'));
assert.equal(engine.save.bookmarks.length, 1);
engine.command({ t: 'bookmarkdel', name: '測試點' });
assert.equal(engine.save.bookmarks.length, 0);

const mageStorage = new MemoryStorage();
const mageEvents = [];
const mage = new LocalGameEngine((event) => mageEvents.push(event), {
  storage: mageStorage, enableTimers: false,
  gameData: { expTable: [0, 125], skills: {
    1: { name: '初級治癒術', mp: 4, hostile: false, dur: 0, action: 19 },
    4: { name: '光箭', mp: 3, hostile: true, range: 10, gfx: 167, action: 18 }
  } }
});
mage.command({ t: 'newchar', name: '測試法師', type: 3, str: 10, dex: 10, con: 10, wis: 12, cha: 10, int: 13 });
mage.command({ t: 'enter', name: '測試法師' });
mage.character.hp = 1;
mage.command({ t: 'useskill', skill: 1, target: mage.playerId, x: 32, y: 32 });
assert.ok(mage.character.hp > 1);
const mageMob = mage.snapshot().monsters[0];
mage.command({ t: 'move', x: 32, y: 32, heading: 2 });
mage.command({ t: 'useskill', skill: 4, target: mageMob.id, x: mageMob.x, y: mageMob.y });
assert.ok(mageEvents.some((event) => event.t === 'attack' && event.gfx === 167));
mage.close();

const map = createWalkMap();
assert.equal(map.byteLength, 16 + 64 * 64);
assert.deepEqual(Array.from(new Int32Array(map, 0, 4)), [0, 63, 0, 63]);
assert.equal(new Uint8Array(map, 16)[0], 15);

const restored = new LocalGameEngine(() => {}, {
  storage,
  enableTimers: false,
  gameData: { expTable: [0, 125, 300] }
});
assert.equal(restored.snapshot().characters[0].name, '離線測試');

engine.close();
restored.close();
process.stdout.write('offline-engine tests passed\n');
