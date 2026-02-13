@echo off
color 0B
title Wicked Alt Manager - PM2 Daemon
echo.
echo ============================================
echo    Wicked Alt Manager - PM2 Production
echo ============================================
echo.

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found. Install Node.js 20 LTS.
  pause
  exit /b 1
)

REM Check PM2
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
  echo [INFO] PM2 not found. Installing globally...
  call npm install -g pm2
  if %errorlevel% neq 0 (
    echo [ERROR] PM2 install failed.
    pause
    exit /b 1
  )
)

REM Check/create .env
if not exist .env (
  echo [INFO] Creating .env...
  (
    echo # Wicked Alt Manager Configuration
    echo # Get your Discord bot token from: https://discord.com/developers/applications
    echo DISCORD_TOKEN=
  ) > .env
  echo [ERROR] .env created but DISCORD_TOKEN is empty!
  echo [INFO] Edit .env, add your token, then run this script again.
  pause
  exit /b 1
)

REM Install dependencies if needed
if not exist node_modules (
  echo [INFO] Installing dependencies...
  call npm install
  if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Building...
call npm run build
if %errorlevel% neq 0 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo [INFO] Starting with PM2...
pm2 delete wicked-alt-manager >nul 2>nul
pm2 start dist/index.js --name wicked-alt-manager --restart-delay 3000
pm2 save
echo [OK] Bot running under PM2. Check status with: pm2 status
echo.

echo PM2 is now managing the bot.
echo View logs: pm2 logs wicked-alt-manager
pause
