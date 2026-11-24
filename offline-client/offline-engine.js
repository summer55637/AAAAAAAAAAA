(function (root) {
  'use strict';

  const SAVE_KEY = 'natisha.offline.save.v1';
  const CLASS_GFX = [[0, 1], [61, 48], [138, 37], [734, 1186], [2786, 2796], [6658, 6661], [6671, 6650]];
  const CLASS_HP = [14, 18, 14, 10, 14, 16, 12];
  const CLASS_MP = [8, 4, 10, 12, 8, 10, 12];

  function asNumber(value, fallback) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }
  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function makeWalkMap() {
    const x0 = 0, x1 = 63, y0 = 0, y1 = 63;
    const width = x1 - x0 + 1, height = y1 - y0 + 1;
    const buffer = new ArrayBuffer(16 + width * height);
    new Int32Array(buffer, 0, 4).set([x0, x1, y0, y1]);
    // 這是第一階段的測試地形：每個方向都可通行，待匯入原始地圖遮罩後替換。
    new Uint8Array(buffer, 16).fill(0x0f);
    return buffer;
  }

  class LocalGameEngine {
    constructor(emit, options) {
      const settings = options || {};
      this.emit = typeof emit === 'function' ? emit : function () {};
      this.storage = settings.storage || this.getStorage();
      this.gameData = settings.gameData || null;
      this.timersEnabled = settings.enableTimers !== false;
      this.tickMs = Math.max(250, asNumber(settings.tickMs, 800));
      this.save = this.readSave();
      this.character = null;
      this.playerId = 1;
      this.nextObjectId = 1000;
      this.player = { x: 32, y: 32, heading: 2 };
      this.monsters = new Map();
      this.drops = new Map();
      this.inventory = [];
      this.autoHunt = false;
      this.lastMonsterStep = 0;
      this.lastMonsterAttack = 0;
      this.tickHandle = null;
      this.respawnHandle = null;
      this.closed = false;
      if (!this.gameData && typeof root.fetch === 'function') {
        root.fetch('game.json').then(function (response) {
          return response.ok ? response.json() : null;
        }).then((data) => {
          if (data) this.gameData = data;
        }).catch(function () {});
      }
    }

    getStorage() {
      try { return root.localStorage; } catch (_) { return null; }
    }

    readSave() {
      try {
        const raw = this.storage && this.storage.getItem(SAVE_KEY);
        const value = raw ? JSON.parse(raw) : null;
        if (value && value.version === 1 && Array.isArray(value.characters)) return value;
      } catch (_) {}
      return { version: 1, nextCharacterId: 1, characters: [] };
    }

    persist() {
      try {
        if (this.storage) this.storage.setItem(SAVE_KEY, JSON.stringify(this.save));
      } catch (_) {}
    }

    emitEvent(event) {
      if (!this.closed && event && typeof event.t === 'string') this.emit(event);
    }

    sendCharacterList() {
      this.emitEvent({ t: 'charamount', max: 3 });
      for (const character of this.save.characters) {
        this.emitEvent({ t: 'charlist', char: this.publicCharacter(character) });
      }
    }

    publicCharacter(character) {
      return {
        id: character.id,
        name: character.name,
        type: character.type,
        sex: character.sex,
        level: character.level,
        exp: character.exp,
        str: character.str,
        dex: character.dex,
        con: character.con,
        int: character.int,
        wis: character.wis,
        cha: character.cha,
        hp: character.hp,
        maxHp: character.maxHp,
        mp: character.mp,
        maxMp: character.maxMp
      };
    }

    command(command) {
      if (!command || typeof command.t !== 'string') return;
      switch (command.t) {
        case 'hello':
          this.emitEvent({ t: 'serverversion', version: 'offline', offline: true });
          return;
        case 'localLogin':
          this.emitEvent({ t: 'loginresult', reason: 0 });
          this.sendCharacterList();
          return;
        case 'newchar':
          this.createCharacter(command);
          return;
        case 'enter':
          this.enterCharacter(command.name);
          return;
        case 'move':
          this.movePlayer(command);
          return;
        case 'attack':
          this.attack(command);
          return;
        case 'pickup':
          this.pickup(command);
          return;
        case 'useitem':
          this.useItem(command);
          return;
        case 'autohunt':
          this.autoHunt = command.on === true;
          return;
        case 'restart':
          this.revive();
          return;
        case 'changechar':
          this.leaveGame();
          return;
        case 'deletechar':
          this.deleteCharacter(command);
          return;
        case 'ping':
          this.emitEvent({ t: 'pong', b: 'offline' });
          return;
        // 線上功能在離線模式不會送往任何外部主機。
        case 'keepalive':
        case 'ack':
        case 'botsig':
        case 'clan':
        case 'webattach':
        case 'webdetach':
        case 'bg':
          return;
        default:
          return;
      }
    }

    createCharacter(command) {
      const name = String(command.name || '').trim();
      const type = Math.max(0, Math.min(6, asNumber(command.type, 1) | 0));
      const sex = command.sex === 1 ? 1 : 0;
      if (!/^[\p{L}\p{N}]{1,12}$/u.test(name)) {
        this.emitEvent({ t: 'newcharstatus', reason: 9 });
        return;
      }
      if (this.save.characters.some((entry) => entry.name === name)) {
        this.emitEvent({ t: 'newcharstatus', reason: 6 });
        return;
      }
      if (this.save.characters.length >= 3) {
        this.emitEvent({ t: 'newcharstatus', reason: 21 });
        return;
      }

      const values = {
        str: asNumber(command.str, 13),
        dex: asNumber(command.dex, 10),
        con: asNumber(command.con, 10),
        wis: asNumber(command.wis, 11),
        cha: asNumber(command.cha, 13),
        int: asNumber(command.int, 10)
      };
      const maxHp = Math.max(10, CLASS_HP[type] + Math.max(0, values.con - 10) * 2);
      const maxMp = Math.max(4, CLASS_MP[type] + Math.max(0, values.wis - 10) * 2);
      const character = {
        id: this.save.nextCharacterId++,
        name: name,
        type: type,
        sex: sex,
        level: 1,
        exp: 0,
        str: values.str,
        dex: values.dex,
        con: values.con,
        wis: values.wis,
        cha: values.cha,
        int: values.int,
        hp: maxHp,
        maxHp: maxHp,
        mp: maxMp,
        maxMp: maxMp,
        x: 32,
        y: 32,
        map: 0,
        inventory: [
          { id: 10001, itemId: 40010, name: '紅色藥水', count: 10 },
          { id: 10002, itemId: 40308, name: '金幣', count: 1000 }
        ]
      };
      this.save.characters.push(character);
      this.persist();
      this.emitEvent({ t: 'newchar', char: this.publicCharacter(character) });
    }

    enterCharacter(name) {
      const character = this.save.characters.find((entry) => entry.name === name) || this.save.characters[0];
      if (!character) {
        this.emitEvent({ t: 'error', msg: '請先建立角色' });
        return;
      }

      this.stopTimers();
      this.character = character;
      this.playerId = 1;
      this.player = {
        x: asNumber(character.x, 32),
        y: asNumber(character.y, 32),
        heading: 2
      };
      this.inventory = copy(character.inventory || []);
      this.monsters.clear();
      this.drops.clear();
      this.autoHunt = false;
      this.lastMonsterStep = 0;
      this.lastMonsterAttack = 0;

      this.emitEvent({ t: 'logintogame' });
      this.emitStatus();
      this.emitEvent({
        t: 'mapid',
        map: 0,
        name: '說話之島',
        mapVer: 'offline-map-1',
        portals: []
      });
      this.emitPlayerObject();
      this.spawnSlime(Math.min(60, this.player.x + 4), this.player.y);
      this.emitEvent({ t: 'inventory', items: copy(this.inventory) });
      this.emitEvent({ t: 'addskill', ids: character.type === 3 ? [1, 4] : [] });
      if (this.timersEnabled) {
        this.tickHandle = setInterval(() => this.tick(), this.tickMs);
      }
      this.persist();
    }

    emitPlayerObject() {
      if (!this.character) return;
      const character = this.character;
      this.emitEvent({
        t: 'object',
        id: this.playerId,
        kind: 'pc',
        name: character.name,
        gfx: CLASS_GFX[character.type] ? CLASS_GFX[character.type][character.sex] : 61,
        x: this.player.x,
        y: this.player.y,
        heading: this.player.heading,
        status: 0,
        level: character.level,
        exp: character.exp
      });
    }

    emitStatus() {
      if (!this.character) return;
      const character = this.character;
      this.emitEvent({
        t: 'status',
        id: this.playerId,
        name: character.name,
        type: character.type,
        sex: character.sex,
        level: character.level,
        exp: character.exp,
        expNext: this.expForNextLevel(character.level),
        str: character.str,
        dex: character.dex,
        con: character.con,
        int: character.int,
        wis: character.wis,
        cha: character.cha,
        hp: character.hp,
        maxHp: character.maxHp,
        mp: character.mp,
        maxMp: character.maxMp,
        ac: 10,
        mr: 0,
        lawful: 0,
        sp: 0
      });
    }

    expForNextLevel(level) {
      const table = this.gameData && this.gameData.expTable;
      if (Array.isArray(table) && table[level] != null) return table[level];
      return Math.max(125, level * 125);
    }

    movePlayer(command) {
      if (!this.character) return;
      const x = Math.max(0, Math.min(63, Math.round(asNumber(command.x, this.player.x))));
      const y = Math.max(0, Math.min(63, Math.round(asNumber(command.y, this.player.y))));
      const dx = x - this.player.x;
      const dy = y - this.player.y;
      if (!dx && !dy) return;
      this.player.heading = this.heading(dx, dy);
      this.player.x = x;
      this.player.y = y;
      this.character.x = x;
      this.character.y = y;
      this.emitEvent({
        t: 'move',
        id: this.playerId,
        x: x,
        y: y,
        heading: this.player.heading
      });
      this.persist();
    }

    heading(dx, dy) {
      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      const headings = {
        '0,-1': 0, '1,-1': 1, '1,0': 2, '1,1': 3,
        '0,1': 4, '-1,1': 5, '-1,0': 6, '-1,-1': 7
      };
      return headings[sx + ',' + sy] == null ? 2 : headings[sx + ',' + sy];
    }

    spawnSlime(x, y) {
      const id = this.nextObjectId++;
      const monster = {
        id: id,
        name: '史萊姆',
        kind: 'monster',
        gfx: 31,
        x: x,
        y: y,
        hp: 16,
        maxHp: 16,
        exp: 10,
        dead: false,
        lastStep: 0
      };
      this.monsters.set(id, monster);
      this.emitEvent({
        t: 'object', id: id, kind: 'monster', name: monster.name,
        gfx: monster.gfx, x: x, y: y, heading: 6, status: 0, level: 1, exp: monster.exp
      });
      this.emitEvent({ t: 'hpmeter', id: id, ratio: 100 });
      return monster;
    }

    attack(command) {
      if (!this.character) return;
      const id = asNumber(command.id, asNumber(command.target, -1));
      const monster = this.monsters.get(id);
      if (!monster || monster.dead) return;
      const distance = Math.max(
        Math.abs(monster.x - this.player.x),
        Math.abs(monster.y - this.player.y)
      );
      if (distance > 2) return;

      const damage = Math.max(1, Math.floor(asNumber(this.character.str, 10) / 4) + 1);
      monster.hp = Math.max(0, monster.hp - damage);
      this.emitEvent({
        t: 'attack',
        attacker: this.playerId,
        target: monster.id,
        dmg: damage,
        action: 1,
        heading: this.heading(monster.x - this.player.x, monster.y - this.player.y)
      });
      this.emitEvent({
        t: 'hpmeter',
        id: monster.id,
        ratio: Math.round(monster.hp * 100 / monster.maxHp)
      });

      if (monster.hp <= 0) {
        monster.dead = true;
        this.emitEvent({ t: 'action', id: monster.id, action: 8 });
        this.character.exp = asNumber(this.character.exp, 0) + monster.exp;
        this.awardLevels();
        this.emitStatus();
        this.spawnGold(monster.x, monster.y, 5);
        const deadId = monster.id;
        if (this.timersEnabled) {
          this.respawnHandle = setTimeout(() => {
            this.emitEvent({ t: 'remove', id: deadId });
            this.monsters.delete(deadId);
            if (this.character) {
              this.spawnSlime(Math.min(60, this.player.x + 4), this.player.y);
            }
          }, 1800);
        }
        this.persist();
      }
    }

    awardLevels() {
      if (!this.character) return;
      while (
        this.character.level < 99 &&
        this.character.exp >= this.expForNextLevel(this.character.level)
      ) {
        this.character.level++;
        this.character.maxHp += Math.max(2, Math.floor(this.character.con / 5));
        this.character.maxMp += Math.max(1, Math.floor(this.character.wis / 6));
        this.character.hp = this.character.maxHp;
        this.character.mp = this.character.maxMp;
      }
    }

    spawnGold(x, y, count) {
      const id = this.nextObjectId++;
      this.drops.set(id, {
        id: id, itemId: 40308, name: '金幣', count: count, x: x, y: y
      });
      this.emitEvent({
        t: 'object', id: id, kind: 'item', name: '金幣', gfx: 0,
        x: x, y: y, heading: 0, status: 0, count: count
      });
    }

    pickup(command) {
      if (!this.character) return;
      const id = asNumber(command.id, -1);
      const drop = this.drops.get(id);
      if (!drop) return;
      const distance = Math.max(
        Math.abs(drop.x - this.player.x),
        Math.abs(drop.y - this.player.y)
      );
      if (distance > 2) return;
      this.drops.delete(id);
      const existing = this.inventory.find((item) => item.itemId === drop.itemId);
      if (existing) existing.count += drop.count;
      else {
        this.inventory.push({
          id: this.nextObjectId++, itemId: drop.itemId,
          name: drop.name, count: drop.count
        });
      }
      this.character.inventory = copy(this.inventory);
      this.emitEvent({ t: 'remove', id: id });
      this.emitEvent({ t: 'inventory', items: copy(this.inventory) });
      this.persist();
    }

    useItem(command) {
      if (!this.character) return;
      const id = asNumber(command.id, -1);
      const item = this.inventory.find((entry) => entry.id === id);
      if (!item) return;
      if (!/紅色藥水|治癒藥水|治療藥水/.test(item.name)) return;
      this.character.hp = Math.min(this.character.maxHp, this.character.hp + 20);
      item.count--;
      if (item.count <= 0) {
        this.inventory = this.inventory.filter((entry) => entry.id !== item.id);
      }
      this.character.inventory = copy(this.inventory);
      this.emitEvent({
        t: 'hp', hp: this.character.hp, maxHp: this.character.maxHp
      });
      this.emitEvent({ t: 'inventory', items: copy(this.inventory) });
      this.persist();
    }

    tick() {
      if (!this.character || this.closed) return;
      const now = Date.now();
      for (const monster of this.monsters.values()) {
        if (monster.dead) continue;
        const dx = this.player.x - monster.x;
        const dy = this.player.y - monster.y;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance > 1 && now - monster.lastStep > 1200) {
          monster.lastStep = now;
          monster.x += Math.sign(dx);
          monster.y += Math.sign(dy);
          this.emitEvent({
            t: 'move', id: monster.id, x: monster.x, y: monster.y,
            heading: this.heading(dx, dy)
          });
        } else if (distance <= 1 && now - this.lastMonsterAttack > 2200) {
          this.lastMonsterAttack = now;
          this.character.hp = Math.max(0, this.character.hp - 1);
          this.emitEvent({
            t: 'attack', attacker: monster.id, target: this.playerId,
            dmg: 1, action: 1, heading: this.heading(-dx, -dy)
          });
          this.emitEvent({
            t: 'hp', hp: this.character.hp, maxHp: this.character.maxHp
          });
          if (this.character.hp <= 0) {
            this.emitEvent({ t: 'action', id: this.playerId, action: 8 });
          }
        }
      }
      this.character.x = this.player.x;
      this.character.y = this.player.y;
      this.persist();
    }

    revive() {
      if (!this.character) return;
      this.character.hp = this.character.maxHp;
      this.player.x = 32;
      this.player.y = 32;
      this.character.x = 32;
      this.character.y = 32;
      this.emitPlayerObject();
      this.emitEvent({
        t: 'hp', hp: this.character.hp, maxHp: this.character.maxHp
      });
      this.persist();
    }

    leaveGame() {
      this.stopTimers();
      if (this.character) {
        this.character.x = this.player.x;
        this.character.y = this.player.y;
        this.character.inventory = copy(this.inventory);
        this.persist();
      }
      this.character = null;
      this.monsters.clear();
      this.drops.clear();
      this.autoHunt = false;
      this.sendCharacterList();
    }

    deleteCharacter(command) {
      const name = String(command.name || '');
      if (!name) return;
      this.save.characters = this.save.characters.filter((entry) => entry.name !== name);
      this.persist();
      this.emitEvent({ t: 'deletecharok' });
      this.sendCharacterList();
    }

    stopTimers() {
      if (this.tickHandle) clearInterval(this.tickHandle);
      if (this.respawnHandle) clearTimeout(this.respawnHandle);
      this.tickHandle = null;
      this.respawnHandle = null;
    }

    snapshot() {
      return {
        characters: copy(this.save.characters),
        activeCharacter: this.character ? this.character.name : null,
        player: copy(this.player),
        monsters: Array.from(this.monsters.values()).map(copy),
        drops: Array.from(this.drops.values()).map(copy),
        inventory: copy(this.inventory)
      };
    }

    reset() {
      this.stopTimers();
      this.save = { version: 1, nextCharacterId: 1, characters: [] };
      this.persist();
      this.character = null;
      this.monsters.clear();
      this.drops.clear();
      this.inventory = [];
    }

    close() {
      this.stopTimers();
      this.closed = true;
    }
  }

  class LocalSocket {
    constructor(options) {
      this.readyState = 0;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.onopen = null;
      this.url = 'ws://offline.local/';
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.listeners = Object.create(null);
      this.closed = false;
      this.engine = new LocalGameEngine((event) => this.deliver(event), options);
      setTimeout(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.dispatch('open', { target: this });
      }, 0);
    }

    addEventListener(type, callback) {
      if (typeof callback !== 'function') return;
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(callback);
    }

    removeEventListener(type, callback) {
      const callbacks = this.listeners[type] || [];
      this.listeners[type] = callbacks.filter((entry) => entry !== callback);
    }

    dispatch(type, event) {
      const value = event || { target: this };
      for (const callback of this.listeners[type] || []) {
        try { callback.call(this, value); }
        catch (error) { setTimeout(function () { throw error; }, 0); }
      }
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, value);
    }

    send(raw) {
      if (this.readyState !== 1) {
        throw new Error('本機遊戲連線尚未開啟');
      }
      let command;
      try { command = JSON.parse(String(raw)); }
      catch (_) { throw new Error('本機遊戲收到無效命令'); }
      this.engine.command(command);
    }

    deliver(event) {
      if (this.closed || this.readyState !== 1 || typeof this.onmessage !== 'function') return;
      const message = { data: JSON.stringify(event), target: this };
      setTimeout(() => {
        if (this.closed || this.readyState !== 1) return;
        if (typeof this.onmessage === 'function') this.onmessage.call(this, message);
        for (const callback of this.listeners.message || []) {
          try { callback.call(this, message); } catch (error) {
            setTimeout(function () { throw error; }, 0);
          }
        }
      }, 0);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.engine.close();
      this.dispatch('close', {
        target: this, code: 1000, reason: 'offline', wasClean: true
      });
    }
  }

  root.NATISHA_OFFLINE = true;
  root.NatishaLocalSocket = LocalSocket;
  root.NatishaOfflineAPI = {
    createWalkMapBuffer: makeWalkMap,
    snapshot: function () {
      return root.__natishaLocalSocket && root.__natishaLocalSocket.engine
        ? root.__natishaLocalSocket.engine.snapshot() : null;
    },
    reset: function () {
      if (root.__natishaLocalSocket && root.__natishaLocalSocket.engine) {
        root.__natishaLocalSocket.engine.reset();
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LocalGameEngine: LocalGameEngine,
      LocalSocket: LocalSocket,
      createWalkMap: makeWalkMap
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
