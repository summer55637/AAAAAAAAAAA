# 離線資料快照

資料來源：`https://linwebgame.cc/config.json`、`/game.json`、`/speeds.json`。

擷取日期：2026-11-24。

- `offline-client/config.json`：原站設定的離線版本，已清空 Google 登入與外部 WebSocket 主機，關閉角色市集、拍賣、交易 OTP、排行榜、血盟徽章、高寵等線上專用功能，並標記 `offlineMode: true`。
- `offline-client/game.json`：原站遊戲資料快照，保留 EXP、技能、裝備／道具能力值、NPC 位置與效果資料表。
- `offline-client/speeds.json`：原站動作與動畫速度資料快照。
- `original-config.json`：未修改的原站設定備份。

注意：這些資料仍是客戶端資料層；怪物出生與 AI、戰鬥結算、掉落、地圖區塊／圖集仍需由離線核心接管或補齊。尚未把原版主程式接入原型頁面。