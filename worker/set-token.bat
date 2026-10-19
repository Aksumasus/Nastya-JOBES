@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Встав токен бота від BotFather (правий клік у цьому вікні = вставити) і натисни Enter:
call npx --yes wrangler@4 secret put BOT_TOKEN
pause
