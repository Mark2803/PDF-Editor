@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Не найден Node.js. Установите версию LTS с сайта https://nodejs.org
  echo   ^(обычная установка, все галочки по умолчанию^), затем снова запустите start.bat
  echo.
  start "" "https://nodejs.org/ru/download"
  pause
  exit /b 1
)
node server.js --open
pause
