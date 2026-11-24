# 原版《娜緹夏天堂》JavaScript 匯出模組

此資料夾保存自 main/files/isolated 匯出的 15 個原版 JavaScript 模組，檔案內容未修改。

## 模組辨識
- source-12: 原版主程式（WebSocket 事件處理、遊戲狀態、地圖／物件／移動／戰鬥客戶端）
- source-14: HUD、角色／背包／技能面板、自動狩獵介面
- source-15: L1MAP 地圖區塊、地圖繪製與相關載入邏輯
- source-1: Gamedex 圖示載入
- source-6: Flare 素材載入與繪製
- source-8: 音效播放
- source-10: 暫用 SPR 替代素材
- source-11: 素材預載入
- source-2: 每日任務 UI
- source-3: 伊娃寶藏 UI
- source-4: 變身選單元件
- source-7: 皇家劍特效
- source-5、source-9、source-13: 版面與顯示設定

## 尚缺的執行依賴
此資料夾不是完整網站封裝，沒有原版 HTML、CSS、圖片／動畫、地圖區塊、圖集、遊戲資料 JSON、伺服器設定及其他靜態資源。程式碼中仍引用 /game.json、/config.json、/speeds.json、assets/map、assets/tmap、assets/sprs、assets/flare、assets/sound 等資源。

## 狀態
目前只作為單機化整合底本保存，尚未載入或接線到 offline-client 原型。不要將這些模組當成可獨立執行的遊戲，也不要覆蓋現有單機原型。
