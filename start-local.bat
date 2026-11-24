@echo off
cd /d "%~dp0"
echo.
echo [1/2] 同步原版素材（首次下載；之後會略過已存在檔案）...
node sync-original-assets.cjs
if errorlevel 1 echo [注意] 素材同步未完整完成，遊戲仍會以本機替代素材啟動。
echo.
echo [2/2] 啟動娜緹夏天堂原版客戶端離線伺服器...
node server.cjs
pause
