'use strict';

const assert = require('node:assert/strict');
const { LocalSocket } = require('./offline-engine.js');

async function run() {
  const storage = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = String(value); }
  };
  const socket = new LocalSocket({
    storage,
    enableTimers: false,
    gameData: { expTable: [0, 125], skills: {} }
  });
  const seen = new Set();
  let entered = false;

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('LocalSocket handshake timed out: ' + [...seen].join(', ')));
      }, 2500);

      const finish = () => {
        clearTimeout(timeout);
        socket.close();
        resolve();
      };

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data);
          if (event.t === 'object' && event.kind === 'monster') seen.add('monster');
          else seen.add(event.t);

          if (event.t === 'serverversion') {
            socket.send(JSON.stringify({ t: 'localLogin' }));
          } else if (event.t === 'charamount' && !entered) {
            socket.send(JSON.stringify({
              t: 'newchar', name: 'Socket測試', type: 1, sex: 0,
              str: 13, dex: 10, con: 10, int: 10, wis: 11, cha: 13
            }));
          } else if (event.t === 'newchar' && !entered) {
            entered = true;
            socket.send(JSON.stringify({ t: 'enter', name: 'Socket測試' }));
          } else if (event.t === 'settings' && seen.has('monster')) {
            for (const expected of [
              'loginresult', 'charamount', 'newchar', 'logintogame',
              'status', 'mapid', 'monster', 'inventory', 'settings'
            ]) assert.ok(seen.has(expected), 'missing event: ' + expected);
            finish();
          }
        } catch (error) {
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      };

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'hello' }));
      });
    });
  } finally {
    socket.close();
  }
  process.stdout.write('offline LocalSocket login-to-world test passed\\n');
}

module.exports = run;
if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
