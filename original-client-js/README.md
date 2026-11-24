# 原版《娜緹夏天堂》JavaScript 匯出模組

此資料夾保存自 `main/files/isolated` 匯出的 15 個 JavaScript 模組，原始檔案內容未修改。

## 模組辨識
- `source-12`: 原版主程式 `app.js`（WebSocket 事件處理、遊戲狀態、地圖／物件／移動／戰鬥客戶端）
- `source-14`: 原版 HUD `hud.js`（角色／背包／技能面板、自動狩獵介面）
- `source-15`: 原版地圖 `l1map.js`（地圖區塊、圖集、地面與物件繪製）
- `source-1`: Gamedex 圖示載入
- `source-6`: Flare 素材載入與繪製
- `source-8`: 音效播放
- `source-10`: 暫用 SPR 替代素材
- `source-11`: 素材預載入
- `source-2`: 每日任務 UI
- `source-3`: 伊娃寶藏 UI
- `source-4`: 變身選單元件
- `source-7`: 皇家劍特效
- `source-5`、`source-9`、`source-13`: 版面與顯示設定

## 離線整合狀態
`source-12`、`source-14`、`source-15` 已鏡像到 `offline-client/app.js`、`offline-client/hud.js`、`offline-client/l1map.js`，供下一階段本機整合。它們目前仍未由原型 `index.html` 載入，因為原版頁面骨架、Sprite/Flare/UI 素材和地圖圖集尚未完整匯入。

## 依賴
原版程式會讀取 `/config.json`、`/game.json`、`/speeds.json`，並讀取 `assets/map`、`assets/tmap`、`assets/sprs`、`assets/sprs50`、`assets/flare`、`assets/ui182` 等資源。遊戲狀態與攻擊／移動／拾取結果仍需離線模擬層取代線上 WebSocket 伺服器。