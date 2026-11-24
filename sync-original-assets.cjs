'use strict';

// 一次性原始素材同步器：只下載出生點附近的原版地圖與初始角色/介面素材。
// 所有檔案寫入 offline-client/，完成後遊戲只讀取本機，不在遊戲中連線原站。
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, 'offline-client');
const REMOTE = 'https://linwebgame.cc/';
const FORCE = process.argv.includes('--refresh');
const SPAWN = { map: 0, x: 32593, y: 32922 };
const SEG = 64;
const CHUNK_RADIUS = 1;
const CLASS_GFX = [0, 1, 61, 48, 138, 37, 734, 1186, 2786, 2796, 6658, 6661, 6671, 6650, 31];
const UI182 = [
  'bar', 'close', 'dragon', 'exp', 'exp0', 'hp', 'mp', 'panel', 'round', 'slot',
  'i_bag', 'i_char', 'i_chat', 'i_gear', 'i_help', 'i_party', 'i_skill', 'stone',
  'buff_brave', 'st_481', 'st_486', 'st_480', 'st_5399', 'st_484g', 'st_1477'
];

const manifest = {
  source: REMOTE,
  syncedAt: new Date().toISOString(),
  spawn: SPAWN,
  chunkRadius: CHUNK_RADIUS,
  files: [],
  cached: 0,
  warnings: []
};

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function localPath(relative) {
  const clean = String(relative).split('?')[0].replace(/^[/\\]+/, '');
  const target = path.resolve(ROOT, clean);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error('不安全的素材路徑：' + relative);
  }
  return target;
}

function requestBuffer(url, redirects) {
  const depth = redirects || 0;
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重新導向次數過多：' + url));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 NatishaOfflineAssetSync/1.0',
        'Accept': '*/*'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        requestBuffer(next, depth + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const error = new Error('HTTP ' + status + '：' + url);
        error.status = status;
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      res.on('end', () => resolve(Buffer.concat(chunks, size)));
      res.on('error', reject);
    });
    req.setTimeout(45000, () => req.destroy(new Error('下載逾時：' + url)));
    req.on('error', reject);
  });
}

async function saveBuffer(remotePath, destination, optional) {
  const rel = destination || remotePath.split('?')[0];
  const target = localPath(rel);
  try {
    if (!FORCE) {
      const stat = await fs.promises.stat(target);
      if (stat.isFile() && stat.size > 0) {
        manifest.cached++;
        return true;
      }
    }
  } catch (_) {}

  const url = new URL(remotePath, REMOTE).toString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await requestBuffer(url);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const temp = target + '.part';
      await fs.promises.writeFile(temp, data);
      try { await fs.promises.unlink(target); } catch (_) {}
      await fs.promises.rename(temp, target);
      manifest.files.push({ path: rel.replace(/\\/g, '/'), bytes: data.length });
      console.log('  OK ' + rel + ' (' + data.length.toLocaleString() + ' bytes)');
      return true;
    } catch (error) {
      if (error.status === 404 && optional) {
        manifest.warnings.push(rel + ': HTTP 404 (略過)');
        return false;
      }
      if (attempt < 3) await delay(500 * attempt);
      else {
        manifest.warnings.push(rel + ': ' + error.message);
        console.log('  WARN ' + rel + ': ' + error.message);
        return false;
      }
    }
  }
  return false;
}

async function loadJson(remotePath, destination, optional) {
  const rel = destination || remotePath.split('?')[0];
  const target = localPath(rel);
  if (!FORCE) {
    try {
      const value = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      manifest.cached++;
      return value;
    } catch (_) {
      try { await fs.promises.unlink(target); } catch (_) {}
    }
  }
  const ok = await saveBuffer(remotePath, rel, optional);
  if (!ok) return null;
  try {
    return JSON.parse(await fs.promises.readFile(target, 'utf8'));
  } catch (error) {
    manifest.warnings.push(rel + ': JSON 解析失敗：' + error.message);
    return null;
  }
}

async function pool(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { await worker(items[index], index); }
      catch (error) { manifest.warnings.push(String(error)); }
    }
  });
  await Promise.all(workers);
}

async function syncMap() {
  console.log('[地圖] 讀取說話之島區塊索引…');
  const index = await loadJson('assets/tmap/0.json?v=t1', 'assets/tmap/0.json', false);
  if (!index || typeof index !== 'object') {
    manifest.warnings.push('說話之島地圖索引讀取失敗，遊戲會使用替代地面與通行遮罩。');
    return;
  }

  const sx = Math.floor(SPAWN.x / SEG);
  const sy = Math.floor(SPAWN.y / SEG);
  const chunks = [];
  for (let x = sx - CHUNK_RADIUS; x <= sx + CHUNK_RADIUS; x++) {
    for (let y = sy - CHUNK_RADIUS; y <= sy + CHUNK_RADIUS; y++) {
      const key = x + ',' + y;
      if (index[key]) chunks.push({ x, y, hash: index[key] });
    }
  }

  const groups = new Set();
  await pool(chunks, 3, async (chunk) => {
    const rel = 'assets/tmap/seg/' + chunk.hash + '.json';
    const data = await loadJson(rel + '?v=t1g3', rel, false);
    if (!data) return;
    for (const graphic of data.p || []) {
      if (Number.isFinite(graphic)) groups.add(graphic >> 10);
    }
    for (const row of data.o || []) {
      for (let i = 2; i < row.length; i += 2) {
        if (Number.isFinite(row[i])) groups.add(row[i] >> 10);
      }
    }
  });

  console.log('[地圖] 區塊 ' + chunks.length + ' 個，圖集 ' + groups.size + ' 組；下載地圖圖集…');
  await pool([...groups].sort((a, b) => a - b), 4, async (group) => {
    await Promise.all([
      saveBuffer('assets/tmap/til/' + group + '.json?v=t1'),
      saveBuffer('assets/tmap/til/' + group + '.webp?v=t1')
    ]);
  });

  // 完整索引保留地圖範圍；出生點周圍三乘三區塊的內容與圖集已備妥。
  await saveBuffer('assets/tmap/til/index.json?v=t1', 'assets/tmap/til/index.json', true);
  await saveBuffer('map/0', 'map/0', true);
}

async function syncCharacterAndUI() {
  console.log('[角色] 下載角色選角圖與角色動畫…');
  const charsel = await loadJson('assets/charsel/index.json?v=1', 'assets/charsel/index.json', true);
  if (charsel) {
    await pool(Object.keys(charsel), 4, async (key) => {
      await saveBuffer('assets/charsel/' + key + '.webp?v=1');
    });
  }

  const sprites = await loadJson('assets/spr/index.json?v=7', 'assets/spr/index.json', true);
  const packed = await loadJson('assets/sprs/index.json', 'assets/sprs/index.json', true) || {};
  const small = await loadJson('assets/sprs50/index.json', 'assets/sprs50/index.json', true) || {};
  if (Array.isArray(sprites)) {
    const available = new Set(sprites.map(String));
    const gfxList = CLASS_GFX.filter((gfx) => available.has(String(gfx)));
    await pool(gfxList, 3, async (gfx) => {
      const packedHash = packed[String(gfx)];
      const base = packedHash
        ? (String(packedHash).startsWith('s75-') ? 'assets/sprs75/' : 'assets/sprs/')
        : 'assets/spr/';
      const jsonPath = base + gfx + '.json';
      const meta = await loadJson(jsonPath + '?v=' + (packedHash || '8'), jsonPath, true);
      if (meta) {
        const pages = Math.max(1, Math.min(32, Number(meta.pages) || 1));
        for (let page = 0; page < pages; page++) {
          const suffix = page ? '-' + page : '';
          await saveBuffer(base + gfx + suffix + '.webp?v=' + (packedHash || '7'),
            base + gfx + suffix + '.webp', true);
        }
      }
      const smallHash = small[String(gfx)];
      if (smallHash) {
        const smallBase = 'assets/sprs50/';
        const smallJson = smallBase + gfx + '.json';
        const smallMeta = await loadJson(smallJson + '?v=' + smallHash, smallJson, true);
        if (smallMeta) {
          const pages = Math.max(1, Math.min(32, Number(smallMeta.pages) || 1));
          for (let page = 0; page < pages; page++) {
            const suffix = page ? '-' + page : '';
            await saveBuffer(smallBase + gfx + suffix + '.webp?v=' + smallHash,
              smallBase + gfx + suffix + '.webp', true);
          }
        }
      }
    });
  } else {
    manifest.warnings.push('角色動畫索引不存在；遊戲會使用替代角色／怪物繪圖。');
  }

  await saveBuffer('assets/spr/spawns.json?v=7', 'assets/spr/spawns.json', true);
  console.log('[介面] 下載 HUD 圖示…');
  await pool(UI182, 5, async (name) => {
    await saveBuffer('assets/ui182/' + name + '.webp?v=1', 'assets/ui182/' + name + '.webp', true);
  });
}

async function main() {
  console.log('娜緹夏天堂：原版離線素材同步');
  console.log('來源：' + REMOTE);
  console.log('目標：' + ROOT);
  if (FORCE) console.log('模式：強制更新');
  await syncMap();
  await syncCharacterAndUI();

  const report = {
    ...manifest,
    downloadedFiles: manifest.files.length,
    downloadedBytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0)
  };
  const reportPath = localPath('assets-manifest.json');
  await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('同步完成：' + report.downloadedFiles + ' 個檔案，' + report.downloadedBytes.toLocaleString() + ' bytes');
  console.log('略過既有檔案：' + manifest.cached);
  if (manifest.warnings.length) console.log('注意事項：' + manifest.warnings.length + ' 項（詳見 offline-client/assets-manifest.json）');
  console.log('沒有下載到的原始素材會由離線替代素材接手。');
}

main().catch((error) => {
  console.error('[同步器錯誤]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
